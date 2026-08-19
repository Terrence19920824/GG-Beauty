// ==================================================
// 美容院预约系统 - 后端服务器 (完整修复版)
// ==================================================
const express = require('express');
const app = express();
app.use(express.json());

const CONFIG = {
  shopName: "GG-Beauty",
  currency: "S$",
  validUntil: "2026-09-19",
  adminPassword: "123456",
  services: [
    { id:101, name: "面部护理 - 深层清洁", duration: 60 },
    { id:102, name: "面部护理 - 保湿补水", duration: 60 },
    { id:103, name: "面部护理 - 抗皱紧致", duration: 60 },
    { id:104, name: "面部护理 - 美白提亮", duration: 60 },
    { id:105, name: "面部护理 - 水光针导入", duration: 60 },
    { id:106, name: "面部护理 - 眼部护理", duration: 45 },
    { id:107, name: "面部护理 - 颈部护理", duration: 45 },
    { id:201, name: "身体护理 - 全身按摩", duration: 60 },
    { id:202, name: "身体护理 - 背部舒压", duration: 60 },
    { id:203, name: "身体护理 - 推拿理疗", duration: 60 },
    { id:204, name: "身体护理 - 美白护理", duration: 60 },
    { id:205, name: "身体护理 - 纤体塑形", duration: 60 },
    { id:206, name: "身体护理 - 经络疏通", duration: 75 },
    { id:207, name: "身体护理 - 热石疗法", duration: 75 },
    { id:301, name: "手足护理 - 手部护理", duration: 60 },
    { id:302, name: "手足护理 - 足部护理", duration: 60 },
    { id:303, name: "手足护理 - 美甲护理", duration: 60 },
    { id:304, name: "手足护理 - 深层滋润", duration: 75 },
    { id:305, name: "手足护理 - 精致美甲", duration: 90 },
    { id:306, name: "手足护理 - 指甲修复", duration: 60 }
  ],
  staff: ["Lily", "Coco", "Mia"],
  businessHours: { start: "10:00", end: "21:00" }
};

let bookings = [];

// 管理员会话（简单实现）
let adminSession = {};

// 检查是否过期
const checkAuth = (req, res, next) => {
  if (new Date() > new Date(CONFIG.validUntil) && req.path.startsWith('/api/new')) {
    return res.json({ success: false, message: '服务已过期，请联系商家续费。' });
  }
  next();
};
app.use(checkAuth);

// 获取配置
app.get('/api/config', (req, res) => res.json({ success: true, data: CONFIG }));

// 获取所有预约
app.get('/api/bookings', (req, res) => res.json({ success: true, data: bookings }));

// 新增预约
app.post('/api/new', (req, res) => {
  const b = { 
    id: Date.now(), 
    ...req.body, 
    time: new Date().toLocaleString('zh-SG'),
    status: req.body.status || 'Pending'
  };
  bookings.unshift(b);
  res.json({ success: true, message: '预约成功！' });
});

// 管理员登录
app.post('/api/admin/login', (req, res) => {
  if (req.body.password === CONFIG.adminPassword) {
    adminSession[req.ip] = true;
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: '密码错误' });
  }
});

// 管理员退出
app.post('/api/admin/logout', (req, res) => {
  delete adminSession[req.ip];
  res.json({ success: true });
});

