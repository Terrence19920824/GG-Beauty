'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const { app } = require('../server');

const startServer = async () => {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, base: `http://127.0.0.1:${server.address().port}` };
};

test('booking identity and profile routes enforce masked session authority', async () => {
  const previousIdentity = app.locals.customerMemberIdentity;
  const previousAccount = app.locals.customerAccountService;
  const { server, base } = await startServer();
  let session = {
    shop_id: 'shop-a-id', customer_id: 'customer-a', shop_slug: 'shop-a',
    name: 'Alice Tan', phone_normalized: '+6591234567', phone_verified_at: null,
    email: 'protected@example.invalid', date_of_birth: '1990-01-02', gender: 'female'
  };
  let updated = false;
  app.locals.customerMemberIdentity = {
    authenticate: async token => {
      assert.equal(token, 'test-session');
      return session;
    },
    updateProfile: async args => {
      updated = true;
      assert.equal(args.session.customer_id, 'customer-a');
      assert.equal(args.dateOfBirth, '1991-03-04');
    }
  };
  app.locals.customerAccountService = {
    getCustomerSummary: async ({ shopId, customerId }) => {
      assert.deepEqual({ shopId, customerId }, { shopId: 'shop-a-id', customerId: 'customer-a' });
      return { name: 'Alice Updated', isPhoneVerified: true, dateOfBirth: '1991-03-04' };
    }
  };

  try {
    const anonymous = await fetch(`${base}/api/customer/booking-identity?shopSlug=shop-a`);
    assert.equal(anonymous.status, 200);
    assert.deepEqual((await anonymous.json()).data, { authenticated: false });

    const identity = await fetch(`${base}/api/customer/booking-identity?shopSlug=shop-a`, {
      headers: { cookie: 'gg_beauty_customer_session=test-session' }
    });
    assert.equal(identity.status, 200);
    assert.equal(identity.headers.get('cache-control'), 'no-store');
    const identityBody = await identity.json();
    assert.deepEqual(identityBody.data, {
      authenticated: true,
      name: 'Alice Tan',
      maskedPhone: '•••• 4567',
      isPhoneVerified: false
    });
    assert.equal(JSON.stringify(identityBody).includes('protected@example.invalid'), false);
    assert.equal(JSON.stringify(identityBody).includes('1990-01-02'), false);
    assert.equal(JSON.stringify(identityBody).includes('customer-a'), false);

    const wrongShop = await fetch(`${base}/api/customer/booking-identity?shopSlug=shop-b`, {
      headers: { cookie: 'gg_beauty_customer_session=test-session' }
    });
    assert.equal(wrongShop.status, 403);
    assert.equal((await wrongShop.json()).code, 'CUSTOMER_SESSION_SHOP_MISMATCH');

    const unverifiedPatch = await fetch(`${base}/api/customer/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: 'gg_beauty_customer_session=test-session' },
      body: JSON.stringify({ name: 'Alice Updated', dateOfBirth: '1991-03-04' })
    });
    assert.equal(unverifiedPatch.status, 403);
    assert.equal((await unverifiedPatch.json()).code, 'CUSTOMER_PROFILE_VERIFICATION_REQUIRED');
    assert.equal(updated, false);

    session = { ...session, phone_verified_at: new Date('2026-01-01T00:00:00Z') };
    const verifiedPatch = await fetch(`${base}/api/customer/me`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: 'gg_beauty_customer_session=test-session' },
      body: JSON.stringify({ name: 'Alice Updated', email: '', dateOfBirth: '1991-03-04', gender: '' })
    });
    assert.equal(verifiedPatch.status, 200);
    assert.equal(updated, true);
    assert.deepEqual((await verifiedPatch.json()).data, {
      name: 'Alice Updated', isPhoneVerified: true, dateOfBirth: '1991-03-04'
    });
  } finally {
    app.locals.customerMemberIdentity = previousIdentity;
    app.locals.customerAccountService = previousAccount;
    server.close();
    await once(server, 'close');
  }
});
