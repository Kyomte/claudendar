import { randomUUID } from 'crypto';
import { DateTime } from 'luxon';
import ICAL from 'ical.js';
import {
  getClient,
  getAllReminderLists,
  getReminderListByName,
  findCalendarForObjectUrl,
  getUserTimezone,
} from './caldav';

export interface CreateReminderInput {
  title: string;
  due_datetime?: string;
  list_name?: string;
  notes?: string;
  priority?: number; // 1 = high, 5 = medium, 9 = low (per RFC 5545)
}

export interface ListRemindersInput {
  list_name?: string;
  include_completed?: boolean;
  due_before?: string;
  due_after?: string;
}

export interface UpdateReminderInput {
  reminder_uid: string;
  title?: string;
  due_datetime?: string | null; // null clears due
  notes?: string;
  priority?: number;
  completed?: boolean;
}

export interface DeleteReminderInput {
  reminder_uid: string;
}

export interface ReminderItem {
  uid: string;
  title: string;
  due: string | null;
  notes: string;
  list: string;
  completed: boolean;
  priority: number | null;
}

// ---------- Helpers ----------

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

function encodeHandle(url: string): string {
  return Buffer.from(url, 'utf8').toString('base64url');
}

function decodeHandle(handle: string): string {
  return Buffer.from(handle, 'base64url').toString('utf8');
}

// ---------- ICS (VTODO) ----------

interface VtodoFields {
  uid: string;
  summary: string;
  dueUtc?: Date | null;
  description?: string;
  priority?: number;
  completed: boolean;
}

function buildVtodoIcs(fields: VtodoFields): string {
  const vcal = new ICAL.Component(['vcalendar', [], []]);
  vcal.updatePropertyWithValue('prodid', '-//Claudendar//EN');
  vcal.updatePropertyWithValue('version', '2.0');

  const vtodo = new ICAL.Component('vtodo');
  vtodo.updatePropertyWithValue('uid', fields.uid);
  vtodo.updatePropertyWithValue('summary', fields.summary);
  vtodo.updatePropertyWithValue('dtstamp', ICAL.Time.fromJSDate(new Date(), true));
  if (fields.dueUtc) {
    vtodo.updatePropertyWithValue('due', ICAL.Time.fromJSDate(fields.dueUtc, true));
  }
  if (fields.description && fields.description.length > 0) {
    vtodo.updatePropertyWithValue('description', fields.description);
  }
  if (typeof fields.priority === 'number') {
    vtodo.updatePropertyWithValue('priority', Math.max(0, Math.min(9, Math.round(fields.priority))));
  }
  if (fields.completed) {
    vtodo.updatePropertyWithValue('status', 'COMPLETED');
    vtodo.updatePropertyWithValue('percent-complete', 100);
    vtodo.updatePropertyWithValue('completed', ICAL.Time.fromJSDate(new Date(), true));
  } else {
    vtodo.updatePropertyWithValue('status', 'NEEDS-ACTION');
  }

  vcal.addSubcomponent(vtodo);
  return vcal.toString();
}

function parseVtodo(ics: string): VtodoFields | null {
  try {
    const jcal = ICAL.parse(ics);
    const vcal = new ICAL.Component(jcal);
    const vtodo = vcal.getFirstSubcomponent('vtodo');
    if (!vtodo) return null;

    const due = vtodo.getFirstPropertyValue('due') as ICAL.Time | null;
    const status = (vtodo.getFirstPropertyValue('status') as string | null) ?? '';
    const priorityRaw = vtodo.getFirstPropertyValue('priority');
    const priority = typeof priorityRaw === 'number' ? priorityRaw : null;

    return {
      uid: (vtodo.getFirstPropertyValue('uid') as string) ?? '',
      summary: (vtodo.getFirstPropertyValue('summary') as string) ?? '',
      dueUtc: due ? due.toJSDate() : null,
      description:
        (vtodo.getFirstPropertyValue('description') as string | null) ?? undefined,
      priority: priority ?? undefined,
      completed: status.toUpperCase() === 'COMPLETED',
    };
  } catch (err) {
    console.warn('[caldav] Failed to parse VTODO ICS:', err);
    return null;
  }
}

// ---------- Operations ----------

export async function createReminder(input: CreateReminderInput): Promise<string> {
  const client = await getClient();
  const list = await getReminderListByName(input.list_name);
  const listName = typeof list.displayName === 'string' ? list.displayName : 'Reminders';

  const uid = randomUUID();
  const dueUtc = input.due_datetime ? parseLocalToUTC(input.due_datetime) : null;

  const ics = buildVtodoIcs({
    uid,
    summary: input.title,
    dueUtc,
    description: input.notes,
    priority: input.priority,
    completed: false,
  });

  const filename = `${uid}.ics`;
  await client.createCalendarObject({
    calendar: list,
    filename,
    iCalString: ics,
  });

  const listUrl = list.url.endsWith('/') ? list.url : `${list.url}/`;
  const objectUrl = `${listUrl}${filename}`;

  return JSON.stringify({
    uid: encodeHandle(objectUrl),
    list: listName,
    message: dueUtc
      ? `Added "${input.title}" to "${listName}" due ${input.due_datetime} (${getUserTimezone()}).`
      : `Added "${input.title}" to "${listName}".`,
  });
}

