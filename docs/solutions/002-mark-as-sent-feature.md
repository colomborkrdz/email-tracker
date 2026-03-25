# Solution: Mark as Sent Feature + Bug Fixes

**Date:** March 25, 2026
**Status:** Resolved ✅

---

## Problem

The dashboard had no way to distinguish between:
- Emails created but never sent (draft/test)
- Emails actually sent to a recipient but not yet opened

Everything showed as "unseen" regardless, making the open rate stat misleading (unsent drafts diluted the denominator).

## What We Built

A `sentAt` field on each email record, set via a new `PATCH /api/emails/:id` endpoint. The dashboard shows three states:

| State | Visual | Meaning |
|---|---|---|
| `○ not sent` | Gray badge + no border | Created but not marked sent |
| `● sent · unseen` | Amber badge + amber left border | Sent, recipient hasn't opened |
| `✓ opened` | Green badge + green left border | Recipient opened |

Open rate stat now uses sent emails as the denominator (not all emails).

## Bugs Found During Review (and Fixed)

### 1. `sentAt` could be nulled via the API
**Before:** `if (patch.sentAt !== undefined) db.emails[trackId].sentAt = patch.sentAt;`
Any client could send `{ sentAt: null }` to unmark an email as sent.

**After:** Validate it's a non-empty string AND a parseable date:
```js
if (patch.sentAt && typeof patch.sentAt === 'string' && !isNaN(Date.parse(patch.sentAt))) {
  db.emails[trackId].sentAt = patch.sentAt;
}
```
This also covers the security issue of arbitrary string injection.

### 2. `markSent()` had no error handling
**Before:** `await fetch(...); loadEmails();` — silent failure.

**After:**
```js
const res = await fetch(...);
if (!res.ok) { alert('Failed to mark as sent'); return; }
loadEmails();
```

### 3. Missing `.open-badge.unsent` CSS
The badge element was assigned class `unsent` but no matching CSS rule existed, leaving it unstyled.

**Fix:**
```css
.open-badge.unsent { background: var(--bg3); color: var(--muted); }
```

## Rule Going Forward

**When adding a new field to email records:**
1. Add the PATCH endpoint with strict type + value validation before writing to DB
2. Handle the three states (absent / set / interacted) in the frontend
3. Check CSS — if a new class string is interpolated into HTML, make sure a matching rule exists
4. Always handle `fetch()` failures in async UI functions

## Files Changed

- `server.js` — added `PATCH /api/emails/:id`, CORS allows `PATCH`
- `public/index.html` — `emailCard()`, `renderStats()`, `markSent()`, CSS states
