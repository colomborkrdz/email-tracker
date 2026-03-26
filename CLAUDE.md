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
│   └── index.html     ← Full dashboard (HTML + JS in one file)
├── db/
│   └── data.json      ← JSON file database (emails + opens)
└── package.json
```

### Key Routes
- `GET /` → serves dashboard (public/index.html)
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
2. `public/index.html` — `const API = '...'` (used by dashboard JS)

Missing either one causes the pixel tag to show the wrong URL.

**Verification command before deploying:**
```bash
grep -n "ngrok\|localhost:3000" ~/email-tracker/server.js ~/email-tracker/public/index.html
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

### Email Status States
Emails have two states:
- **unseen** — no opens where `viaProxy === false`
- **opened** — at least one open where `viaProxy === false`

Gmail proxy hits are logged and visible in the opens table (marked "(proxy)") but do NOT change the opened status. Open rate = emails with `realOpenCount > 0` divided by total tracked emails.

The `GET /api/emails` response includes `realOpenCount` (non-proxy opens) alongside `openCount` (all opens). No PATCH route exists — `sentAt` field has been removed.

### Gmail Tracking Notes
- Gmail pre-fetches images via Google proxy — this shows as "Gmail Proxy, Google" in the dashboard
- This is normal and expected — multiple proxy opens on the same email are Gmail, not the recipient
- Recipient's real open shows their actual city/country
- Recipients must have "Show images" enabled in Gmail for tracking to work

---

## Current Status (as of March 25, 2026)

- ✅ Railway deployment live and working
- ✅ Pixel tracking working (opens logged with location + timestamp)
- ✅ Dashboard showing correct Railway URLs
- ✅ Google proxy detection working
- ✅ Tested end-to-end with real email to boti82@gmail.com
- ✅ 2-state tracking: unseen / opened (proxy opens logged but don't count as opened)

### Next Up
- [ ] Test open tracking from recipient's side (confirm non-proxy open logs correctly)
- [ ] Add email open notifications (webhook or email alert when recipient opens)
- [ ] Optional: custom domain via Railway → Settings → Networking → Custom Domain
- [ ] Optional: migrate from JSON file DB to SQLite for reliability

---

## Known Issues / Watch Out For

- JSON file DB (`data.json`) is ephemeral on Railway — if the container restarts, data resets. For now acceptable for testing; migrate to SQLite or Railway volume for persistence.
- No authentication on dashboard — anyone with the URL can see all tracked emails. Fine for solo use, needs auth before sharing.

---

## Decisions Log

| Date | Decision | Reason |
|------|----------|--------|
| Mar 2026 | Use vanilla http module instead of Express | Simplicity, no dependencies |
| Mar 2026 | JSON file as DB | Fast to build, sufficient for MVP |
| Mar 2026 | Host on Railway | Simple git-push deploys, free tier available |
| Mar 2026 | `sentAt` field for "Mark as Sent" | Distinguish drafts from actually-sent emails; open rate only counts sent emails |
