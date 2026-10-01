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

const preflightSql = fs.readFileSync(path.join(ROOT, 'migrations', '093_merchant_tenant_mode_preflight_readonly.sql'), 'utf8');
const schemaSql = fs.readFileSync(path.join(ROOT, 'migrations', '094_merchant_tenant_mode_schema.sql'), 'utf8');
const verifySql = fs.readFileSync(path.join(ROOT, 'migrations', '095_merchant_tenant_mode_verification_readonly.sql'), 'utf8');
const rollbackSql = fs.readFileSync(path.join(ROOT, 'migrations', 'rollback', '094_merchant_tenant_mode_rollback.sql'), 'utf8');
const classifySql = fs.readFileSync(path.join(ROOT, 'migrations', '096_merchant_known_tenants_classification_controlled.sql'), 'utf8');
const verifyClassifySql = fs.readFileSync(path.join(ROOT, 'migrations', '097_merchant_known_tenants_classification_verification_readonly.sql'), 'utf8');
const rollbackClassifySql = fs.readFileSync(path.join(ROOT, 'migrations', 'rollback', '096_merchant_known_tenants_classification_rollback.sql'), 'utf8');

test('PostgreSQL 17 merchant tenant_mode migration lifecycle is idempotent and safe', { timeout: 120000 }, async t => {
  if (!fs.existsSync(path.join(PG_BIN, 'initdb'))) return t.skip('PostgreSQL 17 unavailable');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gg-beauty-tenant-mode-'));
  const data = path.join(temp, 'data');
  const port = 54100 + Math.floor(Math.random() * 800);
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
    db.on('error', () => {});

    // 1. Create baseline shops table without tenant_mode
    await db.query(`
      CREATE TABLE public.shops (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
      );
    `);

    // Insert existing Shop A (representative development shop)
    await db.query(`
      INSERT INTO public.shops (id, slug, name, status)
      VALUES ('5e002f26-1267-4bb6-8c73-d60f11985799', 'gg-beauty', 'GG-Beauty', 'active')
    `);

    // 2. Run Preflight
    await db.query(preflightSql);

    // 3. Run Forward Schema Migration
    await db.query(schemaSql);

    // Verify existing Shop A received default 'live' without error
    const shopAResult = await db.query(
      `SELECT tenant_mode FROM public.shops WHERE id = '5e002f26-1267-4bb6-8c73-d60f11985799'`
    );
    assert.equal(shopAResult.rows[0].tenant_mode, 'live');

    // 4. Run Verification Migration
    await db.query(verifySql);

    // 5. Test Check Constraints for tenant_mode
    // Allowed values: 'demo', 'test', 'live'
    await db.query(`
      INSERT INTO public.shops (slug, name, tenant_mode)
      VALUES ('shop-demo', 'Demo Shop', 'demo')
    `);
    await db.query(`
      INSERT INTO public.shops (slug, name, tenant_mode)
      VALUES ('shop-test', 'Test Shop', 'test')
    `);
    await db.query(`
      INSERT INTO public.shops (slug, name, tenant_mode)
      VALUES ('shop-live', 'Live Shop', 'live')
    `);

    // Disallowed value: 'production', 'staging', 'other' -> must fail with 23514
    await assert.rejects(
      db.query(`
        INSERT INTO public.shops (slug, name, tenant_mode)
        VALUES ('shop-invalid', 'Invalid Shop', 'production')
      `),
      error => error.code === '23514'
    );

    // Idempotent schema execution
    await db.query(schemaSql);
    await db.query(verifySql);

    // 6. Test Rollback Migration
    await db.query(rollbackSql);

    // Verify tenant_mode column is removed
    const columns = await db.query(`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'shops' AND column_name = 'tenant_mode'
    `);
    assert.equal(columns.rows.length, 0);

    // Verify shops table and data remain intact
    const remainingShops = await db.query(`SELECT slug FROM public.shops ORDER BY slug`);
    assert.deepEqual(
      remainingShops.rows.map(r => r.slug),
      ['gg-beauty', 'shop-demo', 'shop-live', 'shop-test']
    );

    // Re-apply forward migration and verification for complete round-trip proof
    await db.query(schemaSql);
    await db.query(verifySql);

    // 7. Test Controlled Classification Migration (096 & 097)
    // First, test FAIL-CLOSED when expected GG-Beauty Test Shop is missing
    await assert.rejects(
      db.query(classifySql),
      err => /Controlled classification aborted/i.test(err.message)
    );
    await db.query('ROLLBACK').catch(() => {});

    // Insert GG-Beauty Test Shop with exact ID and slug
    await db.query(`
      INSERT INTO public.shops (id, slug, name, status, tenant_mode)
      VALUES ('aa7a9c1b-a9c1-4775-86bd-9c11b16eb451', 'gg-beauty-test', 'GG-Beauty Test Shop', 'active', 'live')
    `);

    // Insert an unrelated unknown merchant to verify it is NOT auto-classified
    await db.query(`
      INSERT INTO public.shops (id, slug, name, status, tenant_mode)
      VALUES ('99999999-9999-9999-9999-999999999999', 'unknown-shop', 'Unknown Merchant', 'active', 'live')
    `);

    // Test FAIL-CLOSED when slug is mismatched (identity drift)
    await db.query(`UPDATE public.shops SET slug = 'gg-beauty-drift' WHERE id = '5e002f26-1267-4bb6-8c73-d60f11985799'`);
    await assert.rejects(
      db.query(classifySql),
      err => /Controlled classification aborted/i.test(err.message)
    );
    await db.query('ROLLBACK').catch(() => {});
    // Restore exact slug
    await db.query(`UPDATE public.shops SET slug = 'gg-beauty' WHERE id = '5e002f26-1267-4bb6-8c73-d60f11985799'`);

    // Now execute controlled classification successfully
    await db.query(classifySql);

    // Verify exact classifications
    const ggBeautyRow = await db.query(`SELECT tenant_mode, slug FROM public.shops WHERE id = '5e002f26-1267-4bb6-8c73-d60f11985799'`);
    assert.equal(ggBeautyRow.rows[0].tenant_mode, 'demo');
    assert.equal(ggBeautyRow.rows[0].slug, 'gg-beauty');

    const ggTestRow = await db.query(`SELECT tenant_mode, slug FROM public.shops WHERE id = 'aa7a9c1b-a9c1-4775-86bd-9c11b16eb451'`);
    assert.equal(ggTestRow.rows[0].tenant_mode, 'test');
    assert.equal(ggTestRow.rows[0].slug, 'gg-beauty-test');

    // Verify unknown merchant was NOT auto-classified and remains 'live'
    const unknownRow = await db.query(`SELECT tenant_mode FROM public.shops WHERE id = '99999999-9999-9999-9999-999999999999'`);
    assert.equal(unknownRow.rows[0].tenant_mode, 'live');

    // Verify no merchant was deleted or lost
    const shopCount = await db.query(`SELECT count(*) FROM public.shops`);
    assert.equal(shopCount.rows[0].count, '6');

    // 8. Run Read-Only Verification Migration (097)
    await db.query(verifyClassifySql);

    // 9. Run Rollback Migration for Controlled Classification (rollback/096)
    await db.query(rollbackClassifySql);

    const ggBeautyReverted = await db.query(`SELECT tenant_mode FROM public.shops WHERE id = '5e002f26-1267-4bb6-8c73-d60f11985799'`);
    assert.equal(ggBeautyReverted.rows[0].tenant_mode, 'live');

    const ggTestReverted = await db.query(`SELECT tenant_mode FROM public.shops WHERE id = 'aa7a9c1b-a9c1-4775-86bd-9c11b16eb451'`);
    assert.equal(ggTestReverted.rows[0].tenant_mode, 'live');

    // Re-apply 096 and 097 for round-trip proof
    await db.query(classifySql);
    await db.query(verifyClassifySql);
  } finally {
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
