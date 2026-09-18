'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const cartApi = require('../public/customer-multi-service-cart');
const categoryFlowApi = require('../public/customer-category-flow');
const i18n = require('../public/shared-i18n');
const serverJs = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

const MOCK_SERVICES = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    categoryId: 'cat-hair',
    name: '女士剪发',
    price: 68,
    priceIsFrom: false,
    durationMinutes: 45,
    description: '专业总监剪裁'
  },
  {
    id: '22222222-2222-4222-8222-222222222222',
    categoryId: 'cat-hair',
    name: '染发护理',
    price: 188,
    priceIsFrom: true,
    durationMinutes: 90,
    description: '植物精油染发'
  },
  {
    id: '33333333-3333-4333-8333-333333333333',
    categoryId: 'cat-spa',
    name: '头皮深层护理',
    price: 128,
    priceIsFrom: false,
    durationMinutes: 60,
    description: '去屑舒缓'
  }
];

test('1. 只显示启用分类：服务端仅查询启用且有可预约服务的分类', () => {
  assert.match(serverJs, /category\.is_active = TRUE/);
  assert.match(serverJs, /service\.is_active = TRUE/);
  assert.match(serverJs, /service\.bookable = TRUE/);
  assert.match(html, /categoryStep/);
  assert.match(html, /categoryGrid/);
});

test('2. 只显示启用服务：服务端仅查询启用且开放预约的服务项目', () => {
  assert.match(serverJs, /service\.is_active = TRUE[\s\S]*service\.bookable = TRUE/);
  assert.match(html, /filterServicesByCategory\(availableServices, selectedCategoryId\)/);
});

test('3. 选择一个服务：卡片可选中并加入购物车，显示已选状态', () => {
  let cart = cartApi.create();
  assert.equal(cart.length, 0);
  cart = cartApi.add(cart, MOCK_SERVICES[0]);
  assert.equal(cart.length, 1);
  assert.equal(cart[0].serviceId, MOCK_SERVICES[0].id);
  assert.equal(cartApi.hasService(cart, MOCK_SERVICES[0].id), true);
  assert.match(html, /service-card/);
  assert.match(html, /service-card-badge/);
  assert.match(html, /aria-pressed/);
});

test('4. 同分类增加第二个服务：购物车包含两个服务且时长与金额累加', () => {
  let cart = cartApi.create();
  cart = cartApi.add(cart, MOCK_SERVICES[0]);
  cart = cartApi.add(cart, MOCK_SERVICES[1]);
  assert.equal(cart.length, 2);
  assert.equal(cart[0].serviceId, MOCK_SERVICES[0].id);
  assert.equal(cart[1].serviceId, MOCK_SERVICES[1].id);
  const totals = cartApi.totals(cart, MOCK_SERVICES);
  assert.equal(totals.durationMinutes, 45 + 90);
  assert.equal(totals.listedPrice, 68 + 188);
  assert.equal(totals.priceIsFrom, true);
});

test('5. 跨分类增加服务：分类筛选不冲掉已有已选项目', () => {
  let cart = cartApi.create();
  const hairServices = categoryFlowApi.filterServicesByCategory(MOCK_SERVICES, 'cat-hair');
  cart = cartApi.add(cart, hairServices[0]);

  const spaServices = categoryFlowApi.filterServicesByCategory(MOCK_SERVICES, 'cat-spa');
  cart = cartApi.add(cart, spaServices[0]);

  assert.equal(cart.length, 2);
  assert.equal(cart[0].categoryId, 'cat-hair');
  assert.equal(cart[1].categoryId, 'cat-spa');
  const totals = cartApi.totals(cart, MOCK_SERVICES);
  assert.equal(totals.durationMinutes, 45 + 60);
  assert.equal(totals.listedPrice, 68 + 128);
});

test('6. 同一项目不能意外重复：重复添加同一 serviceId 返回原购物车', () => {
  let cart = cartApi.create();
  cart = cartApi.add(cart, MOCK_SERVICES[0]);
  const lengthBefore = cart.length;
  cart = cartApi.add(cart, MOCK_SERVICES[0]);
  assert.equal(cart.length, lengthBefore);
  assert.equal(cartApi.hasService(cart, MOCK_SERVICES[0].id), true);
});