// 更新预约状态（增加认证检查）
app.post('/api/admin/update-status', (req, res) => {
  // 检查是否已登录
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

// 主页面
app.get('/', (req, res) => {
  const serviceList = CONFIG.services.map(s => 
    `<div class="item" data-id="${s.id}">${s.name} - ${s.duration} 分钟</div>`
  ).join('');
  
  const staffList = CONFIG.staff.map((s, i) => 
    `<div class="item" data-staff="${i}">${s}</div>`
  ).join('');

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>${CONFIG.shopName} - 预约系统</title>
      <style>
        *{box-sizing:border-box; margin:0; padding:0; font-family:-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif}
        body{background:#f9f9f9; padding:20px; max-width:480px; margin:0 auto}
        h1{text-align:center; color:#333; margin-bottom:25px; font-size:22px}
        .card{background:white; border-radius:12px; padding:18px; margin-bottom:15px; box-shadow:0 2px 8px rgba(0,0,0,0.06)}
        .title{font-weight:600; margin-bottom:12px; font-size:16px; color:#444}
        .btn{width:100%; padding:14px; border:none; border-radius:10px; font-size:16px; cursor:pointer; margin:5px 0}
        .btn-primary{background:linear-gradient(135deg,#6366f1,#8b5cf6); color:white; font-weight:600}
        .btn-outline{background:white; border:1px solid #ddd; color:#333}
        .btn-danger{background:#ef4444; color:white}
        input{width:100%; padding:12px; border:1px solid #ddd; border-radius:8px; margin:6px 0; font-size:15px}
        .item{padding:12px; border-bottom:1px solid #f0f0f0; cursor:pointer; font-size:15px}
        .item:hover{background:#f5f5f5}
        .item.selected{background:#eef2ff; color:#4f46e5; font-weight:500}
        #success{display:none; text-align:center; padding:40px 20px}
        .expired-notice{background:#fee2e2; color:#991b1b; padding:12px; border-radius:8px; margin-bottom:15px; text-align:center}
      </style>
    </head>
    <body>
      <h1>💄 ${CONFIG.shopName}</h1>
      
      ${new Date() > new Date(CONFIG.validUntil) ? `<div class="expired-notice">⚠️ 系统已过期，请联系商家续费</div>` : ''}
      
      <div id="booking-form">
        <div class="card">
          <div class="title">选择服务</div>
          <div id="service-list">${serviceList}</div>
        </div>
        <div class="card">
          <div class="title">选择美容师</div>
          <div id="staff-list">${staffList}</div>
        </div>
        <div class="card">
          <div class="title">预约日期和时间</div>
          <input type="date" id="date">
          <input type="time" id="time">
        </div>
        <div class="card">
          <div class="title">个人信息</div>
          <input type="text" id="name" placeholder="您的姓名">
          <input type="tel" id="phone" placeholder="手机号码">
        </div>
        <button class="btn btn-primary" id="submit-btn">确认预约</button>
        <button class="btn btn-outline" id="admin-btn">管理员登录</button>
      </div>
      
      <div id="success">
        <div style="font-size:50px;">✅</div>
        <h2>预约成功！</h2>
        <p style="color:#666; margin-top:10px;">我们已收到您的预约，请等待确认通知</p>
        <button class="btn btn-primary" onclick="location.reload()" style="margin-top:20px;">继续预约</button>
      </div>
      
      <script>
        let selectedService = null, selectedStaff = null;
        const services = ${JSON.stringify(CONFIG.services)};
        const staff = ${JSON.stringify(CONFIG.staff)};

        document.getElementById('service-list').addEventListener('click', e => {
          if (e.target.classList.contains('item')) {
            document.querySelectorAll('#service-list .item').forEach(el => el.classList.remove('selected'));
            e.target.classList.add('selected');
            selectedService = services.find(s => s.id === parseInt(e.target.dataset.id));
          }
        });

        document.getElementById('staff-list').addEventListener('click', e => {
          if (e.target.classList.contains('item')) {
            document.querySelectorAll('#staff-list .item').forEach(el => el.classList.remove('selected'));
            e.target.classList.add('selected');
            selectedStaff = staff[parseInt(e.target.dataset.staff)];
          }
        });

        document.getElementById('submit-btn').addEventListener('click', async () => {
          const name = document.getElementById('name').value.trim();
          const phone = document.getElementById('phone').value.trim();
          const date = document.getElementById('date').value;
          const time = document.getElementById('time').value;
          
          if (!selectedService || !selectedStaff || !name || !phone || !date || !time) {
            return alert('请完整填写所有信息');
          }
          
          const res = await fetch('/api/new', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              service: selectedService,
              staff: selectedStaff,
              customerName: name,
              phone, date, time,
              status: 'Pending'
            })
          });
          
          const data = await res.json();
          if (data.success) {
            document.getElementById('booking-form').style.display = 'none';
            document.getElementById('success').style.display = 'block';
          } else {
            alert(data.message);
          }
        });

        // 管理员登录
        document.getElementById('admin-btn').addEventListener('click', () => {
          const pwd = prompt('请输入管理员密码：');
          if (!pwd) return;
          
          fetch('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pwd })
          })
          .then(r => r.json())
          .then(d => {
            if (d.success) {
              window.location.href = '/admin.html';
            } else {
              alert('密码错误，请重试');
            }
          });
        });

        // 设置默认日期为今天
        document.getElementById('date').valueAsDate = new Date();
        
        // 设置默认时间为当前时间+1小时
        const now = new Date();
        now.setHours(now.getHours() + 1);
        document.getElementById('time').value = now.toTimeString().slice(0, 5);
      </script>
    </body>
    </html>
  `);
});

// 管理员页面（增加认证检查）
app.get('/admin.html', (req, res) => {
  // 检查是否已登录，使用IP作为简单标识
  if (!adminSession[req.ip]) {
    return res.send(`
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>需要登录</title>
        <style>
          *{box-sizing:border-box; margin:0; padding:0}
          body{display:flex; justify-content:center; align-items:center; height:100vh; background:#f9f9f9; font-family:-apple-system, sans-serif}
          .box{background:white; padding:40px; border-radius:16px; text-align:center; max-width:400px}
          h2{color:#333; margin-bottom:20px}
          .btn{display:inline-block; padding:12px 30px; background:#6366f1; color:white; border:none; border-radius:8px; font-size:16px; cursor:pointer; text-decoration:none}
          .btn:hover{background:#4f46e5}
        </style>
      </head>
      <body>
        <div class="box">
          <h2>🔒 需要管理员登录</h2>
          <p style="color:#666; margin-bottom:20px;">请返回首页进行管理员登录</p>
          <a href="/" class="btn">返回首页</a>
        </div>
      </body>
      </html>
    `);
  }

  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>管理员后台 - ${CONFIG.shopName}</title>
      <style>
        *{box-sizing:border-box; margin:0; padding:0; font-family:-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif}
        body{background:#f9f9f9; padding:20px; max-width:600px; margin:0 auto}
        h1{text-align:center; margin-bottom:20px; font-size:22px}
        .card{background:white; border-radius:12px; padding:16px; margin-bottom:12px; box-shadow:0 2px 6px rgba(0,0,0,0.05)}
        .tag{display:inline-block; padding:3px 10px; border-radius:12px; font-size:12px; margin-left:10px}
        .pending{background:#fef3c7; color:#92400e}
        .confirmed{background:#d1fae5; color:#065f46}
        .cancelled{background:#fee2e2; color:#991b1b}
        button{padding:6px 12px; border:none; border-radius:6px; margin:4px; cursor:pointer; font-size:14px}
        .btn-confirm{background:#10b981; color:white}
        .btn-cancel{background:#ef4444; color:white}
        .btn-logout{background:#6b7280; color:white; padding:8px 20px; border-radius:8px; font-size:14px}
        .info{background:#eef2ff; padding:10px; border-radius:8px; margin-bottom:15px}
        .header{display:flex; justify-content:space-between; align-items:center; margin-bottom:15px}
        .empty{text-align:center; color:#999; padding:30px 0}
        .booking-time{color:#888; font-size:13px}
        .service-info{color:#666; font-size:14px; margin:4px 0}
      </style>
    </head>
    <body>
      <div class="header">
        <h1>📋 预约管理</h1>
        <button class="btn-logout" onclick="logout()">退出</button>
      </div>
      
      <div class="info">
        <strong>🏪 店铺</strong> ${CONFIG.shopName}<br>
        <strong>📅 有效期至</strong> ${CONFIG.validUntil}<br>
        <strong>📊 总预约数</strong> <span id="count">0</span>
      </div>
      
      <div id="list"></div>
      
      <script>
        async function load(){
          const res = await fetch('/api/bookings');
          const data = await res.json();
          const bookings = data.data || [];
          
          document.getElementById('count').textContent = bookings.length;
          
          if (bookings.length === 0) {
            document.getElementById('list').innerHTML = '<div class="card empty">暂无预约记录</div>';
            return;
          }
          
          document.getElementById('list').innerHTML = bookings.map(b => {
            const statusMap = {
              'Pending': '待确认',
              'Confirmed': '已确认',
              'Cancelled': '已取消'
            };
            const statusClass = {
              'Pending': 'pending',
              'Confirmed': 'confirmed',
              'Cancelled': 'cancelled'
            };
            
            return \`
              <div class="card">
                <div><strong>\${b.customerName}</strong> 📱 \${b.phone}</div>
                <div class="service-info">\${b.service.name} | 美容师: \${b.staff}</div>
                <div class="service-info">📅 \${b.date} \${b.time}</div>
                <div style="margin-top:8px; display:flex; align-items:center; flex-wrap:wrap;">
                  <span class="tag \${statusClass[b.status] || 'pending'}">\${statusMap[b.status] || b.status}</span>
                  ${b.status !== 'Confirmed' ? `<button class="btn-confirm" onclick="updateStatus(\${b.id},'Confirmed')">✅ 确认</button>` : ''}
                  ${b.status !== 'Cancelled' ? `<button class="btn-cancel" onclick="updateStatus(\${b.id},'Cancelled')">❌ 取消</button>` : ''}
                </div>
              </div>
            \`;
          }).join('');
        }
        
        async function updateStatus(id, status){
          if (!confirm(\`确定要\${status === 'Confirmed' ? '确认' : '取消'}这个预约吗？\`)) return;
          
          const res = await fetch('/api/admin/update-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, status })
          });
          
          const data = await res.json();
          if (data.success) {
            load();
          } else {
            alert(data.message || '操作失败，请重新登录');
            if (data.message === '请先登录') {
              window.location.href = '/';
            }
          }
        }
        
        async function logout() {
          if (!confirm('确定要退出吗？')) return;
          await fetch('/api/admin/logout', { method: 'POST' });
          window.location.href = '/';
        }
        
        load();
        setInterval(load, 10000);
      </script>
    </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ 服务器运行在端口 ${PORT}`);
  console.log(`📋 访问地址: http://localhost:${PORT}`);
  console.log(`🔑 管理员密码: ${CONFIG.adminPassword}`);
});
