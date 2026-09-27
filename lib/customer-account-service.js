'use strict';

const crypto = require('crypto');
const { normalizePhone } = require('./customer-identity');
const { normalizeSelectedPhone, tokenHash } = require('./customer-member-identity');
const { memberPresentationFromShopSettings } = require('./customer-member-config');

const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

class CustomerAccountError extends Error {
  constructor(code, status = 400) {
    super(code);
    this.name = 'CustomerAccountError';
    this.code = code;
    this.status = status;
  }
}

const runTransaction = async (pool, work) => {
  let client;
  let shouldRelease = false;
  if (typeof pool.connect === 'function') {
    try {
      client = await pool.connect();
      shouldRelease = typeof client.release === 'function';
    } catch (err) {
      if (/already been connected/i.test(err.message)) {
        client = pool;
        shouldRelease = false;
      } else {
        throw err;
      }
    }
  } else {
    client = pool;
  }
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    if (shouldRelease && typeof client.release === 'function') {
      client.release();
    }
  }
};

const resolveShop = async (client, shopSlug) => {
  const result = await client.query(
    `SELECT shop.id AS shop_id, shop.name AS shop_name, shop.slug AS shop_slug,
            settings.default_phone_country_code, settings.dob_requirement,
            settings.membership_enabled, settings.points_enabled,
            settings.stored_value_enabled, settings.packages_enabled,
            settings.auto_free_membership,
            to_jsonb(settings) AS customer_settings
     FROM shops shop
     JOIN shop_customer_settings settings ON settings.shop_id = shop.id
     WHERE shop.slug = $1 AND shop.status = 'active'`,
    [shopSlug]
  );
  if (result.rows.length !== 1) {
    throw new CustomerAccountError('SHOP_NOT_FOUND', 404);
  }
  return result.rows[0];
};

const calculateExpiresAt = (startedAt, validityType, validityDays) => {
  if (validityType === 'permanent' || !validityType) return null;
  const d = new Date(startedAt.getTime());
  if (validityType === '3_months') {
    d.setMonth(d.getMonth() + 3);
    return d;
  }
  if (validityType === '6_months') {
    d.setMonth(d.getMonth() + 6);
    return d;
  }
  if (validityType === '12_months') {
    d.setFullYear(d.getFullYear() + 1);
    return d;
  }
  if (validityType === 'custom_days' && Number.isInteger(validityDays) && validityDays > 0) {
    return new Date(d.getTime() + validityDays * 24 * 60 * 60 * 1000);
  }
  return null;
};

