'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  CustomerIdentityError,
  normalizePhone,
  recipientCustomerIdForBenefits,
  resolveBookingParties,
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

test('booking parties resolve myself and someone else independently inside one trusted shop', async () => {
  const calls = [];
  const client = { query: async (_sql, params) => {
    calls.push(params);
    return { rows: [{ id: params[1] === '+6599999999' ? 'recipient-b' : 'booker-a' }] };
  } };
  const myself = await resolveBookingParties(client, { shopId: 'shop-a', body: {
    customerName: 'A', phone: '+6581234567', email: 'a@example.invalid'
  } });
  assert.equal(myself.booker.customerId, 'booker-a');
  assert.equal(myself.recipient.customerId, 'booker-a');
  assert.equal(calls.length, 1);

  const someoneElse = await resolveBookingParties(client, { shopId: 'shop-a', body: {
    bookingFor: 'someone_else', customerName: 'A', phone: '+6581234567',
    recipient: { name: 'B', phone: '+6599999999', email: 'b@example.invalid' }
  } });
  assert.equal(someoneElse.booker.customerId, 'booker-a');
  assert.equal(someoneElse.recipient.customerId, 'recipient-b');
  assert.ok(calls.every(params => params[0] === 'shop-a'));
});

test('booking parties reject forged customer ids and safely retain unsupported local phones without guessing', async () => {
  const noMatches = { query: async sql => /INSERT INTO customers/.test(sql)
    ? { rows: [{ id: 'new-customer' }] } : { rows: [] } };
  await assert.rejects(resolveBookingParties(noMatches, { shopId: 'shop-a', body: {
    customerName: 'A', phone: '+6581234567', customerId: 'forged'
  } }), error => error.code === 'CLIENT_CUSTOMER_ID_FORBIDDEN');
  const unsupported = await resolveBookingParties(noMatches, { shopId: 'shop-a', body: {
    customerName: 'A', phone: '123'
  } });
  assert.equal(unsupported.booker.phoneNormalized, null);
  assert.equal(unsupported.booker.phone, '123');
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
