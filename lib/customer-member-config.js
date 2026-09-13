'use strict';

const MEMBER_MODULE_KEYS = Object.freeze([
  'singleSale', 'membershipTier', 'points', 'storedValue', 'packages', 'referral'
]);

// These flags are shop-scoped policy, never customer balances. Persisting owner
// choices needs a separately reviewed schema change; disabled modules retain all
// history and are simply omitted from customer presentation and future use.
const normalizeMemberModules = value => Object.fromEntries(
  MEMBER_MODULE_KEYS.map(key => [key, key === 'singleSale' ? value?.[key] !== false : value?.[key] === true])
);

const normalizeMemberTheme = value => ({
  key: typeof value?.key === 'string' && /^[a-z0-9-]{1,32}$/.test(value.key) ? value.key : 'premium-black'
});

const memberPresentationFromShopSettings = settings => ({
  memberModules: normalizeMemberModules({
    singleSale: settings?.single_sale_enabled,
    membershipTier: settings?.membership_tier_enabled,
    points: settings?.points_enabled,
    storedValue: settings?.stored_value_enabled,
    packages: settings?.packages_enabled,
    referral: settings?.referral_enabled
  }),
  memberTheme: normalizeMemberTheme({key:settings?.member_theme_key})
});

module.exports = { MEMBER_MODULE_KEYS,memberPresentationFromShopSettings,normalizeMemberModules,normalizeMemberTheme };
