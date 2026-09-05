'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  StaffBookabilityError
} = require('../lib/staff-bookability-validator');
const { app } = require('../server');

const ID = {
  shop: '11111111-1111-4111-8111-111111111111',
  location: '22222222-2222-4222-8222-222222222222',
  staff: '33333333-3333-4333-8333-333333333333',
  service: '44444444-4444-4444-8444-444444444444',
  customer: '55555555-5555-4555-8555-555555555555',
  appointment: '66666666-6666-4666-8666-666666666666',
  item: '77777777-7777-4777-8777-777777777777'
};

const body = {
  shopSlug: 'test-shop',
  service: 'Test Service',
  staff: 'Test Staff',
  customerName: 'Test Customer',
  phone: '00000000',
  email: 'test@example.invalid',
  date: '2030-01-07',
  time: '10:00',
  duration: 999,
  endAt: '2099-01-01T00:00:00Z'
};

const responseForSql = (sql, params = []) => {
  if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(sql.trim())) return { rows: [] };
  if (/FROM shops/.test(sql)) return { rows: [{ id: ID.shop }] };
  if (/FROM locations\s/.test(sql) && !/WITH interval_scope/.test(sql)) {
    return { rows: [{ id: ID.location }] };
  }
  if (/FROM services/.test(sql)) {
    if (params[1] == null && params[2] && params[2] !== 'Test Service') {
      return { rows: [] };
    }
    return {
      rows: [{
        id: ID.service,
        name: 'Test Service',
        localized_name: params[3] === 'zh-CN' ? '测试服务' : 'Test Service',
        duration_minutes: 60
      }]
    };
  }
  if (/FROM staff\s/.test(sql)) return { rows: [{ id: ID.staff }] };
  if (/WITH interval_scope/.test(sql)) {
    return {
      rows: [{
        start_at: '2030-01-07T02:00:00.000000Z',
        end_at: '2030-01-07T03:00:00.000000Z'
      }]
    };
  }
  if (/SELECT id\s+FROM customers/.test(sql)) return { rows: [] };
  if (/INSERT INTO customers/.test(sql)) {
    return { rows: [{ id: ID.customer }] };
  }
  if (/INSERT INTO appointments/.test(sql)) {
    return {
      rows: [{
        id: ID.appointment,
        shop_id: ID.shop,
        location_id: ID.location,
        customer_id: ID.customer,
        service_id: ID.service,
        staff_id: ID.staff,
        appointment_no: 'GG-TEST',
        start_at: '2030-01-07T02:00:00.000000Z',
        end_at: '2030-01-07T03:00:00.000000Z',
        status: 'pending',
        created_at: '2030-01-01T00:00:00.000000Z'
      }]
    };
  }
  if (/INSERT INTO appointment_items/.test(sql)) {
    return { rows: [{ id: ID.item }] };
  }
  if (/INSERT INTO appointment_item_staff_assignments/.test(sql)) {
    return { rows: [{ id: '88888888-8888-4888-8888-888888888888' }] };
  }
  throw new Error(`Unexpected SQL in test: ${sql}`);
};

const makePool = failOnSql => {
  const state = {
    connected: 0,
    released: 0,
    releaseDiscard: undefined,
    queries: []
  };
  const client = {
    query: async (sql, params) => {
      const normalized = sql.trim();
      state.queries.push({ sql: normalized, params });
      const failure = failOnSql
        ? failOnSql(normalized)
        : null;
      if (failure) throw failure;
      return responseForSql(sql, params);
    },
    release: discard => {
      state.released += 1;
      state.releaseDiscard = discard;
    }
  };
  state.client = client;
  return {
    state,
    pool: {
      connect: async () => {
        state.connected += 1;
        return client;
      }
    }
  };
};

const withServer = async operation => {
  const server = app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const { port } = server.address();
    return await operation(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
  }
};

const postBooking = (baseUrl, requestBody = body) =>
  fetch(`${baseUrl}/api/new-db`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(requestBody)
  });

const installDependencies = (pool, validator) => {
  app.locals.bookingPool = pool;
  app.locals.bookingValidator = validator;
};

