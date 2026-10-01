'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 16;
const MAX_PASSWORD_BYTES = 72;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const ALLOWED_TENANT_MODES = new Set(['demo', 'test', 'live']);

class MerchantProvisioningError extends Error {
  constructor(code, status, publicMessage) {
    super(publicMessage);
    this.name = 'MerchantProvisioningError';
    this.code = code;
    this.status = status;
    this.publicMessage = publicMessage;
  }
}

const normalizeSlug = value => {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
};

const isValidTimezone = tz => {
  if (!tz || typeof tz !== 'string') return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz.trim() });
    return true;
  } catch (_) {
    return false;
  }
};

const validateProvisioningInput = (options = {}) => {
  if (!options || typeof options !== 'object' || Array.isArray(options)) {
    throw new MerchantProvisioningError(
      'INVALID_INPUT',
      400,
      'Provisioning options must be an object'
    );
  }

  // 1. Merchant Name
  const name = typeof options.name === 'string' ? options.name.trim() : '';
  if (!name || name.length > 200) {
    throw new MerchantProvisioningError(
      'INVALID_MERCHANT_NAME',
      400,
      'Merchant name must be between 1 and 200 characters'
    );
  }

  // 2. Slug
  const slug = normalizeSlug(options.slug);
  if (!slug || slug.length > 100 || !SLUG_PATTERN.test(slug)) {
    throw new MerchantProvisioningError(
      'INVALID_SLUG',
      400,
      'Merchant slug must contain only lowercase letters, numbers, and single hyphens (max 100 chars)'
    );
  }

  // 3. Tenant Mode
  const rawMode = options.tenantMode !== undefined ? options.tenantMode : 'live';
  const tenantMode = typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : '';
  if (!ALLOWED_TENANT_MODES.has(tenantMode)) {
    throw new MerchantProvisioningError(
      'INVALID_TENANT_MODE',
      400,
      `Tenant mode must be one of: ${Array.from(ALLOWED_TENANT_MODES).join(', ')}`
    );
  }

  // 4. Initial Location
  const locationRaw = options.location || {};
  if (typeof locationRaw !== 'object' || Array.isArray(locationRaw)) {
    throw new MerchantProvisioningError(
      'INVALID_LOCATION',
      400,
      'Location options must be an object'
    );
  }

  const locationName = typeof locationRaw.name === 'string' && locationRaw.name.trim()
    ? locationRaw.name.trim().slice(0, 200)
    : 'Main Branch';

  const timezone = typeof locationRaw.timezone === 'string' && locationRaw.timezone.trim()
    ? locationRaw.timezone.trim()
    : 'Asia/Singapore';

  if (!isValidTimezone(timezone)) {
    throw new MerchantProvisioningError(
      'INVALID_TIMEZONE',
      400,
      `Timezone "${timezone}" is invalid`
    );
  }

  // 5. Initial Categories
  const categoriesRaw = options.categories !== undefined ? options.categories : [];
  if (!Array.isArray(categoriesRaw)) {
    throw new MerchantProvisioningError(
      'INVALID_CATEGORIES',
      400,
      'Categories must be an array'
    );
  }

  const categories = categoriesRaw.map((cat, index) => {
    if (!cat || typeof cat !== 'object') {
      throw new MerchantProvisioningError(
        'INVALID_CATEGORY',
        400,
        `Category at index ${index} must be an object`
      );
    }
    const canonicalName = typeof cat.canonicalName === 'string' ? cat.canonicalName.trim() : '';
    if (!canonicalName || canonicalName.length > 200) {
      throw new MerchantProvisioningError(
        'INVALID_CATEGORY_NAME',
        400,
        `Category at index ${index} must have a canonicalName between 1 and 200 characters`
      );
    }
    return {
      canonicalName,
      iconKey: typeof cat.iconKey === 'string' && cat.iconKey.trim() ? cat.iconKey.trim().slice(0, 100) : null,
      sortOrder: Number.isInteger(cat.sortOrder) && cat.sortOrder >= 0 ? cat.sortOrder : index * 10,
      nameZh: typeof cat.nameZh === 'string' && cat.nameZh.trim() ? cat.nameZh.trim().slice(0, 200) : null,
      nameEn: typeof cat.nameEn === 'string' && cat.nameEn.trim() ? cat.nameEn.trim().slice(0, 200) : null,
      isActive: cat.isActive !== false
    };
  });

  // 6. Optional Owner
  let owner = null;
  if (options.owner !== undefined && options.owner !== null) {
    if (typeof options.owner !== 'object' || Array.isArray(options.owner)) {
      throw new MerchantProvisioningError(
        'INVALID_OWNER',
        400,
        'Owner options must be an object'
      );
    }
    const loginIdentifier = typeof options.owner.loginIdentifier === 'string'
      ? options.owner.loginIdentifier.trim()
      : '';
    if (!loginIdentifier || loginIdentifier.length > 200) {
      throw new MerchantProvisioningError(
        'INVALID_OWNER_IDENTIFIER',
        400,
        'Owner login identifier must be between 1 and 200 characters'
      );
    }

    const displayName = typeof options.owner.displayName === 'string'
      ? options.owner.displayName.trim()
      : '';
    if (!displayName || displayName.length > 200) {
      throw new MerchantProvisioningError(
        'INVALID_OWNER_DISPLAY_NAME',
        400,
        'Owner display name must be between 1 and 200 characters'
      );
    }

    const password = typeof options.owner.password === 'string' ? options.owner.password : '';
    if (password.length < MIN_PASSWORD_LENGTH) {
      throw new MerchantProvisioningError(
        'PASSWORD_TOO_SHORT',
        400,
        `Owner password must contain at least ${MIN_PASSWORD_LENGTH} characters`
      );
    }
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
      throw new MerchantProvisioningError(
        'PASSWORD_TOO_LONG',
        400,
        `Owner password exceeds maximum length of ${MAX_PASSWORD_BYTES} bytes in UTF-8 encoding`
      );
    }

    owner = {
      loginIdentifier,
      loginIdentifierNormalized: loginIdentifier.toLowerCase(),
      displayName,
      password
    };
  }

  // 7. Settings
  const settings = options.settings && typeof options.settings === 'object' && !Array.isArray(options.settings)
    ? { ...options.settings }
    : {};

  return {
    name,
    slug,
    tenantMode,
    location: {
      name: locationName,
      timezone
    },
    categories,
    owner,
    settings
  };
};

