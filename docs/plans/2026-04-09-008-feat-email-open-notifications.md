# ET-25 — Email Open Notifications

**Date:** 2026-04-09  
**Status:** Planned  
**Scope:** `server.js`, `lib/email.js` (no schema changes, no UI)

---

## Context

When a tracked email is opened, the dashboard shows the open event. But the user has to actively check the dashboard to know. ET-25 adds a push notification: when a real (non-proxy, non-scanner) open is recorded for the first time on a given tracked email, the tracked email's owner receives a notification email via Resend.

No UI toggle. No opt-out. Applies to all users including the seed user.

---

## Research Findings

### Pixel handler flow (`server.js:93–141`)

1. `db.getEmailByTrackId.get(trackId)` — fetches the tracked email row (`track_id`, `user_id`, `subject`, `recipient`). Returns `null` for unknown trackIds; early return already handles that (line 99).
2. `db.getOpensByTrackId.all(trackId)` — fetches **all previous opens** at line 103, **before** inserting the new one. This is the correct snapshot to use for first-open detection.
3. `isAutomatedScanner()` returns `{ viaProxy, scannerReason }`. A real human open has `viaProxy === false`.
4. `db.insertOpen.run(...)` — inserts the new open at line 112.

### First-open detection

`opens` (line 103) is captured before insertion. A real open is one where `via_proxy = 0`. Therefore:

```js
const isFirstRealOpen = !viaProxy && opens.filter(o => !o.via_proxy).length === 0;
```

This condition is true exactly when: the current open is real AND there are zero previous real opens. Subsequent real opens and all proxy opens are excluded.

### Owner email lookup

`email.user_id` (from `db.getEmailByTrackId`) → `db.getUserById.get(email.user_id)` → `.email`. `getUserById` is already a prepared statement in `lib/db.js:64`.

### `lib/email.js` pattern

- Single exported async function per email type.
- Uses `fetch` against `https://api.resend.com/emails` with `Authorization: Bearer ${process.env.SMTP_PASS}`.
- `SMTP_FROM` env var sets the sender address.
- If `SMTP_PASS` is not set: logs to console and returns (no throw). This same fallback must apply to the notification function.
- Throws on non-2xx Resend response (caller must catch).

### Data available at notification time

| Field | Source |
|---|---|
| Owner email (to:) | `db.getUserById.get(email.user_id).email` |
| Tracked email subject | `email.subject` |
| Tracked email recipient | `email.recipient` |
| Open timestamp | `new Date().toISOString()` (current open) |
| City / Country | `geo.city`, `geo.country` (already computed) |

All data is in scope at the point after `db.insertOpen.run(...)`. No additional DB queries beyond one `getUserById` call.

### No schema changes needed

"First open only" is derived from the existing `opens` array, not a stored flag. Adding a `notification_sent` column would be more robust against crashes mid-send but adds migration complexity that is not warranted at this scale.

---

## Acceptance Criteria

1. When `viaProxy === false` and this is the first real open for a `trackId`, a notification email is sent to the tracked email's owner.
2. Subsequent real opens for the same `trackId` do not trigger additional notifications.
3. Proxy opens (`viaProxy === true`) never trigger notifications, regardless of open count.
4. The notification email contains: tracked email subject, recipient, open timestamp (UTC), and city/country.
5. A Resend failure (network error or non-2xx) is caught, logged, and does not affect pixel delivery — the 1x1 GIF is returned regardless.
6. If `SMTP_PASS` is not set, the notification falls back to `console.log` (same as verification email).
7. The owner user row not found (deleted account edge case) is handled gracefully — notification is skipped, no crash.
8. The seed user receives notifications identically to regular users.

---

## Implementation Steps

### Step 1 — Add `sendOpenNotification` to `lib/email.js`

Add a new exported function alongside `sendVerificationEmail`. It accepts `{ toEmail, subject, recipient, timestamp, city, country }`.