const sqlWrites = state =>
  state.queries.filter(({ sql }) => /^INSERT\s/i.test(sql));

test('maintenance returns 503 before connecting to DB', async () => {
  const original = process.env.BOOKING_WRITE_MAINTENANCE;
  process.env.BOOKING_WRITE_MAINTENANCE = 'true';
  const fixture = makePool();
  installDependencies(fixture.pool, async () => {});
  try {
    await withServer(async baseUrl => {
      const response = await postBooking(baseUrl, {});
      assert.equal(response.status, 503);
      assert.equal((await response.json()).code, 'BOOKING_MAINTENANCE');
    });
    assert.equal(fixture.state.connected, 0);
  } finally {
    if (original === undefined) {
      delete process.env.BOOKING_WRITE_MAINTENANCE;
    } else {
      process.env.BOOKING_WRITE_MAINTENANCE = original;
    }
  }
});

for (const code of [
  'STAFF_NOT_BOOKABLE',
  'SERVICE_NOT_BOOKABLE',
  'STAFF_SERVICE_NOT_ALLOWED',
  'STAFF_LOCATION_NOT_ASSIGNED',
  'NO_WORKING_HOURS',
  'OUTSIDE_WORKING_HOURS',
  'STAFF_ON_LEAVE',
  'SCHEDULE_OVERRIDE_PENDING',
  'SCHEDULE_CONFIGURATION_INVALID',
  'APPOINTMENT_COLLISION'
]) {
  test(`${code} rolls back before business writes`, async () => {
    delete process.env.BOOKING_WRITE_MAINTENANCE;
    const fixture = makePool();
    installDependencies(fixture.pool, async input => {
      assert.equal(input.dbClient, fixture.state.client);
      assert.equal(input.shopId, ID.shop);
      assert.equal(input.locationId, ID.location);
      assert.equal(input.staffId, ID.staff);
      assert.equal(input.serviceId, ID.service);
      assert.equal(input.requestedStartAt, '2030-01-07T02:00:00.000000Z');
      assert.equal(input.requestedEndAt, '2030-01-07T03:00:00.000000Z');
      assert.equal(sqlWrites(fixture.state).length, 0);
      throw new StaffBookabilityError(code);
    });
    await withServer(async baseUrl => {
      const response = await postBooking(baseUrl);
      const payload = await response.json();
      assert.equal(response.status, 409);
      assert.equal(payload.code, 'BOOKING_NOT_AVAILABLE');
    });
    assert.equal(sqlWrites(fixture.state).length, 0);
    assert.equal(fixture.state.queries.at(-1).sql, 'ROLLBACK');
    assert.equal(fixture.state.released, 1);
  });
}

test('valid booking atomically writes customer, parent, item, assignment', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  const fixture = makePool();
  let validatorPassed = false;
  installDependencies(fixture.pool, async () => {
    assert.equal(sqlWrites(fixture.state).length, 0);
    validatorPassed = true;
  });
  await withServer(async baseUrl => {
    const response = await postBooking(baseUrl);
    assert.equal(response.status, 200);
  });
  assert.equal(validatorPassed, true);
  assert.deepEqual(
    sqlWrites(fixture.state).map(({ sql }) =>
      sql.match(/^INSERT INTO ([a-z_]+)/i)[1]
    ),
    [
      'customers',
      'appointments',
      'appointment_items',
      'appointment_item_staff_assignments'
    ]
  );
  const parentWrite = fixture.state.queries.find(
    ({ sql }) => /^INSERT INTO appointments/i.test(sql)
  );
  assert.equal(parentWrite.params[5], '2030-01-07T02:00:00.000000Z');
  assert.equal(parentWrite.params[6], '2030-01-07T03:00:00.000000Z');
  const itemWrite = fixture.state.queries.find(
    ({ sql }) => /^INSERT INTO appointment_items/i.test(sql)
  );
  assert.equal(itemWrite.params[4], 'Test Service');
  assert.equal(itemWrite.params[5], 'en');
  assert.equal(fixture.state.queries.at(-1).sql, 'COMMIT');
  assert.equal(fixture.state.released, 1);
});