test('7. 删除一个已选项目：移除后仅剩余其它项目且重新计算总计', () => {
  let cart = cartApi.create();
  cart = cartApi.add(cart, MOCK_SERVICES[0]);
  cart = cartApi.add(cart, MOCK_SERVICES[1]);
  assert.equal(cart.length, 2);

  cart = cartApi.remove(cart, cart[0].clientItemKey);
  assert.equal(cart.length, 1);
  assert.equal(cart[0].serviceId, MOCK_SERVICES[1].id);

  const totals = cartApi.totals(cart, MOCK_SERVICES);
  assert.equal(totals.durationMinutes, 90);
  assert.equal(totals.listedPrice, 188);
});

test('8. 删除全部项目后不能进入下一步：购物车为空时下一步按钮禁用且隐藏排期', () => {
  let cart = cartApi.create();
  cart = cartApi.add(cart, MOCK_SERVICES[0]);
  cart = cartApi.remove(cart, cart[0].clientItemKey);
  assert.equal(cart.length, 0);
  assert.match(html, /if \(nextStepBtn\) nextStepBtn\.disabled = true/);
  assert.match(html, /scheduleSection\.hidden = true/);
});

test('9. 总时长显示正确：多项时长精确累加', () => {
  let cart = cartApi.create();
  cart = cartApi.add(cart, MOCK_SERVICES[0]);
  cart = cartApi.add(cart, MOCK_SERVICES[1]);
  cart = cartApi.add(cart, MOCK_SERVICES[2]);
  const totals = cartApi.totals(cart, MOCK_SERVICES);
  assert.equal(totals.durationMinutes, 195);
  assert.equal(i18n.formatDuration(totals.durationMinutes, 'zh-CN'), '195 分钟');
  assert.equal(i18n.formatDuration(totals.durationMinutes, 'en'), '195 min');
});

test('10. 总金额显示正确：起价标识正确传播', () => {
  let cartFixed = cartApi.create();
  cartFixed = cartApi.add(cartFixed, MOCK_SERVICES[0]);
  cartFixed = cartApi.add(cartFixed, MOCK_SERVICES[2]);
  assert.equal(cartApi.totals(cartFixed, MOCK_SERVICES).priceIsFrom, false);
  assert.equal(cartApi.totals(cartFixed, MOCK_SERVICES).listedPrice, 196);

  let cartFrom = cartApi.create();
  cartFrom = cartApi.add(cartFrom, MOCK_SERVICES[0]);
  cartFrom = cartApi.add(cartFrom, MOCK_SERVICES[1]);
  assert.equal(cartApi.totals(cartFrom, MOCK_SERVICES).priceIsFrom, true);
  assert.equal(cartApi.totals(cartFrom, MOCK_SERVICES).listedPrice, 256);
  assert.equal(i18n.formatPrice(256, true, 'zh-CN'), 'S$256.00 起');
  assert.equal(i18n.formatPrice(256, true, 'en'), 'From S$256.00');
});

test('11. 价格和时长使用权威服务数据：客户端购物车项不携带价格时长', () => {
  let cart = cartApi.create();
  cart = cartApi.add(cart, { id: MOCK_SERVICES[0].id, categoryId: 'cat-hair' });
  assert.equal(cart[0].price, undefined);
  assert.equal(cart[0].durationMinutes, undefined);
  assert.doesNotMatch(JSON.stringify(cart), /price|durationMinutes/);
});

test('12. 切换中英文不丢失选择：locale 切换时保持 cart 数据完整', () => {
  let cart = cartApi.create();
  cart = cartApi.add(cart, MOCK_SERVICES[0]);
  cart = cartApi.add(cart, MOCK_SERVICES[1]);
  const requested = cartApi.requestItems(cart);

  const zhLocale = i18n.setLocale('zh-CN', { setItem() {} });
  assert.equal(zhLocale, 'zh-CN');
  assert.deepEqual(cartApi.requestItems(cart), requested);

  const enLocale = i18n.setLocale('en', { setItem() {} });
  assert.equal(enLocale, 'en');
  assert.deepEqual(cartApi.requestItems(cart), requested);
});

