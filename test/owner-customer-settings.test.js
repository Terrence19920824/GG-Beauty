'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app, OWNER_CUSTOMER_SETTINGS_ROLES } = require('../server');

const ID = {
  account: '11111111-1111-4111-8111-111111111111',
  membership: '22222222-2222-4222-8222-222222222222',
  shopA: '33333333-3333-4333-8333-333333333333',
  shopB: '44444444-4444-4444-8444-444444444444'
};

const sessionRow = (role, shopId = ID.shopA) => ({
  owner_account_id: ID.account,
  membership_id: ID.membership,
  shop_id: shopId,
  login_identifier: 'owner-test',
  display_name: 'Owner Test',
  role,
  shop_slug: 'shop-test',
  shop_name: 'Shop Test'
});

const makeMockPool = ({
  role = 'owner',
  shopId = ID.shopA,
  validSession = true,
  settingsStore = null
} = {}) => {
  const store = settingsStore || {
    [ID.shopA]: {
      membership_enabled: false,
      points_enabled: false,
      stored_value_enabled: false,
      packages_enabled: false
    }
  };

  return {
    async query(sql, params = []) {
      const normalized = sql.trim();
      if (/FROM owner_sessions/.test(normalized)) {
        return {
          rows: validSession ? [sessionRow(role, shopId)] : []
        };
      }
      if (/SELECT[\s\S]+FROM shop_customer_settings/.test(normalized)) {
        const sid = params[0];
        const s = store[sid] || {
          membership_enabled: false,
          points_enabled: false,
          stored_value_enabled: false,
          packages_enabled: false
        };
        return { rows: [{ ...s, shop_id: sid }] };
      }
      if (/INSERT INTO shop_customer_settings[\s\S]+ON CONFLICT/.test(normalized)) {
        const sid = params[0];
        const current = store[sid] || {
          membership_enabled: false,
          points_enabled: false,
          stored_value_enabled: false,
          packages_enabled: false
        };
        const updated = {
          membership_enabled: params[1] !== undefined ? params[1] : current.membership_enabled,
          points_enabled: params[2] !== undefined ? params[2] : current.points_enabled,
          stored_value_enabled: params[3] !== undefined ? params[3] : current.stored_value_enabled,
          packages_enabled: params[4] !== undefined ? params[4] : current.packages_enabled
        };
        store[sid] = updated;
        return { rows: [{ ...updated, shop_id: sid }] };
      }
      throw new Error(`Unexpected query: ${normalized}`);
    },
    async connect() {
      return this;
    },
    release() {}
  };
};

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) =>
      server.close(error => (error ? reject(error) : resolve()))
    );
  }
};

