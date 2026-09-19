# Palm Palace Hotel — Complete System Foundation v2

A working hotel website + staff operations portal for Palm Palace Hotel, Bahir Dar.

## Included
- Cinematic responsive public website using the supplied hotel photos.
- 51-room inventory with current room types/prices.
- Rooms 302 and 507 initially Out of Service.
- Real availability checking by date and exact room number.
- Server-side price calculation and overlap protection.
- Online booking records as PENDING_PAYMENT until an authoritative gateway confirms payment.
- Reception walk-in/offline booking flow.
- Super Admin / Reception / Finance role separation.
- Staff login with salted scrypt password hashes.
- Super Admin user creation/disable.
- Super Admin room state control: Available / Out of Service / Maintenance.
- Finance payment ledger and audit log.
- Persistent local JSON store so data survives server restarts.
- Configurable payment gateway adapter and CNET integration placeholders.

## Important production items requiring hotel/provider credentials
No honest software build can invent the hotel's merchant credentials, gateway API contract, webhook secret, domain, hosting account, or CNET API access. The adapter is intentionally fail-closed: if a real gateway is not configured, customers cannot be falsely marked as paid.

Before launch configure `.env` and replace the generic payment adapter with the exact approved CBE/gateway API contract supplied to the hotel. If CNET exposes an approved API, add that integration using its vendor documentation.

## Run
1. Install Node.js LTS.
2. `npm install`
3. Copy `.env.example` to `.env`.
4. Set a strong `SESSION_SECRET` and `SUPER_ADMIN_PASSWORD`.
5. `npm start`
6. Public site: `http://localhost:3000`
7. Staff portal: `http://localhost:3000/admin.html`

Do not deploy with the example admin password.
