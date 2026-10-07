'use strict';

process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');
const bookingChannel = require('../public/booking-channel');

const makeStorage = () => {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
    snapshot() { return new Map(values); }
  };
};

const capture = (storage, shopSlug, href) => {
  const replacements = [];
  const historyLike = {
    state: { retained: true },
    replaceState(state, title, url) { replacements.push({ state, title, url }); }
  };
  const value = bookingChannel.captureFromLocation({
    locationLike: { href },
    historyLike,
    storage,
    shopSlug
  });
  return { value, replacements };
};

test('all seven allowlisted channels normalize, persist per shop and are removed from the captured URL', () => {
  assert.deepEqual(bookingChannel.CHANNELS, [
    'whatsapp', 'instagram', 'tiktok', 'xiaohongshu', 'douyin', 'google', 'website'
  ]);

  for (const channel of bookingChannel.CHANNELS) {
    const storage = makeStorage();
    const result = capture(
      storage,
      'gg-beauty',
      `https://example.test/book/gg-beauty?keep=1&channel=${channel}#services`
    );
    assert.equal(result.value, channel);
    assert.equal(bookingChannel.readForShop(storage, 'gg-beauty'), channel);
    assert.deepEqual(result.replacements.map(item => item.url), [
      '/book/gg-beauty?keep=1#services'
    ]);
  }
});

test('channel normalization accepts casing and surrounding spaces only for exact allowlist members', () => {
  assert.equal(bookingChannel.normalize('  InStaGram  '), 'instagram');
  assert.equal(bookingChannel.normalize(' WHATSAPP '), 'whatsapp');
  assert.equal(bookingChannel.normalize('instagram-ad'), null);
  assert.equal(bookingChannel.normalize(''), null);
  assert.equal(bookingChannel.normalize('x'.repeat(bookingChannel.MAX_CHANNEL_LENGTH + 1)), null);
  assert.equal(bookingChannel.normalize(['instagram']), null);
});

test('duplicate, invalid, overlong and missing URL channels do not save or overwrite an existing valid channel', () => {
  const storage = makeStorage();
  bookingChannel.writeForShop(storage, 'shop-a', 'google');

  for (const href of [
    'https://example.test/book/shop-a',
    'https://example.test/book/shop-a?channel=invalid',
    `https://example.test/book/shop-a?channel=${'x'.repeat(80)}`,
    'https://example.test/book/shop-a?channel=instagram&channel=google'
  ]) {
    const result = capture(storage, 'shop-a', href);
    assert.equal(result.value, 'google');
    assert.equal(result.replacements.length, 0);
    assert.equal(bookingChannel.readForShop(storage, 'shop-a'), 'google');
  }
});

test('a new valid channel replaces the old channel without crossing shop namespaces', () => {
  const storage = makeStorage();
  bookingChannel.writeForShop(storage, 'shop-a', 'whatsapp');
  bookingChannel.writeForShop(storage, 'shop-b', 'tiktok');

  assert.equal(capture(storage, 'shop-a', 'https://example.test/book/shop-a?channel=Douyin').value, 'douyin');
  assert.equal(bookingChannel.readForShop(storage, 'shop-a'), 'douyin');
  assert.equal(bookingChannel.readForShop(storage, 'shop-b'), 'tiktok');
  assert.notEqual(bookingChannel.storageKey('shop-a'), bookingChannel.storageKey('shop-b'));
});

test('successful booking cleanup is shop-scoped while retry state can remain available', () => {
  const storage = makeStorage();
  bookingChannel.writeForShop(storage, 'shop-a', 'instagram');
  bookingChannel.writeForShop(storage, 'shop-b', 'website');

  // A failed booking does not call clearForShop, so the retry attribution remains.
  assert.equal(bookingChannel.readForShop(storage, 'shop-a'), 'instagram');

  bookingChannel.clearForShop(storage, 'shop-a');
  assert.equal(bookingChannel.readForShop(storage, 'shop-a'), null);
  assert.equal(bookingChannel.readForShop(storage, 'shop-b'), 'website');
});

const withServer = async operation => {
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
};

test('public booking API rejects forged invalid channel values with BOOKING_CHANNEL_INVALID before DB access', async () => {
  delete process.env.BOOKING_WRITE_MAINTENANCE;
  const previousPool = app.locals.bookingPool;
  let connections = 0;
  app.locals.bookingPool = {
    async connect() {
      connections += 1;
      throw new Error('database must not be reached for invalid channel input');
    }
  };

  try {
    await withServer(async baseUrl => {
      for (const invalid of ['invalid', 'x'.repeat(80), ' ', ['instagram'], { channel: 'instagram' }]) {
        const response = await fetch(`${baseUrl}/api/new-db`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            shopSlug: 'gg-beauty',
            startAt: '2030-01-07T02:00:00.000Z',
            customerName: 'Customer',
            phone: '+6581234567',
            items: [],
            bookingChannel: invalid
          })
        });
        assert.equal(response.status, 400);
        assert.equal((await response.json()).code, 'BOOKING_CHANNEL_INVALID');
      }
    });
    assert.equal(connections, 0);
  } finally {
    app.locals.bookingPool = previousPool;
  }
});
