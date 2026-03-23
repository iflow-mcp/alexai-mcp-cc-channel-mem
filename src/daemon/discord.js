'use strict';

const { Client, GatewayIntentBits } = require('discord.js');
const { writeMessage } = require('./writer');

let client = null;

/**
 * Start the Discord bot (봇 B — 저장 전용, 응답 없음)
 *
 * Env vars:
 *   DISCORD_BOT_TOKEN           required
 *   DISCORD_ALLOWED_GUILD_IDS   optional, comma-separated guild IDs
 *   DISCORD_ALLOWED_CHANNEL_IDS optional, comma-separated channel IDs
 */
async function startDiscord() {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.log('[discord] DISCORD_BOT_TOKEN not set — skipping');
    return;
  }

  const allowedGuilds = parseIdList(process.env.DISCORD_ALLOWED_GUILD_IDS);
  const allowedChannels = parseIdList(process.env.DISCORD_ALLOWED_CHANNEL_IDS);

  client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once('ready', () => {
    console.log(`[discord] connected as ${client.user.tag}`);
  });

  client.on('messageCreate', async (message) => {
    // Skip bots
    if (message.author.bot) return;

    // Skip empty content (attachment-only messages)
    if (!message.content || !message.content.trim()) return;

    // Guild filter
    if (allowedGuilds.size > 0 && !allowedGuilds.has(message.guildId)) return;

    // Channel filter
    if (allowedChannels.size > 0 && !allowedChannels.has(message.channelId)) return;

    try {
      await writeMessage({
        platform: 'discord',
        channelId: message.channelId,
        channelName: `#${message.channel.name}`,
        authorId: message.author.id,
        authorName: message.author.username,
        content: message.content,
        timestamp: message.createdAt,
      });
    } catch (err) {
      console.error('[discord] write error:', err.message);
    }
  });

  client.on('error', (err) => {
    console.error('[discord] client error:', err.message);
  });

  await client.login(token);
}

/**
 * Gracefully destroy the Discord client
 */
async function stopDiscord() {
  if (client) {
    await client.destroy();
    client = null;
    console.log('[discord] stopped');
  }
}

/**
 * Parse comma-separated env var into a Set
 */
function parseIdList(envVal) {
  if (!envVal || !envVal.trim()) return new Set();
  return new Set(envVal.split(',').map((s) => s.trim()).filter(Boolean));
}

module.exports = { startDiscord, stopDiscord };
