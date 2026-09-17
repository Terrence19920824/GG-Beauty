'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const sharedI18nPath = path.join(root, 'public', 'shared-i18n.js');
const calendarSharedCssPath = path.join(root, 'public', 'calendar-shared.css');
const adminHtmlPath = path.join(root, 'public', 'admin.html');
const staffAppointmentsHtmlPath = path.join(root, 'public', 'staff-appointments.html');

const i18n = require(sharedI18nPath);
const i18nSource = fs.readFileSync(sharedI18nPath, 'utf8');
const calendarSharedCss = fs.readFileSync(calendarSharedCssPath, 'utf8');
const adminHtml = fs.readFileSync(adminHtmlPath, 'utf8');
const staffHtml = fs.readFileSync(staffAppointmentsHtmlPath, 'utf8');
const serverJsSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

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
  unknownStatus: '状态未知',
  loading: '加载中',
  loadFailed: '加载失败',
  calendarSessionExpired: '登录已过期'
};

const EXPECTED_EN = {
  pending: 'Pending',
  confirmed: 'Confirmed',
  arrived: 'Arrived',
  in_service: 'In Service',
  completed: 'Completed',
  no_show: 'No Show',
  cancelled: 'Cancelled',
  unknownStatus: 'Unknown Status',
  loading: 'Loading',
  loadFailed: 'Load Failed',
  calendarSessionExpired: 'Session Expired'
};

// 1. 7 Authoritative statuses Chinese copy
test('1. 7 authoritative statuses resolve to exact Chinese single-language text', () => {
  for (const st of AUTHORITATIVE_STATUSES) {
    assert.equal(
      i18n.formatStatus(st, 'zh-CN'),
      EXPECTED_ZH[st],
      `Status ${st} in zh-CN must be ${EXPECTED_ZH[st]}`
    );
  }
});

// 2. 7 Authoritative statuses English copy
test('2. 7 authoritative statuses resolve to exact English single-language text', () => {
  for (const st of AUTHORITATIVE_STATUSES) {
    assert.equal(
      i18n.formatStatus(st, 'en'),
      EXPECTED_EN[st],
      `Status ${st} in en must be ${EXPECTED_EN[st]}`
    );
  }
});

// 3. Zero bilingual slash concatenation
test('3. Zero bilingual slash concatenation in shared dictionary and pages', () => {
  for (const st of AUTHORITATIVE_STATUSES) {
    const zhText = i18n.formatStatus(st, 'zh-CN');
    const enText = i18n.formatStatus(st, 'en');
    assert.equal(zhText.includes('/'), false, `zh text "${zhText}" must not contain slash`);
    assert.equal(enText.includes('/'), false, `en text "${enText}" must not contain slash`);
    assert.doesNotMatch(zhText, /[a-zA-Z]/, `zh text "${zhText}" must not contain English letters`);
  }
  // Verify staff-appointments.html status dictionary has no slash
  const staffZhStatusesMatch = staffHtml.match(/statuses:\s*\{[\s\S]*?pending:\s*'待确认'[\s\S]*?\}/);
  assert.ok(staffZhStatusesMatch, 'staff zh statuses dictionary exists');
  assert.equal(staffZhStatusesMatch[0].includes('/'), false, 'staff zh statuses must not contain slash');

  const staffEnStatusesMatch = staffHtml.match(/statuses:\s*\{[\s\S]*?pending:\s*'Pending'[\s\S]*?\}/);
  assert.ok(staffEnStatusesMatch, 'staff en statuses dictionary exists');
  assert.equal(staffEnStatusesMatch[0].includes('/'), false, 'staff en statuses must not contain slash');
});

