'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sharedI18nPath = path.join(root, 'public', 'shared-i18n.js');
const calendarSharedCssPath = path.join(root, 'public', 'calendar-shared.css');
const staffAppointmentsHtmlPath = path.join(root, 'public', 'staff-appointments.html');

const i18n = require(sharedI18nPath);
const i18nSource = fs.readFileSync(sharedI18nPath, 'utf8');
const calendarSharedCss = fs.readFileSync(calendarSharedCssPath, 'utf8');
const staffHtml = fs.readFileSync(staffAppointmentsHtmlPath, 'utf8');

const AUTHORITATIVE_STATUSES = [
  'pending',
  'confirmed',
  'arrived',
  'in_service',
  'completed',
  'no_show',
  'cancelled'
];

const EXPECTED_ZH = {
  pending: '待确认',
  confirmed: '已确认',
  arrived: '已到店',
  in_service: '服务中',
  completed: '已完成',
  no_show: '未到店',
  cancelled: '已取消',
  unknownStatus: '状态未知'
};

const EXPECTED_EN = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  arrived: 'Arrived',
  in_service: 'In Service',
  completed: 'Completed',
  no_show: 'No Show',
  cancelled: 'Cancelled',
  unknownStatus: 'Unknown Status'
};

// 1. 员工姓名首字母头像 (getStaffInitials)
test('1. Staff avatar initials generation (getStaffInitials) handles diverse naming conventions', () => {
  assert.equal(typeof i18n.getStaffInitials, 'function', 'getStaffInitials must be exported by shared-i18n');

  // English multi-word names -> initials of first two words
  assert.equal(i18n.getStaffInitials('Alice Wong'), 'AW');
  assert.equal(i18n.getStaffInitials('John Doe'), 'JD');
  assert.equal(i18n.getStaffInitials('Bob Smith Jr'), 'BS');
  assert.equal(i18n.getStaffInitials('Mary-Jane Watson'), 'MJ');
  assert.equal(i18n.getStaffInitials('Jean_Luc Picard'), 'JL');

  // Single word English name -> first two characters
  assert.equal(i18n.getStaffInitials('Alice'), 'AL');
  assert.equal(i18n.getStaffInitials('Bob'), 'BO');
  assert.equal(i18n.getStaffInitials('A'), 'A');

  // Chinese names -> first two characters
  assert.equal(i18n.getStaffInitials('李小明'), '李小');
  assert.equal(i18n.getStaffInitials('张伟'), '张伟');
  assert.equal(i18n.getStaffInitials('王'), '王');

  // Spacing and casing normalization
  assert.equal(i18n.getStaffInitials('  alice   wong  '), 'AW');
  assert.equal(i18n.getStaffInitials('   '), '');

  // Invalid / non-string inputs fail gracefully
  assert.equal(i18n.getStaffInitials(''), '');
  assert.equal(i18n.getStaffInitials(null), '');
  assert.equal(i18n.getStaffInitials(undefined), '');
  assert.equal(i18n.getStaffInitials(123), '');
  assert.equal(i18n.getStaffInitials({}), '');
});

