'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client, Pool } = require('pg');

const ROOT = path.join(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const sql = file => fs.readFileSync(path.join(ROOT, file), 'utf8');
const id = {
  shop:'11111111-1111-4111-8111-111111111111', shop2:'11111111-1111-4111-8111-222222222222',
  location:'22222222-2222-4222-8222-222222222222', location2:'22222222-2222-4222-8222-333333333333',
  staffA:'33333333-3333-4333-8333-111111111111', staffB:'33333333-3333-4333-8333-222222222222', staffC:'33333333-3333-4333-8333-333333333333', staffD:'33333333-3333-4333-8333-444444444444',
  accountA:'44444444-4444-4444-8444-111111111111', accountB:'44444444-4444-4444-8444-222222222222', accountC:'44444444-4444-4444-8444-333333333333', accountD:'44444444-4444-4444-8444-444444444444',
  service:'55555555-5555-4555-8555-555555555555'
};

const SCHEMA = `
CREATE EXTENSION btree_gist; CREATE EXTENSION pgcrypto;
CREATE TABLE shops(id uuid PRIMARY KEY,status text NOT NULL);
CREATE TABLE locations(id uuid PRIMARY KEY,shop_id uuid NOT NULL,timezone text NOT NULL,is_active boolean NOT NULL,UNIQUE(shop_id,id));
CREATE TABLE staff(id uuid PRIMARY KEY,shop_id uuid NOT NULL,is_active boolean NOT NULL,bookable boolean NOT NULL,can_login boolean NOT NULL,UNIQUE(shop_id,id));
CREATE TABLE staff_accounts(id uuid PRIMARY KEY,shop_id uuid NOT NULL,staff_id uuid NOT NULL,session_version integer NOT NULL,status text NOT NULL,UNIQUE(shop_id,id,staff_id));
CREATE TABLE staff_sessions(staff_account_id uuid NOT NULL,shop_id uuid NOT NULL,staff_id uuid NOT NULL,location_id uuid NOT NULL,token_hash text NOT NULL,revoked_at timestamptz,expires_at timestamptz NOT NULL,session_version integer NOT NULL);
CREATE TABLE staff_permissions(shop_id uuid NOT NULL,staff_account_id uuid NOT NULL,can_view_customer_history boolean,can_view_service_notes boolean,can_view_own_sales boolean,can_view_own_commission boolean,can_view_full_customer_phone boolean,can_move_own_appointments boolean);
CREATE TABLE services(id uuid PRIMARY KEY,shop_id uuid NOT NULL,name text NOT NULL,duration_minutes integer NOT NULL,is_active boolean NOT NULL,bookable boolean NOT NULL,UNIQUE(shop_id,id));
CREATE TABLE staff_services(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,staff_id uuid NOT NULL,service_id uuid NOT NULL,is_active boolean NOT NULL);
CREATE TABLE staff_location_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,location_id uuid NOT NULL,staff_id uuid NOT NULL,is_active boolean NOT NULL);
CREATE TABLE staff_location_working_hours(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,location_id uuid NOT NULL,staff_id uuid NOT NULL,day_of_week integer NOT NULL,start_time time NOT NULL,end_time time NOT NULL,is_active boolean NOT NULL,effective_from date,effective_to date);
CREATE TABLE staff_schedule_overrides(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid,location_id uuid,staff_id uuid,schedule_date date,is_active boolean,approval_status text,override_type text,start_time time,end_time time);
CREATE TABLE appointments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,location_id uuid NOT NULL,service_id uuid NOT NULL,staff_id uuid NOT NULL,start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,status text NOT NULL,override_conflict boolean NOT NULL DEFAULT false,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(shop_id,location_id,id),UNIQUE(shop_id,id),FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id) ON DELETE RESTRICT,CONSTRAINT prevent_staff_double_booking EXCLUDE USING gist(staff_id WITH =,tstzrange(start_at,end_at,'[)') WITH &&) WHERE(status IN('pending','confirmed') AND override_conflict=false));
CREATE TABLE appointment_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,location_id uuid NOT NULL,appointment_id uuid NOT NULL,service_id uuid NOT NULL,sequence_no integer NOT NULL,status text NOT NULL,start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(shop_id,location_id,id),FOREIGN KEY(shop_id,location_id,appointment_id) REFERENCES appointments(shop_id,location_id,id) ON DELETE RESTRICT);
CREATE TABLE appointment_item_staff_assignments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,location_id uuid NOT NULL,appointment_item_id uuid NOT NULL,staff_id uuid NOT NULL,role text NOT NULL CHECK(role IN('primary','assistant')),start_at timestamptz NOT NULL,end_at timestamptz NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),updated_at timestamptz NOT NULL DEFAULT now(),UNIQUE(shop_id,location_id,appointment_item_id,staff_id),FOREIGN KEY(shop_id,location_id,appointment_item_id) REFERENCES appointment_items(shop_id,location_id,id) ON DELETE RESTRICT,FOREIGN KEY(shop_id,staff_id) REFERENCES staff(shop_id,id) ON DELETE RESTRICT);
CREATE UNIQUE INDEX appointment_item_staff_primary_uidx ON appointment_item_staff_assignments(shop_id,location_id,appointment_item_id) WHERE role='primary';
CREATE INDEX appointment_item_staff_schedule_idx ON appointment_item_staff_assignments(shop_id,location_id,staff_id,start_at,end_at);
CREATE TABLE appointment_time_change_history(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),shop_id uuid NOT NULL,location_id uuid NOT NULL,appointment_id uuid NOT NULL,staff_id uuid NOT NULL,actor_type text NOT NULL,actor_id uuid,old_start_at timestamptz NOT NULL,old_end_at timestamptz NOT NULL,new_start_at timestamptz NOT NULL,new_end_at timestamptz NOT NULL,reason text,source text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
`;

test('real staff move endpoint uses canonical assignments and rolls back safely', {timeout:120000}, async t => {
  if (!fs.existsSync(path.join(PG_BIN,'initdb'))) return t.skip('PostgreSQL 17 unavailable');
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'gg-move-pg-')), data=path.join(temp,'data');
  assert.equal(spawnSync(path.join(PG_BIN,'initdb'),['-D',data,'-A','trust','--no-locale'],{encoding:'utf8'}).status,0);
  const port=56000+Math.floor(Math.random()*500), pg=spawn(path.join(PG_BIN,'postgres'),['-D',data,'-p',String(port)],{stdio:'ignore'});
  const url=`postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`; let db;
  try {
    for(let n=0;n<50;n++){try{db=new Client({connectionString:url});await db.connect();break;}catch{if(db)await db.end().catch(()=>{});await new Promise(r=>setTimeout(r,100));}}
    assert.ok(db); await db.query(SCHEMA);
    await db.query(sql('migrations/014_assignment_collision_projection_schema.sql'));
    await db.query(sql('migrations/015_assignment_collision_backfill.sql'));
    await db.query(sql('migrations/016_assignment_collision_constraint.sql'));
    await db.query(sql('migrations/026_multi_service_parent_collision_compatibility.sql'));
    const tokenA='staff-a-token',tokenB='staff-b-token',tokenC='staff-c-token',tokenD='staff-d-token';
    await db.query(`INSERT INTO shops VALUES($1,'active'),($2,'active')`,[id.shop,id.shop2]);
    await db.query(`INSERT INTO locations VALUES($1,$2,'UTC',true),($3,$4,'UTC',true)`,[id.location,id.shop,id.location2,id.shop2]);
    await db.query(`INSERT INTO staff VALUES($1,$5,true,true,true),($2,$5,true,true,true),($3,$5,true,true,true),($4,$6,true,true,true)`,[id.staffA,id.staffB,id.staffC,id.staffD,id.shop,id.shop2]);
    await db.query(`INSERT INTO staff_accounts VALUES($1,$5,$6,1,'active'),($2,$5,$7,1,'active'),($3,$5,$8,1,'active'),($4,$9,$10,1,'active')`,[id.accountA,id.accountB,id.accountC,id.accountD,id.shop,id.staffA,id.staffB,id.staffC,id.shop2,id.staffD]);
    for(const [account,shop,location,staff,token] of [[id.accountA,id.shop,id.location,id.staffA,tokenA],[id.accountB,id.shop,id.location,id.staffB,tokenB],[id.accountC,id.shop,id.location,id.staffC,tokenC],[id.accountD,id.shop2,id.location2,id.staffD,tokenD]]){
      await db.query(`INSERT INTO staff_sessions VALUES($1,$2,$3,$4,$5,NULL,now()+interval '1 day',1)`,[account,shop,staff,location,crypto.createHash('sha256').update(token).digest('hex')]);
      await db.query(`INSERT INTO staff_permissions VALUES($1,$2,false,false,false,false,false,true)`,[shop,account]);
    }
    await db.query(`INSERT INTO services VALUES($1,$2,'Service',60,true,true)`,[id.service,id.shop]);
    for(const staff of [id.staffA,id.staffB,id.staffC]){
      await db.query(`INSERT INTO staff_services(shop_id,staff_id,service_id,is_active) VALUES($1,$2,$3,true)`,[id.shop,staff,id.service]);
      await db.query(`INSERT INTO staff_location_assignments(shop_id,location_id,staff_id,is_active) VALUES($1,$2,$3,true)`,[id.shop,id.location,staff]);
      for(let day=1;day<=7;day++) await db.query(`INSERT INTO staff_location_working_hours(shop_id,location_id,staff_id,day_of_week,start_time,end_time,is_active) VALUES($1,$2,$3,$4,'00:00','23:59',true)`,[id.shop,id.location,staff,day]);
    }
    await db.query(`INSERT INTO staff_location_assignments(shop_id,location_id,staff_id,is_active) VALUES($1,$2,$3,true)`,[id.shop2,id.location2,id.staffD]);
    process.env.DATABASE_URL=url;
    delete require.cache[require.resolve('../server')];
    const {app}=require('../server');
    const originalPool=app.locals.bookingPool;
    const testPool=new Pool({connectionString:url,ssl:false});
    app.locals.bookingPool=testPool;
    const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
    const base=`http://127.0.0.1:${server.address().port}`;
    const create = async (start, primaryStaffs) => {
      const end=new Date(new Date(start).getTime()+primaryStaffs.length*3600000).toISOString(); await db.query('BEGIN');
      const parent=(await db.query(`INSERT INTO appointments(shop_id,location_id,service_id,staff_id,start_at,end_at,status) VALUES($1,$2,$3,$4,$5,$6,'pending') RETURNING *`,[id.shop,id.location,id.service,primaryStaffs[0],start,end])).rows[0];
      for(let n=0;n<primaryStaffs.length;n++){const s=new Date(new Date(start).getTime()+n*3600000).toISOString(),e=new Date(new Date(start).getTime()+(n+1)*3600000).toISOString();const item=(await db.query(`INSERT INTO appointment_items(shop_id,location_id,appointment_id,service_id,sequence_no,status,start_at,end_at) VALUES($1,$2,$3,$4,$5,'pending',$6,$7) RETURNING id`,[id.shop,id.location,parent.id,id.service,n+1,s,e])).rows[0];await db.query(`INSERT INTO appointment_item_staff_assignments(shop_id,location_id,appointment_item_id,staff_id,role,start_at,end_at) VALUES($1,$2,$3,$4,'primary',$5,$6)`,[id.shop,id.location,item.id,primaryStaffs[n],s,e]);}
      await db.query('COMMIT'); return parent;
    };
    const move=async(parent,token,newStartAt)=>fetch(`${base}/api/staff/appointments/${parent.id}/time`,{method:'PATCH',headers:{'content-type':'application/json','cookie':`gg_beauty_staff_session=${token}`,'origin':base},body:JSON.stringify({newStartAt})});
    const addAssistant=async(parent,staff)=>{const item=(await db.query(`SELECT id,start_at,end_at FROM appointment_items WHERE appointment_id=$1 ORDER BY sequence_no LIMIT 1`,[parent.id])).rows[0];await db.query(`INSERT INTO appointment_item_staff_assignments(shop_id,location_id,appointment_item_id,staff_id,role,start_at,end_at) VALUES($1,$2,$3,$4,'assistant',$5,$6)`,[id.shop,id.location,item.id,staff,item.start_at,item.end_at]);};
    const times=async parent=>(await db.query(`SELECT p.start_at,p.end_at,(SELECT json_agg(json_build_array(i.start_at,i.end_at) ORDER BY i.sequence_no) FROM appointment_items i WHERE i.appointment_id=p.id) items,(SELECT json_agg(json_build_array(a.start_at,a.end_at) ORDER BY i.sequence_no,a.id) FROM appointment_item_staff_assignments a JOIN appointment_items i ON i.id=a.appointment_item_id WHERE i.appointment_id=p.id) assignments FROM appointments p WHERE id=$1`,[parent.id])).rows[0];
    const auditCount=async parent=>(await db.query(`SELECT count(*)::int n FROM appointment_time_change_history WHERE appointment_id=$1`,[parent.id])).rows[0].n;
    const expectMovedOnce=async(parent,start,itemCount)=>{
      const actual=await times(parent),baseMs=new Date(start).getTime();
      assert.equal(new Date(actual.start_at).toISOString(),new Date(baseMs).toISOString());
      assert.equal(new Date(actual.end_at).toISOString(),new Date(baseMs+itemCount*3600000).toISOString());
      for(let n=0;n<itemCount;n++){
        const expectedStart=new Date(baseMs+n*3600000).toISOString(),expectedEnd=new Date(baseMs+(n+1)*3600000).toISOString();
        assert.deepEqual(actual.items[n].map(value=>new Date(value).toISOString()),[expectedStart,expectedEnd]);
        assert.deepEqual(actual.assignments[n].map(value=>new Date(value).toISOString()),[expectedStart,expectedEnd]);
      }
    };

    await t.test('single and same-owner multi-item moves pass without double-shifting assignments',async()=>{let p=await create('2036-01-07T10:00:00Z',[id.staffA]);assert.equal((await move(p,tokenA,'2036-01-07T12:00:00Z')).status,200);await expectMovedOnce(p,'2036-01-07T12:00:00Z',1);assert.equal(await auditCount(p),1);p=await create('2036-01-08T10:00:00Z',[id.staffA,id.staffA]);assert.equal((await move(p,tokenA,'2036-01-08T13:00:00Z')).status,200);await expectMovedOnce(p,'2036-01-08T13:00:00Z',2);assert.equal(await auditCount(p),1);});
    await t.test('both canonical primary staff fail closed consistently for multi-primary appointment',async()=>{const p=await create('2036-01-09T10:00:00Z',[id.staffA,id.staffB]),before=JSON.stringify(await times(p));assert.equal((await move(p,tokenA,'2036-01-09T14:00:00Z')).status,409);assert.equal((await move(p,tokenB,'2036-01-09T14:00:00Z')).status,409);assert.equal(JSON.stringify(await times(p)),before);assert.equal(await auditCount(p),0);});
    await t.test('unrelated, assistant-only, and cross-tenant staff remain least-privileged',async()=>{let p=await create('2036-01-13T10:00:00Z',[id.staffA]);let before=JSON.stringify(await times(p));assert.equal((await move(p,tokenC,'2036-01-13T12:00:00Z')).status,404);assert.equal((await move(p,tokenD,'2036-01-13T12:00:00Z')).status,404);assert.equal(JSON.stringify(await times(p)),before);assert.equal(await auditCount(p),0);p=await create('2036-01-14T10:00:00Z',[id.staffA]);await addAssistant(p,id.staffC);before=JSON.stringify(await times(p));assert.equal((await move(p,tokenC,'2036-01-14T12:00:00Z')).status,409);assert.equal(JSON.stringify(await times(p)),before);assert.equal(await auditCount(p),0);});
    await t.test('collision, schedule, and leave failures roll back all rows and audit history',async()=>{await create('2036-01-10T14:00:00Z',[id.staffA]);let p=await create('2036-01-10T10:00:00Z',[id.staffA,id.staffA]),before=JSON.stringify(await times(p));assert.equal((await move(p,tokenA,'2036-01-10T13:00:00Z')).status,409);assert.equal(JSON.stringify(await times(p)),before);assert.equal(await auditCount(p),0);p=await create('2036-01-11T10:00:00Z',[id.staffA]);before=JSON.stringify(await times(p));assert.equal((await move(p,tokenA,'2036-01-11T23:30:00Z')).status,409);assert.equal(JSON.stringify(await times(p)),before);assert.equal(await auditCount(p),0);p=await create('2036-01-12T10:00:00Z',[id.staffA]);before=JSON.stringify(await times(p));await db.query(`INSERT INTO staff_schedule_overrides(shop_id,location_id,staff_id,schedule_date,is_active,approval_status,override_type) VALUES($1,$2,$3,'2036-01-12',true,'approved','leave')`,[id.shop,id.location,id.staffA]);assert.equal((await move(p,tokenA,'2036-01-12T14:00:00Z')).status,409);assert.equal(JSON.stringify(await times(p)),before);assert.equal(await auditCount(p),0);});
    await new Promise((r,j)=>server.close(e=>e?j(e):r())); await testPool.end(); await originalPool.end();
  } finally {if(db)await db.end().catch(()=>{});pg.kill('SIGTERM');await new Promise(r=>pg.once('exit',r));fs.rmSync(temp,{recursive:true,force:true});}
});
