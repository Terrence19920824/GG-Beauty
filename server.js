// ==================================================
// GG-Beauty 美容养生预约系统 - 后端服务器
// ==================================================

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');
const {
  AppointmentMutationError,
  runInTransaction,
  createSingleServiceCompatibilityRows,
  createMultiServiceRows,
  loadAndValidatePhaseAStructure,
  moveAppointmentStructurePrecisely,
  syncAppointmentItemStatus
} = require('./lib/appointment-multi-service');
const {
  MultiServicePlanningError,
  normalizeBookingItems,
  buildSequentialTimeline,
  planStaffAssignments
} = require('./lib/customer-multi-service-booking');
const {
  computeBatchAvailability
} = require('./lib/customer-batch-availability');
const {
  StaffBookabilityError,
  validateStaffBookability
} = require('./lib/staff-bookability-validator');
const {
  createOwnerAuth
} = require('./lib/owner-auth');
const {
  createOwnerStaffManagement
} = require('./lib/owner-staff-management');
const {
  createOwnerStaffCapabilityManagement
} = require('./lib/owner-staff-capability-management');
const {
  createOwnerScheduleManagement
} = require('./lib/owner-schedule-management');
const { createOwnerServiceCategoryManagement } = require('./lib/owner-service-category-management');
const {
  normalizeLocale
} = require('./public/service-locale');
const {
  CustomerIdentityError,
  resolveBookingParties
} = require('./lib/customer-identity');
const {
  COOKIE: CUSTOMER_SESSION_COOKIE,
  CustomerMemberError,
  createCustomerMemberIdentity
} = require('./lib/customer-member-identity');
const { isKnownStatus, canTransition, recordStatusHistory } = require('./lib/appointment-status');
const { createCheckoutPos } = require('./lib/checkout-pos');
const { createCheckoutPosRead } = require('./lib/checkout-pos-read');
const {
  projectOwnerAppointmentCheckout
} = require('./lib/owner-appointment-checkout-projection');
const { validateSettings: validateMerchantContactSettings, publicPresentation: merchantContactPresentation } = require('./lib/merchant-contact');
const {
  checkRateLimit,
  normalizeCustomerQueryPhone,
  queryCustomerBookings
} = require('./lib/customer-booking-query');
const {
  createOwnerAppointmentEdit
} = require('./lib/owner-appointment-edit');

const app = express();
const OWNER_MERCHANT_CONTACT_READ_ROLES = Object.freeze(['owner', 'manager', 'admin']);
const OWNER_MERCHANT_CONTACT_WRITE_ROLES = Object.freeze(['owner', 'manager', 'admin']);
const OWNER_APPOINTMENT_INTERNAL_NOTES_WRITE_ROLES = Object.freeze(['owner', 'manager']);
const OWNER_APPOINTMENT_INTERNAL_NOTES_MAX_LENGTH = 4000;
const OWNER_CUSTOMER_PROFILE_NOTES_WRITE_ROLES = Object.freeze(['owner', 'manager']);
const OWNER_CUSTOMER_PROFILE_NOTES_READ_ROLES = Object.freeze(['owner', 'manager', 'admin', 'front_desk']);
const OWNER_CUSTOMER_PROFILE_NOTES_MAX_LENGTH = 4000;

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// Server-owned dependencies. Client input can never replace these trusted
// objects; tests may inject isolated doubles without opening a real database.
app.locals.bookingPool = pool;
app.locals.bookingValidator = validateStaffBookability;
app.locals.ownerAuthPool = pool;
app.locals.customerOtpProvider = null;

// ==================================================
// 中间件
// ==================================================

app.use(express.json());
app.get('/manifest.webmanifest', (req, res) => {
  const shopSlug = typeof req.query.shop === 'string' ? req.query.shop.trim().toLowerCase() : '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(shopSlug) || shopSlug.length > 100) {
    return res.status(400).json({ success: false, code: 'INVALID_SHOP_CONTEXT' });
  }
  res.set({ 'Cache-Control': 'no-store, no-cache, must-revalidate, private', Pragma: 'no-cache', Expires: '0', 'Content-Type': 'application/manifest+json' });
  return res.json({ name: 'GG-Beauty Booking', short_name: 'GG-Beauty', start_url: `/book/${encodeURIComponent(shopSlug)}?pwa=1`, scope: '/', display: 'standalone', background_color: '#f6f6f6', theme_color: '#111111', icons: [{ src: '/icons/gg-default.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }] });
});
app.get('/book/:shopSlug', (req, res) => {
  const shopSlug = typeof req.params.shopSlug === 'string' ? req.params.shopSlug.trim().toLowerCase() : '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(shopSlug) || shopSlug.length > 100) return res.status(404).end();
  return res.sendFile(path.join(__dirname, 'public', 'index.html'));
});
app.use(express.static('public'));

const customerMemberIdentity = createCustomerMemberIdentity({
  pool,
  getProvider: () => app.locals.customerOtpProvider
});

const customerCookie = request => {
  const header=request.headers.cookie||'';
  for (const part of header.split(';')) {
    const [name,...rest]=part.trim().split('=');
    if (name===CUSTOMER_SESSION_COOKIE) {
      try { return decodeURIComponent(rest.join('=')); } catch (_) { return ''; }
    }
  }
  return '';
};
const customerCookieOptions = maxAge => `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${process.env.NODE_ENV==='production'?'; Secure':''}`;
const customerIdentityError = (res,error) => {
  const status=error instanceof CustomerMemberError?error.status:500;
  const code=error instanceof CustomerMemberError?error.code:'CUSTOMER_IDENTITY_FAILED';
  return res.status(status).json({success:false,code});
};
const rejectCustomerAuthority = body => ['shopId','shop_id','customerId','customer_id'].some(key=>body?.[key]!==undefined);

app.get('/api/customer/member/config',async(req,res)=>{
  if(rejectCustomerAuthority(req.query)) return res.status(400).json({success:false,code:'INVALID_IDENTITY_CONTEXT'});
  try { const data=await customerMemberIdentity.getPublicConfig(req.query.shopSlug); return res.json({success:true,data}); }
  catch(error){ return customerIdentityError(res,error); }
});

app.post('/api/customer/auth/otp/request',async(req,res)=>{
  if(rejectCustomerAuthority(req.body)) return res.status(400).json({success:false,code:'INVALID_IDENTITY_CONTEXT'});
  try { const data=await customerMemberIdentity.requestOtp({shopSlug:req.body.shopSlug,countryCode:req.body.countryCode,
    phone:req.body.phone,purpose:'sign_in',ip:req.ip,userAgent:req.headers['user-agent']}); return res.json({success:true,data}); }
  catch(error){ return customerIdentityError(res,error); }
});
app.post('/api/customer/auth/otp/verify',async(req,res)=>{
  if(rejectCustomerAuthority(req.body)) return res.status(400).json({success:false,code:'INVALID_IDENTITY_CONTEXT'});
  try { const data=await customerMemberIdentity.verifySignIn({challengeId:req.body.challengeId,code:req.body.code,name:req.body.name,email:req.body.email,
    dateOfBirth:req.body.dateOfBirth,gender:req.body.gender});
    res.setHeader('Set-Cookie',`${CUSTOMER_SESSION_COOKIE}=${encodeURIComponent(data.token)}; ${customerCookieOptions(30*24*60*60)}`);
    return res.json({success:true,data:{customerId:data.customerId}}); }
  catch(error){ return customerIdentityError(res,error); }
});
app.get('/api/customer/me',async(req,res)=>{
  try { const data=await customerMemberIdentity.authenticate(customerCookie(req)); return res.json({success:true,data}); }
  catch(error){ return customerIdentityError(res,error); }
});
app.patch('/api/customer/me',async(req,res)=>{
  if(rejectCustomerAuthority(req.body)) return res.status(400).json({success:false,code:'INVALID_IDENTITY_CONTEXT'});
  try { const session=await customerMemberIdentity.authenticate(customerCookie(req));
    await customerMemberIdentity.updateProfile({session,name:req.body.name,email:req.body.email,dateOfBirth:req.body.dateOfBirth,gender:req.body.gender});
    const data=await customerMemberIdentity.authenticate(customerCookie(req)); return res.json({success:true,data}); }
  catch(error){ return customerIdentityError(res,error); }
});
app.post('/api/customer/phone-change/request',async(req,res)=>{
  if(rejectCustomerAuthority(req.body)) return res.status(400).json({success:false,code:'INVALID_IDENTITY_CONTEXT'});
  try { const session=await customerMemberIdentity.authenticate(customerCookie(req));
    const data=await customerMemberIdentity.requestOtp({shopSlug:session.shop_slug,countryCode:req.body.countryCode,phone:req.body.phone,
      purpose:'phone_change',customerId:session.customer_id,ip:req.ip,userAgent:req.headers['user-agent']}); return res.json({success:true,data}); }
  catch(error){ return customerIdentityError(res,error); }
});
app.post('/api/customer/phone-change/confirm',async(req,res)=>{
  if(rejectCustomerAuthority(req.body)) return res.status(400).json({success:false,code:'INVALID_IDENTITY_CONTEXT'});
  try { const session=await customerMemberIdentity.authenticate(customerCookie(req));
    await customerMemberIdentity.confirmPhoneChange({session,challengeId:req.body.challengeId,code:req.body.code}); return res.json({success:true}); }
  catch(error){ return customerIdentityError(res,error); }
});
app.post('/api/customer/logout',async(req,res)=>{
  const token=customerCookie(req); if(token) await pool.query('UPDATE customer_sessions SET revoked_at=NOW() WHERE token_hash=$1',[require('./lib/customer-member-identity').tokenHash(token)]);
  res.setHeader('Set-Cookie',`${CUSTOMER_SESSION_COOKIE}=; ${customerCookieOptions(0)}`); return res.json({success:true});
});


// ==================================================
// 员工认证工具
// ==================================================

const STAFF_SESSION_COOKIE =
  'gg_beauty_staff_session';

const STAFF_SESSION_MAX_AGE_MS =
  12 * 60 * 60 * 1000;

const STAFF_LOGIN_RATE_LIMIT_WINDOW_MS =
  15 * 60 * 1000;

const STAFF_LOGIN_RATE_LIMIT_MAX_REQUESTS =
  10;

const STAFF_LOGIN_RATE_LIMIT_MAX_KEYS =
  10000;

const STAFF_LOGIN_LOCK_THRESHOLD = 5;

const staffLoginRateLimits = new Map();

const STAFF_PERMISSION_NAMES = [
  'can_view_customer_history',
  'can_view_service_notes',
  'can_view_own_sales',
  'can_view_own_commission',
  'can_view_full_customer_phone',
  'can_move_own_appointments',
  'can_update_own_appointment_status'
];

const DUMMY_STAFF_PASSWORD_HASH =
  bcrypt.hashSync(
    'invalid-staff-login-password',
    12
  );

const normalizeLoginIdentifier = value =>
  typeof value === 'string'
    ? value.trim().toLowerCase()
    : '';

const setStaffAuthNoStore = response => {
  response.setHeader(
    'Cache-Control',
    'no-store'
  );
};

const safeStaffAuthErrorCode = error =>
  error && typeof error.code === 'string'
    ? error.code
    : 'unknown_error';

const isUuid = value =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    value
  );

const parseStrictIsoInstant = value => {
  if (typeof value !== 'string') {
    return null;
  }

  const match = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/
  );

  if (!match) {
    return null;
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const offsetHour = match[10]
    ? Number(match[10])
    : 0;
  const offsetMinute = match[11]
    ? Number(match[11])
    : 0;

  const calendarDate = new Date(
    Date.UTC(year, month - 1, day)
  );

  if (
    year < 1000 ||
    calendarDate.getUTCFullYear() !== year ||
    calendarDate.getUTCMonth() !== month - 1 ||
    calendarDate.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 14 ||
    offsetMinute > 59 ||
    (offsetHour === 14 && offsetMinute !== 0)
  ) {
    return null;
  }

  const parsed = new Date(value);

  return Number.isNaN(parsed.getTime())
    ? null
    : parsed;
};

const isSameOriginRequest = request => {
  const originHeader = request.headers.origin;
  const hostHeader = request.headers.host;

  if (
    typeof originHeader !== 'string' ||
    typeof hostHeader !== 'string' ||
    hostHeader.length === 0
  ) {
    return false;
  }

  try {
    const originUrl = new URL(originHeader);

    if (
      originUrl.origin !== originHeader ||
      !['http:', 'https:'].includes(
        originUrl.protocol
      )
    ) {
      return false;
    }

    const requestHostUrl = new URL(
      `${originUrl.protocol}//${hostHeader}`
    );

    if (
      requestHostUrl.username ||
      requestHostUrl.password ||
      requestHostUrl.pathname !== '/' ||
      requestHostUrl.search ||
      requestHostUrl.hash ||
      requestHostUrl.host !== originUrl.host
    ) {
      return false;
    }

    const hostname = originUrl.hostname
      .toLowerCase();
    const isLocalHost = [
      'localhost',
      '127.0.0.1',
      '[::1]'
    ].includes(hostname);

    return isLocalHost ||
      originUrl.protocol === 'https:';
  } catch (_error) {
    return false;
  }
};

const staffLoginRateLimitKey = (
  shopIdentifier,
  username
) =>
  crypto
    .createHash('sha256')
    .update(`${shopIdentifier}\u0000${username}`)
    .digest('hex');

// Phase 1 uses a process-local first layer of protection. A multi-instance
// deployment must replace this with a shared Redis, database, or gateway-level
// rate limiter so every instance observes the same request window.
const consumeStaffLoginAttempt = key => {
  const now = Date.now();

  if (
    staffLoginRateLimits.size >=
    STAFF_LOGIN_RATE_LIMIT_MAX_KEYS
  ) {
    for (const [storedKey, storedEntry]
      of staffLoginRateLimits) {
      if (storedEntry.windowEndsAt <= now) {
        staffLoginRateLimits.delete(storedKey);
      }
    }

    if (
      staffLoginRateLimits.size >=
      STAFF_LOGIN_RATE_LIMIT_MAX_KEYS
    ) {
      const oldestKey =
        staffLoginRateLimits.keys().next().value;

      staffLoginRateLimits.delete(oldestKey);
    }
  }

  let entry = staffLoginRateLimits.get(key);

  if (!entry || entry.windowEndsAt <= now) {
    entry = {
      requestCount: 0,
      windowEndsAt:
        now + STAFF_LOGIN_RATE_LIMIT_WINDOW_MS
    };
  }

  if (
    entry.requestCount >=
    STAFF_LOGIN_RATE_LIMIT_MAX_REQUESTS
  ) {
    staffLoginRateLimits.set(key, entry);
    return false;
  }

  entry.requestCount += 1;
  staffLoginRateLimits.set(key, entry);

  return true;
};

const clearStaffLoginRateLimit = key => {
  staffLoginRateLimits.delete(key);
};

const rollbackStaffLogin = async client => {
  if (!client) {
    return;
  }

  try {
    await client.query('ROLLBACK');
  } catch (_rollbackError) {
    console.error(
      'Staff login rollback failed'
    );
  }
};

const rollbackStaffAppointmentMove = async client => {
  if (!client) {
    return false;
  }

  try {
    await client.query('ROLLBACK');
    return true;
  } catch (_rollbackError) {
    console.error(
      'Staff appointment move rollback failed'
    );
    return false;
  }
};

const parseCookies = request => {
  const cookies = {};
  const cookieHeader =
    request.headers.cookie || '';

  cookieHeader.split(';').forEach(part => {
    const separatorIndex =
      part.indexOf('=');

    if (separatorIndex < 0) {
      return;
    }

    const name =
      part.slice(0, separatorIndex).trim();

    if (!name) {
      return;
    }

    const encodedValue =
      part.slice(separatorIndex + 1).trim();

    try {
      cookies[name] =
        decodeURIComponent(encodedValue);
    } catch (_error) {
      cookies[name] = '';
    }
  });

  return cookies;
};

const hashStaffSessionToken = token =>
  crypto
    .createHash('sha256')
    .update(token)
    .digest('hex');

const staffSessionCookieOptions = () => [
  'Path=/',
  'HttpOnly',
  'SameSite=Lax',
  `Max-Age=${Math.floor(
    STAFF_SESSION_MAX_AGE_MS / 1000
  )}`,
  // Render production must explicitly set NODE_ENV=production so staff
  // session cookies are never sent over an insecure connection.
  ...(process.env.NODE_ENV === 'production'
    ? ['Secure']
    : [])
];

const setStaffSessionCookie = (
  response,
  token
) => {
  response.setHeader(
    'Set-Cookie',
    `${STAFF_SESSION_COOKIE}=${encodeURIComponent(token)}; ${staffSessionCookieOptions().join('; ')}`
  );
};

const clearStaffSessionCookie = response => {
  const options = [
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
    ...(process.env.NODE_ENV === 'production'
      ? ['Secure']
      : [])
  ];

  response.setHeader(
    'Set-Cookie',
    `${STAFF_SESSION_COOKIE}=; ${options.join('; ')}`
  );
};

const permissionsFromRow = row =>
  STAFF_PERMISSION_NAMES.reduce(
    (permissions, permissionName) => {
      permissions[permissionName] =
        row[permissionName] === true;
      return permissions;
    },
    {}
  );

const requireStaffAuth = async (
  req,
  res,
  next
) => {
  setStaffAuthNoStore(res);

  const token =
    parseCookies(req)[STAFF_SESSION_COOKIE];

  if (!token) {
    return res.status(401).json({
      success: false,
      message: '请先登录员工账号'
    });
  }

  const tokenHash =
    hashStaffSessionToken(token);

  try {
    const result = await req.app.locals.bookingPool.query(
      `
      SELECT
        ss.staff_account_id,
        ss.shop_id,
        ss.staff_id,
        ss.location_id,
        sp.can_view_customer_history,
        sp.can_view_service_notes,
        sp.can_view_own_sales,
        sp.can_view_own_commission,
        sp.can_view_full_customer_phone,
        sp.can_move_own_appointments,
        sp.can_update_own_appointment_status
      FROM staff_sessions ss
      JOIN staff_accounts sa
        ON sa.id = ss.staff_account_id
       AND sa.shop_id = ss.shop_id
       AND sa.staff_id = ss.staff_id
      JOIN staff st
        ON st.id = ss.staff_id
       AND st.shop_id = ss.shop_id
      JOIN shops sh
        ON sh.id = ss.shop_id
      JOIN staff_location_assignments sla
        ON sla.shop_id = ss.shop_id
       AND sla.staff_id = ss.staff_id
       AND sla.location_id = ss.location_id
      JOIN locations l
        ON l.id = ss.location_id
       AND l.shop_id = ss.shop_id
      LEFT JOIN staff_permissions sp
        ON sp.shop_id = ss.shop_id
       AND sp.staff_account_id = ss.staff_account_id
      WHERE ss.token_hash = $1
        AND ss.revoked_at IS NULL
        AND ss.expires_at > NOW()
        AND ss.session_version = sa.session_version
        AND sa.status = 'active'
        AND sh.status = 'active'
        AND st.can_login = TRUE
        AND st.is_active = TRUE
        AND sla.is_active = TRUE
        AND l.is_active = TRUE
      LIMIT 1
      `,
      [tokenHash]
    );

    if (result.rows.length === 0) {
      clearStaffSessionCookie(res);

      return res.status(401).json({
        success: false,
        message: '员工登录已失效，请重新登录'
      });
    }

    const row = result.rows[0];

    req.staffAuth = {
      accountId: row.staff_account_id,
      shopId: row.shop_id,
      staffId: row.staff_id,
      locationId: row.location_id,
      permissions: permissionsFromRow(row)
    };

    next();
  } catch (error) {
    console.error(
      'Staff authentication error:',
      safeStaffAuthErrorCode(error)
    );

    res.status(500).json({
      success: false,
      message: '员工认证暂时不可用'
    });
  }
};

const {
  login: ownerLogin,
  logout: ownerLogout,
  me: ownerMe,
  requireOwnerAuth
} = createOwnerAuth({
  pool: {
    query: (...args) =>
      app.locals.ownerAuthPool.query(...args),
    connect: (...args) =>
      app.locals.ownerAuthPool.connect(...args)
  },
  bcrypt,
  crypto,
  isSameOriginRequest,
  safeErrorCode: safeStaffAuthErrorCode
});

app.post('/api/owner/login', ownerLogin);
app.get('/api/owner/me', requireOwnerAuth, ownerMe);
app.post('/api/owner/logout', ownerLogout);

const requireOwnerRole = allowedRoles =>
  (req, res, next) => {
    if (
      !req.ownerAuth ||
      !allowedRoles.includes(req.ownerAuth.role)
    ) {
      return res.status(403).json({
        success: false,
        message: '无权访问此资源'
      });
    }

    next();
  };

// Checkout writes are independently gated on the server. The browser feature
// flag is presentation-only and must never authorize a financial mutation.
const requireCheckoutWriteEnabled = (req, res, next) => {
  if (process.env.CHECKOUT_WRITE_ENABLED !== 'true') {
    return res.status(503).json({
      success: false,
      code: 'CHECKOUT_WRITE_DISABLED'
    });
  }

  next();
};

// Checkout is an owner/manager-only financial operation.  The handler derives
// the appointment/customer scope from the authenticated shop; UI-supplied IDs
// can never choose a tenant or an existing checkout.
const checkoutPos = createCheckoutPos({
  pool: { connect: (...args) => app.locals.ownerAuthPool.connect(...args) }
});
const checkoutPosRead = createCheckoutPosRead({
  pool: { connect: (...args) => app.locals.ownerAuthPool.connect(...args) }
});
app.get(
  '/api/owner/appointments/:appointmentId/checkout-session',
  requireOwnerAuth,
  requireOwnerRole(['owner', 'manager']),
  checkoutPosRead.getSession
);
app.post(
  '/api/owner/appointments/:appointmentId/checkout',
  requireOwnerAuth,
  requireOwnerRole(['owner', 'manager']),
  requireCheckoutWriteEnabled,
  checkoutPos.create
);

const ownerAppointmentEdit = createOwnerAppointmentEdit({
  pool: { connect: (...args) => app.locals.ownerAuthPool.connect(...args) },
  isUuid,
  runInTransaction,
  safeErrorCode: safeStaffAuthErrorCode
});

app.patch(
  '/api/owner/appointments/:appointmentId/adjust',
  requireOwnerAuth,
  requireOwnerRole(['owner', 'manager', 'admin', 'front_desk']),
  ownerAppointmentEdit.adjustAppointment
);

app.patch('/api/owner/appointments/:appointmentId/internal-notes', requireOwnerAuth, requireOwnerRole(OWNER_APPOINTMENT_INTERNAL_NOTES_WRITE_ROLES), async (req, res) => {
  const appointmentId = typeof req.params.appointmentId === 'string' ? req.params.appointmentId.trim() : '';
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!isUuid(appointmentId)) return res.status(400).json({ success: false, code: 'INVALID_APPOINTMENT_ID', message: '预约ID不正确' });
  if (!body || !Object.prototype.hasOwnProperty.call(body, 'internalNotes') || typeof body.internalNotes !== 'string') return res.status(400).json({ success: false, code: 'INVALID_INTERNAL_NOTES', message: '内部备注格式不正确' });
  const internalNotes = body.internalNotes.trim();
  if (internalNotes.length > OWNER_APPOINTMENT_INTERNAL_NOTES_MAX_LENGTH) return res.status(400).json({ success: false, code: 'INTERNAL_NOTES_TOO_LONG', message: '内部备注不能超过4000个字符' });
  try {
    const result = await app.locals.ownerAuthPool.query(`UPDATE appointments SET internal_notes = $1, updated_at = NOW() WHERE id = $2 AND shop_id = $3 RETURNING id, internal_notes, updated_at`, [internalNotes || null, appointmentId, req.ownerAuth.shopId]);
    if (result.rows.length !== 1) return res.status(404).json({ success: false, code: 'APPOINTMENT_NOT_FOUND', message: '未找到该预约' });
    const row = result.rows[0];
    return res.json({ success: true, data: { appointmentId: row.id, internalNotes: row.internal_notes || '', updatedAt: row.updated_at } });
  } catch (error) {
    console.error('Owner appointment internal notes update error:', safeStaffAuthErrorCode(error));
    return res.status(500).json({ success: false, code: 'INTERNAL_NOTES_UPDATE_FAILED', message: '内部备注保存失败' });
  }
});

app.get('/api/owner/customers/:customerId/profile-notes', requireOwnerAuth, requireOwnerRole(OWNER_CUSTOMER_PROFILE_NOTES_READ_ROLES), async (req, res) => {
  const customerId = typeof req.params.customerId === 'string' ? req.params.customerId.trim() : '';
  if (!isUuid(customerId)) return res.status(400).json({ success: false, code: 'INVALID_CUSTOMER_ID', message: '顾客ID不正确' });
  try {
    const result = await app.locals.ownerAuthPool.query(
      `SELECT id, profile_notes FROM customers WHERE id = $1 AND shop_id = $2`,
      [customerId, req.ownerAuth.shopId]
    );
    if (result.rows.length !== 1) return res.status(404).json({ success: false, code: 'CUSTOMER_NOT_FOUND', message: '未找到该顾客' });
    const row = result.rows[0];
    return res.json({ success: true, data: { customerId: row.id, profileNotes: row.profile_notes || '', profile_notes: row.profile_notes || '' } });
  } catch (error) {
    console.error('Owner customer profile notes read error:', safeStaffAuthErrorCode(error));
    return res.status(500).json({ success: false, code: 'PROFILE_NOTES_READ_FAILED', message: '读取顾客档案备注失败' });
  }
});

app.patch('/api/owner/customers/:customerId/profile-notes', requireOwnerAuth, requireOwnerRole(OWNER_CUSTOMER_PROFILE_NOTES_WRITE_ROLES), async (req, res) => {
  const customerId = typeof req.params.customerId === 'string' ? req.params.customerId.trim() : '';
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!isUuid(customerId)) return res.status(400).json({ success: false, code: 'INVALID_CUSTOMER_ID', message: '顾客ID不正确' });
  if (!body) return res.status(400).json({ success: false, code: 'INVALID_PROFILE_NOTES', message: '顾客档案备注格式不正确' });
  const rawNotes = Object.prototype.hasOwnProperty.call(body, 'profileNotes')
    ? body.profileNotes
    : (Object.prototype.hasOwnProperty.call(body, 'profile_notes') ? body.profile_notes : undefined);
  if (rawNotes === undefined || (rawNotes !== null && typeof rawNotes !== 'string')) {
    return res.status(400).json({ success: false, code: 'INVALID_PROFILE_NOTES', message: '顾客档案备注格式不正确' });
  }
  const trimmed = typeof rawNotes === 'string' ? rawNotes.trim() : '';
  if (trimmed.length > OWNER_CUSTOMER_PROFILE_NOTES_MAX_LENGTH) {
    return res.status(400).json({ success: false, code: 'PROFILE_NOTES_TOO_LONG', message: '顾客档案备注不能超过4000个字符' });
  }
  const profileNotesValue = trimmed || null;
  try {
    const result = await app.locals.ownerAuthPool.query(
      `UPDATE customers SET profile_notes = $1 WHERE id = $2 AND shop_id = $3 RETURNING id, profile_notes`,
      [profileNotesValue, customerId, req.ownerAuth.shopId]
    );
    if (result.rows.length !== 1) return res.status(404).json({ success: false, code: 'CUSTOMER_NOT_FOUND', message: '未找到该顾客' });
    const row = result.rows[0];
    return res.json({ success: true, data: { customerId: row.id, profileNotes: row.profile_notes || '', profile_notes: row.profile_notes || '' } });
  } catch (error) {
    console.error('Owner customer profile notes update error:', safeStaffAuthErrorCode(error));
    return res.status(500).json({ success: false, code: 'PROFILE_NOTES_UPDATE_FAILED', message: '顾客档案备注保存失败' });
  }
});

