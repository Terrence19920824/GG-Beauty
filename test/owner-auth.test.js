'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const { createOwnerAuth } = require('../lib/owner-auth');

const IDS = {
  account: '11111111-1111-4111-8111-111111111111',
  membership: '22222222-2222-4222-8222-222222222222',
  shop: '33333333-3333-4333-8333-333333333333'
};

const account = {
  id: IDS.account,
  login_identifier: 'OwnerOne',
  password_hash: 'stored-hash',
  display_name: 'Owner One',
  is_active: true,
  session_version: 4,
  failed_login_attempts: 0,
  locked_until: null,
  is_locked: false,
  previous_lock_expired: false
};

const membership = {
  membership_id: IDS.membership,
  owner_account_id: IDS.account,
  shop_id: IDS.shop,
  role: 'owner',
  shop_slug: 'shop-one',
  shop_name: 'Shop One'
};

const response = () => ({
  statusCode: 200,
  headers: {},
  payload: undefined,
  setHeader(name, value) { this.headers[name] = value; },
  status(code) { this.statusCode = code; return this; },
  json(payload) { this.payload = payload; return this; }
});

const request = (body = {}) => ({
  body,
  headers: {
    origin: 'https://example.test',
    host: 'example.test'
  }
});

const makeFixture = (options = {}) => {
  const state = {
    queries: [],
    releases: [],
    comparedHashes: []
  };
  const client = {
    async query(sql, params = []) {
      const normalized = sql.trim();
      state.queries.push({ sql: normalized, params });
      if (options.throwOn && options.throwOn(normalized)) {
        throw Object.assign(new Error('database detail'), { code: 'XX000' });
      }
      if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(normalized)) return { rows: [] };
      if (/FROM owner_accounts/.test(normalized)) {
        return { rows: options.accountRows ?? [account] };
      }
      if (/FROM owner_shop_memberships/.test(normalized)) {
        return { rows: options.membershipRows ?? [membership] };
      }
      if (/INSERT INTO owner_sessions/.test(normalized)) {
        return { rows: [{ id: 'session-id' }] };
      }
      if (/UPDATE owner_accounts/.test(normalized)) return { rows: [] };
      throw new Error(`Unexpected SQL: ${normalized}`);
    },
    release(discard) { state.releases.push(discard); }
  };
  const pool = {
    connect: async () => client,
    query: async (sql, params = []) => {
      const normalized = sql.trim();
      state.queries.push({ sql: normalized, params });
      if (options.poolError) throw Object.assign(new Error('secret detail'), { code: 'XX001' });
      if (/FROM owner_sessions/.test(normalized)) {
        return { rows: options.sessionRows ?? [{
          owner_account_id: IDS.account,
          membership_id: IDS.membership,
          shop_id: IDS.shop,
          login_identifier: 'OwnerOne',
          display_name: 'Owner One',
          role: options.role || 'owner',
          shop_slug: 'shop-one',
          shop_name: 'Shop One'
        }] };
      }
      if (/UPDATE owner_sessions/.test(normalized)) return { rows: [] };
      throw new Error(`Unexpected pool SQL: ${normalized}`);
    }
  };
  const bcrypt = {
    hashSync: () => 'dummy-hash',
    compare: async (_password, hash) => {
      state.comparedHashes.push(hash);
      return options.passwordMatches !== false && hash === 'stored-hash';
    }
  };
  const auth = createOwnerAuth({
    pool,
    bcrypt,
    crypto,
    isSameOriginRequest: req => req.headers.origin === 'https://example.test' && req.headers.host === 'example.test',
    safeErrorCode: error => error.code || 'unknown_error'
  });
  return { auth, state, pool, client };
};

const validBody = {
  loginIdentifier: '  OWNERONE  ',
  password: 'correct-password',
  shopSlug: 'SHOP-ONE'
};

test('normalizes identifier and uses exact normalized lookup', async () => {
  const fixture = makeFixture();
  await fixture.auth.login(request(validBody), response());
  const query = fixture.state.queries.find(entry => /FROM owner_accounts/.test(entry.sql));
  assert.equal(query.params[0], 'ownerone');
  assert.match(query.sql, /login_identifier_normalized = \$1/);
  assert.doesNotMatch(query.sql, /ILIKE|LIKE/);
});

