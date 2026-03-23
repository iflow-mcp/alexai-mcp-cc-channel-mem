'use strict';

require('dotenv').config({ path: require('path').join(require('os').homedir(), '.cc-channel-mem', '.env') });

const { startDiscord, stopDiscord } = require('./discord');
const { startTelegram, stopTelegram } = require('./telegram');
const { ensureDataDir } = require('./writer');
const { startIndexer, stopIndexer } = require('../memory/indexer');
const { embedAndStore } = require('../memory/search');
const { curate } = require('../memory/curator');

async function start() {
  ensureDataDir();

  // Start indexer (watches memory dir for changes)
  try { startIndexer(); } catch (e) { console.error('[indexer] startup error:', e.message); }

  // Lazy embedding loop every 5 minutes
  setInterval(() => {
    embedAndStore().catch(() => {});
  }, 5 * 60 * 1000);

  // Daily curation at midnight
  scheduleMidnightCuration();

  // Start both; one failure must not kill the other
  const results = await Promise.allSettled([
    startDiscord(),
    startTelegram(),
  ]);

  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      const name = i === 0 ? 'discord' : 'telegram';
      console.error(`[${name}] startup error:`, r.reason?.message ?? r.reason);
    }
  });

  const anyStarted = results.some((r) => r.status === 'fulfilled');
  if (!anyStarted) {
    console.error('[cc-channel-mem] no platform started — set at least one BOT_TOKEN in ~/.cc-channel-mem/.env');
    process.exit(1);
  }

  console.log('[cc-channel-mem] daemon started');
}

function scheduleMidnightCuration() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 30, 0); // 00:00:30 next day
  const msUntilMidnight = midnight - now;

  setTimeout(async () => {
    const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    await curate(yesterday).catch(() => {});
    scheduleMidnightCuration(); // reschedule
  }, msUntilMidnight);
}

async function shutdown() {
  console.log('\n[cc-channel-mem] shutting down...');
  // Run curation for today before exit
  const today = new Date().toISOString().slice(0, 10);
  await curate(today).catch(() => {});
  stopIndexer();
  await Promise.allSettled([stopDiscord(), stopTelegram()]);
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

start().catch((err) => {
  console.error('[cc-channel-mem] fatal:', err);
  process.exit(1);
});
