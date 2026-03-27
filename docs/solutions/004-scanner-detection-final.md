---
title: "Scanner Detection: Behavioral-First with Retroactive Rapid-Fire Patching"
date: 2026-03-27
status: resolved
problem_type: logic_error
component: email_processing
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - scanner-detection
  - email-tracking
  - rapid-fire
  - behavioral-detection
  - retroactive-patching
related_files:
  - server.js
supersedes: docs/solutions/003-scanner-detection.md
related_commits:
  - "3433deb refactor scanner detection: rapid-fire first, remove IP blocklist"
---

## Problem

The IP-range blocklist approach in `isAutomatedScanner()` didn't scale. New scanner IP ranges kept appearing (e.g., `179.50.15.x`), requiring manual additions each time. Additionally, the rapid-fire threshold was set too high (3 hits), so the **first 2 hits from a scanner always slipped through as real opens** before the 3rd triggered the check. Both problems inflated open counts.

## Symptoms

- New scanner IP ranges logged as real geographic opens (e.g., Brazil, Chile) — not matching any known blocklist entry
- Emails showing 1–2 "real" opens that were obviously automated (arrived within seconds, geographic impossibility, came from commercial IP ASNs)
- Manual blocklist additions required after each new scanner was observed
- With a 3-hit threshold, the 1st and 2nd scanner hits were permanently logged as `viaProxy: false`

## What Didn't Work

**Expanding the IP blocklist (commits `5aeb36c`, `3433deb` predecessor):** Adding `140.248.x`, `167.82.x`, `191.104.208.x` one at a time. This is a whack-a-mole approach — scanner operators use rotating commercial IP infrastructure. The list is always one incident behind.

**3-hit rapid-fire threshold:** `recentSameIp.length >= 2` meant the check fired on the 3rd hit. The first two hits already passed through as real opens and were written to `db.opens` with `viaProxy: false`. No retroactive correction existed.

## Solution

Three changes, all in `server.js`:

### 1. Rapid-fire first, threshold lowered to 2 hits

Move `rapid_fire_scanner` to the top of `isAutomatedScanner()`, before all IP and UA checks. Lower threshold from 3 hits to 2 hits (1 existing + current = 2 total).

```js
// BEFORE — rapid-fire was last, triggered on 3rd hit
if (recentSameIp.length >= 2) { // 2 existing + this one = 3 total
  return { viaProxy: true, scannerReason: 'rapid_fire_scanner' };
}

// AFTER — rapid-fire is first, triggers on 2nd hit
const recentSameIp = opens.filter(o =>
  o.trackId === trackId &&
  o.ip === ip &&
  (now - new Date(o.timestamp).getTime()) <= 60000
);
if (recentSameIp.length >= 1) { // 1 existing + this one = 2 total
  return { viaProxy: true, scannerReason: 'rapid_fire_scanner' };
}
```

### 2. Retroactive patching in the pixel handler

When `rapid_fire_scanner` fires, loop back through `db.opens` and flip any earlier opens from the same IP/trackId within the 60s window that were already stored as `viaProxy: false`.

```js
db.opens.push({ ..., viaProxy, scannerReason });

// Retroactively flag earlier hits from the same IP/trackId that slipped through as real opens
if (scannerReason === 'rapid_fire_scanner') {
  const cutoff = Date.now() - 60000;
  db.opens.forEach(o => {
    if (o.trackId === trackId && o.ip === ip && !o.viaProxy &&
        new Date(o.timestamp).getTime() >= cutoff) {
      o.viaProxy = true;
      o.scannerReason = 'rapid_fire_scanner';
    }
  });
}

saveDB(db);
```

### 3. Remove `known_scanner_range` from the time-gated block; replace with a small explicit fallback list

`KNOWN_SCANNER_RANGES` is a module-level constant for ranges confirmed by observation to be scanner-only (not used by real email clients). These are checked **without a time gate** — they're never legitimate opens. Add to this list only as a last resort when behavioral detection alone isn't sufficient (e.g., slow-drip scanners below the rapid-fire threshold).

```js
const KNOWN_SCANNER_RANGES = ['179.50.15.'];

// In isAutomatedScanner(), after rapid-fire check:
if (KNOWN_SCANNER_RANGES.some(range => ip.startsWith(range))) {
  return { viaProxy: true, scannerReason: 'known_scanner_range' };
}
```

### Final `isAutomatedScanner()` — check order

