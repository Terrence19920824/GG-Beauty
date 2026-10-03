'use strict';

const SHOP_SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const CLIENT_TENANT_FIELDS = Object.freeze([
  'shopId',
  'shop_id',
  'shopSlug',
  'shop_slug',
  'tenantId',
  'tenant_id'
]);

const READINESS_CHECK_DEFINITIONS = Object.freeze([
  { key: 'business_profile', blocking: true },
  { key: 'active_location', blocking: true },
  { key: 'business_timezone', blocking: true },
  { key: 'active_service', blocking: true },
  { key: 'active_staff', blocking: true },
  { key: 'staff_location_assignment', blocking: true },
  { key: 'bookable_capability', blocking: true },
  { key: 'working_schedule', blocking: true },
  { key: 'owner_membership', blocking: true },
  { key: 'booking_url', blocking: true },
  { key: 'booking_qr', blocking: true }
]);

class PublicBaseUrlError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PublicBaseUrlError';
    this.code = 'PUBLIC_BASE_URL_UNAVAILABLE';
  }
}

const isLoopbackHostname = hostname => [
  'localhost',
  '127.0.0.1',
  '[::1]'
].includes(hostname);

const normalizePublicBaseUrl = rawValue => {
  if (typeof rawValue !== 'string' || !rawValue.trim()) {
    throw new PublicBaseUrlError('PUBLIC_BASE_URL is not configured');
  }

  const candidate = rawValue.trim();
  if (candidate.length > 2048) {
    throw new PublicBaseUrlError('PUBLIC_BASE_URL is invalid');
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch (_error) {
    throw new PublicBaseUrlError('PUBLIC_BASE_URL is invalid');
  }

  const secure = parsed.protocol === 'https:';
  const localDevelopment = parsed.protocol === 'http:' &&
    isLoopbackHostname(parsed.hostname.toLowerCase());
  if (!secure && !localDevelopment) {
    throw new PublicBaseUrlError('PUBLIC_BASE_URL must use HTTPS');
  }
  if (
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.pathname && parsed.pathname !== '/')
  ) {
    throw new PublicBaseUrlError('PUBLIC_BASE_URL must be an origin');
  }

  return parsed.origin;
};

const normalizeShopSlug = rawValue => {
  const slug = typeof rawValue === 'string'
    ? rawValue.trim().toLowerCase()
    : '';
  if (!slug || slug.length > 100 || !SHOP_SLUG_PATTERN.test(slug)) {
    throw new PublicBaseUrlError('Authoritative shop slug is invalid');
  }
  return slug;
};

const buildCanonicalBookingUrl = (publicBaseUrl, shopSlug) => {
  const origin = normalizePublicBaseUrl(publicBaseUrl);
  const slug = normalizeShopSlug(shopSlug);
  return `${origin}/book/${encodeURIComponent(slug)}`;
};

const containsClientTenantAuthority = request => {
  const sources = [request && request.query, request && request.body];
  return sources.some(source => source && typeof source === 'object' &&
    CLIENT_TENANT_FIELDS.some(field => Object.prototype.hasOwnProperty.call(source, field)));
};

