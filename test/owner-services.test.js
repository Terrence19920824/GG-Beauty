'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');

const ID = {
  account: '11111111-1111-4111-8111-111111111111',
  membership: '22222222-2222-4222-8222-222222222222',
  shopA: '33333333-3333-4333-8333-333333333333',
  shopB: '44444444-4444-4444-8444-444444444444',
  serviceA: '55555555-5555-4555-8555-555555555555',
  serviceB: '66666666-6666-4666-8666-666666666666'
};

const sessionRow = role => ({
  owner_account_id: ID.account,
  membership_id: ID.membership,
  shop_id: ID.shopA,
  login_identifier: 'owner-a',
  display_name: 'Owner A',
  role,
  shop_slug: 'shop-a',
  shop_name: 'Shop A'
});

const serviceA = {
  id: ID.serviceA,
  category: 'Hair',
  name: 'Cut',
  description: null,
  price: '50.00',
  duration_minutes: 60,
  bookable: true,
  is_active: true,
  sort_order: 1,
  created_at: '2030-01-01T00:00:00Z',
  updated_at: '2030-01-01T00:00:00Z'
};

const serviceB = {
  ...serviceA,
  id: ID.serviceB,
  name: 'Other tenant service'
};

const makePool = ({
  role = 'owner',
  validSession = true,
  dbError = false
} = {}) => {
  const state = {
    services: {
      [ID.serviceA]: { ...serviceA, shop_id: ID.shopA },
      [ID.serviceB]: { ...serviceB, shop_id: ID.shopB }
    },
    poolQueries: [],
    clientQueries: [],
    releases: 0,
    appointmentWrites: 0
  };

  const client = {
    async query(sql, params = []) {
      const normalized = sql.trim();
      state.clientQueries.push({ sql: normalized, params });

      if (dbError) {
        throw Object.assign(
          new Error('private SQL and schema detail'),
          { code: 'XX000' }
        );
      }

      if (/^(UPDATE|INSERT|DELETE).*appointment/im.test(normalized)) {
        state.appointmentWrites += 1;
      }

      if (/^SELECT[\s\S]+FROM services/.test(normalized)) {
        return {
          rows: Object.values(state.services)
            .filter(item => item.shop_id === params[0])
            .map(({ shop_id: _shopId, ...item }) => item)
        };
      }

      if (/^INSERT INTO services/.test(normalized)) {
        const id = '77777777-7777-4777-8777-777777777777';
        const created = {
          id,
          category: params[1],
          name: params[2],
          description: params[3],
          price: String(params[4]),
          duration_minutes: params[5],
          bookable: params[6],
          is_active: params[7],
          sort_order: params[8],
          created_at: '2030-01-02T00:00:00Z',
          updated_at: '2030-01-02T00:00:00Z',
          shop_id: params[0]
        };
        state.services[id] = created;
        const { shop_id: _shopId, ...safe } = created;
        return { rows: [safe] };
      }

      if (/^UPDATE services/.test(normalized)) {
        const serviceId = params.at(-2);
        const shopId = params.at(-1);
        const current = state.services[serviceId];

        if (!current || current.shop_id !== shopId) {
          return { rows: [] };
        }

        const setClause = normalized.match(
          /SET\s+([\s\S]+?)\s+WHERE/
        )[1];
        const fieldMap = {
          category: 'category',
          name: 'name',
          description: 'description',
          price: 'price',
          duration_minutes: 'duration_minutes',
          bookable: 'bookable',
          is_active: 'is_active',
          sort_order: 'sort_order'
        };

        for (const match of setClause.matchAll(
          /(category|name|description|price|duration_minutes|bookable|is_active|sort_order) = \$(\d+)/g
        )) {
          current[fieldMap[match[1]]] =
            params[Number(match[2]) - 1];
        }

        current.updated_at = '2030-01-03T00:00:00Z';
        const { shop_id: _shopId, ...safe } = current;
        return { rows: [safe] };
      }

      throw new Error(`Unexpected client SQL: ${normalized}`);
    },
    release() {
      state.releases += 1;
    }
  };

  return {
    state,
    pool: {
      async query(sql, params = []) {
        state.poolQueries.push({ sql: sql.trim(), params });
        if (/FROM owner_sessions/.test(sql)) {
          return {
            rows: validSession ? [sessionRow(role)] : []
          };
        }
        throw new Error(`Unexpected pool SQL: ${sql.trim()}`);
      },
      async connect() {
        return client;
      }
    }
  };
};

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));

  try {
    return await operation(
      `http://127.0.0.1:${server.address().port}`
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close(error => error ? reject(error) : resolve())
    );
  }
};

