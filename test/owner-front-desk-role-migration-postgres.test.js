'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Client } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';
const migration = fs.readFileSync(path.join(ROOT, 'migrations', '053_owner_front_desk_role.sql'), 'utf8');
const rollback = fs.readFileSync(path.join(ROOT, 'migrations', 'rollback', '053_owner_front_desk_role.sql'), 'utf8');

test('PostgreSQL 17 front-desk role migration is idempotent and has a data-safe rollback', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-beauty-owner-role-'));
  const data = path.join(temp, 'data');
  const port = 57300 + Math.floor(Math.random() * 400);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port)], { stdio: 'ignore' });
  const connectionString = `postgresql://${os.userInfo().username}@127.0.0.1:${port}/postgres`;
  let db;
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      const candidate = new Client({ connectionString });
      try {
        await candidate.connect();
        db = candidate;
        break;
      } catch (error) {
        await candidate.end().catch(() => {});
        if (attempt === 39) throw error;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
    assert.ok(db, 'local PostgreSQL test server must accept a connection');
    await db.query(`CREATE TABLE public.owner_shop_memberships (role text NOT NULL CONSTRAINT owner_shop_memberships_role_check CHECK (role IN ('owner', 'manager', 'admin')))`);
    await db.query("INSERT INTO public.owner_shop_memberships (role) VALUES ('owner'), ('manager'), ('admin')");

    await db.query(migration);
    await db.query(migration);
    await db.query("INSERT INTO public.owner_shop_memberships (role) VALUES ('front_desk')");
    await assert.rejects(db.query("INSERT INTO public.owner_shop_memberships (role) VALUES ('invalid_role')"), error => error.code === '23514');
    assert.deepEqual((await db.query('SELECT role FROM public.owner_shop_memberships ORDER BY role')).rows.map(row => row.role), ['admin', 'front_desk', 'manager', 'owner']);

    await assert.rejects(db.query(rollback), /Cannot roll back 053 while front_desk memberships exist/);
    await db.query('ROLLBACK');
    assert.match((await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'public.owner_shop_memberships'::regclass AND conname = 'owner_shop_memberships_role_check'")).rows[0].definition, /front_desk/);

    await db.query("DELETE FROM public.owner_shop_memberships WHERE role = 'front_desk'");
    await db.query(rollback);
    assert.deepEqual((await db.query('SELECT role FROM public.owner_shop_memberships ORDER BY role')).rows.map(row => row.role), ['admin', 'manager', 'owner']);
    await assert.rejects(db.query("INSERT INTO public.owner_shop_memberships (role) VALUES ('front_desk')"), error => error.code === '23514');

    await db.query('ALTER TABLE public.owner_shop_memberships DROP CONSTRAINT owner_shop_memberships_role_check');
    await db.query("INSERT INTO public.owner_shop_memberships (role) VALUES ('invalid_existing_role')");
    await assert.rejects(db.query(migration), error => error.code === '23514');
    await db.query('ROLLBACK');
    const definition = (await db.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid = 'public.owner_shop_memberships'::regclass AND conname = 'owner_shop_memberships_role_check'"));
    assert.equal(definition.rowCount, 0, 'a failing replacement must roll back to the pre-migration no-constraint state');
  } finally {
    await db?.end().catch(() => {});
    if (!postgres.killed) postgres.kill('SIGTERM');
    await new Promise(resolve => postgres.once('exit', resolve));
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