export async function listReminders(input: ListRemindersInput): Promise<string> {
  const client = await getClient();

  const lists = input.list_name
    ? [await getReminderListByName(input.list_name)]
    : await getAllReminderLists();

  const dueBefore = input.due_before ? parseLocalToUTC(input.due_before) : null;
  const dueAfter = input.due_after ? parseLocalToUTC(input.due_after) : null;
  const includeCompleted = input.include_completed === true;

  const perList = await Promise.all(
    lists.map(async (list) => {
      try {
        const objects = await client.fetchCalendarObjects({ calendar: list });
        const listName =
          typeof list.displayName === 'string' ? list.displayName : '(unnamed)';
        const items: ReminderItem[] = [];
        for (const obj of objects) {
          if (!obj.data) continue;
          const parsed = parseVtodo(obj.data);
          if (!parsed) continue;
          if (!includeCompleted && parsed.completed) continue;
          if (dueBefore && parsed.dueUtc && parsed.dueUtc > dueBefore) continue;
          if (dueAfter && parsed.dueUtc && parsed.dueUtc < dueAfter) continue;
          // If due filter requested but the reminder has no due → skip
          if ((dueBefore || dueAfter) && !parsed.dueUtc) continue;
          items.push({
            uid: encodeHandle(obj.url),
            title: parsed.summary,
            due: parsed.dueUtc ? utcToLocalIso(parsed.dueUtc) : null,
            notes: parsed.description ?? '',
            list: listName,
            completed: parsed.completed,
            priority: typeof parsed.priority === 'number' ? parsed.priority : null,
          });
        }
        return items;
      } catch (err) {
        console.warn(`[caldav] Failed to list reminders in "${list.displayName}":`, err);
        return [];
      }
    }),
  );

  const reminders = perList.flat();
  reminders.sort((a, b) => {
    if (a.due && b.due) return a.due < b.due ? -1 : a.due > b.due ? 1 : 0;
    if (a.due) return -1;
    if (b.due) return 1;
    return a.title.localeCompare(b.title);
  });

  return JSON.stringify({
    reminders,
    count: reminders.length,
    timezone: getUserTimezone(),
  });
}

export async function updateReminder(input: UpdateReminderInput): Promise<string> {
  const client = await getClient();
  const objectUrl = decodeHandle(input.reminder_uid);

  const list = await findCalendarForObjectUrl(objectUrl);
  if (!list) {
    return JSON.stringify({
      ok: false,
      message: 'Reminder not found (could not match URL to any list).',
    });
  }

  const existingObjects = await client.fetchCalendarObjects({
    calendar: list,
    objectUrls: [objectUrl],
  });
  const existing = existingObjects[0];
  if (!existing || !existing.data) {
    return JSON.stringify({ ok: false, message: 'Reminder not found.' });
  }

  const parsed = parseVtodo(existing.data);
  if (!parsed) {
    return JSON.stringify({ ok: false, message: 'Could not parse existing reminder.' });
  }

  const newSummary = input.title ?? parsed.summary;
  let newDueUtc: Date | null | undefined = parsed.dueUtc;
  if (input.due_datetime === null) newDueUtc = null;
  else if (typeof input.due_datetime === 'string')
    newDueUtc = parseLocalToUTC(input.due_datetime);

  const newDescription =
    input.notes !== undefined ? input.notes : parsed.description;
  const newPriority =
    typeof input.priority === 'number' ? input.priority : parsed.priority;
  const newCompleted =
    typeof input.completed === 'boolean' ? input.completed : parsed.completed;

  const newIcs = buildVtodoIcs({
    uid: parsed.uid,
    summary: newSummary,
    dueUtc: newDueUtc,
    description: newDescription,
    priority: newPriority,
    completed: newCompleted,
  });

  await client.updateCalendarObject({
    calendarObject: {
      url: existing.url,
      etag: existing.etag,
      data: newIcs,
    },
  });

  return JSON.stringify({ ok: true, message: 'Reminder updated.' });
}

export async function deleteReminder(input: DeleteReminderInput): Promise<string> {
  const client = await getClient();
  const objectUrl = decodeHandle(input.reminder_uid);

  const list = await findCalendarForObjectUrl(objectUrl);
  if (!list) {
    return JSON.stringify({ ok: false, message: 'Reminder not found.' });
  }

  const existingObjects = await client.fetchCalendarObjects({
    calendar: list,
    objectUrls: [objectUrl],
  });
  const existing = existingObjects[0];
  if (!existing) {
    return JSON.stringify({ ok: false, message: 'Reminder not found.' });
  }

  await client.deleteCalendarObject({
    calendarObject: { url: existing.url, etag: existing.etag },
  });

  return JSON.stringify({ ok: true, message: 'Reminder deleted.' });
}
