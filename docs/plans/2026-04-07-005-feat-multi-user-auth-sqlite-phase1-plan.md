---
title: "feat: Multi-user auth + SQLite migration (Phase 1)"
type: feat
status: active
date: 2026-04-07
---

# feat: Multi-user auth + SQLite migration (Phase 1)

## Overview

Convert email-tracker from a single-user personal tool to a multi-user SaaS. Phase 1 delivers the complete authentication and data-isolation foundation: user signup/login, email verification, JWT sessions, SQLite replacing the JSON file DB, and per-user scoping on all email/opens data. Stripe billing is Phase 2 and is explicitly out of scope here.

## Problem Frame

The current tracker has no authentication, a single implicit user, and an ephemeral flat-file database. Shipping to multiple users requires: (1) a persistent relational database, (2) user identity, (3) session auth on the API, (4) complete data isolation per user. All four must land together — partial delivery leaves the system in a broken intermediate state.

## Requirements Trace

- R1. Users can sign up with email + password. Account is inactive until email is verified.
- R2. Users can log in with email + password and receive a JWT.
- R3. JWT must be presented on all `/api/emails*` requests. Invalid/missing token returns 401.
- R4. Each user sees only their own tracked emails and opens — no cross-user data leakage.
- R5. The `/pixel` route remains permanently public and auth-free.
- R6. SQLite replaces `db/data.json`. Database file persists across Railway deploys via a Volume.
- R7. Existing JSON data is migrated to SQLite and assigned to a seed (founding) user.
- R8. Email verification link is sent on signup; clicking it activates the account.

## Scope Boundaries

- No Stripe or subscription gating — that is Phase 2.
- No admin panel, no user management UI, no password reset flow (can be added post-Phase 1).
- No OAuth / social login.
- No rate limiting (acceptable for initial launch; add later).
- The pixel route never requires auth — this is a permanent constraint, not a Phase 2 item.

## Context & Research

### Relevant Code and Patterns

- `server.js:1-257` — entire backend: manual routing with `if/else` on pathname, synchronous `loadDB()`/`saveDB()` pattern, body parsed via chunk accumulation per handler
- `server.js:25` — `NGROK_URL` / base URL — single source of truth for pixel URLs (mirrored in `public/index.html`)
- `server.js` — `isAutomatedScanner()` and `geoLookup()` are pure self-contained functions; extract without change
- `public/index.html` — all frontend in one file; split into `login.html` + `app.html` as part of this plan
- `db/data.json` — current schema: `{ emails: { [trackId]: emailObj }, opens: [openObj, ...] }`
- `docs/plans/2026-03-26-001-fix-data-persistence-railway-volume-plan.md` — prior plan for Railway Volume; the SQLite file must live on this volume

### Institutional Learnings

- `docs/solutions/001` — base URL lives in two places (`server.js` + `index.html`); same pattern will apply to auth API endpoint references in the new `login.html`
- CLAUDE.md Known Issues — `data.json` is ephemeral on Railway; SQLite has the same problem without a Volume. **Volume must be provisioned before deploying SQLite.**

### Key Infrastructure Constraint

Railway containers are ephemeral — filesystem resets on every deploy. A Railway Volume must be mounted (e.g. at `/data`) and `DB_PATH` pointed there (`/data/tracker.db`) before any SQLite work is deployed. Without this, user accounts are wiped on every push.

## Key Technical Decisions

- **`better-sqlite3` over `sqlite3`**: Synchronous API matches the current codebase's synchronous `loadDB()`/`saveDB()` pattern. No async refactor needed on core read/write paths. Performs well for this workload.
- **`bcryptjs` over `argon2`**: Pure JavaScript — no native compilation. Avoids Railway build failures from missing native toolchains. Cost: slightly slower hashing, irrelevant at this scale.
- **JWT in `localStorage` + `Authorization: Bearer` header**: Simpler than `httpOnly` cookies for a vanilla JS frontend with no server-rendered pages. Acceptable threat model for a personal SaaS. If XSS risk increases later, migrate to `httpOnly` cookies.
- **Split `public/index.html` → `login.html` + `app.html`**: The single-file frontend is already ~650 lines. Auth UI would push it past 1000. Separate files keep each concern manageable.
- **`nodemailer` + SMTP env vars for email**: Flexible — works with Resend, SendGrid, Mailgun, or any SMTP relay. No vendor lock-in. Configure via `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` env vars.
- **`lib/` module extraction**: `server.js` will grow significantly. Extract `lib/db.js`, `lib/auth.js`, `lib/scanner.js`, `lib/geo.js`, `lib/email.js` before adding auth routes.
- **Horizontal privilege escalation prevention**: PATCH and DELETE routes must include `WHERE track_id = ? AND user_id = ?` — not just `WHERE track_id = ?`. A user who discovers another user's trackId must not be able to modify or delete it.
- **Pixel route scoping**: The pixel handler looks up emails by `track_id` only — no `user_id` check. This is correct: the trackId UUID is the auth mechanism for the pixel (unguessable, embedded in the `<img>` tag). Do not add user_id gating to the pixel route.