// 4. Locale switch instant re-rendering
test('4. Locale switch returns single-language status without cache contamination', () => {
  for (const st of AUTHORITATIVE_STATUSES) {
    assert.equal(i18n.formatStatus(st, 'zh-CN'), EXPECTED_ZH[st]);
    assert.equal(i18n.formatStatus(st, 'en'), EXPECTED_EN[st]);
    assert.equal(i18n.formatStatus(st, 'zh-CN'), EXPECTED_ZH[st]);
  }
});

// 5. Unknown/missing status fail-closed to 状态未知 / Unknown Status
test('5. Unknown or missing statuses fail closed to safe unknown status', () => {
  const invalidStatuses = [
    '',
    ' ',
    null,
    undefined,
    'unknown',
    'invalid',
    'draft',
    'paid',
    'refunded',
    'partially_paid',
    'late_not_arrived',
    'in_progress',
    'waiting',
    123,
    {},
    []
  ];

  for (const invalid of invalidStatuses) {
    assert.equal(i18n.isAuthoritativeAppointmentStatus(invalid), false);
    assert.equal(i18n.normalizeAppointmentStatus(invalid), 'unknown');
    assert.equal(i18n.formatStatus(invalid, 'zh-CN'), EXPECTED_ZH.unknownStatus);
    assert.equal(i18n.formatStatus(invalid, 'en'), EXPECTED_EN.unknownStatus);
  }

  // Loading, load failed, and session expired keys
  assert.equal(i18n.t('loading', 'zh-CN'), EXPECTED_ZH.loading);
  assert.equal(i18n.t('loading', 'en'), EXPECTED_EN.loading);
  assert.equal(i18n.t('loadFailed', 'zh-CN'), EXPECTED_ZH.loadFailed);
  assert.equal(i18n.t('loadFailed', 'en'), EXPECTED_EN.loadFailed);
  assert.equal(i18n.t('calendarSessionExpired', 'zh-CN'), EXPECTED_ZH.calendarSessionExpired);
  assert.equal(i18n.t('calendarSessionExpired', 'en'), EXPECTED_EN.calendarSessionExpired);
});

// 6. paid/refunded rejected as appointment status
test('6. Financial statuses (paid, refunded, etc.) are strictly rejected as appointment statuses', () => {
  const financialStatuses = ['paid', 'refunded', 'draft', 'partially_paid', 'authorized', 'failed'];
  for (const fin of financialStatuses) {
    assert.equal(i18n.isAuthoritativeAppointmentStatus(fin), false);
    assert.equal(i18n.normalizeAppointmentStatus(fin), 'unknown');
    assert.equal(i18n.formatStatus(fin, 'zh-CN'), '状态未知');
    assert.equal(i18n.formatStatus(fin, 'en'), 'Unknown Status');
  }
});

