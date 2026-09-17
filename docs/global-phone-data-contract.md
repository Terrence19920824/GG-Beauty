# GG-Beauty Global Phone Data Contract & Architecture Specification

## 1. Commercial Context & Geographic Scope
- **Primary Market**: Singapore (SG, calling code `+65`).
- **Target Expansion Markets**: Malaysia (MY, `+60`), Indonesia (ID, `+62`), Mainland China (CN, `+86`).
- **Global Compatibility**: Full ISO 3166-1 alpha-2 coverage supported for inbound international tourists and expatriates residing in Singapore.
- **Top 4 Priority Countries**:
  1. SG Singapore (`+65`)
  2. MY Malaysia (`+60`)
  3. ID Indonesia (`+62`)
  4. CN Mainland China (`+86`)
- India (`+91`), Australia (`+61`), and all other global countries remain fully searchable and validated in the comprehensive global registry.

## 2. Phone Number Canonical Data Contract
- **Authoritative Identity Field**: `phone_e164` formatted strictly in ITU-T E.164 standard (`^\+[1-9]\d{6,14}$`).
- **Storage Type**: String (`VARCHAR(25)`), NEVER integer, bigint, or floating-point numbers.
- **Auxiliary Presentation Fields**:
  - `phone_country_iso`: ISO 3166-1 alpha-2 uppercase country code (e.g., `'SG'`, `'MY'`, `'CN'`, `'US'`, `'CA'`).
  - `phone_calling_code`: Canonical ITU international dialing prefix including leading `+` (e.g., `'+65'`, `'+1'`).
  - `phone_national`: National significant number formatted without country dialing prefix, preserving national trunk rules (e.g., `'91234567'`, `'123456789'`).

## 3. Server-Side Authoritative Normalization & Security Rules
- **No Client Trust**: The server NEVER trusts client-side normalized values. All phone inputs must be strictly validated and normalized server-side using `lib/phone-normalization.js`.
- **Country ISO Mandate for National Numbers**:
  - Validating a national phone number requires an explicit, supported `countryIso2`.
  - Bare local phone numbers without country context MUST fail closed; the server NEVER assumes or guesses `+65`.
- **National Trunk & Leading Zero Handling**:
  - The system NEVER applies a naive blanket rule to strip leading zeros.
  - National prefixes are resolved strictly per country specification by `libphonenumber-js`.
  - Leading zeros in countries such as Italy (`IT`, e.g. Rome `06...`, Milan `02...`) are strictly preserved.
- **Shared Calling Code Disambiguation**:
  - Calling codes are NOT unique keys (e.g., US and CA share `+1`; RU and KZ share `+7`; IT and VA share `+39`).
  - Full E.164 parsing dynamically disambiguates country context based on national destination codes.
- **Disallowed Formats**:
  - Extensions (e.g. `ext`, `x`, `#`) are strictly prohibited for primary customer identification.
  - Multiple phone numbers, concatenated numbers, or delimiters (e.g. `/`, `,`, `;`, `or`) are rejected.
  - Letters, HTML/script tags, control characters, and newlines are rejected.
- **PII Protection**: Error messages and logs must never interpolate or display full customer phone numbers.

## 4. Trust Boundaries: Guest Booking vs. Verified Member
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

## 5. Phase Rollout Architecture
- **Phase 1 (Current)**:
  - Establishes authoritative data contract, `libphonenumber-js` integration, pure normalization helpers (`normalizeNationalPhone`, `normalizeE164Phone`, `isCanonicalE164`), metadata helpers, top 4 priority country definitions, and comprehensive unit tests.
  - Zero runtime alterations; no database modifications; no third-party provider credential dependency.
- **Phase 2**:
  - Database schema migration adding E.164 columns and check constraints.
  - Safe, idempotent historical Singapore local number backfill script.
- **Phase 3**:
  - Searchable frontend country selector UI with pure single-language (zh-CN / en) rendering.
- **Future Phases (P4–P10)**:
  - Online booking integration (P4), passwordless OTP provider & session hardening (P5), phone change & multi-device flow (P6), immutable receipt snapshot & outbox (P7), email worker (P8), customer display confirmation (P9), brand / "Powered by GG Beauty" separation (P10).
