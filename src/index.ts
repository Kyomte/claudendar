import * as dotenv from 'dotenv';
dotenv.config();

import { createBot } from './bot';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.error(`Missing required env var: ${name}`);
    console.error('Copy .env.example to .env and fill in your tokens.');
    process.exit(1);
  }
  return v;
}

const token = requireEnv('TELEGRAM_BOT_TOKEN');
requireEnv('ANTHROPIC_API_KEY');
requireEnv('ICLOUD_USERNAME');
requireEnv('ICLOUD_APP_PASSWORD');
requireEnv('USER_TIMEZONE');

const bot = createBot(token);

process.once('SIGINT', () => {
  console.log('\nStopping bot...');
  bot.stop('SIGINT');
});
process.once('SIGTERM', () => {
  console.log('\nStopping bot...');
  bot.stop('SIGTERM');
});

bot
  .launch()
  .then(() => {
    console.log('Claudendar is running (Telegram long-polling). Press Ctrl+C to stop.');
  })
  .catch((err) => {
    console.error('Failed to start bot:', err);
    process.exit(1);
  });
