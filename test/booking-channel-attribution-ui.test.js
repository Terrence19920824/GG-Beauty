'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
const indexHtml = read('public', 'index.html');
const adminHtml = read('public', 'admin.html');
const serverSource = read('server.js');
const customerBookingsSource = read('lib', 'customer-booking-query.js');
const notificationSource = read('lib', 'booking-notifications.js');
const channelSource = read('public', 'booking-channel.js');
const i18n = require('../public/shared-i18n');

test('customer page captures after authoritative shop resolution, submits channel, and clears only after success', () => {
  assert.match(indexHtml, /<script src="\/booking-channel\.js"><\/script>/);
  const nextSlugAt = indexHtml.indexOf('const nextSlug = result.data.shopSlug');
  const captureAt = indexHtml.indexOf('bookingChannelApi.captureFromLocation');
  assert.ok(nextSlugAt >= 0 && captureAt > nextSlugAt, 'capture must use server-resolved shop context');
  assert.match(indexHtml, /storage:\s*globalThis\.sessionStorage/);
  assert.match(indexHtml, /shopSlug:\s*customerShopSlug/);
  assert.match(indexHtml, /startAt:\s*selectedSlot\.startAt,\s*bookingChannel/);

  const failureBranchAt = indexHtml.indexOf('if (!result.success)');
  const clearAt = indexHtml.indexOf('bookingChannelApi.clearForShop');
  const catchAt = indexHtml.indexOf('} catch', clearAt);
  assert.ok(failureBranchAt >= 0 && clearAt > failureBranchAt && catchAt > clearAt);
  assert.doesNotMatch(indexHtml.slice(failureBranchAt, clearAt), /clearForShop/);
  assert.match(indexHtml.slice(clearAt, catchAt), /bookingChannel = null/);
});

test('capture implementation uses session injection and history replacement without cookie or localStorage', () => {
  assert.match(channelSource, /url\.searchParams\.getAll\('channel'\)/);
  assert.match(channelSource, /historyLike\.replaceState/);
  assert.doesNotMatch(channelSource, /localStorage|document\.cookie|cookie/i);
});

test('owner drawer maps booking source and marketing channel through allowlisted i18n labels', () => {
  const start = adminHtml.indexOf('const BOOKING_SOURCE_I18N_KEYS');
  const end = adminHtml.indexOf('const adminResultMessage', start);
  assert.ok(start >= 0 && end > start);
  const context = vm.createContext({ adminT: key => key, Object });
  vm.runInContext(adminHtml.slice(start, end), context);
  const sourceLabel = vm.runInContext('getBookingSourceLabel', context);
  const channelLabel = vm.runInContext('getBookingChannelLabel', context);

  assert.equal(sourceLabel('online'), 'bookingSourceOnline');
  assert.equal(sourceLabel('walk_in'), 'bookingSourceWalkIn');
  assert.equal(sourceLabel('owner_assisted'), 'bookingSourceOwnerAssisted');
  assert.equal(channelLabel('online', 'instagram'), 'bookingChannelInstagram');
  assert.equal(channelLabel('online', 'raw-attacker-value'), 'bookingChannelUnknown');
  assert.equal(channelLabel('online', null), 'bookingChannelUnknown');
  assert.equal(channelLabel('walk_in', null), 'bookingChannelNotApplicable');
  assert.equal(channelLabel('owner_assisted', null), 'bookingChannelNotApplicable');

  const drawer = adminHtml.slice(
    adminHtml.indexOf('function renderAppointmentDrawer'),
    adminHtml.indexOf('function bindActionButtonsIn')
  );
  assert.match(drawer, /adminT\('bookingMethod'\), getBookingSourceLabel\(appointment\.booking_source\)/);
  assert.match(drawer, /adminT\('marketingChannel'\), getBookingChannelLabel\(appointment\.booking_source, appointment\.booking_channel\)/);
});

