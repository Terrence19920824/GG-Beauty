# Merchant Launch Readiness

## Trusted public URL

The canonical customer booking URL is derived on the server as:

`PUBLIC_BASE_URL` + `/book/<authoritative shop slug>`

Phase 4 introduces `PUBLIC_BASE_URL` as the server-owned canonical-origin
contract for booking links. The repository did not previously have a trusted
public-origin setting that was suitable for this purpose. For a deployed
environment the value must be an HTTPS origin only, with no credentials, path,
query, or fragment. Loopback HTTP origins are accepted only for local
development and tests. Request `Host`, `X-Forwarded-Host`, and client-supplied
shop identifiers are never used.

If the value is absent or invalid, the launch API fails closed: it does not
return an absolute booking URL and it does not generate a QR code.

This task does not change production configuration. A release operator must
verify the production `PUBLIC_BASE_URL` value before deploying Phase 4.

## Readiness model

`GET /api/owner/launch/readiness` recomputes readiness from current tenant data.
It does not persist or cache a readiness boolean. The authenticated Owner
membership supplies `shop_id`; the client cannot select a tenant.

All current checks are blocking:

1. Business profile row and shop name exist.
2. An active location exists.
3. An active location has a business timezone.
4. An active, bookable service in an active category exists.
5. An active staff member exists.
6. A bookable active staff member has an active location assignment.
7. A bookable active staff member has an active capability for an active,
   bookable service in an active category.
8. A currently effective working-hours row connects the same active staff,
   location, capability, service, and category foundation.
9. An active Owner account and membership exist.
10. The public booking context can resolve the active shop and location.
11. A QR can be generated from the trusted canonical booking URL.

The endpoint is available to `owner`, `manager`, and read-only `admin` roles.
`front_desk` is denied. Readiness never changes `shops.status` or
`shops.tenant_mode`.

## QR generation

`GET /api/owner/launch/booking-qr.svg` deterministically generates a 1024-pixel
SVG using high error correction. The QR payload is exactly the canonical public
booking URL. No QR binary is stored in the database, and no external QR service
is called.

## Database impact

Migration: none. Phase 4 adds no persistent schema and does not write readiness
or QR state.
