---
title: "fix: Remove location and IP columns from opens table"
type: fix
status: completed
date: 2026-04-06
---

# fix: Remove location and IP columns from opens table

## Overview

The opens table currently shows four columns: `#`, `Time`, `Location`, `IP`. Location data for real opens often reflects Gmail data centers rather than the recipient's actual location, providing zero useful signal. IP is noise for end users. Reducing the table to `#` and `Time` only makes the display cleaner and more accurate.

## Problem Frame

Even after filtering proxy rows (see `docs/solutions/006-filter-proxy-opens-dashboard-display.md`), the Location and IP columns add clutter without actionable value:
- Location is unreliable — Gmail mobile routes opens through regional data centers, not the recipient's actual city
- IP is meaningless to an email sender with no network context

## Requirements Trace

- R1. Opens table displays only `#` and `Time` columns.
- R2. No changes to DB, API, or server logic.
- R3. Location and IP data remain in the DB and API response — display only.

## Scope Boundaries

- No server-side changes.
- No changes to `e.locations` sub-header (shows location badges on the card header row — separate concern, separate field).
- No changes to how data is stored or returned.

## Context & Research

### Relevant Code

- **`public/index.html:496`** — `<thead><tr><th>#</th><th>Time</th><th>Location</th><th>IP</th></tr></thead>`
- **`public/index.html:499-502`** — four `<td>` cells per row: `i+1`, `formatTime`, city/country join, ip
- **`public/index.html:216`** — `.opens-table td:first-child` styles the `#` cell with mono accent color — this remains correct after removal since `#` is still first

## Implementation Units

- [ ] **Unit 1: Remove Location and IP columns**

**Goal:** Opens table shows only `#` and `Time`.

**Requirements:** R1, R2, R3

**Dependencies:** None

**Files:**
- Modify: `public/index.html`

**Approach:**
- In the `<thead>`, remove `<th>Location</th><th>IP</th>`
- In the `<tbody>` row template, remove the two `<td>` cells for location and IP (lines 501–502)
- No CSS changes needed — the table naturally reflows to two columns

**Test scenarios:**
- Email with 1+ real opens → table shows exactly two columns: `#` and `Time`
- Multiple opens → rows numbered correctly, timestamps formatted correctly
- Empty opens → "Not opened yet" message unchanged

**Verification:**
- Open a card in the browser — table has two columns only, no Location or IP visible

## Risks & Dependencies

- None. Purely additive removal in a single template string.
