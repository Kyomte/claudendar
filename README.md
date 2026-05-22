# Claudendar

A Telegram bot that lets you manage your Apple Calendar and Apple Reminders by chatting in plain English. Runs in the cloud so it works even when your Mac is off — events sync to all your Apple devices via iCloud CalDAV.

> *"Schedule a coffee chat tomorrow at 3pm at Blue Bottle for 30 minutes, remind me 15 minutes before"*
>
> → New event appears in Apple Calendar on every device within seconds.

## Features

- **Natural-language scheduling** — talk to it like a person, no forms or commands.
- **Multi-calendar aware** — picks the right calendar from context (gym → Workouts, class → School, meeting → Work).
- **Event alerts** — sets VALARM alarms ("remind me 1 hour before").
- **Locations** — addresses get geocoded by Apple Calendar for directions.
- **Apple Reminders support** — can create/list/complete tasks (with caveats — see [Apple Reminders Limitations](#apple-reminders-limitations)).
- **Conversation memory** — follow-ups like *"actually move it to 4pm"* just work.
- **Whitelist auth** — only your Telegram chat IDs can use it.

## Architecture

```
Telegram ⇄ Bot (Telegraf, long-polling) ⇄ Claude (tool use) ⇄ iCloud CalDAV
                                                                    │
                                                                    ▼
                                                          Apple Calendar / Reminders
                                                       (syncs to all your devices)
```

- **Long-polling** means no public URL or webhook is needed — the bot just needs outbound internet.
- Runs anywhere Docker runs: Fly.io, a VPS, a Raspberry Pi, etc.

## Prerequisites

| What | Where |
|---|---|
| **Telegram bot token** | [@BotFather](https://t.me/BotFather) → `/newbot` |
| **Anthropic API key** | [console.anthropic.com](https://console.anthropic.com) — add a few dollars of credit |
| **iCloud app-specific password** | [appleid.apple.com](https://appleid.apple.com) → *Sign-In and Security* → *App-Specific Passwords* |
| **Your IANA timezone** | e.g. `America/Los_Angeles`, `Europe/London`, `Asia/Tokyo` |

> ⚠️ The iCloud password must be an **app-specific password**, not your normal Apple ID password.

## Quick Start (Local)

```bash
git clone <this-repo>
cd claudendar
npm install
cp .env.example .env
# Edit .env and fill in your tokens
npm run dev
```

The bot will start polling Telegram. Send any message to your bot — the console will log your Telegram chat ID. Add it to `ALLOWED_CHAT_IDS` in `.env` and restart so only you can use the bot.

## Deploy to Fly.io

Fly is the recommended host. A single small VM (256 MB shared-CPU) is plenty.

```bash
brew install flyctl
fly auth signup   # or `fly auth login`

# Edit fly.toml first — pick a globally-unique app name and your preferred region
fly apps create <your-app-name>

fly secrets set \
  TELEGRAM_BOT_TOKEN='...' \
  ANTHROPIC_API_KEY='...' \
  ICLOUD_USERNAME='you@icloud.com' \
  ICLOUD_APP_PASSWORD='xxxx-xxxx-xxxx-xxxx' \
  USER_TIMEZONE='America/Los_Angeles' \
  ALLOWED_CHAT_IDS=''   # leave empty for the first run

fly deploy
fly logs
```

Send your bot a message in Telegram. Find your chat ID in the logs (`[auth] Open mode — message from chat 123456789`), then lock it down:

```bash
fly secrets set ALLOWED_CHAT_IDS='123456789'
```

Fly will auto-redeploy.

> Fly now requires a payment method on file before creating apps, even for the free tier. The Hobby plan still covers a small always-on machine for free.

## Deploy with Docker (any host)

```bash
docker build -t claudendar .
docker run -d --restart unless-stopped --name claudendar \
  -e TELEGRAM_BOT_TOKEN='...' \
  -e ANTHROPIC_API_KEY='...' \
  -e ICLOUD_USERNAME='you@icloud.com' \
  -e ICLOUD_APP_PASSWORD='xxxx-xxxx-xxxx-xxxx' \
  -e USER_TIMEZONE='America/Los_Angeles' \
  -e ALLOWED_CHAT_IDS='123456789' \
  claudendar
```

Works on Hetzner, DigitalOcean, Oracle Cloud Always Free, a Raspberry Pi at home — anywhere Docker runs.

## Configuration

All configuration is via environment variables (loaded from `.env` locally or set as secrets in production).

| Variable | Required | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | yes | From @BotFather |
| `ANTHROPIC_API_KEY` | yes | From console.anthropic.com |
| `ICLOUD_USERNAME` | yes | Your Apple ID email |
| `ICLOUD_APP_PASSWORD` | yes | App-specific password (NOT your normal Apple ID password) |
| `USER_TIMEZONE` | yes | IANA name, e.g. `America/Los_Angeles` |
| `ALLOWED_CHAT_IDS` | recommended | Comma-separated Telegram chat IDs allowed to use the bot |
| `ICLOUD_CALENDAR_NAME` | optional | Default calendar for new events. Defaults to first writable. |
| `ICLOUD_REMINDER_LIST_NAME` | optional | Default reminder list. Defaults to first. |
| `MAX_HISTORY_MESSAGES` | optional | Conversation history cap per chat. Default `20`. |

## Telegram Commands

- `/start` — welcome message
- `/clear` — reset conversation history for the current chat
- Anything else — Claude routes it through calendar / reminder tools

## Example Conversations

```
You: What's on my calendar today?
Bot: You have 2 events today:
     • 10:00 AM – 10:30 AM  Daily standup  (Work)
     • 4:00 PM – 5:00 PM    Leg day        (Workouts) — alarm 15 min before
```

```
You: Schedule lunch with mom Sunday at 1pm at Sushi Zanmai Shibuya, remind me an hour before
Bot: Added lunch with mom to Personal — Sun May 24, 1:00 PM–2:00 PM at Sushi Zanmai Shibuya
     with a 1-hour alert. ✅
```

```
You: Move my dentist appointment to 11am
Bot: Moved "Dentist" to 11:00 AM – 12:00 PM on Friday.
```

```
You: Remind me to text the landlord at 8pm
Bot: Set a calendar event "Text the landlord" at 8:00 PM with an alarm at start. ✅
```

## Project Structure

```
src/
├── index.ts                 # Entry: env validation + bot launch
├── bot.ts                   # Telegraf setup, auth, history, commands
├── claude.ts                # Anthropic SDK agentic tool-use loop with backoff
└── tools/
    ├── definitions.ts       # Tool JSON schemas for Claude
    ├── dispatcher.ts        # Routes tool name → implementation
    ├── caldav.ts            # CalDAV client + calendar/list discovery (cached)
    ├── calendar.ts          # VEVENT operations (events)
    └── reminders.ts         # VTODO operations (reminders / tasks)
```

## How It Works

1. You send a Telegram message.
2. The bot forwards it to Claude with the calendar/reminder tools registered.
3. Claude inspects the message, chooses tool(s), and calls them.
4. Tools talk to iCloud CalDAV (`caldav.icloud.com`), which is the same backend Apple Calendar and Reminders use.
5. iCloud propagates the change to every signed-in device via push within seconds.
6. Claude composes a friendly confirmation and sends it back to you on Telegram.

## Apple Reminders Limitations

iCloud has two parallel reminder systems:

- **Legacy CalDAV reminders** — what this bot writes to.
- **Modern CloudKit Reminders** — what the iOS/macOS Reminders app reads from on newer accounts.

If your account was migrated to the new format (most accounts post-iOS 13), reminders the bot creates may not appear in the Reminders app. They will appear in the CalDAV `Reminders` list — sometimes visible via iCloud.com → Reminders.

**Workaround:** By default, Claude treats `"remind me to X at <time>"` requests as **calendar events with alarms** instead of true reminders. This sidesteps the limitation and gets you the same notification-on-your-device behavior. To force a true reminder, say *"add a task to Reminders"* explicitly.

## Security Notes

- The `ALLOWED_CHAT_IDS` whitelist is the only thing preventing strangers from using your bot's calendar access if they discover the bot's username. **Set it.**
- Never commit `.env`. The included `.gitignore` excludes it.
- Use Fly secrets / Docker env vars for production — they're encrypted at rest.
- The iCloud app-specific password can be revoked at any time at appleid.apple.com.

## License

MIT — see [LICENSE](LICENSE).

## Acknowledgements

- Calendar access via the [tsdav](https://github.com/natelindev/tsdav) CalDAV client
- iCal generation/parsing via [ical.js](https://github.com/kewisch/ical.js)
- Timezone math via [Luxon](https://moment.github.io/luxon/)
- Telegram framework: [Telegraf](https://telegraf.js.org/)
