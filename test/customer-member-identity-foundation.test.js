'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

test('036-042 chain is staged, bounded, and contains no benefit implementation',()=>{
  const files=fs.readdirSync(path.join(root,'migrations')).filter(x=>/^0(?:3[6-9]|4[0-2])_/.test(x)).sort();
  assert.deepEqual(files,[
    '036_customer_member_identity_preflight_readonly.sql','037_customer_member_profile_schema.sql',
    '038_customer_member_profile_verification_readonly.sql','039_customer_member_code_backfill.sql',
    '040_customer_phone_otp_session_schema.sql','041_customer_member_identity_enforcement.sql',
    '042_customer_member_identity_verification_readonly.sql']);
  for(const file of [files[0],files[2],files[6]]) assert.match(read(`migrations/${file}`),/BEGIN TRANSACTION READ ONLY/);
  for(const file of [files[1],files[3],files[4],files[5]]) {
    const sql=read(`migrations/${file}`);assert.match(sql,/lock_timeout='5s'/);assert.match(sql,/statement_timeout='30s'/);
  }
  const all=files.map(file=>read(`migrations/${file}`)).join('\n');
  assert.doesNotMatch(all,/points_balance|stored_value_balance|package_balance|referral_reward/i);
});

test('OTP foundation stores hashes, bounds attempts, and never trusts client identity',()=>{
  const module=read('lib/customer-member-identity.js'),server=read('server.js');
  assert.match(module,/code_hash/);assert.match(module,/timingSafeEqual/);assert.match(module,/max_attempts/);
  assert.match(module,/OTP_RATE_LIMITED/);assert.match(module,/OTP_RESEND_TOO_SOON/);assert.match(module,/consumed_at/);
  assert.doesNotMatch(read('migrations/040_customer_phone_otp_session_schema.sql'),/otp_code|plaintext/i);
  assert.match(server,/rejectCustomerAuthority/);assert.match(server,/INVALID_IDENTITY_CONTEXT/);
});