// Helper to create sandboxed DOM context for admin.html testing
function createAdminContext(initialState = {}) {
  const elements = new Map();
  for (const id of [
    'loginOverlay',
    'adminContent',
    'loginMessage',
    'ownerLoginIdentifier',
    'adminPassword',
    'ownerShopSlug',
    'totalCount',
    'pendingCount',
    'todayCount',
    'adminLanguageZh',
    'adminLanguageEn',
    'content'
  ]) {
    elements.set(id, {
      id,
      value: '',
      textContent: '',
      innerHTML: '',
      className: '',
      hidden: id === 'adminContent',
      disabled: false,
      style: {},
      setAttribute(k, v) { this[k] = v; },
      getAttribute(k) { return this[k] || null; },
      removeAttribute(k) { delete this[k]; },
      addEventListener() {},
      removeEventListener() {},
      querySelector() { return null; },
      querySelectorAll() { return []; },
      closest() { return null; }
    });
  }

  let currentApiData = [];
  const context = {
    console,
    Date,
    Intl,
    JSON,
    ggI18n: i18n,
    ownerSelfService: {
      _state: { locale: 'zh-CN', ...(initialState.ownerState || {}) },
      setLocale(loc) { this._state.locale = loc; },
      setProfile() {},
      reset() {}
    },
    confirm: () => true,
    alert: () => {},
    fetch: async (url) => {
      return {
        status: 200,
        ok: true,
        async json() {
          if (String(url).includes('/api/appointments-db')) {
            return { success: true, data: currentApiData, appointments: currentApiData };
          }
          return { success: true };
        }
      };
    },
    document: {
      getElementById(id) {
        if (!elements.has(id)) {
          elements.set(id, {
            id,
            value: '',
            textContent: '',
            innerHTML: '',
            className: '',
            style: {},
            setAttribute(k, v) { this[k] = v; },
            getAttribute(k) { return this[k] || null; },
            removeAttribute(k) { delete this[k]; },
            addEventListener() {},
            removeEventListener() {},
            querySelector() { return null; },
            querySelectorAll() { return []; },
            closest() { return null; }
          });
        }
        return elements.get(id);
      },
      querySelectorAll() { return []; },
      addEventListener() {},
      removeEventListener() {}
    },
    FEATURE_CHECKOUT_ENABLED: false
  };
  context.window = context;
  context.globalThis = context;

  const scriptMatch = adminHtml.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'admin inline script must exist');
  vm.createContext(context);
  vm.runInContext(scriptMatch[1], context);

  const loadAppointments = async (appts) => {
    currentApiData = appts;
    await context.loadAppointments();
  };

  return { context, elements, loadAppointments };
}

// 7. Completed ≠ Paid strictly maintained
test('7. appointment.status="completed" and checkout=null does NOT display Paid (Completed != Paid)', async () => {
  const { context, elements, loadAppointments } = createAdminContext();
  await loadAppointments([{
    id: '00000000-0000-4000-8000-000000000001',
    start_at: '2030-01-01T02:00:00Z',
    customer_name: 'Test Customer',
    customer_phone: '91234567',
    service_name: 'Haircut',
    staff_name: 'Stylist',
    status: 'completed',
    items: [],
    checkout: null,
    can_start_checkout: false
  }]);

  const rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="status completed"/);
  assert.match(rendered, /已完成/);
  assert.doesNotMatch(rendered, /status-paid/);
  assert.doesNotMatch(rendered, /已结账/);
  assert.strictEqual(context.resolveCheckoutFinancialState({ status: 'completed', checkout: null }), null);
});

// 8. Owner Checkout financial badges intact
test('8. Owner checkout financial badges render separately from appointment status', async () => {
  const { context, elements, loadAppointments } = createAdminContext();
  await loadAppointments([{
    id: '00000000-0000-4000-8000-000000000002',
    start_at: '2030-01-01T02:00:00Z',
    customer_name: 'Test Customer',
    customer_phone: '91234567',
    service_name: 'Haircut',
    staff_name: 'Stylist',
    status: 'pending',
    items: [],
    checkout: {
      id: 'chk-001',
      payment_state: 'paid',
      reconciliation_valid: true
    },
    can_start_checkout: false
  }]);

  const rendered = elements.get('content').innerHTML;
  assert.match(rendered, /class="status pending"/);
  assert.match(rendered, /待确认/);
  assert.match(rendered, /class="pill status-paid notranslate"/);
  assert.match(rendered, /已结账/);
});