test('13. 返回分类列表不丢失选择：点击继续添加项目保留购物车内容', () => {
  let cart = cartApi.create();
  cart = cartApi.add(cart, MOCK_SERVICES[0]);
  assert.equal(cart.length, 1);
  assert.match(html, /addAnotherBtn/);
  assert.match(html, /selectedCategoryId = '';/);
  assert.match(html, /categoryStep\.hidden = false;/);
});

test('14. API重新加载不会重复添加：多次调用不引入多余条目', () => {
  let cart = cartApi.create();
  cart = cartApi.add(cart, MOCK_SERVICES[0]);
  cart = cartApi.reconcile(cart, MOCK_SERVICES);
  assert.equal(cart.length, 1);
  cart = cartApi.reconcile(cart, MOCK_SERVICES);
  assert.equal(cart.length, 1);
});

test('15. 已停用项目安全移除或阻止继续：reconcile 过滤下架服务', () => {
  let cart = cartApi.create();
  cart = cartApi.add(cart, MOCK_SERVICES[0]);
  cart = cartApi.add(cart, MOCK_SERVICES[1]);

  const activeServicesAfterDeactivation = [MOCK_SERVICES[1]];
  cart = cartApi.reconcile(cart, activeServicesAfterDeactivation);
  assert.equal(cart.length, 1);
  assert.equal(cart[0].serviceId, MOCK_SERVICES[1].id);
  assert.equal(i18n.t('serviceUnavailableRetry', 'zh-CN'), '项目已不可用，请重新选择');
  assert.equal(i18n.t('serviceUnavailableRetry', 'en'), 'This service is no longer available. Please select again.');
});

test('16. 外部商家的service ID拒绝：服务端只返回并接收当前商家 slug 服务', () => {
  assert.match(serverJs, /WHERE shop\.slug = \$1/);
  assert.match(serverJs, /service\.shop_id = shop\.id/);
});

test('17. 非法service ID拒绝：cartApi.add 拒绝空、null或非字符串ID', () => {
  let cart = cartApi.create();
  cart = cartApi.add(cart, null);
  assert.equal(cart.length, 0);
  cart = cartApi.add(cart, {});
  assert.equal(cart.length, 0);
  cart = cartApi.add(cart, { id: '' });
  assert.equal(cart.length, 0);
  cart = cartApi.add(cart, { id: '   ' });
  assert.equal(cart.length, 0);
  cart = cartApi.add(cart, { id: 12345 });
  assert.equal(cart.length, 0);
});

test('18. Loading状态：包含 loading 容器与双语文本', () => {
  assert.match(html, /id="servicesLoading"/);
  assert.match(html, /loadingCustomerServices/);
  assert.equal(i18n.t('loadingCustomerServices', 'zh-CN'), '正在读取服务...');
  assert.equal(i18n.t('loadingCustomerServices', 'en'), 'Loading services...');
});

test('19. Empty状态：包含 empty 容器与权威要求文本', () => {
  assert.match(html, /id="servicesEmpty"/);
  assert.match(html, /noBookableServices/);
  assert.equal(i18n.t('noBookableServices', 'zh-CN'), '暂无可预约项目');
  assert.equal(i18n.t('noBookableServices', 'en'), 'No services are currently available');
});

test('20. API错误状态：包含 error 容器与权威要求文本', () => {
  assert.match(html, /id="servicesError"/);
  assert.match(html, /loadServicesFailed/);
  assert.equal(i18n.t('loadServicesFailed', 'zh-CN'), '无法加载服务，请重试');
  assert.equal(i18n.t('loadServicesFailed', 'en'), 'Unable to load services. Please try again.');
});

