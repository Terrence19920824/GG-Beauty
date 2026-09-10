'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CustomerIdentityError,
  normalizePhone,
  recipientCustomerIdForBenefits,
  resolveCustomerByPhone
} = require('../lib/customer-identity');

test('phone normalization is deterministic and never guesses a country', () => {
  assert.equal(normalizePhone(' +65 (8123)-4567 '), '+6581234567');
  assert.equal(normalizePhone('0065 8123 4567'), '+6581234567');
  assert.equal(normalizePhone('8123 4567'), '81234567');
  assert.equal(normalizePhone('8123-4567'), '81234567');
  assert.equal(normalizePhone('call-me'), null);
  assert.equal(normalizePhone(''), null);
});

test('phone lookup is shop scoped and ambiguous matches fail closed', async () => {
  const calls = [];
  const client = { query: async (sql, params) => { calls.push({ sql, params }); return { rows: [{ id: 'a' }, { id: 'b' }] }; } };
  await assert.rejects(resolveCustomerByPhone(client, { shopId: 'shop-a', phone: '+65 8123-4567' }),
    error => error instanceof CustomerIdentityError && error.code === 'CUSTOMER_PHONE_AMBIGUOUS');
  assert.deepEqual(calls[0].params, ['shop-a', '+6581234567']);
  assert.match(calls[0].sql, /shop_id=\$1 AND phone_normalized=\$2/);
  assert.doesNotMatch(calls[0].sql, /LIMIT\s+1/i);
});

test('benefit authority is recipient, never booker', () => {
  assert.equal(recipientCustomerIdForBenefits({ recipient_customer_id: 'recipient', booker_customer_id: 'booker' }), 'recipient');
  assert.throws(() => recipientCustomerIdForBenefits({ booker_customer_id: 'booker' }), /RECIPIENT_CUSTOMER_REQUIRED/);
});
