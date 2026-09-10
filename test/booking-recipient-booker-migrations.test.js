'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = name => fs.readFileSync(path.join(__dirname, '..', 'migrations', name), 'utf8');

test('028 and 030 composite-key guards are read-only and exact', () => {
  const preflight = read('028_customers_composite_key_preflight_readonly.sql');
  const verification = read('030_customers_composite_key_verification_readonly.sql');
  for (const sql of [preflight, verification]) {
    assert.match(sql, /BEGIN TRANSACTION READ ONLY/);
    assert.match(sql, /GROUP BY shop_id,id HAVING COUNT\(\*\)>1/);
    assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i);
  }
  assert.match(verification, /indisunique AND ix\.indisvalid AND ix\.indisready/);
  assert.match(verification, /ix\.indpred IS NULL AND ix\.indexprs IS NULL/);
  assert.match(verification, /ARRAY\['shop_id','id'\]/);
  assert.match(verification, /SELECT COUNT\(\*\) AS customers_total,[\s\S]*FROM customers;\s*\n\s*ROLLBACK;/);
});

test('029 changes only the composite unique prerequisite with bounded locks', () => {
  const migration = read('029_customers_composite_key_schema.sql');
  assert.match(migration, /^--[^\n]*\nBEGIN;/);
  assert.match(migration, /lock_timeout='5s'/);
  assert.match(migration, /statement_timeout='30s'/);
  assert.match(migration, /CREATE UNIQUE INDEX customers_shop_id_id_uidx ON public\.customers\(shop_id,id\)/);
  assert.doesNotMatch(migration, /\b(?:INSERT|UPDATE|DELETE)\b/i);
  assert.doesNotMatch(migration, /appointments|booker|recipient|phone_normalized/i);
});

test('031 recipient preflight requires the completed composite key', () => {
  const preflight = read('031_booking_recipient_booker_preflight_readonly.sql');
  assert.match(preflight, /customers\(shop_id,id\) unique prerequisite missing or drifted/);
  assert.match(preflight, /indisunique AND ix\.indisvalid AND ix\.indisready/);
  assert.match(preflight, /ix\.indpred IS NULL AND ix\.indexprs IS NULL/);
});
