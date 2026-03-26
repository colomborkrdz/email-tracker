---
title: "Automated Scanner Detection: isGoogleProxy → isAutomatedScanner with 5 Strategies"
date: 2026-03-26
status: resolved
problem_type: logic_error
component: email_processing
root_cause: logic_error
resolution_type: code_fix
severity: high
tags:
  - scanner-detection
  - email-tracking
  - google-proxy
  - user-agent
  - ip-filtering
  - rapid-fire
related_files:
  - server.js
related_commits:
  - "021fca2 time-based scanner detection: proxy hits after 120s count as real opens"
  - "5aeb36c add known scanner IP ranges 140.248.x and 167.82.x"
  - "3d9bc73 expand scanner detection: suspicious UA, rapid-fire, no UA"
  - "a27ca7a simplify to 2-state tracking: opened only on non-proxy opens"
---

## Problem

The original `isGoogleProxy` check only matched Google's known IP prefixes, letting through non-Google delivery scanners, headless bots, and requests with missing or non-browser user-agents — all of which were logged as genuine human opens and inflated open counts.

## Symptoms

- Emails showed as "opened" within seconds of send — before any human could have seen them
- Multiple rapid opens from the same IP counted as real opens
- Known third-party security scanner ranges (`140.248.x`, `167.82.x`) appeared as geographic opens
- Requests with no user-agent or bot-style UAs were treated as real opens
- Gmail proxy hits that arrived after 120s (delayed image prefetch, cached thread re-open) were being dropped even though a human caused them

## What Didn't Work

**3-state tracking with a manual `sentAt` field (commit `b156bb2`):** Added a PATCH endpoint and a "Mark as Sent" button so users could set a `sentAt` baseline for the time window. Introduced UI complexity and required a manual action before each email. Replaced one commit later (`a27ca7a`) by using `createdAt` (set automatically) as the time baseline and dropping back to 2 states.

**IP-only detection without a time gate (commits `3d9bc73`, `5aeb36c`):** Expanded IP checks applied unconditionally at all times. This incorrectly flagged real Gmail users whose client routes image fetches through Google's proxy infrastructure more than 2 minutes after receiving the email. The time gate was the fix.

## Solution

Renamed `isGoogleProxy` → `isAutomatedScanner` and expanded to 5 strategies. Lives in `server.js` lines 24–61.

```js
const REAL_UA_PATTERNS = ['Mozilla', 'Chrome', 'Safari', 'Outlook'];

function isAutomatedScanner(ip, ua, trackId, opens, emailCreatedAt) {
  const now = Date.now();
  const withinScanWindow = emailCreatedAt && (now - new Date(emailCreatedAt).getTime()) <= 120000;

  // IP-based checks only apply within 120s of send — after that, proxy IPs are real human opens
  if (withinScanWindow) {
    if ((ua && ua.includes('GoogleImageProxy')) ||
        ip.startsWith('66.102.') || ip.startsWith('66.249.') ||
        ip.startsWith('64.233.') || ip.startsWith('72.14.') ||
        ip.startsWith('74.125.') || ip.startsWith('209.85.')) {
      return { viaProxy: true, scannerReason: 'google_proxy' };
    }

    if (ip.startsWith('140.248.') || ip.startsWith('167.82.')) {
      return { viaProxy: true, scannerReason: 'known_scanner_range' };
    }
  }

  // UA-based and rapid-fire checks always apply regardless of timing
  if (!ua) {
    return { viaProxy: true, scannerReason: 'no_ua' };
  }

  if (!REAL_UA_PATTERNS.some(p => ua.includes(p))) {
    return { viaProxy: true, scannerReason: 'suspicious_ua' };
  }

  const recentSameIp = opens.filter(o =>
    o.trackId === trackId &&
    o.ip === ip &&
    (now - new Date(o.timestamp).getTime()) <= 60000
  );
  if (recentSameIp.length >= 2) { // 2 existing + this one = 3 total
    return { viaProxy: true, scannerReason: 'rapid_fire_scanner' };
  }

  return { viaProxy: false, scannerReason: null };
}
```

### The 5 Strategies

| Strategy | Trigger | Time-gated? |
|---|---|---|
| `google_proxy` | Google IP ranges (`66.x`/`64.x`/`72.x`/`74.x`/`209.x`) or `GoogleImageProxy` UA | Yes — only within 120s of send |
| `known_scanner_range` | `140.248.x` or `167.82.x` | Yes — only within 120s of send |
| `no_ua` | Empty or missing `User-Agent` | No — always active |
| `suspicious_ua` | UA present but contains none of `Mozilla`, `Chrome`, `Safari`, `Outlook` | No — always active |
| `rapid_fire_scanner` | 3+ pixel fetches from same IP for same `trackId` within 60 seconds | No — always active |