## Open Questions

### Resolved During Planning

- **Which SQLite library?** → `better-sqlite3` (sync API, no refactor cost)
- **Password hashing?** → `bcryptjs` (pure JS, Railway-safe)
- **JWT storage?** → `localStorage` + Bearer header
- **Email sending?** → `nodemailer` + SMTP env vars
- **Existing data?** → One-time migration script assigns all existing emails to a seed user created from `SEED_USER_EMAIL` + `SEED_USER_PASSWORD` env vars

### Deferred to Implementation

- Exact bcrypt salt rounds (12 is a reasonable default; tune based on Railway CPU)
- JWT expiry duration (7 days is reasonable; configure via `JWT_EXPIRES_IN` env var)
- Verification token expiry window (24 hours is standard)
- Whether to redirect `/` to `/login` if no JWT present (client-side redirect is simplest)
- Error message granularity on login failures (security: "invalid email or password" not "no account found")

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### SQLite Schema

```sql
CREATE TABLE users (
  id TEXT PRIMARY KEY,                        -- UUID
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  email_verified INTEGER NOT NULL DEFAULT 0,  -- 0=false, 1=true
  verification_token TEXT,                    -- NULL after verified
  created_at TEXT NOT NULL
);

CREATE TABLE emails (
  track_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject TEXT NOT NULL DEFAULT '(no subject)',
  recipient TEXT NOT NULL DEFAULT '',
  body_html TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX idx_emails_user_id ON emails(user_id);

CREATE TABLE opens (
  id TEXT PRIMARY KEY,
  track_id TEXT NOT NULL REFERENCES emails(track_id) ON DELETE CASCADE,
  timestamp TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  region TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT '',
  via_proxy INTEGER NOT NULL DEFAULT 0,
  scanner_reason TEXT
);
CREATE INDEX idx_opens_track_id ON opens(track_id);
```

### Request flow for protected routes

```
Client request (Authorization: Bearer <jwt>)
  → requireAuth middleware
    → verify JWT signature + expiry
    → attach userId to request context
  → route handler
    → all DB queries WHERE user_id = userId
  → response
```

### Auth routes (all unprotected)

```
POST /api/auth/signup     { email, password } → 201 Created, sends verification email
POST /api/auth/login      { email, password } → 200 { token } or 401
GET  /api/auth/verify-email?token=...         → redirect to /login?verified=1
```

### Frontend routing (no server-side sessions)

```
/login  → serves login.html  (public)
/app    → serves app.html    (public file; client JS checks for JWT, redirects to /login if absent)
/       → redirect to /app
```

## Implementation Units

- [ ] **Unit 1: Railway Volume + SQLite wiring**

**Goal:** SQLite database file persists across deploys; `lib/db.js` creates schema on first run.

**Requirements:** R6

**Dependencies:** None — must be done first; all other units depend on this

**Files:**
- Create: `lib/db.js`
- Modify: `package.json` (add `better-sqlite3` dependency)
- Modify: `server.js` (replace `loadDB`/`saveDB` imports with `lib/db.js`)

**Approach:**
- Provision Railway Volume in Railway dashboard → Settings → Volumes → mount at `/data`
- Set `DB_PATH` env var to `/data/tracker.db` in Railway (keep fallback `./db/tracker.db` for local dev)
- `lib/db.js` exports a single `better-sqlite3` connection instance, created once at module load
- On first connection, run `CREATE TABLE IF NOT EXISTS` for all three tables with the schema above
- Export typed query helpers: `getEmailsByUser(userId)`, `getEmailByTrackId(trackId)`, `insertEmail(...)`, `getOpensByTrackId(trackId)`, `insertOpen(...)`, `updateEmail(...)`, `deleteEmail(...)` — keeps SQL out of route handlers

**Patterns to follow:**
- Current `loadDB()` / `saveDB()` in `server.js` for the synchronous DB interaction style

