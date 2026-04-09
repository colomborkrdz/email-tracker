# Email Tracker — Project Memory (CLAUDE.md)

> This file is read at the start of every session. Keep it updated. Every bug fix, pattern, and decision lives here.

---

## Project Overview

A self-hosted email open tracker — shows if an email was opened, from where, and how many times. Built as an alternative to Mixpanel/Superhuman tracking.

**Live URL:** https://track.mangacreativestudios.com  
**GitHub:** https://github.com/colomborkrdz/email-tracker  
**Stack:** Node.js (vanilla http module), JSON file database, vanilla HTML/JS dashboard  
**Hosting:** Railway (auto-deploys from GitHub main branch)  
**Local dev:** `cd ~/email-tracker && node server.js` + ngrok for public tunnel

---

## Architecture

```
email-tracker/
├── server.js          ← HTTP server, all routes, tracking logic
├── lib/
│   ├── db.js          ← SQLite connection, schema, prepared statements
│   ├── auth.js        ← JWT sign/verify, bcrypt hash/compare
│   ├── email.js       ← Resend email sending (fetch, no nodemailer)
│   ├── scanner.js     ← Automated scanner detection
│   └── geo.js         ← IP geolocation
├── public/
│   ├── app.html       ← Dashboard (requires JWT + active subscription)
│   ├── login.html     ← Login/signup page (public)
│   ├── billing.html   ← Subscription management page (public, JWT-gated client-side)
│   ├── admin.html     ← Admin dashboard (seed user only)
│   └── nequi.html     ← Nequi payment page (public)
├── scripts/
│   ├── migrate.js     ← One-time JSON → SQLite migration
│   ├── verify-user.js ← Manually verify a user's email by address
│   └── delete-user.js ← Manually delete a user by address
└── package.json
```

### SQLite Schema (users table)
```sql
id, email, password_hash, email_verified, verification_token, created_at,
stripe_customer_id, subscription_status, trial_ends_at, last_login
```
`subscription_status` values: `none` | `trialing` | `active` | `past_due` | `canceled`

### Key Routes
- `GET /` → redirect to `/app`
- `GET /app` → serves `public/app.html` (public file; JS redirects to `/login` if no JWT)
- `GET /login` → serves `public/login.html`
- `GET /billing` → serves `public/billing.html`
- `GET /pixel?id=TRACK_ID` → logs open, returns 1x1 GIF pixel ⚠️ query param, NOT path segment. **Permanently public, no auth.**
- `POST /api/auth/signup` → creates account, sends verification email
- `POST /api/auth/login` → returns JWT on success
- `GET /api/auth/verify-email?token=...` → activates account, redirects to `/login?verified=1`
- `POST /api/emails` → creates tracked email (JWT + active subscription required)
- `GET /api/emails` → returns emails with open counts (JWT + active subscription required)
- `PATCH /api/emails/:id` → updates email metadata (JWT + active subscription required)
- `DELETE /api/emails/:id` → deletes tracked email (JWT + active subscription required)
- `POST /api/billing/create-checkout-session` → creates Stripe Checkout session (JWT required)
- `POST /api/billing/create-portal-session` → creates Stripe Customer Portal session (JWT required)
- `GET /api/billing/status` → returns `subscription_status`, `trial_ends_at` (JWT required)
- `POST /api/billing/webhook` → Stripe webhook; raw body, no JWT, signature-verified
- `GET /admin` → serves `public/admin.html` (public file; JS shows access denied for non-seed users)
- `GET /api/admin/users` → all users list, seed user only
- `PATCH /api/admin/users/:id` → activate or deactivate user, seed user only
- `DELETE /api/admin/users/:id` → delete user, seed user only; self-delete blocked server-side
- `DELETE /api/admin/delete-user` → delete user by email body `{ email }`, seed user only; self-delete blocked
- `GET /nequi` → public Nequi payment page (manual payment flow for Colombian users)

### How Tracking Works
1. User creates a tracked email via dashboard → server generates a `trackId` (UUID)
2. Server returns a pixel URL: `https://[BASE_URL]/pixel?id=[trackId]`
3. User pastes `<img>` tag into email via "Insert HTML for Gmail" Chrome extension
4. When recipient opens email → Gmail fetches the pixel → server logs IP, location, timestamp
5. Google proxy IPs (66.102.x, 66.249.x etc.) are detected and labeled "Gmail Proxy, Google"

---

## Rules & Patterns

