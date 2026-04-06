---
title: "feat: Grab-and-go pixel generation modal"
type: feat
status: completed
date: 2026-04-05
---

# feat: Grab-and-go pixel generation modal

## Overview

Redesign the "Track New Email" modal so the pixel tag is generated instantly when the modal opens — no form submission required. The pixel URL is copyable immediately. Subject and recipient become optional metadata labels shown below the pixel tag; submitting them saves to the DB but does not gate pixel creation.

## Problem Frame

The current modal requires the user to fill in subject and recipient before they can generate a pixel. This is friction for a "fire and forget" use case: the user just wants to grab a pixel tag quickly and paste it into Gmail. The form-first flow inverts the priority — the pixel is the primary artifact, subject/recipient are secondary labels for dashboard organization.

## Requirements Trace

- R1. Pixel tag is generated and visible as soon as the modal opens — no button click required.
- R2. The pixel tag and pixel URL are copyable immediately on modal open.
- R3. Subject and recipient fields remain, positioned below the pixel tag, clearly marked optional.
- R4. Submitting the optional fields saves the metadata to the DB. The pixel is already live regardless.
- R5. The modal is functional even if the user opens it, copies the pixel, and closes without filling in any labels.
- R6. Empty/unlabeled emails render correctly in the dashboard list (already works: "(no subject)" and "—").

## Scope Boundaries

- No changes to scanner detection logic or the pixel endpoint (`/pixel`).
- No changes to the `GET /api/emails` response shape or dashboard list rendering.
- No optimistic list update — the existing `loadEmails()` on "Done" is sufficient.
- The `bodyHtml` field and its textarea are removed from the modal entirely. Body composition is out of scope.
- No auto-delete of the created record if the user closes without saving labels (acceptable: leaves a "(no subject)" entry; cleanup is a future concern).
- No auth, no custom domain, no notification features.

## Context & Research

### Relevant Code and Patterns

- `public/index.html:openModal()` (~line 512) — resets form, shows `#form-area`, hides `#result-area`
- `public/index.html:createEmail()` (~line 524) — fires on submit, calls `POST /api/emails`, populates `#pixel-code` and `#full-code`
- `public/index.html` — `const API` is the base URL for all API calls and the pixel tag; this is the source of truth for what URL the modal renders (not `server.js`)
- `server.js:POST /api/emails` (~line 156) — accepts `{}`, defaults subject to `"(no subject)"`, recipient and bodyHtml to `""`, returns `{ trackId, pixelUrl }`
- `server.js` DB write pattern (~lines 163–171) — load `db`, mutate `db.emails[trackId]`, call `saveDb()`
- `public/index.html:emailCard()` (~line 483) — already renders `e.recipient || '—'` for empty recipient; no changes needed

### Institutional Learnings

- **Two URL sources**: `const API` in `index.html` controls the pixel URL shown in the UI; `NGROK_URL` in `server.js` controls the URL embedded in the DB. The POST response `pixelUrl` comes from the server — the modal should use the `pixelUrl` from the response directly (as it does today), not reconstruct it from `const API`. No change needed here.
- **CSS class discipline** (from `docs/solutions/002`): every class dynamically injected into HTML must have a matching CSS rule. After writing new modal HTML, grep every injected class name to confirm a rule exists.
- **fetch() error handling** (from `docs/solutions/002`): every `fetch()` in the UI must have an `if (!res.ok)` guard with user-visible feedback. The initial POST at modal-open is especially important — a silent failure would leave the user staring at a loading state with no pixel.

### External References

None needed — all patterns established locally.

## Key Technical Decisions

