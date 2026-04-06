---
title: "fix: Hide proxy/scanner opens from dashboard display"
type: fix
status: completed
date: 2026-04-06
---

# fix: Hide proxy/scanner opens from dashboard display

## Overview

The opens table in the dashboard currently shows all open records including scanner and Gmail proxy hits. This is noisy and misleading — users see rows labelled "(proxy)" that inflate the apparent open count and obscure real human opens. This fix makes the display show only real opens (`viaProxy === false`) while leaving all data intact in the DB.

## Problem Frame

Three places in `public/index.html` currently use raw `openCount` (all opens) or unfiltered `e.opens` arrays:
1. The opens table renders every record including scanner/proxy rows.
2. The open-count badge on each email card shows `e.openCount` (all opens).
3. The "Total opens" stat card sums `e.openCount` across all emails.

All three should reflect real opens only (`realOpenCount` / `viaProxy === false`). Scanner data stays in the DB untouched — this is a display-only fix.

## Requirements Trace

- R1. Opens table displays only rows where `viaProxy === false`.
- R2. Open-count badge on each card shows `realOpenCount`.
- R3. "Total opens" stat shows sum of `realOpenCount` across all emails.
- R4. No changes to server, DB, or API response shape.
- R5. If an email has proxy/scanner hits but zero real opens, the table shows "Not opened yet".

## Scope Boundaries

- No server-side changes.
- No changes to how `viaProxy` or `scannerReason` is stored or returned.
- The `stat-rate` calculation already uses `realOpenCount > 0` — no change needed there.
- The `has-opens` card class and tag state already use `realOpenCount > 0` — no change needed there.

## Context & Research

### Relevant Code and Patterns

- **`public/index.html:466-474`** — `renderStats()`: computes stat-opens as `emails.reduce((s, e) => s + e.openCount, 0)`
- **`public/index.html:485-531`** — `emailCard()`: builds card HTML
  - Line 493–504: maps over `e.opens` without filtering; renders all rows including proxy
  - Line 510: badge shows `e.openCount`
- **`public/index.html:499`**: proxy rows currently annotated with inline `(proxy)` span — this annotation will become unnecessary once proxy rows are hidden
- API already returns both `openCount` (all) and `realOpenCount` (non-proxy) per email, and each open record includes `viaProxy: boolean`

### Institutional Learnings

- CLAUDE.md: `realOpenCount` is non-proxy opens; `openCount` is all opens. Email status (unseen/opened) is already gated on `realOpenCount > 0`.

## Key Technical Decisions

- **Filter at render time, not at fetch time**: filter `e.opens` inside `emailCard()` to a local `realOpens` array, then render from that. This keeps the raw data available if needed later (e.g., a future "show all" toggle).
- **Badge uses `realOpenCount` from API response**: no need to derive it from the filtered array — the API already provides it.
- **"Not opened yet" fallback**: the existing `else` branch on `e.opens.length` already handles empty arrays; after filtering, if `realOpens.length === 0` it will correctly show this message, even if the email has proxy hits.

## Implementation Units

- [ ] **Unit 1: Filter opens table to real opens only**

**Goal:** Opens table shows only `viaProxy === false` rows; proxy/scanner rows are hidden.

**Requirements:** R1, R5

**Dependencies:** None

**Files:**
- Modify: `public/index.html`

**Approach:**
- In `emailCard()`, before building the table, derive `const realOpens = (e.opens || []).filter(o => !o.viaProxy)`
- Replace the `e.opens.map(...)` with `realOpens.map(...)` for the `<tbody>` rows
- Replace the guard `if (e.opens && e.opens.length)` with `if (realOpens.length)`
- Remove the inline `(proxy)` annotation span from the location cell — it is no longer needed since proxy rows are hidden

**Patterns to follow:**
- Existing `e.opens.map((o, i) => ...)` row rendering pattern at `index.html:495–501`

**Test scenarios:**
- Email with 2 real opens and 1 proxy open → table shows 2 rows, no "(proxy)" annotation
- Email with only proxy/scanner opens → table shows "Not opened yet"
- Email with zero opens → table shows "Not opened yet" (unchanged)
- Email with only real opens → table shows all rows (unchanged behavior)

**Verification:**
- Open a tracked email card in the browser; only non-proxy rows appear in the opens table
- An email with only scanner hits shows "Not opened yet" in the detail panel

---

- [ ] **Unit 2: Update open-count badge to show `realOpenCount`**

**Goal:** The badge on each email card shows the real open count, not total-including-scanners.

**Requirements:** R2

**Dependencies:** None (can land with Unit 1 in the same edit)

**Files:**
- Modify: `public/index.html`

**Approach:**
- In `emailCard()`, change the badge from `e.openCount` to `e.realOpenCount` (line ~510)

**Test scenarios:**
- Email with 3 proxy hits and 1 real open → badge shows `1`
- Email with no opens → badge shows `0`
- Email with 2 real opens and no proxy hits → badge shows `2` (unchanged)

**Verification:**
- Badge value matches the count of rows visible in the opens table

---

- [ ] **Unit 3: Update "Total opens" stat to sum `realOpenCount`**

**Goal:** The top stat card "Total opens" reflects only real human opens.

**Requirements:** R3

**Dependencies:** None (can land with Units 1 and 2 in the same edit)

**Files:**
- Modify: `public/index.html`

**Approach:**
- In `renderStats()`, change `emails.reduce((s, e) => s + e.openCount, 0)` to `emails.reduce((s, e) => s + (e.realOpenCount || 0), 0)`

**Test scenarios:**
- Mix of emails where some have proxy-only hits → stat reflects only real opens across all emails
- All emails unopened → stat shows `0`
- No proxy hits in data → stat value unchanged from before

**Verification:**
- Stat card total equals the sum of badge values visible across all email cards

## Risks & Dependencies

- Low risk: all changes are local to `public/index.html`, pure JS render logic, no API contract changes.
- `realOpenCount` is already present in the API response — no schema dependency risk.
- The `|| 0` guard in Unit 3 defends against any edge-case emails missing `realOpenCount` (e.g. old records).

## Sources & References

- Related code: `public/index.html` — `renderStats()`, `emailCard()`
- CLAUDE.md: Email Status States section
