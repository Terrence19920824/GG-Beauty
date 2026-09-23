'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { app } = require('../server');

const withServer = async operation => {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    return await operation(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
};

for (const path of [
  '/api/bookings',
  '/api/bookings/1001',
  '/api/bookings/phone/%2B6591234567'
]) {
  test(`anonymous legacy booking read ${path} is retired without PII`, async () => {
    await withServer(async baseUrl => {
      const response = await fetch(`${baseUrl}${path}`);
      assert.equal(response.status, 410);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const payload = await response.json();
      assert.deepEqual(payload, {
        success: false,
        code: 'LEGACY_BOOKINGS_RETIRED',
        message: '旧版预约读取接口已停用'
      });
      assert.doesNotMatch(JSON.stringify(payload), /phone|email|customer|91234567/i);
    });
  });
}
