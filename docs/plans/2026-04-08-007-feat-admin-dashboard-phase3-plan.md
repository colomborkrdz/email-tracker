---
title: "feat: Admin dashboard (Phase 3)"
type: feat
status: active
date: 2026-04-08
---

# feat: Admin dashboard (Phase 3)

## Context

Email Tracker is now a multi-user SaaS with auth and billing scaffolding in place. User management is currently done via one-off scripts (`scripts/verify-user.js`, `scripts/delete-user.js`) and a temporary `DELETE /api/admin/delete-user` API route. The Nequi payment flow is manual: a user pays, emails confirmation, and the seed user must then manually activate their account by running a script — which requires terminal access to Railway.

An admin dashboard gives the seed user a browser-based interface to manage users, activate/deactivate subscriptions, and monitor account health without needing terminal access. It is the operational tool needed for the manual Nequi payment flow to work at scale.

**Scope:** Read-only user list + three actions (activate, deactivate, delete). No multi-admin support, no audit log, no impersonation.

---

## Research: Existing Codebase

### `lib/db.js` — Users table

Current schema:
```sql
id, email, password_hash, email_verified, verification_token, created_at,
stripe_customer_id, subscription_status, trial_ends_at
```

**No `last_login` column exists.** It would need to be added to the schema (an `ALTER TABLE ADD COLUMN` like the Stripe columns) and set on every successful login in the `POST /api/auth/login` handler. This is straightforward but adds a write on every login.

Prepared statements available:
- `getUserByEmail`, `getUserById` — single-user lookups
- `updateSubscriptionStatus` — updates by `stripe_customer_id`, not by user id — **not usable for manual admin activation** (user may have no Stripe customer). Need a new `updateSubscriptionStatusById` that updates by `id`.
- No `getAllUsers` query exists — needs to be added.
- No `updateSubscriptionStatusById` exists — needs to be added.

### `server.js` — Existing admin route and seed guard pattern

`DELETE /api/admin/delete-user` (line 477) already establishes the exact pattern for all new admin routes:

```js
const caller = db.getUserById.get(userId);
const seedEmail = process.env.SEED_USER_EMAIL && process.env.SEED_USER_EMAIL.toLowerCase().trim();
if (!caller || caller.email !== seedEmail) return json(res, 403, { error: 'Forbidden' });
```

This two-line guard must be copied verbatim into every new `/api/admin/*` handler. Do not abstract it — keep it explicit and visible in each handler.

The existing `DELETE /api/admin/delete-user` route should be **replaced** by the new `DELETE /api/admin/users/:id` route defined in this plan. Remove the old route when the dashboard is shipped.

### `public/app.html` — CSS patterns to reuse

The dashboard has a mature component library in its `<style>` block that the admin page should reuse directly:

- **Stats row:** `.stats-row` (3-column grid), `.stat-card`, `.stat-label`, `.stat-value` — exact match for the 4-stat summary row needed
- **Table/list:** `.email-card`, `.email-card-header`, `.email-meta`, `.email-sub` — adaptable as a user row layout, or replace with a proper `<table>` styled to match
- **Buttons:** `.btn-primary`, `.btn-ghost`, `.btn-danger` — all needed for activate, deactivate, and delete actions
- **Section title:** `.section-title` (uppercase, muted, letter-spaced)
- **Tags/badges:** `.tag` — usable for subscription status and verified status pills
- **CSS variables:** Copy the full `:root` block including `--warn` and `--red` which are present in `app.html` but not in `nequi.html`

`app.html` uses `authFetch()` (JWT-injecting fetch wrapper with 401/402 handling) — reuse the same pattern in `admin.html`.

### `public/nequi.html` — Simpler pages don't need the full app.html CSS

`nequi.html` uses a minimal subset of variables. The admin page is more complex (table, actions, stats) and should take its CSS from `app.html` as the reference, not `nequi.html`.

---

## Acceptance Criteria

1. `GET /admin` serves `public/admin.html`. Any unauthenticated request redirects to `/login` (client-side, same as `/app`).
2. If the authenticated user is not the seed user, the page shows "Access denied" and offers a link back to `/app`. The API routes return 403.
3. The page shows four stat cards: Total Users, Active Subscribers, Trialing, Unverified.
4. The user table shows one row per user with: email, signup date, verified status, subscription status, trial expiry (if trialing), last login.
5. Each row has three action buttons: **Activate** (sets `subscription_status = 'active'`), **Deactivate** (sets `subscription_status = 'none'`), **Delete** (deletes user + cascade). Activate is hidden for already-active users; Deactivate is hidden for already-none/canceled users.
6. Delete requires a browser `confirm()` dialog before firing.
7. The seed user's own row must not have a Delete button (prevent self-deletion).
8. All `/api/admin/*` routes return 403 for any user who is not the seed user.
9. The old `DELETE /api/admin/delete-user` route is removed and replaced by `DELETE /api/admin/users/:id`.

---

## Implementation Steps

### Step 1: Add `last_login` column and `getAllUsers` / `updateSubscriptionStatusById` to `lib/db.js`

**File:** `lib/db.js`

Add column (idempotent try/catch, same pattern as Stripe columns):
```js
try { db.prepare(`ALTER TABLE users ADD COLUMN last_login TEXT`).run(); } catch {}
```