const QUALIFIED_SERVICE_STAFF_EXISTS_SQL = `
  EXISTS (
    SELECT 1
    FROM staff_services AS capability
    JOIN staff AS member
      ON member.shop_id = capability.shop_id
     AND member.id = capability.staff_id
     AND member.is_active = TRUE
     AND member.bookable = TRUE
    JOIN staff_location_assignments AS assignment
      ON assignment.shop_id = member.shop_id
     AND assignment.staff_id = member.id
     AND assignment.is_active = TRUE
    JOIN locations AS location
      ON location.shop_id = member.shop_id
     AND location.id = assignment.location_id
     AND location.is_active = TRUE
    JOIN staff_location_working_hours AS hours
      ON hours.shop_id = member.shop_id
     AND hours.location_id = assignment.location_id
     AND hours.staff_id = member.id
     AND hours.is_active = TRUE
    WHERE capability.shop_id = service.shop_id
      AND capability.service_id = service.id
      AND capability.is_active = TRUE
  )
`;

const shopCatalogRevisions = new Map();
const shopSlugToId = new Map();
const shopIdToSlug = new Map();

const recordShopSlugMapping = (slug, id) => {
  if (slug && id) {
    shopSlugToId.set(slug, id);
    shopIdToSlug.set(id, slug);
  }
};

const getShopCatalogRevision = (identifier) => {
  if (!identifier) return 1;
  const key = shopSlugToId.get(identifier) || identifier;
  if (!shopCatalogRevisions.has(key)) {
    shopCatalogRevisions.set(key, 1);
  }
  return shopCatalogRevisions.get(key);
};

const invalidateShopCatalogCache = (identifier) => {
  if (!identifier) return;
  const key = shopSlugToId.get(identifier) || identifier;
  const current = getShopCatalogRevision(key);
  const next = current + 1;
  shopCatalogRevisions.set(key, next);
  const slug = shopIdToSlug.get(key);
  if (slug) {
    shopCatalogRevisions.set(slug, next);
  }
  const id = shopSlugToId.get(key);
  if (id) {
    shopCatalogRevisions.set(id, next);
  }
};
app.locals.getShopCatalogRevision = getShopCatalogRevision;
app.locals.invalidateShopCatalogCache = invalidateShopCatalogCache;
app.locals.recordShopSlugMapping = recordShopSlugMapping;

const setPublicBookingNoCacheHeaders = (res, identifier = null) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  if (identifier) {
    res.set('X-Catalog-Revision', String(getShopCatalogRevision(identifier)));
  }
};

// Public contact data is deliberately a narrow allow-list.  It is shop-scoped
// by the resolved active slug and never exposes owner-only settings.
app.get('/api/customer/public-config', async (req, res) => {
  const shopSlug = typeof req.query.shopSlug === 'string' ? req.query.shopSlug.trim().toLowerCase() : '';
  setPublicBookingNoCacheHeaders(res, shopSlug);
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(shopSlug) || shopSlug.length > 100) {
    return res.status(400).json({ success: false, code: 'INVALID_SHOP_CONTEXT' });
  }
  try {
    const result = await app.locals.bookingPool.query(
      `SELECT shop.name AS shop_name,
              settings.public_contact_phone,
              settings.public_whatsapp_phone,
              settings.public_address,
              settings.public_postal_code,
              settings.public_map_url,
              settings.show_public_address
       FROM shops AS shop
       LEFT JOIN shop_customer_settings AS settings ON settings.shop_id = shop.id
       WHERE shop.slug = $1 AND shop.status = 'active' LIMIT 1`, [shopSlug]
    );
    if (result.rows.length !== 1) return res.status(404).json({ success: false, code: 'SHOP_NOT_FOUND' });
    return res.json({ success: true, data: merchantContactPresentation(result.rows[0]) });
  } catch (error) {
    console.error('Public merchant contact read error:', safeStaffAuthErrorCode(error));
    return res.status(500).json({ success: false, code: 'MERCHANT_CONTACT_UNAVAILABLE' });
  }
});