### ⚠️ URL Configuration — TWO places to update
When changing the base URL (e.g. ngrok → Railway), ALWAYS update BOTH:
1. `server.js` — `const NGROK_URL = '...'` (used in API responses)
2. `public/app.html` — `const API = '...'` (used by dashboard JS)

Missing either one causes the pixel tag to show the wrong URL.

**Verification command before deploying:**
```bash
grep -n "ngrok\|localhost:3000" ~/email-tracker/server.js ~/email-tracker/public/app.html
```
Should return zero results when properly configured for production.

### Pixel URL Format
The pixel route uses a **query parameter**, not a path segment:
```
✅ CORRECT:   /pixel?id=abc123
❌ INCORRECT: /pixel/abc123
❌ INCORRECT: /pixel/abc123.png
```

### Railway Deployment
- Railway auto-deploys on push to `main`
- If Railway serves a stale version: add a dummy env var (`FORCE_REBUILD=1`) to bust cache
- Deployment takes ~60-90 seconds after push
- Verify deploy worked by checking the pixel endpoint: `/pixel?id=test123` should return a blank page (not "Not found")

### Security Patterns

- **Never inject user-supplied values into `innerHTML` without escaping.** Always use the `esc()` helper pattern from `admin.html` for any page that renders user data (email addresses, names, or any field a user could have set at signup). Escape `&`, `<`, `>`, `"`, and `'`. The signup handler only validates `@` presence — it does not sanitize HTML. An unescaped email in `innerHTML` is a stored XSS vector.

```js
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
```

### Gmail Tracking Notes
- Gmail pre-fetches images via Google proxy — this shows as "Gmail Proxy, Google" in the dashboard
- This is normal and expected — multiple proxy opens on the same email are Gmail, not the recipient
- Recipient's real open shows their actual city/country
- Recipients must have "Show images" enabled in Gmail for tracking to work

---

## Current Status (as of April 8, 2026)

- ✅ Railway deployment live and working
- ✅ Pixel tracking working (opens logged with location + timestamp)
- ✅ Dashboard showing correct Railway URLs
- ✅ Google proxy detection working
- ✅ Tested end-to-end with real email to boti82@gmail.com
- ✅ Multi-user auth + SQLite migration complete (Phase 1)
- ✅ Email verification flow tested and working (Resend)
- ✅ Stripe billing implemented (Phase 2) — pending production wiring
- ✅ Admin dashboard complete (Phase 3) — user list, activate/deactivate/delete, stats

### Next Up
- [ ] Configure Stripe webhook in production (register endpoint in Stripe Dashboard)
- [ ] Test full Stripe flow end to end with a real $5 payment
- [ ] Activate Customer Portal in Stripe Dashboard (Settings → Billing → Customer Portal)
- [ ] Add email open notifications (webhook or email alert when recipient opens)

---

## Known Issues / Watch Out For

- JSON file DB (`data.json`) is ephemeral on Railway — if the container restarts, data resets. For now acceptable for testing; migrate to SQLite or Railway volume for persistence.
- No authentication on dashboard — anyone with the URL can see all tracked emails. Fine for solo use, needs auth before sharing.
- **`railway run` cannot access Railway Volumes** — the CLI runs in a local context without volume mounts. Use API routes or Railway's shell (`railway shell`) for any DB operations that need to touch the SQLite file.
- **Resend domain verification is separate from Railway custom domain DNS** — both require their own GoDaddy DNS records. Adding Railway's CNAME does not verify the Resend sending domain; add Resend's SPF/DKIM/DMARC records independently.
- **Webhook race on `checkout.session.completed`** — mitigated with email fallback lookup, but not fully eliminated. If `stripe_customer_id` isn't in the DB when the webhook arrives (server crash between customer creation and DB write), the fallback tries to match by `session.customer_details.email`. Monitor logs after first real payment for `[stripe] checkout.session.completed: no user found` errors.
- **Stripe Customer Portal must be activated manually** — `create-portal-session` returns a Stripe error until the Customer Portal is configured in Stripe Dashboard → Settings → Billing → Customer Portal. Easy to forget during setup.
- **Subscription gating is currently disabled** — `STRIPE_ENABLED` is not set, so `requireSubscription` passes all authenticated users through. Set `STRIPE_ENABLED=true` in Railway once Stripe is fully configured to enforce the paywall.
- **Railway custom domain SSL requires two DNS records** — CNAME alone is not sufficient. Must also add a `_railway-verify.<subdomain>` TXT record in GoDaddy. SSL provisioning will stall until both records are present.

---

## Decisions Log

