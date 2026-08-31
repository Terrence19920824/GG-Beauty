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
  loadAndValidatePhaseAStructure,
  moveAppointmentStructurePrecisely,
  syncAppointmentItemStatus
} = require('./lib/appointment-multi-service');

const app = express();

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// ==================================================
// 中间件
// ==================================================

app.use(express.json());
app.use(express.static('public'));


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
  'can_move_own_appointments'
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
    const result = await pool.query(
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
        sp.can_move_own_appointments
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


// ==================================================
// 从数据库读取真实预约
// ==================================================

app.get('/api/appointments-db', async (req, res) => {
  if (!adminSession[req.ip]) {
    return res.status(401).json({
      success: false,
      message: '请先登录'
    });
  }

  try {
    const result = await pool.query(`
      SELECT
        a.id,
        a.appointment_no,
        a.start_at,
        a.end_at,
        a.status,
        a.booking_source,

        c.name AS customer_name,
        c.phone AS customer_phone,
        c.email AS customer_email,

        s.name AS service_name,
        s.duration_minutes,
        s.price,

        st.name AS staff_name,
        st.staff_code

      FROM appointments a

      JOIN customers c
        ON c.id = a.customer_id

      JOIN services s
        ON s.id = a.service_id

      JOIN staff st
        ON st.id = a.staff_id

      ORDER BY a.start_at DESC
    `);

    res.json({
      success: true,
      data: result.rows
    });

  } catch (error) {
    console.error(
      'Read appointments error:',
      error
    );

    res.status(500).json({
      success: false,
      message: '读取数据库预约失败'
    });
  }
});


// ==================================================
// 配置数据
// ==================================================

const CONFIG = {
  shopName: 'GG-Beauty',
  currency: 'S$',
  validUntil: '2026-09-19',

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
// 检查服务有效期
// ==================================================

const checkAuth = (req, res, next) => {
  if (
    new Date() > new Date(CONFIG.validUntil) &&
    req.path.startsWith('/api/new')
  ) {
    return res.json({
      success: false,
      message: '服务已过期，请联系商家续费。'
    });
  }

  next();
};

app.use(checkAuth);


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
// 旧版预约 API
// 暂时保留
// ==================================================

app.get('/api/bookings', (req, res) => {
  res.json({
    success: true,
    data: bookings
  });
});


app.get('/api/bookings/:id', (req, res) => {
  const booking = bookings.find(
    b => b.id === parseInt(req.params.id)
  );

  if (booking) {
    res.json({
      success: true,
      data: booking
    });

  } else {
    res.status(404).json({
      success: false,
      message: '预约不存在'
    });
  }
});


app.get('/api/bookings/phone/:phone', (req, res) => {
  const userBookings = bookings.filter(
    b => b.phone === req.params.phone
  );

  res.json({
    success: true,
    data: userBookings
  });
});


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
    !date ||
    !time
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

app.post('/api/new-db', async (req, res) => {
  const {
    shopSlug,
    service,
    staff,
    customerName,
    phone,
    email,
    date,
    time
  } = req.body;

  if (
    !shopSlug ||
    !service ||
    !staff ||
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

  try {
    const appointment = await runInTransaction(
      pool,
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
            id,
            name,
            duration_minutes
          FROM services
          WHERE shop_id = $1
            AND name = $2
            AND is_active = true
            AND bookable = true
          LIMIT 1
          `,
          [shopId, service]
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
        const staffResult = await client.query(
          `
          SELECT id
          FROM staff
          WHERE shop_id = $1
            AND name = $2
            AND is_active = true
            AND bookable = true
          LIMIT 1
          `,
          [shopId, staff]
        );

        if (staffResult.rows.length === 0) {
          throw new AppointmentMutationError(
            'staff_not_found',
            400,
            '找不到员工'
          );
        }

        const staffId = staffResult.rows[0].id;

        // 5. 找顾客，没有就创建
        let customerResult = await client.query(
          `
          SELECT id
          FROM customers
          WHERE shop_id = $1
            AND phone = $2
          LIMIT 1
          `,
          [shopId, phone]
        );

        let customerId;

        if (customerResult.rows.length > 0) {
          customerId = customerResult.rows[0].id;
        } else {
          customerResult = await client.query(
            `
            INSERT INTO customers (
              shop_id,
              name,
              phone,
              email
            )
            VALUES ($1, $2, $3, $4)
            RETURNING id
            `,
            [
              shopId,
              customerName,
              phone,
              email || null
            ]
          );

          customerId = customerResult.rows[0].id;
        }

        // 6. 保持当前单项目时间规则
        const startAt = new Date(
          `${date}T${time}:00+08:00`
        );
        const endAt = new Date(
          startAt.getTime() +
          durationMinutes * 60 * 1000
        );

        // 7. 应用层友好防撞；数据库 exclusion 是最终并发保护
        const conflictResult = await client.query(
          `
          SELECT id
          FROM appointments
          WHERE shop_id = $1
            AND staff_id = $2
            AND status <> 'cancelled'
            AND start_at < $4
            AND end_at > $3
          LIMIT 1
          `,
          [shopId, staffId, startAt, endAt]
        );

        if (conflictResult.rows.length > 0) {
          throw new AppointmentMutationError(
            'appointment_collision',
            409,
            '该时间段已被预约，请选择其他时间'
          );
        }

        // 8. 原子创建 parent + item + primary assignment
        const appointmentResult = await client.query(
          `
          INSERT INTO appointments (
            shop_id,
            location_id,
            customer_id,
            service_id,
            staff_id,
            start_at,
            end_at,
            status,
            booking_source
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, $7,
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
            customerId,
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
            service: selectedService
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
    const status = isCollision
      ? 409
      : error instanceof AppointmentMutationError
        ? error.status
        : 500;
    const message = isCollision
      ? '该时间段已被预约，请选择其他时间'
      : error instanceof AppointmentMutationError
        ? error.publicMessage
        : '预约失败';

    res.status(status).json({
      success: false,
      message
    });
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

app.get(
  '/api/available-times-db',
  async (req, res) => {

    const {
      shopSlug,
      date,
      staff,
      service
    } = req.query;

    if (
      !shopSlug ||
      !date ||
      !staff ||
      !service
    ) {
      return res.status(400).json({
        success: false,
        message:
          '缺少 shopSlug、date、staff 或 service'
      });
    }

    try {

      // 1. 找店铺
      const shopResult = await pool.query(
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
          message: '找不到店铺'
        });
      }

      const shopId =
        shopResult.rows[0].id;


      // 2. 找员工
      const staffResult = await pool.query(
        `
        SELECT id
        FROM staff
        WHERE shop_id = $1
          AND name = $2
          AND is_active = true
          AND bookable = true
        LIMIT 1
        `,
        [
          shopId,
          staff
        ]
      );

      if (staffResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: '找不到员工'
        });
      }

      const staffId =
        staffResult.rows[0].id;


      // 3. 找服务项目
      const serviceResult = await pool.query(
        `
        SELECT
          id,
          duration_minutes
        FROM services
        WHERE shop_id = $1
          AND name = $2
          AND is_active = true
          AND bookable = true
        LIMIT 1
        `,
        [
          shopId,
          service
        ]
      );

      if (serviceResult.rows.length === 0) {
        return res.status(404).json({
          success: false,
          message: '找不到服务项目'
        });
      }

      const durationMinutes =
        serviceResult.rows[0].duration_minutes;


      // 4. 基础时间
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


      // 5. 查询当天已有预约
      const dayStart =
        new Date(
          `${date}T00:00:00+08:00`
        );

      const dayEnd =
        new Date(
          `${date}T23:59:59+08:00`
        );

      const bookingResult = await pool.query(
        `
        SELECT
          start_at,
          end_at
        FROM appointments
        WHERE shop_id = $1
          AND staff_id = $2
          AND status <> 'cancelled'
          AND start_at < $4
          AND end_at > $3
        ORDER BY start_at ASC
        `,
        [
          shopId,
          staffId,
          dayStart,
          dayEnd
        ]
      );


      // 6. 根据服务时长过滤冲突时间
      const availableTimes =
        allTimes.filter(time => {

          const slotStart =
            new Date(
              `${date}T${time}:00+08:00`
            );

          const slotEnd =
            new Date(
              slotStart.getTime() +
              durationMinutes * 60 * 1000
            );

          const hasConflict =
            bookingResult.rows.some(
              booking => {

                const bookedStart =
                  new Date(
                    booking.start_at
                  );

                const bookedEnd =
                  new Date(
                    booking.end_at
                  );

                return (
                  slotStart < bookedEnd &&
                  slotEnd > bookedStart
                );
              }
            );

          return !hasConflict;
        });


      res.json({
        success: true,
        data: availableTimes
      });

    } catch (error) {
      console.error(
        'Available times DB error:',
        error
      );

      res.status(500).json({
        success: false,
        message:
          '获取可预约时间失败'
      });
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
      const result = await pool.query(
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
                      WHEN $5::BOOLEAN = TRUE
                      THEN c.phone
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
                AND a.staff_id = scope.staff_id
                AND a.location_id = scope.location_id
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
          requestedDate,
          req.staffAuth.permissions
            .can_view_full_customer_phone === true
        ]
      );

      if (result.rows.length === 0) {
        return res.status(401).json({
          success: false,
          message: '员工地点已失效'
        });
      }

      const appointments = result.rows[0];

      res.json({
        success: true,
        data: {
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
      client = await pool.connect();
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
          AND staff_id = $3
          AND location_id = $4
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

      const conflictResult = await client.query(
        `
        WITH proposed_time AS (
          SELECT
            id,
            $5::TIMESTAMPTZ AS new_start_at,
            $5::TIMESTAMPTZ +
              (end_at - start_at) AS new_end_at
          FROM appointments
          WHERE id = $4
            AND shop_id = $1
            AND location_id = $2
            AND staff_id = $3
        )
        SELECT existing.id
        FROM appointments existing
        CROSS JOIN proposed_time proposed
        WHERE existing.shop_id = $1
          AND existing.location_id = $2
          AND existing.staff_id = $3
          AND existing.id <> proposed.id
          AND existing.status IN ('pending', 'confirmed')
          AND existing.override_conflict = FALSE
          AND existing.start_at < proposed.new_end_at
          AND existing.end_at > proposed.new_start_at
        LIMIT 1
        `,
        [
          req.staffAuth.shopId,
          req.staffAuth.locationId,
          req.staffAuth.staffId,
          appointment.id,
          newStartAt
        ]
      );

      if (conflictResult.rows.length > 0) {
        await rollbackActiveTransaction();

        return res.status(409).json({
          success: false,
          message: '新时间与现有预约冲突'
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
  async (req, res) => {

    if (!adminSession[req.ip]) {
      return res.status(401).json({
        success: false,
        message: '请先登录'
      });
    }

    // The current global-password admin login does not establish a
    // server-trusted shop identity. Keep this database mutation
    // fail-closed until admin authentication is tenant-bound.
    const adminIdentity = adminSession[req.ip];
    const trustedAdminShopId =
      adminIdentity &&
      typeof adminIdentity === 'object' &&
      isUuid(adminIdentity.shopId)
        ? adminIdentity.shopId
        : null;

    if (!trustedAdminShopId) {
      return res.status(403).json({
        success: false,
        message: '无权执行此操作'
      });
    }

    const {
      id,
      status
    } = req.body;

    const allowedStatuses = [
      'pending',
      'confirmed',
      'cancelled',
      'completed',
      'no_show'
    ];

    if (!id || !status) {
      return res.status(400).json({
        success: false,
        message: '缺少预约ID或状态'
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
          pool,
          async client => {
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
                  status
                FROM appointments
                WHERE id = $1
                  AND shop_id = $2
                FOR UPDATE
                `,
                [id, trustedAdminShopId]
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
        safeStaffAuthErrorCode(error) === '23P01'
          ? 409
          : error instanceof AppointmentMutationError
          ? error.status
          : 500;
      const responseMessage =
        safeStaffAuthErrorCode(error) === '23P01'
          ? '新状态与现有预约冲突'
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
