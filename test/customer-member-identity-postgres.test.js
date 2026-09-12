'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn,spawnSync}=require('node:child_process');
const {Client,Pool}=require('pg');
const {createCustomerMemberIdentity,CustomerMemberError,normalizeSelectedPhone}=require('../lib/customer-member-identity');

const ROOT=path.join(__dirname,'..');
const PG_BIN=process.env.PG17_BIN||'/opt/homebrew/opt/postgresql@17/bin';
const migration=name=>fs.readFileSync(path.join(ROOT,'migrations',name),'utf8');
const chain=[
  '036_customer_member_identity_preflight_readonly.sql','037_customer_member_profile_schema.sql',
  '038_customer_member_profile_verification_readonly.sql','039_customer_member_code_backfill.sql',
  '040_customer_phone_otp_session_schema.sql','041_customer_member_identity_enforcement.sql',
  '042_customer_member_identity_verification_readonly.sql'
];
const ID={shopA:'11111111-1111-4111-8111-111111111111',shopB:'11111111-1111-4111-8111-222222222222',
  customerA:'22222222-2222-4222-8222-111111111111',customerB:'22222222-2222-4222-8222-222222222222'};

test('PostgreSQL 17 member identity, OTP, tenant, and phone-change foundation', {timeout:120000}, async t=>{
  if(!fs.existsSync(path.join(PG_BIN,'initdb'))) return t.skip('PostgreSQL 17 unavailable');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'gg-member-pg-')),data=path.join(temp,'data');
  assert.equal(spawnSync(path.join(PG_BIN,'initdb'),['-D',data,'-A','trust','--no-locale'],{encoding:'utf8'}).status,0);
  const port=57200+Math.floor(Math.random()*250),pg=spawn(path.join(PG_BIN,'postgres'),['-D',data,'-p',String(port)],{stdio:'ignore'});
  const url=`postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`; let db,pool;
  try{
    for(let n=0;n<50;n+=1){try{db=new Client({connectionString:url});await db.connect();break;}catch{if(db)await db.end().catch(()=>{});await new Promise(r=>setTimeout(r,100));}}
    assert.ok(db);
    await db.query(`CREATE EXTENSION pgcrypto; CREATE TABLE shops(id uuid PRIMARY KEY,slug text UNIQUE NOT NULL,status text NOT NULL);
      CREATE TABLE customers(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,name text NOT NULL,phone text NOT NULL,email text,
      phone_normalized text,UNIQUE(shop_id,id));`);
    await db.query(`INSERT INTO shops VALUES($1,'a','active'),($2,'b','active')`,[ID.shopA,ID.shopB]);
    await db.query(`INSERT INTO customers(id,shop_id,name,phone,phone_normalized) VALUES
      ($1,$3,'Legacy A','+6581111111','+6581111111'),($2,$4,'Legacy B','+6581111111','+6581111111')`,
      [ID.customerA,ID.customerB,ID.shopA,ID.shopB]);
    for(const file of chain) await db.query(migration(file));
    const legacy=(await db.query('SELECT shop_id,member_code FROM customers ORDER BY shop_id')).rows;
    assert.deepEqual(legacy.map(r=>r.member_code),['MEM-000001','MEM-000001']);
    await db.query(`UPDATE shop_customer_settings SET member_code_prefix='GG-' WHERE shop_id=$1`,[ID.shopA]);
    const firstNew=(await db.query(`INSERT INTO customers(shop_id,name,phone) VALUES($1,'New','+6582222222') RETURNING id,member_code`,[ID.shopA])).rows[0];
    assert.equal(firstNew.member_code,'GG-000002');
    await db.query(`UPDATE shop_customer_settings SET member_code_prefix='NEW-' WHERE shop_id=$1`,[ID.shopA]);
    assert.equal((await db.query('SELECT member_code FROM customers WHERE id=$1',[firstNew.id])).rows[0].member_code,'GG-000002');
    assert.equal((await db.query(`INSERT INTO customers(shop_id,name,phone) VALUES($1,'Later','+6583333333') RETURNING member_code`,[ID.shopA])).rows[0].member_code,'NEW-000003');

    await db.query(`INSERT INTO customer_phone_identities(shop_id,customer_id,phone_normalized,is_primary,verified_at)
      VALUES($1,$2,'+6599999999',true,now()),($3,$4,'+6599999999',true,now())`,[ID.shopA,firstNew.id,ID.shopB,ID.customerB]);
    await assert.rejects(db.query(`INSERT INTO customer_phone_identities(shop_id,customer_id,phone_normalized,is_primary,verified_at)
      VALUES($1,$2,'+6599999999',true,now())`,[ID.shopA,ID.customerA]),e=>e.code==='23505');

    pool=new Pool({connectionString:url,ssl:false}); let sent=[]; let clock=new Date('2030-01-01T00:00:00Z');
    const service=createCustomerMemberIdentity({pool,pepper:'test-pepper',now:()=>new Date(clock),getProvider:()=>({key:'fake',sendOtp:async payload=>{sent.push(payload);return{messageId:`m-${sent.length}`};}})});
    assert.equal(normalizeSelectedPhone({countryCode:'+65',phone:'8123 4567'}),'+6581234567');
    assert.equal(normalizeSelectedPhone({phone:'8123 4567'}),null);
    const legacyChallenge=await service.requestOtp({shopSlug:'a',countryCode:'+65',phone:'8111 1111',ip:'127.0.0.7',userAgent:'legacy'});
    const legacySession=await service.verifySignIn({challengeId:legacyChallenge.challengeId,code:sent.at(-1).code,name:'Legacy A'});
    assert.equal(legacySession.customerId,ID.customerA);
    assert.equal((await db.query('SELECT member_code FROM customers WHERE id=$1',[ID.customerA])).rows[0].member_code,'MEM-000001');
    clock=new Date(clock.getTime()+61000);
    const requested=await service.requestOtp({shopSlug:'a',countryCode:'+65',phone:'8444 4444',ip:'127.0.0.1',userAgent:'test'});
    const requestedCode=sent.at(-1).code; assert.ok(requested.challengeId); assert.equal(sent.length,2);
    await assert.rejects(service.requestOtp({shopSlug:'a',countryCode:'+65',phone:'8444 4444',ip:'127.0.0.1',userAgent:'test'}),e=>e.code==='OTP_RESEND_TOO_SOON');
    const challenge=(await db.query('SELECT code_hash FROM customer_otp_challenges WHERE id=$1',[requested.challengeId])).rows[0];
    assert.match(challenge.code_hash,/^[0-9a-f]{64}$/); assert.notEqual(challenge.code_hash,requestedCode);
    const wrongCode=requestedCode==='000000'?'999999':'000000';
    await assert.rejects(service.verifySignIn({challengeId:requested.challengeId,code:wrongCode,name:'Verified'}),e=>e.code==='OTP_INVALID');
    assert.equal((await db.query('SELECT attempts FROM customer_otp_challenges WHERE id=$1',[requested.challengeId])).rows[0].attempts,1);
    const signedIn=await service.verifySignIn({challengeId:requested.challengeId,code:requestedCode,name:'Verified'});
    const member=(await db.query('SELECT id,member_code,identity_status FROM customers WHERE id=$1',[signedIn.customerId])).rows[0];
    assert.equal(member.identity_status,'verified_member'); assert.match(member.member_code,/^NEW-/);
    assert.equal((await service.authenticate(signedIn.token)).customer_id,signedIn.customerId);
    await assert.rejects(service.verifySignIn({challengeId:requested.challengeId,code:requestedCode,name:'Again'}),e=>e.code==='OTP_INVALID');

    clock=new Date(clock.getTime()+61000);
    const locked=await service.requestOtp({shopSlug:'a',countryCode:'+65',phone:'8666 6666',ip:'127.0.0.4',userAgent:'attempts'});
    const lockedCode=sent.at(-1).code, bad=lockedCode==='111111'?'222222':'111111';
    for(let attempt=0;attempt<5;attempt+=1) await assert.rejects(service.verifySignIn({challengeId:locked.challengeId,code:bad,name:'Locked'}),e=>e.code==='OTP_INVALID');
    await assert.rejects(service.verifySignIn({challengeId:locked.challengeId,code:lockedCode,name:'Locked'}),e=>e.code==='OTP_INVALID');
    assert.equal((await db.query('SELECT attempts FROM customer_otp_challenges WHERE id=$1',[locked.challengeId])).rows[0].attempts,5);

    clock=new Date(clock.getTime()+61000);
    for(let request=0;request<3;request+=1){
      await service.requestOtp({shopSlug:'a',countryCode:'+65',phone:'8777 7777',ip:'127.0.0.5',userAgent:'rate'});
      clock=new Date(clock.getTime()+61000);
    }
    await assert.rejects(service.requestOtp({shopSlug:'a',countryCode:'+65',phone:'8777 7777',ip:'127.0.0.5',userAgent:'rate'}),e=>e.code==='OTP_RATE_LIMITED');

    const change=await service.requestOtp({shopSlug:'a',countryCode:'+60',phone:'1234 5678',purpose:'phone_change',customerId:signedIn.customerId,ip:'127.0.0.2',userAgent:'test'});
    const oldCode=member.member_code;
    await service.confirmPhoneChange({session:{shop_id:ID.shopA,customer_id:signedIn.customerId},challengeId:change.challengeId,code:sent.at(-1).code});
    const changed=(await db.query('SELECT id,member_code,phone_normalized FROM customers WHERE id=$1',[signedIn.customerId])).rows[0];
    assert.equal(changed.id,signedIn.customerId);assert.equal(changed.member_code,oldCode);assert.equal(changed.phone_normalized,'+6012345678');
    assert.equal(Number((await db.query('SELECT COUNT(*) FROM customer_phone_identities WHERE customer_id=$1',[signedIn.customerId])).rows[0].count),2);

    clock=new Date(clock.getTime()+61000);
    const expiring=await service.requestOtp({shopSlug:'a',countryCode:'+65',phone:'8555 5555',ip:'127.0.0.3',userAgent:'test'});
    clock=new Date(clock.getTime()+6*60*1000);
    await assert.rejects(service.verifySignIn({challengeId:expiring.challengeId,code:sent.at(-1).code,name:'Expired'}),e=>e.code==='OTP_INVALID');

    await db.query(`UPDATE shop_customer_settings SET dob_requirement='required' WHERE shop_id=$1`,[ID.shopA]);
    clock=new Date(clock.getTime()+61000);
    const dobChallenge=await service.requestOtp({shopSlug:'a',countryCode:'+65',phone:'8888 8888',ip:'127.0.0.6',userAgent:'dob'});
    const dobCode=sent.at(-1).code;
    await assert.rejects(service.verifySignIn({challengeId:dobChallenge.challengeId,code:dobCode,name:'DOB Member'}),e=>e.code==='DOB_REQUIRED');
    const dobMember=await service.verifySignIn({challengeId:dobChallenge.challengeId,code:dobCode,name:'DOB Member',dateOfBirth:'2000-01-02',gender:'prefer_not_to_say'});
    const profile=(await db.query(`SELECT to_char(date_of_birth,'YYYY-MM-DD') AS date_of_birth,gender FROM customers WHERE id=$1`,[dobMember.customerId])).rows[0];
    assert.equal(profile.date_of_birth,'2000-01-02');assert.equal(profile.gender,'prefer_not_to_say');
  }finally{if(pool)await pool.end().catch(()=>{});if(db)await db.end().catch(()=>{});pg.kill('SIGTERM');await new Promise(r=>pg.once('exit',r));fs.rmSync(temp,{recursive:true,force:true});}
});
