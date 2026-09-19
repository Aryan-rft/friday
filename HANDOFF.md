# Friday — handoff for opencode

Voice-first personal assistant (the "Friday loop": You → Friday → Actions →
Feedback → Friday learns → better actions). Single-server architecture: one
Express process serves both the API and the built web app; every device
(laptop + phone) is a window onto the same SQLite database, so sync is
inherent — there is nothing to merge.

## Status

- Complete and verified: **114/114 tests passing**, `npm run typecheck` clean,
  production build clean, live end-to-end loop exercised over HTTP
  (signup → goals → Hinglish voice capture → feedback → learned prefs →
  suggestions → briefings).
- All work on disk is finished; nothing is WIP or half-finished.
- `data/` (the SQLite DB) is intentionally not included — it is created on
  first run. The 24→25 mission seeder below is idempotent.

## Architecture (one process, one DB)

```
Express API (:8787)                Vite-built SPA (dist/)
├─ auth (scrypt + sessions)        ├─ voice-first dashboard
├─ /api/assistant  (brain)         ├─ floating mic on every view
├─ /api/voice      (whisper)       ├─ PWA (manifest + SW)
├─ /api/tasks|projects|goals|...   └─ offline capture queue
└─ reminder engine (20s tick)  →  web push + in-app notifications + daily briefing
SQLite (node:sqlite, WAL) — migrations run automatically on boot
```

Voice pipeline: Web Speech API → MediaRecorder → `/api/voice/transcribe`
(Whisper, optional) → NLU (deterministic rules, no key needed) or LLM tool
calls → validated action tools → SQLite. The LLM never touches the DB.

## Repo map

- `server/` — Express app: `actions/` (validated tools + Friday loop),
  `ai/` (NLU + LLM), `routes/`, `reminders/` (engine + briefing),
  `notifications/`, `db/` (migrations, seed, conn), `lib/`, `tests/`.
- `src/` — vanilla-TS SPA: `main.ts` (router/auth/shortcuts), `views.ts`,
  `components.ts` (mic FAB, capture sheet, modals), `api.ts` (client +
  offline queue), `ui.ts` (primitives + voice capture), `styles.css`.
- `public/` — PWA manifest, service worker, icons.
- `preview/` + `scripts/build-qa.mjs` — QA harness: real UI + fixture API
  shim compiled to one HTML file (dev-only; excluded from prod build).
- `scripts/seed-mission.mjs` — seeds the 24→25 mission goals + starter tasks.

## Commands

```bash
npm install
cp .env.example .env        # fill SESSION_SECRET (generator command inside)
npm run dev                 # API :8787 + web :5173 (dev)
npm test                    # 114 tests (vitest, node --experimental-sqlite)
npm run typecheck           # tsc server + web
npm run build && npm start  # production: app + API on :8787

# Optional: preload the 24→25 mission (idempotent)
node --experimental-sqlite --no-warnings --import tsx scripts/seed-mission.mjs
# Optional: rebuild the QA harness
npx vite build --config preview/vite.config.ts && node scripts/build-qa.mjs
```

## Configuration notes

- Only `SESSION_SECRET` is required. AI keys (`OPENAI_*`, `WHISPER_MODEL`)
  and push keys (`VAPID_*`) are optional — everything works without them
  (deterministic NLU; in-app + local notifications instead of web push).
- `APP_TIMEZONE` defaults to `Asia/Kolkata`; all date math is tz-aware.

## Gotchas (learned the hard way)

- **Node ≥ 22.5 with `node:sqlite`**: the DB driver is the Node builtin, not
  better-sqlite3. Vitest's Vite resolver mishandles the `node:` prefix, so
  `server/db/conn.ts` imports through `server/db/sqlite.cjs` (a one-line CJS
  shim) — keep that indirection. Run vitest via `npm test`, which passes
  `--experimental-sqlite`.
- **ESM everywhere**: relative imports end in `.js` even in `.ts` files.
- **Timezone**: tests and business logic assume `Asia/Kolkata`; test fixtures
  build times via `zonedMs`, never raw UTC arithmetic. Keep wall-clock-
  dependent fixtures pinned away from boundary times (a "due today at 14:30"
  fixture becomes overdue after 14:30 — pin such fixtures to 23:58).
- **Settings seed**: `settings.updated_at` is NOT NULL — inserts must set it
  (see `seedSettingsForUser`); `INSERT OR IGNORE` alone silently no-ops.
- **Health route order**: `/api/health` is registered before the authed
  `/api` mount so it stays public.