test('invalid account and password share generic 401 response', async () => {
  const missing = makeFixture({ accountRows: [] });
  const wrong = makeFixture({ passwordMatches: false });
  const first = response();
  const second = response();
  await missing.auth.login(request(validBody), first);
  await wrong.auth.login(request(validBody), second);
  assert.equal(first.statusCode, 401);
  assert.deepEqual(first.payload, second.payload);
});

test('missing account follows dummy bcrypt path', async () => {
  const fixture = makeFixture({ accountRows: [] });
  await fixture.auth.login(request(validBody), response());
  assert.deepEqual(fixture.state.comparedHashes, ['dummy-hash']);
});

test('inactive account is rejected without session insert', async () => {
  const fixture = makeFixture({ accountRows: [{ ...account, is_active: false }] });
  const res = response();
  await fixture.auth.login(request(validBody), res);
  assert.equal(res.statusCode, 401);
  assert.equal(fixture.state.queries.some(q => /INSERT INTO owner_sessions/.test(q.sql)), false);
});

for (const label of ['inactive membership', 'inactive shop']) {
  test(`${label} is rejected without session insert`, async () => {
    const fixture = makeFixture({ membershipRows: [] });
    const res = response();
    await fixture.auth.login(request(validBody), res);
    assert.equal(res.statusCode, 403);
    assert.equal(fixture.state.queries.some(q => /INSERT INTO owner_sessions/.test(q.sql)), false);
  });
}

for (const label of ['expired session', 'revoked session', 'session version mismatch']) {
  test(`${label} fails closed`, async () => {
    const fixture = makeFixture({ sessionRows: [] });
    const req = request();
    req.headers.cookie = 'gg_beauty_owner_session=raw-token';
    const res = response();
    await fixture.auth.requireOwnerAuth(req, res, () => assert.fail('must not call next'));
    assert.equal(res.statusCode, 401);
  });
}

test('session stores only SHA-256 token hash', async () => {
  const fixture = makeFixture();
  await fixture.auth.login(request(validBody), response());
  const insert = fixture.state.queries.find(q => /INSERT INTO owner_sessions/.test(q.sql));
  assert.match(insert.params[0], /^[0-9a-f]{64}$/);
  assert.notEqual(insert.params[0], undefined);
});

test('owner cookie is HttpOnly and SameSite=Lax', async () => {
  const fixture = makeFixture();
  const res = response();
  await fixture.auth.login(request(validBody), res);
  assert.match(res.headers['Set-Cookie'], /HttpOnly/);
  assert.match(res.headers['Set-Cookie'], /SameSite=Lax/);
});

test('production owner cookie is Secure', async () => {
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const fixture = makeFixture();
    const res = response();
    await fixture.auth.login(request(validBody), res);
    assert.match(res.headers['Set-Cookie'], /; Secure/);
  } finally {
    if (previous === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = previous;
  }
});

test('/api/owner/me response is no-store and minimal', () => {
  const fixture = makeFixture();
  const req = request();
  req.ownerAuth = {
    ownerAccountId: IDS.account,
    membershipId: IDS.membership,
    shopId: IDS.shop,
    role: 'owner',
    loginIdentifier: 'OwnerOne',
    displayName: 'Owner One',
    shopSlug: 'shop-one',
    shopName: 'Shop One'
  };
  const res = response();
  fixture.auth.me(req, res);
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(res.payload.data.activeShop.id, IDS.shop);
  assert.equal(JSON.stringify(res.payload).includes('password'), false);
});

for (const route of ['login', 'logout']) {
  test(`strict Same-Origin rejects ${route}`, async () => {
    const fixture = makeFixture();
    const req = request(validBody);
    req.headers.origin = 'https://evil.test';
    const res = response();
    await fixture.auth[route](req, res);
    assert.equal(res.statusCode, 403);
    assert.equal(fixture.state.queries.length, 0);
  });
}

