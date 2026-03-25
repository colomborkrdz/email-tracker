# Solution: Fix Hardcoded URLs for Railway Deployment

**Date:** March 24, 2026  
**Status:** Resolved ✅

---

## Problem

After deploying to Railway, the dashboard was generating pixel tags with the old ngrok URL (`https://heteromorphic-supportively-wendy.ngrok-free.dev`) instead of the Railway URL. The dashboard also showed `localhost:3000` in the stored pixel URLs.

## Root Cause

The base URL is defined in **two separate places** and both need to be updated when switching environments:

1. `server.js` line ~20: `const NGROK_URL = '...'` — used when generating pixel URLs in API responses
2. `public/index.html` line 415: `const API = '...'` — used by the dashboard JavaScript for all fetch calls and displayed pixel tags

Only `server.js` had been updated. `public/index.html` still pointed to `localhost:3000`.

## Fix Applied

```bash
# Find all hardcoded URLs
grep -n "ngrok\|localhost:3000" ~/email-tracker/server.js ~/email-tracker/public/index.html

# Fix index.html
sed -i '' "s|const API = 'http://localhost:3000'|const API = 'https://email-tracker-production-b00f.up.railway.app'|" ~/email-tracker/public/index.html

# Verify
grep -n "API" ~/email-tracker/public/index.html

# Deploy
cd ~/email-tracker && git add public/index.html && git commit -m "fix API URL to railway" && git push
```

## Rule Going Forward

**Before any deployment environment change, always run:**
```bash
grep -rn "ngrok\|localhost:3000" ~/email-tracker/
```
Zero results = safe to deploy.

## What We Learned

- The frontend (`index.html`) defines its own API base URL independently from the server
- All pixel tag generation, copy buttons, and API calls in the dashboard flow through `const API`
- Updating server.js alone is not enough — the dashboard JS is served as a static file and has its own hardcoded reference
