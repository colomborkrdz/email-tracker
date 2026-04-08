# Email Tracker — Project Memory (CLAUDE.md)

> This file is read at the start of every session. Keep it updated. Every bug fix, pattern, and decision lives here.

---

## Project Overview

A self-hosted email open tracker — shows if an email was opened, from where, and how many times. Built as an alternative to Mixpanel/Superhuman tracking.

**Live URL:** https://email-tracker-production-b00f.up.railway.app  
**GitHub:** https://github.com/colomborkrdz/email-tracker  
**Stack:** Node.js (vanilla http module), JSON file database, vanilla HTML/JS dashboard  
**Hosting:** Railway (auto-deploys from GitHub main branch)  
**Local dev:** `cd ~/email-tracker && node server.js` + ngrok for public tunnel

---

## Architecture

```
email-tracker/
├── server.js          ← HTTP server, all routes, tracking logic
├── public/
│   ├── app.html       ← Dashboard (requires JWT, redirects to /login if no token)
│   └── login.html     ← Login/signup page (public)
├── db/
│   └── data.json      ← JSON file database (emails + opens)
└── package.json
```

### Key Routes
- `GET /` → serves dashboard (public/app.html)
- `GET /pixel?id=TRACK_ID` → logs open, returns 1x1 GIF pixel ⚠️ query param, NOT path segment
- `POST /api/emails` → creates tracked email, returns pixelUrl
- `GET /api/emails` → returns all emails with open counts + locations
- `DELETE /api/emails/:id` → deletes tracked email

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

### Next Up
- [ ] Add email open notifications (webhook or email alert when recipient opens)
- [ ] Phase 2: Stripe billing

---

## Known Issues / Watch Out For

- JSON file DB (`data.json`) is ephemeral on Railway — if the container restarts, data resets. For now acceptable for testing; migrate to SQLite or Railway volume for persistence.
- No authentication on dashboard — anyone with the URL can see all tracked emails. Fine for solo use, needs auth before sharing.
- **`railway run` cannot access Railway Volumes** — the CLI runs in a local context without volume mounts. Use API routes or Railway's shell (`railway shell`) for any DB operations that need to touch the SQLite file.
- **Resend domain verification is separate from Railway custom domain DNS** — both require their own GoDaddy DNS records. Adding Railway's CNAME does not verify the Resend sending domain; add Resend's SPF/DKIM/DMARC records independently.

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

---

## Roadmap

### Immediate
- [x] Test new user signup + email verification flow via Resend ✅ Apr 8 2026
- [x] Test open tracking end to end with new auth system ✅ Apr 7 2026
- [x] Fix app.html reference in CLAUDE.md ✅ Apr 7 2026

### Phase 2 — Stripe Billing
- [ ] Add Stripe subscription at $5/month
- [ ] Gate dashboard access behind active subscription
- [ ] Add billing management page

### Phase 3 — Polish
- [ ] Switch BASE_URL to track.mangacreativestudios.com once DNS propagates
- [ ] Email open notifications (webhook or email alert on open)
- [ ] Admin dashboard to manage users
