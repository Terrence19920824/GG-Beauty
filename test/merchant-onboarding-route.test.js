'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('../server');
const { generateToken, hashToken } = require('../lib/invitation-token');
const {
  validateMerchantOnboardingInput
} = require('../lib/merchant-onboarding');

const listen = () => new Promise(resolve => {
  const server = app.listen(0, '127.0.0.1', () => resolve(server));
});

test('onboarding request validation rejects client tenant authority and enforces password policy', () => {
  const token = generateToken();
  const valid = {
    token,
    businessName: 'Example Merchant',
    slug: 'example-merchant',
    locationName: 'Main Location',
    country: 'SG',
    address: '',
    postalCode: '',
    timezone: 'Asia/Singapore',
    currencyCode: 'sgd',
    locale: 'en',
    ownerDisplayName: 'Owner',
    ownerLoginIdentifier: 'owner-example',
    password: 'Merchant-Chosen-Password-2026!',
    passwordConfirmation: 'Merchant-Chosen-Password-2026!'
  };
  const normalized = validateMerchantOnboardingInput(valid);
  assert.equal(normalized.provisioning.tenantMode, 'live');
  assert.deepEqual(normalized.provisioning.categories, []);
  assert.equal(normalized.provisioning.settings.countryCode, 'SG');
  assert.equal(normalized.provisioning.settings.defaultPhoneCountryCode, '+65');
  assert.equal(normalized.provisioning.settings.currencyCode, 'SGD');
  assert.equal(normalized.provisioning.settings.defaultLocale, 'en');

  // Country calling code derivation: MY -> +60
  const myNormalized = validateMerchantOnboardingInput({ ...valid, country: 'MY', currencyCode: 'MYR' });
  assert.equal(myNormalized.provisioning.settings.countryCode, 'MY');
  assert.equal(myNormalized.provisioning.settings.defaultPhoneCountryCode, '+60');

  for (const forged of [
    { shopId: 'forged-shop' },
    { tenantMode: 'demo' },
    { categories: [{ canonicalName: 'Beauty' }] }
  ]) {
    assert.throws(
      () => validateMerchantOnboardingInput({ ...valid, ...forged }),
      error => error.code === 'INVALID_ONBOARDING_REQUEST'
    );
  }
  assert.throws(
    () => validateMerchantOnboardingInput({
      ...valid,
      password: 'too-short',
      passwordConfirmation: 'too-short'
    }),
    error => error.code === 'PASSWORD_TOO_SHORT'
  );

  // Password 72-byte boundary validation
  const exact72Ascii = 'A'.repeat(72);
  const valid72 = validateMerchantOnboardingInput({
    ...valid,
    password: exact72Ascii,
    passwordConfirmation: exact72Ascii
  });
  assert.equal(valid72.provisioning.owner.password, exact72Ascii);

  const over72Ascii = 'A'.repeat(73);
  assert.throws(
    () => validateMerchantOnboardingInput({
      ...valid,
      password: over72Ascii,
      passwordConfirmation: over72Ascii
    }),
    error => error.code === 'PASSWORD_TOO_LONG'
  );

  // Multibyte 72-byte UTF-8 boundary (24 3-byte Chinese characters = 72 bytes, 25 = 75 bytes)
  const exact72Utf8 = '密'.repeat(24);
  assert.equal(Buffer.byteLength(exact72Utf8, 'utf8'), 72);
  const validUtf8 = validateMerchantOnboardingInput({
    ...valid,
    password: exact72Utf8,
    passwordConfirmation: exact72Utf8
  });
  assert.equal(validUtf8.provisioning.owner.password, exact72Utf8);

  const over72Utf8 = '密'.repeat(25);
  assert.equal(Buffer.byteLength(over72Utf8, 'utf8'), 75);
  assert.throws(
    () => validateMerchantOnboardingInput({
      ...valid,
      password: over72Utf8,
      passwordConfirmation: over72Utf8
    }),
    error => error.code === 'PASSWORD_TOO_LONG'
  );

  // Country validation
  for (const badCountry of ['ZZ', 'XX', '', null, 123]) {
    assert.throws(
      () => validateMerchantOnboardingInput({ ...valid, country: badCountry }),
      error => error.code === 'INVALID_COUNTRY'
    );
  }

  // Currency validation rejects syntactically valid unassigned codes like AAA
  for (const badCurrency of ['AAA', 'ZZZ', '123', 'SG', 'SGDD', '']) {
    assert.throws(
      () => validateMerchantOnboardingInput({ ...valid, currencyCode: badCurrency }),
      error => error.code === 'INVALID_CURRENCY_CODE'
    );
  }

  // Locale validation accepts only zh-CN and en
  for (const badLocale of ['fr', 'de', 'ja', 'es', '', null]) {
    assert.throws(
      () => validateMerchantOnboardingInput({ ...valid, locale: badLocale }),
      error => error.code === 'INVALID_LOCALE'
    );
  }

  // Timezone validation
  for (const badTz of ['Fake/Timezone', 'Invalid', '', null]) {
    assert.throws(
      () => validateMerchantOnboardingInput({ ...valid, timezone: badTz }),
      error => error.code === 'INVALID_TIMEZONE'
    );
  }
});