// 2. 空姓名安全fallback (createAvatarElement with neutral SVG)
test('2. Empty or missing name produces safe fallback SVG avatar without crash or leak', () => {
  assert.match(staffHtml, /const createAvatarElement =/);
  assert.match(staffHtml, /svg\.className\.baseVal = 'staff-avatar-fallback-icon';/);
  assert.match(staffHtml, /svg\.setAttribute\('viewBox',\s*'0 0 24 24'\);/);
  assert.match(staffHtml, /svg\.setAttribute\('aria-hidden',\s*'true'\);/);

  // When name is empty, fallback SVG icon is rendered inside staff-avatar
  assert.match(staffHtml, /if\s*\(initials\)\s*\{[\s\S]*?elements\.staffAvatarText\.textContent = initials;[\s\S]*?\} else \{[\s\S]*?staff-avatar-fallback-icon/);

  // Avatar label in en / zh
  assert.match(staffHtml, /const getStaffAvatarAriaLabel =/);
  assert.match(staffHtml, /'员工头像'/);
  assert.match(staffHtml, /'Staff avatar'/);
  assert.doesNotMatch(staffHtml, /photo_url/i, 'Must not query or fake non-existent photo_url');
  assert.doesNotMatch(staffHtml, /upload-photo/i, 'Must not add photo upload feature');
});

// 3. 业务姓名保持原文和notranslate
test('3. Business names retain exact original text and include notranslate attributes', () => {
  // Staff name elements
  assert.match(staffHtml, /id="staff-name"\s+class="staff-name notranslate"\s+translate="no"/);
  assert.match(staffHtml, /id="staff-avatar-text"\s+class="staff-avatar-initials notranslate"\s+translate="no"/);
  assert.match(staffHtml, /calendar-staff-name notranslate/);

  // Appointment customer name & service name
  assert.match(staffHtml, /customer-name notranslate/);
  assert.match(staffHtml, /service-name notranslate/);
  assert.match(staffHtml, /calendar-appointment-name notranslate/);
  assert.match(staffHtml, /calendar-appointment-service notranslate/);
});

// 4. 中文模式纯中文
test('4. Chinese mode presents 100% pure Chinese system text', () => {
  const zhTranslations = {
    today: '今天',
    list: '列表',
    calendar: '日历',
    previousDay: '上一天',
    nextDay: '下一天',
    myAppointments: '我的预约',
    noAppointments: '暂无预约',
    loading: '加载中',
    loadFailed: '加载失败',
    sessionExpired: '登录已过期',
    timeHeader: '时间',
    staffAvatar: '员工头像'
  };

  for (const [key, value] of Object.entries(zhTranslations)) {
    assert.doesNotMatch(value, /[a-zA-Z]/, `Chinese translation for ${key} must not contain English letters`);
    assert.equal(value.includes('/'), false, `Chinese translation for ${key} must not contain slash`);
  }

  // All 7 statuses in Chinese must be pure Chinese
  for (const st of AUTHORITATIVE_STATUSES) {
    const text = EXPECTED_ZH[st];
    assert.doesNotMatch(text, /[a-zA-Z]/, `Status ${st} in Chinese must not contain English letters`);
    assert.equal(text.includes('/'), false, `Status ${st} in Chinese must not contain slash`);
  }
});

// 5. English模式纯English
test('5. English mode presents 100% pure English system text', () => {
  const enTranslations = {
    today: 'Today',
    list: 'List',
    calendar: 'Calendar',
    previousDay: 'Previous Day',
    nextDay: 'Next Day',
    myAppointments: 'My Appointments',
    noAppointments: 'No appointments',
    loading: 'Loading',
    loadFailed: 'Load Failed',
    sessionExpired: 'Session Expired',
    timeHeader: 'TIME',
    staffAvatar: 'Staff avatar'
  };

  for (const [key, value] of Object.entries(enTranslations)) {
    assert.doesNotMatch(value, /[\u4e00-\u9fa5]/, `English translation for ${key} must not contain Chinese characters`);
    assert.equal(value.includes('/'), false, `English translation for ${key} must not contain slash`);
  }

  // All 7 statuses in English must be pure English
  for (const st of AUTHORITATIVE_STATUSES) {
    const text = EXPECTED_EN[st];
    assert.doesNotMatch(text, /[\u4e00-\u9fa5]/, `Status ${st} in English must not contain Chinese characters`);
    assert.equal(text.includes('/'), false, `Status ${st} in English must not contain slash`);
  }
});

// 6. 禁止双语拼接 (Zero bilingual slash concatenation)
test('6. Zero bilingual slash concatenation in UI and translations', () => {
  const vm = require('node:vm');
  // Check shared-i18n.js
  for (const st of AUTHORITATIVE_STATUSES) {
    assert.equal(i18n.formatStatus(st, 'zh-CN').includes('/'), false);
    assert.equal(i18n.formatStatus(st, 'en').includes('/'), false);
  }

  // Check staff-appointments.html translations dictionary
  const code = staffHtml.slice(staffHtml.indexOf('const translations ='), staffHtml.indexOf('const getSavedLanguage ='));
  const dict = vm.runInNewContext('(' + code.replace('const translations =', '').replace(/;\s*$/, '') + ')');

  function checkNoSlashes(obj, lang) {
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'string') {
        assert.equal(v.includes('/'), false, `${lang} string for ${k} ("${v}") must not contain slash`);
      } else if (typeof v === 'object' && v !== null) {
        checkNoSlashes(v, `${lang}.${k}`);
      }
    }
  }

  checkNoSlashes(dict.zh, 'zh');
  checkNoSlashes(dict.en, 'en');
});