**Test scenarios:**
- Fresh start: tables created, no data
- Second start: `IF NOT EXISTS` means no error, existing data preserved
- `DB_PATH` env var controls file location; fallback works for local dev

**Verification:**
- `node -e "require('./lib/db')"` completes without error; `tracker.db` created at configured path

---

- [ ] **Unit 2: Extract `lib/` modules from `server.js`**

**Goal:** `server.js` delegates scanner detection, geo lookup, and scanner constants to `lib/` modules. No behavior change.

**Requirements:** Prerequisite for clean Unit 5/6 implementation

**Dependencies:** Unit 1 (lib/ directory established)

**Files:**
- Create: `lib/scanner.js`
- Create: `lib/geo.js`
- Modify: `server.js`

**Approach:**
- `lib/scanner.js`: export `isAutomatedScanner()`, `KNOWN_SCANNER_RANGES`, `REAL_UA_PATTERNS`, and the retroactive proxy-patching helper
- `lib/geo.js`: export `geoLookup(ip)` async function
- `server.js`: `require()` both modules, delete the moved code
- No logic changes — pure extraction

**Patterns to follow:**
- Existing `isAutomatedScanner()` signature at `server.js` (reads `opens` array passed in, does not hit DB directly)

**Test scenarios:**
- Server starts and handles a pixel request end-to-end after extraction
- Scanner detection still marks rapid-fire hits as `viaProxy: true`

**Verification:**
- `node server.js` starts cleanly; pixel endpoint logs an open with correct scanner detection

---

- [ ] **Unit 3: Auth utilities (`lib/auth.js`, `lib/email.js`)**

**Goal:** Password hashing/comparison, JWT sign/verify, and verification email sending are available as tested utilities.

**Requirements:** R1, R2, R8

**Dependencies:** Unit 1

**Files:**
- Create: `lib/auth.js`
- Create: `lib/email.js`
- Modify: `package.json` (add `jsonwebtoken`, `bcryptjs`, `nodemailer`)

**Approach:**
- `lib/auth.js`: `hashPassword(plain)`, `comparePassword(plain, hash)`, `signToken(userId)`, `verifyToken(token)` — all synchronous except `hashPassword`/`comparePassword` which use bcryptjs async API
- JWT signed with `process.env.JWT_SECRET` (hard-fail at startup if missing); configurable expiry via `JWT_EXPIRES_IN` (default `'7d'`)
- `lib/email.js`: `sendVerificationEmail(toEmail, token)` — builds nodemailer transporter from `SMTP_*` env vars, sends HTML email with verification link `${BASE_URL}/api/auth/verify-email?token=${token}`
- Hard-fail at startup if `JWT_SECRET` is absent; log a warning (not hard-fail) if SMTP env vars are absent (allows running without email in local dev)

**Patterns to follow:**
- `NGROK_URL` / `BASE_URL` constant pattern in `server.js` for building the verification URL

**Test scenarios:**
- `hashPassword` + `comparePassword` round-trip returns true for matching plain text
- `signToken` + `verifyToken` round-trip returns the original userId
- `verifyToken` throws on tampered or expired token
- `sendVerificationEmail` calls nodemailer transport (can be stubbed for local dev with `SMTP_HOST=localhost`)

**Verification:**
- Unit can be required and all four auth functions called without error; email function logs the verification URL when SMTP is not configured

---

- [ ] **Unit 4: JSON → SQLite data migration script**

**Goal:** One-time script transfers all existing emails and opens from `db/data.json` to SQLite, assigned to a seed user.

**Requirements:** R7

**Dependencies:** Units 1, 3

**Files:**
- Create: `scripts/migrate.js`

**Approach:**
- Read `DB_PATH` for SQLite and `DATA_JSON_PATH` (default `./db/data.json`) for source
- Read two seed user env vars: `SEED_USER_EMAIL`, `SEED_USER_PASSWORD` — create the user if not already in the DB
- For each email in `data.json.emails`: insert into `emails` table with `user_id = seedUser.id`; skip if `track_id` already exists (idempotent)
- For each open in `data.json.opens`: insert into `opens` table; skip if `id` already exists
- Log counts: `Migrated X emails, Y opens → seed user <email>`
- Script is run once manually (`node scripts/migrate.js`) before first multi-user deploy; not called automatically

**Test scenarios:**
- Running twice on the same data produces no errors and no duplicates
- Seed user created with hashed password (not plaintext)
- All email records linked to seed user