test('merchant onboarding routes validate same-origin requests and never expose token hashes', async () => {
  const token = generateToken();
  const queries = [];
  const previous = app.locals.merchantOnboardingPool;
  app.locals.merchantOnboardingPool = {
    query: async (sql, params) => {
      queries.push({ sql, params });
      return {
        rows: [{
          id: '11111111-1111-4111-8111-111111111111',
          status: 'pending',
          is_expired: false,
          consumed_at: null,
          revoked_at: null,
          resulting_shop_id: null,
          merchant_name_hint: 'Invited Merchant',
          token_hash: hashToken(token)
        }]
      };
    },
    connect: async () => { throw new Error('connect must not be reached'); }
  };

  const server = await listen();
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const page = await fetch(`${base}/onboarding.html?token=${token}`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('cache-control'), /no-store/);
    assert.equal(page.headers.get('referrer-policy'), 'no-referrer');

    const valid = await fetch(`${base}/api/merchant-onboarding/invitation/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({ token })
    });
    const validBody = await valid.json();
    assert.equal(valid.status, 200);
    assert.deepEqual(validBody, {
      success: true,
      data: { state: 'VALID', merchantNameHint: 'Invited Merchant' }
    });
    assert.equal(JSON.stringify(validBody).includes(token), false);
    assert.equal(JSON.stringify(validBody).includes(hashToken(token)), false);
    assert.deepEqual(queries[0].params, [hashToken(token)]);

    const workingQuery = app.locals.merchantOnboardingPool.query;
    const originalConsoleError = console.error;
    const logs = [];
    try {
      app.locals.merchantOnboardingPool.query = async () => {
        throw Object.assign(new Error(`database detail ${token}`), { code: 'XX000' });
      };
      console.error = (...args) => logs.push(args.join(' '));
      const failedValidation = await fetch(
        `${base}/api/merchant-onboarding/invitation/validate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Origin: base },
          body: JSON.stringify({ token })
        }
      );
      assert.equal(failedValidation.status, 500);
    } finally {
      console.error = originalConsoleError;
      app.locals.merchantOnboardingPool.query = workingQuery;
    }
    assert.equal(logs.join('\n').includes(token), false);
    assert.match(logs.join('\n'), /XX000/);

    const queryCount = queries.length;
    const crossOrigin = await fetch(`${base}/api/merchant-onboarding/invitation/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://attacker.invalid' },
      body: JSON.stringify({ token })
    });
    assert.equal(crossOrigin.status, 403);
    assert.equal(queries.length, queryCount);

    const password = 'Merchant-Chosen-Password-2026!';
    const mismatch = await fetch(`${base}/api/merchant-onboarding/invitation/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({
        token,
        businessName: 'Example Merchant',
        slug: 'example-merchant',
        locationName: 'Main Location',
        country: 'SG',
        address: '',
        postalCode: '',
        timezone: 'Asia/Singapore',
        currencyCode: 'SGD',
        locale: 'en',
        ownerDisplayName: 'Owner',
        ownerLoginIdentifier: 'owner-example',
        password,
        passwordConfirmation: `${password}-different`
      })
    });
    const mismatchBody = await mismatch.json();
    assert.equal(mismatch.status, 400);
    assert.equal(mismatchBody.code, 'PASSWORD_CONFIRMATION_MISMATCH');
    assert.equal(JSON.stringify(mismatchBody).includes(token), false);
    assert.equal(JSON.stringify(mismatchBody).includes(password), false);

    const overlongPw = await fetch(`${base}/api/merchant-onboarding/invitation/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({
        token,
        businessName: 'Example Merchant',
        slug: 'example-merchant',
        locationName: 'Main Location',
        country: 'SG',
        address: '',
        postalCode: '',
        timezone: 'Asia/Singapore',
        currencyCode: 'SGD',
        locale: 'en',
        ownerDisplayName: 'Owner',
        ownerLoginIdentifier: 'owner-example',
        password: 'A'.repeat(73),
        passwordConfirmation: 'A'.repeat(73)
      })
    });
    const overlongBody = await overlongPw.json();
    assert.equal(overlongPw.status, 400);
    assert.equal(overlongBody.code, 'PASSWORD_TOO_LONG');

    const badCurrency = await fetch(`${base}/api/merchant-onboarding/invitation/consume`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: base },
      body: JSON.stringify({
        token,
        businessName: 'Example Merchant',
        slug: 'example-merchant',
        locationName: 'Main Location',
        country: 'SG',
        address: '',
        postalCode: '',
        timezone: 'Asia/Singapore',
        currencyCode: 'AAA',
        locale: 'en',
        ownerDisplayName: 'Owner',
        ownerLoginIdentifier: 'owner-example',
        password,
        passwordConfirmation: password
      })
    });
    const badCurrencyBody = await badCurrency.json();
    assert.equal(badCurrency.status, 400);
    assert.equal(badCurrencyBody.code, 'INVALID_CURRENCY_CODE');
  } finally {
    app.locals.merchantOnboardingPool = previous;
    await new Promise(resolve => server.close(resolve));
  }
});
