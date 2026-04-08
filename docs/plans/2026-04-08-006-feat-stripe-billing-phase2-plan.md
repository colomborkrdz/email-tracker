---
title: "feat: Stripe billing (Phase 2)"
type: feat
status: active
date: 2026-04-08
---

# feat: Stripe billing (Phase 2)

## Context

Email Tracker is a multi-user SaaS after Phase 1 (auth + SQLite). Phase 2 adds a $5/month Stripe subscription as the paywall between signup and dashboard access. There is no free tier — a paid subscription is required to use the product. Users who have verified their email but have no active subscription are blocked at the dashboard and redirected to a `/billing` page where they can subscribe.

Stripe Checkout handles all payment UI. We do not build a custom payment form. Subscription state is stored on the user record in SQLite and kept in sync via Stripe webhooks.

**Live app:** https://email-tracker-production-b00f.up.railway.app  
**Stack:** Node.js vanilla http, SQLite via better-sqlite3, vanilla JS frontend

---

## Research: Existing Codebase

### `lib/db.js`

The `users` table currently has:

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,
  verification_token TEXT,
  created_at TEXT NOT NULL
);
```

Two columns need to be added: `stripe_customer_id` (nullable TEXT) and `subscription_status` (TEXT, default `'none'`). SQLite `ALTER TABLE ADD COLUMN` supports this without a migration script — just run it with `IF NOT EXISTS` semantics via a try/catch or check.

Prepared statements exported from `lib/db.js`:
- `getUserByEmail`, `getUserById` — used by auth and requireAuth; will need to return the new columns (they do automatically via `SELECT *`)
- `insertUser` — does not set the new columns; they default to NULL / `'none'`
- No existing query touches `stripe_customer_id` or `subscription_status`

### `server.js`

**Auth flow:**
- `requireAuth(req, res)` — verifies JWT, returns `userId` or sends 401. Currently used as the sole gate on all `/api/emails*` routes. Subscription check must happen after `requireAuth`, not replace it.
- Login returns a JWT on success; no subscription state is embedded in the token. Subscription status must be checked per-request by looking up the user record — acceptable at this scale.

**Protected routes that need subscription gating:**
- `POST /api/emails` (line 198)
- `GET /api/emails` (line 222)
- `PATCH /api/emails/:trackId` (line 265)
- `DELETE /api/emails/:trackId` (line 299)

**Permanently public routes (must stay ungated):**
- `GET /pixel` — tracking pixel, never requires auth or subscription
- `POST /api/auth/signup`, `POST /api/auth/login`, `GET /api/auth/verify-email`
- All new billing routes: `/api/billing/*` must be callable before a subscription exists

**Static file serving:** `GET /app` serves `public/app.html`, `GET /login` serves `public/login.html`. A new `GET /billing` route must serve `public/billing.html`.

**Body parsing:** `readBody(req)` helper accumulates chunks and JSON-parses — use for all new POST handlers.

**JSON responses:** `json(res, status, body)` helper — use throughout.

**Webhook gotcha:** Stripe webhooks send raw bodies that must not be JSON-parsed before signature verification. The existing `readBody()` helper JSON-parses — a separate raw body reader is needed for the webhook endpoint.

### `public/app.html`

- Checks `localStorage.getItem('token')` on load; redirects to `/login` if absent
- All fetch calls include `Authorization: Bearer ${token}`
- On any 401 response, clears localStorage and redirects to `/login`
- Needs an additional check: on 402 (Payment Required) response, redirect to `/billing`
- Needs a "Manage billing" link in the header pointing to `/billing`

### `public/login.html`

- Posts to `/api/auth/login`, stores JWT in localStorage, redirects to `/app`
- No changes needed for billing — subscription gate is enforced at `/app` load and API level

---

## Acceptance Criteria

1. A user who signs up and verifies their email but has no active Stripe subscription is redirected to `/billing` when they visit `/app`.
2. All `/api/emails*` routes return `402 Payment Required` for authenticated users with no active subscription.
3. A user on the `/billing` page can click "Subscribe" and complete Stripe Checkout; after payment, they are redirected back to `/app` and can use the dashboard.
4. A user can visit `/billing` and cancel their subscription via a Stripe Customer Portal link.
5. Subscription state (`subscription_status`) in SQLite updates correctly on: checkout completion, renewal, cancellation, and payment failure — all via Stripe webhooks.
6. The pixel route (`/pixel`) continues to work for all tracked emails regardless of the owner's subscription status.
7. The seed user (`SEED_USER_EMAIL`, currently `andres@mangacreativestudios.com`) bypasses the subscription gate — same pattern as the email verification bypass in the login handler. Seed user can access `/app` and all `/api/emails*` routes with no subscription.
8. A user with `subscription_status = 'active'` who cancels sees their access revoked when the subscription period ends (Stripe sends `customer.subscription.deleted` or status changes to `canceled`).
9. Users who existed before Stripe was introduced get `subscription_status = 'trialing'` and a `trial_ends_at` timestamp 7 days from migration. They can access the dashboard during the trial. After `trial_ends_at` passes, `requireSubscription` treats them as unsubscribed and redirects to `/billing`.

---

## Implementation Steps

### Step 1: Add Stripe columns to the `users` table

**File:** `lib/db.js`

Add three columns to the `users` table via `ALTER TABLE`:

```sql
ALTER TABLE users ADD COLUMN stripe_customer_id TEXT;
ALTER TABLE users ADD COLUMN subscription_status TEXT NOT NULL DEFAULT 'none';
ALTER TABLE users ADD COLUMN trial_ends_at TEXT;
```

Run each in a separate try/catch (SQLite throws if the column already exists, unlike `IF NOT EXISTS` which only works for tables/indexes). Add after the `db.exec(CREATE TABLE...)` block.

After adding the columns, run a one-time backfill to give existing users a 7-day trial:

```js
db.prepare(`
  UPDATE users SET subscription_status = 'trialing', trial_ends_at = ?
  WHERE subscription_status = 'none' AND stripe_customer_id IS NULL
`).run(new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString());
```

This runs on every server start but is idempotent — users already on `'trialing'` or with a `stripe_customer_id` are unaffected by the `WHERE` clause.

Add new prepared statements:
- `updateStripeCustomer` — sets `stripe_customer_id` and `subscription_status` by user id
- `updateSubscriptionStatus` — sets `subscription_status` by `stripe_customer_id` (used by webhook handler)
- `getUserByStripeCustomerId` — looks up user by `stripe_customer_id` (used by webhook handler)

### Step 2: Install `stripe` npm package

```bash
npm install stripe
```

Add `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET` to Railway env vars. Add `STRIPE_PRICE_ID` (the $5/month price ID from Stripe dashboard).

### Step 3: Add `requireSubscription` helper to `server.js`

A function that runs after `requireAuth`:

```js
function requireSubscription(req, res, userId) {
  const user = db.getUserById.get(userId);
  const isSeedUser = process.env.SEED_USER_EMAIL &&
    user.email === process.env.SEED_USER_EMAIL.toLowerCase().trim();
  if (isSeedUser) return true;
  if (user.subscription_status === 'active') return true;
  if (user.subscription_status === 'trialing' && user.trial_ends_at && new Date(user.trial_ends_at) > new Date()) return true;
  json(res, 402, { error: 'Subscription required' });
  return false;
}
```

Apply at the top of each `/api/emails*` handler, after `requireAuth`.

`GET /api/billing/status` should also return `trial_ends_at` so the billing page can show a "Your trial ends on <date>" message to trialing users.

### Step 4: Add billing API routes to `server.js`

All routes require a valid JWT (`requireAuth`). None require an active subscription — they must be callable to *start* a subscription.

**`POST /api/billing/create-checkout-session`**
- Look up user; if no `stripe_customer_id`, create a Stripe customer via `stripe.customers.create({ email })`; save `stripe_customer_id` to DB
- Call `stripe.checkout.sessions.create` with:
  - `mode: 'subscription'`
  - `line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }]`
  - `customer: stripe_customer_id`
  - `success_url: ${BASE_URL}/billing?success=1`
  - `cancel_url: ${BASE_URL}/billing?canceled=1`
- Return `{ url: session.url }` — frontend redirects to this URL

**`POST /api/billing/create-portal-session`**
- Require `stripe_customer_id` to exist (user must have subscribed at least once); return 400 if not
- Call `stripe.billingPortal.sessions.create({ customer: stripe_customer_id, return_url: ${BASE_URL}/billing })`
- Return `{ url: session.url }`

**`GET /api/billing/status`**
- Return `{ subscription_status: user.subscription_status, stripe_customer_id: user.stripe_customer_id }`
- Used by `billing.html` on load to decide what to show

### Step 5: Add Stripe webhook endpoint to `server.js`

**`POST /api/billing/webhook`** — permanently public (no JWT)

⚠️ **Critical:** The webhook route must read the raw request body directly from `req` — `readBody()` must never be called on this route. `readBody()` JSON-parses the accumulated string, which mutates the body content. Stripe's `webhooks.constructEvent()` verifies the HMAC signature against the exact raw bytes Stripe sent — any transformation (including string encoding or JSON parsing) will cause signature verification to fail with a 400, silently dropping all webhook events. Use `readRawBody()` (defined below) exclusively for this route.

A separate helper is needed:

```js
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
```

Handler logic:
1. Read raw body as Buffer
2. Verify signature: `stripe.webhooks.constructEvent(rawBody, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET)`
3. On verification failure → 400
4. Handle these events:
   - `checkout.session.completed` → set `subscription_status = 'active'` by `stripe_customer_id`
   - `customer.subscription.updated` → map Stripe status (`active`, `past_due`, `canceled`, etc.) to local `subscription_status`
   - `customer.subscription.deleted` → set `subscription_status = 'canceled'`
   - `invoice.payment_failed` → set `subscription_status = 'past_due'`
5. Return 200 for all handled and unhandled events (Stripe retries on non-2xx)

Stripe status mapping:

| Stripe status | Local `subscription_status` |
|---|---|
| `active` | `active` |
| `past_due` | `past_due` |
| `canceled` | `canceled` |
| `unpaid` | `past_due` |
| anything else | `none` |

### Step 6: Update `app.html` to handle 402

In the `fetch` wrapper or response handler, add:

```js
if (res.status === 402) {
  window.location = '/billing';
  return;
}
```

Add a "Manage billing" link in the header nav pointing to `/billing`.

On initial page load, before fetching emails, check `GET /api/billing/status`. If `subscription_status !== 'active'`, redirect to `/billing` immediately (avoids a flash of the dashboard before the first API call returns 402).

### Step 7: Create `public/billing.html`

A simple page in the existing dark-theme style. States:

**No subscription:**
- Heading: "Subscribe to Email Tracker"
- Price: "$5/month"
- Button: "Subscribe with Stripe" → calls `POST /api/billing/create-checkout-session`, redirects to returned URL

**Active subscription:**
- Heading: "Your subscription is active"
- Button: "Manage billing" → calls `POST /api/billing/create-portal-session`, redirects to portal URL
- Button: "Go to dashboard" → `/app`

**Success state (`?success=1` in URL):**
- Show "Subscription activated — welcome!" banner, then redirect to `/app` after 2 seconds

**Canceled state (`?canceled=1` in URL):**
- Show "Checkout canceled" message, show subscribe button again

**Past due state:**
- Show "Your payment failed — please update your payment method" with "Manage billing" button

On page load, call `GET /api/billing/status` to determine which state to render.

### Step 8: Add `GET /billing` route to `server.js`

```js
if (pathname === '/billing') {
  const file = path.join(__dirname, 'public', 'billing.html');
  res.writeHead(200, { 'Content-Type': 'text/html' });
  return res.end(fs.readFileSync(file));
}
```

Public — no auth check server-side (client JS handles auth redirect).

### Step 9: Railway env vars

Set before deploying:
- `STRIPE_SECRET_KEY` — from Stripe dashboard (use test key first)
- `STRIPE_WEBHOOK_SECRET` — from Stripe dashboard → Webhooks → signing secret
- `STRIPE_PRICE_ID` — the recurring price ID for the $5/month product

Register the webhook endpoint in Stripe dashboard: `https://email-tracker-production-b00f.up.railway.app/api/billing/webhook`

Events to subscribe to: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`

---

## Risks and Unknowns

**Webhook delivery timing.** After Stripe Checkout completes, there's a brief window between the redirect to `?success=1` and the webhook arriving. If the user hits `/app` before the webhook fires, they'll see the billing page briefly. Mitigate: the `?success=1` page waits 2 seconds before redirecting, giving the webhook time to land. Alternatively, poll `GET /api/billing/status` on the success page until status flips to `active`.

**Raw body parsing for webhook.** The existing `readBody()` JSON-parses everything. The webhook endpoint needs a raw Buffer — if implemented incorrectly, Stripe signature verification will fail and all webhooks will 400. Must verify end-to-end with the Stripe CLI (`stripe listen --forward-to localhost:3000/api/billing/webhook`) before deploying.

**`subscription_status` drift.** If a webhook is missed (Railway downtime, bad deploy), the local status can diverge from Stripe truth. Mitigate: on `GET /api/billing/status`, optionally hit `stripe.subscriptions.list({ customer })` to reconcile — but this adds latency. Acceptable to skip for launch and handle manually if it occurs.

**Seed user bypass.** The seed user bypasses subscription gating (same as email verification bypass). This is intentional for development. Remove both bypasses before opening signups publicly, or replace with an explicit `is_admin` flag.

**Stripe test vs live keys.** Deploy with test keys first; validate the full flow end-to-end in Railway before switching to live keys. Test card: `4242 4242 4242 4242`.

**`better-sqlite3` + `ALTER TABLE`.** SQLite allows `ALTER TABLE ADD COLUMN` but not all constraint types. The new columns (`stripe_customer_id TEXT`, `subscription_status TEXT NOT NULL DEFAULT 'none'`) are safe — `NOT NULL` with a `DEFAULT` is allowed on new columns in SQLite.

**Customer Portal activation.** Stripe requires the Customer Portal to be configured in the Stripe dashboard (Settings → Billing → Customer Portal) before `stripe.billingPortal.sessions.create` will work. Easy to miss during setup.

---

## Out of Scope (Phase 3)

- Per-seat pricing or team plans
- Usage-based billing
- Invoice history UI (Stripe Portal handles this)
- Proration on plan changes
- Annual pricing option
- Dunning emails beyond Stripe's built-in Smart Retries
