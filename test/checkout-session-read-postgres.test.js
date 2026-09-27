'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');

const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const readHandler = fs.readFileSync(path.join(__dirname, '..', 'lib', 'checkout-pos-read.js'), 'utf8');

test('checkout-session read transaction is database-enforced read-only', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');
  assert.match(readHandler, /BEGIN READ ONLY/);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-checkout-read-'));
  const data = path.join(temp, 'data');
  const socket = path.join(temp, 'socket');
  const port = 58150 + Math.floor(Math.random() * 80);
  fs.mkdirSync(socket);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);
  let stderr = '';
  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-k', socket, '-p', String(port)], { stdio: ['ignore', 'ignore', 'pipe'] });
  postgres.stderr.on('data', chunk => { stderr += chunk; });
  const postgresExit = new Promise(resolve => { postgres.once('exit', (code, signal) => resolve({ code, signal })); postgres.once('error', error => resolve({ error })); });
  let db;
  try {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      if (postgres.exitCode !== null || postgres.signalCode !== null) throw new Error(`PostgreSQL exited before readiness: ${stderr}`);
      db = new Client({ host: socket, port, database: 'postgres', user: os.userInfo().username });
      try { await db.connect(); break; }
      catch { await db.end().catch(() => {}); db = null; await new Promise(resolve => setTimeout(resolve, 100)); }
    }
    assert.ok(db);
    await db.query('CREATE TABLE read_only_probe (id integer PRIMARY KEY)');
    await db.query('BEGIN READ ONLY');
    await assert.rejects(db.query('INSERT INTO read_only_probe VALUES (1)'), error => error.code === '25006');
    await db.query('ROLLBACK');
    assert.equal((await db.query('SELECT count(*) FROM read_only_probe')).rows[0].count, '0');
  } finally {
    if (db) await db.end().catch(() => {});
    if (postgres.exitCode === null && postgres.signalCode === null) postgres.kill('SIGTERM');
    await postgresExit;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
