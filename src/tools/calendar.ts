import { randomUUID } from 'crypto';
import { DateTime } from 'luxon';
import ICAL from 'ical.js';
import {
  getClient,
  getAllCalendars,
  getCalendarByName,
  findCalendarForObjectUrl,
  getUserTimezone,
} from './caldav';

export interface CreateEventInput {
  title: string;
  start_datetime: string;
  end_datetime: string;
  calendar_name?: string;
  notes?: string;
  location?: string;
  reminder_minutes_before?: number[];
}

export interface ListEventsInput {
  start_date: string;
  end_date: string;
  calendar_name?: string;
}

export interface UpdateEventInput {
  event_uid: string;
  title?: string;
  start_datetime?: string;
  end_datetime?: string;
  notes?: string;
  location?: string;
  reminder_minutes_before?: number[];
}

export interface DeleteEventInput {
  event_uid: string;
}

export interface CalendarEvent {
  uid: string;
  title: string;
  start: string;
  end: string;
  notes: string;
  location: string;
  calendar: string;
  reminders_minutes_before: number[];
}

// ---------- Time helpers ----------

function parseLocalToUTC(localIso: string): Date {
  const tz = getUserTimezone();
  const dt = DateTime.fromISO(localIso, { zone: tz });
  if (!dt.isValid) {
    throw new Error(`Invalid datetime "${localIso}": ${dt.invalidReason}`);
  }
  return dt.toUTC().toJSDate();
}

function utcToLocalIso(date: Date): string {
  const tz = getUserTimezone();
  return DateTime.fromJSDate(date).setZone(tz).toFormat("yyyy-LL-dd'T'HH:mm:ss");
}

// ---------- Handle (opaque uid we expose to Claude) ----------

function encodeHandle(url: string): string {
  return Buffer.from(url, 'utf8').toString('base64url');
}

function decodeHandle(handle: string): string {
  return Buffer.from(handle, 'base64url').toString('utf8');
}

// ---------- ICS building / parsing ----------

interface VeventFields {
  uid: string;
  summary: string;
  startUtc: Date;
  endUtc: Date;
  description?: string;
  location?: string;
  reminderMinutesBefore?: number[];
}

function triggerStringFor(minutesBefore: number): string {
  if (minutesBefore === 0) return 'PT0S';
  const m = Math.max(0, Math.round(minutesBefore));
  return `-PT${m}M`;
}

function buildValarm(minutesBefore: number, summary: string): ICAL.Component {
  const valarm = new ICAL.Component('valarm');
  valarm.updatePropertyWithValue('action', 'DISPLAY');
  valarm.updatePropertyWithValue('description', summary || 'Reminder');
  valarm.updatePropertyWithValue(
    'trigger',
    ICAL.Duration.fromString(triggerStringFor(minutesBefore)),
  );
  return valarm;
}

function buildIcs(fields: VeventFields): string {
  const vcalendar = new ICAL.Component(['vcalendar', [], []]);
  vcalendar.updatePropertyWithValue('prodid', '-//Claudendar//EN');
  vcalendar.updatePropertyWithValue('version', '2.0');

  const vevent = new ICAL.Component('vevent');
  vevent.updatePropertyWithValue('uid', fields.uid);
  vevent.updatePropertyWithValue('summary', fields.summary);
  vevent.updatePropertyWithValue(
    'dtstamp',
    ICAL.Time.fromJSDate(new Date(), true),
  );
  vevent.updatePropertyWithValue(
    'dtstart',
    ICAL.Time.fromJSDate(fields.startUtc, true),
  );
  vevent.updatePropertyWithValue(
    'dtend',
    ICAL.Time.fromJSDate(fields.endUtc, true),
  );
  if (fields.description !== undefined && fields.description.length > 0) {
    vevent.updatePropertyWithValue('description', fields.description);
  }
  if (fields.location !== undefined && fields.location.length > 0) {
    vevent.updatePropertyWithValue('location', fields.location);
  }

  if (fields.reminderMinutesBefore && fields.reminderMinutesBefore.length > 0) {
    // De-dupe and sort largest-first (= earliest reminder first)
    const unique = Array.from(new Set(fields.reminderMinutesBefore.map((n) => Math.max(0, Math.round(n)))));
    unique.sort((a, b) => b - a);
    for (const m of unique) {
      vevent.addSubcomponent(buildValarm(m, fields.summary));
    }
  }

  vcalendar.addSubcomponent(vevent);
  return vcalendar.toString();
}