### The 120-Second Time Gate

```js
const withinScanWindow = emailCreatedAt && (now - new Date(emailCreatedAt).getTime()) <= 120000;
```

IP-range checks (`google_proxy`, `known_scanner_range`) are wrapped in `if (withinScanWindow)`. After 120s, a hit from a proxy IP is treated as a real human open (e.g., Gmail mobile cached image load).

### Integration with the Pixel Endpoint

```js
const email = db.emails[trackId];
const { viaProxy, scannerReason } = isAutomatedScanner(ip, userAgent, trackId, db.opens, email?.createdAt);

const geo = viaProxy && scannerReason === 'google_proxy'
  ? { city: 'Gmail Proxy', region: '', country: 'Google' }
  : viaProxy
    ? { city: 'Scanner', region: '', country: 'Automated' }
    : await geoLookup(ip);

// Both scanner and real opens are persisted; viaProxy and scannerReason stored per open
db.opens.push({ ..., viaProxy, scannerReason });
```

`realOpenCount` in `GET /api/emails` is computed as opens where `viaProxy === false`. This is what determines opened status.

## Why This Works

Delivery-time scanners (Google spam filter, Proofpoint, Mimecast) fetch every email image automatically within milliseconds of arrival — server-side, before any human sees the message. They use known IP ranges and either have no UA, a non-browser UA, or hit the pixel in rapid bursts.

The 120-second window exploits the timing asymmetry: a machine scanner arrives before a human can read the subject line. After 120s, a Google proxy hit is almost certainly a real Gmail user routing image fetches through Google's proxy (as Gmail does for all remote images). UA and rapid-fire checks have no time gate because a badly-behaved scanner can arrive at any time, and a human will never hit the same pixel three times in 60 seconds.

## Prevention

### Adding new scanner IP ranges

Add a new `ip.startsWith()` inside the `withinScanWindow` block. Always time-gate IP checks unless you've confirmed the range is never used by real email clients:

```js
if (withinScanWindow) {
  // ... existing checks ...
  if (ip.startsWith('NEW.RANGE.')) {
    return { viaProxy: true, scannerReason: 'known_scanner_range' };
  }
}
```

To identify new ranges: look at opens where `createdAt` and `timestamp` are within seconds of each other, then WHOIS/ASN-lookup the IP.

### Tuning the 120-second threshold

The constant is `<= 120000` ms on line 26 of `server.js`. Chosen empirically — scanner hits in testing arrived under 5s; real human opens happened after several minutes. Raising it catches more real Gmail opens at the cost of letting slow scanners through; lowering it catches more scanners but may misclassify humans on slow connections.

### Test cases

```js
// 1. Google proxy within 120s → flagged as google_proxy
isAutomatedScanner('66.249.1.1', 'GoogleImageProxy/1.0', id, [], recentTime)
// → { viaProxy: true, scannerReason: 'google_proxy' }

// 2. Google proxy after 120s → NOT flagged (real Gmail open)
isAutomatedScanner('66.249.1.1', 'Mozilla/5.0 ...', id, [], oldTime)
// → { viaProxy: false, scannerReason: null }

// 3. Known scanner range within 120s → flagged
isAutomatedScanner('140.248.10.5', 'Mozilla/5.0', id, [], recentTime)
// → { viaProxy: true, scannerReason: 'known_scanner_range' }

// 4. Known scanner range after 120s → NOT flagged (time gate expired)
isAutomatedScanner('140.248.10.5', 'Mozilla/5.0', id, [], oldTime)
// → { viaProxy: false, scannerReason: null }

// 5. No UA at any time → flagged
isAutomatedScanner('1.2.3.4', '', id, [], oldTime)
// → { viaProxy: true, scannerReason: 'no_ua' }

// 6. Non-browser UA at any time → flagged
isAutomatedScanner('1.2.3.4', 'python-requests/2.28', id, [], oldTime)
// → { viaProxy: true, scannerReason: 'suspicious_ua' }

// 7. Rapid-fire: 2 prior opens from same IP within 60s → flagged
isAutomatedScanner('1.2.3.4', 'Mozilla/5.0', id, twoRecentOpens, oldTime)
// → { viaProxy: true, scannerReason: 'rapid_fire_scanner' }

// 8. Legitimate open: real UA, non-proxy IP, no burst → clean
isAutomatedScanner('203.0.113.5', 'Mozilla/5.0 (iPhone; ...)', id, [], oldTime)
// → { viaProxy: false, scannerReason: null }

// Fixtures: recentTime = new Date(Date.now() - 30000).toISOString()
//           oldTime    = new Date(Date.now() - 300000).toISOString()
```
