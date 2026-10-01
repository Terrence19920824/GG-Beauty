'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { Pool, Client } = require('pg');
const bcrypt = require('bcryptjs');

const {
  createOwner,
  BootstrapError
} = require('../scripts/bootstrap-owner');

const PG_BIN = process.env.PG17_BIN || '/opt/homebrew/opt/postgresql@17/bin';

test('Parameterized Owner Bootstrap - Complete Suite', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-beauty-bootstrap-test-'));
  const data = path.join(temp, 'data');
  const port = 56100 + Math.floor(Math.random() * 800);
  const init = spawnSync(path.join(PG_BIN, 'initdb'), ['-D', data, '-A', 'trust', '--no-locale'], { encoding: 'utf8' });
  assert.equal(init.status, 0, init.stderr);

  const postgres = spawn(path.join(PG_BIN, 'postgres'), ['-D', data, '-p', String(port), '-k', temp], { stdio: 'ignore' });
  const exited = new Promise(resolve => postgres.once('exit', resolve));
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

    // Create prerequisite tables
    await db.query(`
      CREATE TABLE public.shops (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );

      CREATE TABLE public.owner_accounts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        login_identifier TEXT NOT NULL,
        login_identifier_normalized TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        display_name TEXT NOT NULL,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        session_version INTEGER NOT NULL DEFAULT 1,
        failed_login_attempts INTEGER NOT NULL DEFAULT 0,
        locked_until TIMESTAMPTZ,
        password_changed_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE public.owner_shop_memberships (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        owner_account_id UUID NOT NULL REFERENCES public.owner_accounts(id) ON DELETE RESTRICT,
        shop_id UUID NOT NULL REFERENCES public.shops(id) ON DELETE RESTRICT,
        role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'admin', 'front_desk')),
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (owner_account_id, shop_id)
      );
    `);

    // Insert two distinct shops
    await db.query(`
      INSERT INTO public.shops (slug, name, status)
      VALUES
        ('shop-alpha', 'Alpha Salon', 'active'),
        ('shop-beta', 'Beta Salon', 'active'),
        ('shop-inactive', 'Inactive Shop', 'inactive');
    `);

    const pool = new Pool({ connectionString });
    pool.on('error', () => {});
    db.on('error', () => {});

    // 1. Create owner targeting shop-alpha
    const resultAlpha = await createOwner(
      {
        shopSlug: 'shop-alpha',
        role: 'owner',
        loginIdentifier: 'AlphaOwner',
        loginIdentifierNormalized: 'alphaowner',
        displayName: 'Alpha Boss',
        password: 'PasswordAlpha2026!'
      },
      pool
    );

    assert.equal(resultAlpha.success, true);
    assert.equal(resultAlpha.shopSlug, 'shop-alpha');
    assert.equal(resultAlpha.role, 'owner');
    assert.ok(resultAlpha.ownerAccountId);
    assert.ok(resultAlpha.membershipId);

    // 2. Reject non-existent shop
    await assert.rejects(
      createOwner(
        {
          shopSlug: 'shop-non-existent',
          role: 'owner',
          loginIdentifier: 'GhostOwner',
          loginIdentifierNormalized: 'ghostowner',
          displayName: 'Ghost',
          password: 'PasswordGhost2026!'
        },
        pool
      ),
      err => err instanceof BootstrapError && /unavailable/i.test(err.publicMessage)
    );

    // 3. Reject inactive shop
    await assert.rejects(
      createOwner(
        {
          shopSlug: 'shop-inactive',
          role: 'owner',
          loginIdentifier: 'InactiveOwner',
          loginIdentifierNormalized: 'inactiveowner',
          displayName: 'Inactive Boss',
          password: 'PasswordInactive2026!'
        },
        pool
      ),
      err => err instanceof BootstrapError && /unavailable/i.test(err.publicMessage)
    );

    // 4. Attach existing account to shop-beta as manager
    const resultBeta = await createOwner(
      {
        shopSlug: 'shop-beta',
        role: 'manager',
        loginIdentifier: 'AlphaOwner',
        loginIdentifierNormalized: 'alphaowner',
        displayName: 'Alpha Boss',
        password: 'PasswordAlpha2026!'
      },
      pool
    );

    assert.equal(resultBeta.success, true);
    assert.equal(resultBeta.shopSlug, 'shop-beta');
    assert.equal(resultBeta.role, 'manager');
    // Reused account ID across shops
    assert.equal(resultBeta.ownerAccountId, resultAlpha.ownerAccountId);
    assert.notEqual(resultBeta.membershipId, resultAlpha.membershipId);

    // 5. Reject duplicate membership for same account and same shop
    await assert.rejects(
      createOwner(
        {
          shopSlug: 'shop-alpha',
          role: 'owner',
          loginIdentifier: 'AlphaOwner',
          loginIdentifierNormalized: 'alphaowner',
          displayName: 'Alpha Boss',
          password: 'PasswordAlpha2026!'
        },
        pool
      ),
      err => err instanceof BootstrapError && /already holds a membership/i.test(err.publicMessage)
    );

    // 6. Create Front Desk account targeting shop-alpha
    const resultFrontDesk = await createOwner(
      {
        shopSlug: 'shop-alpha',
        role: 'front_desk',
        loginIdentifier: 'FrontDeskAmy',
        loginIdentifierNormalized: 'frontdeskamy',
        displayName: 'Amy Front Desk',
        password: 'PasswordFrontDesk2026!'
      },
      pool
    );

    assert.equal(resultFrontDesk.success, true);
    assert.equal(resultFrontDesk.role, 'front_desk');
  } finally {
    if (typeof pool !== 'undefined' && pool) await pool.end().catch(() => {});
    if (db) await db.end().catch(() => {});
    postgres.kill('SIGINT');
    const forceKill = setTimeout(() => {
      postgres.kill('SIGKILL');
    }, 3000);
    await exited;
    clearTimeout(forceKill);
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
