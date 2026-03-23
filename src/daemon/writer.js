'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.cc-channel-mem');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');

/**
 * Ensure ~/.cc-channel-mem/memory/ exists
 */
function ensureMemoryDir() {
  if (!fs.existsSync(MEMORY_DIR)) {
    fs.mkdirSync(MEMORY_DIR, { recursive: true });
  }
}

/**
 * Format a Date as YYYY-MM-DD
 */
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/**
 * Format a Date as HH:MM (local time)
 */
function formatTime(date) {
  const h = String(date.getHours()).padStart(2, '0');
  const m = String(date.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

/**
 * Generate a 50-char summary (or full content if shorter)
 */
function summarize(content) {
  const trimmed = content.trim().replace(/\n+/g, ' ');
  return trimmed.length <= 50 ? trimmed : trimmed.slice(0, 47) + '...';
}

/**
 * Platform display name
 */
function platformLabel(platform) {
  if (platform === 'discord') return 'Discord';
  if (platform === 'telegram') return 'Telegram';
  return platform;
}

/**
 * Write a single message to the daily log file.
 *
 * @param {object} msg
 * @param {string} msg.platform     'discord' | 'telegram'
 * @param {string} msg.channelId    channel or chat ID
 * @param {string} msg.channelName  display name (#dev-channel, @AlexMemBot, etc.)
 * @param {string} msg.authorId
 * @param {string} msg.authorName
 * @param {string} msg.content      raw message text
 * @param {Date}   msg.timestamp
 */
async function writeMessage({ platform, channelId, channelName, authorId, authorName, content, timestamp }) {
  // Skip empty content
  if (!content || !content.trim()) return;

  ensureMemoryDir();

  const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
  const dateStr = formatDate(date);
  const timeStr = formatTime(date);
  const filePath = path.join(MEMORY_DIR, `${dateStr}.md`);

  const header = `## ${timeStr} [${platformLabel(platform)} — ${channelName}] @${authorName}\n`;
  const body = `${content.trim()}\n`;
  const summary = `S @${authorName}: ${summarize(content)}\n`;
  const entry = `\n${header}${body}${summary}`;

  // Sync write — data durability over performance
  if (!fs.existsSync(filePath)) {
    const fileHeader = `# ${dateStr}\n`;
    fs.writeFileSync(filePath, fileHeader + entry, 'utf8');
  } else {
    fs.appendFileSync(filePath, entry, 'utf8');
  }
}

function ensureDataDir() {
  ensureMemoryDir();
}

module.exports = { writeMessage, ensureDataDir, DATA_DIR, MEMORY_DIR };
