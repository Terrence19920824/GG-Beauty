'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');

const i18n = require('../public/shared-i18n');
const {
  checkRateLimit,
  clearRateLimit,
  normalizeCustomerQueryPhone,
  queryCustomerBookings
} = require('../lib/customer-booking-query');

const root = path.resolve(__dirname, '..');
const indexHtml = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const myBookingsHtml = fs.readFileSync(path.join(root, 'public/my-bookings.html'), 'utf8');
const myBookingsJs = fs.readFileSync(path.join(root, 'public/customer-my-bookings.js'), 'utf8');

// Helper to create an isolated mock Express server with the real endpoint logic
const createMockApp = (customPool) => {
  const app = express();
  app.use(express.json());

  app.locals.bookingPool = customPool;

  app.post('/api/customer/my-bookings', async (req, res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, private');

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

    const ipLimit = checkRateLimit(`ip:${clientIp}`, { maxRequests: 5, windowMs: 60000 });
    if (!ipLimit.allowed) {
      res.setHeader('Retry-After', String(ipLimit.retryAfterSeconds));
      return res.status(429).json({ success: false, code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please try again later.' });
    }

    if (phoneNormalized) {
      const phoneLimit = checkRateLimit(`phone:${normalizedSlug}:${phoneNormalized}`, { maxRequests: 3, windowMs: 60000 });
      if (!phoneLimit.allowed) {
        res.setHeader('Retry-After', String(phoneLimit.retryAfterSeconds));
        return res.status(429).json({ success: false, code: 'TOO_MANY_REQUESTS', message: 'Too many requests. Please try again later.' });
      }
    }

    try {
      const shopResult = await app.locals.bookingPool.query(
        `SELECT shop.id, shop.name AS shop_name, settings.public_contact_phone, settings.public_whatsapp_phone
         FROM shops AS shop
         LEFT JOIN shop_customer_settings AS settings ON settings.shop_id = shop.id
         WHERE shop.slug = $1 AND shop.status = 'active' LIMIT 1`, [normalizedSlug]
      );

      if (shopResult.rows.length !== 1) {
        return res.status(404).json({ success: false, code: 'SHOP_NOT_FOUND' });
      }

      const shopRow = shopResult.rows[0];
      const shopContact = {
        shopName: shopRow.shop_name,
        contactPhone: shopRow.public_contact_phone || null,
        whatsAppUrl: shopRow.public_whatsapp_phone ? `https://wa.me/${shopRow.public_whatsapp_phone.replace(/[^0-9]/g, '')}` : null
      };

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
      return res.status(500).json({ success: false, code: 'BOOKINGS_QUERY_UNAVAILABLE' });
    }
  });

  return app;
};

// 1. 当前店手机号只返回当前店预约
test('1. 当前店手机号只返回当前店预约', async () => {
  clearRateLimit();
  const mockRows = [
    {
      id: 'apt-uuid-1',
      appointment_no: 'GG-20261001-001',
      start_at: new Date('2026-10-01T10:00:00Z'),
      end_at: new Date('2026-10-01T11:00:00Z'),
      status: 'confirmed',
      items: [
        { sequenceNo: 1, name: '精致剪发', durationMinutes: 60, staffName: 'Alex' }
      ]
    }
  ];

  let queryShopIdCaptured = null;
  const mockPool = {
    query: async (sql, params) => {
      if (sql.includes('FROM shops')) {
        if (params[0] === 'shop-a') {
          return { rows: [{ id: 'shop-uuid-a', shop_name: 'Shop A', public_contact_phone: '+6581234567', public_whatsapp_phone: '+6581234567' }] };
        }
        return { rows: [] };
      }
      if (sql.includes('FROM appointments')) {
        queryShopIdCaptured = params[0];
        return { rows: mockRows };
      }
      return { rows: [] };
    }
  };

  const app = createMockApp(mockPool);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/customer/my-bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shopSlug: 'shop-a',
      countryCode: '+65',
      phone: '81234567'
    })
  });

  const json = await res.json();
  server.close();

  assert.equal(res.status, 200);
  assert.equal(json.success, true);
  assert.equal(queryShopIdCaptured, 'shop-uuid-a');
  assert.equal(json.data.appointments.length, 1);
  assert.equal(json.data.appointments[0].appointmentNo, 'GG-20261001-001');
  assert.equal(json.data.appointments[0].services[0].name, '精致剪发');
  assert.equal(json.data.appointments[0].services[0].staffName, 'Alex');
  assert.equal(json.data.shop.shopName, 'Shop A');
});