```js
const REAL_UA_PATTERNS = ['Mozilla', 'Chrome', 'Safari', 'Outlook'];
const KNOWN_SCANNER_RANGES = ['179.50.15.'];

function isAutomatedScanner(ip, ua, trackId, opens, emailCreatedAt) {
  const now = Date.now();

  // 1. Rapid-fire — all IPs, no time gate
  const recentSameIp = opens.filter(o =>
    o.trackId === trackId &&
    o.ip === ip &&
    (now - new Date(o.timestamp).getTime()) <= 60000
  );
  if (recentSameIp.length >= 1) {
    return { viaProxy: true, scannerReason: 'rapid_fire_scanner' };
  }

  // 2. Known scanner ranges — fallback explicit blocklist, no time gate
  if (KNOWN_SCANNER_RANGES.some(range => ip.startsWith(range))) {
    return { viaProxy: true, scannerReason: 'known_scanner_range' };
  }

  // 3. Google proxy — time-gated at 600s (after that = real Gmail open via proxy)
  const withinGoogleWindow = emailCreatedAt && (now - new Date(emailCreatedAt).getTime()) <= 600000;
  if (withinGoogleWindow) {
    if ((ua && ua.includes('GoogleImageProxy')) ||
        ip.startsWith('66.102.') || ip.startsWith('66.249.') ||
        ip.startsWith('64.233.') || ip.startsWith('72.14.') ||
        ip.startsWith('74.125.') || ip.startsWith('209.85.')) {
      return { viaProxy: true, scannerReason: 'google_proxy' };
    }
  }

  // 4. No UA — always active
  if (!ua) {
    return { viaProxy: true, scannerReason: 'no_ua' };
  }

  // 5. Suspicious UA — always active
  if (!REAL_UA_PATTERNS.some(p => ua.includes(p))) {
    return { viaProxy: true, scannerReason: 'suspicious_ua' };
  }

  return { viaProxy: false, scannerReason: null };
}
```

## Why This Works

**Behavioral over identity:** Scanners always burst — they fetch the pixel multiple times in quick succession (delivery confirmation, spam re-scan, etc). A human opens an email once per session. Moving rapid-fire to the top means unknown scanner IPs are caught by behavior, not by being on a list. The blocklist no longer needs to be exhaustive.

**Why the retroactive patch is necessary:** `isAutomatedScanner()` only sees prior opens at call time. The first hit from a new IP passes all checks (no prior opens, real-looking UA) and is written to `db.opens` as `viaProxy: false`. Without retroactive patching, that first hit stays as a real open permanently — even after the second hit triggers `rapid_fire_scanner`. The patch corrects the record within the same request/response cycle, before `saveDB()` is called.

**Why `KNOWN_SCANNER_RANGES` has no time gate:** Unlike Google's proxy infrastructure (which represents real humans after the time window), confirmed scanner-only ranges will never become legitimate opens. Time-gating them was a mistake inherited from the original `withinScanWindow` block design.

## Prevention

### When to add to `KNOWN_SCANNER_RANGES`

Only add a range when:
1. It appears repeatedly across multiple emails
2. Rapid-fire didn't catch it (slow-drip pattern — 1 hit per email, many emails)
3. WHOIS/ASN confirms it's commercial scanning infrastructure, not a residential/mobile range

Use `ip-api.com` or `ipinfo.io` to check the ASN. Residential and mobile ranges should never go in the blocklist.

### Tuning the rapid-fire window

The 60-second window (`<= 60000`) and 2-hit threshold (`>= 1`) are in `isAutomatedScanner()`. Raising the window catches slower scanners but risks flagging a user who opens an email twice in quick succession (e.g., preview + full open). The current values represent the minimum observable scanner behavior.

### Test cases

```js
// 1. 2nd hit from same IP within 60s → rapid_fire_scanner (behavioral catch)
const recentOpens = [{ trackId: id, ip: '179.50.15.22', timestamp: new Date(Date.now() - 5000).toISOString() }];
isAutomatedScanner('179.50.15.22', 'Mozilla/5.0', id, recentOpens, oldTime)
// → { viaProxy: true, scannerReason: 'rapid_fire_scanner' }

// 2. Known scanner range, 1st hit — caught by KNOWN_SCANNER_RANGES fallback
isAutomatedScanner('179.50.15.22', 'Mozilla/5.0', id, [], oldTime)
// → { viaProxy: true, scannerReason: 'known_scanner_range' }

// 3. Unknown scanner range, 1st hit, real-looking UA → passes through (expected)
isAutomatedScanner('203.0.113.99', 'Mozilla/5.0 (Windows NT...)', id, [], oldTime)
// → { viaProxy: false, scannerReason: null }

// 4. Same unknown IP hits again within 60s → retroactive patch flips first open
// First hit stored as viaProxy:false. Second hit → rapid_fire_scanner fires.
// Retroactive loop patches the first open to viaProxy:true, scannerReason:'rapid_fire_scanner'.

// 5. Google proxy within 600s → google_proxy
isAutomatedScanner('66.249.1.1', 'GoogleImageProxy/1.0', id, [], recentTime)
// → { viaProxy: true, scannerReason: 'google_proxy' }

// 6. Google proxy after 600s → real Gmail open (time gate expired)
isAutomatedScanner('66.249.1.1', 'Mozilla/5.0', id, [], oldTime)
// → { viaProxy: false, scannerReason: null }

// 7. No UA → no_ua
isAutomatedScanner('1.2.3.4', '', id, [], oldTime)
// → { viaProxy: true, scannerReason: 'no_ua' }

// 8. Legitimate open: real UA, unknown IP, no burst → clean
isAutomatedScanner('203.0.113.5', 'Mozilla/5.0 (iPhone; CPU iPhone OS...)', id, [], oldTime)
// → { viaProxy: false, scannerReason: null }

// Fixtures:
// recentTime = new Date(Date.now() - 30000).toISOString()   // 30s ago
// oldTime    = new Date(Date.now() - 900000).toISOString()  // 15 min ago
```
