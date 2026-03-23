#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawn } = require('child_process');
const readline = require('readline');

const DATA_DIR = path.join(os.homedir(), '.cc-channel-mem');
const PID_FILE = path.join(DATA_DIR, 'daemon.pid');
const ENV_FILE = path.join(DATA_DIR, '.env');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const DAEMON_SCRIPT = path.join(__dirname, '..', 'src', 'daemon', 'index.js');

const [,, cmd, ...args] = process.argv;

const commands = { start, stop, status, setup, logs };

if (!cmd || !commands[cmd]) {
  console.log(`Usage: cc-channel-mem <command>

Commands:
  start    Start the daemon in the background
  stop     Stop the daemon
  status   Show daemon status and message stats
  setup    Interactive setup (create ~/.cc-channel-mem/.env)
  logs     Print today's message log`);
  process.exit(cmd ? 1 : 0);
}

commands[cmd]().catch((err) => {
  console.error(err.message);
  process.exit(1);
});

// ─── commands ────────────────────────────────────────────────────────────────

async function start() {
  ensureDataDir();

  if (isRunning()) {
    const pid = fs.readFileSync(PID_FILE, 'utf8').trim();
    console.log(`[cc-channel-mem] daemon already running (pid ${pid})`);
    return;
  }

  const logFile = path.join(DATA_DIR, 'daemon.log');
  const out = fs.openSync(logFile, 'a');
  const err = fs.openSync(logFile, 'a');

  const child = spawn(process.execPath, [DAEMON_SCRIPT], {
    detached: true,
    stdio: ['ignore', out, err],
  });
  child.unref();

  fs.writeFileSync(PID_FILE, String(child.pid), 'utf8');
  console.log(`[cc-channel-mem] daemon started (pid ${child.pid})`);
  console.log(`  logs: ${logFile}`);
}

async function stop() {
  if (!isRunning()) {
    console.log('[cc-channel-mem] daemon is not running');
    return;
  }

  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  try {
    process.kill(pid, 'SIGTERM');
    fs.unlinkSync(PID_FILE);
    console.log(`[cc-channel-mem] daemon stopped (pid ${pid})`);
  } catch (e) {
    fs.unlinkSync(PID_FILE);
    console.log(`[cc-channel-mem] pid ${pid} not found — cleaned up pidfile`);
  }
}

async function status() {
  const running = isRunning();
  const pid = running ? fs.readFileSync(PID_FILE, 'utf8').trim() : null;
  console.log(`daemon:       ${running ? `running (pid ${pid})` : 'stopped'}`);

  if (!fs.existsSync(MEMORY_DIR)) {
    console.log('messages:     0 (no data directory)');
    return;
  }

  let totalMessages = 0;
  let lastReceived = null;
  const files = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md')).sort();

  for (const file of files) {
    const content = fs.readFileSync(path.join(MEMORY_DIR, file), 'utf8');
    const matches = content.match(/^## \d{2}:\d{2} /gm);
    if (matches) totalMessages += matches.length;
    if (matches && matches.length > 0) {
      lastReceived = file.replace('.md', '') + ' ' + matches[matches.length - 1].replace(/^## /, '').trim();
    }
  }

  console.log(`messages:     ${totalMessages}`);
  console.log(`last received: ${lastReceived || 'none'}`);
  console.log(`data dir:     ${DATA_DIR}`);
}

async function setup() {
  ensureDataDir();

  console.log('cc-channel-mem setup\n');
  console.log('This will create ~/.cc-channel-mem/.env with your bot tokens.');
  console.log('Leave blank to skip a platform.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((res) => rl.question(q, res));

  const discordToken = await ask('Discord Bot Token: ');
  const discordGuilds = await ask('Discord allowed guild IDs (comma-separated, blank = all): ');
  const discordChannels = await ask('Discord allowed channel IDs (comma-separated, blank = all): ');
  const telegramToken = await ask('Telegram Bot Token: ');
  const telegramChats = await ask('Telegram allowed chat IDs (comma-separated, blank = all): ');

  rl.close();

  const lines = [];
  if (discordToken.trim()) lines.push(`DISCORD_BOT_TOKEN=${discordToken.trim()}`);
  if (discordGuilds.trim()) lines.push(`DISCORD_ALLOWED_GUILD_IDS=${discordGuilds.trim()}`);
  if (discordChannels.trim()) lines.push(`DISCORD_ALLOWED_CHANNEL_IDS=${discordChannels.trim()}`);
  if (telegramToken.trim()) lines.push(`TELEGRAM_BOT_TOKEN=${telegramToken.trim()}`);
  if (telegramChats.trim()) lines.push(`TELEGRAM_ALLOWED_CHAT_IDS=${telegramChats.trim()}`);

  if (lines.length === 0) {
    console.log('\nNo tokens provided — nothing saved.');
    return;
  }

  fs.writeFileSync(ENV_FILE, lines.join('\n') + '\n', 'utf8');
  // Restrict permissions (owner read/write only)
  try { fs.chmodSync(ENV_FILE, 0o600); } catch (_) {}

  console.log(`\nSaved to ${ENV_FILE}`);
  console.log('Run `cc-channel-mem start` to start the daemon.');
}

async function logs() {
  const today = formatDate(new Date());
  const logFile = path.join(MEMORY_DIR, `${today}.md`);

  if (!fs.existsSync(logFile)) {
    console.log(`No messages today (${today})`);
    return;
  }

  process.stdout.write(fs.readFileSync(logFile, 'utf8'));
}

// ─── helpers ─────────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(MEMORY_DIR)) fs.mkdirSync(MEMORY_DIR, { recursive: true });
}

function isRunning() {
  if (!fs.existsSync(PID_FILE)) return false;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    try { fs.unlinkSync(PID_FILE); } catch (_) {}
    return false;
  }
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