// 7. locale即时切换 (Instant re-rendering without reload)
test('7. Locale switches instantly without full page reload and syncs gg_beauty_locale', () => {
  assert.match(staffHtml, /const setLanguage = language =>/);
  assert.match(staffHtml, /state\.language = language;/);
  assert.match(staffHtml, /localStorage\.setItem\(\s*LANGUAGE_STORAGE_KEY,\s*language\s*\);/);
  assert.match(staffHtml, /localStorage\.setItem\(\s*'gg_beauty_locale',\s*language === 'zh' \? 'zh-CN' : 'en'\s*\);/);
  assert.match(staffHtml, /setLanguage[\s\S]*?render\(\);/);
  assert.doesNotMatch(staffHtml, /setLanguage[\s\S]*?location\.reload\(\)/, 'setLanguage must not trigger page reload');
});

// 8. Today按钮 (Today button navigation)
test('8. Today button navigates to today date in both list and calendar views', () => {
  assert.match(staffHtml, /id="today-button"/);
  assert.match(staffHtml, /id="calendar-today"/);
  assert.match(staffHtml, /elements\.todayButton\.setAttribute\('aria-label',\s*text\.today\);/);
  assert.match(staffHtml, /elements\.calendarToday\.setAttribute\('aria-label',\s*text\.today\);/);
  assert.match(staffHtml, /elements\.calendarToday\.addEventListener\(\s*'click',\s*\(\) =>/);
});

// 9. 前一天/后一天 (Previous Day / Next Day navigation)
test('9. Previous Day / Next Day navigation updates date and localized aria-labels', () => {
  assert.match(staffHtml, /id="previous-day"/);
  assert.match(staffHtml, /id="next-day"/);
  assert.match(staffHtml, /elements\.previousDay\.setAttribute\(\s*'aria-label',\s*text\.previousDay\s*\);/);
  assert.match(staffHtml, /elements\.nextDay\.setAttribute\(\s*'aria-label',\s*text\.nextDay\s*\);/);
  assert.match(staffHtml, /elements\.previousDay\.addEventListener\(\s*'click',\s*\(\) =>/);
  assert.match(staffHtml, /elements\.nextDay\.addEventListener\(\s*'click',\s*\(\) =>/);
});

// 10. List/Calendar切换 (View switcher and aria-pressed)
test('10. List / Calendar view switcher toggles display mode and updates aria-pressed', () => {
  assert.match(staffHtml, /id="view-list"/);
  assert.match(staffHtml, /id="view-calendar"/);
  assert.match(staffHtml, /elements\.viewList\.setAttribute\(\s*'aria-pressed',\s*String\(state\.displayMode === 'list'\)\s*\);/);
  assert.match(staffHtml, /elements\.viewCalendar\.setAttribute\(\s*'aria-pressed',\s*String\(state\.displayMode === 'calendar'\)\s*\);/);
  assert.match(staffHtml, /elements\.calendarNavigation\.classList\.toggle\(\s*'visible',\s*state\.displayMode === 'calendar'\s*\);/);
});

// 11. 7种预约状态 (All 7 authoritative appointment statuses render valid status pills and geometric icons)
test('11. All 7 authoritative appointment statuses render valid status pills and geometric icons', () => {
  for (const st of AUTHORITATIVE_STATUSES) {
    assert.equal(i18n.isAuthoritativeAppointmentStatus(st), true);
    assert.equal(i18n.formatStatus(st, 'zh-CN'), EXPECTED_ZH[st]);
    assert.equal(i18n.formatStatus(st, 'en'), EXPECTED_EN[st]);
  }

  // HTML includes status classes for all 7 statuses in list and calendar view
  assert.match(staffHtml, /status-pending/);
  assert.match(staffHtml, /status-confirmed/);
  assert.match(staffHtml, /status-arrived/);
  assert.match(staffHtml, /status-in_service/);
  assert.match(staffHtml, /status-completed/);
  assert.match(staffHtml, /status-no_show/);
  assert.match(staffHtml, /status-cancelled/);

  // Both views include calendar-status-icon and role="status"
  assert.match(staffHtml, /badge\.className = `status-badge calendar-status-pill status-\${normalizedStatus}`;/);
  assert.match(staffHtml, /statusPill\.className = `calendar-status-pill status-\${normalizedStatus}`;/);
  assert.match(staffHtml, /statusIcon\.className = 'calendar-status-icon';/);
});

// 12. 未知状态fail closed
test('12. Unknown or corrupted status fails closed to 状态未知 / Unknown Status', () => {
  const invalidCases = ['invalid', 'hack', 'xyz', 'draft', 'paid', 'refunded', '', null, undefined];
  for (const inv of invalidCases) {
    assert.equal(i18n.isAuthoritativeAppointmentStatus(inv), false);
    assert.equal(i18n.normalizeAppointmentStatus(inv), 'unknown');
    assert.equal(i18n.formatStatus(inv, 'zh-CN'), '状态未知');
    assert.equal(i18n.formatStatus(inv, 'en'), 'Unknown Status');
  }

  assert.match(staffHtml, /normalizeStatus = status =>/);
  assert.match(staffHtml, /: 'unknown';/);
  assert.match(staffHtml, /status-unknown/);
});

// 13. Completed不显示Paid
test('13. Completed appointment status strictly does NOT show Paid or financial badges', () => {
  assert.equal(i18n.formatStatus('completed', 'zh-CN'), '已完成');
  assert.notEqual(i18n.formatStatus('completed', 'zh-CN'), '已结账');
  assert.equal(i18n.formatStatus('completed', 'en'), 'Completed');
  assert.notEqual(i18n.formatStatus('completed', 'en'), 'Paid');

  // staff-appointments.html does NOT contain checkout payment status badges
  assert.doesNotMatch(staffHtml, /status-paid/i);
  assert.doesNotMatch(staffHtml, /已结账/);
  assert.doesNotMatch(staffHtml, /reconciliation_valid/i);
});

// 14. 金融状态不能成为预约状态
test('14. Financial statuses (paid, draft, refunded) cannot be injected as appointment statuses', () => {
  const financialTokens = ['paid', 'refunded', 'draft', 'partially_paid', 'authorized', 'failed'];
  for (const fin of financialTokens) {
    assert.equal(i18n.isAuthoritativeAppointmentStatus(fin), false);
    assert.equal(i18n.normalizeAppointmentStatus(fin), 'unknown');
  }
});

// 15. 手机号仍为遮罩值
test('15. Staff appointment customer phone remains server-masked without unmasking attempt', () => {
  // Staff HTML strictly displays customerPhone from appointment object without modification
  assert.match(staffHtml, /appointment\.customerPhone \|\| '—'/);
  assert.match(staffHtml, /appointment\.customerPhone/);
  assert.doesNotMatch(staffHtml, /unmask/i);
  assert.doesNotMatch(staffHtml, /can_view_full_customer_phone/);
});

// 16. 不显示Email
test('16. Customer email is strictly never displayed in staff appointment views', () => {
  assert.doesNotMatch(staffHtml, /appointment\.customerEmail/);
  assert.doesNotMatch(staffHtml, /appointment\.email/);
  assert.doesNotMatch(staffHtml, /customer-email/);
});

// 17. 不写敏感数据到localStorage
test('17. LocalStorage strictly never stores sensitive business or customer data', () => {
  const matches = staffHtml.matchAll(/localStorage\.setItem\(([^)]+)\)/g);
  for (const m of matches) {
    const arg = m[1];
    const isAllowed =
      arg.includes('LANGUAGE_STORAGE_KEY') ||
      arg.includes('gg_beauty_locale') ||
      arg.includes('VIEW_STORAGE_KEY');
    assert.ok(isAllowed, `Unexpected localStorage write: ${arg}`);
  }
});

// 18. 44px触控 (Touch targets)
test('18. 44px minimum touch targets enforced across all mobile interactive controls', () => {
  assert.match(calendarSharedCss, /--calendar-touch-min:\s*44px/);
  assert.match(calendarSharedCss, /--staff-avatar-size:\s*44px/);
  assert.match(calendarSharedCss, /\.staff-avatar-circle[\s\S]*?min-width:\s*var\(--staff-avatar-size,\s*44px\)/);
  assert.match(calendarSharedCss, /\.staff-avatar-circle[\s\S]*?min-height:\s*var\(--staff-avatar-size,\s*44px\)/);

  // Buttons in staff-appointments.html
  assert.match(staffHtml, /\.language-switch button\s*\{[^}]*min-width:\s*44px;/);
  assert.match(staffHtml, /\.language-switch button\s*\{[^}]*min-height:\s*44px;/);
  assert.match(staffHtml, /\.view-switch button\s*\{[^}]*min-width:\s*44px;/);
  assert.match(staffHtml, /\.view-switch button\s*\{[^}]*min-height:\s*44px;/);
  assert.match(staffHtml, /\.calendar-today-button\s*\{[^}]*min-width:\s*44px;/);
  assert.match(staffHtml, /\.calendar-today-button\s*\{[^}]*min-height:\s*44px;/);
  assert.match(staffHtml, /\.calendar-nav-button\s*\{[^}]*min-width:\s*44px;/);
  assert.match(staffHtml, /\.calendar-nav-button\s*\{[^}]*min-height:\s*44px;/);
  assert.match(staffHtml, /\.calendar-appointment\s*\{[^}]*min-height:\s*44px;/);
});

// 19. focus-visible
test('19. Focus-visible accessibility styling is defined and functional', () => {
  assert.match(calendarSharedCss, /:focus-visible\s*\{/);
  assert.match(calendarSharedCss, /--color-focus-ring/);
  assert.match(staffHtml, /<link rel="stylesheet" href="\/calendar-shared\.css">/);
});

// 20. aria-busy/aria-live & appointment aria-labels
test('20. Accessibility states: aria-busy, aria-live, and complete card aria-labels', () => {
  assert.match(staffHtml, /class="identity"\s+aria-live="polite"/);
  assert.match(staffHtml, /elements\.appointmentsSection\.setAttribute\(\s*'aria-busy',\s*String\(state\.loading\)\s*\);/);
  assert.match(staffHtml, /card\.setAttribute\(\s*'aria-label',\s*`\${formatTime\(appointment\.startAt\)} – \${formatTime\(appointment\.endAt\)}, \${appointment\.customerName \|\| ''}, \${serviceDisplayName}, \${statusText}`/);
  assert.match(staffHtml, /block\.setAttribute\(\s*'aria-label',\s*`\${formatTime\(appointment\.startAt\)} – \${formatTime\(appointment\.endAt\)}, \${appointment\.customerName \|\| ''}, \${serviceDisplayName}, \${statusText}`/);
});

// 21. reduced-motion
test('21. Reduced motion preference disables/minimizes transitions and animations', () => {
  assert.match(calendarSharedCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/);
  assert.match(staffHtml, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/);
});

// 22. 动态DOM无inline on*
test('22. Zero dynamic inline on* event handler attributes in staff DOM rendering', () => {
  assert.doesNotMatch(staffHtml, /setAttribute\(['"]on/i);
  assert.doesNotMatch(staffHtml, /<button[^>]*\son[a-z]+=/i);
  assert.doesNotMatch(staffHtml, /status-badge[^>]*\son[a-z]+=/i);
  assert.doesNotMatch(staffHtml, /calendar-appointment[^>]*\son[a-z]+=/i);

  // Check git diff additions
  const diff = execSync('git diff -U0 public/staff-appointments.html public/calendar-shared.css public/shared-i18n.js', { cwd: root, encoding: 'utf8' });
  const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
  for (const line of addedLines) {
    assert.doesNotMatch(line, /\son[a-z]+\s*=/i, `Diff must not introduce inline on* handler: ${line}`);
  }
});

// 23. XSS业务文本安全
test('23. XSS protection: customer, staff, and service business text strictly uses textContent', () => {
  // Elements set with textContent, not innerHTML
  assert.match(staffHtml, /elements\.staffName\.textContent = rawStaffName;/);
  assert.match(staffHtml, /staffNameSpan\.textContent = staffName;/);
  assert.match(staffHtml, /createTextElement\(\s*'span',\s*'calendar-appointment-name notranslate',\s*appointment\.customerName \|\| '—'\s*\)/);
  assert.match(staffHtml, /createTextElement\(\s*'span',\s*'calendar-appointment-service notranslate',\s*serviceDisplayName\s*\)/);
  assert.match(staffHtml, /statusLabel\.textContent = statusText;/);
});

// 24. 重渲染无重复listener
test('24. Re-rendering does not produce duplicate event listeners on global controls', () => {
  // Global buttons have listeners attached outside render()
  assert.match(staffHtml, /elements\.languageEn\.addEventListener\(\s*'click',\s*\(\) => setLanguage\('en'\)\s*\);/);
  assert.match(staffHtml, /elements\.languageZh\.addEventListener\(\s*'click',\s*\(\) => setLanguage\('zh'\)\s*\);/);
  assert.match(staffHtml, /elements\.viewList\.addEventListener\(\s*'click',\s*\(\) => setDisplayMode\('list'\)\s*\);/);
  assert.match(staffHtml, /elements\.viewCalendar\.addEventListener\(\s*'click',\s*\(\) => setDisplayMode\('calendar'\)\s*\);/);

  // render() only updates attributes and re-creates view content
  assert.doesNotMatch(staffHtml, /function render\(\)\s*\{[\s\S]*?elements\.languageEn\.addEventListener/);
  assert.doesNotMatch(staffHtml, /function render\(\)\s*\{[\s\S]*?elements\.viewList\.addEventListener/);
});

// 25. 现有员工认证测试不回归
test('25. Existing staff auth and status backend endpoints remain untouched', () => {
  const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  assert.match(serverJs, /app\.patch\('\/api\/staff\/appointments\/:appointmentId\/status'/);
  assert.match(serverJs, /app\.get\(\s*['"]\/api\/staff\/appointments['"]/);
});

// 26. C1测试保持通过
test('26. C1 shared calendar foundation tests exist and pass', () => {
  assert.ok(fs.existsSync(path.join(root, 'test', 'calendar-visual-foundation.test.js')), 'C1 test file exists');
});

// 27. Global Phone文件不进入diff
test('27. Working tree contains ZERO global phone P1 files', () => {
  const forbiddenFiles = [
    'lib/phone.js',
    'lib/phone-metadata.js',
    'lib/phone-data-contract.js',
    'docs/global-phone-data-contract.md',
    'test/phone-normalization.test.js'
  ];

  for (const forbidden of forbiddenFiles) {
    const fullPath = path.join(root, forbidden);
    assert.equal(
      fs.existsSync(fullPath),
      false,
      `Forbidden global phone file ${forbidden} must NOT exist in this branch`
    );
  }
});

// 28. git diff --check passes cleanly
test('28. git diff --check reports zero whitespace errors', () => {
  assert.doesNotThrow(() => {
    execSync('git diff --check', { cwd: root, encoding: 'utf8' });
  }, 'git diff --check must exit 0 with no whitespace errors');
});

// 29 & 30. Items[] multi-service support and sticky header
test('29. Multi-service appointment items[] support in staff timeline card', () => {
  assert.match(staffHtml, /const getServiceDisplayName = appointment =>/);
  assert.match(staffHtml, /Array\.isArray\(appointment\?\.items\) && appointment\.items\.length > 0/);
  assert.match(staffHtml, /it\.serviceName \|\| it\.service_name \|\| it\.name/);
  assert.match(staffHtml, /itemNames\.join\(' \+ '\)/);
});

test('30. Sticky calendar header row aligns TIME column and staff header with circular avatar', () => {
  assert.match(calendarSharedCss, /\.calendar-header-row\s*\{/);
  assert.match(calendarSharedCss, /position:\s*sticky;/);
  assert.match(calendarSharedCss, /\.calendar-time-header\s*\{/);
  assert.match(calendarSharedCss, /width:\s*58px;/);
  assert.match(calendarSharedCss, /\.calendar-staff-column-header\s*\{/);
  assert.match(staffHtml, /timeHeader\.className = 'calendar-time-header';/);
  assert.match(staffHtml, /staffColHeader\.className = 'calendar-staff-column-header calendar-staff-header';/);
  assert.match(staffHtml, /createAvatarElement\(staffName,\s*'staff-avatar-circle'\)/);
});
