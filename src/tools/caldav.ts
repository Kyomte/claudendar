import { createDAVClient } from 'tsdav';

export type DAVClient = Awaited<ReturnType<typeof createDAVClient>>;
export type DAVCalendar = Awaited<ReturnType<DAVClient['fetchCalendars']>>[number];

let clientPromise: Promise<DAVClient> | null = null;
let allCollectionsPromise: Promise<DAVCalendar[]> | null = null;

const ICLOUD_SERVER = 'https://caldav.icloud.com';

function getEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    throw new Error(`Missing required env var: ${name}`);
  }
  return v;
}

export async function getClient(): Promise<DAVClient> {
  if (!clientPromise) {
    const username = getEnv('ICLOUD_USERNAME');
    const password = getEnv('ICLOUD_APP_PASSWORD');
    clientPromise = createDAVClient({
      serverUrl: ICLOUD_SERVER,
      credentials: { username, password },
      authMethod: 'Basic',
      defaultAccountType: 'caldav',
    });
  }
  return clientPromise;
}

function collectionName(c: DAVCalendar): string {
  return typeof c.displayName === 'string' && c.displayName.length > 0
    ? c.displayName
    : '(unnamed)';
}

function hasComponent(c: DAVCalendar, name: 'VEVENT' | 'VTODO'): boolean {
  const comps = c.components;
  if (!Array.isArray(comps)) return false;
  return comps.includes(name);
}

/** All CalDAV collections (calendars + reminder lists), cached. */
async function fetchAllOnce(): Promise<DAVCalendar[]> {
  if (!allCollectionsPromise) {
    allCollectionsPromise = (async () => {
      const client = await getClient();
      return await client.fetchCalendars();
    })();
  }
  return allCollectionsPromise;
}

// ---------- Event calendars (VEVENT) ----------

export async function getAllCalendars(): Promise<DAVCalendar[]> {
  const all = await fetchAllOnce();
  const writable = all.filter((c) => hasComponent(c, 'VEVENT'));
  // If the server didn't advertise components, fall back to everything
  return writable.length > 0
    ? writable
    : all.filter((c) => !hasComponent(c, 'VTODO'));
}

export async function getCalendarNames(): Promise<string[]> {
  return (await getAllCalendars()).map(collectionName);
}

export async function getCalendarByName(name?: string): Promise<DAVCalendar> {
  const cals = await getAllCalendars();
  if (cals.length === 0) {
    throw new Error('No writable event calendars on the iCloud account.');
  }
  const wanted = (name || process.env.ICLOUD_CALENDAR_NAME || '').trim();
  if (wanted) {
    const match = cals.find(
      (c) => collectionName(c).toLowerCase() === wanted.toLowerCase(),
    );
    if (match) return match;
    if (name) {
      throw new Error(
        `Calendar "${name}" not found. Available: ${cals.map(collectionName).join(', ')}`,
      );
    }
    console.warn(`[caldav] Env ICLOUD_CALENDAR_NAME="${wanted}" not found; using first.`);
  }
  return cals[0];
}

// ---------- Reminder lists (VTODO) ----------

export async function getAllReminderLists(): Promise<DAVCalendar[]> {
  const all = await fetchAllOnce();
  return all.filter((c) => hasComponent(c, 'VTODO'));
}

export async function getReminderListNames(): Promise<string[]> {
  return (await getAllReminderLists()).map(collectionName);
}

export async function getReminderListByName(name?: string): Promise<DAVCalendar> {
  const lists = await getAllReminderLists();
  if (lists.length === 0) {
    throw new Error('No reminder lists found on the iCloud account.');
  }
  const wanted = (name || process.env.ICLOUD_REMINDER_LIST_NAME || '').trim();
  if (wanted) {
    const match = lists.find(
      (c) => collectionName(c).toLowerCase() === wanted.toLowerCase(),
    );
    if (match) return match;
    if (name) {
      throw new Error(
        `Reminder list "${name}" not found. Available: ${lists.map(collectionName).join(', ')}`,
      );
    }
  }
  return lists[0];
}

// ---------- Lookup by object URL (events or reminders) ----------

export async function findCalendarForObjectUrl(
  objectUrl: string,
): Promise<DAVCalendar | undefined> {
  const all = await fetchAllOnce();
  return all.find((c) => objectUrl.startsWith(c.url));
}

export function getUserTimezone(): string {
  return process.env.USER_TIMEZONE?.trim() || 'UTC';
}
