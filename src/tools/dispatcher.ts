import {
  createCalendarEvent,
  listCalendarEvents,
  updateCalendarEvent,
  deleteCalendarEvent,
  CreateEventInput,
  ListEventsInput,
  UpdateEventInput,
  DeleteEventInput,
} from './calendar';
import {
  createReminder,
  listReminders,
  updateReminder,
  deleteReminder,
  CreateReminderInput,
  ListRemindersInput,
  UpdateReminderInput,
  DeleteReminderInput,
} from './reminders';

export async function dispatchTool(
  name: string,
  input: Record<string, unknown>,
): Promise<string> {
  switch (name) {
    // Events
    case 'create_calendar_event':
      return createCalendarEvent(input as unknown as CreateEventInput);
    case 'list_calendar_events':
      return listCalendarEvents(input as unknown as ListEventsInput);
    case 'update_calendar_event':
      return updateCalendarEvent(input as unknown as UpdateEventInput);
    case 'delete_calendar_event':
      return deleteCalendarEvent(input as unknown as DeleteEventInput);

    // Reminders
    case 'create_reminder':
      return createReminder(input as unknown as CreateReminderInput);
    case 'list_reminders':
      return listReminders(input as unknown as ListRemindersInput);
    case 'update_reminder':
      return updateReminder(input as unknown as UpdateReminderInput);
    case 'delete_reminder':
      return deleteReminder(input as unknown as DeleteReminderInput);

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}
