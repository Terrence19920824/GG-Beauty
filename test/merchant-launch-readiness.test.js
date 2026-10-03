'use strict';

process.env.ADMIN_PASSWORD = 'local-test-admin-password';
process.env.NODE_ENV = 'test';

const assert = require('node:assert/strict');
const test = require('node:test');
const QRCode = require('qrcode');
const {
  PublicBaseUrlError,
  READINESS_CHECK_DEFINITIONS,
  READINESS_SQL,
  buildCanonicalBookingUrl,
  createMerchantLaunchReadiness,
  normalizePublicBaseUrl
} = require('../lib/merchant-launch-readiness');
const { app } = require('../server');

const IDS = {
  account: '11111111-1111-4111-8111-111111111111',
  membership: '22222222-2222-4222-8222-222222222222',
  shopA: '33333333-3333-4333-8333-333333333333',
  shopB: '44444444-4444-4444-8444-444444444444'
};

const completeSnapshot = (overrides = {}) => ({
  shop_slug: 'merchant-a',
  shop_status: 'active',
  business_profile: true,
  active_location: true,
  business_timezone: true,
  active_service: true,
  active_staff: true,
  staff_location_assignment: true,
  bookable_capability: true,
  working_schedule: true,
  owner_membership: true,
  ...overrides
});

const response = () => ({
  statusCode: 200,
  headers: {},
  payload: undefined,
  body: undefined,
  setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  status(code) { this.statusCode = code; return this; },
  json(value) { this.payload = value; return this; },
  send(value) { this.body = value; return this; }
});

const request = overrides => ({
  query: {},
  body: undefined,
  headers: {},
  ownerAuth: {
    shopId: IDS.shopA,
    shopSlug: 'merchant-a',
    role: 'owner'
  },
  ...overrides
});

test('canonical booking URL accepts only a trusted origin and never needs request host data', () => {
  assert.equal(
    buildCanonicalBookingUrl('https://booking.example.com/', 'Merchant-A'),
    'https://booking.example.com/book/merchant-a'
  );
  assert.equal(
    buildCanonicalBookingUrl('http://127.0.0.1:3000', 'local-shop'),
    'http://127.0.0.1:3000/book/local-shop'
  );
  assert.equal(normalizePublicBaseUrl('https://booking.example.com'), 'https://booking.example.com');

  for (const invalid of [
    undefined,
    '',
    'http://booking.example.com',
    'https://user:password@booking.example.com',
    'https://booking.example.com/subpath',
    'https://booking.example.com/?host=attacker.invalid',
    'javascript:alert(1)'
  ]) {
    assert.throws(
      () => buildCanonicalBookingUrl(invalid, 'merchant-a'),
      error => error instanceof PublicBaseUrlError && error.code === 'PUBLIC_BASE_URL_UNAVAILABLE'
    );
  }
});

test('complete and incomplete readiness are server-derived with all required blocking checks', async () => {
  let snapshot = completeSnapshot();
  const queries = [];
  const service = createMerchantLaunchReadiness({
    pool: {
      query: async (sql, params) => {
        queries.push({ sql, params });
        return { rows: [snapshot] };
      }
    },
    getPublicBaseUrl: () => 'https://booking.example.com',
    qrCode: { toString: async () => '<svg></svg>' }
  });

  const completeResponse = response();
  await service.getReadiness(request(), completeResponse);
  assert.equal(completeResponse.statusCode, 200);
  assert.equal(completeResponse.payload.data.ready, true);
  assert.equal(completeResponse.payload.data.checks.length, 11);
  assert.equal(completeResponse.payload.data.checks.every(check => check.blocking), true);
  assert.equal(completeResponse.payload.data.booking.url, 'https://booking.example.com/book/merchant-a');
  assert.deepEqual(queries[0].params, [IDS.shopA]);
  assert.equal(queries[0].sql, READINESS_SQL);

  for (const key of [
    'business_profile',
    'active_location',
    'business_timezone',
    'active_service',
    'active_staff',
    'staff_location_assignment',
    'bookable_capability',
    'working_schedule',
    'owner_membership'
  ]) {
    snapshot = completeSnapshot({ [key]: false });
    const incompleteResponse = response();
    await service.getReadiness(request(), incompleteResponse);
    assert.equal(incompleteResponse.payload.data.ready, false, key);
    assert.equal(
      incompleteResponse.payload.data.checks.find(check => check.key === key).status,
      'incomplete',
      key
    );
  }

  assert.deepEqual(
    READINESS_CHECK_DEFINITIONS.map(check => check.key),
    [
      'business_profile', 'active_location', 'business_timezone',
      'active_service', 'active_staff', 'staff_location_assignment',
      'bookable_capability', 'working_schedule', 'owner_membership',
      'booking_url', 'booking_qr'
    ]
  );
});

test('missing trusted base URL keeps public URL and QR checks incomplete', async () => {
  const service = createMerchantLaunchReadiness({
    pool: { query: async () => ({ rows: [completeSnapshot()] }) },
    getPublicBaseUrl: () => undefined,
    qrCode: { toString: async () => assert.fail('QR must not be generated') }
  });
  const res = response();
  await service.getReadiness(request(), res);
  assert.equal(res.payload.data.ready, false);
  assert.equal(res.payload.data.booking.url, null);
  assert.equal(res.payload.data.booking.trustedPublicBaseUrlConfigured, false);
  assert.equal(res.payload.data.booking.qrAvailable, false);
  for (const key of ['booking_url', 'booking_qr']) {
    assert.equal(res.payload.data.checks.find(check => check.key === key).status, 'incomplete');
  }
});

