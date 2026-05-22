import type Anthropic from '@anthropic-ai/sdk';

export const calendarTools: Anthropic.Tool[] = [
  {
    name: 'create_calendar_event',
    description:
      "Create a new event in one of the user's iCloud calendars. Choose calendar_name based on the event's context (see the list in the system prompt). Returns an opaque uid for later update/delete. All datetimes are ISO 8601 in the user's LOCAL time (no timezone suffix), e.g. 2026-06-15T14:30:00.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Event title' },
        start_datetime: {
          type: 'string',
          description: 'ISO 8601 local start datetime, e.g. 2026-06-15T14:30:00',
        },
        end_datetime: {
          type: 'string',
          description: 'ISO 8601 local end datetime',
        },
        calendar_name: {
          type: 'string',
          description:
            'Name of the calendar to create the event in. Match the user\'s available calendars from the system prompt. If unclear, omit this field to use the default calendar.',
        },
        notes: { type: 'string', description: 'Optional notes / description' },
        location: {
          type: 'string',
          description:
            "Optional location (e.g. 'Starbucks Shibuya', '123 Main St', 'Zoom: https://...'). Apple Calendar will geocode addresses for directions.",
        },
        reminder_minutes_before: {
          type: 'array',
          items: { type: 'integer', minimum: 0 },
          description:
            "Optional list of reminders, in minutes before the event. Examples: [60] = 1 hour before, [10] = 10 min before, [0, 1440] = at start time and 1 day before, [15, 1440] = 15 min and 1 day before. Default behavior is no reminders unless the user mentions one.",
        },
      },
      required: ['title', 'start_datetime', 'end_datetime'],
    },
  },
  {
    name: 'list_calendar_events',
    description:
      "List events within a date range. By default searches ALL of the user's calendars. Pass calendar_name to restrict to one. Use a full-day range (T00:00:00 to T23:59:59) when the user asks about specific days. Each returned event includes its source calendar name and an opaque uid for update/delete.",
    input_schema: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'ISO 8601 local start of range' },
        end_date: { type: 'string', description: 'ISO 8601 local end of range' },
        calendar_name: {
          type: 'string',
          description: 'Optional — restrict to this calendar. Omit to search all.',
        },
      },
      required: ['start_date', 'end_date'],
    },
  },
  {
    name: 'update_calendar_event',
    description:
      'Update an existing event by uid. Only the provided fields are changed. When changing time, always provide BOTH start_datetime and end_datetime together.',
    input_schema: {
      type: 'object',
      properties: {
        event_uid: {
          type: 'string',
          description: 'Opaque uid from list_calendar_events or create_calendar_event',
        },
        title: { type: 'string' },
        start_datetime: { type: 'string', description: 'ISO 8601 local' },
        end_datetime: { type: 'string', description: 'ISO 8601 local' },
        notes: { type: 'string' },
        location: { type: 'string' },
        reminder_minutes_before: {
          type: 'array',
          items: { type: 'integer', minimum: 0 },
          description:
            'Replaces all existing reminders. Pass [] to remove all. Omit to keep existing reminders unchanged.',
        },
      },
      required: ['event_uid'],
    },
  },
  {
    name: 'delete_calendar_event',
    description: 'Delete an event by its opaque uid.',
    input_schema: {
      type: 'object',
      properties: {
        event_uid: { type: 'string', description: 'Opaque uid of the event to delete' },
      },
      required: ['event_uid'],
    },
  },

  // ---------- Apple Reminders (VTODO) ----------

  {
    name: 'create_reminder',
    description:
      "Create a task in Apple Reminders. Use this when the user says 'remind me to ...' (an action/todo), as opposed to scheduling a time-blocked event. due_datetime is optional — many reminders are just tasks without a due date.",
    input_schema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What the reminder is about' },
        due_datetime: {
          type: 'string',
          description: 'Optional ISO 8601 local datetime when the reminder is due',
        },
        list_name: {
          type: 'string',
          description:
            "Optional reminder list to add to. See available lists in the system prompt. Omit for the default list.",
        },
        notes: { type: 'string', description: 'Optional notes' },
        priority: {
          type: 'integer',
          minimum: 0,
          maximum: 9,
          description:
            'Optional priority — 1 = high, 5 = medium, 9 = low, 0 = unset (RFC 5545).',
        },
      },
      required: ['title'],
    },
  },
  {
    name: 'list_reminders',
    description:
      "List reminders (Apple Reminders tasks). By default, returns only pending reminders across all lists. Use include_completed to include completed ones. Use due_before / due_after to filter by due date range (both filters skip reminders with no due date).",
    input_schema: {
      type: 'object',
      properties: {
        list_name: {
          type: 'string',
          description: 'Optional — restrict to one reminder list.',
        },
        include_completed: {
          type: 'boolean',
          description: 'If true, include completed reminders. Defaults to false.',
        },
        due_before: {
          type: 'string',
          description: 'Optional ISO 8601 local — only include reminders due before this.',
        },
        due_after: {
          type: 'string',
          description: 'Optional ISO 8601 local — only include reminders due after this.',
        },
      },
    },
  },
  {
    name: 'update_reminder',
    description:
      "Update a reminder by uid. Use completed=true to mark it done. Pass due_datetime as null (JSON null) to clear the due date.",
    input_schema: {
      type: 'object',
      properties: {
        reminder_uid: { type: 'string' },
        title: { type: 'string' },
        due_datetime: {
          type: ['string', 'null'],
          description: 'New due datetime, or null to clear it. Omit to keep existing.',
        },
        notes: { type: 'string' },
        priority: { type: 'integer', minimum: 0, maximum: 9 },
        completed: {
          type: 'boolean',
          description: 'Set true to mark the reminder done; false to reopen.',
        },
      },
      required: ['reminder_uid'],
    },
  },
  {
    name: 'delete_reminder',
    description: 'Delete a reminder by uid.',
    input_schema: {
      type: 'object',
      properties: {
        reminder_uid: { type: 'string' },
      },
      required: ['reminder_uid'],
    },
  },
];
