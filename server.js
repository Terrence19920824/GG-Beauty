// ==================================================
// 鍏荤敓缇庡棰勭害绯荤粺 - 绾噣鐗堬紙鏃犱环鏍笺€佸垎绫绘竻鏅帮級
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
    { id:101, name: "鍏荤敓 - 鑲╅鑸掔紦鎶ょ悊", duration: 60 },
    { id:102, name: "鍏荤敓 - 韬綋鑸掔紦鎶ょ悊", duration: 60 },
    { id:103, name: "鍏荤敓 - 缁忕粶鎶ょ悊", duration: 60 },
    { id:104, name: "鍏荤敓 - 娣嬪反鎶ょ悊", duration: 60 },
    { id:105, name: "鍏荤敓 - 绮炬补韬綋鎶ょ悊", duration: 60 },
    { id:106, name: "鍏荤敓 - 鑵归儴鎶ょ悊", duration: 45 },
    { id:107, name: "鍏荤敓 - 鑳岄儴鎶ょ悊", duration: 45 },
    { id:201, name: "闈㈤儴 - 鍩虹闈㈤儴鎶ょ悊", duration: 60 },
    { id:202, name: "闈㈤儴 - 娣卞眰娓呮磥", duration: 60 },
    { id:203, name: "闈㈤儴 - 琛ユ按鎶ょ悊", duration: 60 },
    { id:204, name: "闈㈤儴 - 闈㈤儴娣嬪反鎶ょ悊", duration: 60 },
    { id:205, name: "闈㈤儴 - 闈㈤儴濉戝舰鎶ょ悊", duration: 60 },
    { id:206, name: "闈㈤儴 - 鎻愭媺绱ц嚧鎶ょ悊", duration: 75 },
    { id:207, name: "闈㈤儴 - 灏廣鑴告姢鐞�", duration: 75 },
    { id:301, name: "濉戝舰 - 鑵归儴濉戝舰", duration: 60 },
    { id:302, name: "濉戝舰 - 鑵拌吂鎶ょ悊", duration: 60 },
    { id:303, name: "濉戝舰 - 鑵块儴濉戝舰", duration: 60 },
    { id:304, name: "濉戝舰 - 韬綋绱ц嚧鎶ょ悊", duration: 75 },
    { id:305, name: "濉戝舰 - 鍏ㄨ韩濉戝舰鎶ょ悊", duration: 90 },
    { id:306, name: "濉戝舰 - 灞€閮ㄥ褰㈡姢鐞�", duration: 60 }
  ],
  staff: ["Lily", "Coco", "Mia"],
  businessHours: { start: "10:00", end: "21:00" }
};

let bookings = [];

const checkAuth = (req, res, next) => {
  if (new Date() > new Date(CONFIG.validUntil) && req.path.startsWith('/api/new')) {
    return res.json({ success: false, message: 'Service expired.' });
  }
  next();
};
app.use(checkAuth);

app.get('/api/config', (req, res) => res.json({ success: true, data: CONFIG }));
app.get('/api/bookings', (req, res) => res.json({ success: true, data: bookings }));

app.post('/api/new', (req, res) => {
  const b = { id: Date.now(), ...req.body, time: new Date().toLocaleString('zh-SG') };
  bookings.unshift(b);
  res.json({ success: true, message: 'Booking successful!' });
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === CONFIG.adminPassword) res.json({ success: true });
  else res.status(401).json({ success: false, message: 'Wrong password' });
});

app.post('/api/admin/update-status', (req, res) => {
  const item = bookings.find(b => b.id === req.body.id);
  if (item) item.status = req.body.status;
  res.json({ success: true });
});

