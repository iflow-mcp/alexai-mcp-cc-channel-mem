'use strict';

const TelegramBot = require('node-telegram-bot-api');
const { writeMessage } = require('./writer');

let bot = null;

/**
 * Start the Telegram bot (저장 전용, 응답 없음)
 *
 * Env vars:
 *   TELEGRAM_BOT_TOKEN          required
 *   TELEGRAM_ALLOWED_CHAT_IDS   optional, comma-separated chat IDs
 */
async function startTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    console.log('[telegram] TELEGRAM_BOT_TOKEN not set — skipping');
    return;
  }

  const allowedChats = parseIdList(process.env.TELEGRAM_ALLOWED_CHAT_IDS);

  bot = new TelegramBot(token, {
    polling: {
      interval: 1000,
      timeout: 10,
    },
  });

  bot.on('message', async (msg) => {
    // Skip bots
    if (msg.from && msg.from.is_bot) return;

    // Skip non-text messages
    if (!msg.text || !msg.text.trim()) return;

    const chatId = String(msg.chat.id);

    // Chat filter
    if (allowedChats.size > 0 && !allowedChats.has(chatId)) return;

    const channelName = msg.chat.title || msg.chat.username
      ? `@${msg.chat.username || msg.chat.title}`
      : `chat_${chatId}`;

    const authorName = msg.from.username || msg.from.first_name || String(msg.from.id);

    try {
      await writeMessage({
        platform: 'telegram',
        channelId: chatId,
        channelName,
        authorId: String(msg.from.id),
        authorName,
        content: msg.text,
        timestamp: new Date(msg.date * 1000),
      });
    } catch (err) {
      console.error('[telegram] write error:', err.message);
    }
  });

  bot.on('polling_error', (err) => {
    console.error('[telegram] polling error:', err.message);
  });

  console.log('[telegram] polling started');
}

/**
 * Stop the Telegram bot polling
 */
async function stopTelegram() {
  if (bot) {
    await bot.stopPolling();
    bot = null;
    console.log('[telegram] stopped');
  }
}

/**
 * Parse comma-separated env var into a Set
 */
function parseIdList(envVal) {
  if (!envVal || !envVal.trim()) return new Set();
  return new Set(envVal.split(',').map((s) => s.trim()).filter(Boolean));
}

module.exports = { startTelegram, stopTelegram };
