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
5. Each pixel hit is passed through `isAutomatedScanner()` — 5 strategies detect delivery scanners vs. real human opens (see `docs/solutions/003-scanner-detection.md`)

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

The `GET /api/emails` response includes `realOpenCount` (non-proxy opens) alongside `openCount` (all opens). Each open record stores `viaProxy` (bool) and `scannerReason` (`google_proxy` | `known_scanner_range` | `no_ua` | `suspicious_ua` | `rapid_fire_scanner` | null).

### Automated Scanner Detection

`isAutomatedScanner(ip, ua, trackId, opens, emailCreatedAt)` in `server.js` runs on every pixel hit. Five strategies, evaluated in this order:

| Strategy | Trigger | Time-gated? |
|---|---|---|
| `rapid_fire_scanner` | 2+ hits from same IP for same trackId within 60s | No — applies to ALL IPs always |
| `known_scanner_range` | IP in `KNOWN_SCANNER_RANGES` (e.g. `179.50.15.`) | No |
| `google_proxy` | Google IP ranges or `GoogleImageProxy` UA | Yes — within 600s of `createdAt` |
| `no_ua` | Missing/empty `User-Agent` | No |
| `suspicious_ua` | UA doesn't match Mozilla/Chrome/Safari/Outlook | No |

`rapid_fire_scanner` fires on the **2nd hit** (1 existing + current = 2 total) and **retroactively patches** any earlier opens from the same IP/trackId within the 60s window that were already logged as `viaProxy: false`. This ensures all hits in a rapid-fire burst are flagged, not just the one that crossed the threshold.

`KNOWN_SCANNER_RANGES` in `server.js` is a small explicit blocklist for confirmed bad-actor ranges (`179.50.15.` etc.). Add ranges here when rapid-fire alone isn't sufficient (e.g. slow-drip scanners).

Google IP ranges are time-gated at 600s: after that threshold, a Google IP hit counts as a real Gmail open (human opened via Gmail mobile).

Scanner hits are logged with `viaProxy: true` and `scannerReason: '<strategy>'`. Google proxy hits show as "Gmail Proxy, Google"; other scanners show as "Scanner, Automated". Neither counts toward opened status.

### Gmail Tracking Notes
- Gmail pre-fetches images via Google proxy — flagged as `google_proxy` if within 120s, counted as real open if after 120s
- Recipients must have "Show images" enabled in Gmail for tracking to work

---

## Current Status (as of March 27, 2026)

- ✅ Railway deployment live and working
- ✅ Pixel tracking working (opens logged with location + timestamp)
- ✅ Dashboard showing correct Railway URLs
- ✅ Scanner detection refactored to behavioral-first: rapid-fire (2-hit threshold) catches unknown ranges; `KNOWN_SCANNER_RANGES` is a small explicit fallback
- ✅ Retroactive patching: when rapid-fire fires, earlier hits from the same IP/trackId within 60s are flipped to `viaProxy: true` in the same DB write
- ✅ Google proxy time gate extended to 600s (was 120s); all other IP-range checks removed from time-gated block
- ✅ Tested end-to-end with real email to boti82@gmail.com
- ✅ 2-state tracking: unseen / opened (proxy opens logged but don't count as opened)

### Next Up
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
| Mar 2026 | Use `createdAt` (not `sentAt`) as scanner time baseline | `sentAt` required manual "Mark as Sent" action; `createdAt` is set automatically and sufficient — scanners always hit within seconds of delivery |
| Mar 2026 | Behavioral detection over IP blocklist | New scanner IP ranges kept appearing; rapid-fire (2+ hits/60s) catches any scanner regardless of IP. `KNOWN_SCANNER_RANGES` kept as a last-resort fallback for slow-drip scanners only |
| Mar 2026 | Retroactive rapid-fire patching | First hit from an unknown scanner passes all checks; without retroactive correction it stays as a real open permanently. Patch runs in the same DB write cycle as the triggering hit |
