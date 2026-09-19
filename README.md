# Friday 🎙️ — Your Voice-First Personal Assistant

> **"I tell it things, and it takes care of remembering them."**

Friday is a personal executive assistant you talk to. Speak naturally — in English or Hinglish — and it captures tasks, sets deadlines, prioritizes, tracks follow-ups, reminds you at the right time, and learns from your feedback. It runs on **one server** (your laptop) so your phone and laptop are always perfectly in sync.

---

## The loop

```
You → Friday → Actions → Feedback → Friday learns → better actions
```

- **Tell it anything** — "Kal KUK mein twelve thirty wali lecture ke liye slides check karni hain", "Follow up with the outreach team Friday", "Remind me tomorrow at 10 to call the CEO".
- **It manages tasks** — auto project, auto priority, auto reminders, follow-up records, overdue escalation.
- **Goals** — "My goal is to build the business this year" → broken into concrete, linked tasks with progress tracking.
- **It proactively suggests** — overdue items, deadlines without reminders, follow-ups due, neglected inbox work, stale goals.
- **You give feedback — it learns**:
  - *"That reminder was too early"* → this reminder moves, and future ones shift too (learned bias).
  - *"Don't suggest this"* → it stops. Repeated mutes make it less pushy overall.
  - *"I prefer doing this at night"* → remembers your preferred work hour.
  - *"This isn't important anymore"* → demotes priority.
  - *"Make this task smaller"* → splits it into concrete steps.

## Quick start

```bash
npm install
cp .env.example .env      # fill in SESSION_SECRET (command inside); AI keys optional
npm run dev               # API on :8787 + web on :5173
```

Open **http://localhost:5173**, create your account, and talk to Friday.

### Seed the 24→25 mission

To start with the full mission pre-loaded as goals (Build Money, Business, Expertise, Purpose, Health, Relationships, Life — each broken into concrete starter tasks):

```bash
node --experimental-sqlite --no-warnings --import tsx scripts/seed-mission.mjs
```

It's idempotent — rerunning never duplicates. Use `FRIDAY_EMAIL` / `FRIDAY_PASSWORD` env vars to attach it to a specific account.

### Production / phone use

```bash
npm run build             # builds web app into dist/
npm start                 # serves API + app on :8787
```

Then from your phone on the **same Wi-Fi**, open `http://<laptop-ip>:8787`.
Find the IP with `ipconfig` (Windows) or `ipconfig getifaddr en0` (macOS).

> **Sync model:** there is exactly one server and one database. Every device is a
> window onto the same data — anything captured anywhere appears everywhere
> instantly. Nothing lives only on the phone.

**On the phone:** open the site → *Share* → *Add to Home Screen*. Friday installs as an app with its own icon, full-screen UI, and (with notifications enabled) push reminders.

## Daily briefing

Every morning at your **brief_time** (Settings → Rhythm, default 08:00 IST), the server composes your day from real data — what's due (with times), what's overdue, who you're waiting on, and the one thing to start with — and delivers it to every device: as a web push if configured, and always as an in-app notification that open tabs surface automatically. It fires once per day in your timezone, catches up if the server boots late (3h window), and honors brief_time changes instantly.

## Configuration

See `.env.example`. Everything works with no keys:

| Variable | Purpose | Without it |
|---|---|---|
| `SESSION_SECRET` | Signs auth sessions | insecure dev default |
| `OPENAI_API_KEY` / `OPENAI_BASE_URL` / `OPENAI_MODEL` | LLM interpretation (any OpenAI-compatible API) | deterministic built-in NLU (English + Hinglish) is used |
| `WHISPER_MODEL` | Server voice transcription | browser speech recognition (Chrome/Edge/Android/Safari) |
| `VAPID_*` | Web push notifications | in-app reminders + local notifications still work |
| `APP_TIMEZONE` | All date math (default `Asia/Kolkata`) | — |

## Architecture

```
┌────────────────────────── one process ──────────────────────────┐
│  Express API (:8787)              Vite-built SPA (dist/)        │
│  ├─ auth (scrypt + sessions)      ├─ voice-first dashboard      │
│  ├─ /api/assistant  (brain)       ├─ floating mic on every view │
│  ├─ /api/voice      (whisper)     ├─ PWA (manifest + SW)        │
│  ├─ /api/tasks|projects|goals|... └─ offline capture queue       │
│  └─ reminder engine (20s tick + web push)                       │
├──────────────────────────────────────────────────────────────────┤
│  SQLite (node:sqlite, WAL) — migrations, single file on disk     │
└──────────────────────────────────────────────────────────────────┘
```

**Voice pipeline:** Web Speech API (live, low-latency, en-IN/hi-IN) → fallback MediaRecorder → `/api/voice/transcribe` (Whisper) → NLU/LLM interpretation → validated action tools → SQLite. The mic is always one tap away (floating button on every screen, `V` shortcut on desktop); typing is always the fallback when voice fails — and the UI says so honestly.

**AI action system:** the LLM never touches the DB. It emits structured tool calls (`create_task`, `complete_task`, `reschedule_task`, `create_reminder`, `create_follow_up`, `create_goal`, `breakdown_task`, `record_feedback`, …), each validated server-side before execution. With no API key, a deterministic rules engine runs the same tools.

**Learning:** feedback rows → `learned_prefs` (evidence-weighted) → reminder bias, suggestion pushiness, preferred hours. All inspectable in Settings → "What Friday learned about you".

## Database

Tables: `users`, `sessions`, `projects`, `tasks`, `subtasks`, `goals`, `goal_tasks`, `reminders`, `follow_ups`, `feedback`, `learned_prefs`, `suggestion_state`, `conversations`, `messages`, `memories`, `notifications`, `push_subscriptions`, `activity_log`, `settings`. Migrations run automatically on boot.

## Tests

```bash
npm test        # 114 tests: dates, priority, NLU, briefing, Friday loop (goals, feedback, suggestions, e2e HTTP)
npm run typecheck
```

## Keyboard shortcuts

`V` voice · `N` new task · `T` today · `U` urgent · `D` dashboard · `A` assistant · `?` help

## Honest limitations

- Voice input needs Chrome/Edge/Safari (Web Speech) or a configured Whisper key for other browsers.
- Web push requires HTTPS (or localhost) and VAPID keys; without it, reminders are in-app + local notifications on that device.
- Phone access uses your laptop's LAN IP — no internet exposure, which is also why it's private by default.
- The rules-mode NLU is strong on the patterns it knows (dates, times, Hinglish postpositions, common verbs); with an LLM key, coverage broadens to arbitrary phrasing.

## Dev extras (safe to ignore at runtime)

- `preview/` + `scripts/build-qa.mjs` — a QA harness: the real UI with a fixture API shim, compiled to one HTML file for visual/interaction checks. Build with `npx vite build --config preview/vite.config.ts && node scripts/build-qa.mjs`.
- `scripts/seed-mission.mjs` — idempotent seeder for the 24→25 mission goals (see above).
- The first run creates `data/` and the SQLite database automatically.
