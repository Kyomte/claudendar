import Anthropic from '@anthropic-ai/sdk';
import { calendarTools } from './tools/definitions';
import { dispatchTool } from './tools/dispatcher';
import { getCalendarNames, getReminderListNames } from './tools/caldav';

export type MessageParam = Anthropic.MessageParam;

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 5,
});

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callWithBackoff<T>(fn: () => Promise<T>, label: string): Promise<T> {
  const maxAttempts = 6;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastErr = err;
      const status = (err as { status?: number }).status;
      const retryable = status === 529 || status === 503 || status === 502 || status === 500;
      if (!retryable || attempt === maxAttempts - 1) {
        throw err;
      }
      const waitMs = Math.min(1000 * 2 ** attempt, 15000) + Math.random() * 500;
      console.warn(
        `[${label}] HTTP ${status} (attempt ${attempt + 1}/${maxAttempts}) — retrying in ${Math.round(waitMs)}ms`,
      );
      await sleep(waitMs);
    }
  }
  throw lastErr;
}

const MODEL = 'claude-sonnet-4-6';
const MAX_TOKENS = 4096;
const MAX_TOOL_ROUNDS = 8;

function todayString(): string {
  const tz = process.env.USER_TIMEZONE?.trim() || 'UTC';
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
  return `${fmt.format(now)} (${tz})`;
}

async function buildSystemPrompt(): Promise<string> {
  const tz = process.env.USER_TIMEZONE?.trim() || 'UTC';
  let calendarsBlock = '';
  let remindersBlock = '';
  try {
    const names = await getCalendarNames();
    if (names.length > 0) {
      calendarsBlock = `\nAvailable event calendars (use the exact name in calendar_name):\n${names.map((n) => `- ${n}`).join('\n')}\n`;
    }
  } catch (err) {
    console.warn('[claude] Could not load calendar list:', err);
  }
  try {
    const names = await getReminderListNames();
    if (names.length > 0) {
      remindersBlock = `\nAvailable reminder lists (use the exact name in list_name):\n${names.map((n) => `- ${n}`).join('\n')}\n`;
    }
  } catch (err) {
    console.warn('[claude] Could not load reminder lists:', err);
  }

  return `You are Claudendar, a helpful assistant managing the user's iCloud / Apple Calendar AND Apple Reminders via CalDAV tools.

Right now it is ${todayString()}. The user's timezone is ${tz}.
${calendarsBlock}${remindersBlock}
=== DEFAULT TO EVENTS for "remind me to ..." ===
Apple Reminders (VTODO) doesn't sync reliably to this user's Reminders app due to iCloud's legacy/CloudKit split. So:
- "Remind me to X at <time>" → CREATE A CALENDAR EVENT, not a reminder. Use create_calendar_event with a 15-minute duration and reminder_minutes_before=[0] (alarm at start). Title = "X".
- "Remind me to X tomorrow / Friday / next week" (no specific time) → Ask the user what time they want the reminder/alarm to fire, then create an event.
- "Remind me to X" with no day/time at all → Ask for both day and time.
- Use create_reminder (VTODO) only if the user EXPLICITLY says "add to my reminders list", "add a task", or "in Apple Reminders". Otherwise default to events.

=== Calendar events vs Apple Reminders (technical distinction, mostly for advanced cases) ===
- Apple Calendar EVENTS (create_calendar_event etc): time-blocked items with start AND end times. "Meeting at 3pm for 1 hr", "Workout 7-8am", "Dentist Friday at 2pm".
- Apple REMINDERS / tasks (create_reminder etc): a to-do, optionally with a due time. Stored separately. May not show in the modern Reminders app for this account.

Choosing an event calendar (create_calendar_event):
- Infer from context. Workout/run → "Workouts"; class/lecture/exam → "School"; team standup/work meeting → "Work"; family/shared event → "Personal"; otherwise pick the most fitting one.
- If unsure, omit calendar_name.

Event alerts (reminder_minutes_before on an event, NOT a reminder list):
- Use reminder_minutes_before to attach Apple Calendar alerts to an event (VALARM). Common: 0 (at start), 5, 10, 15, 30, 60, 120, 1440 (1 day).
- "Remind me 1 hour before the meeting" → set reminder_minutes_before [60] on the event, NOT a separate reminder.
- "Remind me to ..." with no event context → use create_reminder.

Choosing a reminder list (create_reminder):
- If unsure, omit list_name and the default list is used. Use list_name only when the user explicitly references a list ("add to my Groceries list").

Locations (events):
- Pass concrete strings like "Starbucks Shibuya", "Conference Room 3", "Zoom: <link>". Apple Calendar geocodes addresses.

Other guidelines:
- When the user mentions schedule, meetings, events, or appointments, use the calendar tools.
- All datetimes you pass to tools must be ISO 8601 in the user's LOCAL time (no timezone suffix), e.g. 2026-06-15T14:30:00.
- For "today", "tomorrow", "this week", etc., compute the actual dates relative to today (above).
- When listing events for a day or range, use a full-day range: start at T00:00:00 and end at T23:59:59. By default list_calendar_events searches ALL calendars.
- When updating event times, always provide BOTH start_datetime and end_datetime together.
- Event UIDs come from list_calendar_events results — use them when updating or deleting.
- If the user asks to edit or delete an event without giving a UID, first list events in the relevant range to find it.
- When confirming a created event, mention which calendar it went into.
- Be concise and friendly.`;
}

export interface ProcessResult {
  responseText: string;
  updatedHistory: MessageParam[];
}

export async function processMessage(
  userText: string,
  history: MessageParam[],
): Promise<ProcessResult> {
  const messages: MessageParam[] = [
    ...history,
    { role: 'user', content: userText },
  ];

  const systemPrompt = await buildSystemPrompt();

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const response = await callWithBackoff(
      () =>
        client.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          tools: calendarTools,
          messages,
        }),
      'anthropic',
    );

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
      const textBlocks = response.content.filter(
        (b): b is Anthropic.TextBlock => b.type === 'text',
      );
      const responseText = textBlocks.map((b) => b.text).join('\n\n').trim() || '(no response)';
      return { responseText, updatedHistory: messages };
    }

    if (response.stop_reason !== 'tool_use') {
      throw new Error(`Unexpected stop_reason: ${response.stop_reason}`);
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
    );

    const toolResults: Anthropic.ToolResultBlockParam[] = await Promise.all(
      toolUseBlocks.map(async (block) => {
        let result: string;
        let isError = false;
        try {
          result = await dispatchTool(block.name, block.input as Record<string, unknown>);
        } catch (err: unknown) {
          const e = err as { message?: string };
          result = `Error: ${e.message ?? String(err)}`;
          isError = true;
        }
        console.log(
          `[tool] ${block.name}(${JSON.stringify(block.input)}) => ${result.slice(0, 200)}`,
        );
        return {
          type: 'tool_result' as const,
          tool_use_id: block.id,
          content: result,
          is_error: isError,
        };
      }),
    );

    messages.push({ role: 'user', content: toolResults });
  }

  throw new Error(`Exceeded ${MAX_TOOL_ROUNDS} tool rounds without final response.`);
}
