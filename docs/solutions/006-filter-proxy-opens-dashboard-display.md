---
title: "Filter proxy/scanner opens from dashboard display"
date: 2026-04-06
category: ui-bugs
problem_type: ui_bug
component: frontend_stimulus
root_cause: logic_error
resolution_type: code_fix
severity: low
tags:
  - email-tracking
  - scanner-detection
  - proxy-filtering
  - dashboard
  - display-logic
  - realOpenCount
related:
  - docs/solutions/003-scanner-detection.md
  - docs/solutions/004-scanner-detection-final.md
---

# Filter proxy/scanner opens from dashboard display

## Problem

The email tracker dashboard displayed all pixel hit events — including automated scanner and Gmail proxy hits — in the opens table and open count badge, making it impossible to distinguish real human opens from noise.

## Symptoms

- Opens table showed rows annotated with `(proxy)` mixed in with real opens
- The numeric badge on each email card showed `openCount` (all hits), inflating apparent open counts
- The top-level "Total opens" stat totalled all hits across all emails, not real opens
- Users had no clean signal of how many humans actually opened a given email

## What Didn't Work

Nothing was tried that failed — the original approach was simply wrong by design: `e.opens` was mapped over directly, annotating proxy rows inline with `(proxy)` text instead of filtering them out. The correct data was already present in the API response (`realOpenCount`, `viaProxy`) but unused in the display layer.

## Solution

Three targeted changes in `public/index.html`, plus two follow-up fixes from code review:

### 1. Extract named predicate at module level

```js
// Add near top of <script> block
const isRealOpen = o => !o.viaProxy;
```

### 2. renderStats() — global "Total opens" stat

```js
// Before
const opens = emails.reduce((s, e) => s + e.openCount, 0);

// After
const opens = emails.reduce((s, e) => s + (e.realOpenCount || 0), 0);
```

### 3. emailCard() — opens table and badge

```js
// Before
if (e.opens && e.opens.length) {
  opensHtml = `<table>...<tbody>` + e.opens.map((o, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${formatTime(o.timestamp)}</td>
      <td>${[o.city, o.country].filter(Boolean).join(', ') || 'Unknown'}${o.viaProxy ? ' <span style="color:var(--muted);font-size:10px">(proxy)</span>' : ''}</td>
      <td>${o.ip}</td>
    </tr>`).join('') + `</tbody></table>`;
}
// ...badge:
<div class="open-badge ${opened ? 'opened' : 'unopened'}">${e.openCount}</div>

// After
const realOpens = (e.opens || []).filter(isRealOpen);
if (realOpens.length) {
  opensHtml = `<table>...<tbody>` + realOpens.map((o, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${formatTime(o.timestamp)}</td>
      <td>${[o.city, o.country].filter(Boolean).join(', ') || 'Unknown'}</td>
      <td>${o.ip}</td>
    </tr>`).join('') + `</tbody></table>`;
}
// ...badge:
<div class="open-badge ${opened ? 'opened' : 'unopened'}">${e.realOpenCount ?? realOpens.length}</div>
```

The badge uses `e.realOpenCount ?? realOpens.length` as a dual-source expression: prefer the API-computed value, fall back to the locally-filtered count for old DB records that predate the `realOpenCount` field (code review finding — without this, old records would render the string `"undefined"` in the badge).

## Why This Works

The backend already does all the classification work: scanner detection sets `viaProxy: true` on every automated hit (see `docs/solutions/004-scanner-detection-final.md`), and `GET /api/emails` computes `realOpenCount` server-side as `opens.filter(o => !o.viaProxy).length`. The frontend was simply ignoring both signals and using raw `openCount` everywhere.

By filtering `opens[]` with `isRealOpen` before rendering and consuming `realOpenCount` instead of `openCount`, the display now reflects exactly the same definition of "real open" as the backend's opened-status logic — no duplication, no drift. The opens table, badge, and stats all agree.

The "Not opened yet" empty-state message is unchanged and now correctly appears for emails that have only scanner/proxy hits (since `realOpens.length === 0`).

## Prevention

**Never use `openCount` in the UI.** `openCount` is a raw hit counter retained for debugging. All user-facing display must use `realOpenCount` or compute from `opens.filter(isRealOpen)`.

**Keep the predicate at module level.** `const isRealOpen = o => !o.viaProxy` is the single definition of a real open on the frontend. If the backend definition ever expands (e.g., a new scanner strategy), update the predicate in one place.

**Guard against missing fields with `??` or `|| 0`.** When the backend adds new computed fields, old DB records won't have them. Always provide a fallback derived from raw data already in scope (e.g., `realOpens.length`) rather than defaulting to zero blindly.

**The badge count and the card's opened/unseen state must agree.** Both derive from `viaProxy === false`. If you change the opened-status definition in `server.js`, mirror the change in the frontend filter predicate.

**Key invariant:** `realOpens.length === e.realOpenCount` must hold for every email record. If these ever diverge (e.g., due to a new scanner strategy that sets `viaProxy: true` server-side without a corresponding client-side predicate update), the badge count and the table row count will disagree visibly.