// 2. 跨店同手机号不能泄露：Shop B 查询时无法看到 Shop A 的预约
test('2. 跨店同手机号不能泄露：Shop B 严格隔离，不同店无法串查', async () => {
  clearRateLimit();
  const mockPool = {
    query: async (sql, params) => {
      if (sql.includes('FROM shops')) {
        if (params[0] === 'shop-b') {
          return { rows: [{ id: 'shop-uuid-b', shop_name: 'Shop B', public_contact_phone: '+6599998888', public_whatsapp_phone: null }] };
        }
        return { rows: [] };
      }
      if (sql.includes('FROM appointments')) {
        // Assert the query strictly filters by shopId = shop-uuid-b
        assert.equal(params[0], 'shop-uuid-b');
        // Shop B has 0 appointments for this customer
        return { rows: [] };
      }
      return { rows: [] };
    }
  };

  const app = createMockApp(mockPool);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/customer/my-bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      shopSlug: 'shop-b',
      countryCode: '+65',
      phone: '81234567'
    })
  });

  const json = await res.json();
  server.close();

  assert.equal(res.status, 200);
  assert.equal(json.success, true);
  assert.equal(json.data.appointments.length, 0);
  assert.equal(json.data.shop.shopName, 'Shop B');
});

// 3. 不返回 PII 禁止字段（无 customer_id, 无 raw appointment id, 无 email, 无 notes 等）
test('3. 不返回 PII 禁止字段（白名单安全性验证）', async () => {
  clearRateLimit();
  const mockPool = {
    query: async (sql, params) => {
      if (sql.includes('FROM shops')) {
        return { rows: [{ id: 'shop-1', shop_name: 'Shop 1', public_contact_phone: '+6581234567', public_whatsapp_phone: '+6581234567' }] };
      }
      if (sql.includes('FROM appointments')) {
        return {
          rows: [{
            id: 'apt-raw-id-999',
            appointment_no: 'GG-001',
            start_at: new Date('2026-10-01T10:00:00Z'),
            end_at: new Date('2026-10-01T11:00:00Z'),
            status: 'confirmed',
            items: [{ sequenceNo: 1, name: '护理', durationMinutes: 45, staffName: 'Staff 1' }]
          }]
        };
      }
      return { rows: [] };
    }
  };

  const app = createMockApp(mockPool);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/customer/my-bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shopSlug: 'shop-1', countryCode: '+65', phone: '81234567' })
  });

  const json = await res.json();
  server.close();

  const apt = json.data.appointments[0];
  assert.ok(apt);

  // Allowed fields
  const allowedAptKeys = new Set(['appointmentNo', 'startAt', 'endAt', 'status', 'services']);
  for (const k of Object.keys(apt)) {
    assert.ok(allowedAptKeys.has(k), `Unexpected field exposed on appointment: ${k}`);
  }

  // Forbidden fields must not exist
  assert.equal(apt.id, undefined);
  assert.equal(apt.customer_id, undefined);
  assert.equal(apt.customerId, undefined);
  assert.equal(apt.email, undefined);
  assert.equal(apt.notes, undefined);
  assert.equal(apt.internal_notes, undefined);
  assert.equal(apt.price, undefined);
  assert.equal(apt.checkout, undefined);
  assert.equal(apt.payment, undefined);

  // Services whitelist
  const allowedServiceKeys = new Set(['name', 'durationMinutes', 'staffName']);
  for (const s of apt.services) {
    for (const k of Object.keys(s)) {
      assert.ok(allowedServiceKeys.has(k), `Unexpected field exposed on service: ${k}`);
    }
    assert.equal(s.staffId, undefined);
    assert.equal(s.staffPhone, undefined);
  }
});

// 4. 查询不到返回空列表，不要报错暴露信息
test('4. 查询不到返回空列表，HTTP 200 且 appointments: []', async () => {
  clearRateLimit();
  const mockPool = {
    query: async (sql, params) => {
      if (sql.includes('FROM shops')) {
        return { rows: [{ id: 'shop-1', shop_name: 'Shop 1', public_contact_phone: null, public_whatsapp_phone: null }] };
      }
      return { rows: [] };
    }
  };

  const app = createMockApp(mockPool);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/customer/my-bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shopSlug: 'shop-1', countryCode: '+65', phone: '99999999' })
  });

  const json = await res.json();
  server.close();

  assert.equal(res.status, 200);
  assert.equal(json.success, true);
  assert.deepEqual(json.data.appointments, []);
});

// 5. 频控拦截：短时间内过多请求返回 429
test('5. 频控拦截：短时间内过多请求返回 429 与 Retry-After', async () => {
  clearRateLimit();
  const mockPool = {
    query: async () => ({ rows: [{ id: 'shop-1', shop_name: 'Shop 1' }] })
  };

  const app = createMockApp(mockPool);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const makeReq = () => fetch(`http://127.0.0.1:${port}/api/customer/my-bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shopSlug: 'shop-1', countryCode: '+65', phone: '88880000' })
  });

  // Allowed requests
  const res1 = await makeReq();
  assert.equal(res1.status, 200);
  const res2 = await makeReq();
  assert.equal(res2.status, 200);
  const res3 = await makeReq();
  assert.equal(res3.status, 200);

  // 4th request exceeds phone limit (3)
  const res4 = await makeReq();
  assert.equal(res4.status, 429);
  assert.ok(res4.headers.get('retry-after'));
  const json4 = await res4.json();
  assert.equal(json4.code, 'TOO_MANY_REQUESTS');

  server.close();
});

// 6. 拒绝 Query Parameters 传输手机号（防 URL 日志泄露）
test('6. 拒绝 Query Parameters 传输手机号（防 URL 日志泄露）', async () => {
  clearRateLimit();
  const mockPool = { query: async () => ({ rows: [] }) };
  const app = createMockApp(mockPool);
  const server = http.createServer(app);
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;

  const res = await fetch(`http://127.0.0.1:${port}/api/customer/my-bookings?phone=81234567`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ shopSlug: 'shop-1' })
  });

  const json = await res.json();
  server.close();

  assert.equal(res.status, 400);
  assert.equal(json.code, 'INVALID_QUERY_TRANSPORT');
});