app.post('/api/customer/my-bookings', async (req, res) => {
  setPublicBookingNoCacheHeaders(res);

  if (req.query.phone || req.query.phoneNumber || req.query.mobile) {
    return res.status(400).json({ success: false, code: 'INVALID_QUERY_TRANSPORT', message: 'Phone must not be sent via query parameters' });
  }

  const { shopSlug, countryCode, phone } = req.body || {};
  const normalizedSlug = typeof shopSlug === 'string' ? shopSlug.trim().toLowerCase() : '';
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(normalizedSlug) || normalizedSlug.length > 100) {
    return res.status(400).json({ success: false, code: 'INVALID_SHOP_CONTEXT' });
  }

  const clientIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown';
  const rawPhone = typeof phone === 'string' ? phone.trim() : '';
  const phoneNormalized = normalizeCustomerQueryPhone(countryCode, rawPhone);

  const ipLimit = checkRateLimit(`ip:${clientIp}`, { maxRequests: 20, windowMs: 60000 });
  if (!ipLimit.allowed) {
    res.setHeader('Retry-After', String(ipLimit.retryAfterSeconds));
    return res.status(429).json({ success: false, code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please try again later.' });
  }

  if (phoneNormalized) {
    const phoneLimit = checkRateLimit(`phone:${normalizedSlug}:${phoneNormalized}`, { maxRequests: 10, windowMs: 60000 });
    if (!phoneLimit.allowed) {
      res.setHeader('Retry-After', String(phoneLimit.retryAfterSeconds));
      return res.status(429).json({ success: false, code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please try again later.' });
    }
  }

  try {
    const shopResult = await app.locals.bookingPool.query(
      `SELECT shop.id,
              shop.name AS shop_name,
              settings.public_contact_phone,
              settings.public_whatsapp_phone,
              settings.public_address,
              settings.public_postal_code,
              settings.public_map_url,
              settings.show_public_address
       FROM shops AS shop
       LEFT JOIN shop_customer_settings AS settings ON settings.shop_id = shop.id
       WHERE shop.slug = $1 AND shop.status = 'active' LIMIT 1`, [normalizedSlug]
    );

    if (shopResult.rows.length !== 1) {
      return res.status(404).json({ success: false, code: 'SHOP_NOT_FOUND' });
    }

    const shopRow = shopResult.rows[0];
    const shopContact = merchantContactPresentation(shopRow);

    if (!phoneNormalized && !rawPhone) {
      return res.json({ success: true, data: { shop: shopContact, appointments: [] } });
    }

    const appointments = await queryCustomerBookings(app.locals.bookingPool, {
      shopId: shopRow.id,
      phoneNormalized,
      rawPhone
    });

    return res.json({
      success: true,
      data: {
        shop: shopContact,
        appointments
      }
    });
  } catch (error) {
    console.error('Customer my-bookings query error:', safeStaffAuthErrorCode(error));
    return res.status(500).json({ success: false, code: 'BOOKINGS_QUERY_UNAVAILABLE' });
  }
});

app.get('/api/owner/merchant-contact', requireOwnerAuth, requireOwnerRole(OWNER_MERCHANT_CONTACT_READ_ROLES), async (req, res) => {
  setPublicBookingNoCacheHeaders(res);
  try {
    const result = await app.locals.ownerAuthPool.query(
      `SELECT public_contact_phone,
              public_whatsapp_phone,
              public_address,
              public_postal_code,
              public_map_url,
              show_public_address
       FROM shop_customer_settings WHERE shop_id = $1 LIMIT 1`, [req.ownerAuth.shopId]
    );
    const row = result.rows[0] || {};
    return res.json({ success: true, data: {
      contactPhone: row.public_contact_phone || '',
      whatsAppPhone: row.public_whatsapp_phone || '',
      address: row.public_address || '',
      postalCode: row.public_postal_code || '',
      mapUrl: row.public_map_url || '',
      showAddress: row.show_public_address !== false
    }});
  } catch (error) {
    console.error('Owner merchant contact read error:', safeStaffAuthErrorCode(error));
    return res.status(500).json({ success: false, code: 'MERCHANT_CONTACT_UNAVAILABLE' });
  }
});

app.patch('/api/owner/merchant-contact', requireOwnerAuth, requireOwnerRole(OWNER_MERCHANT_CONTACT_WRITE_ROLES), async (req, res) => {
  setPublicBookingNoCacheHeaders(res);
  const validation = validateMerchantContactSettings(req.body);
  if (validation.error) return res.status(400).json({ success: false, code: validation.error });
  const fields = Object.entries(validation.values);
  const assignments = fields.map(([column], index) => `${column} = $${index + 2}`).join(', ');
  try {
    const result = await app.locals.ownerAuthPool.query(
      `INSERT INTO shop_customer_settings (shop_id) VALUES ($1)
       ON CONFLICT (shop_id) DO UPDATE SET ${assignments}
       RETURNING public_contact_phone, public_whatsapp_phone, public_address, public_postal_code, public_map_url, show_public_address`,
      [req.ownerAuth.shopId, ...fields.map(([, value]) => value)]
    );
    const row = result.rows[0] || {};
    return res.json({ success: true, data: {
      contactPhone: row.public_contact_phone || '',
      whatsAppPhone: row.public_whatsapp_phone || '',
      address: row.public_address || '',
      postalCode: row.public_postal_code || '',
      mapUrl: row.public_map_url || '',
      showAddress: row.show_public_address !== false
    }});
  } catch (error) {
    console.error('Owner merchant contact write error:', safeStaffAuthErrorCode(error));
    return res.status(500).json({ success: false, code: 'MERCHANT_CONTACT_UPDATE_FAILED' });
  }
});

const ownerStaffManagement = createOwnerStaffManagement({
  pool: {
    connect: (...args) =>
      app.locals.ownerAuthPool.connect(...args)
  },
  isUuid,
  runInTransaction,
  safeErrorCode: safeStaffAuthErrorCode,
  invalidateCatalog: invalidateShopCatalogCache
});

app.get(
  '/api/owner/staff',
  requireOwnerAuth,
  requireOwnerRole(['owner', 'manager', 'admin', 'front_desk']),
  ownerStaffManagement.listStaff
);

app.post(
  '/api/owner/staff',
  requireOwnerAuth,
  requireOwnerRole(['owner', 'manager']),
  ownerStaffManagement.createStaff
);

app.patch(
  '/api/owner/staff/:staffId',
  requireOwnerAuth,
  requireOwnerRole(['owner', 'manager']),
  ownerStaffManagement.updateStaff
);

app.get(
  '/api/owner/staff/:staffId/locations',
  requireOwnerAuth,
  requireOwnerRole(['owner', 'manager', 'admin']),
  ownerStaffManagement.listStaffLocations
);

app.put(
  '/api/owner/staff/:staffId/locations',
  requireOwnerAuth,
  requireOwnerRole(['owner', 'manager']),
  ownerStaffManagement.replaceStaffLocations
);

const ownerStaffCapabilityManagement =
  createOwnerStaffCapabilityManagement({
    pool: {
      connect: (...args) =>
        app.locals.ownerAuthPool.connect(...args)
    },
    isUuid,
    runInTransaction,
    safeErrorCode: safeStaffAuthErrorCode,
    invalidateCatalog: invalidateShopCatalogCache
  });

app.get(
  '/api/owner/staff/:staffId/services',
  requireOwnerAuth,
  requireOwnerRole(['owner', 'manager', 'admin']),
  ownerStaffCapabilityManagement.listStaffServices
);

app.put(
  '/api/owner/staff/:staffId/services',
  requireOwnerAuth,
  requireOwnerRole(['owner', 'manager']),
  ownerStaffCapabilityManagement.replaceStaffServices
);

const ownerScheduleManagement = createOwnerScheduleManagement({
  pool: { connect: (...args) => app.locals.ownerAuthPool.connect(...args) },
  isUuid,
  runInTransaction,
  safeErrorCode: safeStaffAuthErrorCode,
  invalidateCatalog: invalidateShopCatalogCache
});

app.get('/api/owner/staff/:staffId/schedule', requireOwnerAuth, requireOwnerRole(['owner', 'manager', 'admin']), ownerScheduleManagement.getWeekly);
app.put('/api/owner/staff/:staffId/schedule', requireOwnerAuth, requireOwnerRole(['owner', 'manager']), ownerScheduleManagement.putWeekly);
app.get('/api/owner/staff/:staffId/schedule-overrides', requireOwnerAuth, requireOwnerRole(['owner', 'manager', 'admin']), ownerScheduleManagement.getOverrides);
app.post('/api/owner/staff/:staffId/schedule-overrides', requireOwnerAuth, requireOwnerRole(['owner', 'manager']), ownerScheduleManagement.postOverride);
app.patch('/api/owner/staff/:staffId/schedule-overrides/:overrideId', requireOwnerAuth, requireOwnerRole(['owner', 'manager']), ownerScheduleManagement.patchOverride);

const ownerServiceCategoryManagement = createOwnerServiceCategoryManagement({
  pool: { connect: (...args) => app.locals.ownerAuthPool.connect(...args) },
  isUuid,
  runInTransaction,
  safeErrorCode: safeStaffAuthErrorCode,
  invalidateCatalog: invalidateShopCatalogCache
});
app.get('/api/owner/service-categories', requireOwnerAuth, requireOwnerRole(['owner', 'manager', 'admin']), ownerServiceCategoryManagement.list);
app.post('/api/owner/service-categories', requireOwnerAuth, requireOwnerRole(['owner', 'manager']), ownerServiceCategoryManagement.create);
app.patch('/api/owner/service-categories/:categoryId', requireOwnerAuth, requireOwnerRole(['owner', 'manager']), ownerServiceCategoryManagement.patch);

const OWNER_SERVICE_FIELDS = new Set([
  'category',
  'categoryId',
  'name',
  'description',
  'nameZh',
  'nameEn',
  'descriptionZh',
  'descriptionEn',
  'price',
  'priceIsFrom',
  'durationMinutes',
  'bookable',
  'isActive',
  'sortOrder'
]);

const OWNER_SERVICE_LIMITS = {
  name: 200,
  category: 100,
  description: 2000,
  price: 1000000000,
  durationMinutes: 1440,
  sortOrder: 1000000000
};

const ownerServiceValidationError = message => ({
  success: false,
  message
});

const validateOwnerServiceFields = (body, { partial }) => {
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body)
  ) {
    return { error: '服务资料格式不正确' };
  }

  const keys = Object.keys(body);
  const unknownField = keys.find(
    key => !OWNER_SERVICE_FIELDS.has(key)
  );

  if (unknownField) {
    return { error: '包含不支持的服务字段' };
  }

  if (partial && keys.length === 0) {
    return { error: '没有可更新的服务字段' };
  }

  if (!partial && !keys.includes('name')) {
    if (!keys.includes('nameEn') && !keys.includes('nameZh')) {
      return { error: '服务名称不能为空' };
    }
  }

  const values = {};

  for (const [field, limit] of [
    ['nameZh', OWNER_SERVICE_LIMITS.name],
    ['nameEn', OWNER_SERVICE_LIMITS.name],
    ['descriptionZh', OWNER_SERVICE_LIMITS.description],
    ['descriptionEn', OWNER_SERVICE_LIMITS.description]
  ]) {
    if (!keys.includes(field)) continue;
    if (typeof body[field] !== 'string') {
      return { error: `${field} 格式不正确` };
    }
    const trimmed = body[field].trim();
    if (!trimmed || trimmed.length > limit) {
      return { error: `${field} 长度不正确` };
    }
    values[field] = trimmed;
  }

  if (
    keys.includes('descriptionEn') &&
    !keys.includes('nameEn') &&
    !partial
  ) {
    return { error: 'English Name 不能为空' };
  }

  if (
    keys.includes('descriptionZh') &&
    !keys.includes('nameZh') &&
    !partial
  ) {
    return { error: '中文名称不能为空' };
  }

  if (keys.includes('name')) {
    if (typeof body.name !== 'string') {
      return { error: '服务名称格式不正确' };
    }

    values.name = body.name.trim();

    if (
      !values.name ||
      values.name.length > OWNER_SERVICE_LIMITS.name
    ) {
      return { error: '服务名称长度不正确' };
    }
  }

  for (const field of ['category', 'description']) {
    if (!keys.includes(field)) {
      continue;
    }

    if (body[field] === null) {
      values[field] = null;
      continue;
    }

    if (typeof body[field] !== 'string') {
      return { error: `${field} 格式不正确` };
    }

    const trimmed = body[field].trim();
    const maxLength = OWNER_SERVICE_LIMITS[field];

    if (trimmed.length > maxLength) {
      return { error: `${field} 长度不正确` };
    }

    values[field] = trimmed || null;
  }

  if (keys.includes('categoryId')) {
    if (body.categoryId !== null && !isUuid(body.categoryId)) return { error: '分类ID不正确' };
    values.categoryId = body.categoryId;
  }

  if (keys.includes('price')) {
    if (
      typeof body.price !== 'number' ||
      !Number.isFinite(body.price) ||
      body.price < 0 ||
      body.price > OWNER_SERVICE_LIMITS.price
    ) {
      return { error: '服务价格不正确' };
    }

    values.price = body.price;
  }

  if (keys.includes('durationMinutes')) {
    if (
      !Number.isInteger(body.durationMinutes) ||
      body.durationMinutes <= 0 ||
      body.durationMinutes >
        OWNER_SERVICE_LIMITS.durationMinutes
    ) {
      return { error: '服务时长不正确' };
    }

    values.durationMinutes = body.durationMinutes;
  }

  for (const field of ['bookable', 'isActive', 'priceIsFrom']) {
    if (
      keys.includes(field) &&
      typeof body[field] !== 'boolean'
    ) {
      return { error: `${field} 格式不正确` };
    }

    if (keys.includes(field)) {
      values[field] = body[field];
    }
  }

  if (keys.includes('sortOrder')) {
    if (
      !Number.isInteger(body.sortOrder) ||
      body.sortOrder < 0 ||
      body.sortOrder > OWNER_SERVICE_LIMITS.sortOrder
    ) {
      return { error: '服务排序值不正确' };
    }

    values.sortOrder = body.sortOrder;
  }

  return { values };
};

const OWNER_SERVICE_RETURNING_SQL = `
  service.id,
  service.category_id AS "categoryId",
  service.category,
  service.name,
  service.description,
  service.name AS "canonicalName",
  service.description AS "canonicalDescription",
  service.price,
  service.price_is_from AS "priceIsFrom",
  service.price_is_from,
  service.duration_minutes AS "durationMinutes",
  service.duration_minutes,
  service.bookable,
  service.is_active AS "isActive",
  service.is_active,
  service.sort_order AS "sortOrder",
  service.sort_order,
  service.created_at AS "createdAt",
  service.updated_at AS "updatedAt",
  translation_zh.name AS "nameZh",
  translation_en.name AS "nameEn",
  translation_zh.description AS "descriptionZh",
  translation_en.description AS "descriptionEn"
`;

const OWNER_SERVICE_SELECT_SQL = `
  SELECT ${OWNER_SERVICE_RETURNING_SQL}
  FROM services AS service
  LEFT JOIN service_translations AS translation_zh
    ON translation_zh.shop_id = service.shop_id
   AND translation_zh.service_id = service.id
   AND translation_zh.locale = 'zh-CN'
  LEFT JOIN service_translations AS translation_en
    ON translation_en.shop_id = service.shop_id
   AND translation_en.service_id = service.id
   AND translation_en.locale = 'en'
`;

const assertOwnerServiceCategory = async (client, shopId, categoryId) => {
  if (categoryId === null || categoryId === undefined) return;
  const result = await client.query('SELECT id FROM service_categories WHERE id=$1 AND shop_id=$2 LIMIT 1', [categoryId, shopId]);
  if (result.rows.length !== 1) throw new AppointmentMutationError('category_not_found', 409, '服务分类不存在或不属于当前店铺');
};

const selectOwnerService = async (client, shopId, serviceId) => {
  const result = await client.query(
    `${OWNER_SERVICE_SELECT_SQL}
     WHERE service.shop_id = $1
       AND ($2::UUID IS NULL OR service.id = $2::UUID)
     ORDER BY service.sort_order ASC, service.name ASC`,
    [shopId, serviceId || null]
  );
  return result.rows;
};

const upsertOwnerServiceTranslation = async (
  client,
  { shopId, serviceId, locale, name, description, partial }
) => {
  const existing = await client.query(
    `SELECT name, description
     FROM service_translations
     WHERE shop_id = $1 AND service_id = $2 AND locale = $3
     FOR UPDATE`,
    [shopId, serviceId, locale]
  );
  const current = existing.rows[0];
  const nextName = name === undefined ? current?.name : name;
  const nextDescription = description === undefined
    ? current?.description ?? null
    : description;

  if (!nextName) {
    if (partial && name === undefined && description === undefined) return;
    throw new AppointmentMutationError(
      'translation_name_required',
      400,
      locale === 'zh-CN' ? '中文名称不能为空' : 'English Name 不能为空'
    );
  }

  await client.query(
    `INSERT INTO service_translations (
       shop_id, service_id, locale, name, description
     ) VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (shop_id, service_id, locale)
     DO UPDATE SET
       name = EXCLUDED.name,
       description = EXCLUDED.description,
       updated_at = NOW()`,
    [shopId, serviceId, locale, nextName, nextDescription]
  );
};

app.get(
  '/api/owner/services',
  requireOwnerAuth,
  requireOwnerRole(['owner', 'manager', 'admin']),
  async (req, res) => {
    let client;

    try {
      client = await app.locals.ownerAuthPool.connect();
      const rows = await selectOwnerService(
        client,
        req.ownerAuth.shopId
      );

      res.json({ success: true, data: rows });
    } catch (error) {
      console.error(
        'Read owner services error:',
        safeStaffAuthErrorCode(error)
      );
      res.status(500).json({
        success: false,
        message: '读取服务资料失败'
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);

app.post(
  '/api/owner/services',
  requireOwnerAuth,
  requireOwnerRole(['owner', 'manager']),
  async (req, res) => {
    const validation = validateOwnerServiceFields(
      req.body,
      { partial: false }
    );

    if (validation.error) {
      return res.status(400).json(
        ownerServiceValidationError(validation.error)
      );
    }

    const values = validation.values;
    try {
      const created = await runInTransaction(
        app.locals.ownerAuthPool,
        async client => {
          const canonicalName = values.name || values.nameEn || values.nameZh;
          await assertOwnerServiceCategory(client, req.ownerAuth.shopId, values.categoryId);
          const result = await client.query(
            `INSERT INTO services (
               shop_id, category, category_id, name, description, price,
               price_is_from, duration_minutes, bookable, is_active, sort_order
             ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
             RETURNING id`,
            [
              req.ownerAuth.shopId,
              values.category ?? null,
              values.categoryId ?? null,
              canonicalName,
              values.description ?? null,
              values.price ?? 0,
              values.priceIsFrom ?? false,
              values.durationMinutes ?? 60,
              values.bookable ?? true,
              values.isActive ?? true,
              values.sortOrder ?? 0
            ]
          );
          if (result.rows.length !== 1) {
            throw new Error('owner_service_insert_rowcount');
          }
          const serviceId = result.rows[0].id;
          for (const [locale, nameField, descriptionField] of [
            ['zh-CN', 'nameZh', 'descriptionZh'],
            ['en', 'nameEn', 'descriptionEn']
          ]) {
            if (values[nameField] !== undefined || values[descriptionField] !== undefined) {
              await upsertOwnerServiceTranslation(client, {
                shopId: req.ownerAuth.shopId,
                serviceId,
                locale,
                name: values[nameField],
                description: values[descriptionField],
                partial: false
              });
            }
          }
          const rows = await selectOwnerService(client, req.ownerAuth.shopId, serviceId);
          if (rows.length !== 1) throw new Error('owner_service_select_rowcount');
          return rows[0];
        }
      );

      invalidateShopCatalogCache(req.ownerAuth.shopId);

      res.status(201).json({
        success: true,
        data: created
      });
    } catch (error) {
      console.error(
        'Create owner service error:',
        safeStaffAuthErrorCode(error)
      );
      res.status(error instanceof AppointmentMutationError ? error.status : 500).json({
        success: false,
        message: error instanceof AppointmentMutationError
          ? error.publicMessage
          : '创建服务失败'
      });
    }
  }
);

app.patch(
  '/api/owner/services/:serviceId',
  requireOwnerAuth,
  requireOwnerRole(['owner', 'manager']),
  async (req, res) => {
    if (!isUuid(req.params.serviceId)) {
      return res.status(400).json(
        ownerServiceValidationError('服务ID不正确')
      );
    }

    const validation = validateOwnerServiceFields(
      req.body,
      { partial: true }
    );

    if (validation.error) {
      return res.status(400).json(
        ownerServiceValidationError(validation.error)
      );
    }

    const values = validation.values;
    const columnByField = {
      category: 'category',
      categoryId: 'category_id',
      name: 'name',
      description: 'description',
      price: 'price',
      priceIsFrom: 'price_is_from',
      durationMinutes: 'duration_minutes',
      bookable: 'bookable',
      isActive: 'is_active',
      sortOrder: 'sort_order'
    };
    const translationFields = new Set([
      'nameZh', 'nameEn', 'descriptionZh', 'descriptionEn'
    ]);
    const entries = Object.entries(validation.values)
      .filter(([field]) => !translationFields.has(field));
    const parameters = entries.map(([, value]) => value);
    const assignments = entries.map(
      ([field], index) =>
        `${columnByField[field]} = $${index + 1}`
    );
    const serviceIdParameter = parameters.length + 1;
    const shopIdParameter = parameters.length + 2;
    parameters.push(
      req.params.serviceId,
      req.ownerAuth.shopId
    );

    try {
      const updated = await runInTransaction(
        app.locals.ownerAuthPool,
        async client => {
          const locked = await client.query(
            `SELECT id FROM services
             WHERE id = $1 AND shop_id = $2
             FOR UPDATE`,
            [req.params.serviceId, req.ownerAuth.shopId]
          );
          if (locked.rows.length !== 1) {
            throw new AppointmentMutationError(
              'service_not_found', 404, '未找到该服务'
            );
          }

          await assertOwnerServiceCategory(client, req.ownerAuth.shopId, values.categoryId);

          if (assignments.length) {
            const result = await client.query(
              `UPDATE services
               SET ${assignments.join(', ')}, updated_at = NOW()
               WHERE id = $${serviceIdParameter}
                 AND shop_id = $${shopIdParameter}
               RETURNING id`,
              parameters
            );
            if (result.rows.length !== 1) {
              throw new Error('owner_service_update_rowcount');
            }
          }

          for (const [locale, nameField, descriptionField] of [
            ['zh-CN', 'nameZh', 'descriptionZh'],
            ['en', 'nameEn', 'descriptionEn']
          ]) {
            if (values[nameField] !== undefined || values[descriptionField] !== undefined) {
              await upsertOwnerServiceTranslation(client, {
                shopId: req.ownerAuth.shopId,
                serviceId: req.params.serviceId,
                locale,
                name: values[nameField],
                description: values[descriptionField],
                partial: true
              });
            }
          }

          const rows = await selectOwnerService(
            client, req.ownerAuth.shopId, req.params.serviceId
          );
          if (rows.length !== 1) throw new Error('owner_service_select_rowcount');
          return rows[0];
        }
      );

      invalidateShopCatalogCache(req.ownerAuth.shopId);

      res.json({ success: true, data: updated });
    } catch (error) {
      console.error(
        'Update owner service error:',
        safeStaffAuthErrorCode(error)
      );
      res.status(error instanceof AppointmentMutationError ? error.status : 500).json({
        success: false,
        message: error instanceof AppointmentMutationError
          ? error.publicMessage
          : '更新服务失败'
      });
    }
  }
);


// ==================================================
// 数据库连接测试
// ==================================================

app.get('/api/db-test', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT NOW() AS now'
    );

    res.json({
      success: true,
      message: 'Database connected successfully',
      time: result.rows[0].now
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      success: false,
      message: 'Database connection failed'
    });
  }
});

// Public, tenant-scoped service categories. Categories without an active,
// bookable service backed by staff with active schedules are hidden.
app.get('/api/booking/service-categories', async (req, res) => {
  const shopSlug = typeof req.query.shopSlug === 'string' ? req.query.shopSlug.trim() : '';
  setPublicBookingNoCacheHeaders(res, shopSlug);
  const locale = normalizeLocale(req.query.locale);
  if (!shopSlug) return res.status(400).json({ success: false, message: '缺少店铺资料' });

  let client;
  try {
    client = await req.app.locals.bookingPool.connect();
    const result = await client.query(
      `SELECT
         category.id AS "categoryId",
         COALESCE(requested.name, english.name, chinese.name, category.canonical_name) AS name,
         category.icon_key AS "iconKey",
         category.sort_order AS "sortOrder"
       FROM shops AS shop
       JOIN service_categories AS category
         ON category.shop_id = shop.id
        AND category.is_active = TRUE
       LEFT JOIN service_category_translations AS requested
         ON requested.shop_id = category.shop_id
        AND requested.category_id = category.id
        AND requested.locale = $2
       LEFT JOIN service_category_translations AS english
         ON english.shop_id = category.shop_id
        AND english.category_id = category.id
        AND english.locale = 'en'
       LEFT JOIN service_category_translations AS chinese
         ON chinese.shop_id = category.shop_id
        AND chinese.category_id = category.id
        AND chinese.locale = 'zh-CN'
       WHERE shop.slug = $1
         AND shop.status = 'active'
         AND EXISTS (
           SELECT 1
           FROM services AS service
           WHERE service.shop_id = category.shop_id
             AND service.category_id = category.id
             AND service.is_active = TRUE
             AND service.bookable = TRUE
             AND ${QUALIFIED_SERVICE_STAFF_EXISTS_SQL}
         )
       ORDER BY category.sort_order ASC, category.id ASC`,
      [shopSlug, locale]
    );
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Read public service categories error:', safeStaffAuthErrorCode(error));
    return res.status(500).json({ success: false, message: '读取服务分类失败' });
  } finally {
    if (client) client.release();
  }
});

// Public, tenant-scoped service catalogue. Locale affects display fields only.
app.get('/api/services-db', async (req, res) => {
  const shopSlug = typeof req.query.shopSlug === 'string'
    ? req.query.shopSlug.trim()
    : '';
  setPublicBookingNoCacheHeaders(res, shopSlug);
  const locale = normalizeLocale(req.query.locale);

  if (!shopSlug) {
    return res.status(400).json({
      success: false,
      message: '缺少店铺资料'
    });
  }

  let client;
  try {
    client = await req.app.locals.bookingPool.connect();
    const result = await client.query(
      `SELECT
         service.id,
         service.category,
         service.category_id AS "categoryId",
         service.price,
         service.price_is_from AS "priceIsFrom",
         service.duration_minutes AS "durationMinutes",
         COALESCE(requested.name, english.name, chinese.name, service.name) AS name,
         COALESCE(requested.description, english.description, chinese.description, service.description) AS description,
         $2::TEXT AS locale
       FROM shops AS shop
       JOIN services AS service
         ON service.shop_id = shop.id
        AND service.is_active = TRUE
        AND service.bookable = TRUE
       JOIN service_categories AS category
         ON category.shop_id = service.shop_id
        AND category.id = service.category_id
        AND category.is_active = TRUE
       LEFT JOIN service_translations AS requested
         ON requested.shop_id = service.shop_id
        AND requested.service_id = service.id
        AND requested.locale = $2
       LEFT JOIN service_translations AS english
         ON english.shop_id = service.shop_id
        AND english.service_id = service.id
        AND english.locale = 'en'
       LEFT JOIN service_translations AS chinese
         ON chinese.shop_id = service.shop_id
        AND chinese.service_id = service.id
        AND chinese.locale = 'zh-CN'
       WHERE shop.slug = $1
         AND shop.status = 'active'
         AND ${QUALIFIED_SERVICE_STAFF_EXISTS_SQL}
       ORDER BY service.sort_order ASC, service.name ASC`,
      [shopSlug, locale]
    );
    return res.json({ success: true, data: result.rows });
  } catch (error) {
    console.error('Read public services error:', safeStaffAuthErrorCode(error));
    return res.status(500).json({ success: false, message: '读取服务失败' });
  } finally {
    if (client) client.release();
  }
});


// ==================================================
// 读取 Owner 日历上下文（权威时间与地点时区）
// ==================================================

app.get(
  '/api/owner/calendar-context',
  requireOwnerAuth,
  requireOwnerRole(['owner', 'manager', 'admin', 'front_desk']),
  async (req, res) => {
    const trustedShopId = req.ownerAuth.shopId;
    const requestedLocationId =
      typeof req.query.locationId === 'string'
        ? req.query.locationId.trim()
        : '';

    if (requestedLocationId && !isUuid(requestedLocationId)) {
      return res.status(404).json({
        success: false,
        message: '未找到请求的地点'
      });
    }

    let client;
    try {
      client = await app.locals.ownerAuthPool.connect();

      let locationResult;
      if (requestedLocationId) {
        locationResult = await client.query(
          `
          SELECT id, timezone
          FROM locations
          WHERE id = $1
            AND shop_id = $2
            AND is_active = TRUE
          LIMIT 1
          `,
          [requestedLocationId, trustedShopId]
        );

        if (locationResult.rows.length === 0) {
          return res.status(404).json({
            success: false,
            message: '未找到请求的地点'
          });
        }
      } else {
        locationResult = await client.query(
          `
          SELECT id, timezone
          FROM locations
          WHERE shop_id = $1
            AND is_active = TRUE
          ORDER BY created_at ASC
          LIMIT 2
          `,
          [trustedShopId]
        );

        if (locationResult.rows.length === 0) {
          return res.status(404).json({
            success: false,
            message: '未找到请求的地点'
          });
        }

        if (locationResult.rows.length > 1) {
          return res.status(400).json({
            success: false,
            message: '店铺存在多个营业地点，必须指定 locationId'
          });
        }
      }

      const location = locationResult.rows[0];

      res.set('Cache-Control', 'no-store, private, max-age=0');
      res.set('Pragma', 'no-cache');

      res.json({
        success: true,
        data: {
          server_now: new Date().toISOString(),
          timezone: location.timezone,
          location_id: location.id
        }
      });
    } catch (error) {
      console.error(
        'Read calendar context error:',
        safeStaffAuthErrorCode(error)
      );

      res.status(500).json({
        success: false,
        message: '读取日历上下文失败'
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);


// ==================================================
// 从数据库读取真实预约
// ==================================================

app.get(
  '/api/appointments-db',
  requireOwnerAuth,
  requireOwnerRole(['owner', 'manager', 'admin', 'front_desk']),
  async (req, res) => {
  const trustedShopId = req.ownerAuth.shopId;
  const requestedLocationId =
    typeof req.query.locationId === 'string'
      ? req.query.locationId.trim()
      : '';

  if (requestedLocationId && !isUuid(requestedLocationId)) {
    return res.status(404).json({
      success: false,
      message: '未找到请求的地点'
    });
  }

  let client;

  try {
    client = await app.locals.ownerAuthPool.connect();

    if (requestedLocationId) {
      const locationResult = await client.query(
        `
        SELECT id
        FROM locations
        WHERE id = $1
          AND shop_id = $2
          AND is_active = TRUE
        LIMIT 1
        `,
        [requestedLocationId, trustedShopId]
      );

      if (locationResult.rows.length !== 1) {
        return res.status(404).json({
          success: false,
          message: '未找到请求的地点'
        });
      }
    }

    const result = await client.query(`
      WITH selected_appointments AS MATERIALIZED (
        SELECT appointment.*
        FROM appointments appointment
        WHERE appointment.shop_id = $1
          AND (
            $2::UUID IS NULL
            OR appointment.location_id = $2::UUID
          )
      ),
      assignment_projection AS (
        SELECT
          assignment.shop_id,
          assignment.location_id,
          assignment.appointment_item_id,
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'assignment_id', assignment.id,
              'staff_id', assignment.staff_id,
              'staff_name', assigned_staff.name,
              'role', assignment.role,
              'start_at', assignment.start_at,
              'end_at', assignment.end_at
            )
            ORDER BY
              CASE assignment.role WHEN 'primary' THEN 0 ELSE 1 END,
              assignment.id
          ) AS assignments
        FROM appointment_item_staff_assignments assignment
        JOIN appointment_items assigned_item
          ON assigned_item.id = assignment.appointment_item_id
         AND assigned_item.shop_id = assignment.shop_id
         AND assigned_item.location_id = assignment.location_id
        JOIN selected_appointments selected
          ON selected.id = assigned_item.appointment_id
         AND selected.shop_id = assigned_item.shop_id
         AND selected.location_id = assigned_item.location_id
        JOIN staff assigned_staff
          ON assigned_staff.id = assignment.staff_id
         AND assigned_staff.shop_id = assignment.shop_id
        WHERE assignment.shop_id = $1
        GROUP BY
          assignment.shop_id,
          assignment.location_id,
          assignment.appointment_item_id
      ),
      item_projection AS (
        SELECT
          item.shop_id,
          item.location_id,
          item.appointment_id,
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'item_id', item.id,
              'sequence_no', item.sequence_no,
              'service_id', item.service_id,
              'service_name_snapshot', item.service_name_snapshot,
              'service_locale_snapshot', item.service_locale_snapshot,
              'duration_minutes_snapshot', item.duration_minutes_snapshot,
              'price_snapshot_minor',
                CASE
                  WHEN item.price_snapshot IS NULL THEN NULL
                  ELSE (ROUND(item.price_snapshot * 100)::BIGINT)::TEXT
                END,
              'start_at', item.start_at,
              'end_at', item.end_at,
              'status', item.status,
              'staff_assignments', COALESCE(
                assignment_projection.assignments,
                '[]'::JSON
              )
            )
            ORDER BY item.sequence_no, item.id
          ) AS items
        FROM appointment_items item
        JOIN selected_appointments selected
          ON selected.id = item.appointment_id
         AND selected.shop_id = item.shop_id
         AND selected.location_id = item.location_id
        LEFT JOIN assignment_projection
          ON assignment_projection.shop_id = item.shop_id
         AND assignment_projection.location_id = item.location_id
         AND assignment_projection.appointment_item_id = item.id
        WHERE item.shop_id = $1
        GROUP BY item.shop_id, item.location_id, item.appointment_id
      ),
      legacy_assignment_projection AS (
        SELECT
          item.shop_id,
          item.location_id,
          item.appointment_id,
          JSON_AGG(
            JSON_BUILD_OBJECT(
              'itemId', item.id,
              'sequenceNo', item.sequence_no,
              'staffId', assignment.staff_id,
              'role', assignment.role,
              'startAt', assignment.start_at,
              'endAt', assignment.end_at
            )
            ORDER BY item.sequence_no, assignment.role, assignment.id
          ) AS staff_assignments
        FROM appointment_items item
        JOIN selected_appointments selected
          ON selected.id = item.appointment_id
         AND selected.shop_id = item.shop_id
         AND selected.location_id = item.location_id
        JOIN appointment_item_staff_assignments assignment
          ON assignment.shop_id = item.shop_id
         AND assignment.location_id = item.location_id
         AND assignment.appointment_item_id = item.id
        WHERE item.shop_id = $1
        GROUP BY item.shop_id, item.location_id, item.appointment_id
      ),
      selected_checkouts AS (
        SELECT checkout.*
        FROM checkout_transactions checkout
        JOIN selected_appointments selected
          ON selected.id = checkout.appointment_id
         AND selected.shop_id = checkout.shop_id
      ),
      checkout_line_projection AS (
        SELECT
          line.shop_id,
          line.checkout_id,
          COUNT(*)::TEXT AS line_item_count,
          SUM(line.quote_price_minor)::TEXT AS line_quote_total_minor,
          SUM(line.actual_price_minor)::TEXT AS line_actual_total_minor,
          SUM(line.discount_minor)::TEXT AS line_discount_total_minor,
          SUM(line.final_value_minor)::TEXT AS line_final_total_minor
        FROM checkout_line_items line
        JOIN selected_checkouts checkout
          ON checkout.id = line.checkout_id
         AND checkout.shop_id = line.shop_id
        WHERE line.shop_id = $1
        GROUP BY line.shop_id, line.checkout_id
      ),
      payment_projection AS (
        SELECT
          payment.shop_id,
          payment.checkout_id,
          COALESCE(SUM(payment.amount_minor) FILTER (
            WHERE payment.value_kind <> 'refund'
          ), 0)::TEXT AS payment_total_minor,
          COALESCE(SUM(payment.amount_minor) FILTER (
            WHERE payment.value_kind = 'refund'
          ), 0)::TEXT AS refund_total_minor
        FROM checkout_payments payment
        JOIN selected_checkouts checkout
          ON checkout.id = payment.checkout_id
         AND checkout.shop_id = payment.shop_id
        WHERE payment.shop_id = $1
        GROUP BY payment.shop_id, payment.checkout_id
      ),
      audit_projection AS (
        SELECT
          audit.shop_id,
          audit.checkout_id,
          COUNT(*) FILTER (
            WHERE audit.event_type = 'refund'
          )::TEXT AS refund_audit_count,
          COUNT(*) FILTER (
            WHERE audit.event_type = 'void'
          )::TEXT AS void_audit_count
        FROM checkout_financial_audit audit
        JOIN selected_checkouts checkout
          ON checkout.id = audit.checkout_id
         AND checkout.shop_id = audit.shop_id
         AND checkout.appointment_id = audit.appointment_id
        WHERE audit.shop_id = $1
        GROUP BY audit.shop_id, audit.checkout_id
      )
      SELECT
        a.id,
        a.appointment_no,
        a.start_at,
        a.end_at,
        a.status,
        a.booking_source,
        a.internal_notes,

        a.customer_id,
        a.booker_customer_id,
        a.recipient_customer_id,
        a.booker_name_snapshot,
        a.booker_phone_snapshot,
        a.booker_email_snapshot,
        a.recipient_name_snapshot,
        a.recipient_phone_snapshot,
        a.recipient_email_snapshot,

        c.name AS customer_name,
        c.phone AS customer_phone,
        c.email AS customer_email,
        c.member_code,
        c.identity_status,
        c.profile_notes,

        s.name AS service_name,
        s.duration_minutes,
        s.price,

        st.name AS staff_name,
        st.staff_code,
        COALESCE(item_projection.items, '[]'::JSON) AS items,
        COALESCE(
          legacy_assignment_projection.staff_assignments,
          '[]'::JSON
        ) AS staff_assignments,

        checkout.id AS checkout_id,
        checkout.status AS checkout_status,
        checkout.currency_code,
        checkout.quote_total_minor::TEXT AS checkout_quote_total_minor,
        checkout.actual_total_minor::TEXT AS checkout_actual_total_minor,
        checkout.discount_total_minor::TEXT AS checkout_discount_total_minor,
        checkout.final_due_minor::TEXT AS checkout_final_due_minor,
        checkout.paid_minor::TEXT AS checkout_recorded_paid_minor,
        checkout_line_projection.line_item_count,
        checkout_line_projection.line_quote_total_minor,
        checkout_line_projection.line_actual_total_minor,
        checkout_line_projection.line_discount_total_minor,
        checkout_line_projection.line_final_total_minor,
        COALESCE(payment_projection.payment_total_minor, '0')
          AS payment_total_minor,
        COALESCE(payment_projection.refund_total_minor, '0')
          AS refund_total_minor,
        COALESCE(audit_projection.refund_audit_count, '0')
          AS refund_audit_count,
        COALESCE(audit_projection.void_audit_count, '0')
          AS void_audit_count

      FROM selected_appointments a

      JOIN customers c
        ON c.id = a.customer_id
       AND c.shop_id = a.shop_id

      JOIN services s
        ON s.id = a.service_id
       AND s.shop_id = a.shop_id

      JOIN staff st
        ON st.id = a.staff_id
       AND st.shop_id = a.shop_id

      JOIN locations l
        ON l.id = a.location_id
       AND l.shop_id = a.shop_id

      LEFT JOIN item_projection
        ON item_projection.shop_id = a.shop_id
       AND item_projection.location_id = a.location_id
       AND item_projection.appointment_id = a.id

      LEFT JOIN legacy_assignment_projection
        ON legacy_assignment_projection.shop_id = a.shop_id
       AND legacy_assignment_projection.location_id = a.location_id
       AND legacy_assignment_projection.appointment_id = a.id

      LEFT JOIN selected_checkouts checkout
        ON checkout.shop_id = a.shop_id
       AND checkout.appointment_id = a.id

      LEFT JOIN checkout_line_projection
        ON checkout_line_projection.shop_id = checkout.shop_id
       AND checkout_line_projection.checkout_id = checkout.id

      LEFT JOIN payment_projection
        ON payment_projection.shop_id = checkout.shop_id
       AND payment_projection.checkout_id = checkout.id

      LEFT JOIN audit_projection
        ON audit_projection.shop_id = checkout.shop_id
       AND audit_projection.checkout_id = checkout.id

      ORDER BY a.start_at DESC
    `, [
      trustedShopId,
      requestedLocationId || null
    ]);

    res.json({
      success: true,
      data: result.rows.map(row =>
        projectOwnerAppointmentCheckout(row, {
          role: req.ownerAuth.role,
          checkoutWriteEnabled:
            process.env.CHECKOUT_WRITE_ENABLED === 'true'
        })
      )
    });

  } catch (error) {
    console.error(
      'Read appointments error:',
      safeStaffAuthErrorCode(error)
    );

    res.status(500).json({
      success: false,
      message: '读取数据库预约失败'
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});


// ==================================================
// 配置数据
// ==================================================

const CONFIG = {
  shopName: 'GG-Beauty',
  currency: 'S$',

  services: [
    // 面部护理
    {
      id: 101,
      name: '深层清洁',
      duration: 60,
      price: 68,
      category: 'beauty'
    },
    {
      id: 102,
      name: '补水护理',
      duration: 60,
      price: 78,
      category: 'beauty'
    },
    {
      id: 103,
      name: '抗皱紧致',
      duration: 60,
      price: 88,
      category: 'beauty'
    },
    {
      id: 104,
      name: '美白提亮',
      duration: 60,
      price: 82,
      category: 'beauty'
    },
    {
      id: 105,
      name: '水光针导入',
      duration: 60,
      price: 98,
      category: 'beauty'
    },
    {
      id: 106,
      name: '眼部护理',
      duration: 45,
      price: 58,
      category: 'beauty'
    },
    {
      id: 107,
      name: '颈部护理',
      duration: 45,
      price: 55,
      category: 'beauty'
    },

    // 身体护理
    {
      id: 201,
      name: '全身按摩',
      duration: 60,
      price: 75,
      category: 'wellness'
    },
    {
      id: 202,
      name: '背部舒压',
      duration: 60,
      price: 70,
      category: 'wellness'
    },
    {
      id: 203,
      name: '推拿理疗',
      duration: 60,
      price: 80,
      category: 'wellness'
    },
    {
      id: 204,
      name: '美白身体护理',
      duration: 60,
      price: 85,
      category: 'wellness'
    },
    {
      id: 205,
      name: '纤体塑形',
      duration: 60,
      price: 90,
      category: 'wellness'
    },
    {
      id: 206,
      name: '经络疏通',
      duration: 75,
      price: 95,
      category: 'wellness'
    },
    {
      id: 207,
      name: '热石疗法',
      duration: 75,
      price: 100,
      category: 'wellness'
    },

    // 手足护理
    {
      id: 301,
      name: '手部护理',
      duration: 60,
      price: 60,
      category: 'wellness'
    },
    {
      id: 302,
      name: '足部护理',
      duration: 60,
      price: 65,
      category: 'wellness'
    },
    {
      id: 303,
      name: '美甲护理',
      duration: 60,
      price: 70,
      category: 'wellness'
    },
    {
      id: 304,
      name: '深层滋润',
      duration: 75,
      price: 75,
      category: 'wellness'
    },
    {
      id: 305,
      name: '精致美甲',
      duration: 90,
      price: 95,
      category: 'wellness'
    },
    {
      id: 306,
      name: '指甲修复',
      duration: 60,
      price: 68,
      category: 'wellness'
    }
  ],

  staff: [
    'Lily',
    'Coco',
    'Mia'
  ],

  businessHours: {
    start: '10:00',
    end: '21:00'
  }
};


// ==================================================
// 旧版内存预约数据
// 暂时保留，不删除
// ==================================================

let bookings = [];
let bookingIdCounter = 1000;


// ==================================================
// 管理员会话
// ==================================================

let adminSession = {};


// ==================================================
// 基础 API
// ==================================================

app.get('/api/config', (req, res) => {
  res.json({
    success: true,
    data: CONFIG
  });
});


// ==================================================
// 旧版预约读取 API 已退役：它们基于内存数据，且不具备现代的
// 身份认证、店铺隔离或 PII 保护。正式预约流程使用 /api/booking/*；
// 老板端使用受 owner session 保护的 /api/appointments-db。
// ==================================================

app.get(
  [
    '/api/bookings',
    '/api/bookings/:id',
    '/api/bookings/phone/:phone'
  ],
  (_req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(410).json({
      success: false,
      code: 'LEGACY_BOOKINGS_RETIRED',
      message: '旧版预约读取接口已停用'
    });
  }
);


// ==================================================
// 旧版新增预约
// 暂时保留
// ==================================================

app.post('/api/new', (req, res) => {
  const {
    service,
    staff,
    customerName,
    phone,
    email,
    date,
    time
  } = req.body;

  if (
    !service ||
    !staff ||
    !customerName ||
    !phone ||
    !isValidCalendarDate(date) ||
    !isValidClockTime(time)
  ) {
    return res.status(400).json({
      success: false,
      message: '请完整填写所有必填信息'
    });
  }

  const existingBooking = bookings.find(
    b =>
      b.date === date &&
      b.time === time &&
      b.staff === staff
  );

  if (existingBooking) {
    return res.status(409).json({
      success: false,
      message: '该时间段已被预约，请选择其他时间'
    });
  }

  const booking = {
    id: bookingIdCounter++,
    service,
    staff,
    customerName,
    phone,
    email: email || '',
    date,
    time,
    status: 'Pending',
    createdAt: new Date().toISOString(),
    bookingNumber:
      `GG-${String(bookingIdCounter).padStart(4, '0')}`
  };

  bookings.unshift(booking);

  res.json({
    success: true,
    message: '预约成功！',
    data: booking
  });
});


// ==================================================
// 新版预约 API
// 写入 Supabase PostgreSQL
// ==================================================

const loadMultiServiceContext = async (client, { shopSlug, items, locale }) => {
  const scope = await loadTrustedCustomerBookingScope(client, shopSlug);
  if (!scope) throw new AppointmentMutationError('shop_not_found', 400, '找不到店铺');
  const ids = [...new Set(items.map(item => item.serviceId))];
  const result = await client.query(
    `SELECT service.id,service.duration_minutes,service.price,service.price_is_from,
       service.category_id,
       COALESCE(requested.name,english.name,chinese.name,service.name) AS localized_name
     FROM services service
     JOIN service_categories category ON category.shop_id=service.shop_id
       AND category.id=service.category_id AND category.is_active=TRUE
     LEFT JOIN service_translations requested ON requested.shop_id=service.shop_id
       AND requested.service_id=service.id AND requested.locale=$3
     LEFT JOIN service_translations english ON english.shop_id=service.shop_id
       AND english.service_id=service.id AND english.locale='en'
     LEFT JOIN service_translations chinese ON chinese.shop_id=service.shop_id
       AND chinese.service_id=service.id AND chinese.locale='zh-CN'
     WHERE service.shop_id=$1 AND service.id=ANY($2::UUID[])
       AND service.is_active=TRUE AND service.bookable=TRUE
       AND ${QUALIFIED_SERVICE_STAFF_EXISTS_SQL}`,
    [scope.shop_id, ids, locale]
  );
  if (result.rows.length !== ids.length) throw new AppointmentMutationError('service_not_found', 400, '找不到服务项目');
  if (result.rows.some(service => !Number.isInteger(Number(service.duration_minutes)) || Number(service.duration_minutes) <= 0 ||
    service.price === null || !Number.isFinite(Number(service.price)) || Number(service.price) < 0 || !service.localized_name)) {
    throw new AppointmentMutationError('service_snapshot_invalid', 409, '服务资料暂不可预约');
  }
  const byId = new Map(result.rows.map(row => [row.id, row]));
  return {
    scope,
    services: items.map(item => {
      const service = byId.get(item.serviceId);
      return { ...item, serviceId: service.id, duration_minutes: service.duration_minutes,
        durationMinutes: service.duration_minutes, price: service.price,
        priceIsFrom: service.price_is_from, localizedName: service.localized_name,
        categoryId: service.category_id };
    })
  };
};

const planMultiServiceStaff = async ({ client, scope, date, timeline, validator, candidatesByService = null }) => {
  const candidates = candidatesByService || new Map();
  for (const serviceId of [...new Set(timeline.map(item => item.serviceId))]) {
    if (candidates.has(serviceId)) continue;
    candidates.set(serviceId, await loadEligibleBookingStaff(client, {
      shopId: scope.shop_id, locationId: scope.location_id, serviceId, date
    }));
  }
  return planStaffAssignments({
    items: timeline,
    candidatesByService: candidates,
    validate: async (item, staffId) => {
      try {
        await validator({ dbClient: client, shopId: scope.shop_id,
          locationId: scope.location_id, staffId, serviceId: item.serviceId,
          requestedStartAt: item.startAt, requestedEndAt: item.endAt });
      } catch (error) {
        if (error instanceof StaffBookabilityError && UNAVAILABLE_SLOT_ERROR_CODES.has(error.code)) {
          const unavailable = new Error(error.code); unavailable.unavailable = true; throw unavailable;
        }
        throw error;
      }
    }
  });
};

const createMultiServiceBooking = async (req,verifiedSession=null) => {
  const body = req.body;
  const items = normalizeBookingItems(body, isUuid);
  const locale = normalizeLocale(body.locale);
  const parsedStart = parseStrictIsoInstant(body.startAt);
  if (!parsedStart || !body.shopSlug || !body.customerName || !body.phone) {
    throw new AppointmentMutationError('booking_input_invalid', 400, '请完整填写所有必填信息');
  }
  return runInTransaction(req.app.locals.bookingPool, async client => {
    const serverNow = req.app.locals.bookingNow || new Date();
    if (parsedStart.getTime() <= serverNow.getTime()) {
      throw new AppointmentMutationError('booking_time_in_past', 400, '所选时间已过，无法预约');
    }
    const { scope, services } = await loadMultiServiceContext(client, { shopSlug: body.shopSlug, items, locale });
    const timeline = buildSequentialTimeline(services, parsedStart.toISOString());
    const businessDate = new Intl.DateTimeFormat('en-CA', {
      timeZone: scope.timezone || 'Asia/Singapore', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(parsedStart);
    const planned = await planMultiServiceStaff({ client, scope,
      date: businessDate, timeline, validator: req.app.locals.bookingValidator });
    if (!planned) throw new StaffBookabilityError('NO_AVAILABLE_STAFF');

    let parties;
    try {
      parties = await resolveBookingParties(client, { shopId: scope.shop_id, body,verifiedSession });
    } catch (error) {
      if (error instanceof CustomerIdentityError) {
        throw new AppointmentMutationError(error.code, 409, '顾客联系方式无法唯一识别');
      }
      throw error;
    }
    const first = planned[0], last = planned[planned.length - 1];
    const appointmentResult = await client.query(
      `INSERT INTO appointments (
         shop_id,location_id,customer_id,booker_customer_id,recipient_customer_id,
         booker_name_snapshot,booker_phone_snapshot,booker_email_snapshot,
         recipient_name_snapshot,recipient_phone_snapshot,recipient_email_snapshot,
         service_id,staff_id,start_at,end_at,status,booking_source
       )
       VALUES ($1,$2,$3,$4,$3,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'pending','online')
       RETURNING id,shop_id,location_id,customer_id,service_id,staff_id,appointment_no,start_at,end_at,status,created_at`,
      [scope.shop_id, scope.location_id, parties.recipient.customerId, parties.booker.customerId,
       parties.bookerDraft.name, parties.booker.phone, parties.bookerDraft.email,
       parties.recipientDraft.name, parties.recipient.phone, parties.recipientDraft.email,
       first.serviceId, first.staffId, first.startAt, last.endAt]
    );
    if (appointmentResult.rows.length !== 1) throw new AppointmentMutationError('appointment_insert_mismatch', 500, '预约创建失败');
    await createMultiServiceRows(client, { appointment: appointmentResult.rows[0], items: planned, serviceLocale: locale });
    return { appointment: appointmentResult.rows[0], items: planned };
  });
};

app.post('/api/new-db', async (req, res) => {
  if (
    process.env.BOOKING_WRITE_MAINTENANCE ===
    'true'
  ) {
    return res.status(503).json({
      error: 'Booking temporarily unavailable',
      code: 'BOOKING_MAINTENANCE'
    });
  }

  if (['customerId', 'customer_id', 'bookerCustomerId', 'booker_customer_id',
    'recipientCustomerId', 'recipient_customer_id'].some(key => req.body?.[key] !== undefined ||
      req.body?.recipient?.[key] !== undefined || req.body?.booker?.[key] !== undefined)) {
    return res.status(400).json({ success: false, message: 'Invalid customer identity' });
  }

  let verifiedSession=null;
  const sessionToken=customerCookie(req);
  if(sessionToken){
    try{verifiedSession=await customerMemberIdentity.authenticate(sessionToken);}
    catch(error){return customerIdentityError(res,error);}
  }

  const canonicalItemsRequest = Array.isArray(req.body.items) ||
    (req.body.items === undefined && req.body.startAt !== undefined);
  if (canonicalItemsRequest) {
    if (req.body.shopId !== undefined || req.body.shop_id !== undefined) {
      return res.status(400).json({ success: false, message: 'Invalid shop context' });
    }
    try {
      const created = await createMultiServiceBooking(req,verifiedSession);
      return res.json({ success: true, message: '预约成功', data: {
        id: created.appointment.id, appointment_no: created.appointment.appointment_no,
        start_at: created.appointment.start_at, end_at: created.appointment.end_at,
        status: created.appointment.status, created_at: created.appointment.created_at,
        items: created.items
      }});
    } catch (error) {
      console.error('Create multi-service appointment error:', safeStaffAuthErrorCode(error));
      const unavailable = error instanceof StaffBookabilityError || error instanceof MultiServicePlanningError;
      const status = error.code === '23P01' || unavailable ? 409
        : error instanceof AppointmentMutationError ? error.status : 500;
      return res.status(status).json({ success: false,
        message: error.code === '23P01' || unavailable ? '该时间暂不可预约'
          : error instanceof AppointmentMutationError ? error.publicMessage : '预约失败',
        ...(error.code === '23P01' || unavailable ? { code: 'BOOKING_NOT_AVAILABLE' } : {}) });
    }
  }

  const {
    shopSlug,
    serviceId,
    service,
    locale: requestedLocale,
    staff,
    staffId: requestedStaffId,
    staffSelectionType = requestedStaffId ? 'specific' : undefined,
    customerName,
    phone,
    email,
    date,
    time
  } = req.body;

  const noPreference = staffSelectionType === 'no_preference';

  if (
    !shopSlug ||
    (!serviceId && !service) ||
    (!noPreference && !requestedStaffId && !staff) ||
    !['specific', 'no_preference', undefined].includes(staffSelectionType) ||
    !customerName ||
    !phone ||
    !date ||
    !time
  ) {
    return res.status(400).json({
      success: false,
      message: '请完整填写所有必填信息'
    });
  }

  if (serviceId !== undefined && !isUuid(serviceId)) {
    return res.status(400).json({
      success: false,
      message: '服务项目无效'
    });
  }

  if (requestedStaffId !== undefined && !isUuid(requestedStaffId)) {
    return res.status(400).json({ success: false, message: '员工无效' });
  }

  const serviceLocale = normalizeLocale(requestedLocale);

  try {
    const appointment = await runInTransaction(
      req.app.locals.bookingPool,
      async client => {
        // 1. 找店铺
        const shopResult = await client.query(
          `
          SELECT id
          FROM shops
          WHERE slug = $1
            AND status = 'active'
          LIMIT 1
          `,
          [shopSlug]
        );

        if (shopResult.rows.length === 0) {
          throw new AppointmentMutationError(
            'shop_not_found',
            400,
            '找不到店铺'
          );
        }

        const shopId = shopResult.rows[0].id;

        // 2. 找营业地点
        const locationResult = await client.query(
          `
          SELECT id
          FROM locations
          WHERE shop_id = $1
            AND is_active = true
          ORDER BY created_at ASC
          LIMIT 1
          `,
          [shopId]
        );

        if (locationResult.rows.length === 0) {
          throw new AppointmentMutationError(
            'location_not_found',
            400,
            '找不到营业地点'
          );
        }

        const locationId =
          locationResult.rows[0].id;

        // 3. 找服务项目，并取得可信快照来源
        const serviceResult = await client.query(
          `
          SELECT
            service.id,
            service.name,
            service.duration_minutes,
            service.price,
            COALESCE(requested.name, english.name, chinese.name, service.name) AS localized_name,
            COALESCE(requested.description, english.description, chinese.description, service.description) AS localized_description
          FROM services AS service
          LEFT JOIN service_translations AS requested
            ON requested.shop_id = service.shop_id
           AND requested.service_id = service.id
           AND requested.locale = $4
          LEFT JOIN service_translations AS english
            ON english.shop_id = service.shop_id
           AND english.service_id = service.id
           AND english.locale = 'en'
          LEFT JOIN service_translations AS chinese
            ON chinese.shop_id = service.shop_id
           AND chinese.service_id = service.id
           AND chinese.locale = 'zh-CN'
          WHERE service.shop_id = $1
            AND (
              ($2::UUID IS NOT NULL AND service.id = $2::UUID)
              OR ($2::UUID IS NULL AND service.name = $3)
            )
          LIMIT 1
          `,
          [shopId, serviceId || null, service || null, serviceLocale]
        );

        if (serviceResult.rows.length === 0) {
          throw new AppointmentMutationError(
            'service_not_found',
            400,
            '找不到服务项目'
          );
        }

        const selectedService =
          serviceResult.rows[0];
        const durationMinutes =
          selectedService.duration_minutes;

        if (
          !Number.isInteger(durationMinutes) ||
          durationMinutes <= 0
        ) {
          throw new AppointmentMutationError(
            'service_duration_invalid',
            409,
            '服务时长暂不可用'
          );
        }

        // 4. 找员工
        const staffResult = noPreference ? { rows: [] } : await client.query(
          `
          SELECT id
          FROM staff
          WHERE shop_id = $1
            AND (
              ($2::UUID IS NOT NULL AND id = $2::UUID)
              OR ($2::UUID IS NULL AND name = $3)
            )
          LIMIT 1
          `,
          [shopId, requestedStaffId || null, staff || null]
        );

        if (!noPreference && staffResult.rows.length === 0) {
          throw new AppointmentMutationError(
            'staff_not_found',
            400,
            '找不到员工'
          );
        }

        let staffId = noPreference ? null : staffResult.rows[0].id;

        // 5. PostgreSQL derives the authoritative interval from the
        // server-selected location timezone and service duration.
        const intervalResult = await client.query(
          `
          WITH interval_scope AS (
            SELECT
              ($3::DATE + $4::TIME)
                AT TIME ZONE location.timezone AS start_at
            FROM locations AS location
            WHERE location.id = $1::UUID
              AND location.shop_id = $2::UUID
              AND location.is_active = TRUE
          )
          SELECT
            TO_CHAR(
              start_at AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS start_at,
            TO_CHAR(
              (
                start_at +
                $5::INTEGER * INTERVAL '1 minute'
              ) AT TIME ZONE 'UTC',
              'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
            ) AS end_at
          FROM interval_scope
          `,
          [
            locationId,
            shopId,
            date,
            time,
            durationMinutes
          ]
        );

        if (intervalResult.rows.length !== 1) {
          throw new AppointmentMutationError(
            'booking_scope_invalid',
            400,
            '预约资料无效'
          );
        }

        const startAt =
          intervalResult.rows[0].start_at;
        const endAt =
          intervalResult.rows[0].end_at;

        const serverNow = req.app.locals.bookingNow || new Date();
        if (new Date(startAt).getTime() <= serverNow.getTime()) {
          throw new AppointmentMutationError('booking_time_in_past', 400, '所选时间已过，无法预约');
        }

        if (noPreference) {
          const staffCandidates = await loadEligibleBookingStaff(client, {
            shopId,
            locationId,
            serviceId: selectedService.id,
            date
          });
          for (const candidate of staffCandidates) {
            try {
              await req.app.locals.bookingValidator({
                dbClient: client,
                shopId,
                locationId,
                staffId: candidate.staff_id,
                serviceId: selectedService.id,
                requestedStartAt: startAt,
                requestedEndAt: endAt
              });
              staffId = candidate.staff_id;
              break;
            } catch (error) {
              if (error instanceof StaffBookabilityError && UNAVAILABLE_SLOT_ERROR_CODES.has(error.code)) continue;
              throw error;
            }
          }
          if (!staffId) throw new StaffBookabilityError('NO_AVAILABLE_STAFF');
        } else {
          await req.app.locals.bookingValidator({
            dbClient: client,
            shopId,
            locationId,
            staffId,
            serviceId: selectedService.id,
            requestedStartAt: startAt,
            requestedEndAt: endAt
          });
        }

        // 6. Validator passed before any customer or appointment write.
        let parties;
        try {
          parties = await resolveBookingParties(client, { shopId, body: req.body,verifiedSession });
        } catch (error) {
          if (error instanceof CustomerIdentityError) {
            throw new AppointmentMutationError(error.code, 409, '顾客联系方式无法唯一识别');
          }
          throw error;
        }
        // 7. 原子创建 parent + item + primary assignment. The parent DB
        // exclusion constraint remains the final concurrency guard.
        const appointmentResult = await client.query(
          `
          INSERT INTO appointments (
            shop_id,
            location_id,
            customer_id,
            booker_customer_id,
            recipient_customer_id,
            booker_name_snapshot,
            booker_phone_snapshot,
            booker_email_snapshot,
            recipient_name_snapshot,
            recipient_phone_snapshot,
            recipient_email_snapshot,
            service_id,
            staff_id,
            start_at,
            end_at,
            status,
            booking_source
          )
          VALUES (
            $1, $2, $3, $4, $3, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
            'pending',
            'online'
          )
          RETURNING
            id,
            shop_id,
            location_id,
            customer_id,
            service_id,
            staff_id,
            appointment_no,
            start_at,
            end_at,
            status,
            created_at
          `,
          [
            shopId,
            locationId,
            parties.recipient.customerId,
            parties.booker.customerId,
            parties.bookerDraft.name,
            parties.booker.phone,
            parties.bookerDraft.email,
            parties.recipientDraft.name,
            parties.recipient.phone,
            parties.recipientDraft.email,
            selectedService.id,
            staffId,
            startAt,
            endAt
          ]
        );

        const createdAppointment =
          appointmentResult.rows[0];

        await createSingleServiceCompatibilityRows(
          client,
          {
            appointment: createdAppointment,
            service: {
              ...selectedService,
              name: selectedService.localized_name
            },
            serviceLocale
          }
        );

        return createdAppointment;
      }
    );

    res.json({
      success: true,
      message: '预约成功',
      data: {
        id: appointment.id,
        appointment_no: appointment.appointment_no,
        start_at: appointment.start_at,
        end_at: appointment.end_at,
        status: appointment.status,
        created_at: appointment.created_at
      }
    });
  } catch (error) {
    console.error(
      'Create appointment error:',
      safeStaffAuthErrorCode(error)
    );

    const isCollision = error.code === '23P01';
    const isExpectedBookabilityFailure =
      error instanceof StaffBookabilityError &&
      UNAVAILABLE_SLOT_ERROR_CODES.has(error.code);
    const status = isCollision
      ? 409
      : isExpectedBookabilityFailure
        ? 409
      : error instanceof AppointmentMutationError
        ? error.status
        : 500;
    const message = isCollision
      ? '该时间段已被预约，请选择其他时间'
      : isExpectedBookabilityFailure
        ? '该时间暂不可预约'
      : error instanceof AppointmentMutationError
        ? error.publicMessage
        : '预约失败';

    const response = {
      success: false,
      message
    };

    if (isExpectedBookabilityFailure) {
      response.code = 'BOOKING_NOT_AVAILABLE';
    }

    res.status(status).json(response);
  }
});


// ==================================================
// 旧版可预约时间
// 暂时保留
// ==================================================

app.get('/api/available-times', (req, res) => {
  const {
    date,
    staff
  } = req.query;

  const allTimes = [
    '10:00', '10:30',
    '11:00', '11:30',
    '12:00', '12:30',
    '13:00', '13:30',
    '14:00', '14:30',
    '15:00', '15:30',
    '16:00', '16:30',
    '17:00', '17:30',
    '18:00', '18:30',
    '19:00', '19:30',
    '20:00', '20:30'
  ];

  if (date && staff) {
    const bookedTimes = bookings
      .filter(
        b =>
          b.date === date &&
          b.staff === staff
      )
      .map(
        b => b.time
      );

    const availableTimes =
      allTimes.filter(
        t => !bookedTimes.includes(t)
      );

    res.json({
      success: true,
      data: availableTimes
    });

  } else {
    res.json({
      success: true,
      data: allTimes
    });
  }
});


// ==================================================
// 新版可预约时间 API
// 从 Supabase PostgreSQL 查询
// ==================================================

const UNAVAILABLE_SLOT_ERROR_CODES = new Set([
  'STAFF_NOT_BOOKABLE',
  'SERVICE_NOT_BOOKABLE',
  'STAFF_SERVICE_NOT_ALLOWED',
  'STAFF_LOCATION_NOT_ASSIGNED',
  'NO_WORKING_HOURS',
  'OUTSIDE_WORKING_HOURS',
  'STAFF_ON_LEAVE',
  'SCHEDULE_OVERRIDE_PENDING',
  'SCHEDULE_CONFIGURATION_INVALID',
  'APPOINTMENT_COLLISION',
  'NO_AVAILABLE_STAFF'
]);

const isValidCalendarDate = value => {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value)
  ) {
    return false;
  }

  const [year, month, day] =
    value.split('-').map(Number);
  const parsed = new Date(
    Date.UTC(year, month - 1, day)
  );

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
};

const isValidClockTime = value =>
  typeof value === 'string' &&
  /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);

const filterBookableCandidateSlots = async ({
  dbClient,
  candidates,
  shopId,
  locationId,
  staffId,
  serviceId,
  validator = validateStaffBookability
}) => {
  const availableTimes = [];

  for (const candidate of candidates) {
    // Mirror the final database exclusion predicate. It is intentionally
    // staff-wide, so availability never advertises a slot the DB will reject.
    if (candidate.has_database_guard_collision === true) {
      continue;
    }

    try {
      await validator({
        dbClient,
        shopId,
        locationId,
        staffId,
        serviceId,
        requestedStartAt: candidate.start_at,
        requestedEndAt: candidate.end_at
      });

      availableTimes.push(candidate.time);
    } catch (error) {
      if (
        error instanceof StaffBookabilityError &&
        UNAVAILABLE_SLOT_ERROR_CODES.has(error.code)
      ) {
        continue;
      }

      throw error;
    }
  }

  return availableTimes;
};

// Phase-one customer location boundary: resolve the tenant from its public
// slug, then select that tenant's first active location. A future locationId
// may be added here only after validating it against the resolved shop.
const loadTrustedCustomerBookingScope = async (dbClient, shopSlug) => {
  const result = await dbClient.query(
    `
    SELECT shop.id AS shop_id, shop.slug AS shop_slug, shop.name AS shop_name, location.id AS location_id,
      location.timezone
    FROM shops AS shop
    JOIN LATERAL (
      SELECT id, timezone
      FROM locations
      WHERE shop_id = shop.id AND is_active = TRUE
      ORDER BY created_at ASC
      LIMIT 1
    ) AS location ON TRUE
    WHERE shop.slug = $1 AND shop.status = 'active'
    LIMIT 1
    `,
    [shopSlug]
  );
  const row = result.rows[0] || null;
  if (row) {
    recordShopSlugMapping(row.shop_slug, row.shop_id);
  }
  return row;
};

app.get('/api/booking/context', async (req, res) => {
  const shopSlug = typeof req.query.shopSlug === 'string' ? req.query.shopSlug.trim().toLowerCase() : '';
  setPublicBookingNoCacheHeaders(res, shopSlug);
  if (req.query.shopId !== undefined || req.query.shop_id !== undefined || req.query.tenantId !== undefined) {
    return res.status(400).json({ success: false, message: 'Invalid shop context' });
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(shopSlug) || shopSlug.length > 100) {
    return res.status(400).json({ success: false, message: 'Invalid shop context' });
  }

  let client;
  try {
    client = await req.app.locals.bookingPool.connect();
    const scope = await loadTrustedCustomerBookingScope(client, shopSlug);
    if (!scope) return res.status(404).json({ success: false, message: 'Shop is unavailable' });
    return res.json({ success: true, data: { shopSlug: scope.shop_slug, shopName: scope.shop_name } });
  } catch (error) {
    console.error('Resolve customer shop context error:', safeStaffAuthErrorCode(error));
    return res.status(500).json({ success: false, message: 'Unable to resolve shop context' });
  } finally {
    if (client) client.release();
  }
});

const loadEligibleBookingStaff = async (
  dbClient,
  { shopId, locationId, serviceId, date = null }
) => {
  const result = await dbClient.query(
    `
    SELECT
      member.id AS staff_id,
      member.name AS display_name,
      COUNT(DISTINCT busy_item.appointment_id) FILTER (
        WHERE busy.blocks_time = TRUE
          AND ($4::DATE IS NULL OR (busy.start_at AT TIME ZONE location.timezone)::DATE = $4::DATE)
      )::INTEGER AS assigned_appointment_count
    FROM services AS service
    JOIN service_categories AS category
      ON category.shop_id = service.shop_id
     AND category.id = service.category_id
     AND category.is_active = TRUE
    JOIN staff_services AS capability
      ON capability.shop_id = service.shop_id
     AND capability.service_id = service.id
     AND capability.is_active = TRUE
    JOIN staff AS member
      ON member.shop_id = capability.shop_id
     AND member.id = capability.staff_id
     AND member.is_active = TRUE
     AND member.bookable = TRUE
    JOIN staff_location_assignments AS location_assignment
      ON location_assignment.shop_id = member.shop_id
     AND location_assignment.staff_id = member.id
     AND location_assignment.location_id = $2::UUID
     AND location_assignment.is_active = TRUE
    JOIN locations AS location
      ON location.shop_id = service.shop_id
     AND location.id = location_assignment.location_id
     AND location.is_active = TRUE
    LEFT JOIN appointment_item_staff_assignments AS busy
      ON busy.shop_id = member.shop_id
     AND busy.staff_id = member.id
    LEFT JOIN appointment_items AS busy_item
      ON busy_item.shop_id = busy.shop_id
     AND busy_item.location_id = busy.location_id
     AND busy_item.id = busy.appointment_item_id
    WHERE service.shop_id = $1::UUID
      AND service.id = $3::UUID
      AND service.is_active = TRUE
      AND service.bookable = TRUE
      AND EXISTS (
        SELECT 1
        FROM staff_location_working_hours AS hours
        WHERE hours.shop_id = member.shop_id
          AND hours.location_id = location_assignment.location_id
          AND hours.staff_id = member.id
          AND hours.is_active = TRUE
      )
    GROUP BY member.id, member.name
    ORDER BY assigned_appointment_count ASC, member.id ASC
    LIMIT 100
    `,
    [shopId, locationId, serviceId, date]
  );
  return result.rows;
};

const filterAnyStaffCandidateSlots = async ({
  dbClient,
  candidates,
  staffCandidates,
  shopId,
  locationId,
  serviceId,
  validator = validateStaffBookability
}) => {
  const availableTimes = [];
  for (const candidate of candidates) {
    let available = false;
    for (const member of staffCandidates) {
      try {
        await validator({
          dbClient,
          shopId,
          locationId,
          staffId: member.staff_id,
          serviceId,
          requestedStartAt: candidate.start_at,
          requestedEndAt: candidate.end_at
        });
        available = true;
        break;
      } catch (error) {
        if (error instanceof StaffBookabilityError && UNAVAILABLE_SLOT_ERROR_CODES.has(error.code)) continue;
        throw error;
      }
    }
    if (available) availableTimes.push(candidate.time);
  }
  return availableTimes;
};

const CUSTOMER_BOOKING_TIMES = [
  '10:00','10:30','11:00','11:30','12:00','12:30','13:00','13:30',
  '14:00','14:30','15:00','15:30','16:00','16:30','17:00','17:30',
  '18:00','18:30','19:00','19:30','20:00','20:30'
];

const loadMultiServiceAvailableTimes = async ({ client, context, date, validator, now }) => {
  const resultByDate = await computeBatchAvailability({
    client,
    context,
    startDate: date,
    endDate: date,
    validator,
    defaultValidator: validateStaffBookability,
    loadEligibleBookingStaff,
    planMultiServiceStaff,
    bookingTimes: CUSTOMER_BOOKING_TIMES,
    earlyExitPerDate: false,
    now
  });
  return resultByDate.get(date) || [];
};

const loadMultiServiceAvailableDates = async ({ client, context, startDate, endDate, validator, now }) => {
  const resultByDate = await computeBatchAvailability({
    client,
    context,
    startDate,
    endDate,
    validator,
    defaultValidator: validateStaffBookability,
    loadEligibleBookingStaff,
    planMultiServiceStaff,
    bookingTimes: CUSTOMER_BOOKING_TIMES,
    earlyExitPerDate: true,
    now
  });
  const data = [];
  for (const [date, available] of resultByDate.entries()) {
    data.push({
      date,
      hasAvailability: available.length > 0,
      earliestStartAt: available[0]?.startAt || null
    });
  }
  return data;
};

app.post('/api/booking/multi-service-available-times', async (req, res) => {
  setPublicBookingNoCacheHeaders(res, req.body && req.body.shopSlug);
  if (req.body.shopId !== undefined || req.body.shop_id !== undefined) {
    return res.status(400).json({ success: false, message: 'Invalid shop context' });
  }
  let client;
  try {
    const items = normalizeBookingItems(req.body, isUuid);
    if (!isValidCalendarDate(req.body.date) || typeof req.body.shopSlug !== 'string') {
      return res.status(400).json({ success: false, message: '预约选项无效' });
    }
    client = await req.app.locals.bookingPool.connect();
    const locale = normalizeLocale(req.body.locale);
    const context = await loadMultiServiceContext(client, { shopSlug: req.body.shopSlug, items, locale });
    const now = req.app.locals.bookingNow || undefined;
    const available = await loadMultiServiceAvailableTimes({ client, context, date: req.body.date,
      validator: req.app.locals.bookingValidator, now });
    return res.json({ success: true, data: available });
  } catch (error) {
    console.error('Multi-service available times error:', safeStaffAuthErrorCode(error));
    if (error instanceof AppointmentMutationError || error instanceof MultiServicePlanningError) {
      return res.status(error.status || 400).json({ success: false, message: error.publicMessage || '预约选项无效' });
    }
    return res.status(500).json({ success: false, message: '获取可预约时间失败' });
  } finally {
    if (client) client.release();
  }
});

app.post('/api/booking/multi-service-available-dates', async (req, res) => {
  setPublicBookingNoCacheHeaders(res, req.body && req.body.shopSlug);
  if (req.body.shopId !== undefined || req.body.shop_id !== undefined || req.body.locationId !== undefined) {
    return res.status(400).json({ success: false, message: 'Invalid shop context' });
  }
  let client;
  try {
    const items = normalizeBookingItems(req.body, isUuid);
    const { startDate, endDate } = req.body;
    if (!isValidCalendarDate(startDate) || !isValidCalendarDate(endDate) || typeof req.body.shopSlug !== 'string') {
      return res.status(400).json({ success: false, message: '预约日期范围无效' });
    }
    const start = new Date(`${startDate}T00:00:00.000Z`);
    const end = new Date(`${endDate}T00:00:00.000Z`);
    const dayCount = Math.floor((end - start) / 86400000) + 1;
    if (dayCount < 1 || dayCount > 42) {
      return res.status(400).json({ success: false, message: '预约日期范围无效' });
    }
    client = await req.app.locals.bookingPool.connect();
    const context = await loadMultiServiceContext(client, {
      shopSlug: req.body.shopSlug, items, locale: normalizeLocale(req.body.locale)
    });
    const now = req.app.locals.bookingNow || undefined;
    const data = await loadMultiServiceAvailableDates({
      client,
      context,
      startDate,
      endDate,
      validator: req.app.locals.bookingValidator,
      now
    });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('Multi-service available dates error:', safeStaffAuthErrorCode(error));
    if (error instanceof AppointmentMutationError || error instanceof MultiServicePlanningError) {
      return res.status(error.status || 400).json({ success: false, message: error.publicMessage || '预约选项无效' });
    }
    return res.status(500).json({ success: false, message: '获取可预约日期失败' });
  } finally {
    if (client) client.release();
  }
});

app.get('/api/booking/staff-options', async (req, res) => {
  setPublicBookingNoCacheHeaders(res, req.query && req.query.shopSlug);
  const { shopSlug, serviceId } = req.query;
  if (typeof shopSlug !== 'string' || !shopSlug || !isUuid(serviceId)) {
    return res.status(400).json({ success: false, message: '预约选项无效' });
  }
  let client;
  try {
    client = await req.app.locals.bookingPool.connect();
    const scope = await loadTrustedCustomerBookingScope(client, shopSlug);
    if (!scope) return res.status(404).json({ success: false, message: '找不到预约选项' });
    const staffOptions = await loadEligibleBookingStaff(client, {
      shopId: scope.shop_id,
      locationId: scope.location_id,
      serviceId
    });
    return res.json({
      success: true,
      data: staffOptions.map(row => ({ staffId: row.staff_id, displayName: row.display_name }))
    });
  } catch (error) {
    console.error('Staff options error:', safeStaffAuthErrorCode(error));
    return res.status(500).json({ success: false, message: '获取员工选项失败' });
  } finally {
    if (client) client.release();
  }
});

app.post('/api/booking/multi-service-eligible-staff', async (req, res) => {
  setPublicBookingNoCacheHeaders(res, req.body && req.body.shopSlug);
  if (req.body.shopId !== undefined || req.body.shop_id !== undefined) {
    return res.status(400).json({ success: false, message: 'Invalid shop context' });
  }
  const { shopSlug, date, time } = req.body;
  if (!shopSlug || typeof shopSlug !== 'string' || !isValidCalendarDate(date) || !time || typeof time !== 'string') {
    return res.status(400).json({ success: false, message: '预约选项无效' });
  }
  let client;
  try {
    const rawItems = Array.isArray(req.body.items) ? req.body.items : [];
    const normalizedBody = {
      ...req.body,
      items: rawItems.map(item => ({
        staffSelectionType: 'no_preference',
        ...item
      }))
    };
    const items = normalizeBookingItems(normalizedBody, isUuid);
    client = await req.app.locals.bookingPool.connect();
    const locale = normalizeLocale(req.body.locale);
    const context = await loadMultiServiceContext(client, { shopSlug, items, locale });
    const { scope } = context;

    const instantResult = await client.query(
      `SELECT TO_CHAR((($1::DATE + $2::TIME) AT TIME ZONE location.timezone) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS start_at
       FROM locations location
       WHERE location.shop_id = $3 AND location.id = $4 AND location.is_active = TRUE`,
      [date, time, scope.shop_id, scope.location_id]
    );
    if (!instantResult.rows.length) {
      return res.status(400).json({ success: false, message: '找不到门店' });
    }
    const startAt = instantResult.rows[0].start_at;
    const timeline = buildSequentialTimeline(context.services, startAt);

    const validator = req.app.locals.bookingValidator || validateStaffBookability;
    const resultData = [];

    for (let i = 0; i < timeline.length; i++) {
      const item = timeline[i];
      const candidates = await loadEligibleBookingStaff(client, {
        shopId: scope.shop_id,
        locationId: scope.location_id,
        serviceId: item.serviceId,
        date
      });

      const eligibleStaff = [];
      for (const candidate of candidates) {
        try {
          await validator({
            dbClient: client,
            shopId: scope.shop_id,
            locationId: scope.location_id,
            staffId: candidate.staff_id,
            serviceId: item.serviceId,
            requestedStartAt: item.startAt,
            requestedEndAt: item.endAt
          });
          eligibleStaff.push({
            staffId: candidate.staff_id,
            displayName: candidate.display_name
          });
        } catch (err) {
          // Staff not available for this time slot
        }
      }

      const startObj = new Date(item.startAt);
      const endObj = new Date(item.endAt);
      const timeDisplay = `${startObj.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: scope.timezone || 'Asia/Singapore' })}–${endObj.toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: scope.timezone || 'Asia/Singapore' })}`;

      resultData.push({
        clientItemKey: item.clientItemKey,
        serviceId: item.serviceId,
        serviceName: item.localizedName || item.name,
        durationMinutes: item.durationMinutes,
        startAt: item.startAt,
        endAt: item.endAt,
        timeDisplay,
        eligibleStaff
      });
    }

    return res.json({ success: true, data: resultData });
  } catch (error) {
    console.error('Multi-service eligible staff error:', safeStaffAuthErrorCode(error));
    if (error instanceof AppointmentMutationError || error instanceof MultiServicePlanningError) {
      return res.status(error.status || 400).json({ success: false, message: error.publicMessage || '预约选项无效' });
    }
    return res.status(500).json({ success: false, message: '获取员工选项失败' });
  } finally {
    if (client) client.release();
  }
});

app.get(
  '/api/available-times-db',
  async (req, res) => {

    const {
      shopSlug,
      date,
      staff,
      staffId: requestedStaffId,
      staffSelectionType = requestedStaffId ? 'specific' : undefined,
      serviceId,
      service
    } = req.query;

    const noPreference = staffSelectionType === 'no_preference';

    if (
      typeof shopSlug !== 'string' ||
      !shopSlug ||
      (!noPreference && !requestedStaffId && (typeof staff !== 'string' || !staff)) ||
      !['specific', 'no_preference', undefined].includes(staffSelectionType) ||
      (!serviceId && (typeof service !== 'string' || !service)) ||
      !isValidCalendarDate(date)
    ) {
      return res.status(400).json({
        success: false,
        message:
          '缺少 shopSlug、date、staff 或 service'
      });
    }

    if (serviceId !== undefined && !isUuid(serviceId)) {
      return res.status(400).json({
        success: false,
        message: '服务项目无效'
      });
    }

    if (requestedStaffId !== undefined && !isUuid(requestedStaffId)) {
      return res.status(400).json({ success: false, message: '员工无效' });
    }

    let client;

    try {
      client = await req.app.locals.bookingPool.connect();

      // 1. 找店铺
      const shopResult = await client.query(
        `
        SELECT id
        FROM shops
        WHERE slug = $1
          AND status = 'active'
        LIMIT 1
        `,
        [shopSlug]
      );

      if (shopResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: '找不到预约选项'
        });
      }

      const shopId =
        shopResult.rows[0].id;


      // 2. 使用与预约创建相同的 server-side location 选择规则
      const locationResult = await client.query(
        `
        SELECT id
        FROM locations
        WHERE shop_id = $1
          AND is_active = TRUE
        ORDER BY created_at ASC
        LIMIT 1
        `,
        [shopId]
      );

      if (locationResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: '找不到预约选项'
        });
      }

      const locationId = locationResult.rows[0].id;

      // 3. Tenant-scoped lookup only; bookability is decided by the validator.
      const staffResult = noPreference ? { rows: [] } : await client.query(
        `
        SELECT id
        FROM staff
        WHERE shop_id = $1
          AND (
            ($2::UUID IS NOT NULL AND id = $2::UUID)
            OR ($2::UUID IS NULL AND name = $3)
          )
        LIMIT 1
        `,
        [
          shopId,
          requestedStaffId || null,
          staff || null
        ]
      );

      if (!noPreference && staffResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: '找不到预约选项'
        });
      }

      const staffId =
        noPreference ? null : staffResult.rows[0].id;


      // 4. Duration comes only from the tenant-scoped service row.
      const serviceResult = await client.query(
        `
        SELECT
          id,
          duration_minutes
        FROM services
        WHERE shop_id = $1
          AND (
            ($2::UUID IS NOT NULL AND id = $2::UUID)
            OR ($2::UUID IS NULL AND name = $3)
          )
        LIMIT 1
        `,
        [
          shopId,
          serviceId || null,
          service || null
        ]
      );

      if (serviceResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: '找不到预约选项'
        });
      }

      const durationMinutes =
        serviceResult.rows[0].duration_minutes;


      // 5. 保留现有 30-minute candidate grid.
      const allTimes = [
        '10:00', '10:30',
        '11:00', '11:30',
        '12:00', '12:30',
        '13:00', '13:30',
        '14:00', '14:30',
        '15:00', '15:30',
        '16:00', '16:30',
        '17:00', '17:30',
        '18:00', '18:30',
        '19:00', '19:30',
        '20:00', '20:30'
      ];


      // 6. PostgreSQL uses the authoritative location timezone to build
      // candidate instants and mirrors the DB exclusion constraint globally
      // for this trusted staff id.
      const candidateResult = await client.query(
        `
        WITH scoped_location AS (
          SELECT timezone
          FROM locations
          WHERE id = $6::UUID
            AND shop_id = $5::UUID
            AND is_active = TRUE
        ),
        candidate AS (
          SELECT
            candidate_time.time,
            (
              $1::DATE + candidate_time.time::TIME
            ) AT TIME ZONE location.timezone AS start_at
          FROM scoped_location AS location
          CROSS JOIN UNNEST($2::TEXT[])
            WITH ORDINALITY AS candidate_time(time, position)
        ),
        bounded_candidate AS (
          SELECT
            time,
            start_at,
            start_at + $3::INTEGER * INTERVAL '1 minute' AS end_at
          FROM candidate
        )
        SELECT
          time,
          TO_CHAR(
            start_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) AS start_at,
          TO_CHAR(
            end_at AT TIME ZONE 'UTC',
            'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
          ) AS end_at,
          CASE WHEN $4::UUID IS NULL THEN FALSE ELSE EXISTS (
            SELECT 1
            FROM appointment_item_staff_assignments AS assignment
            WHERE assignment.shop_id = $5::UUID
              AND assignment.staff_id = $4::UUID
              AND assignment.blocks_time = TRUE
              AND assignment.start_at < bounded_candidate.end_at
              AND assignment.end_at > bounded_candidate.start_at
          ) END AS has_database_guard_collision
        FROM bounded_candidate
        ORDER BY start_at
        `,
        [
          date,
          allTimes,
          durationMinutes,
          staffId,
          shopId,
          locationId
        ]
      );

      const staffCandidates = noPreference
        ? await loadEligibleBookingStaff(client, {
            shopId,
            locationId,
            serviceId: serviceResult.rows[0].id,
            date
          })
        : null;

      const availableTimes = noPreference
        ? await filterAnyStaffCandidateSlots({
            dbClient: client,
            candidates: candidateResult.rows,
            staffCandidates,
            shopId,
            locationId,
            serviceId: serviceResult.rows[0].id,
            validator: req.app.locals.bookingValidator
          })
        : await filterBookableCandidateSlots({
          dbClient: client,
          candidates: candidateResult.rows,
          shopId,
          locationId,
          staffId,
          serviceId: serviceResult.rows[0].id,
          validator: req.app.locals.bookingValidator
        });


      res.json({
        success: true,
        data: availableTimes
      });

    } catch (error) {
      console.error(
        'Available times DB error:',
        safeStaffAuthErrorCode(error)
      );

      if (
        error instanceof StaffBookabilityError &&
        error.code === 'BOOKABILITY_SCOPE_INVALID'
      ) {
        return res.status(404).json({
          success: false,
          message: '找不到预约选项'
        });
      }

      res.status(500).json({
        success: false,
        message:
          '获取可预约时间失败'
      });
    } finally {
      if (client) {
        client.release();
      }
    }
  }
);