Add prepared statements:
```js
getAllUsers: db.prepare(`SELECT * FROM users ORDER BY created_at DESC`),
updateSubscriptionStatusById: db.prepare(`UPDATE users SET subscription_status = ? WHERE id = ?`),
```

Update `POST /api/auth/login` in `server.js` to set `last_login` on successful login:
```js
db.db.prepare(`UPDATE users SET last_login = ? WHERE id = ?`).run(new Date().toISOString(), user.id);
```

Add this after `signToken(user.id)` and before `return json(res, 200, { token })`.

---

### Step 2: Add admin API routes to `server.js`

All four routes share the same two-line seed guard. Add them before the existing static file block.

**`GET /api/admin/users`** — returns all users (minus `password_hash` and `verification_token`)

```js
// GET /api/admin/users
const users = db.getAllUsers.all().map(u => ({
  id: u.id,
  email: u.email,
  emailVerified: !!u.email_verified,
  subscriptionStatus: u.subscription_status,
  trialEndsAt: u.trial_ends_at,
  stripeCustomerId: u.stripe_customer_id,
  createdAt: u.created_at,
  lastLogin: u.last_login,
}));
return json(res, 200, users);
```

**`PATCH /api/admin/users/:id`** — activate or deactivate a user

Body: `{ action: 'activate' | 'deactivate' }`
- `activate` → `subscription_status = 'active'`
- `deactivate` → `subscription_status = 'none'`
- Unknown action → 400

Extract `:id` from `pathname.split('/')[4]`.

**`DELETE /api/admin/users/:id`** — delete a user

- Prevent seed user from deleting themselves: if `targetUser.email === seedEmail` → 400 `{ error: 'Cannot delete the seed user' }`
- `db.db.prepare('DELETE FROM users WHERE id = ?').run(id)` — cascade handles emails and opens

**Remove the old `DELETE /api/admin/delete-user` route** (currently at line 477) — it is superseded by the above.

---

### Step 3: Add `GET /admin` static route to `server.js`

```js
if (pathname === '/admin') {
  const file = path.join(__dirname, 'public', 'admin.html');
  if (fs.existsSync(file)) {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    return res.end(fs.readFileSync(file));
  }
}
```

Public at the file-serve level — access control is enforced client-side (redirect to `/login` if no JWT) and server-side (all `/api/admin/*` routes return 403 for non-seed users).

---

### Step 4: Create `public/admin.html`

**CSS:** Copy the full `:root` variable block and all shared component styles from `app.html` (stats-row, stat-card, btn-primary, btn-ghost, btn-danger, section-title, header styles). Add a `<table>` style for the user table.

**Page structure:**

```
header
  logo | "Admin" label | [Go to Dashboard] [Sign out]

main
  stats row (4 cards)
    Total Users | Active | Trialing | Unverified

  section title: "Users"
  user table
    thead: Email | Joined | Verified | Status | Trial Ends | Last Login | Actions
    tbody: one row per user
      actions: [Activate] [Deactivate] [Delete]
```

**JS flow on page load:**
1. Check `localStorage.getItem('token')` — if absent, redirect to `/login`
2. `GET /api/admin/users` with JWT
3. On 403 → show "Access denied" message, hide table
4. On success → render stats cards and user table

**Stats computation** (client-side from the users array):
- Total users: `users.length`
- Active: `users.filter(u => u.subscriptionStatus === 'active').length`
- Trialing: `users.filter(u => u.subscriptionStatus === 'trialing').length`
- Unverified: `users.filter(u => !u.emailVerified).length`

**Action handlers:**
- `activate(id)` → `PATCH /api/admin/users/:id` with `{ action: 'activate' }`, re-render on success
- `deactivate(id)` → `PATCH /api/admin/users/:id` with `{ action: 'deactivate' }`, re-render on success
- `deleteUser(id, email)` → `confirm('Delete ${email}? This cannot be undone.')` → `DELETE /api/admin/users/:id`, re-render on success

**Status pill colors** (inline style or class):
- `active` → accent green
- `trialing` → blue
- `past_due` → warn amber
- `canceled` / `none` → muted

---

## Risks and Unknowns

**Seed user self-deletion.** The seed user row must not have a Delete button. Also enforced server-side: `DELETE /api/admin/users/:id` returns 400 if the target is the seed user. Both guards are needed — never rely solely on the UI to prevent dangerous actions.

**No `last_login` before this deploy.** All existing users will have `last_login = NULL` until they log in after Phase 3 ships. The table should display "—" for null values, not a JS error.

**`getAllUsers` returns all rows — scales fine at current size.** With hundreds of users this is acceptable. At thousands, add pagination. Not a concern for launch.

**`updateSubscriptionStatusById` vs `updateSubscriptionStatus`.** The existing `updateSubscriptionStatus` prepared statement targets `WHERE stripe_customer_id = ?` (for Stripe webhook use). The new `updateSubscriptionStatusById` targets `WHERE id = ?` (for manual admin use). Do not confuse them — they serve different lookup keys.

**The old `DELETE /api/admin/delete-user` route accepts email, not id.** The new routes use user id (UUID) extracted from the URL path. The old route must be removed when the dashboard ships — otherwise two delete mechanisms exist with different interfaces, which is confusing.

**No confirmation email on manual activation.** When the seed user activates an account via the dashboard, the user receives no notification. Consider adding a simple activation email via `lib/email.js` in a follow-up — for now, the user is expected to check back or be notified manually.