test('QR payload is exactly the canonical public URL with high error correction', async () => {
  const calls = [];
  const service = createMerchantLaunchReadiness({
    pool: { query: async () => assert.fail('QR generation must use authenticated shop context') },
    getPublicBaseUrl: () => 'https://booking.example.com',
    qrCode: {
      toString: async (payload, options) => {
        calls.push({ payload, options });
        return '<svg data-test="qr"></svg>';
      }
    }
  });
  const res = response();
  await service.getBookingQr(request({
    headers: {
      host: 'attacker.invalid',
      'x-forwarded-host': 'attacker.invalid'
    }
  }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].payload, 'https://booking.example.com/book/merchant-a');
  assert.equal(calls[0].options.errorCorrectionLevel, 'H');
  assert.equal(calls[0].options.width, 1024);
  assert.equal(JSON.stringify(calls[0]).includes('token'), false);
  assert.equal(JSON.stringify(calls[0]).includes(IDS.shopA), false);
  assert.match(res.headers['content-type'], /image\/svg\+xml/);
  assert.match(res.headers['content-disposition'], /merchant-a-booking-qr\.svg/);
});

test('installed QR renderer produces a printable SVG and fails closed without trusted base URL', async () => {
  const printable = await QRCode.toString('https://booking.example.com/book/merchant-a', {
    type: 'svg',
    errorCorrectionLevel: 'H',
    margin: 4,
    width: 1024
  });
  assert.match(printable, /^<svg/);
  assert.match(printable, /width="1024"/);

  const service = createMerchantLaunchReadiness({
    pool: { query: async () => assert.fail('QR endpoint does not need a tenant query') },
    getPublicBaseUrl: () => undefined,
    qrCode: { toString: async () => assert.fail('renderer must not run') }
  });
  const res = response();
  await service.getBookingQr(request(), res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.code, 'PUBLIC_BASE_URL_UNAVAILABLE');
});

test('client tenant authority is rejected before readiness or QR work', async () => {
  let queryCount = 0;
  let qrCount = 0;
  const service = createMerchantLaunchReadiness({
    pool: { query: async () => { queryCount += 1; return { rows: [completeSnapshot()] }; } },
    getPublicBaseUrl: () => 'https://booking.example.com',
    qrCode: { toString: async () => { qrCount += 1; return '<svg></svg>'; } }
  });

  const readinessResponse = response();
  await service.getReadiness(request({ query: { shopSlug: 'merchant-b' } }), readinessResponse);
  assert.equal(readinessResponse.statusCode, 400);

  const qrResponse = response();
  await service.getBookingQr(request({ query: { shop_id: IDS.shopB } }), qrResponse);
  assert.equal(qrResponse.statusCode, 400);
  assert.equal(queryCount, 0);
  assert.equal(qrCount, 0);
});

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
};

test('launch routes enforce authentication, role policy, and membership-bound tenant scope', async () => {
  const previousPool = app.locals.ownerAuthPool;
  const previousBaseUrl = app.locals.publicBaseUrl;
  const previousQr = app.locals.qrCode;
  let role = 'owner';
  const readinessParams = [];
  const qrPayloads = [];

  app.locals.publicBaseUrl = 'https://booking.example.com';
  app.locals.qrCode = {
    toString: async payload => {
      qrPayloads.push(payload);
      return '<svg data-route="qr"></svg>';
    }
  };
  app.locals.ownerAuthPool = {
    query: async (sql, params) => {
      if (/FROM owner_sessions session/.test(sql)) {
        return {
          rows: [{
            owner_account_id: IDS.account,
            membership_id: IDS.membership,
            shop_id: IDS.shopA,
            login_identifier: 'merchant-owner',
            display_name: 'Merchant Owner',
            role,
            shop_slug: 'merchant-a',
            shop_name: 'Merchant A'
          }]
        };
      }
      if (/FROM shops AS shop/.test(sql)) {
        readinessParams.push(params);
        return { rows: [completeSnapshot()] };
      }
      throw new Error('Unexpected query');
    }
  };

  try {
    await withServer(async baseUrl => {
      const unauthenticated = await fetch(`${baseUrl}/api/owner/launch/readiness`);
      assert.equal(unauthenticated.status, 401);

      const headers = { Cookie: 'gg_beauty_owner_session=test-session' };
      for (const allowedRole of ['owner', 'manager', 'admin']) {
        role = allowedRole;
        const allowed = await fetch(`${baseUrl}/api/owner/launch/readiness`, { headers });
        assert.equal(allowed.status, 200, allowedRole);
        assert.equal((await allowed.json()).data.ready, true);
      }

      role = 'front_desk';
      const denied = await fetch(`${baseUrl}/api/owner/launch/readiness`, { headers });
      assert.equal(denied.status, 403);

      role = 'owner';
      const forged = await fetch(
        `${baseUrl}/api/owner/launch/readiness?shop_id=${encodeURIComponent(IDS.shopB)}`,
        { headers }
      );
      assert.equal(forged.status, 400);

      const qr = await fetch(`${baseUrl}/api/owner/launch/booking-qr.svg`, {
        headers: { ...headers, 'X-Forwarded-Host': 'attacker.invalid' }
      });
      assert.equal(qr.status, 200);
      assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
      assert.equal(qrPayloads.at(-1), 'https://booking.example.com/book/merchant-a');
    });

    assert.equal(readinessParams.length, 3);
    assert.equal(readinessParams.every(params => params[0] === IDS.shopA), true);
  } finally {
    app.locals.ownerAuthPool = previousPool;
    app.locals.publicBaseUrl = previousBaseUrl;
    app.locals.qrCode = previousQr;
  }
});