// ==================================================
// 员工认证 API
// ==================================================

app.post('/api/staff/login', async (req, res) => {
  setStaffAuthNoStore(res);

  const shopIdentifier =
    typeof req.body.shopIdentifier === 'string'
      ? req.body.shopIdentifier.trim().toLowerCase()
      : '';

  const username =
    normalizeLoginIdentifier(req.body.username);

  const password =
    typeof req.body.password === 'string'
      ? req.body.password
      : '';

  if (
    !shopIdentifier ||
    !username ||
    !password ||
    shopIdentifier.length > 200 ||
    username.length > 200 ||
    password.length > 1024
  ) {
    return res.status(400).json({
      success: false,
      message: '请输入店铺、员工账号和密码'
    });
  }

  const rateLimitKey =
    staffLoginRateLimitKey(
      shopIdentifier,
      username
    );

  if (!consumeStaffLoginAttempt(rateLimitKey)) {
    return res.status(429).json({
      success: false,
      message: '登录请求过多，请稍后再试'
    });
  }

  let client;

  try {
    client = await pool.connect();
    await client.query('BEGIN');

    const accountResult = await client.query(
      `
      SELECT
        sa.id AS staff_account_id,
        sa.shop_id,
        sa.staff_id,
        sa.password_hash,
        sa.status AS account_status,
        sa.session_version,
        sa.failed_login_attempts,
        sa.locked_until,
        st.can_login,
        st.is_active AS staff_is_active
      FROM staff_accounts sa
      JOIN staff st
        ON st.id = sa.staff_id
       AND st.shop_id = sa.shop_id
      JOIN shops sh
        ON sh.id = sa.shop_id
      WHERE LOWER(sh.slug) = $1
        AND sh.status = 'active'
        AND sa.login_identifier_normalized = $2
      LIMIT 1
      FOR UPDATE OF sa, st
      `,
      [shopIdentifier, username]
    );

    const account =
      accountResult.rows[0];

    const now = new Date();

    const accountIsTemporarilyLocked =
      account &&
      account.locked_until &&
      new Date(account.locked_until) > now;

    const passwordMatches =
      await bcrypt.compare(
        password,
        account && !accountIsTemporarilyLocked
          ? account.password_hash
          : DUMMY_STAFF_PASSWORD_HASH
      );

    const accountCanLogin =
      account &&
      !accountIsTemporarilyLocked &&
      passwordMatches &&
      account.account_status === 'active' &&
      account.can_login === true &&
      account.staff_is_active === true;

    if (!accountCanLogin) {
      const shouldRecordPasswordFailure =
        account &&
        !accountIsTemporarilyLocked &&
        !passwordMatches &&
        account.account_status === 'active' &&
        account.can_login === true &&
        account.staff_is_active === true;

      if (shouldRecordPasswordFailure) {
        const previousLockExpired =
          account.locked_until &&
          new Date(account.locked_until) <= now;

        const previousFailures =
          previousLockExpired
            ? 0
            : Number(
              account.failed_login_attempts || 0
            );

        const nextFailureCount =
          previousFailures + 1;

        await client.query(
          `
          UPDATE staff_accounts
          SET
            failed_login_attempts = $1::INTEGER,
            locked_until =
              CASE
                WHEN $1::INTEGER >= $2::INTEGER
                THEN NOW() + INTERVAL '15 minutes'
                ELSE NULL
              END,
            updated_at = NOW()
          WHERE id = $3
            AND shop_id = $4
            AND staff_id = $5
          `,
          [
            nextFailureCount,
            STAFF_LOGIN_LOCK_THRESHOLD,
            account.staff_account_id,
            account.shop_id,
            account.staff_id
          ]
        );

        await client.query('COMMIT');
      } else {
        await rollbackStaffLogin(client);
      }

      return res.status(401).json({
        success: false,
        message: '员工账号或密码不正确'
      });
    }

    const assignmentResult = await client.query(
      `
      SELECT
        sla.location_id,
        sla.is_primary
      FROM staff_location_assignments sla
      JOIN locations l
        ON l.id = sla.location_id
       AND l.shop_id = sla.shop_id
      WHERE sla.shop_id = $1
        AND sla.staff_id = $2
        AND sla.is_active = TRUE
        AND l.is_active = TRUE
      ORDER BY
        sla.is_primary DESC,
        sla.created_at ASC,
        sla.id ASC
      FOR SHARE OF sla, l
      `,
      [account.shop_id, account.staff_id]
    );

    const primaryAssignments =
      assignmentResult.rows.filter(
        assignment =>
          assignment.is_primary === true
      );

    const selectedAssignment =
      primaryAssignments.length === 1
        ? primaryAssignments[0]
        : assignmentResult.rows.length === 1
          ? assignmentResult.rows[0]
          : null;

    if (!selectedAssignment) {
      await rollbackStaffLogin(client);

      return res.status(403).json({
        success: false,
        message: '员工没有有效的登录地点'
      });
    }

    const sessionToken =
      crypto.randomBytes(32).toString('base64url');

    const tokenHash =
      hashStaffSessionToken(sessionToken);

    const expiresAt =
      new Date(
        Date.now() + STAFF_SESSION_MAX_AGE_MS
      );

    await client.query(
      `
      INSERT INTO staff_sessions (
        token_hash,
        staff_account_id,
        shop_id,
        staff_id,
        location_id,
        session_version,
        expires_at,
        last_seen_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      `,
      [
        tokenHash,
        account.staff_account_id,
        account.shop_id,
        account.staff_id,
        selectedAssignment.location_id,
        account.session_version,
        expiresAt
      ]
    );

    await client.query(
      `
      UPDATE staff_accounts
      SET
        last_login_at = NOW(),
        failed_login_attempts = 0,
        locked_until = NULL,
        updated_at = NOW()
      WHERE id = $1
        AND shop_id = $2
        AND staff_id = $3
      `,
      [
        account.staff_account_id,
        account.shop_id,
        account.staff_id
      ]
    );

    await client.query('COMMIT');

    clearStaffLoginRateLimit(rateLimitKey);

    setStaffSessionCookie(res, sessionToken);

    res.json({
      success: true
    });
  } catch (error) {
    await rollbackStaffLogin(client);

    console.error(
      'Staff login error:',
      safeStaffAuthErrorCode(error)
    );

    res.status(500).json({
      success: false,
      message: '员工登录暂时不可用'
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});


app.post('/api/staff/logout', async (req, res) => {
  setStaffAuthNoStore(res);

  const token =
    parseCookies(req)[STAFF_SESSION_COOKIE];

  try {
    if (token) {
      await pool.query(
        `
        UPDATE staff_sessions
        SET
          revoked_at = COALESCE(revoked_at, NOW()),
          revoke_reason = COALESCE(
            revoke_reason,
            'staff_logout'
          )
        WHERE token_hash = $1
        `,
        [hashStaffSessionToken(token)]
      );
    }

    clearStaffSessionCookie(res);

    res.json({
      success: true
    });
  } catch (error) {
    console.error(
      'Staff logout error:',
      safeStaffAuthErrorCode(error)
    );

    res.status(500).json({
      success: false,
      message: '员工退出暂时不可用'
    });
  }
});


app.get(
  '/api/staff/me',
  requireStaffAuth,
  async (req, res) => {
    try {
      const result = await pool.query(
        `
        SELECT
          st.name AS staff_name,
          st.staff_code,
          sh.name AS shop_name,
          l.name AS location_name
        FROM staff st
        JOIN shops sh
          ON sh.id = st.shop_id
        JOIN locations l
          ON l.id = $3
         AND l.shop_id = st.shop_id
        WHERE st.id = $2
          AND st.shop_id = $1
        LIMIT 1
        `,
        [
          req.staffAuth.shopId,
          req.staffAuth.staffId,
          req.staffAuth.locationId
        ]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          success: false,
          message: '员工身份已失效'
        });
      }

      const staff = result.rows[0];

      res.json({
        success: true,
        data: {
          name: staff.staff_name,
          staffCode: staff.staff_code,
          shopName: staff.shop_name,
          locationName: staff.location_name,
          permissions:
            req.staffAuth.permissions
        }
      });
    } catch (error) {
      console.error(
        'Read staff profile error:',
        safeStaffAuthErrorCode(error)
      );

      res.status(500).json({
        success: false,
        message: '读取员工资料失败'
      });
    }
  }
);


app.get(
  '/api/staff/appointments',
  requireStaffAuth,
  async (req, res) => {
    const forbiddenIdentityParameters = [
      'staff_id',
      'staffId',
      'shop_id',
      'shopId',
      'location_id',
      'locationId',
      'role',
      'permissions'
    ];

    if (
      forbiddenIdentityParameters.some(parameter =>
        Object.prototype.hasOwnProperty.call(
          req.query,
          parameter
        )
      )
    ) {
      return res.status(400).json({
        success: false,
        message: '请求包含不允许的身份参数'
      });
    }

    const requestedDate =
      typeof req.query.date === 'string'
        ? req.query.date
        : null;

    if (requestedDate) {
      const parsedDate = new Date(
        `${requestedDate}T00:00:00.000Z`
      );

      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(
          requestedDate
        ) ||
        Number.isNaN(parsedDate.getTime()) ||
        parsedDate.toISOString().slice(0, 10) !==
          requestedDate
      ) {
        return res.status(400).json({
          success: false,
          message: '日期格式必须为 YYYY-MM-DD'
        });
      }
    }

    try {
      const activePool = req.app?.locals?.bookingPool || pool;
      const result = await activePool.query(
        `
        WITH staff_scope AS (
          SELECT
            $1::UUID AS shop_id,
            $2::UUID AS staff_id,
            $3::UUID AS location_id,
            l.timezone,
            COALESCE(
              $4::DATE,
              (
                CURRENT_TIMESTAMP
                AT TIME ZONE l.timezone
              )::DATE
            ) AS local_date
          FROM locations l
          WHERE l.id = $3::UUID
            AND l.shop_id = $1::UUID
            AND l.is_active = TRUE
        )
        SELECT
          scope.local_date::TEXT AS appointment_date,
          scope.timezone,
          COALESCE(
            (
              SELECT JSON_AGG(
                JSON_BUILD_OBJECT(
                  'id', a.id,
                  'startAt', a.start_at,
                  'endAt', a.end_at,
                  'customerName', c.name,
                  'customerPhone',
                    CASE
                      WHEN c.phone IS NULL
                      THEN NULL
                      ELSE
                        '•••••' || RIGHT(
                          REGEXP_REPLACE(
                            c.phone,
                            '[^0-9]',
                            '',
                            'g'
                          ),
                          3
                        )
                    END,
                  'serviceName', s.name,
                  'durationMinutes',
                    s.duration_minutes,
                  'status', a.status
                )
                ORDER BY a.start_at ASC, a.id ASC
              )
              FROM appointments a
              JOIN customers c
                ON c.id = a.customer_id
               AND c.shop_id = a.shop_id
              JOIN services s
                ON s.id = a.service_id
               AND s.shop_id = a.shop_id
              WHERE a.shop_id = scope.shop_id
                AND a.location_id = scope.location_id
                AND EXISTS (
                  SELECT 1
                  FROM appointment_items item
                  JOIN appointment_item_staff_assignments assignment
                    ON assignment.shop_id = item.shop_id
                   AND assignment.location_id = item.location_id
                   AND assignment.appointment_item_id = item.id
                  WHERE item.shop_id = a.shop_id
                    AND item.location_id = a.location_id
                    AND item.appointment_id = a.id
                    AND assignment.staff_id = scope.staff_id
                )
                AND a.start_at >= (
                  scope.local_date::TIMESTAMP
                  AT TIME ZONE scope.timezone
                )
                AND a.start_at < (
                  (scope.local_date + 1)::TIMESTAMP
                  AT TIME ZONE scope.timezone
                )
            ),
            '[]'::JSON
          ) AS appointments
        FROM staff_scope scope
        `,
        [
          req.staffAuth.shopId,
          req.staffAuth.staffId,
          req.staffAuth.locationId,
          requestedDate
        ]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          success: false,
          message: '员工地点已失效'
        });
      }

      const appointments = result.rows[0];

      res.set('Cache-Control', 'no-store, private, max-age=0');
      res.set('Pragma', 'no-cache');

      res.json({
        success: true,
        data: {
          server_now: new Date().toISOString(),
          date: appointments.appointment_date,
          timezone: appointments.timezone,
          appointments: appointments.appointments
        }
      });
    } catch (error) {
      console.error(
        'Read staff appointments error:',
        safeStaffAuthErrorCode(error)
      );

      res.status(500).json({
        success: false,
        message: '读取员工预约失败'
      });
    }
  }
);