// 9. Staff phone masking intact
test('9. Staff appointment view preserves phone masking (*** 4033)', () => {
  // Front-end staff UI strictly renders customerPhone from API without client unmasking
  assert.match(staffHtml, /appointment\.customerPhone/);
  // Backend API query masks customerPhone by default for staff
  assert.match(serverJsSource, /'•••••'\s*\|\|\s*RIGHT\(/);
  assert.match(serverJsSource, /REGEXP_REPLACE\(\s*c\.phone/);
});

// 10. Status button routes and payloads unchanged
test('10. Owner appointment action buttons produce unchanged status payloads', async () => {
  const { context, elements, loadAppointments } = createAdminContext();
  await loadAppointments([{
    id: '00000000-0000-4000-8000-000000000003',
    start_at: '2030-01-01T02:00:00Z',
    customer_name: 'Status Test',
    customer_phone: '91234567',
    service_name: 'Haircut',
    staff_name: 'Stylist',
    status: 'pending',
    items: [],
    checkout: null,
    can_start_checkout: false
  }]);

  const contentHtml = elements.get('content').innerHTML;
  assert.match(contentHtml, /data-action="status"/);
  assert.match(contentHtml, /data-target-status="confirmed"/);
  assert.match(contentHtml, /data-target-status="cancelled"/);
});

// 11. 44px touch targets on interactive buttons
test('11. 44px touch targets enforced on interactive elements', () => {
  assert.match(calendarSharedCss, /--calendar-touch-min:\s*44px/);
  assert.match(calendarSharedCss, /min-height:\s*var\(--calendar-touch-min,\s*44px\)/);
  assert.match(calendarSharedCss, /min-width:\s*var\(--calendar-touch-min,\s*44px\)/);

  // admin.html table action buttons
  assert.match(adminHtml, /table button\[data-action="status"\]\s*\{[^}]*min-height:\s*44px;/);
  assert.match(adminHtml, /table button\[data-action="status"\]\s*\{[^}]*min-width:\s*44px;/);

  // staff-appointments.html language & view switch buttons
  assert.match(staffHtml, /\.language-switch button\s*\{[^}]*min-width:\s*44px;/);
  assert.match(staffHtml, /\.language-switch button\s*\{[^}]*min-height:\s*44px;/);
  assert.match(staffHtml, /\.view-switch button\s*\{[^}]*min-width:\s*44px;/);
  assert.match(staffHtml, /\.view-switch button\s*\{[^}]*min-height:\s*44px;/);
});

// 12. Focus-visible styles present
test('12. Focus-visible defined with clear ring in shared CSS', () => {
  assert.match(calendarSharedCss, /:focus-visible\s*\{/);
  assert.match(calendarSharedCss, /--color-focus-ring/);
  assert.match(calendarSharedCss, /outline:\s*2px solid/);
});

// 13. Prefers-reduced-motion styles present
test('13. Prefers-reduced-motion media query defines safe minimal animation/transition', () => {
  assert.match(calendarSharedCss, /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{/);
  assert.match(calendarSharedCss, /animation-duration:\s*0\.01ms\s*!important/);
  assert.match(calendarSharedCss, /transition-duration:\s*0\.01ms\s*!important/);
});

// 14. ARIA compliance (aria-busy, aria-live, role="status")
test('14. ARIA compliance: aria-busy, aria-live, role="status", and localized aria-label', () => {
  assert.match(adminHtml, /id="content"[^>]*aria-busy="true"[^>]*aria-live="polite"/);
  assert.match(adminHtml, /role="status"/);
  assert.match(adminHtml, /aria-label="\$\{escapeHtml\(getStatusText\(item\.status\)\)\}"/);

  assert.match(staffHtml, /\.setAttribute\('role',\s*'status'\)/);
  assert.match(staffHtml, /\.setAttribute\('aria-label',\s*statusText\)/);
  assert.match(staffHtml, /\.calendar-appointment[\s\S]*?aria-label/);
});

// 15. No inline dynamic on* handlers
test('15. Zero inline dynamic on* handlers introduced in calendar components', () => {
  // Check that calendar-shared.css and shared-i18n.js have no inline on* handlers
  assert.doesNotMatch(calendarSharedCss, /\son[a-z]+\s*=/i);
  assert.doesNotMatch(i18nSource, /\son[a-z]+\s*=/i);

  // In admin.html, status buttons and status pills must NOT have inline on* handlers
  assert.doesNotMatch(adminHtml, /data-action="status"[^>]*\son[a-z]+=/i);
  assert.doesNotMatch(adminHtml, /class="status [^"]*"[^>]*\son[a-z]+=/i);

  // In staff-appointments.html, status badges, appointment cards, view/lang buttons must NOT have inline on* handlers
  assert.doesNotMatch(staffHtml, /status-badge[^>]*\son[a-z]+=/i);
  assert.doesNotMatch(staffHtml, /calendar-appointment[^>]*\son[a-z]+=/i);
  assert.doesNotMatch(staffHtml, /\son[a-z]+\s*=/i);

  // Git diff must introduce zero on* handlers
  const diff = execSync('git diff -U0', { cwd: root, encoding: 'utf8' });
  const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
  for (const line of addedLines) {
    assert.doesNotMatch(line, /\son[a-z]+\s*=/i, `Diff must not introduce inline on* handler: ${line}`);
  }
});

// 16. No XSS sink in status rendering
test('16. No unescaped XSS sinks in status rendering', () => {
  // getStatusText in admin.html must escape output
  assert.match(adminHtml, /function getStatusText\([\s\S]*?escapeHtml\(/);
  // staff-appointments.html creates DOM elements via textContent
  assert.match(staffHtml, /textSpan\.textContent = statusText;/);
});

// 17. No global phone P1 files present
test('17. Working tree contains ZERO global phone P1 files', () => {
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

// 18. Shared CSS token definitions
test('18. Shared CSS token definitions exist for all authoritative statuses and states', () => {
  const requiredTokens = [
    '--calendar-touch-min',
    '--color-status-pending',
    '--color-status-pending-soft',
    '--color-status-confirmed',
    '--color-status-confirmed-soft',
    '--color-status-arrived',
    '--color-status-arrived-soft',
    '--color-status-in-service',
    '--color-status-in-service-soft',
    '--color-status-completed',
    '--color-status-completed-soft',
    '--color-status-no-show',
    '--color-status-no-show-soft',
    '--color-status-cancelled',
    '--color-status-cancelled-soft',
    '--color-status-unknown',
    '--color-status-unknown-soft',
    '--color-late-alert',
    '--color-live-time-line',
    '--color-focus-ring'
  ];

  for (const token of requiredTokens) {
    assert.ok(
      calendarSharedCss.includes(token),
      `CSS custom property ${token} must be defined in calendar-shared.css`
    );
  }
});

// 19. Non-color geometric indicators
test('19. Non-color geometric indicator glyphs defined with distinct shapes and localized text', () => {
  assert.match(calendarSharedCss, /\.calendar-status-icon/);
  assert.match(calendarSharedCss, /\.status-pending[\s\S]*?\.calendar-status-icon/);
  assert.match(calendarSharedCss, /\.status-confirmed[\s\S]*?\.calendar-status-icon/);
  assert.match(calendarSharedCss, /\.status-arrived[\s\S]*?\.calendar-status-icon/);
  assert.match(calendarSharedCss, /\.status-in-service[\s\S]*?\.calendar-status-icon/);
  assert.match(calendarSharedCss, /\.status-completed[\s\S]*?\.calendar-status-icon/);
  assert.match(calendarSharedCss, /\.status-no-show[\s\S]*?\.calendar-status-icon/);
  assert.match(calendarSharedCss, /\.status-cancelled[\s\S]*?\.calendar-status-icon/);
  assert.match(calendarSharedCss, /\.status-unknown[\s\S]*?\.calendar-status-icon/);

  // Both pages render the icon inside the status container
  assert.match(adminHtml, /<span class="calendar-status-icon" aria-hidden="true"><\/span>/);
  assert.match(staffHtml, /icon\.className = 'calendar-status-icon';/);
});

// 20. Git diff whitespace check
test('20. Git diff check passes cleanly with zero whitespace issues', () => {
  const result = execSync('git diff --check', { cwd: root, encoding: 'utf8' });
  assert.equal(result.trim(), '', 'git diff --check must be clean');
});
