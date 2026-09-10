'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');

const ROOT = path.join(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const sql = name => fs.readFileSync(path.join(ROOT, 'migrations', name), 'utf8');
const files = [
  '028_customers_composite_key_preflight_readonly.sql',
  '029_customers_composite_key_schema.sql',
  '030_customers_composite_key_verification_readonly.sql',
  '031_booking_recipient_booker_preflight_readonly.sql',
  '032_booking_recipient_booker_schema.sql',
  '033_booking_recipient_booker_legacy_backfill.sql',
  '034_booking_recipient_booker_consistency.sql',
  '035_booking_recipient_booker_verification_readonly.sql'
];
const ids = {
  shopA: '11111111-1111-4111-8111-111111111111', shopB: '11111111-1111-4111-8111-222222222222',
  customerA: '22222222-2222-4222-8222-111111111111', customerB: '22222222-2222-4222-8222-222222222222',
  customerOther: '22222222-2222-4222-8222-333333333333', appointment: '33333333-3333-4333-8333-111111111111'
};

test('PostgreSQL 17 recipient/booker migration chain is tenant safe and legacy compatible', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-party-pg-')); const data = path.join(temp, 'data');
  assert.equal(spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' }).status, 0);
  const port = 56900 + Math.floor(Math.random() * 300); const pg = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port)], { stdio: 'ignore' });
  const url = `postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`; let db;
  try {
    for (let n=0;n<50;n+=1) { try { db=new Client({connectionString:url}); await db.connect(); break; } catch { if(db) await db.end().catch(()=>{}); await new Promise(r=>setTimeout(r,100)); } }
    assert.ok(db);
    await db.query(`CREATE EXTENSION pgcrypto; CREATE TABLE shops(id uuid PRIMARY KEY); CREATE TABLE customers(id uuid PRIMARY KEY,shop_id uuid NOT NULL,name text NOT NULL,phone text,email text); CREATE TABLE appointments(id uuid PRIMARY KEY,shop_id uuid NOT NULL,customer_id uuid NOT NULL,CONSTRAINT appointments_customer_id_fkey FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE RESTRICT);`);
    await db.query(`INSERT INTO shops VALUES($1),($2)`, [ids.shopA,ids.shopB]);
    await db.query(`INSERT INTO customers VALUES($1,$4,'A','+65 8123-4567',NULL),($2,$4,'B','0065 81234567',NULL),($3,$5,'Other','+65 8123-4567',NULL)`, [ids.customerA,ids.customerB,ids.customerOther,ids.shopA,ids.shopB]);
    await db.query(`ALTER TABLE appointments DROP CONSTRAINT appointments_customer_id_fkey; ALTER TABLE appointments ADD CONSTRAINT appointments_customer_id_fkey FOREIGN KEY(customer_id) REFERENCES customers(id)`);
    await db.query(sql(files[0])); await db.query(sql(files[1])); await db.query(sql(files[2]));
    await assert.rejects(db.query(sql(files[3])), /Legacy appointments customer FK missing or drifted/);
    await db.query('ROLLBACK');
    await db.query(`ALTER TABLE appointments DROP CONSTRAINT appointments_customer_id_fkey; ALTER TABLE appointments ADD CONSTRAINT appointments_customer_id_fkey FOREIGN KEY(customer_id) REFERENCES customers(id) ON DELETE RESTRICT`);
    await db.query(`INSERT INTO appointments VALUES($1,$2,$3)`, [ids.appointment,ids.shopA,ids.customerOther]);
    await assert.rejects(db.query(sql(files[3])), /Cross-shop appointment customer link detected/);
    await db.query('ROLLBACK');
    await db.query(`UPDATE appointments SET customer_id=$2 WHERE id=$1`, [ids.appointment,ids.customerA]);
    for (const file of files.slice(3)) await db.query(sql(file));
    const legacy=(await db.query(`SELECT customer_id,booker_customer_id,recipient_customer_id,booker_name_snapshot FROM appointments WHERE id=$1`,[ids.appointment])).rows[0];
    assert.equal(legacy.customer_id,ids.customerA); assert.equal(legacy.booker_customer_id,ids.customerA); assert.equal(legacy.recipient_customer_id,ids.customerA); assert.equal(legacy.booker_name_snapshot,null);
    await db.query(`INSERT INTO appointments(id,shop_id,customer_id,booker_customer_id,recipient_customer_id,booker_name_snapshot,recipient_name_snapshot) VALUES(gen_random_uuid(),$1,$2,$2,$2,'A','A')`,[ids.shopA,ids.customerA]);
    await db.query(`INSERT INTO appointments(id,shop_id,customer_id,booker_customer_id,recipient_customer_id) VALUES(gen_random_uuid(),$1,$2,$3,$2)`,[ids.shopA,ids.customerB,ids.customerA]);
    await assert.rejects(db.query(`INSERT INTO appointments(id,shop_id,customer_id,booker_customer_id,recipient_customer_id) VALUES(gen_random_uuid(),$1,$2,$2,$2)`,[ids.shopA,ids.customerOther]),e=>e.code==='23503');
    await assert.rejects(db.query(`INSERT INTO appointments(id,shop_id,customer_id,booker_customer_id,recipient_customer_id) VALUES(gen_random_uuid(),$1,$2,$3,$2)`,[ids.shopA,ids.customerA,ids.customerOther]),e=>e.code==='23503');
    await assert.rejects(db.query(`INSERT INTO appointments(id,shop_id,customer_id,booker_customer_id,recipient_customer_id) VALUES(gen_random_uuid(),$1,$2,$2,$3)`,[ids.shopA,ids.customerA,ids.customerB]),e=>e.code==='23514');
    await assert.rejects(db.query(`INSERT INTO appointments(id,shop_id,customer_id,booker_customer_id,recipient_customer_id) VALUES(gen_random_uuid(),$1,$2,$2,NULL)`,[ids.shopA,ids.customerA]),e=>e.code==='23502');
    await assert.rejects(db.query(`INSERT INTO appointments(id,shop_id,customer_id,booker_customer_id,recipient_customer_id) VALUES(gen_random_uuid(),$1,$2,NULL,$2)`,[ids.shopA,ids.customerA]),e=>e.code==='23502');
    const duplicates=(await db.query(`SELECT shop_id,phone_normalized,count(*) FROM customers WHERE phone_normalized IS NOT NULL GROUP BY shop_id,phone_normalized ORDER BY shop_id`)).rows;
    assert.equal(duplicates.find(row=>row.shop_id===ids.shopA).count,'2');
    assert.equal(duplicates.find(row=>row.shop_id===ids.shopB).count,'1');
  } finally {
    if(db) await db.end().catch(()=>{}); pg.kill('SIGTERM'); await new Promise(r=>pg.once('exit',r)); fs.rmSync(temp,{recursive:true,force:true});
  }
});