**Verification:**
- After running: `SELECT COUNT(*) FROM emails` matches email count in `data.json`; `SELECT COUNT(*) FROM opens` matches opens count

---

- [ ] **Unit 5: Auth routes (signup, login, email verification)**

**Goal:** Three new unprotected routes handle user creation, login, and email verification.

**Requirements:** R1, R2, R8

**Dependencies:** Units 1, 3

**Files:**
- Modify: `server.js`

**Approach:**
- `POST /api/auth/signup`: validate email format + password length; check email not already taken (409 if taken); hash password; generate UUID verification token; insert user; call `sendVerificationEmail`; return 201 `{ message: 'Check your email to verify your account' }`
- `POST /api/auth/login`: look up user by email; if not found or wrong password → 401 `{ error: 'Invalid email or password' }` (same message for both — no enumeration); if `email_verified === 0` → 403 `{ error: 'Please verify your email before logging in' }`; sign JWT with userId; return 200 `{ token }`
- `GET /api/auth/verify-email?token=...`: look up user by `verification_token`; if not found → 400; set `email_verified = 1`, `verification_token = NULL`; redirect to `/login?verified=1`
- All three routes added before the existing route `if` chain in `server.js`

**Patterns to follow:**
- Existing body chunk accumulation pattern in `server.js` POST handlers
- JSON error response pattern `{ error: '...' }` used throughout

**Test scenarios:**
- Signup with valid email + password → 201, user in DB, email_verified=0
- Signup with duplicate email → 409
- Login with unverified account → 403
- Login with wrong password → 401 (same message as no-account case)
- Login with verified account → 200 with JWT
- Verify email with valid token → user.email_verified=1, redirect to /login?verified=1
- Verify email with invalid/expired token → 400

**Verification:**
- Full signup → verify → login flow completes and returns a valid JWT that `verifyToken()` accepts

---

- [ ] **Unit 6: `requireAuth` middleware + per-user scoping on existing routes**

**Goal:** All `/api/emails*` routes require a valid JWT; all DB queries are scoped to the authenticated user.

**Requirements:** R3, R4, R5

**Dependencies:** Units 1, 3, 5

**Files:**
- Modify: `server.js`
- Modify: `lib/db.js` (add `userId` parameter to query helpers)

**Approach:**
- `requireAuth(req, res)`: read `Authorization` header, extract Bearer token, call `verifyToken()`, attach `req.userId`; on failure send 401 `{ error: 'Unauthorized' }` and return `false` so the caller can `return` immediately
- Apply `requireAuth` at the top of each existing `/api/emails*` handler
- `POST /api/emails`: insert with `user_id = req.userId`
- `GET /api/emails`: `SELECT ... WHERE user_id = req.userId`
- `PATCH /api/emails/:trackId`: `UPDATE ... WHERE track_id = ? AND user_id = req.userId` — return 404 if 0 rows affected (either not found or belongs to another user)
- `DELETE /api/emails/:trackId`: `DELETE ... WHERE track_id = ? AND user_id = req.userId` — same 404 handling
- `/pixel` route: no change — remains permanently auth-free
- CORS: add `Authorization` to `Access-Control-Allow-Headers`

**Patterns to follow:**
- Current route handler structure in `server.js`
- `PATCH` currently uses `pathname.split('/')[3]` — harden to a regex match while touching this code

**Test scenarios:**
- Request to `/api/emails` with no token → 401
- Request with valid token → returns only that user's emails (not all emails)
- PATCH/DELETE with valid token but another user's trackId → 404 (not 403 — don't reveal existence)
- Pixel hit with no token → still logged correctly
- Two users with separate emails: each sees only their own data

**Verification:**
- Create two users, each with a tracked email; GET /api/emails for user A returns only user A's email

---

- [ ] **Unit 7: Frontend split + auth UI**

**Goal:** Dashboard requires login. Unauthenticated users are redirected to login page. Signup and login work end-to-end.

**Requirements:** R1, R2, R3

**Dependencies:** Units 5, 6

**Files:**
- Create: `public/login.html`
- Rename/modify: `public/index.html` → `public/app.html`
- Modify: `server.js` (serve new files, add `/login` route, redirect `/` to `/app`)

