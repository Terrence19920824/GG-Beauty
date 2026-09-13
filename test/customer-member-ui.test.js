'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const i18n=require('../public/shared-i18n');
const root=path.join(__dirname,'..');
const html=fs.readFileSync(path.join(root,'public/member.html'),'utf8');
const ui=fs.readFileSync(path.join(root,'public/customer-member-ui.js'),'utf8');
const booking=fs.readFileSync(path.join(root,'public/index.html'),'utf8');
const server=fs.readFileSync(path.join(root,'server.js'),'utf8');

test('customer booking exposes a bilingual VIP membership entry',()=>{
  assert.match(booking,/id="memberEntry"[^>]+href="\/member\.html"[^>]+data-i18n="membershipEntry"/);
  assert.equal(i18n.t('membershipEntry','zh-CN'),'VIP / 我的会员');
  assert.equal(i18n.t('membershipEntry','en'),'VIP / My Membership');
  assert.match(booking,/memberEntry\.href = `\/member\.html\?shop=/);
});

test('trusted shop branding replaces the fallback title and critical business values opt out of browser translation',()=>{
  assert.match(booking,/id="shopBrandName"[^>]+translate="no"/);
  assert.match(booking,/shopBrandName\.textContent = result\.data\.shopName \|\| customerShopSlug/);
  assert.match(server,/shop\.name AS shop_name/);assert.match(server,/shopName: scope\.shop_name/);
  for(const id of ['shopName','memberName','memberCode','memberVerifiedPhone']) assert.match(html,new RegExp(`id="${id}"[^>]+translate="no"`));
  assert.match(booking,/id="cartTotals"[^>]+translate="no"/);
});

test('language control is a compact translucent 中｜E pill and locale defaults stay deterministic',()=>{
  for(const page of [booking,html]){assert.match(page,/>中<\/button><span class="language-divider">｜<\/span><button[^>]*>E<\/button>/);assert.match(page,/backdrop-filter:blur\(9px\)/);}
  assert.equal(i18n.detectBrowserLocale({languages:['zh-Hans','en']}),'zh-CN');
  assert.equal(i18n.detectBrowserLocale({languages:['fr-FR']}),'en');
  assert.equal(i18n.getStoredLocale({getItem:()=> 'en'},{languages:['zh-CN']}),'en');
});

test('member entry reuses the matching verified shop session and rejects a different-shop session in UI',()=>{
  assert.match(ui,/member\.shop_slug!==state\.shopSlug/);
  assert.match(ui,/state\.member=member/);
  assert.match(ui,/await api\('\/api\/customer\/me'\)/);
});

test('member UI covers OTP registration returning member profile phone change and logout without empty benefit modules',()=>{
  for(const id of ['authPanel','countryCode','memberPhone','sendCode','codeStep','otpCode','verifyCode','resendCode','registrationStep','registrationName','registrationEmail','registrationDob','registrationGender','memberPanel','memberCode','memberVerifiedPhone','editMemberProfile','changeMemberPhone','phoneChangePanel','changeCountryCode','changePhone','sendPhoneChangeCode','phoneChangeCode','confirmPhoneChange','logoutMember']) assert.match(html,new RegExp(`id="${id}"`));
  for(const endpoint of ['/api/customer/auth/otp/request','/api/customer/auth/otp/verify','/api/customer/me','/api/customer/phone-change/request','/api/customer/phone-change/confirm','/api/customer/logout']) assert.ok(ui.includes(endpoint));
  assert.doesNotMatch(html,/points|stored value|package|referral/i);
  assert.match(html,/class="member-card"/);assert.match(html,/class="logo [^"]*notranslate"/);
});

test('member modules are shop-policy flags and render only with enabled real payload while theme stays shop scoped',()=>{
  const config=require('../lib/customer-member-config');
  assert.deepEqual(config.normalizeMemberModules(),{singleSale:true,membershipTier:false,points:false,storedValue:false,packages:false,referral:false});
  assert.deepEqual(config.memberPresentationFromShopSettings({points_enabled:true,stored_value_enabled:false}).memberModules,
    {singleSale:true,membershipTier:false,points:true,storedValue:false,packages:false,referral:false});
  assert.equal(config.normalizeMemberTheme().key,'premium-black');
  assert.match(html,/data-member-theme="premium-black"/);assert.match(html,/id="memberDynamicSections" hidden/);
  assert.match(ui,/modules\[key\]===true&&payload\[key\]!=null/);
  assert.match(ui,/panel\.dataset\.shop=state\.shopSlug/);
});

test('phone change uses verified session endpoints and never sends shop or customer authority',()=>{
  const request=ui.match(/async function requestPhoneChange\(\)\{([\s\S]*?)\}\n  async function confirmPhoneChange/)[1];
  assert.match(request,/countryCode/);assert.match(request,/phone/);assert.doesNotMatch(request,/shopSlug|shopId|customerId/);
  assert.match(server,/shopSlug:session\.shop_slug/);
});

test('OTP UI uses explicit countries generic messages and keeps shared locale state',()=>{
  for(const code of ['+65','+60','+62','+86','+1']) assert.ok(ui.includes(`'${code}'`));
  assert.equal(i18n.t('otpSentGeneric','en'),'If this number can receive messages, a code has been sent.');
  assert.equal(i18n.t('otpSentGeneric','zh-CN'),'如果该号码可接收短信，验证码已发送。');
  const setLocale=ui.match(/function setLocale\(locale\)\{([^}]*)\}/)[1];
  assert.match(setLocale,/i18n\.setLocale/);assert.match(setLocale,/renderLocale/);
  assert.doesNotMatch(setLocale,/fetch|challengeId|member=null|location\.reload/);
  assert.match(ui,/state\.config\?\.defaultPhoneCountryCode\|\|'\+65'/);
  assert.match(ui,/clearTimeout\(state\.timer\)/);
  assert.match(ui,/state\.timer=root\.setTimeout/);
  assert.doesNotMatch(ui,/setInterval/);
});

test('member API trusts session and shop slug, rejects client authority, and uses canonical identity service',()=>{
  assert.match(server,/app\.get\('\/api\/customer\/member\/config'/);
  assert.match(server,/app\.patch\('\/api\/customer\/me'/);
  assert.match(server,/rejectCustomerAuthority\(req\.query\)/);
  assert.match(server,/rejectCustomerAuthority\(req\.body\)/);
  assert.match(server,/customerMemberIdentity\.authenticate\(customerCookie\(req\)\)/);
  assert.match(server,/customerMemberIdentity\.updateProfile/);
  assert.doesNotMatch(ui,/customerId\s*:/);
  assert.doesNotMatch(ui,/shopId\s*:/);
});

test('member UI dictionary is complete in Chinese and English',()=>{
  const keys=['myMembership','memberLabel','backToBooking','memberSignInHelp','sendCode','verificationCode','verifyCode','resendCode','completeMembership','dateOfBirth','genderOptional','profile','editProfile','profileSaved','changePhone','newPhone','verifyNewPhone','phoneChanged'];
  for(const key of keys){assert.notEqual(i18n.t(key,'zh-CN'),key);assert.notEqual(i18n.t(key,'en'),key);}
});