const createCustomerAccountService = ({ pool, now = () => new Date() }) => {
  if (!pool) throw new Error('CUSTOMER_ACCOUNT_DEPENDENCY_INVALID');

  const getShopSettings = async shopId => {
    const result = await pool.query(
      `SELECT membership_enabled, points_enabled, stored_value_enabled, packages_enabled, auto_free_membership
       FROM shop_customer_settings WHERE shop_id = $1`,
      [shopId]
    );
    return result.rows[0] || {
      membership_enabled: false,
      points_enabled: false,
      stored_value_enabled: false,
      packages_enabled: false,
      auto_free_membership: true
    };
  };

  const updateShopSettings = async (shopId, settings) => {
    const current = await getShopSettings(shopId);
    const membershipEnabled = settings.membership_enabled !== undefined ? Boolean(settings.membership_enabled) : current.membership_enabled === true;

    const result = await pool.query(
      `INSERT INTO shop_customer_settings (shop_id, membership_enabled, points_enabled, stored_value_enabled, packages_enabled, updated_at)
       VALUES ($1, $2, false, false, false, NOW())
       ON CONFLICT (shop_id) DO UPDATE
       SET membership_enabled = EXCLUDED.membership_enabled,
           points_enabled = false,
           stored_value_enabled = false,
           packages_enabled = false,
           updated_at = NOW()
       RETURNING membership_enabled, points_enabled, stored_value_enabled, packages_enabled, auto_free_membership`,
      [shopId, membershipEnabled]
    );
    return result.rows[0];
  };

  const findOrCreateCustomer = async (client, { shopId, phoneNormalized, name, email, dateOfBirth, gender }) => {
    const existing = await client.query(
      `SELECT id, member_code, name, phone, phone_normalized, phone_verified_at, identity_status, date_of_birth, gender, email
       FROM customers WHERE shop_id = $1 AND phone_normalized = $2 ORDER BY id LIMIT 1`,
      [shopId, phoneNormalized]
    );
    if (existing.rows.length === 1) {
      const row = existing.rows[0];
      const nextName = (typeof name === 'string' && name.trim()) ? name.trim() : row.name;
      const nextEmail = email !== undefined ? (email ? email.trim() : null) : row.email;
      const nextDob = dateOfBirth !== undefined ? (dateOfBirth || null) : row.date_of_birth;
      const nextGender = gender !== undefined ? (gender || null) : row.gender;

      if (nextName !== row.name || nextEmail !== row.email || nextDob !== row.date_of_birth || nextGender !== row.gender) {
        await client.query(
          `UPDATE customers SET name = $3, email = $4, date_of_birth = $5, gender = $6 WHERE shop_id = $1 AND id = $2`,
          [shopId, row.id, nextName, nextEmail, nextDob, nextGender]
        );
      }
      return {
        id: row.id,
        memberCode: row.member_code,
        name: nextName,
        phone: row.phone,
        phoneNormalized: row.phone_normalized,
        email: nextEmail,
        dateOfBirth: nextDob,
        gender: nextGender,
        phoneVerifiedAt: row.phone_verified_at,
        isPhoneVerified: Boolean(row.phone_verified_at)
      };
    }

    if (typeof name !== 'string' || !name.trim()) {
      throw new CustomerAccountError('CUSTOMER_NAME_REQUIRED');
    }

    const inserted = await client.query(
      `INSERT INTO customers (shop_id, name, phone, phone_normalized, email, date_of_birth, gender, identity_status)
       VALUES ($1, $2, $3, $3, $4, $5, $6, 'unverified_contact')
       RETURNING id, member_code, name, phone, phone_normalized, email, date_of_birth, gender, phone_verified_at`,
      [shopId, name.trim(), phoneNormalized, email?.trim() || null, dateOfBirth || null, gender || null]
    );
    const row = inserted.rows[0];
    return {
      id: row.id,
      memberCode: row.member_code,
      name: row.name,
      phone: row.phone,
      phoneNormalized: row.phone_normalized,
      email: row.email,
      dateOfBirth: row.date_of_birth,
      gender: row.gender,
      phoneVerifiedAt: row.phone_verified_at,
      isPhoneVerified: false
    };
  };

  const ensureAccount = async (client, { shopId, customerId, phoneNormalized, createdByRole = 'customer' }) => {
    const existing = await client.query(
      `SELECT id, status, registered_at, created_by_role
       FROM customer_accounts WHERE shop_id = $1 AND customer_id = $2`,
      [shopId, customerId]
    );
    if (existing.rows.length === 1) {
      return existing.rows[0];
    }

    const inserted = await client.query(
      `INSERT INTO customer_accounts (shop_id, customer_id, phone_normalized, status, created_by_role, registered_at)
       VALUES ($1, $2, $3, 'active', $4, $5)
       ON CONFLICT (shop_id, customer_id) DO UPDATE SET updated_at = NOW()
       RETURNING id, status, registered_at, created_by_role`,
      [shopId, customerId, phoneNormalized, createdByRole, now()]
    );
    return inserted.rows[0];
  };

  const ensureMembership = async (client, { shopId, customerId, activatedBy = 'auto_free' }) => {
    const settings = await client.query(
      `SELECT membership_enabled, auto_free_membership FROM shop_customer_settings WHERE shop_id = $1`,
      [shopId]
    );
    const config = settings.rows[0];
    if (!config || config.membership_enabled !== true || config.auto_free_membership !== true) {
      return null;
    }

    const existing = await client.query(
      `SELECT cm.id, cm.status, cm.started_at, cm.expires_at, cm.activated_by,
              mt.tier_code, mt.name AS tier_name
       FROM customer_memberships cm
       JOIN membership_tiers mt ON mt.shop_id = cm.shop_id AND mt.id = cm.tier_id
       WHERE cm.shop_id = $1 AND cm.customer_id = $2 AND cm.status = 'active'
       ORDER BY cm.created_at DESC LIMIT 1`,
      [shopId, customerId]
    );
    if (existing.rows.length === 1) {
      const row = existing.rows[0];
      const isExpired = row.expires_at && new Date(row.expires_at) <= now();
      return {
        id: row.id,
        status: isExpired ? 'expired' : row.status,
        isActive: !isExpired && row.status === 'active' && config.membership_enabled === true,
        tierCode: row.tier_code,
        tierName: row.tier_name,
        startedAt: row.started_at,
        expiresAt: row.expires_at,
        activatedBy: row.activated_by
      };
    }

    const defaultTier = await client.query(
      `SELECT id, tier_code, name, validity_type, validity_days
       FROM membership_tiers WHERE shop_id = $1 AND is_default = true AND is_active = true
       ORDER BY created_at ASC LIMIT 1`,
      [shopId]
    );
    if (defaultTier.rows.length !== 1) {
      return null;
    }
    const tier = defaultTier.rows[0];
    const startedAt = now();
    const expiresAt = calculateExpiresAt(startedAt, tier.validity_type, tier.validity_days);

    const inserted = await client.query(
      `INSERT INTO customer_memberships (shop_id, customer_id, tier_id, status, started_at, expires_at, activated_by)
       VALUES ($1, $2, $3, 'active', $4, $5, $6)
       RETURNING id, status, started_at, expires_at, activated_by`,
      [shopId, customerId, tier.id, startedAt, expiresAt, activatedBy]
    );
    const row = inserted.rows[0];
    return {
      id: row.id,
      status: row.status,
      isActive: true,
      tierCode: tier.tier_code,
      tierName: tier.name,
      startedAt: row.started_at,
      expiresAt: row.expires_at,
      activatedBy: row.activated_by
    };
  };

  const signInWithPhone = async ({ shopSlug, countryCode, phone, name, email, dateOfBirth, gender }) => {
    const normalized = normalizeSelectedPhone({ countryCode, phone });
    if (!normalized) throw new CustomerAccountError('PHONE_INVALID');

    return runTransaction(pool, async client => {
      const shop = await resolveShop(client, shopSlug);
      const customer = await findOrCreateCustomer(client, {
        shopId: shop.shop_id,
        phoneNormalized: normalized,
        name,
        email,
        dateOfBirth,
        gender
      });

      const account = await ensureAccount(client, {
        shopId: shop.shop_id,
        customerId: customer.id,
        phoneNormalized: normalized,
        createdByRole: 'customer'
      });

      const membership = await ensureMembership(client, {
        shopId: shop.shop_id,
        customerId: customer.id,
        activatedBy: 'auto_free'
      });

      const token = crypto.randomBytes(32).toString('base64url');
      await client.query(
        `INSERT INTO customer_sessions(shop_id, customer_id, token_hash, expires_at)
         VALUES($1, $2, $3, $4)`,
        [shop.shop_id, customer.id, tokenHash(token), new Date(now().getTime() + SESSION_TTL_MS)]
      );

      return {
        token,
        shopId: shop.shop_id,
        shopSlug: shop.shop_slug,
        customerId: customer.id,
        memberCode: customer.memberCode,
        isPhoneVerified: customer.isPhoneVerified,
        account,
        membership
      };
    });
  };

  const getCustomerSummary = async ({ shopId, customerId }) => {
    const settings = await getShopSettings(shopId);

    const customerRes = await pool.query(
      `SELECT c.id, c.member_code, c.name, c.phone, c.phone_normalized, c.email,
              c.date_of_birth, c.gender, c.phone_verified_at, c.identity_status,
              s.name AS shop_name, s.slug AS shop_slug
       FROM customers c
       JOIN shops s ON s.id = c.shop_id
       WHERE c.shop_id = $1 AND c.id = $2`,
      [shopId, customerId]
    );
    if (customerRes.rows.length !== 1) return null;
    const c = customerRes.rows[0];

    const accountRes = await pool.query(
      `SELECT id, status, registered_at, created_by_role
       FROM customer_accounts WHERE shop_id = $1 AND customer_id = $2`,
      [shopId, customerId]
    );
    const account = accountRes.rows[0] || null;

    let membership = null;
    const membershipRes = await pool.query(
      `SELECT cm.id, cm.status, cm.started_at, cm.expires_at, cm.activated_by,
              mt.tier_code, mt.name AS tier_name
       FROM customer_memberships cm
       JOIN membership_tiers mt ON mt.shop_id = cm.shop_id AND mt.id = cm.tier_id
       WHERE cm.shop_id = $1 AND cm.customer_id = $2 AND cm.status = 'active'
       ORDER BY cm.created_at DESC LIMIT 1`,
      [shopId, customerId]
    );
    if (membershipRes.rows.length === 1) {
      const m = membershipRes.rows[0];
      const isExpired = m.expires_at && new Date(m.expires_at) <= now();
      membership = {
        id: m.id,
        status: isExpired ? 'expired' : m.status,
        isActive: !isExpired && m.status === 'active' && settings.membership_enabled === true,
        tierCode: m.tier_code,
        tierName: m.tier_name,
        startedAt: m.started_at,
        expiresAt: m.expires_at,
        activatedBy: m.activated_by
      };
    }

    const isVerified = Boolean(c.phone_verified_at);

    return {
      shopId: c.shop_id,
      shopSlug: c.shop_slug,
      shopName: c.shop_name,
      customerId: c.id,
      memberCode: c.member_code,
      name: c.name,
      phone: isVerified ? c.phone : null,
      phoneNormalized: c.phone_normalized,
      email: isVerified ? c.email : null,
      dateOfBirth: isVerified ? c.date_of_birth : null,
      gender: isVerified ? c.gender : null,
      phoneVerifiedAt: c.phone_verified_at,
      isPhoneVerified: isVerified,
      account: account ? {
        id: account.id,
        status: account.status,
        registeredAt: account.registered_at,
        createdByRole: account.created_by_role
      } : null,
      membership,
      modules: {
        membership: settings.membership_enabled === true,
        points: settings.points_enabled === true,
        storedValue: settings.stored_value_enabled === true,
        packages: settings.packages_enabled === true
      }
    };
  };

  return {
    ensureAccount,
    ensureMembership,
    findOrCreateCustomer,
    getCustomerSummary,
    getShopSettings,
    resolveShop,
    signInWithPhone,
    updateShopSettings
  };
};

module.exports = {
  CustomerAccountError,
  createCustomerAccountService
};