- **Pixel is created at modal open, not on submit**: `openModal()` immediately calls `POST /api/emails` with an empty body. This is safe because the endpoint already accepts `{}` and a "(no subject)" record is a valid, harmless state.
- **New `PATCH /api/emails/:id` endpoint for metadata**: The optional subject/recipient form submits via PATCH after the pixel is already created. An alternative (re-POST with subject/recipient) was rejected because it would create a second record.
- **bodyHtml removed entirely**: Under the new flow the user copies the pixel tag directly; there is no email body composition step. The field is removed from the modal and not submitted to the API. Existing records in `data.json` that have `bodyHtml` are unaffected.
- **Loading state on modal open**: The modal should show a "Generating..." placeholder while the initial POST is in flight. If the POST fails, show an error with a retry button rather than silently stalling.
- **"Done" auto-saves labels if filled in**: Instead of a separate "Save" button, clicking "Done" checks if subject or recipient have been filled in and, if so, fires the PATCH before closing. This is the lowest-friction path: one action closes and saves.

## Open Questions

### Resolved During Planning

- *Should we delete the email if the user closes without filling in labels?* No — "(no subject)" records are valid and the dashboard handles them. Cleanup is a future concern.
- *Should bodyHtml be kept as an advanced field?* No — it was only useful when the modal composed a full email body. That concept is removed by this UX.
- *Where does the pixel URL come from in the new flow?* From the `pixelUrl` field in the POST response — same as today. No change needed.

### Deferred to Implementation

- Exact wording for the "Generating..." placeholder and error state copy.
- Whether "Done" silently fires PATCH or shows a brief "Saved" confirmation before closing.

## Implementation Units

- [ ] **Unit 1: Add PATCH /api/emails/:id endpoint**

**Goal:** Allow subject and recipient to be updated on an existing email record after the pixel has been created.

**Requirements:** R4

**Dependencies:** None

**Files:**
- Modify: `server.js`

**Approach:**
- Add a route handler for `PATCH /api/emails/:id` alongside the existing `DELETE /api/emails/:id` handler
- Extract `trackId` from the URL path (same pattern as DELETE)
- Parse the request body for `subject` and `recipient`; trim whitespace on both
- Validate: the record must exist in `db.emails`; both fields must be strings (reject nulls)
- Update only the fields provided — do not overwrite `createdAt`, `bodyHtml`, or `trackId`
- Respond `200 { ok: true }` on success; `404` if trackId not found; `400` for invalid payload
- Use the existing `saveDb()` pattern

**Patterns to follow:**
- `DELETE /api/emails/:id` handler for URL parsing and 404 handling
- Lines 163–171 for the load → mutate → save DB pattern

**Test scenarios:**
- PATCH with subject only updates subject, leaves recipient unchanged
- PATCH with recipient only updates recipient, leaves subject unchanged
- PATCH on a non-existent trackId returns 404
- PATCH with a non-string value is rejected with 400
- PATCH does not overwrite `createdAt` or `trackId`

**Verification:**
- `curl -X PATCH .../api/emails/<id> -d '{"subject":"Test"}'` returns `{ ok: true }` and the record in `data.json` shows the updated subject
- `GET /api/emails` reflects the updated subject/recipient

---

- [ ] **Unit 2: Redesign Track New Email modal**

**Goal:** Instant pixel generation on modal open; subject/recipient as optional post-open metadata; "Done" saves labels if present.

**Requirements:** R1, R2, R3, R4, R5

**Dependencies:** Unit 1 (PATCH endpoint must exist before "Done" can save labels)

**Files:**
- Modify: `public/index.html`
- Test: manual browser verification (no automated test file exists in this project)

**Approach:**

*Modal open (`openModal()`):*
- Set a module-level `_pendingTrackId = null` variable to hold the trackId for the session
- Show modal immediately with a "Generating your pixel..." loading state in the pixel display area
- Fire `POST /api/emails` with `{}` (empty body)
- On success: store `trackId` in `_pendingTrackId`, build the `<img>` pixel tag from `pixelUrl`, populate the pixel display and copy button
- On failure: show an inline error with a "Retry" button that re-fires the POST