function parseIcs(ics: string): VeventFields | null {
  try {
    const jcal = ICAL.parse(ics);
    const vcal = new ICAL.Component(jcal);
    const vevent = vcal.getFirstSubcomponent('vevent');
    if (!vevent) return null;

    const dtstart = vevent.getFirstPropertyValue('dtstart') as ICAL.Time | null;
    const dtend = vevent.getFirstPropertyValue('dtend') as ICAL.Time | null;
    if (!dtstart || !dtend) return null;

    const reminders: number[] = [];
    for (const va of vevent.getAllSubcomponents('valarm')) {
      const trigger = va.getFirstPropertyValue('trigger');
      if (!trigger) continue;
      // Duration-typed trigger (relative). Skip absolute date-time triggers.
      if (trigger instanceof ICAL.Duration) {
        const totalSeconds = trigger.toSeconds(); // negative means "before"
        const minutesBefore = Math.round(-totalSeconds / 60);
        if (minutesBefore >= 0) reminders.push(minutesBefore);
      }
    }

    return {
      uid: (vevent.getFirstPropertyValue('uid') as string) ?? '',
      summary: (vevent.getFirstPropertyValue('summary') as string) ?? '',
      startUtc: dtstart.toJSDate(),
      endUtc: dtend.toJSDate(),
      description:
        (vevent.getFirstPropertyValue('description') as string | null) ?? undefined,
      location:
        (vevent.getFirstPropertyValue('location') as string | null) ?? undefined,
      reminderMinutesBefore: reminders,
    };
  } catch (err) {
    console.warn('[caldav] Failed to parse ICS:', err);
    return null;
  }
}

// ---------- Operations ----------

export async function createCalendarEvent(input: CreateEventInput): Promise<string> {
  const client = await getClient();
  const calendar = await getCalendarByName(input.calendar_name);
  const calName =
    typeof calendar.displayName === 'string' ? calendar.displayName : 'calendar';

  const uid = randomUUID();
  const startUtc = parseLocalToUTC(input.start_datetime);
  const endUtc = parseLocalToUTC(input.end_datetime);

  if (endUtc.getTime() <= startUtc.getTime()) {
    throw new Error('end_datetime must be after start_datetime');
  }

  const ics = buildIcs({
    uid,
    summary: input.title,
    startUtc,
    endUtc,
    description: input.notes,
    location: input.location,
    reminderMinutesBefore: input.reminder_minutes_before,
  });

  const filename = `${uid}.ics`;
  await client.createCalendarObject({
    calendar,
    filename,
    iCalString: ics,
  });

  const calendarUrl = calendar.url.endsWith('/') ? calendar.url : `${calendar.url}/`;
  const objectUrl = `${calendarUrl}${filename}`;

  return JSON.stringify({
    uid: encodeHandle(objectUrl),
    calendar: calName,
    message: `Created "${input.title}" in calendar "${calName}" from ${input.start_datetime} to ${input.end_datetime} (${getUserTimezone()}).`,
  });
}

