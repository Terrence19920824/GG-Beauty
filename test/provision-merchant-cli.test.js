'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT_PATH = path.resolve(__dirname, '..', 'scripts', 'provision-merchant.js');

test('provision-merchant CLI release hardening - password & category help tests', async t => {
  // 1. --help output verification
  const helpResult = spawnSync(process.execPath, [SCRIPT_PATH, '--help'], { encoding: 'utf8' });
  assert.equal(helpResult.status, 0, 'Exit code must be 0 for --help');
  assert.ok(helpResult.stdout.includes('Usage: node scripts/provision-merchant.js'), 'Must contain usage header');
  assert.ok(!helpResult.stdout.includes('--owner-password'), 'Must NOT expose --owner-password in help output');
  assert.ok(
    helpResult.stdout.includes('canonicalName') && helpResult.stdout.includes('nameZh') && helpResult.stdout.includes('nameEn'),
    'Help text for categories must reflect canonicalName, nameZh, and nameEn schema'
  );

  // 2. Rejection of plaintext password via --owner-password
  const rejectKebab = spawnSync(
    process.execPath,
    [SCRIPT_PATH, '--name', 'Test', '--slug', 'test', '--owner-login', 'admin', '--owner-password', 'SecretPass123456!'],
    { encoding: 'utf8' }
  );
  assert.equal(rejectKebab.status, 1, 'Must exit with code 1 when --owner-password is provided');
  assert.ok(
    /Security error: Plaintext passwords cannot be supplied via --owner-password/i.test(rejectKebab.stderr),
    'Must output security error rejecting command-line password arguments'
  );

  // 3. Rejection of plaintext password via --ownerPassword (camelCase alias)
  const rejectCamel = spawnSync(
    process.execPath,
    [SCRIPT_PATH, '--name', 'Test', '--slug', 'test', '--owner-login', 'admin', '--ownerPassword', 'SecretPass123456!'],
    { encoding: 'utf8' }
  );
  assert.equal(rejectCamel.status, 1, 'Must exit with code 1 when --ownerPassword is provided');
  assert.ok(
    /Security error: Plaintext passwords cannot be supplied via --owner-password/i.test(rejectCamel.stderr),
    'Must output security error rejecting camelCase password arguments'
  );

  // 4. Non-interactive attempt to provide owner without TTY fails securely
  const nonTtyOwner = spawnSync(
    process.execPath,
    [SCRIPT_PATH, '--name', 'Test', '--slug', 'test', '--owner-login', 'admin'],
    {
      encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: 'postgres://localhost/dummy' },
      input: ''
    }
  );
  assert.equal(nonTtyOwner.status, 1, 'Must exit with code 1 when interactive TTY is unavailable');
  assert.ok(
    /A secure interactive TTY is required/i.test(nonTtyOwner.stderr),
    'Must reject when secure interactive TTY is missing'
  );
});
