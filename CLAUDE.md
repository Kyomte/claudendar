# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install              # install dependencies
npm run dev              # tsx watch — hot-reload local dev (requires .env)
npm start                # tsx — run once locally
npm run build            # tsc → ./dist
npx tsc --noEmit         # type-check only (use this to validate before deploy)
fly deploy               # build Docker image + push to Fly (uses fly.toml)
fly logs                 # tail the running bot
fly secrets set FOO=bar  # set/update a runtime secret (auto-redeploys)
```

There are **no unit tests** in this repo — validation is `npx tsc --noEmit` plus manual end-to-end via Telegram against a real iCloud account.

## Architecture

```
Telegram message
   └─► bot.ts          per-chat auth + in-memory MessageParam[] history Map
        └─► claude.ts  agentic tool-use loop with exponential backoff on 5xx/529
             └─► tools/dispatcher.ts  routes Anthropic tool_use blocks → impls
                  ├─► tools/calendar.ts   VEVENT ops (events)
                  └─► tools/reminders.ts  VTODO ops (Apple Reminders tasks)
                       └─► tools/caldav.ts  shared DAV client + collection discovery (cached)
                            └─► caldav.icloud.com  (iCloud CalDAV)
```

The bot is a single Node process using **Telegram long-polling** (Telegraf). It exposes no HTTP port — cloud deploys need outbound internet only, no public URL.

### Agentic loop (src/claude.ts)

`processMessage(text, history)` runs up to `MAX_TOOL_ROUNDS` (8) iterations of `messages.create`. On each round:
- `stop_reason === 'end_turn'` → extract text blocks, return
- `stop_reason === 'tool_use'` → execute all tool_use blocks **in parallel** via `Promise.all`, append the assistant turn (with tool_use blocks) and a single user turn containing all `tool_result` blocks, loop
- Tool errors are caught and returned as `is_error: true` tool_result strings so Claude can recover gracefully without crashing the turn
- Every Anthropic call is wrapped in `callWithBackoff` (retries 529/503/502/500 with `1s → 2s → 4s → 8s → 15s` + jitter, max 6 attempts). The SDK's own `maxRetries: 5` runs on top of this

The system prompt is rebuilt per-message via `buildSystemPrompt()` so today's date, the user's timezone, and the live calendar/reminder-list names are always fresh. List names come from `getCalendarNames()` / `getReminderListNames()` in caldav.ts (cached after first call).

### Opaque UID handles

Tools expose `event_uid` / `reminder_uid` to Claude. These are **base64url of the CalDAV object URL** (e.g. `https://p36-caldav.icloud.com/.../calendars/<calendar-uuid>/<event-uuid>.ics`). This means:

- Update/delete don't need a second lookup to map UID → URL
- `findCalendarForObjectUrl()` resolves any handle to the owning collection via prefix match — works uniformly for events and reminders since both go through the same calendars
- `createCalendarObject` doesn't return the URL, so we construct it as `<calendar.url><filename>.ics` — that pattern is iCloud-specific behavior and could break on other CalDAV servers

### Timezone discipline

The user's wall-clock timezone comes from `USER_TIMEZONE` (IANA name, e.g. `Asia/Tokyo`). Tools accept ISO 8601 **local-time-without-offset** strings (e.g. `2026-06-15T14:30:00`) — never Z/UTC. Conversion is done via luxon in calendar.ts / reminders.ts:

- `parseLocalToUTC(iso)` — interprets the string in `USER_TIMEZONE` and returns a UTC `Date`
- `utcToLocalIso(date)` — formats a UTC `Date` back to local wall-clock for display

CalDAV/iCloud always stores in UTC (`...Z` form via `ICAL.Time.fromJSDate(date, true)` — second arg = `useUTC`).

### Events vs Reminders — important semantic split

The system prompt in `buildSystemPrompt()` instructs Claude to **default "remind me to ..." to a calendar event with `reminder_minutes_before: [0]`, not a VTODO**. Reason: iCloud has two parallel reminder backends (legacy CalDAV vs modern CloudKit), and writes to the CalDAV one don't always surface in the modern Reminders app. VTODO support exists in `reminders.ts` and is wired into `definitions.ts`, but Claude should only use it when the user explicitly references Reminders / a task list.

When editing the system prompt, preserve the EVENTS-vs-REMINDERS section — removing or weakening it will silently regress this UX.

### Update ordering invariant

In `updateCalendarEvent`, **never set start_date before end_date**. If the new start is after the current end (e.g. moving an event later), Calendar will reject the intermediate state. The current code builds a fresh ICS with both new values atomically via `buildIcs`, avoiding the issue — but if you ever switch to a property-by-property update via AppleScript or PATCH semantics, set end first.

### Auth + history (src/bot.ts)

- `ALLOWED_CHAT_IDS` (comma-separated Telegram chat IDs) is the **only** authorization layer. If unset, the bot logs `[auth] Open mode` and accepts anyone — fine for first-run discovery, not for production
- History is a per-chat `Map<chatId, MessageParam[]>` in process memory — restart wipes it. `/clear` wipes a single chat
- After each turn, history is trimmed to `MAX_HISTORY_MESSAGES` (default 20). The trim helper guarantees the first surviving message has `role: 'user'` (Anthropic API requirement)

## Deploy notes

- Production runs on Fly under app name `claudendar` (template) — `fly.toml` defines a single small VM with no HTTP service and a standby machine for crash recovery
- The Dockerfile is multi-stage: build with `tsc`, runtime is `node dist/index.js` under `tini` for clean SIGTERM handling
- `CLAUDE_MODEL` (env) controls which Anthropic model is used; defaults to `claude-sonnet-4-6` in code. Haiku is significantly cheaper and adequate for this workload