const READINESS_SQL = `
  SELECT
    shop.slug AS shop_slug,
    shop.status AS shop_status,
    (
      NULLIF(BTRIM(shop.name), '') IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM shop_customer_settings AS settings
        WHERE settings.shop_id = shop.id
      )
    ) AS business_profile,
    EXISTS (
      SELECT 1
      FROM locations AS location
      WHERE location.shop_id = shop.id
        AND location.is_active = TRUE
    ) AS active_location,
    EXISTS (
      SELECT 1
      FROM locations AS location
      WHERE location.shop_id = shop.id
        AND location.is_active = TRUE
        AND NULLIF(BTRIM(location.timezone), '') IS NOT NULL
    ) AS business_timezone,
    EXISTS (
      SELECT 1
      FROM services AS service
      JOIN service_categories AS category
        ON category.shop_id = service.shop_id
       AND category.id = service.category_id
       AND category.is_active = TRUE
      WHERE service.shop_id = shop.id
        AND service.is_active = TRUE
        AND service.bookable = TRUE
    ) AS active_service,
    EXISTS (
      SELECT 1
      FROM staff AS member
      WHERE member.shop_id = shop.id
        AND member.is_active = TRUE
    ) AS active_staff,
    EXISTS (
      SELECT 1
      FROM staff_location_assignments AS assignment
      JOIN staff AS member
        ON member.shop_id = assignment.shop_id
       AND member.id = assignment.staff_id
       AND member.is_active = TRUE
       AND member.bookable = TRUE
      JOIN locations AS location
        ON location.shop_id = assignment.shop_id
       AND location.id = assignment.location_id
       AND location.is_active = TRUE
      WHERE assignment.shop_id = shop.id
        AND assignment.is_active = TRUE
    ) AS staff_location_assignment,
    EXISTS (
      SELECT 1
      FROM staff_services AS capability
      JOIN staff AS member
        ON member.shop_id = capability.shop_id
       AND member.id = capability.staff_id
       AND member.is_active = TRUE
       AND member.bookable = TRUE
      JOIN services AS service
        ON service.shop_id = capability.shop_id
       AND service.id = capability.service_id
       AND service.is_active = TRUE
       AND service.bookable = TRUE
      JOIN service_categories AS category
        ON category.shop_id = service.shop_id
       AND category.id = service.category_id
       AND category.is_active = TRUE
      WHERE capability.shop_id = shop.id
        AND capability.is_active = TRUE
    ) AS bookable_capability,
    EXISTS (
      SELECT 1
      FROM staff_location_working_hours AS hours
      JOIN staff_location_assignments AS assignment
        ON assignment.shop_id = hours.shop_id
       AND assignment.location_id = hours.location_id
       AND assignment.staff_id = hours.staff_id
       AND assignment.is_active = TRUE
      JOIN locations AS location
        ON location.shop_id = hours.shop_id
       AND location.id = hours.location_id
       AND location.is_active = TRUE
      JOIN staff AS member
        ON member.shop_id = hours.shop_id
       AND member.id = hours.staff_id
       AND member.is_active = TRUE
       AND member.bookable = TRUE
      JOIN staff_services AS capability
        ON capability.shop_id = member.shop_id
       AND capability.staff_id = member.id
       AND capability.is_active = TRUE
      JOIN services AS service
        ON service.shop_id = capability.shop_id
       AND service.id = capability.service_id
       AND service.is_active = TRUE
       AND service.bookable = TRUE
      JOIN service_categories AS category
        ON category.shop_id = service.shop_id
       AND category.id = service.category_id
       AND category.is_active = TRUE
      WHERE hours.shop_id = shop.id
        AND hours.is_active = TRUE
        AND hours.start_time < hours.end_time
        AND (
          hours.effective_from IS NULL
          OR hours.effective_from <= (CURRENT_TIMESTAMP AT TIME ZONE location.timezone)::DATE
        )
        AND (
          hours.effective_to IS NULL
          OR hours.effective_to >= (CURRENT_TIMESTAMP AT TIME ZONE location.timezone)::DATE
        )
    ) AS working_schedule,
    EXISTS (
      SELECT 1
      FROM owner_shop_memberships AS membership
      JOIN owner_accounts AS account
        ON account.id = membership.owner_account_id
       AND account.is_active = TRUE
      WHERE membership.shop_id = shop.id
        AND membership.role = 'owner'
        AND membership.is_active = TRUE
    ) AS owner_membership
  FROM shops AS shop
  WHERE shop.id = $1
  LIMIT 1
`;

const snapshotValue = (snapshot, key) => snapshot && snapshot[key] === true;

