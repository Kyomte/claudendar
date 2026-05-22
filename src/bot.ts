import { Telegraf } from 'telegraf';
import { message } from 'telegraf/filters';
import { processMessage, MessageParam } from './claude';

const MAX_HISTORY = parseInt(process.env.MAX_HISTORY_MESSAGES ?? '20', 10);

const ALLOWED_CHAT_IDS: Set<number> | null = (() => {
  const raw = process.env.ALLOWED_CHAT_IDS?.trim();
  if (!raw) return null;
  return new Set(
    raw
      .split(',')
      .map((s) => parseInt(s.trim(), 10))
      .filter((n) => !Number.isNaN(n)),
  );
})();

const conversationHistory = new Map<number, MessageParam[]>();

function getHistory(chatId: number): MessageParam[] {
  const existing = conversationHistory.get(chatId);
  if (existing) return existing;
  const fresh: MessageParam[] = [];
  conversationHistory.set(chatId, fresh);
  return fresh;
}

function pruneHistory(messages: MessageParam[]): MessageParam[] {
  if (messages.length <= MAX_HISTORY) return messages;
  let pruned = messages.slice(messages.length - MAX_HISTORY);
  const firstUserIdx = pruned.findIndex((m) => m.role === 'user');
  if (firstUserIdx > 0) {
    pruned = pruned.slice(firstUserIdx);
  }
  return pruned;
}

export function createBot(token: string): Telegraf {
  const bot = new Telegraf(token);

  bot.use(async (ctx, next) => {
    const chatId = ctx.chat?.id;
    if (chatId !== undefined) {
      if (ALLOWED_CHAT_IDS && !ALLOWED_CHAT_IDS.has(chatId)) {
        console.warn(`[auth] Rejected message from chat ${chatId}`);
        await ctx.reply(
          `Unauthorized chat. Your chat ID is ${chatId} — add it to ALLOWED_CHAT_IDS in .env if this is you.`,
        );
        return;
      }
      if (!ALLOWED_CHAT_IDS) {
        console.log(`[auth] Open mode — message from chat ${chatId}`);
      }
    }
    return next();
  });

  bot.command('start', async (ctx) => {
    await ctx.reply(
      'Hi! I\'m Claudendar — I manage your Apple Calendar.\n\n' +
        'Try things like:\n' +
        '• "What\'s on my calendar today?"\n' +
        '• "Schedule a coffee chat tomorrow at 3pm for 30 min"\n' +
        '• "Move my dentist appointment to 11am"\n' +
        '• "Cancel my 4pm meeting"\n\n' +
        'Use /clear to reset our conversation.',
    );
  });

  bot.command('clear', async (ctx) => {
    const chatId = ctx.chat.id;
    conversationHistory.delete(chatId);
    await ctx.reply('Conversation history cleared.');
  });

  bot.on(message('text'), async (ctx) => {
    const chatId = ctx.chat.id;
    const userText = ctx.message.text;
    console.log(`[${chatId}] user: ${userText}`);

    const typingInterval = setInterval(() => {
      ctx.sendChatAction('typing').catch(() => {});
    }, 4000);
    ctx.sendChatAction('typing').catch(() => {});

    try {
      const history = getHistory(chatId);
      const { responseText, updatedHistory } = await processMessage(userText, history);
      conversationHistory.set(chatId, pruneHistory(updatedHistory));
      console.log(`[${chatId}] claude: ${responseText.slice(0, 200)}`);
      await ctx.reply(responseText);
    } catch (err: unknown) {
      const e = err as { status?: number; message?: string };
      console.error(`[${chatId}] error:`, err);
      let userMessage: string;
      if (e.status === 529) {
        userMessage =
          "Claude's API is overloaded right now (Anthropic-side capacity). Try again in a minute.";
      } else if (e.status === 429) {
        userMessage = "Rate limited by Claude. Give it a moment and try again.";
      } else if (e.status === 401 || e.status === 403) {
        userMessage = "Auth failed talking to Claude — check your ANTHROPIC_API_KEY.";
      } else if (typeof e.message === 'string' && e.message.includes('AppleScript')) {
        userMessage = `Calendar error: ${e.message}`;
      } else {
        userMessage = `Sorry, something went wrong: ${e.message ?? String(err)}`;
      }
      await ctx.reply(userMessage);
    } finally {
      clearInterval(typingInterval);
    }
  });

  return bot;
}
