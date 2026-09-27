'use strict';

const MEMBER_MODULE_KEYS = Object.freeze([
  'singleSale', 'membershipTier', 'points', 'storedValue', 'packages', 'referral'
]);

// These flags are shop-scoped policy, never customer balances. Persisting owner
// choices needs a separately reviewed schema change; disabled modules retain all
// history and are simply omitted from customer presentation and future use.
// Merchant-to-merchant subscription referrals are a separate future billing
// relationship (referrer shop -> referred shop -> earned subscription credit);
// they must not be mixed with this customer-facing referral presentation flag.
const normalizeMemberModules = value => Object.fromEntries(
  MEMBER_MODULE_KEYS.map(key => [key, key === 'singleSale' ? value?.[key] !== false : value?.[key] === true])
);

const normalizeMemberTheme = value => ({
  key: typeof value?.key === 'string' && /^[a-z0-9-]{1,32}$/.test(value.key) ? value.key : 'premium-black'
});

const memberPresentationFromShopSettings = settings => ({
  memberModules: normalizeMemberModules({
    singleSale: settings?.single_sale_enabled,
    membershipTier: settings?.membership_tier_enabled !== undefined
      ? settings.membership_tier_enabled === true
      : (settings?.membership_enabled === true),
    points: settings?.points_enabled === true,
    storedValue: settings?.stored_value_enabled === true,
    packages: settings?.packages_enabled === true,
    referral: settings?.referral_enabled === true
  }),
  memberTheme: normalizeMemberTheme({ key: settings?.member_theme_key })
});

module.exports = {
  MEMBER_MODULE_KEYS,
  memberPresentationFromShopSettings,
  normalizeMemberModules,
  normalizeMemberTheme
};