const hasColumn = async (client, tableName, columnName) => {
  const result = await client.query(
    `SELECT 1
     FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = $1
       AND column_name = $2
     LIMIT 1`,
    [tableName, columnName]
  );
  return result.rows.length > 0;
};

const mapProvisioningDatabaseError = (error, validated) => {
  if (error && error.code === '23505') {
    if (
      error.constraint === 'shops_slug_key' ||
      /shops.*slug|slug.*already exists/i.test(error.detail || error.message || '')
    ) {
      return new MerchantProvisioningError(
        'DUPLICATE_SLUG',
        409,
        `Shop with slug "${validated.slug}" already exists`
      );
    }

    if (
      error.constraint === 'owner_accounts_login_identifier_normalized_key' ||
      /owner_accounts.*login_identifier_normalized|login_identifier_normalized.*already exists/i.test(
        error.detail || error.message || ''
      )
    ) {
      return new MerchantProvisioningError(
        'DUPLICATE_OWNER_LOGIN',
        409,
        'Owner login identifier is already in use'
      );
    }
  }

  return error;
};

/**
 * Provisions one merchant on an already-open transaction client.
 * The caller owns BEGIN/COMMIT/ROLLBACK. This is the authoritative primitive
 * used by both the CLI wrapper and invitation consumption so provisioning and
 * invitation consumption can share one atomic transaction.
 */