app.patch('/api/staff/appointments/:appointmentId/status', requireStaffAuth, async (req, res) => {
  if (req.staffAuth.permissions.can_update_own_appointment_status !== true) {
    return res.status(403).json({ success: false, message: '没有修改预约状态的权限' });
  }
  if (!isSameOriginRequest(req) || !isUuid(req.params.appointmentId)) {
    return res.status(400).json({ success: false, message: '预约ID或请求来源不正确' });
  }
  const body = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : null;
  if (!body || !isKnownStatus(body.status)) return res.status(400).json({ success: false, message: '预约状态不正确' });
  try {
    const data = await runInTransaction(req.app.locals.bookingPool, async client => {
      await client.query("SET LOCAL lock_timeout = '5s'");
      const result = await client.query(`SELECT id,shop_id,location_id,service_id,staff_id,start_at,end_at,status,cancelled_at,service_completed_at,updated_at FROM appointments a WHERE id=$1 AND shop_id=$2 AND location_id=$4 AND EXISTS (SELECT 1 FROM appointment_items i JOIN appointment_item_staff_assignments x ON x.shop_id=i.shop_id AND x.location_id=i.location_id AND x.appointment_item_id=i.id WHERE i.shop_id=a.shop_id AND i.location_id=a.location_id AND i.appointment_id=a.id AND x.staff_id=$3) FOR UPDATE`, [req.params.appointmentId, req.staffAuth.shopId, req.staffAuth.staffId, req.staffAuth.locationId]);
      if (result.rows.length !== 1) throw new AppointmentMutationError('appointment_not_found', 404, '找不到预约');
      const appointment = result.rows[0];
      if (!isKnownStatus(appointment.status) || !canTransition(appointment.status, body.status)) throw new AppointmentMutationError('appointment_status_transition_invalid', 409, '不允许进行该预约状态变更');
      if (appointment.status === body.status) return { id: appointment.id, status: appointment.status };
      const structure = await loadAndValidatePhaseAStructure(client, appointment);
      const updated = await client.query(`UPDATE appointments SET status=$1,cancelled_at=CASE WHEN $1='cancelled' THEN NOW() ELSE cancelled_at END,service_completed_at=CASE WHEN $1='completed' THEN NOW() ELSE service_completed_at END,updated_at=NOW() WHERE id=$2 AND shop_id=$3 AND location_id=$4 RETURNING id,status,start_at,end_at,updated_at`, [body.status, appointment.id, appointment.shop_id, appointment.location_id]);
      if (updated.rows.length !== 1) throw new AppointmentMutationError('appointment_status_update_mismatch', 500, '更新预约状态失败');
      await syncAppointmentItemStatus(client, { appointment, status: body.status, expectedItemCount: structure.itemCount });
      await recordStatusHistory(client, { appointment, fromStatus: appointment.status, toStatus: body.status, operatorType: 'staff', operatorId: req.staffAuth.accountId, source: 'staff_portal', reason: typeof body.reason === 'string' ? body.reason.trim() || null : null });
      return updated.rows[0];
    });
    res.json({ success: true, data });
  } catch (error) {
    const code = safeStaffAuthErrorCode(error);
    const status = ['23P01', '55P03'].includes(code) ? 409 : error instanceof AppointmentMutationError ? error.status : 500;
    res.status(status).json({ success: false, message: error instanceof AppointmentMutationError ? error.publicMessage : '更新预约状态失败' });
  }
});


