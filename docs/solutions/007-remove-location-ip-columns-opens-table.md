---
title: "Remove Location and IP columns from opens table"
date: 2026-04-06
category: ui-bugs
problem_type: ui_bug
component: frontend_stimulus
root_cause: logic_error
resolution_type: code_fix
severity: low
tags:
  - dashboard
  - opens-table
  - display-only
  - gmail
  - location
related:
  - docs/solutions/006-filter-proxy-opens-dashboard-display.md
  - docs/solutions/004-scanner-detection-final.md
---

# Remove Location and IP columns from opens table

## Problem

The email opens table displayed Location and IP columns that were misleading. Gmail routes all pixel requests through its own image proxy, so location data always reflects a Google data center (Mountain View CA, Ashburn VA), not the recipient's actual geography. IP addresses are equally meaningless for email senders.

## Symptoms

- Opens table showed four columns: `#`, `Time`, `Location`, `IP`
- Location was almost always "Mountain View, US" or "Ashburn, US" regardless of recipient's actual location
- IP values were Google infrastructure IPs, not the recipient's device
- The columns created a false impression of geographic tracking capability

## What Didn't Work

This was a direct fix with no failed attempts. The columns were added with the assumption that IP geolocation would yield recipient location — which is incorrect for Gmail-proxied tracking.

## Solution

Two changes to the opens table template in `public/index.html`:

```html
<!-- Before — thead -->
<thead><tr><th>#</th><th>Time</th><th>Location</th><th>IP</th></tr></thead>

<!-- After — thead -->
<thead><tr><th>#</th><th>Time</th></tr></thead>
```

```js
// Before — row template (4 cells)
realOpens.map((o, i) => `
  <tr>
    <td>${i + 1}</td>
    <td>${formatTime(o.timestamp)}</td>
    <td>${[o.city, o.country].filter(Boolean).join(', ') || 'Unknown'}</td>
    <td style="color:var(--muted);font-family:'IBM Plex Mono',monospace;font-size:11px">${o.ip}</td>
  </tr>`)

// After — row template (2 cells)
realOpens.map((o, i) => `
  <tr>
    <td>${i + 1}</td>
    <td>${formatTime(o.timestamp)}</td>
  </tr>`)
```

`city`, `country`, and `ip` are still stored in `db/data.json` and still returned by `GET /api/emails` — this is a display-only removal.

## Why This Works

Gmail's image proxy fetches every tracking pixel before it reaches the recipient's email client. Even opens that pass the 600-second time gate and count as real human opens (see `docs/solutions/004-scanner-detection-final.md`) originate from a Google server IP. IP geolocation of a Google server IP resolves to a Google data center, not the recipient's city. Removing the columns eliminates the false signal entirely.

## Prevention

Before adding any location or IP-derived column to the opens table, verify that pixel requests reach the server directly from the recipient's device rather than through an intermediate proxy.

In this architecture, every pixel request passes through Gmail's image proxy, making IP-derived fields (location, ISP, city, country) unreliable for recipient geography. Fields that remain accurate regardless of proxy routing — timestamp, open count, open sequence — are safe to display.

If recipient-location data is ever needed in the future, it requires a side-channel mechanism (e.g., a tracked link click with redirect, which captures a direct browser request) rather than a pixel hit.