const provisionMerchantInTransaction = async (
  client,
  rawOptions = {},
  executionOptions = {}
) => {
  if (!client || typeof client.query !== 'function') {
    throw new MerchantProvisioningError(
      'INVALID_DATABASE_CLIENT',
      500,
      'Database client is required'
    );
  }

  const validated = executionOptions.inputValidated === true
    ? rawOptions
    : validateProvisioningInput(rawOptions);

  try {
    // 1. Check duplicate slug
    const existingShop = await client.query(
      `SELECT id FROM public.shops WHERE LOWER(slug) = $1 LIMIT 1 FOR UPDATE`,
      [validated.slug]
    );

    if (existingShop.rows.length > 0) {
      throw new MerchantProvisioningError(
        'DUPLICATE_SLUG',
        409,
        `Shop with slug "${validated.slug}" already exists`
      );
    }

    // 2. Check if shops has tenant_mode column
    const supportsTenantMode = await hasColumn(client, 'shops', 'tenant_mode');

    const shopId = crypto.randomUUID();
    let shopRow;

    if (supportsTenantMode) {
      const shopResult = await client.query(
        `INSERT INTO public.shops (id, slug, name, status, tenant_mode)
         VALUES ($1, $2, $3, 'active', $4)
         RETURNING id, slug, name, status, tenant_mode, created_at`,
        [shopId, validated.slug, validated.name, validated.tenantMode]
      );
      shopRow = shopResult.rows[0];
    } else {
      const shopResult = await client.query(
        `INSERT INTO public.shops (id, slug, name, status)
         VALUES ($1, $2, $3, 'active')
         RETURNING id, slug, name, status, created_at`,
        [shopId, validated.slug, validated.name]
      );
      shopRow = { ...shopResult.rows[0], tenant_mode: validated.tenantMode };
    }

    // 3. Insert Primary Location
    const locationId = crypto.randomUUID();
    const supportsLocationName = await hasColumn(client, 'locations', 'name');
    let locationRow;

    if (supportsLocationName) {
      const locationResult = await client.query(
        `INSERT INTO public.locations (id, shop_id, name, timezone, is_active, created_at)
         VALUES ($1, $2, $3, $4, TRUE, NOW())
         RETURNING id, shop_id, name, timezone, is_active, created_at`,
        [locationId, shopRow.id, validated.location.name, validated.location.timezone]
      );
      locationRow = locationResult.rows[0];
    } else {
      const locationResult = await client.query(
        `INSERT INTO public.locations (id, shop_id, timezone, is_active, created_at)
         VALUES ($1, $2, $3, TRUE, NOW())
         RETURNING id, shop_id, timezone, is_active, created_at`,
        [locationId, shopRow.id, validated.location.timezone]
      );
      locationRow = { ...locationResult.rows[0], name: validated.location.name };
    }

    // 4. Update / ensure shop_customer_settings
    const settings = validated.settings;
    const settingsColumns = [];
    const settingsValues = [shopRow.id];

    const settingFieldMap = {
      countryCode: 'country_code',
      defaultPhoneCountryCode: 'default_phone_country_code',
      publicContactPhone: 'public_contact_phone',
      publicWhatsappPhone: 'public_whatsapp_phone',
      publicAddress: 'public_address',
      publicPostalCode: 'public_postal_code',
      publicBusinessHours: 'public_business_hours',
      publicDisplayName: 'public_display_name',
      currencyCode: 'currency_code',
      defaultLocale: 'default_locale',
      memberCodePrefix: 'member_code_prefix',
      memberCodeWidth: 'member_code_width',
      dobRequirement: 'dob_requirement',
      membershipEnabled: 'membership_enabled',
      pointsEnabled: 'points_enabled',
      storedValueEnabled: 'stored_value_enabled',
      packagesEnabled: 'packages_enabled',
      autoFreeMembership: 'auto_free_membership'
    };

    for (const [prop, col] of Object.entries(settingFieldMap)) {
      if (settings[prop] !== undefined) {
        settingsValues.push(settings[prop]);
        settingsColumns.push(`${col} = $${settingsValues.length}`);
      }
    }

    if (settingsColumns.length > 0) {
      const updateSettingsSql = `
        UPDATE public.shop_customer_settings
        SET ${settingsColumns.join(', ')}, updated_at = NOW()
        WHERE shop_id = $1
      `;
      await client.query(updateSettingsSql, settingsValues);
    }

    // 5. Initial Service Categories and Translations
    const provisionedCategories = [];
    for (const cat of validated.categories) {
      const categoryId = crypto.randomUUID();
      await client.query(
        `INSERT INTO public.service_categories (id, shop_id, canonical_name, icon_key, sort_order, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW(), NOW())`,
        [categoryId, shopRow.id, cat.canonicalName, cat.iconKey, cat.sortOrder, cat.isActive]
      );

      if (cat.nameZh) {
        await client.query(
          `INSERT INTO public.service_category_translations (shop_id, category_id, locale, name, created_at, updated_at)
           VALUES ($1, $2, 'zh-CN', $3, NOW(), NOW())
           ON CONFLICT (shop_id, category_id, locale) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()`,
          [shopRow.id, categoryId, cat.nameZh]
        );
      }

      if (cat.nameEn) {
        await client.query(
          `INSERT INTO public.service_category_translations (shop_id, category_id, locale, name, created_at, updated_at)
           VALUES ($1, $2, 'en', $3, NOW(), NOW())
           ON CONFLICT (shop_id, category_id, locale) DO UPDATE SET name = EXCLUDED.name, updated_at = NOW()`,
          [shopRow.id, categoryId, cat.nameEn]
        );
      }

      provisionedCategories.push({
        id: categoryId,
        canonicalName: cat.canonicalName,
        iconKey: cat.iconKey,
        sortOrder: cat.sortOrder,
        nameZh: cat.nameZh,
        nameEn: cat.nameEn
      });
    }

    // 6. Optional Owner Provisioning
    let ownerSummary = null;
    if (validated.owner) {
      const passwordHash = await bcrypt.hash(
        validated.owner.password,
        BCRYPT_COST
      );
      validated.owner.password = null;

      // Check existing owner account by normalized login identifier
      const existingAccount = await client.query(
        `SELECT id, display_name FROM public.owner_accounts
         WHERE login_identifier_normalized = $1
         LIMIT 1
         FOR UPDATE`,
        [validated.owner.loginIdentifierNormalized]
      );

      let ownerAccountId;

      if (existingAccount.rows.length > 0) {
        if (executionOptions.rejectExistingOwner === true) {
          throw new MerchantProvisioningError(
            'DUPLICATE_OWNER_LOGIN',
            409,
            'Owner login identifier is already in use'
          );
        }
        ownerAccountId = existingAccount.rows[0].id;
      } else {
        const newAccount = await client.query(
          `INSERT INTO public.owner_accounts (
             id, login_identifier, login_identifier_normalized,
             password_hash, display_name, is_active, session_version,
             failed_login_attempts, locked_until, password_changed_at,
             created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5, TRUE, 1, 0, NULL, NOW(), NOW(), NOW()
           ) RETURNING id`,
          [
            crypto.randomUUID(),
            validated.owner.loginIdentifier,
            validated.owner.loginIdentifierNormalized,
            passwordHash,
            validated.owner.displayName
          ]
        );
        ownerAccountId = newAccount.rows[0].id;
      }

      // Check if membership already exists
      const existingMembership = await client.query(
        `SELECT id FROM public.owner_shop_memberships
         WHERE owner_account_id = $1 AND shop_id = $2
         LIMIT 1`,
        [ownerAccountId, shopRow.id]
      );

      let membershipId;
      if (existingMembership.rows.length > 0) {
        membershipId = existingMembership.rows[0].id;
      } else {
        const newMembership = await client.query(
          `INSERT INTO public.owner_shop_memberships (
             id, owner_account_id, shop_id, role, is_active, created_at, updated_at
           ) VALUES ($1, $2, $3, 'owner', TRUE, NOW(), NOW())
           RETURNING id`,
          [crypto.randomUUID(), ownerAccountId, shopRow.id]
        );
        membershipId = newMembership.rows[0].id;
      }

      ownerSummary = {
        accountId: ownerAccountId,
        membershipId,
        loginIdentifier: validated.owner.loginIdentifier,
        displayName: validated.owner.displayName,
        role: 'owner'
      };
    }

    return {
      success: true,
      shop: {
        id: shopRow.id,
        slug: shopRow.slug,
        name: shopRow.name,
        status: shopRow.status,
        tenantMode: shopRow.tenant_mode || validated.tenantMode,
        createdAt: shopRow.created_at
      },
      location: {
        id: locationRow.id,
        shopId: shopRow.id,
        name: locationRow.name,
        timezone: locationRow.timezone,
        isActive: locationRow.is_active
      },
      categories: provisionedCategories,
      owner: ownerSummary
    };
  } catch (error) {
    throw mapProvisioningDatabaseError(error, validated);
  }
};

const provisionMerchant = async (dbOrPool, rawOptions = {}) => {
  const validated = validateProvisioningInput(rawOptions);

  let client;
  let shouldRelease = false;

  if (typeof dbOrPool.connect === 'function') {
    try {
      client = await dbOrPool.connect();
      shouldRelease = typeof client.release === 'function';
    } catch (err) {
      if (/already been connected/i.test(err.message)) {
        client = dbOrPool;
        shouldRelease = false;
      } else {
        throw err;
      }
    }
  } else {
    client = dbOrPool;
  }

  let transactionActive = false;

  try {
    await client.query('BEGIN');
    transactionActive = true;
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query("SET LOCAL statement_timeout = '30s'");

    const result = await provisionMerchantInTransaction(
      client,
      validated,
      { inputValidated: true }
    );

    await client.query('COMMIT');
    transactionActive = false;
    return result;
  } catch (error) {
    if (transactionActive && client) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {}
    }
    throw error;
  } finally {
    if (shouldRelease && client) client.release();
  }
};

module.exports = {
  MerchantProvisioningError,
  normalizeSlug,
  isValidTimezone,
  validateProvisioningInput,
  provisionMerchantInTransaction,
  provisionMerchant
};