const request = (baseUrl, path, {
  method = 'GET',
  body,
  authenticated = true,
  headers = {}
} = {}) => fetch(`${baseUrl}${path}`, {
  method,
  headers: {
    ...(authenticated
      ? { cookie: 'gg_beauty_owner_session=owner-token' }
      : {}),
    ...(body === undefined
      ? {}
      : { 'content-type': 'application/json' }),
    ...headers
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) })
});

const run = async (fixture, path, options) => {
  app.locals.ownerAuthPool = fixture.pool;
  return withServer(baseUrl => request(baseUrl, path, options));
};

test('unauthenticated owner services request returns 401', async () => {
  const fixture = makePool();
  const response = await run(
    fixture,
    '/api/owner/services',
    { authenticated: false }
  );
  assert.equal(response.status, 401);
  assert.equal(fixture.state.clientQueries.length, 0);
});

for (const role of ['owner', 'manager', 'admin']) {
  test(`${role} may list tenant services`, async () => {
    const fixture = makePool({ role });
    const response = await run(fixture, '/api/owner/services');
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.deepEqual(payload.data.map(item => item.id), [ID.serviceA]);
    assert.equal(JSON.stringify(payload).includes('shop_id'), false);
  });
}

for (const role of ['owner', 'manager']) {
  test(`${role} may create and update a service`, async () => {
    const fixture = makePool({ role });
    const created = await run(fixture, '/api/owner/services', {
      method: 'POST',
      body: {
        category: ' Beauty ',
        name: ' Facial ',
        description: ' Treatment ',
        price: 80.5,
        durationMinutes: 90,
        bookable: false,
        isActive: true,
        sortOrder: 2
      }
    });
    assert.equal(created.status, 201);
    const createdBody = await created.json();
    assert.equal(createdBody.data.name, 'Facial');
    assert.equal(createdBody.data.category, 'Beauty');
    const insert = fixture.state.clientQueries.find(
      item => /^INSERT INTO services/.test(item.sql)
    );
    assert.equal(insert.params[0], ID.shopA);

    const updated = await run(
      fixture,
      `/api/owner/services/${ID.serviceA}`,
      { method: 'PATCH', body: { name: 'New name' } }
    );
    assert.equal(updated.status, 200);
    assert.equal((await updated.json()).data.name, 'New name');
    assert.equal(fixture.state.releases, 2);
  });
}

test('admin cannot create or update services', async () => {
  const fixture = makePool({ role: 'admin' });
  const created = await run(fixture, '/api/owner/services', {
    method: 'POST', body: { name: 'Denied' }
  });
  const updated = await run(
    fixture,
    `/api/owner/services/${ID.serviceA}`,
    { method: 'PATCH', body: { name: 'Denied' } }
  );
  assert.equal(created.status, 403);
  assert.equal(updated.status, 403);
  assert.equal(fixture.state.clientQueries.length, 0);
});

test('invalid revoked expired or inactive session fails closed', async () => {
  const fixture = makePool({ validSession: false });
  for (const [method, path, body] of [
    ['GET', '/api/owner/services', undefined],
    ['POST', '/api/owner/services', { name: 'Denied' }],
    ['PATCH', `/api/owner/services/${ID.serviceA}`, { name: 'Denied' }]
  ]) {
    const response = await run(fixture, path, { method, body });
    assert.equal(response.status, 401);
  }
  assert.equal(fixture.state.clientQueries.length, 0);
});

test('GET tenant injection cannot change authenticated tenant', async () => {
  const fixture = makePool();
  const response = await run(
    fixture,
    `/api/owner/services?shopId=${ID.shopB}&shop_id=${ID.shopB}`,
    { headers: { 'x-shop-id': ID.shopB, 'x-tenant-id': ID.shopB } }
  );
  const payload = await response.json();
  assert.deepEqual(payload.data.map(item => item.id), [ID.serviceA]);
  const query = fixture.state.clientQueries[0];
  assert.match(query.sql, /WHERE shop_id = \$1/);
  assert.deepEqual(query.params, [ID.shopA]);
});

test('POST tenant injection is rejected and cannot create for another shop', async () => {
  const fixture = makePool();
  const before = structuredClone(fixture.state.services);
  const response = await run(fixture, '/api/owner/services', {
    method: 'POST',
    body: { name: 'Injected', shopId: ID.shopB, shop_id: ID.shopB },
    headers: { 'x-shop-id': ID.shopB }
  });
  assert.equal(response.status, 400);
  assert.deepEqual(fixture.state.services, before);
});

test('POST forged tenant header cannot change inserted shop', async () => {
  const fixture = makePool();
  const response = await run(fixture, '/api/owner/services', {
    method: 'POST',
    body: { name: 'Tenant A service' },
    headers: { 'x-shop-id': ID.shopB, 'x-tenant-id': ID.shopB }
  });
  assert.equal(response.status, 201);
  const insert = fixture.state.clientQueries[0];
  assert.equal(insert.params[0], ID.shopA);
  assert.equal(insert.params.includes(ID.shopB), false);
});