test('serviceId booking uses localized snapshot name and normalized locale', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  const fixture = makePool();
  installDependencies(fixture.pool, async input => {
    assert.equal(input.serviceId, ID.service);
  });
  await withServer(async baseUrl => {
    const response = await postBooking(baseUrl, {
      ...body,
      service: '不应作为身份的显示名称',
      serviceId: ID.service,
      locale: 'zh-SG'
    });
    assert.equal(response.status, 200);
  });
  const lookup = fixture.state.queries.find(({ sql }) => /FROM services AS service/.test(sql));
  assert.deepEqual(lookup.params, [ID.shop, ID.service, '不应作为身份的显示名称', 'zh-CN']);
  assert.match(lookup.sql, /\$2::UUID IS NOT NULL AND service\.id = \$2::UUID/);
  const itemWrite = fixture.state.queries.find(({ sql }) => /^INSERT INTO appointment_items/i.test(sql));
  assert.equal(itemWrite.params[4], '测试服务');
  assert.equal(itemWrite.params[5], 'zh-CN');
});

test('legacy canonical service name remains compatible only without serviceId', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  const fixture = makePool();
  installDependencies(fixture.pool, async () => {});
  await withServer(async baseUrl => {
    const response = await postBooking(baseUrl, body);
    assert.equal(response.status, 200);
  });
  const lookup = fixture.state.queries.find(({ sql }) => /FROM services AS service/.test(sql));
  assert.deepEqual(lookup.params, [ID.shop, null, 'Test Service', 'en']);
  assert.match(lookup.sql, /\$2::UUID IS NULL AND service\.name = \$3/);
});

test('localized display name is rejected as legacy booking identity', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  const fixture = makePool();
  installDependencies(fixture.pool, async () => {});
  await withServer(async baseUrl => {
    const response = await postBooking(baseUrl, { ...body, service: '测试服务' });
    assert.equal(response.status, 400);
  });
  assert.equal(sqlWrites(fixture.state).length, 0);
  assert.equal(fixture.state.queries.at(-1).sql, 'ROLLBACK');
});

test('unexpected validator error rolls back and returns safe 500', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  const fixture = makePool();
  installDependencies(fixture.pool, async () => {
    throw new Error('sensitive internal detail');
  });
  await withServer(async baseUrl => {
    const response = await postBooking(baseUrl);
    const payload = await response.json();
    assert.equal(response.status, 500);
    assert.equal(payload.message, '预约失败');
    assert.doesNotMatch(JSON.stringify(payload), /sensitive internal detail/);
  });
  assert.equal(sqlWrites(fixture.state).length, 0);
  assert.equal(fixture.state.queries.at(-1).sql, 'ROLLBACK');
  assert.equal(fixture.state.released, 1);
});

test('parent 23P01 rolls back and returns 409', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  const fixture = makePool(sql => {
    if (!/^INSERT INTO appointments/i.test(sql)) return null;
    const error = new Error('constraint detail');
    error.code = '23P01';
    return error;
  });
  installDependencies(fixture.pool, async () => {});
  await withServer(async baseUrl => {
    const response = await postBooking(baseUrl);
    assert.equal(response.status, 409);
  });
  assert.equal(fixture.state.queries.at(-1).sql, 'ROLLBACK');
  assert.equal(fixture.state.released, 1);
});

for (const table of [
  'appointment_items',
  'appointment_item_staff_assignments'
]) {
  test(`${table} failure rolls back the whole booking`, async () => {
    delete process.env.BOOKING_WRITE_MAINTENANCE;
    const fixture = makePool(sql =>
      new RegExp(`^INSERT INTO ${table}`, 'i').test(sql)
        ? new Error('child insert failed')
        : null
    );
    installDependencies(fixture.pool, async () => {});
    await withServer(async baseUrl => {
      const response = await postBooking(baseUrl);
      assert.equal(response.status, 500);
    });
    assert.equal(fixture.state.queries.at(-1).sql, 'ROLLBACK');
    assert.equal(fixture.state.released, 1);
  });
}