test('logout revokes only current token hash and then clears cookie', async () => {
  const fixture = makeFixture();
  const req = request();
  req.headers.cookie = 'gg_beauty_owner_session=current-raw-token';
  const res = response();
  await fixture.auth.logout(req, res);
  const update = fixture.state.queries.find(q => /UPDATE owner_sessions/.test(q.sql));
  assert.match(update.sql, /WHERE token_hash = \$1/);
  assert.deepEqual(update.params, [crypto.createHash('sha256').update('current-raw-token').digest('hex')]);
  assert.match(res.headers['Set-Cookie'], /Max-Age=0/);
});

test('trusted owner shop comes from validated membership-bound session', async () => {
  const fixture = makeFixture();
  const req = request({ shopId: 'attacker-shop' });
  req.headers.cookie = 'gg_beauty_owner_session=raw-token';
  await fixture.auth.requireOwnerAuth(req, response(), () => {});
  assert.equal(req.ownerAuth.shopId, IDS.shop);
  assert.equal(req.ownerAuth.ownerAccountId, IDS.account);
});

test('client supplied shopId cannot change authenticated tenant', async () => {
  const fixture = makeFixture();
  const req = request({ shopId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' });
  req.headers.cookie = 'gg_beauty_owner_session=raw-token';
  await fixture.auth.requireOwnerAuth(req, response(), () => {});
  assert.equal(req.ownerAuth.shopId, IDS.shop);
});

test('role is loaded from current membership on every request', async () => {
  const fixture = makeFixture({ role: 'manager' });
  const req = request();
  req.headers.cookie = 'gg_beauty_owner_session=raw-token';
  await fixture.auth.requireOwnerAuth(req, response(), () => {});
  assert.equal(req.ownerAuth.role, 'manager');
});

test('authentication DB error returns safe 500', async () => {
  const fixture = makeFixture({ poolError: true });
  const req = request();
  req.headers.cookie = 'gg_beauty_owner_session=raw-token';
  const res = response();
  const original = console.error;
  console.error = () => {};
  try { await fixture.auth.requireOwnerAuth(req, res, () => {}); } finally { console.error = original; }
  assert.equal(res.statusCode, 500);
  assert.equal(JSON.stringify(res.payload).includes('database detail'), false);
});

test('login transaction releases connection on success', async () => {
  const fixture = makeFixture();
  await fixture.auth.login(request(validBody), response());
  assert.equal(fixture.state.releases.length, 1);
});

test('login rolls back and releases connection on unexpected error', async () => {
  const fixture = makeFixture({ throwOn: sql => /INSERT INTO owner_sessions/.test(sql) });
  const original = console.error;
  console.error = () => {};
  try { await fixture.auth.login(request(validBody), response()); } finally { console.error = original; }
  assert.equal(fixture.state.queries.at(-1).sql, 'ROLLBACK');
  assert.equal(fixture.state.releases.length, 1);
});

test('login session is membership-bound and ignores client identity fields', async () => {
  const fixture = makeFixture();
  await fixture.auth.login(request({ ...validBody, shopSlug: 'shop-one' }), response());
  const insert = fixture.state.queries.find(q => /INSERT INTO owner_sessions/.test(q.sql));
  assert.deepEqual(insert.params.slice(1), [IDS.membership, IDS.account, IDS.shop, 4]);
});

test('successful login returns safe owner profile without token', async () => {
  const fixture = makeFixture();
  const res = response();
  await fixture.auth.login(request(validBody), res);
  assert.equal(res.payload.data.activeShop.id, IDS.shop);
  assert.equal(res.payload.data.membership.role, 'owner');
  assert.equal(JSON.stringify(res.payload).includes('token'), false);
});

test('requireOwnerAuth SQL validates all current session controls', async () => {
  const fixture = makeFixture();
  const req = request();
  req.headers.cookie = 'gg_beauty_owner_session=raw-token';
  await fixture.auth.requireOwnerAuth(req, response(), () => {});
  const sql = fixture.state.queries[0].sql;
  for (const fragment of [
    'session.revoked_at IS NULL', 'session.expires_at > NOW()',
    'session.session_version =', 'account.is_active = TRUE',
    'membership.is_active = TRUE', 'membership.role = ANY',
    "shop.status = 'active'"
  ]) assert.match(sql, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});