app.patch(
  '/api/staff/appointments/:appointmentId/time',
  requireStaffAuth,
  async (req, res) => {
    if (
      req.staffAuth.permissions
        .can_move_own_appointments !== true
    ) {
      return res.status(403).json({
        success: false,
        message: '没有修改预约时间的权限'
      });
    }

    if (!isSameOriginRequest(req)) {
      return res.status(403).json({
        success: false,
        message: '请求来源不允许'
      });
    }

    const appointmentId =
      req.params.appointmentId;

    if (!isUuid(appointmentId)) {
      return res.status(400).json({
        success: false,
        message: '预约ID格式不正确'
      });
    }

    const body =
      req.body &&
      typeof req.body === 'object' &&
      !Array.isArray(req.body)
        ? req.body
        : null;

    const bodyKeys = body
      ? Object.keys(body)
      : [];

    if (
      !body ||
      bodyKeys.length !== 1 ||
      bodyKeys[0] !== 'newStartAt'
    ) {
      return res.status(400).json({
        success: false,
        message: '请求只能包含 newStartAt'
      });
    }

    const newStartAt =
      parseStrictIsoInstant(body.newStartAt);

    if (!newStartAt) {
      return res.status(400).json({
        success: false,
        message: 'newStartAt 必须是带时区的 ISO 8601 时间'
      });
    }

    let client;
    let transactionActive = false;
    let transactionCommitted = false;
    let discardClient = false;
    let clientReleased = false;

    const rollbackActiveTransaction = async () => {
      if (
        !client ||
        !transactionActive ||
        transactionCommitted
      ) {
        return;
      }

      const rollbackSucceeded =
        await rollbackStaffAppointmentMove(client);

      transactionActive = false;

      if (!rollbackSucceeded) {
        discardClient = true;
      }
    };

    try {
      client = await req.app.locals.bookingPool.connect();
      await client.query('BEGIN');
      transactionActive = true;

      const appointmentResult = await client.query(
        `
        SELECT
          id,
          shop_id,
          location_id,
          service_id,
          staff_id,
          start_at,
          end_at,
          status,
          override_conflict,
          end_at > start_at AS duration_is_valid,
          start_at = $5::TIMESTAMPTZ AS is_no_op
        FROM appointments
        WHERE id = $1
          AND shop_id = $2
          AND location_id = $4
          AND EXISTS (
            SELECT 1
            FROM appointment_items participant_item
            JOIN appointment_item_staff_assignments participant_assignment
              ON participant_assignment.shop_id = participant_item.shop_id
             AND participant_assignment.location_id = participant_item.location_id
             AND participant_assignment.appointment_item_id = participant_item.id
            WHERE participant_item.shop_id = appointments.shop_id
              AND participant_item.location_id = appointments.location_id
              AND participant_item.appointment_id = appointments.id
              AND participant_assignment.staff_id = $3
          )
        FOR UPDATE
        `,
        [
          appointmentId,
          req.staffAuth.shopId,
          req.staffAuth.staffId,
          req.staffAuth.locationId,
          newStartAt
        ]
      );

      if (appointmentResult.rows.length === 0) {
        await rollbackActiveTransaction();

        return res.status(404).json({
          success: false,
          message: '找不到预约'
        });
      }

      const appointment =
        appointmentResult.rows[0];

      if (
        !['pending', 'confirmed'].includes(
          appointment.status
        )
      ) {
        await rollbackActiveTransaction();

        return res.status(409).json({
          success: false,
          message: '当前预约状态不允许修改时间'
        });
      }

      if (appointment.override_conflict === true) {
        await rollbackActiveTransaction();

        return res.status(409).json({
          success: false,
          message: '该预约不能由员工移动'
        });
      }

      if (appointment.duration_is_valid !== true) {
        await rollbackActiveTransaction();

        return res.status(409).json({
          success: false,
          message: '预约原始时长无效，无法移动'
        });
      }

      const phaseAStructure =
        await loadAndValidatePhaseAStructure(
          client,
          appointment
        );

      if (
        phaseAStructure.primaryStaffCount !== 1 ||
        phaseAStructure.solePrimaryStaffId !==
          req.staffAuth.staffId
      ) {
        await rollbackActiveTransaction();

        return res.status(409).json({
          success: false,
          message: '多员工预约不能由员工移动整笔时间'
        });
      }

      if (appointment.is_no_op === true) {
        await client.query('COMMIT');
        transactionActive = false;
        transactionCommitted = true;

        return res.json({
          success: true,
          data: {
            id: appointment.id,
            startAt: appointment.start_at,
            endAt: appointment.end_at,
            status: appointment.status
          }
        });
      }

      const moveAssignments = await client.query(
        `
        SELECT
          item.service_id,
          assignment.staff_id,
          assignment.start_at +
            ($4::TIMESTAMPTZ - $5::TIMESTAMPTZ)
            AS proposed_start_at,
          assignment.end_at +
            ($4::TIMESTAMPTZ - $5::TIMESTAMPTZ)
            AS proposed_end_at
        FROM appointment_items item
        JOIN appointment_item_staff_assignments assignment
          ON assignment.shop_id = item.shop_id
         AND assignment.location_id = item.location_id
         AND assignment.appointment_item_id = item.id
        WHERE item.shop_id = $1
          AND item.location_id = $2
          AND item.appointment_id = $3
        ORDER BY item.sequence_no, assignment.role, assignment.id
        FOR SHARE OF assignment
        `,
        [
          appointment.shop_id,
          appointment.location_id,
          appointment.id,
          newStartAt,
          appointment.start_at
        ]
      );

      if (
        moveAssignments.rows.length !==
          phaseAStructure.assignmentCount
      ) {
        throw new AppointmentMutationError(
          'appointment_move_assignment_count_mismatch',
          409,
          '预约员工结构已变化，请重试'
        );
      }

      for (const assignment of moveAssignments.rows) {
        await validateStaffBookability({
          dbClient: client,
          shopId: appointment.shop_id,
          locationId: appointment.location_id,
          staffId: assignment.staff_id,
          serviceId: assignment.service_id,
          requestedStartAt:
            new Date(assignment.proposed_start_at).toISOString(),
          requestedEndAt:
            new Date(assignment.proposed_end_at).toISOString(),
          excludeAppointmentId: appointment.id
        });
      }

      const updatedAppointment =
        await moveAppointmentStructurePrecisely(
          client,
          {
            appointment,
            newStartAt,
            expectedItemCount:
              phaseAStructure.itemCount,
            expectedAssignmentCount:
              phaseAStructure.assignmentCount,
            actorStaffId:
              req.staffAuth.staffId
          }
      );

      await client.query('COMMIT');
      transactionActive = false;
      transactionCommitted = true;

      res.json({
        success: true,
        data: {
          id: updatedAppointment.id,
          startAt: updatedAppointment.start_at,
          endAt: updatedAppointment.end_at,
          status: updatedAppointment.status
        }
      });
    } catch (error) {
      await rollbackActiveTransaction();

      const errorCode =
        safeStaffAuthErrorCode(error);

      if (errorCode === '23P01') {
        return res.status(409).json({
          success: false,
          message: '新时间与现有预约冲突'
        });
      }

      if (
        error instanceof AppointmentMutationError &&
        [400, 403, 404, 409].includes(error.status)
      ) {
        return res.status(error.status).json({
          success: false,
          message: error.publicMessage
        });
      }

      if (error instanceof StaffBookabilityError) {
        return res.status(409).json({
          success: false,
          message: '新时间不符合员工可预约规则'
        });
      }

      console.error(
        'Move staff appointment error:',
        errorCode
      );

      res.status(500).json({
        success: false,
        message: '修改预约时间失败'
      });
    } finally {
      if (client && !clientReleased) {
        clientReleased = true;
        client.release(discardClient || undefined);
      }
    }
  }
);