const createMerchantLaunchReadiness = ({
  pool,
  getPublicBaseUrl,
  qrCode,
  safeErrorCode = error => error && error.code || 'unknown_error'
}) => {
  if (!pool || typeof pool.query !== 'function') {
    throw new TypeError('pool.query is required');
  }
  if (typeof getPublicBaseUrl !== 'function') {
    throw new TypeError('getPublicBaseUrl is required');
  }
  if (!qrCode || typeof qrCode.toString !== 'function') {
    throw new TypeError('qrCode.toString is required');
  }

  const rejectTenantInput = (request, response) => {
    if (!containsClientTenantAuthority(request)) return false;
    response.status(400).json({
      success: false,
      code: 'INVALID_TENANT_CONTEXT'
    });
    return true;
  };

  const loadSnapshot = async shopId => {
    const result = await pool.query(READINESS_SQL, [shopId]);
    return result.rows[0] || null;
  };

  const resolveBooking = shopSlug => {
    const path = `/book/${encodeURIComponent(normalizeShopSlug(shopSlug))}`;
    try {
      return {
        path,
        url: buildCanonicalBookingUrl(getPublicBaseUrl(), shopSlug),
        trustedPublicBaseUrlConfigured: true
      };
    } catch (error) {
      if (!(error instanceof PublicBaseUrlError)) throw error;
      return {
        path,
        url: null,
        trustedPublicBaseUrlConfigured: false
      };
    }
  };

  const getReadiness = async (request, response) => {
    if (rejectTenantInput(request, response)) return response;

    try {
      const snapshot = await loadSnapshot(request.ownerAuth.shopId);
      if (!snapshot) {
        return response.status(404).json({
          success: false,
          code: 'SHOP_NOT_FOUND'
        });
      }

      const booking = resolveBooking(snapshot.shop_slug);
      const publicContextResolves = snapshot.shop_status === 'active' &&
        snapshotValue(snapshot, 'active_location') &&
        booking.url !== null;
      const qrAvailable = booking.url !== null;
      const values = {
        ...snapshot,
        booking_url: publicContextResolves,
        booking_qr: qrAvailable
      };
      const checks = READINESS_CHECK_DEFINITIONS.map(definition => ({
        key: definition.key,
        status: snapshotValue(values, definition.key) ? 'complete' : 'incomplete',
        blocking: definition.blocking
      }));
      const ready = checks
        .filter(check => check.blocking)
        .every(check => check.status === 'complete');

      response.setHeader('Cache-Control', 'no-store');
      return response.json({
        success: true,
        data: {
          ready,
          checks,
          booking: {
            shopSlug: snapshot.shop_slug,
            path: booking.path,
            url: booking.url,
            trustedPublicBaseUrlConfigured: booking.trustedPublicBaseUrlConfigured,
            qrAvailable,
            qrPath: qrAvailable ? '/api/owner/launch/booking-qr.svg' : null
          }
        }
      });
    } catch (error) {
      console.error('Merchant launch readiness error:', safeErrorCode(error));
      return response.status(500).json({
        success: false,
        code: 'READINESS_UNAVAILABLE'
      });
    }
  };

  const getBookingQr = async (request, response) => {
    if (rejectTenantInput(request, response)) return response;

    let bookingUrl;
    try {
      bookingUrl = buildCanonicalBookingUrl(
        getPublicBaseUrl(),
        request.ownerAuth.shopSlug
      );
    } catch (error) {
      if (error instanceof PublicBaseUrlError) {
        return response.status(503).json({
          success: false,
          code: error.code
        });
      }
      throw error;
    }

    try {
      const svg = await qrCode.toString(bookingUrl, {
        type: 'svg',
        errorCorrectionLevel: 'H',
        margin: 4,
        width: 1024,
        color: {
          dark: '#111111ff',
          light: '#ffffffff'
        }
      });
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', 'image/svg+xml; charset=utf-8');
      response.setHeader('Content-Disposition', `inline; filename="${normalizeShopSlug(request.ownerAuth.shopSlug)}-booking-qr.svg"`);
      response.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
      response.setHeader('X-Content-Type-Options', 'nosniff');
      return response.send(svg);
    } catch (error) {
      console.error('Merchant booking QR error:', safeErrorCode(error));
      return response.status(500).json({
        success: false,
        code: 'QR_GENERATION_FAILED'
      });
    }
  };

  return {
    getReadiness,
    getBookingQr,
    loadSnapshot
  };
};

module.exports = {
  CLIENT_TENANT_FIELDS,
  PublicBaseUrlError,
  READINESS_CHECK_DEFINITIONS,
  READINESS_SQL,
  buildCanonicalBookingUrl,
  containsClientTenantAuthority,
  createMerchantLaunchReadiness,
  normalizePublicBaseUrl,
  normalizeShopSlug
};