app.get('/', (req, res) => {
  const serviceList = CONFIG.services.map(s => 
    `<div class="item" data-id="${s.id}">${s.name} 路 ${s.duration} 鍒嗛挓</div>`
  ).join('');
  const staffList = CONFIG.staff.map((s, i) => 
    `<div class="item" data-staff="${i}">${s}</div>`
  ).join('');

  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${CONFIG.shopName} - 棰勭害</title>
    <style>
      *{box-sizing:border-box; margin:0; padding:0; font-family:-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif}
      body{background:#f9f9f9; padding:20px; max-width:480px; margin:0 auto}
      h1{text-align:center; color:#333; margin-bottom:25px; font-size:22px}
      .card{background:white; border-radius:12px; padding:18px; margin-bottom:15px; box-shadow:0 2px 8px rgba(0,0,0,0.06)}
      .title{font-weight:600; margin-bottom:12px; font-size:16px; color:#444}
      .btn{width:100%; padding:14px; border:none; border-radius:10px; font-size:16px; cursor:pointer; margin:5px 0}
      .btn-primary{background:linear-gradient(135deg,#6366f1,#8b5cf6); color:white; font-weight:600}
      .btn-outline{background:white; border:1px solid #ddd; color:#333}
      input{width:100%; padding:12px; border:1px solid #ddd; border-radius:8px; margin:6px 0; font-size:15px}
      .item{padding:12px; border-bottom:1px solid #f0f0f0; cursor:pointer; font-size:15px}
      .item:hover{background:#f5f5f5}
      .item.selected{background:#eef2ff; color:#4f46e5; font-weight:500}
      #success{display:none; text-align:center; padding:40px 20px}
    </style></head>
    <body>
      <h1>鉁� ${CONFIG.shopName}</h1>
      <div id="booking-form">
        <div class="card"><div class="title">閫夋嫨鏈嶅姟</div><div id="service-list">${serviceList}</div></div>
        <div class="card"><div class="title">閫夋嫨鎶€甯�</div><div id="staff-list">${staffList}</div></div>
        <div class="card"><div class="title">鏃ユ湡鏃堕棿</div><input type="date" id="date"><input type="time" id="time"></div>
        <div class="card"><div class="title">鎮ㄧ殑淇℃伅</div><input type="text" id="name" placeholder="濮撳悕"><input type="tel" id="phone" placeholder="鐢佃瘽"></div>
        <button class="btn btn-primary" id="submit-btn">纭棰勭害</button>
        <button class="btn btn-outline" id="admin-btn">绠＄悊鐧诲綍</button>
      </div>
      <div id="success"><div style="font-size:50px;">鉁�</div><h2>棰勭害鎴愬姛锛�</h2><p style="color:#666; margin-top:10px;">鎴戜滑浼氬敖蹇笌鎮ㄧ‘璁�</p><button class="btn btn-primary" onclick="location.reload()" style="margin-top:20px;">杩斿洖棣栭〉</button></div>
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
            return alert('璇峰～鍐欏畬鏁翠俊鎭紒');
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

        document.getElementById('admin-btn').addEventListener('click', () => {
          const pwd = prompt('璇疯緭鍏ョ鐞嗗瘑鐮�');
          if (!pwd) return;
          fetch('/api/admin/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pwd })
          }).then(r => r.json()).then(d => {
            if (d.success) window.location.href = '/admin.html';
            else alert('瀵嗙爜閿欒');
          });
        });

        document.getElementById('date').valueAsDate = new Date();
      </script>
    </body></html>
  `);
});

app.get('/admin.html', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>绠＄悊鍚庡彴 - ${CONFIG.shopName}</title>
    <style>
      *{box-sizing:border-box; margin:0; padding:0; font-family:-apple-system, BlinkMacSystemFont, sans-serif}
      body{background:#f9f9f9; padding:20px; max-width:600px; margin:0 auto}
      h1{text-align:center; margin-bottom:20px}
      .card{background:white; border-radius:12px; padding:16px; margin-bottom:12px; box-shadow:0 2px 6px rgba(0,0,0,0.05)}
      .tag{display:inline-block; padding:3px 10px; border-radius:12px; font-size:12px; margin-left:10px}
      .pending{background:#fef3c7; color:#92400e}
      .confirm{background:#d1fae5; color:#065f46}
      .cancel{background:#fee2e2; color:#991b1b}
      button{padding:6px 12px; border:none; border-radius:6px; margin:4px; cursor:pointer; font-size:14px}
      .btn-confirm{background:#10b981; color:white}
      .btn-cancel{background:#ef4444; color:white}
      .info{background:#eef2ff; padding:10px; border-radius:8px; margin-bottom:15px}
    </style></head>
    <body>
      <h1>馃敡 棰勭害绠＄悊</h1>
      <div class="info"><strong>搴楅摵锛�</strong> ${CONFIG.shopName}<br><strong>鏈夋晥鏈熻嚦锛�</strong> ${CONFIG.validUntil}<br><strong>棰勭害鎬绘暟锛�</strong> <span id="count">0</span></div>
      <div id="list"></div>
      <script>
        async function load(){
          const res = await fetch('/api/bookings');
          const data = await res.json();
          document.getElementById('count').textContent = data.data.length;
          document.getElementById('list').innerHTML = data.data.map(b => \`
            <div class="card">
              <div><strong>\${b.customerName}</strong> 路 \${b.phone}</div>
              <div>\${b.service.name} 路 \${b.staff} 路 \${b.date} \${b.time}</div>
              <div style="margin-top:8px;">
                <span class="tag \${b.status==='Confirmed'?'confirm':b.status==='Cancelled'?'cancel':'pending'}">\${b.status==='Confirmed'?'宸茬‘璁�':b.status==='Cancelled'?'宸插彇娑�':'寰呯‘璁�'}</span>
                <button class="btn-confirm" onclick="updateStatus(\${b.id},'Confirmed')">纭</button>
                <button class="btn-cancel" onclick="updateStatus(\${b.id},'Cancelled')">鍙栨秷</button>
              </div>
            </div>
          \`).join('');
        }
        async function updateStatus(id, status){
          await fetch('/api/admin/update-status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ id, status })
          });
          load();
        }
        load();
        setInterval(load, 10000);
      </script>
    </body></html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`鉁� Running on port ${PORT}`);
});