test('booking attribution translations are complete and do not fall back across languages', () => {
  const proseKeys = [
    'bookingMethod',
    'marketingChannel',
    'bookingSourceOnline',
    'bookingSourceWalkIn',
    'bookingSourceOwnerAssisted',
    'bookingSourceUnknown',
    'bookingChannelUnknown',
    'bookingChannelNotApplicable'
  ];
  for (const key of proseKeys) {
    const zh = i18n.t(key, 'zh-CN');
    const en = i18n.t(key, 'en');
    assert.notEqual(zh, key);
    assert.notEqual(en, key);
    assert.doesNotMatch(zh, /[a-zA-Z]{3,}/, `${key} Chinese label must be Chinese-only`);
    assert.doesNotMatch(en, /[\u4e00-\u9fff]/, `${key} English label must be English-only`);
  }
  assert.equal(i18n.t('bookingChannelXiaohongshu', 'zh-CN'), '小红书');
  assert.equal(i18n.t('bookingChannelXiaohongshu', 'en'), 'Xiaohongshu');
  assert.equal(i18n.t('bookingChannelDouyin', 'zh-CN'), '抖音');
  assert.equal(i18n.t('bookingChannelWebsite', 'en'), 'Website');
});

test('owner DTO selects booking_channel while public DTO/config and notifications do not expose it', () => {
  const ownerRead = serverSource.slice(
    serverSource.indexOf("'/api/appointments-db'"),
    serverSource.indexOf("app.post(\n  '/api/admin/update-status-db'")
  );
  assert.match(ownerRead, /a\.booking_source,\s*a\.booking_channel,/);

  const publicConfig = serverSource.slice(
    serverSource.indexOf("app.get('/api/customer/public-config'"),
    serverSource.indexOf("app.post('/api/customer/my-bookings'")
  );
  assert.doesNotMatch(publicConfig, /booking_channel|bookingChannel/);
  assert.doesNotMatch(customerBookingsSource, /booking_channel|bookingChannel/);
  assert.doesNotMatch(notificationSource, /booking_channel|bookingChannel/);
});

test('customer success DTOs do not echo channel and owner-created appointments reject forged attribution', () => {
  const publicCreate = serverSource.slice(
    serverSource.indexOf('const createMultiServiceBooking'),
    serverSource.indexOf("app.get('/api/available-times'")
  );
  const appointmentInserts = [
    ...publicCreate.matchAll(/INSERT INTO appointments \([\s\S]*?RETURNING[\s\S]*?created_at/g)
  ].map(match => match[0]);
  assert.equal(appointmentInserts.length, 2);
  for (const statement of appointmentInserts) {
    const returning = statement.slice(statement.indexOf('RETURNING'));
    assert.doesNotMatch(returning, /booking_channel|bookingChannel/);
  }
  const canonicalSuccess = publicCreate.match(/return res\.json\(\{ success: true[\s\S]*?\}\);/);
  const legacySuccess = publicCreate.match(/res\.json\(\{\s*success: true,\s*message: '预约成功',[\s\S]*?\n\s*\}\);/);
  assert.ok(canonicalSuccess && legacySuccess);
  assert.doesNotMatch(canonicalSuccess[0], /booking_channel|bookingChannel/);
  assert.doesNotMatch(legacySuccess[0], /booking_channel|bookingChannel/);

  const ownerCreate = serverSource.slice(
    serverSource.indexOf('const createOwnerFrontDeskAppointmentHandler'),
    serverSource.indexOf('const filterAnyStaffCandidateSlots')
  );
  assert.match(ownerCreate, /body\.bookingChannel !== undefined \|\| body\.booking_channel !== undefined/);
  assert.match(ownerCreate, /code: 'BOOKING_CHANNEL_INVALID'/);
  const ownerInsert = ownerCreate.match(/INSERT INTO appointments \(([\s\S]*?)RETURNING/);
  assert.ok(ownerInsert);
  assert.match(ownerInsert[0], /booking_source,booking_channel,override_conflict/);
  assert.match(ownerInsert[0], /'pending',\$11,NULL,\$12/);
});
