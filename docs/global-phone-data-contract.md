# GG-Beauty Global Phone Data Contract & Architecture Specification

## 1. Commercial Context & Geographic Scope
- **Primary Market**: Singapore (SG, calling code `+65`).
- **Target Expansion Markets**: Malaysia (MY, `+60`), Indonesia (ID, `+62`), Mainland China (CN, `+86`).
- **Top 4 Priority Countries**:
  1. SG Singapore (`+65`)
  2. MY Malaysia (`+60`)
  3. ID Indonesia (`+62`)
  4. CN Mainland China (`+86`)
- India (`+91`), Australia (`+61`), and all other global countries remain fully searchable and validated in the comprehensive global registry.

## 2. Region Classification (`regionKind`)
Phone metadata classifies territory and dialing codes into 4 distinct categories:
1. `iso3166`: Officially assigned ISO 3166-1 alpha-2 sovereign countries/territories.
2. `exceptional`: Exceptionally reserved ISO 3166-1 alpha-2 code elements (specifically `AC` Ascension Island and `TA` Tristan da Cunha). These are NOT standard ISO 3166-1 countries.
3. `user_assigned`: User-assigned ISO 3166-1 alpha-2 code elements (specifically `XK` Kosovo). Kosovo is NOT an official ISO 3166-1 country.
4. `non_geographic`: Non-geographic ITU-T calling codes (e.g. `+800`, `+808`, `+870`, `+878`, `+881`, `+882`, `+883`, `+888`) or numbers where `countryIso2 === null`. Non-geographic numbers are never disguised as countries.

### Customer Identity & OTP vs. General Parsing Boundary
- **General Parsing**: `normalizeE164Phone` preserves the ability to parse valid non-geographic numbers (returning `countryIso2: null` and `regionKind: 'non_geographic'`).
- **Customer Identity & Member OTP Restriction**:
  - Pure validation (`validateCustomerIdentityPhone` / `isEligibleForCustomerIdentity`) strictly rejects any phone where `countryIso2 === null` or `regionKind !== 'iso3166'`.
  - Non-geographic numbers, `AC`, `TA`, and `XK` are STRICTLY PROHIBITED for Customer Identity, Member OTP challenges, or authoritative member phone matching.
  - There is NO feature to "save non-geographic numbers to owner notes".
- **Global Selector vs. Global OTP**:
  - Supporting global countries in the Selector does NOT authorize sending SMS OTP globally. Supported OTP destinations will remain governed by a strict runtime allowlist in future phases.

## 3. Customer Phone Selector API (`getCustomerPhoneSelectorCountries`)
- **Authoritative API**: `getCustomerPhoneSelectorCountries(locale)` is the single authoritative source of selectable countries for frontend customer phone input.
- **Default Filter**: Strictly returns items where `regionKind === 'iso3166'`.
  - `AC` and `TA` (`exceptional`) are excluded by default.
  - `XK` (`user_assigned`) is excluded by default.
  - Non-geographic dialing codes are excluded.
- **Ordering**:
  - The top 4 items are strictly: `SG`, `MY`, `ID`, `CN`.
  - The remaining countries are sorted stably by `localizedName` in the specified locale (`zh-CN` or `en`), tie-broken by `iso2`.
- **Language Purity**:
  - Chinese mode (`zh-CN`): Country names display purely in Chinese with zero English tokens.
  - English mode (`en`): Country names display purely in English with zero Chinese characters.
  - Bilingual slash concatenation (e.g. "新加坡 / Singapore") is prohibited.
- **Immutability**: Every invocation returns fresh array and object instances so that caller mutation cannot pollute internal authoritative state.
- **Search Support**: Pure function `searchCustomerPhoneSelectorCountries(query, locale)` supports searching across country name, calling code, and ISO2 code.

## 4. Phone Number Canonical Data Contract & Normalization Invariants
- **Authoritative Identity Field**: `phone_e164` formatted strictly in ITU-T E.164 standard (`^\+[1-9]\d{6,14}$`).
- **Digit Length Bounds**:
  - ITU-T E.164 specifies a maximum of 15 digits (excluding `+`).
  - The application minimum of 7 digits is an explicit **GG-Beauty product policy** (based on shortest valid national subscriber numbers plus calling code across target operational markets), not an ITU guarantee.