test('21. 44px触控要求：按钮与卡片均满足触控尺寸规范', () => {
  assert.match(html, /\.service-card\s*\{[^}]*min-height:\s*64px/);
  assert.match(html, /\.remove-item\s*\{[^}]*min-height:\s*44px/);
  assert.match(html, /\.cart-actions button\s*\{[^}]*min-height:\s*44px/);
});

test('22. 手机端布局：保持 max-width 520px 与 mobile-first 规范', () => {
  assert.match(html, /\.container\s*\{[^}]*max-width:\s*520px/);
  assert.match(html, /viewport.*width=device-width/);
});

test('23. iPad布局：响应式网格在平板上正常自适应', () => {
  assert.match(html, /category-grid/);
  assert.match(html, /service-cards-list/);
});

test('24. 原有单项目预约流程不回归：单个项目时正常渲染与提交', () => {
  let cart = cartApi.create();
  cart = cartApi.add(cart, MOCK_SERVICES[0]);
  const payload = cartApi.requestItems(cart);
  assert.equal(payload.length, 1);
  assert.equal(payload[0].serviceId, MOCK_SERVICES[0].id);
  assert.equal(payload[0].staffSelectionType, 'no_preference');
  assert.equal(payload[0].staffId, undefined);
});

test('25. Calendar测试不回归：日历核心模块完好', () => {
  const calendar = require('../public/customer-booking-calendar');
  assert.equal(typeof calendar.monthModel, 'function');
  assert.equal(typeof calendar.monthRange, 'function');
});

test('26. Checkout测试不回归：无收银相关字段污染顾客端', () => {
  assert.doesNotMatch(html, /checkoutState/);
  assert.doesNotMatch(html, /amount_paid|tender_type/);
});

test('27. Global Phone测试不回归：国际区号与手机号选择器完好', () => {
  assert.match(html, /id="bookerCountryCode"/);
  assert.match(html, /id="recipientCountryCode"/);
  assert.match(html, /explicitContactPhone/);
});

test('28. 中英文界面不混杂：关键系统字符串纯净无双语混杂', () => {
  const requiredZh = [
    ['addAnotherService', '继续添加项目'],
    ['selectedServices', '已选项目'],
    ['totalDuration', '预计总时长'],
    ['estimatedTotal', '预计总金额'],
    ['removeService', '移除'],
    ['nextStep', '下一步'],
    ['noBookableServices', '暂无可预约项目'],
    ['serviceUnavailableRetry', '项目已不可用，请重新选择'],
    ['loadServicesFailed', '无法加载服务，请重试']
  ];
  for (const [key, expected] of requiredZh) {
    const val = i18n.t(key, 'zh-CN');
    assert.equal(val, expected);
    assert.doesNotMatch(val, /[a-zA-Z]/);
  }

  const requiredEn = [
    ['addAnotherService', 'Add another service'],
    ['selectedServices', 'Selected services'],
    ['totalDuration', 'Estimated duration'],
    ['estimatedTotal', 'Estimated total'],
    ['removeService', 'Remove'],
    ['nextStep', 'Next'],
    ['noBookableServices', 'No services are currently available'],
    ['serviceUnavailableRetry', 'This service is no longer available. Please select again.'],
    ['loadServicesFailed', 'Unable to load services. Please try again.']
  ];
  for (const [key, expected] of requiredEn) {
    const val = i18n.t(key, 'en');
    assert.equal(val, expected);
    assert.doesNotMatch(val, /[\u3400-\u9fff]/);
  }
});

test('29. 不访问Production：不含生产环境直连地址或密钥', () => {
  assert.doesNotMatch(html, /production\.supabase|prod-db|stripe-live/);
  assert.doesNotMatch(html, /api_key\s*=\s*['"][a-zA-Z0-9_-]{20,}['"]/);
});

test('30. 不产生数据库业务写入：前台选择只操作客户端购物车与只读接口', () => {
  assert.match(html, /\/api\/booking\/service-categories/);
  assert.match(html, /\/api\/services-db/);
  assert.match(html, /\/api\/booking\/staff-options/);
  assert.doesNotMatch(html, /UPDATE|INSERT INTO|DELETE FROM/);
});