export async function listCalendarEvents(input: ListEventsInput): Promise<string> {
  const client = await getClient();

  const startUtc = parseLocalToUTC(input.start_date);
  const endUtc = parseLocalToUTC(input.end_date);

  const calendars = input.calendar_name
    ? [await getCalendarByName(input.calendar_name)]
    : await getAllCalendars();

  // Query each calendar in parallel.
  const perCalendar = await Promise.all(
    calendars.map(async (cal) => {
      try {
        const objects = await client.fetchCalendarObjects({
          calendar: cal,
          timeRange: {
            start: startUtc.toISOString(),
            end: endUtc.toISOString(),
          },
          expand: false,
        });
        const calName =
          typeof cal.displayName === 'string' ? cal.displayName : '(unnamed)';
        const events: CalendarEvent[] = [];
        for (const obj of objects) {
          if (!obj.data) continue;
          const parsed = parseIcs(obj.data);
          if (!parsed) continue;
          if (parsed.endUtc < startUtc || parsed.startUtc > endUtc) continue;
          events.push({
            uid: encodeHandle(obj.url),
            title: parsed.summary,
            start: utcToLocalIso(parsed.startUtc),
            end: utcToLocalIso(parsed.endUtc),
            notes: parsed.description ?? '',
            location: parsed.location ?? '',
            calendar: calName,
            reminders_minutes_before: parsed.reminderMinutesBefore ?? [],
          });
        }
        return events;
      } catch (err) {
        console.warn(
          `[caldav] Failed to list events in calendar "${cal.displayName}":`,
          err,
        );
        return [];
      }
    }),
  );

  const events = perCalendar.flat();
  events.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));

  return JSON.stringify({
    events,
    count: events.length,
    timezone: getUserTimezone(),
  });
}

export async function updateCalendarEvent(input: UpdateEventInput): Promise<string> {
  const client = await getClient();
  const objectUrl = decodeHandle(input.event_uid);

  const calendar = await findCalendarForObjectUrl(objectUrl);
  if (!calendar) {
    return JSON.stringify({
      ok: false,
      message: 'Event not found (could not match URL to any calendar).',
    });
  }

  const existingObjects = await client.fetchCalendarObjects({
    calendar,
    objectUrls: [objectUrl],
  });
  const existing = existingObjects[0];
  if (!existing || !existing.data) {
    return JSON.stringify({ ok: false, message: 'Event not found.' });
  }

  const parsed = parseIcs(existing.data);
  if (!parsed) {
    return JSON.stringify({ ok: false, message: 'Could not parse existing event.' });
  }

  const newSummary = input.title ?? parsed.summary;
  const newStartUtc = input.start_datetime
    ? parseLocalToUTC(input.start_datetime)
    : parsed.startUtc;
  const newEndUtc = input.end_datetime
    ? parseLocalToUTC(input.end_datetime)
    : parsed.endUtc;
  const newDescription =
    input.notes !== undefined ? input.notes : parsed.description;
  const newLocation =
    input.location !== undefined ? input.location : parsed.location;
  const newReminders =
    input.reminder_minutes_before !== undefined
      ? input.reminder_minutes_before
      : parsed.reminderMinutesBefore;

  if (newEndUtc.getTime() <= newStartUtc.getTime()) {
    throw new Error('end_datetime must be after start_datetime');
  }

  const newIcs = buildIcs({
    uid: parsed.uid,
    summary: newSummary,
    startUtc: newStartUtc,
    endUtc: newEndUtc,
    description: newDescription,
    location: newLocation,
    reminderMinutesBefore: newReminders,
  });

  await client.updateCalendarObject({
    calendarObject: {
      url: existing.url,
      etag: existing.etag,
      data: newIcs,
    },
  });

  return JSON.stringify({ ok: true, message: 'Event updated.' });
}

export async function deleteCalendarEvent(input: DeleteEventInput): Promise<string> {
  const client = await getClient();
  const objectUrl = decodeHandle(input.event_uid);

  const calendar = await findCalendarForObjectUrl(objectUrl);
  if (!calendar) {
    return JSON.stringify({
      ok: false,
      message: 'Event not found (could not match URL to any calendar).',
    });
  }

  const existingObjects = await client.fetchCalendarObjects({
    calendar,
    objectUrls: [objectUrl],
  });
  const existing = existingObjects[0];
  if (!existing) {
    return JSON.stringify({ ok: false, message: 'Event not found.' });
  }

  await client.deleteCalendarObject({
    calendarObject: {
      url: existing.url,
      etag: existing.etag,
    },
  });

  return JSON.stringify({ ok: true, message: 'Event deleted.' });
}