- **Storage Type**: String (`VARCHAR(25)`), NEVER integer, bigint, or floating-point numbers.
- **Input Type Safety**:
  - Inputs must be strings. Number, Object, and Array types are strictly rejected without automatic coercion.
- **No Server-Side Default Country**:
  - Validating a national phone number requires an explicit, supported `countryIso2`.
  - Bare local phone numbers without country context MUST fail closed; the server NEVER assumes or guesses `+65` (SG).
  - Defaulting to `SG` belongs exclusively to future frontend UI client behavior when presenting the selector.
- **National Trunk & Leading Zero Handling**:
  - The system NEVER applies a blanket rule to strip leading zeros.
  - National prefixes are resolved strictly per country specification by `libphonenumber-js`.
  - Leading zeros in countries such as Italy (`IT`, e.g. Rome `06...`, Milan `02...`) and Vatican City (`VA`) under shared code `+39` are strictly preserved.
- **Shared Calling Code Disambiguation**:
  - Calling codes are NOT unique keys (e.g., US and CA share `+1`; RU and KZ share `+7`; IT and VA share `+39`).
  - Full E.164 parsing dynamically disambiguates country context based on national destination codes.
- **Disallowed Formats**:
  - Extensions (e.g. `ext`, `x`, `#`) are strictly prohibited for primary customer identification.
  - Multiple phone numbers, concatenated numbers, or delimiters (e.g. `/`, `,`, `;`, `or`) are rejected.
  - Letters, HTML/script tags, control characters, and newlines are rejected.
- **PII Protection**: Error messages and logs must never interpolate or display full customer phone numbers.
- **Input Immutability**: Functions must never mutate caller-provided input objects.

## 5. Trust Boundaries: Guest Booking vs. Verified Member
- **Guest Appointment Booking**:
  - Requires: Customer Name + Country ISO + Phone (+ Optional Email).
  - ZERO SMS OTP sent; ZERO password required; NO session cookie issued.
  - Never leaks whether a phone number belongs to an existing member.
  - Never exposes member wallet balances, packages, points, or historical records.
- **Customer Member Self-Service**:
  - 100% Passwordless.
  - Authentication requires 6-digit cryptographic SMS OTP challenge.
  - Successful verification grants a 30-day HttpOnly cookie session and unique `member_code`.
- **Cross-Shop Isolation (Multi-Tenant)**:
  - Phone identities are strictly scoped by `shop_id`.
  - The same international phone number can be registered independently across different shops without identity collision or data leakage.
  - Tenant authority is governed solely by authenticated merchant session or verified shop context; the customer-selected country ISO is NOT tenant authority.

## 6. Phase Rollout Architecture & Explicit P1 Boundaries
- **Phase 1 (Current - Classification, Pure Functions & Contract Fix)**:
  - Authoritative data contract and region classification (`iso3166`, `exceptional`, `user_assigned`, `non_geographic`).
  - Pure normalization helpers (`normalizeNationalPhone`, `normalizeE164Phone`, `isCanonicalE164`).
  - Pure Customer Identity eligibility validation (`validateCustomerIdentityPhone`, `isEligibleForCustomerIdentity`).
  - Single authoritative Selector API (`getCustomerPhoneSelectorCountries`, `searchCustomerPhoneSelectorCountries`).
  - Comprehensive unit test coverage.
  - **Explicit P1 Non-Goals**:
    - Does NOT integrate or connect to SMS providers.
    - Does NOT send SMS or OTP.
    - Does NOT modify Booking, Customer Identity, or OTP runtimes in `server.js` or public HTML.
    - Does NOT write or execute database migrations.
    - Does NOT access Production databases or environments.
- **Phase 2**:
  - Database schema migration adding E.164 columns and check constraints.
  - Safe, idempotent historical Singapore local number backfill script.
- **Phase 3**:
  - Searchable frontend country selector UI with pure single-language (zh-CN / en) rendering.
- **Future Phases (P4–P10)**:
  - Online booking integration (P4), passwordless OTP provider & session hardening (P5), phone change & multi-device flow (P6), immutable receipt snapshot & outbox (P7), email worker (P8), customer display confirmation (P9), brand / "Powered by GG Beauty" separation (P10).