```js
async function sendOpenNotification({ toEmail, subject, recipient, timestamp, city, country }) {
  const location = [city, country].filter(Boolean).join(', ') || 'Unknown location';
  const when = new Date(timestamp).toUTCString();

  if (!process.env.SMTP_PASS) {
    console.log(`[email] Open notification (no API key) → ${toEmail}: "${subject}" opened from ${location}`);
    return;
  }

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.SMTP_PASS}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: process.env.SMTP_FROM,
      to: toEmail,
      subject: `"${subject}" was opened`,
      text: `Your tracked email was opened.\n\nSubject: ${subject}\nTo: ${recipient || '(no recipient)'}\nWhen: ${when}\nLocation: ${location}`,
      html: `
        <p>Your tracked email was opened.</p>
        <table>
          <tr><td><strong>Subject</strong></td><td>${subject}</td></tr>
          <tr><td><strong>To</strong></td><td>${recipient || '(no recipient)'}</td></tr>
          <tr><td><strong>When</strong></td><td>${when}</td></tr>
          <tr><td><strong>Location</strong></td><td>${location}</td></tr>
        </table>
        <p><a href="${BASE_URL}/app">View dashboard</a></p>
      `,
    }),
  });

  if (!res.ok) {
    const error = await res.text();
    throw new Error(`Resend API error ${res.status}: ${error}`);
  }
}

module.exports = { sendVerificationEmail, sendOpenNotification };
```

### Step 2 — Import `sendOpenNotification` in `server.js`

Update the existing import at `server.js:11`:

```js
const { sendVerificationEmail, sendOpenNotification } = require('./lib/email');
```

### Step 3 — Add first-open check and fire notification in the pixel handler

Insert immediately after `db.insertOpen.run(...)` (currently line 123), before the `patchRapidFireOpens` block:

```js
// Notify owner on first real open
const isFirstRealOpen = !viaProxy && opens.filter(o => !o.via_proxy).length === 0;
if (isFirstRealOpen) {
  const owner = db.getUserById.get(email.user_id);
  if (owner) {
    sendOpenNotification({
      toEmail: owner.email,
      subject: email.subject,
      recipient: email.recipient,
      timestamp: new Date().toISOString(),
      city: geo.city,
      country: geo.country,
    }).catch(e => console.error(`[notify] Failed to send open notification for ${trackId}:`, e.message));
  }
}
```

Fire-and-forget via `.catch()` — the pixel response is not awaited on the notification.

---

## Risks

### R1 — Double notification on rapid concurrent opens
If two real opens arrive within milliseconds (before either inserts), both would read `opens.filter(o => !o.via_proxy).length === 0` and both would fire a notification. This is a read-before-write race. Mitigation: SQLite with WAL mode processes writes serially, but the `getOpensByTrackId` read happens before the insert in the same async turn. In practice, concurrent pixel fetches for the same trackId are extremely rare and the impact (two notification emails) is low. Acceptable for this scale. A `notification_sent` boolean column on `emails` would eliminate the race entirely if it becomes a problem.

### R2 — Resend API key not configured in Railway
If `SMTP_PASS` is not set, `sendOpenNotification` logs to console and returns without sending. Pixel delivery is unaffected. This is the same behavior as `sendVerificationEmail`.

### R3 — `SMTP_FROM` domain not verified for new subdomain
`track.mangacreativestudios.com` is the new live URL but Resend's sending domain is configured separately (SPF/DKIM records). If the sending domain is not verified, Resend will reject the email. This is an environment/DNS issue, not a code issue. Notification failures are caught and logged without crashing.

### R4 — Owner account deleted between email creation and open
`db.getUserById.get(email.user_id)` returns `null` if the user was deleted. The `if (owner)` guard at Step 3 handles this — notification is silently skipped.

### R5 — Notification sent for scanner opens that slip through detection
`isAutomatedScanner` catches Google proxy IPs and rapid-fire patterns. A scanner that mimics human behavior (low frequency, non-Google IP) would not be flagged as `viaProxy` and could trigger a notification. This is an inherent limitation of scanner detection, not specific to this feature.