| Date | Decision | Reason |
|------|----------|--------|
| Mar 2026 | Use vanilla http module instead of Express | Simplicity, no dependencies |
| Mar 2026 | JSON file as DB | Fast to build, sufficient for MVP |
| Mar 2026 | Host on Railway | Simple git-push deploys, free tier available |
| Apr 2026 | Seed user upserted (not just inserted) on every startup | Hash drift: password_hash in DB becomes stale after `SEED_USER_PASSWORD` env var changes, causing login failures on redeployment. Upsert re-hashes on every boot. |
| Apr 2026 | Admin utility routes scoped to seed user only | Any authenticated user could call admin routes otherwise. Seed user check (`caller.email === SEED_USER_EMAIL`) is the lightweight guard for temporary utility endpoints. Remove routes after use. |
| Apr 2026 | Use Resend HTTP API directly (fetch) instead of nodemailer | Removes nodemailer dependency; Resend's REST API works with Node's built-in fetch. `SMTP_PASS` holds the Resend API key. |
| Apr 2026 | Stripe Checkout over custom payment form | PCI compliance — Stripe handles card data entirely. Faster to build, no card storage concerns. |
| Apr 2026 | Webhook endpoint reads raw Buffer, never calls `readBody()` | Stripe HMAC signature verification requires exact raw bytes. Any string encoding or JSON parsing before `constructEvent()` breaks the signature and silently drops all webhook events. |
| Apr 2026 | Seed user bypasses subscription gate | Same pattern as email verification bypass. Prevents lockout during development. Both bypasses check `user.email === SEED_USER_EMAIL`; remove before opening to the public or replace with an `is_admin` flag. |
| Apr 2026 | 7-day trial for existing users on Phase 2 migration | Users who signed up before billing existed get `subscription_status = 'trialing'` + `trial_ends_at = now + 7d` via idempotent backfill in `lib/db.js`. Prevents locking out existing accounts on first deploy. |
| Apr 2026 | Stripe left dormant, gated by `STRIPE_ENABLED` env var | Stripe doesn't support Colombian entities directly; will activate when US LLC is established. All subscription enforcement is skipped until `STRIPE_ENABLED=true` is set. |
| Apr 2026 | Nequi QR page for manual payments | Interim payment solution for Colombian users while Stripe activation is pending. Manual confirmation flow: user pays → emails confirmation → account activated manually via `scripts/verify-user.js` or admin route. |
| Apr 2026 | `esc()` helper for `innerHTML` in admin.html | User-supplied values (email) must never be injected raw into innerHTML — always escape `&`, `<`, `>`, `"`, `'` before rendering. Signup only validates `@` presence; a crafted email is a stored XSS vector without escaping. |
| Apr 2026 | `isSeed` flag on admin user list | Server sets `isSeed: true` on the seed user's row so the frontend can hide the Delete button. Avoids confusing UX where the seed user sees a Delete button that the server would block anyway. |
| Apr 2026 | `last_login` tracked on every successful login | Needed for admin dashboard visibility. Existing users have `NULL`; displays as "Never" in the admin table. Written in the `POST /api/auth/login` handler after password verification succeeds. |
| Apr 2026 | Restored email-based admin delete route alongside ID-based route | CLI testing requires email-based deletion; ID-based route serves the UI |

---

## Roadmap

### Immediate
- [x] Test new user signup + email verification flow via Resend ✅ Apr 8 2026
- [x] Test open tracking end to end with new auth system ✅ Apr 7 2026
- [x] Fix app.html reference in CLAUDE.md ✅ Apr 7 2026

### Phase 2 — Stripe Billing
- [x] Add Stripe subscription at $5/month ✅ Apr 8 2026
- [x] Gate dashboard access behind active subscription ✅ Apr 8 2026
- [x] Add billing management page ✅ Apr 8 2026

> **Stripe is built but dormant.** Activation requires: US LLC, Stripe account, then set these Railway env vars: `STRIPE_ENABLED=true`, `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, `STRIPE_PRICE_ID`, `STRIPE_WEBHOOK_SECRET`. Also register `POST /api/billing/webhook` in the Stripe Dashboard and activate the Customer Portal (Settings → Billing → Customer Portal).

### Phase 3 — Polish
- [ ] Configure Stripe webhook in production + test real $5 payment end to end
- [ ] Activate Customer Portal in Stripe Dashboard
- [x] Switch BASE_URL to track.mangacreativestudios.com ✅ Apr 9 2026
- [ ] **ET-25 — Email open notifications (webhook or email alert when recipient opens) ← NEXT UP**
- [x] Admin dashboard to manage users ✅ Apr 8 2026
