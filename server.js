// ==================================================
// 缇庡缇庡彂棰勭害绯荤粺 - 鏋佺畝鍗曟枃浠剁増锛圧ender鐩存帴閮ㄧ讲锛�
// ==================================================
const express = require('express');
const app = express();
app.use(express.json());
app.use(express.static('public'));

// ========== 銆愪綘鍙敼杩欓噷锛佸簵鍚�/浠锋牸/鍛樺伐/鎺堟潈鍒版湡鏃ャ€�==========
const CONFIG = {
  shopName: "Bella Nail 缇庣敳涓撻棬搴�",
  currency: "S$",
  validUntil: "2026-09-19",
  adminPassword: "123456",
  services: [
    { id:1, name: "鍩虹缇庣敳", price: 38, duration: 60 },
    { id:2, name: "鍏夌枟寤堕暱", price: 68, duration: 90 },
    { id:3, name: "缇庣敳淇姢", price: 28, duration: 45 }
  ],
  staff: ["Lily", "Coco", "Mia"],
  businessHours: { start: "10:00", end: "21:00" }
};
// ============== 閰嶇疆缁撴潫 涓嬮潰涓嶇敤纰� ==============

let bookings = [];

const checkAuth = (req, res, next) => {
  if (new Date() > new Date(CONFIG.validUntil) && req.path.startsWith('/api/new')) {
    return res.json({ success: false, message: '鏈嶅姟鏈熷凡缁撴潫锛岃缁垂鍚庢彁浜ゆ柊棰勭害锛涘巻鍙茶褰曞彲鏌ョ湅' });
  }
  next();
};
app.use(checkAuth);

app.get('/api/config', (req, res) => res.json({ success: true, data: CONFIG }));
app.get('/api/bookings', (req, res) => res.json({ success: true, data: bookings }));

app.post('/api/new', (req, res) => {
  const b = { id: Date.now(), ...req.body, time: new Date().toLocaleString('zh-SG') };
  bookings.unshift(b);
  res.json({ success: true, message: '棰勭害鎴愬姛锛佹垜浠細灏藉揩纭' });
});

