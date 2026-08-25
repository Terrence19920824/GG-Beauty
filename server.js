// ==================================================
// GG-Beauty 美容养生预约系统 - 后端服务器
// ==================================================
const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false
  }
});

// 中间件
app.use(express.json());
app.use(express.static('public')); // 提供静态文件服务

app.get('/api/db-test', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW() AS now');

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
app.get('/api/appointments-db', async (req, res) => {
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
    console.error('Read appointments error:', error);

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
  shopName: "GG-Beauty",
  currency: "S$",
  validUntil: "2026-09-19",
  adminPassword: "123456",
  services: [
    // 面部护理
    { id: 101, name: "深层清洁", duration: 60, price: 68, category: "beauty" },
    { id: 102, name: "补水护理", duration: 60, price: 78, category: "beauty" },
    { id: 103, name: "抗皱紧致", duration: 60, price: 88, category: "beauty" },
    { id: 104, name: "美白提亮", duration: 60, price: 82, category: "beauty" },
    { id: 105, name: "水光针导入", duration: 60, price: 98, category: "beauty" },
    { id: 106, name: "眼部护理", duration: 45, price: 58, category: "beauty" },
    { id: 107, name: "颈部护理", duration: 45, price: 55, category: "beauty" },
    // 身体护理
    { id: 201, name: "全身按摩", duration: 60, price: 75, category: "wellness" },
    { id: 202, name: "背部舒压", duration: 60, price: 70, category: "wellness" },
    { id: 203, name: "推拿理疗", duration: 60, price: 80, category: "wellness" },
    { id: 204, name: "美白身体护理", duration: 60, price: 85, category: "wellness" },
    { id: 205, name: "纤体塑形", duration: 60, price: 90, category: "wellness" },
    { id: 206, name: "经络疏通", duration: 75, price: 95, category: "wellness" },
    { id: 207, name: "热石疗法", duration: 75, price: 100, category: "wellness" },
    // 手足护理
    { id: 301, name: "手部护理", duration: 60, price: 60, category: "wellness" },
    { id: 302, name: "足部护理", duration: 60, price: 65, category: "wellness" },
    { id: 303, name: "美甲护理", duration: 60, price: 70, category: "wellness" },
    { id: 304, name: "深层滋润", duration: 75, price: 75, category: "wellness" },
    { id: 305, name: "精致美甲", duration: 90, price: 95, category: "wellness" },
    { id: 306, name: "指甲修复", duration: 60, price: 68, category: "wellness" }
  ],
  staff: ["Lily", "Coco", "Mia"],
  businessHours: { start: "10:00", end: "21:00" }
};

// 预约数据（内存存储）
let bookings = [];
let bookingIdCounter = 1000;

// 管理员会话（简单实现）
let adminSession = {};

// ==================================================
// 中间件
// ==================================================

// 检查是否过期
const checkAuth = (req, res, next) => {
  if (new Date() > new Date(CONFIG.validUntil) && req.path.startsWith('/api/new')) {
    return res.json({ success: false, message: '服务已过期，请联系商家续费。' });
  }
  next();
};
app.use(checkAuth);

// ==================================================
// API 路由
// ==================================================

// 获取配置
app.get('/api/config', (req, res) => {
  res.json({ success: true, data: CONFIG });
});

// 获取所有预约
app.get('/api/bookings', (req, res) => {
  res.json({ success: true, data: bookings });
});

// 获取单个预约
app.get('/api/bookings/:id', (req, res) => {
  const booking = bookings.find(b => b.id === parseInt(req.params.id));
  if (booking) {
    res.json({ success: true, data: booking });
  } else {
    res.status(404).json({ success: false, message: '预约不存在' });
  }
});

// 根据手机号查询预约
app.get('/api/bookings/phone/:phone', (req, res) => {
  const userBookings = bookings.filter(b => b.phone === req.params.phone);
  res.json({ success: true, data: userBookings });
});

// 新增预约
app.post('/api/new', (req, res) => {
  const { service, staff, customerName, phone, email, date, time } = req.body;
  
  // 简单验证
  if (!service || !staff || !customerName || !phone || !date || !time) {
    return res.status(400).json({ 
      success: false, 
      message: '请完整填写所有必填信息' 
    });
  }
  
  // 检查该时间段是否已被预约
  const existingBooking = bookings.find(b => 
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
    service: service,
    staff: staff,
    customerName: customerName,
    phone: phone,
    email: email || '',
    date: date,
    time: time,
    status: 'Pending',
    createdAt: new Date().toISOString(),
    bookingNumber: `GG-${String(bookingIdCounter).padStart(4, '0')}`
  };
  
  bookings.unshift(booking);
  res.json({ 
    success: true, 
    message: '预约成功！',
    data: booking 
  });
});

// 获取可预约时间
app.get('/api/available-times', (req, res) => {
  const { date, staff } = req.query;
  
  // 生成当天所有可预约时间（简化版）
  const allTimes = [
    '10:00', '10:30', '11:00', '11:30', 
    '12:00', '12:30', '13:00', '13:30',
    '14:00', '14:30', '15:00', '15:30',
    '16:00', '16:30', '17:00', '17:30',
    '18:00', '18:30', '19:00', '19:30',
    '20:00', '20:30'
  ];
  
  // 如果指定了日期和员工，过滤掉已预约的时间
  if (date && staff) {
    const bookedTimes = bookings
      .filter(b => b.date === date && b.staff === staff)
      .map(b => b.time);
    
    const availableTimes = allTimes.filter(t => !bookedTimes.includes(t));
    res.json({ success: true, data: availableTimes });
  } else {
    res.json({ success: true, data: allTimes });
  }
});

// ==================================================
// 管理员 API
// ==================================================

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === CONFIG.adminPassword) {
    adminSession[req.ip] = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: '密码错误' });
  }
});

app.post('/api/admin/logout', (req, res) => {
  delete adminSession[req.ip];
  res.json({ success: true });
});

app.post('/api/admin/update-status', (req, res) => {
  if (!adminSession[req.ip]) {
    return res.status(401).json({ success: false, message: '请先登录' });
  }
  
  const item = bookings.find(b => b.id === req.body.id);
  if (item) {
    item.status = req.body.status;
    res.json({ success: true });
  } else {
    res.json({ success: false, message: '未找到该预约' });
  }
});

// ==================================================
// 启动服务器
// ==================================================

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ GG-Beauty 服务器运行在端口 ${PORT}`);
  console.log(`📋 访问地址: http://localhost:${PORT}`);
  console.log(`🔑 管理员密码: ${CONFIG.adminPassword}`);
  console.log(`📊 当前预约数: ${bookings.length}`);
});