**Approach:**
- `public/login.html`: two-tab UI — "Log in" and "Sign up"; forms POST to `/api/auth/login` and `/api/auth/signup`; on login success, store JWT in `localStorage('token')` and redirect to `/app`; show inline errors on failure; if `?verified=1` in URL, show "Email verified — you can now log in" banner
- `public/app.html`: current `index.html` content, with these changes:
  - On page load, check `localStorage.getItem('token')`; if absent, `window.location = '/login'`
  - All `fetch()` calls add `Authorization: Bearer ${token}` header
  - On any 401 response: clear localStorage, redirect to `/login`
  - Add logout button in header: clears `localStorage('token')`, redirects to `/login`
- `server.js` routing:
  - `GET /login` → serve `public/login.html`
  - `GET /app` → serve `public/app.html`
  - `GET /` → 302 redirect to `/app`
  - `GET /index.html` → 302 redirect to `/app` (backward compat)

**Patterns to follow:**
- Existing `fetch()` + `async/await` pattern in `public/index.html`
- Existing dark-theme CSS variables (carry all `:root` variables into `login.html`)
- IBM Plex font imports already in `index.html` — replicate in `login.html`

**Test scenarios:**
- Visit `/` while logged out → lands on `/login`
- Visit `/app` while logged out → redirects to `/login`
- Signup with new email → success message, then verify email, then login succeeds
- Login with valid credentials → JWT stored, dashboard loads with user's emails
- Logout → localStorage cleared, redirect to login, `/app` no longer accessible
- Token expiry (or manual localStorage clear) → next API call returns 401, auto-redirect to login

**Verification:**
- Full end-to-end: signup → verify email → login → see dashboard → logout → cannot access dashboard

---

## System-Wide Impact

- **`/pixel` route is permanently public**: Any refactor that adds a global auth middleware must explicitly exclude `/pixel`. Verify this in every future `server.js` change.
- **CORS `Access-Control-Allow-Headers`**: Must include `Authorization` or browser will block preflight for authenticated requests.
- **Railway Volume**: Without the volume provisioned first, deploying Units 1-7 wipes all user accounts on the next deploy. Volume setup is the single blocking prerequisite.
- **`data.json` stays on disk post-migration**: Do not delete it until the migration script has been run and verified in production. Keep as a recovery artifact for at least one week post-deploy.
- **`DB_PATH` env var**: Already used in the codebase for `data.json`; repurpose for the SQLite path. Update Railway env var and local `.env` / dev instructions.
- **Startup env var validation**: Add a hard check at server start for `JWT_SECRET`. Missing secret in production would allow unsigned tokens to be accepted by any downstream JWT library configured insecurely.

## Risks & Dependencies

- **Railway Volume is blocking**: Cannot deploy SQLite without it. Provision the volume before merging Unit 1.
- **`bcryptjs` async vs sync**: bcryptjs has both sync and async APIs. Use async (`bcrypt.hash`, `bcrypt.compare`) in the auth routes — sync bcrypt blocks the Node.js event loop during hashing.
- **Native module build on Railway**: `better-sqlite3` requires a C++ build step. Railway should handle this via its build phase, but pin the Node.js version in `package.json` `engines` field and Railway settings to avoid ABI mismatches.
- **No test suite**: Auth and data-isolation code is security-critical. Manually test all scenarios in Unit 5/6 before deploying. Consider adding basic smoke tests (`scripts/test-auth.js`) that exercise the full auth flow against a local server.
- **Existing sessions on deploy**: Phase 1 has no existing sessions to invalidate (single-user, no auth today). Clean slate.
- **Email deliverability**: Verification emails sent via SMTP may land in spam for new domains. Test with a real inbox before launch. SPF/DKIM records on `mangacreativestudios.com` are outside scope but important.

## Documentation / Operational Notes

- Set these Railway env vars before deploying: `JWT_SECRET` (random 32+ char string), `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `SEED_USER_EMAIL`, `SEED_USER_PASSWORD`, `DB_PATH=/data/tracker.db`
- Run `node scripts/migrate.js` once after first deploy to move existing data to the seed user
- Update CLAUDE.md after Phase 1 ships: new routes table, auth flow description, env vars list, SQLite schema

## Sources & References

- Related code: `server.js`, `public/index.html`, `db/data.json`
- Related plan: `docs/plans/2026-03-26-001-fix-data-persistence-railway-volume-plan.md`
- Related solution: `docs/solutions/001-fix-hardcoded-urls-railway.md`
- `better-sqlite3`: synchronous SQLite bindings for Node.js
- `bcryptjs`: pure-JS bcrypt (no native compilation)
- `jsonwebtoken`: JWT sign/verify