app.post('/api/admin/login', (req, res) => {
  if (req.body.password === CONFIG.adminPassword) res.json({ success: true });
  else res.status(401).json({ success: false, message: '瀵嗙爜閿欒' });
});
app.post('/api/admin/update-status', (req, res) => {
  const item = bookings.find(b => b.id === req.body.id);
  if (item) item.status = req.body.status;
  res.json({ success: true });
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${CONFIG.shopName} - 鍦ㄧ嚎棰勭害</title>
    <style>
      *{box-sizing:border-box; margin:0; padding:0; font-family:-apple-system, BlinkMacSystemFont, sans-serif}
      body{background:#f9f9f9; padding:20px; max-width:480px; margin:0 auto}
      h1{text-align:center; color:#333; margin-bottom:25px; font-size:22px}
      .card{background:white; border-radius:12px; padding:18px; margin-bottom:15px; box-shadow:0 2px 8px rgba(0,0,0,0.06)}
      .title{font-weight:600; margin-bottom:12px; font-size:16px}
      .btn{width:100%; padding:14px; border:none; border-radius:10px; font-size:16px; cursor:pointer; margin:5px 0}
      .btn-primary{background:linear-gradient(135deg,#6366f1,#8b5cf6); color:white; font-weight:600}
      .btn-outline{background:white; border:1px solid #ddd; color:#333}
      input,select{width:100%; padding:12px; border:1px solid #ddd; border-radius:8px; margin:6px 0; font-size:15px}
      .item{padding:10px; border-bottom:1px solid #f0f0f0; cursor:pointer}
      .item:hover{background:#f5f5f5}
      .price{color:#e53e3e; font-weight:600}
      #success{display:none; text-align:center; padding:40px 20px}
      .tag{display:inline-block; padding:2px 8px; border-radius:12px; font-size:12px; margin-left:8px}
      .tag-pending{background:#fef3c7; color:#92400e}
      .tag-confirm{background:#d1fae5; color:#065f46}
    </style></head>
    <body>
      <h1>鉁� ${CONFIG.shopName}</h1>
      <div id="booking-form">
        <div class="card"><div class="title">閫夋嫨鏈嶅姟</div><div id="service-list"></div></div>
        <div class="card"><div class="title">閫夋嫨鎶€甯�</div><div id="staff-list"></div></div>
        <div class="card"><div class="title">棰勭害鏃堕棿</div><input type="date" id="date"><input type="time" id="time"></div>
        <div class="card"><div class="title">鎮ㄧ殑淇℃伅</div><input type="text" id="name" placeholder="濮撳悕"><input type="tel" id="phone" placeholder="鎵嬫満鍙�"></div>
        <button class="btn btn-primary" onclick="submitBooking()">纭棰勭害</button>
        <button class="btn btn-outline" onclick="showAdmin()">绠＄悊鐧诲綍</button>
      </div>
      <div id="success"><div style="font-size:50px;">鉁�</div><h2>棰勭害鎻愪氦鎴愬姛锛�</h2><p style="color:#666; margin-top:10px;">鎴戜滑浼氬敖蹇笌鎮ㄧ‘璁�</p><button class="btn btn-primary" onclick="location.reload()" style="margin-top:20px;">杩斿洖棣栭〉</button></div>
      <script>
        let selected = { service:null, staff:null };
        const CONFIG = ${JSON.stringify(CONFIG)};
        function renderServices(){const list=document.getElementById('service-list');list.innerHTML=CONFIG.services.map(s=>`<div class="item" onclick="selectService(${s.id})" id="svc-${s.id}">${s.name} 路 <span class="price">${CONFIG.currency}${s.price}</span> 路 ${s.duration}鍒嗛挓</div>`).join('');}
        function renderStaff(){const list=document.getElementById('staff-list');list.innerHTML=CONFIG.staff.map((s,i)=>`<div class="item" onclick="selectStaff(${i})" id="stf-${i}">${s}</div>`).join('');}
        function selectService(id){selected.service=CONFIG.services.find(s=>s.id===id);document.querySelectorAll('#service-list .item').forEach(el=>el.style.background='');document.getElementById(`svc-${id}`).style.background='#eef2ff';}
        function selectStaff(i){selected.staff=CONFIG.staff[i];document.querySelectorAll('#staff-list .item').forEach(el=>el.style.background='');document.getElementById(`stf-${i}`).style.background='#eef2ff';}
        async function submitBooking(){const name=document.getElementById('name').value.trim(),phone=document.getElementById('phone').value.trim(),date=document.getElementById('date').value,time=document.getElementById('time').value;if(!selected.service||!selected.staff||!name||!phone||!date||!time)return alert('璇峰～鍐欏畬鏁翠俊鎭�');const res=await fetch('/api/new',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...selected,customerName:name,phone,date,time,status:'寰呯‘璁�'})});const data=await res.json();if(data.success){document.getElementById('booking-form').style.display='none';document.getElementById('success').style.display='block';}else alert(data.message);}
        function showAdmin(){const pwd=prompt('璇疯緭鍏ョ鐞嗗瘑鐮�');if(!pwd)return;fetch('/api/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})}).then(r=>r.json()).then(d=>{if(d.success)window.location.href='/admin.html';else alert('瀵嗙爜閿欒');});}
        renderServices();renderStaff();document.getElementById('date').valueAsDate=new Date();
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
      <h1>馃敡 棰勭害绠＄悊鍚庡彴</h1>
      <div class="info"><strong>搴楅摵锛�</strong>${CONFIG.shopName}<br><strong>鎺堟潈鑷筹細</strong>${CONFIG.validUntil}<br><strong>褰撳墠棰勭害鏁帮細</strong><span id="count">0</span></div>
      <div id="list"></div>
      <script>
        async function load(){const res=await fetch('/api/bookings');const data=await res.json();document.getElementById('count').textContent=data.data.length;document.getElementById('list').innerHTML=data.data.map(b=>`<div class="card"><div><strong>${b.customerName}</strong> 路 ${b.phone}</div><div>${b.service.name} 路 ${b.staff} 路 ${b.date} ${b.time}</div><div style="margin-top:8px;"><span class="tag ${b.status==='宸茬‘璁�'?'confirm':b.status==='宸插彇娑�'?'cancel':'pending'}">${b.status||'寰呯‘璁�'}</span><button class="btn-confirm" onclick="updateStatus(${b.id},'宸茬‘璁�')">纭</button><button class="btn-cancel" onclick="updateStatus(${b.id},'宸插彇娑�')">鍙栨秷</button></div></div>`).join('');}
        async function updateStatus(id,status){await fetch('/api/admin/update-status',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id,status})});load();}
        load();setInterval(load,10000);
      </script>
    </body></html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`鉁� 棰勭害绯荤粺宸插惎鍔�: http://localhost:${PORT}`);
});