const request = (baseUrl, path, {
  method = 'GET',
  body,
  authenticated = true,
  cookie = 'gg_beauty_owner_session=owner-token'
} = {}) => fetch(`${baseUrl}${path}`, {
  method,
  headers: {
    'Content-Type': 'application/json',
    ...(authenticated ? { cookie } : {})
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

test('OWNER_CUSTOMER_SETTINGS_ROLES allows owner, manager, admin and excludes front_desk and staff', () => {
  assert.deepEqual([...OWNER_CUSTOMER_SETTINGS_ROLES], ['owner', 'manager', 'admin']);
  assert.equal(OWNER_CUSTOMER_SETTINGS_ROLES.includes('front_desk'), false);
  assert.equal(OWNER_CUSTOMER_SETTINGS_ROLES.includes('staff'), false);
});

test('unauthenticated request to GET /api/owner/customer-settings returns 401', async () => {
  const pool = makeMockPool();
  app.locals.ownerAuthPool = pool;
  await withServer(async baseUrl => {
    const res = await request(baseUrl, '/api/owner/customer-settings', { authenticated: false });
    assert.equal(res.status, 401);
  });
});

test('unauthenticated request to PATCH /api/owner/customer-settings returns 401', async () => {
  const pool = makeMockPool();
  app.locals.ownerAuthPool = pool;
  await withServer(async baseUrl => {
    const res = await request(baseUrl, '/api/owner/customer-settings', {
      method: 'PATCH',
      authenticated: false,
      body: { membershipEnabled: false }
    });
    assert.equal(res.status, 401);
  });
});

for (const role of ['owner', 'manager', 'admin']) {
  test(`${role} can read and update customer settings`, async () => {
    const store = {
      [ID.shopA]: {
        membership_enabled: false,
        points_enabled: false,
        stored_value_enabled: false,
        packages_enabled: false
      }
    };
    const pool = makeMockPool({ role, settingsStore: store });
    app.locals.ownerAuthPool = pool;

    await withServer(async baseUrl => {
      // 1. Read settings
      const getRes = await request(baseUrl, '/api/owner/customer-settings');
      assert.equal(getRes.status, 200);
      const getJson = await getRes.json();
      assert.equal(getJson.success, true);
      assert.equal(getJson.data.membershipEnabled, false);
      assert.equal(getJson.data.pointsEnabled, false);
      assert.equal(getJson.data.storedValueEnabled, false);
      assert.equal(getJson.data.packagesEnabled, false);

      // 2. Update settings: enable membership
      const patchRes = await request(baseUrl, '/api/owner/customer-settings', {
        method: 'PATCH',
        body: {
          membershipEnabled: true
        }
      });
      assert.equal(patchRes.status, 200);
      const patchJson = await patchRes.json();
      assert.equal(patchJson.success, true);
      assert.equal(patchJson.data.membershipEnabled, true);
      assert.equal(patchJson.data.pointsEnabled, false);
      assert.equal(patchJson.data.storedValueEnabled, false);
      assert.equal(patchJson.data.packagesEnabled, false);
      assert.equal(store[ID.shopA].membership_enabled, true);

      // 3. Attempting to enable unfinished modules returns 400 UNSUPPORTED_MODULE
      for (const key of ['pointsEnabled', 'storedValueEnabled', 'packagesEnabled']) {
        const errRes = await request(baseUrl, '/api/owner/customer-settings', {
          method: 'PATCH',
          body: { [key]: true }
        });
        assert.equal(errRes.status, 400);
        const errJson = await errRes.json();
        assert.equal(errJson.success, false);
        assert.equal(errJson.code, 'UNSUPPORTED_MODULE');
      }
    });
  });
}

test('front_desk role is denied access (403) to customer settings read and write', async () => {
  const pool = makeMockPool({ role: 'front_desk' });
  app.locals.ownerAuthPool = pool;

  await withServer(async baseUrl => {
    const getRes = await request(baseUrl, '/api/owner/customer-settings');
    assert.equal(getRes.status, 403);

    const patchRes = await request(baseUrl, '/api/owner/customer-settings', {
      method: 'PATCH',
      body: { membershipEnabled: false }
    });
    assert.equal(patchRes.status, 403);
  });
});

test('ordinary staff role is denied access (403) to customer settings', async () => {
  const pool = makeMockPool({ role: 'staff' });
  app.locals.ownerAuthPool = pool;

  await withServer(async baseUrl => {
    const getRes = await request(baseUrl, '/api/owner/customer-settings');
    assert.equal(getRes.status, 403);

    const patchRes = await request(baseUrl, '/api/owner/customer-settings', {
      method: 'PATCH',
      body: { membershipEnabled: false }
    });
    assert.equal(patchRes.status, 403);
  });
});

test('customer session cookie cannot access owner customer settings', async () => {
  const pool = makeMockPool({ validSession: false });
  app.locals.ownerAuthPool = pool;

  await withServer(async baseUrl => {
    const res = await request(baseUrl, '/api/owner/customer-settings', {
      cookie: 'gg_beauty_customer_session=some-customer-token'
    });
    assert.equal(res.status, 401);
  });
});