// 7. 预约成功卡片包含“查看我的预约”按钮、员工、电话和 WhatsApp
test('7. 预约成功卡片包含“查看我的预约”按钮、员工信息与联系方式', () => {
  // Check index.html markup & script
  assert.match(indexHtml, /id="myBookingsEntry"/);
  assert.match(indexHtml, /href="\/my-bookings\.html"/);
  assert.match(indexHtml, /['"]successMyBookingsBtn['"]/);
  assert.match(indexHtml, /customerT\('viewMyBookings'\)/);
  assert.match(indexHtml, /['"]bookAgainBtn['"]/);
  assert.match(indexHtml, /customerT\('bookAgain'\)/);
  assert.match(indexHtml, /success-staff-info/);
  assert.match(indexHtml, /success-contact-row/);
});

// 8. 中英文文案纯净性与状态映射完整性
test('8. 中英文文案纯净性与状态映射完整性', () => {
  const statusKeys = [
    'statusPending',
    'statusConfirmed',
    'statusArrived',
    'statusInService',
    'statusCompleted',
    'statusCancelled',
    'statusNoShow'
  ];

  const expectedZh = {
    myBookings: '我的预约',
    viewMyBookings: '查看我的预约',
    searchBookings: '查询预约',
    enterPhoneToView: '输入预约手机号查看预约',
    noBookingsFound: '未查询到相关预约',
    queryTooFrequent: '查询过于频繁，请稍后再试',
    unassignedStaff: '不指定员工',
    bookAgain: '继续预约',
    statusPending: '已预约',
    statusConfirmed: '已确认',
    statusArrived: '已到店',
    statusInService: '服务中',
    statusCompleted: '已完成',
    statusCancelled: '已取消',
    statusNoShow: '未到店'
  };

  const expectedEn = {
    myBookings: 'My Bookings',
    viewMyBookings: 'View My Bookings',
    searchBookings: 'Search Bookings',
    enterPhoneToView: 'Enter your mobile number to view bookings',
    noBookingsFound: 'No bookings found',
    queryTooFrequent: 'Too many requests. Please try again later',
    unassignedStaff: 'No preference',
    bookAgain: 'Book Again',
    statusPending: 'Booked',
    statusConfirmed: 'Confirmed',
    statusArrived: 'Arrived',
    statusInService: 'In Service',
    statusCompleted: 'Completed',
    statusCancelled: 'Cancelled',
    statusNoShow: 'No Show'
  };

  for (const [key, val] of Object.entries(expectedZh)) {
    const textZh = i18n.t(key, 'zh-CN');
    assert.equal(textZh, val);
    assert.doesNotMatch(textZh, /[a-zA-Z]/, `Chinese key ${key} contains English letters: ${textZh}`);
  }

  for (const [key, val] of Object.entries(expectedEn)) {
    const textEn = i18n.t(key, 'en');
    assert.equal(textEn, val);
    assert.doesNotMatch(textEn, /[\u3400-\u9fff]/, `English key ${key} contains Chinese characters: ${textEn}`);
  }
});

// 9. 独立页面与客户端脚本结构验证
test('9. 独立页面 public/my-bookings.html 与 public/customer-my-bookings.js 包含必需功能', () => {
  // HTML tags
  assert.match(myBookingsHtml, /id="countryCode"/);
  assert.match(myBookingsHtml, /id="queryPhone"/);
  assert.match(myBookingsHtml, /id="queryBtn"/);
  assert.match(myBookingsHtml, /id="bookingsSection"/);
  assert.match(myBookingsHtml, /id="backLink"/);
  assert.match(myBookingsHtml, /id="languageZh"/);
  assert.match(myBookingsHtml, /id="languageEn"/);
  assert.match(myBookingsHtml, /src="\/customer-my-bookings\.js"/);

  // JS script logic
  assert.match(myBookingsJs, /function executeQuery/);
  assert.match(myBookingsJs, /POST/);
  assert.match(myBookingsJs, /\/api\/customer\/my-bookings/);
  assert.match(myBookingsJs, /STATUS_KEY_MAP/);
  assert.match(myBookingsJs, /COUNTRY_OPTIONS/);
  assert.match(myBookingsJs, /root\.ggCustomerMyBookings\s*=/);
});
