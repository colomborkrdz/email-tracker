# AGENTS.md — Email Tracker

> Instructions for AI agents working on this codebase. Read this before making any changes.

---

## Project Context

Self-hosted email open tracker. Logs opens, location, and open count per email.
Single-developer project. Simplicity over abstraction — always.

**Live:** https://email-tracker-production-b00f.up.railway.app  
**Stack:** Node.js (vanilla `http` module), JSON file DB, vanilla HTML/JS  
**Deploy:** Push to `main` → Railway auto-deploys (~60s)

---

## Core Rules

### 1. No unnecessary dependencies
This project uses zero npm packages intentionally. Do not add Express, lodash, or any library unless there is a compelling reason. Discuss first.

### 2. Two files own the base URL — always update both
- `server.js` → `const NGROK_URL`
- `public/index.html` → `const API`

Before any environment change, verify:
```bash
grep -rn "ngrok\|localhost:3000" ~/email-tracker/
```
Zero results = safe to deploy.

### 3. Pixel route uses query params
```
✅ /pixel?id=abc123
❌ /pixel/abc123
❌ /pixel/abc123.png
```
Do not refactor this route to use path segments without updating all pixel tag generation logic.

### 4. JSON DB is intentionally simple
`db/data.json` is the database. It works for solo use. Do not migrate to SQL unless explicitly asked. If asked, prefer SQLite (no separate server needed).

### 5. Deploy verification steps
After any deploy:
1. Check `/pixel?id=test123` → should return blank page (not "Not found")
2. Check dashboard → pixel tags should show `railway.app` URL
3. Create a test email → confirm pixel URL is correct before sending real emails

---

## Architecture Decisions

| Decision | Reason | Date |
|----------|---------|------|
| Vanilla `http` over Express | Zero dependencies, full control | Mar 2026 |
| JSON file over SQLite/Postgres | Fast to build, sufficient for MVP | Mar 2026 |
| Railway over Heroku/Render | Simple git-push deploys, good free tier | Mar 2026 |
| Query param pixel URL | Original design, all logic depends on it | Mar 2026 |

---

## Known Risks

- **Data persistence:** `db/data.json` may reset on Railway container restart. Acceptable for now. Fix: add Railway Volume or migrate to SQLite.
- **No auth:** Dashboard is publicly accessible. Fine for solo use. Add auth before sharing URL with others.
- **Gmail image blocking:** Recipients with image blocking enabled won't trigger the pixel. No fix — this is a Gmail constraint.

---

## File Map

```
server.js              ← All server logic. Routes, tracking, geo lookup, DB read/write.
public/index.html      ← Entire frontend. Dashboard UI + all JS in one file.
db/data.json           ← Live database. emails{} + opens[].
CLAUDE.md              ← Project memory for AI sessions.
AGENTS.md              ← This file. Rules for AI agents.
docs/solutions/        ← Solved problems. Read before debugging similar issues.
```

---

## Before You Ship Any Change

- [ ] Does it touch the base URL? → Update both `server.js` AND `public/index.html`
- [ ] Does it touch routes? → Test all routes manually after deploy
- [ ] Does it touch `data.json` schema? → Make sure existing data still loads cleanly
- [ ] Run: `grep -rn "ngrok\|localhost:3000" ~/email-tracker/` → must return zero results