// ==================================================
// 管理员 API
// ==================================================

app.post('/api/admin/login', (req, res) => {
  if (
    ADMIN_PASSWORD &&
    req.body.password ===
    ADMIN_PASSWORD
  ) {
    adminSession[req.ip] = true;

    res.json({
      success: true
    });

  } else {
    res.status(401).json({
      success: false,
      message: '密码错误'
    });
  }
});


app.post('/api/admin/logout', (req, res) => {
  delete adminSession[req.ip];

  res.json({
    success: true
  });
});


// ==================================================
// 旧版修改预约状态
// 暂时保留
// ==================================================

app.post(
  '/api/admin/update-status',
  (req, res) => {

    if (!adminSession[req.ip]) {
      return res.status(401).json({
        success: false,
        message: '请先登录'
      });
    }

    const item = bookings.find(
      b => b.id === req.body.id
    );

    if (item) {
      item.status =
        req.body.status;

      res.json({
        success: true
      });

    } else {
      res.json({
        success: false,
        message: '未找到该预约'
      });
    }
  }
);


// ==================================================
// 新版修改预约状态
// 写入 Supabase PostgreSQL
// ==================================================

app.post(
  '/api/admin/update-status-db',
  requireOwnerAuth,
  requireOwnerRole(['owner', 'manager', 'admin', 'front_desk']),
  async (req, res) => {
    const trustedShopId = req.ownerAuth.shopId;
    const body =
      req.body && typeof req.body === 'object'
        ? req.body
        : {};
    const appointmentId =
      body.appointmentId || body.id;
    const status = body.status;

    const allowedStatuses = [
      'pending',
      'confirmed',
      'arrived',
      'in_service',
      'cancelled',
      'completed',
      'no_show'
    ];

    if (!appointmentId || !status) {
      return res.status(400).json({
        success: false,
        message: '缺少预约ID或状态'
      });
    }

    if (
      !isUuid(appointmentId) ||
      (
        body.appointmentId &&
        body.id &&
        body.appointmentId !== body.id
      )
    ) {
      return res.status(400).json({
        success: false,
        message: '预约ID不正确'
      });
    }

    if (
      !allowedStatuses.includes(status)
    ) {
      return res.status(400).json({
        success: false,
        message: '预约状态不正确'
      });
    }

    try {
      const updatedAppointment =
        await runInTransaction(
          app.locals.ownerAuthPool,
          async client => {
            await client.query(
              "SET LOCAL lock_timeout = '5s'"
            );

            const appointmentResult =
              await client.query(
                `
                SELECT
                  id,
                  shop_id,
                  location_id,
                  service_id,
                  staff_id,
                  start_at,
                  end_at,
                  status,
                  cancelled_at,
                  service_completed_at,
                  updated_at
                FROM appointments
                WHERE id = $1
                  AND shop_id = $2
                FOR UPDATE
                `,
                [appointmentId, trustedShopId]
              );

            if (appointmentResult.rows.length === 0) {
              throw new AppointmentMutationError(
                'appointment_not_found',
                404,
                '未找到该预约'
              );
            }

            const appointment =
              appointmentResult.rows[0];
            const phaseAStructure =
              await loadAndValidatePhaseAStructure(
                client,
                appointment
              );

            if (!isKnownStatus(appointment.status)) {
              throw new AppointmentMutationError(
                'unsupported_current_status',
                409,
                '当前预约状态不可修改'
              );
            }

            if (appointment.status === status) {
              return {
                id: appointment.id,
                status: appointment.status,
                start_at: appointment.start_at,
                end_at: appointment.end_at,
                updated_at: appointment.updated_at
              };
            }

            if (!canTransition(appointment.status, status)) {
              throw new AppointmentMutationError(
                'appointment_status_transition_invalid',
                409,
                '不允许进行该预约状态变更'
              );
            }

            const result = await client.query(
              `
              UPDATE appointments
              SET
                status = $1,
                cancelled_at =
                  CASE
                    WHEN $1 = 'cancelled'
                    THEN NOW()
                    ELSE cancelled_at
                  END,
                service_completed_at =
                  CASE
                    WHEN $1 = 'completed'
                    THEN NOW()
                    ELSE service_completed_at
                  END,
                updated_at = NOW()
              WHERE id = $2
                AND shop_id = $3
                AND location_id = $4
              RETURNING
                id,
                status,
                start_at,
                end_at,
                updated_at
              `,
              [
                status,
                appointment.id,
                appointment.shop_id,
                appointment.location_id
              ]
            );

            if (result.rows.length !== 1) {
              throw new AppointmentMutationError(
                'appointment_status_update_mismatch',
                500,
                '更新预约状态失败'
              );
            }

            await syncAppointmentItemStatus(
              client,
              {
                appointment,
                status,
                expectedItemCount:
                  phaseAStructure.itemCount
              }
            );

            await recordStatusHistory(client, {
              appointment,
              fromStatus: appointment.status,
              toStatus: status,
              operatorType: 'owner',
              operatorId: req.ownerAuth.ownerAccountId,
              source: 'owner_dashboard',
              reason: typeof body.reason === 'string'
                ? body.reason.trim() || null
                : null
            });

            return result.rows[0];
          }
        );

      res.json({
        success: true,
        message: '预约状态更新成功',
        data: updatedAppointment
      });
    } catch (error) {
      console.error(
        'Update appointment status DB error:',
        safeStaffAuthErrorCode(error)
      );

      const responseStatus =
        ['23P01', '55P03'].includes(
          safeStaffAuthErrorCode(error)
        )
          ? 409
          : error instanceof AppointmentMutationError
          ? error.status
          : 500;
      const responseMessage =
        safeStaffAuthErrorCode(error) === '23P01'
          ? '新状态与现有预约冲突'
          : safeStaffAuthErrorCode(error) === '55P03'
          ? '预约正在被修改，请稍后重试'
          : error instanceof AppointmentMutationError
          ? error.publicMessage
          : '更新预约状态失败';

      res.status(responseStatus).json({
        success: false,
        message: responseMessage
      });
    }
  }
);


// ==================================================
// 启动服务器
// ==================================================

const PORT =
  process.env.PORT || 3000;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(
      `✅ GG-Beauty 服务器运行在端口 ${PORT}`
    );

    console.log(
      `📋 访问地址: http://localhost:${PORT}`
    );

    console.log(
      `📊 当前预约数: ${bookings.length}`
    );
  });
}

module.exports = {
  app,
  OWNER_MERCHANT_CONTACT_WRITE_ROLES,
  filterBookableCandidateSlots,
  filterAnyStaffCandidateSlots,
  loadEligibleBookingStaff,
  loadTrustedCustomerBookingScope,
  invalidateShopCatalogCache,
  getShopCatalogRevision,
  loadMultiServiceAvailableTimes,
  loadMultiServiceAvailableDates
};