test('PATCH tenant injection is rejected and cannot update another shop', async () => {
  const fixture = makePool();
  const before = structuredClone(fixture.state.services[ID.serviceB]);
  const response = await run(
    fixture,
    `/api/owner/services/${ID.serviceB}`,
    {
      method: 'PATCH',
      body: { name: 'Injected', shop_id: ID.shopB },
      headers: { 'x-tenant-id': ID.shopB }
    }
  );
  assert.equal(response.status, 400);
  assert.deepEqual(fixture.state.services[ID.serviceB], before);
});

test('cross-tenant PATCH returns 404 and leaves target unchanged', async () => {
  const fixture = makePool();
  const before = structuredClone(fixture.state.services[ID.serviceB]);
  const response = await run(
    fixture,
    `/api/owner/services/${ID.serviceB}`,
    { method: 'PATCH', body: { name: 'Blocked' } }
  );
  assert.equal(response.status, 404);
  assert.deepEqual(fixture.state.services[ID.serviceB], before);
  const query = fixture.state.clientQueries[0];
  assert.match(query.sql, /WHERE id = \$\d+/);
  assert.match(query.sql, /AND shop_id = \$\d+/);
  assert.equal(query.params.at(-1), ID.shopA);
});

test('PATCH forged tenant header cannot change update scope', async () => {
  const fixture = makePool();
  const response = await run(
    fixture,
    `/api/owner/services/${ID.serviceA}`,
    {
      method: 'PATCH',
      body: { name: 'Tenant A update' },
      headers: { 'x-shop-id': ID.shopB, 'x-tenant-id': ID.shopB }
    }
  );
  assert.equal(response.status, 200);
  const query = fixture.state.clientQueries[0];
  assert.equal(query.params.at(-1), ID.shopA);
  assert.equal(query.params.includes(ID.shopB), false);
});

const invalidBodies = [
  ['empty name', { name: '' }],
  ['whitespace name', { name: '   ' }],
  ['negative price', { name: 'Valid', price: -1 }],
  ['NaN price', { name: 'Valid', price: 'NaN' }],
  ['Infinity price', { name: 'Valid', price: 'Infinity' }],
  ['zero duration', { name: 'Valid', durationMinutes: 0 }],
  ['negative duration', { name: 'Valid', durationMinutes: -1 }],
  ['fractional duration', { name: 'Valid', durationMinutes: 1.5 }],
  ['invalid sort order', { name: 'Valid', sortOrder: -1 }]
];

for (const [label, body] of invalidBodies) {
  test(`validation rejects ${label}`, async () => {
    const fixture = makePool();
    const response = await run(fixture, '/api/owner/services', {
      method: 'POST', body
    });
    assert.equal(response.status, 400);
    assert.equal(fixture.state.clientQueries.length, 0);
  });
}

test('validation rejects invalid service UUID', async () => {
  const fixture = makePool();
  const response = await run(
    fixture,
    '/api/owner/services/not-a-uuid',
    { method: 'PATCH', body: { name: 'Valid' } }
  );
  assert.equal(response.status, 400);
  assert.equal(fixture.state.clientQueries.length, 0);
});

test('validation rejects unknown PATCH field', async () => {
  const fixture = makePool();
  const response = await run(
    fixture,
    `/api/owner/services/${ID.serviceA}`,
    { method: 'PATCH', body: { created_at: '2030-01-01' } }
  );
  assert.equal(response.status, 400);
});

test('validation rejects empty PATCH body', async () => {
  const fixture = makePool();
  const response = await run(
    fixture,
    `/api/owner/services/${ID.serviceA}`,
    { method: 'PATCH', body: {} }
  );
  assert.equal(response.status, 400);
});

test('database errors are safe and every acquired connection is released', async () => {
  const fixture = makePool({ dbError: true });
  const original = console.error;
  console.error = () => {};
  try {
    const response = await run(fixture, '/api/owner/services');
    const payload = await response.json();
    assert.equal(response.status, 500);
    assert.equal(JSON.stringify(payload).includes('private SQL'), false);
  } finally {
    console.error = original;
  }
  assert.equal(fixture.state.releases, 1);
});

test('service mutations neither hard-delete nor modify appointment snapshots', async () => {
  const fixture = makePool();
  const response = await run(
    fixture,
    `/api/owner/services/${ID.serviceA}`,
    {
      method: 'PATCH',
      body: {
        name: 'Renamed',
        price: 90,
        durationMinutes: 120,
        bookable: false,
        isActive: false
      }
    }
  );
  assert.equal(response.status, 200);
  assert.equal(fixture.state.appointmentWrites, 0);
  const sql = fixture.state.clientQueries.map(item => item.sql).join('\n');
  assert.doesNotMatch(sql, /DELETE FROM services/i);
  assert.doesNotMatch(sql, /appointment_items/i);
});