*Modal layout (new structure):*
- Top section: pixel tag display (pre/code block) + "Copy pixel tag" button — visible immediately after POST resolves
- Below that: optional labels section — "Add labels (optional)" heading, subject input, recipient input
- Bottom: "Done" button

*"Done" button (`closeModal` + conditional PATCH):*
- If `_pendingTrackId` is set AND either subject or recipient input has a non-empty value:
  - Fire `PATCH /api/emails/_pendingTrackId` with `{ subject, recipient }`
  - Wait for response, then close and call `loadEmails()`
- Otherwise: close and call `loadEmails()` immediately
- Reset `_pendingTrackId = null` on close

*Removed:*
- The `bodyHtml` textarea and all references to `#full-code` / `window._lastFullCode` in the modal flow
- The old "Generate pixel" submit button
- The `#form-area` / `#result-area` two-panel swap — replaced by a single unified layout

**CSS discipline checklist (from institutional learnings):**
- After writing new modal HTML, grep for every dynamically injected class name (e.g., `.pixel-loading`, `.pixel-error`) and confirm a CSS rule exists in the `<style>` block

**fetch() error handling checklist:**
- Initial POST: `if (!res.ok)` → show retry UI
- PATCH in Done: `if (!res.ok)` → show inline error, do not close modal

**Patterns to follow:**
- Existing modal overlay CSS and `.visible` toggle pattern
- Existing copy-to-clipboard pattern (used for pixel tag today)
- `loadEmails()` call pattern after modal actions

**Test scenarios:**
- Modal opens → loading state appears → pixel tag populates within ~1s
- Copy button copies the `<img>` tag to clipboard
- Subject and recipient fields are present but not required
- Typing in subject and clicking Done → PATCH fires and `GET /api/emails` shows the updated subject
- Clicking Done with empty labels → no PATCH, modal closes cleanly
- POST fails on open → error message with Retry button appears; retry succeeds and shows pixel tag
- PATCH fails on Done → error shown, modal stays open

**Verification:**
- Open modal → pixel tag visible without any interaction
- Copy pixel tag → paste into text editor → valid `<img src="https://...pixel?id=...">` tag
- Add subject "Test email", click Done → dashboard list shows "Test email"
- Open modal, copy pixel, close without typing → dashboard shows "(no subject)" entry
- No "(no subject)" entries are created from the old form-submit path (that path is gone)

## System-Wide Impact

- **Interaction graph:** `openModal()` now has a side effect (creates a DB record) rather than being purely a UI toggle. Any other call sites of `openModal()` (there is currently one: the header button) will trigger a POST on invocation.
- **Error propagation:** If the initial POST fails, the modal must not silently appear empty — the loading/error state must be explicit.
- **State lifecycle risks:** If the user opens the modal multiple times rapidly (e.g., double-clicks the button), multiple records could be created. Mitigate by disabling the "Track New Email" button while the modal is open.
- **API surface parity:** No agent/API surface changes beyond adding PATCH — the pixel endpoint and GET endpoint are untouched.
- **Integration coverage:** The "Done with no labels" path leaves a "(no subject)" record — verify in the dashboard list that it renders correctly (already confirmed it does).

## Risks & Dependencies

- **Orphan records**: Users who open the modal and immediately close (without copying the pixel) will create "(no subject)" placeholder records. This is low-risk for a solo-use tool but worth noting for a future cleanup feature.
- **No automated tests**: This project has no test suite — all verification is manual. The PATCH endpoint and modal behavior must be verified via browser + curl.

## Sources & References

- Related code: `server.js` lines 156–194 (POST + GET /api/emails, DB write pattern)
- Related code: `public/index.html` openModal(), createEmail(), closeModal() functions
- Institutional learning: `docs/solutions/001-fix-hardcoded-urls-railway.md` (URL source of truth)
- Institutional learning: `docs/solutions/002-mark-as-sent-feature.md` (CSS class discipline, fetch error handling)
