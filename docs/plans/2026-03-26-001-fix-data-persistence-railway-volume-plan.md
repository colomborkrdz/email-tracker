---
title: "fix: Persist db/data.json across Railway container restarts via Volume"
type: fix
status: active
date: 2026-03-26
---

# fix: Persist db/data.json across Railway container restarts via Volume

## Overview

`db/data.json` is baked into the Docker image deployed by Railway. Every container restart or redeploy wipes it back to the repo's committed state, destroying all tracked emails and opens. The fix has two parts: a one-line code change to make the DB path configurable via `DB_PATH` env var, and a manual Railway setup step to provision a persistent Volume and point that var at it.

## Problem Frame

Railway containers are stateless — the filesystem resets on every restart or deploy. Any file written at runtime inside the image is lost. `db/data.json` is such a file. Railway Volumes are persistent disks that survive container lifecycles; mounting one at `/data` and writing the DB there solves the problem.

## Requirements Trace

- R1. Container restarts and redeployments must not reset tracked email or open data
- R2. Local development must continue to work without any Railway-specific config
- R3. The DB path must be settable without code changes (env var)

## Scope Boundaries

- Not migrating from JSON to SQLite or any other DB engine — that remains a future option noted in CLAUDE.md
- Not adding authentication or backup/export functionality
- No changes to the DB schema or any route logic

## Context & Research

### Relevant Code and Patterns

- `server.js` line 7: `const DB_PATH = path.join(__dirname, 'db', 'data.json');` — the only place the path is defined; `loadDB` and `saveDB` both consume it
- `server.js` line 197: `process.env.PORT || 3000` — established precedent for env-var-with-local-default pattern
- `loadDB` already gracefully handles a missing file (`fs.existsSync` guard) — no change needed for first-boot behavior on a fresh Volume
- `saveDB` uses `fs.writeFileSync` — works fine when the parent directory (`/data`) already exists, which it will as the Volume mount point

### Institutional Learnings

- `docs/solutions/001-fix-hardcoded-urls-railway.md`: Railway deploys expose this same class of hardcoded-vs-env-var bug; the pattern to fix it is consistent (grep for the constant, replace with env-var + fallback)

## Key Technical Decisions

- **`process.env.DB_PATH || path.join(__dirname, 'db', 'data.json')`**: Matches the `PORT` pattern already in the file; zero new dependencies; local dev requires no configuration change
- **Gitignore `db/data.json`**: The file in the repo image is now irrelevant to production — Railway reads from the Volume. Tracking it in git risks accidentally committing real recipient data and creates confusion about which file is authoritative. Gitignoring it is the right boundary.
- **No `mkdirSync` needed**: `/data` is the Volume mount point and is guaranteed to exist when the container starts on Railway. `./db/` already exists in the repo for local dev.
- **Railway Volume mount point `/data`**: Conventional, short, unambiguous. `DB_PATH` is then set to `/data/data.json` in the Railway dashboard.

## Open Questions

### Resolved During Planning

- **Does `saveDB` need to create the directory?** No — `/data` exists (Volume mount point); `./db/` exists in repo. No `mkdirSync` needed.
- **Does the existing `loadDB` handle a fresh Volume with no `data.json` yet?** Yes — `existsSync` returns false, `loadDB` returns `{ emails: {}, opens: [] }`. First write via `saveDB` creates the file.
- **Should `db/data.json` be gitignored?** Yes — see Key Technical Decisions.

### Deferred to Implementation

- None — the fix is fully specified.

## Implementation Units

- [ ] **Unit 1: Make DB path configurable via env var in `server.js`**

  **Goal:** Replace the hardcoded `DB_PATH` constant with an env-var-with-default so Railway can point it at the Volume.

  **Requirements:** R1, R2, R3

  **Dependencies:** None

  **Files:**
  - Modify: `server.js`
  - Modify: `.gitignore` (create if absent)

  **Approach:**
  - Change line 7 from the hardcoded `path.join(...)` to `process.env.DB_PATH || path.join(__dirname, 'db', 'data.json')` — one character change in effect, same constant name
  - Add `db/data.json` to `.gitignore` (and `db/*.json` as a broader guard if preferred)
  - No other changes to `loadDB`, `saveDB`, or any route — they already use `DB_PATH`

  **Patterns to follow:**
  - `process.env.PORT || 3000` on line 197 of `server.js`

  **Test scenarios:**
  - With `DB_PATH` unset: server starts, reads/writes `./db/data.json` — identical to current behavior
  - With `DB_PATH=/tmp/test.json`: server reads/writes that path; the default `./db/data.json` is untouched
  - With `DB_PATH` pointing to a path whose file doesn't exist yet: `loadDB` returns empty DB; first save creates the file

  **Verification:**
  - `DB_PATH` unset locally → all existing behavior unchanged
  - `DB_PATH=/tmp/test-data.json node server.js` → creates and reads `/tmp/test-data.json`
  - `db/data.json` listed in `.gitignore` and not tracked by git after `git rm --cached db/data.json` (if it was previously committed)

- [ ] **Unit 2: Provision Railway Volume and set env var (manual operational step)**

  **Goal:** Configure Railway so the running container writes to the persistent Volume rather than the ephemeral image filesystem.

  **Requirements:** R1, R3

  **Dependencies:** Unit 1 must be deployed first

  **Files:** None (Railway dashboard configuration)

  **Approach:**
  - In Railway dashboard → project → service → **Volumes** tab: add a Volume, mount path `/data`
  - In Railway dashboard → service → **Variables**: add `DB_PATH` = `/data/data.json`
  - Trigger a redeploy — Railway will mount the Volume at `/data` before the process starts
  - On first boot with an empty Volume, `loadDB` returns `{ emails: {}, opens: [] }` — expected

  **Verification:**
  - After redeploy: create a tracked email via the dashboard, then manually restart the service in Railway; the email must still appear after restart
  - `/data/data.json` should exist on the Volume (visible via Railway's shell or logs)

## System-Wide Impact

- **Only `DB_PATH`** (line 7) changes — `loadDB` and `saveDB` are untouched beyond consuming a now-dynamic constant
- No route logic, no API shape, no schema changes
- Local dev: zero impact — `DB_PATH` is unset, default path applies
- Production: data written during current (broken) Railway deploys is already lost on restart; this fix does not migrate or recover past data — it prevents future loss

## Risks & Dependencies

- **Existing Railway data is lost at cutover** — any emails/opens in the current ephemeral `db/data.json` will not migrate to the Volume automatically. Acceptable since restarts already lose this data today.
- **Volume must be provisioned before `DB_PATH` is set** — if `DB_PATH=/data/data.json` is set but the Volume isn't mounted, `saveDB` will fail with ENOENT. Sequence matters: Volume first, then env var, then redeploy.
- **Railway free-tier Volume availability** — confirm Railway's current plan offers Volumes. As of early 2026, Volumes are available on paid plans. If on the Hobby plan, this may require an upgrade.

## Documentation / Operational Notes

- Update CLAUDE.md: remove "JSON file DB is ephemeral on Railway" from Known Issues; add note that `DB_PATH` env var controls the DB location and Railway Volume is provisioned at `/data`
- `db/data.json` should be removed from git tracking after adding to `.gitignore`: `git rm --cached db/data.json`

## Sources & References

- Related solution: `docs/solutions/001-fix-hardcoded-urls-railway.md` (same class of hardcoded-vs-env-var bug)
- CLAUDE.md Known Issues: "JSON file DB (`data.json`) is ephemeral on Railway"
- Pattern reference: `server.js` line 197 (`process.env.PORT || 3000`)
