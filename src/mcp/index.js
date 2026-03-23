'use strict';

require('dotenv').config({ path: require('path').join(require('os').homedir(), '.cc-channel-mem', '.env') });

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} = require('@modelcontextprotocol/sdk/types.js');

const fs = require('fs');
const path = require('path');
const os = require('os');

const { openDb, indexFile } = require('../memory/indexer');
const { search } = require('../memory/search');

const DATA_DIR = path.join(os.homedir(), '.cc-channel-mem');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const PID_FILE = path.join(DATA_DIR, 'daemon.pid');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function isDaemonRunning() {
  if (!fs.existsSync(PID_FILE)) return false;
  const pid = parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

function readDailyLog(date) {
  const filePath = path.join(MEMORY_DIR, `${date}.md`);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf8');
}

function countMessages(content) {
  if (!content) return 0;
  return (content.match(/^## \d{2}:\d{2} /gm) || []).length;
}

function totalMessages() {
  if (!fs.existsSync(MEMORY_DIR)) return 0;
  let total = 0;
  for (const f of fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md'))) {
    total += countMessages(fs.readFileSync(path.join(MEMORY_DIR, f), 'utf8'));
  }
  return total;
}

function lastReceived() {
  if (!fs.existsSync(MEMORY_DIR)) return null;
  const files = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md')).sort().reverse();
  for (const f of files) {
    const content = fs.readFileSync(path.join(MEMORY_DIR, f), 'utf8');
    const matches = content.match(/^## (\d{2}:\d{2}) /gm);
    if (matches && matches.length > 0) {
      const time = matches[matches.length - 1].replace(/^## /, '').trim();
      return `${f.replace('.md', '')} ${time}`;
    }
  }
  return null;
}

function readMemoryMd() {
  const p = path.join(DATA_DIR, 'MEMORY.md');
  if (!fs.existsSync(p)) return '';
  return fs.readFileSync(p, 'utf8');
}

/**
 * Summarize a daily log to the N most recent lines
 */
function summarizeLog(content, maxEntries = 20) {
  if (!content) return '';
  const blocks = content.split(/\n(?=## \d{2}:\d{2} )/).filter((b) => b.includes('## '));
  const recent = blocks.slice(-maxEntries);
  return recent.map((b) => {
    const header = b.match(/^## (\d{2}:\d{2}) \[([^\]]+)\] @(\S+)/);
    const summary = b.match(/\nS @\S+: (.+)/);
    if (header && summary) {
      return `${header[1]} [${header[2]}] @${header[3]}: ${summary[1].trim()}`;
    }
    return b.split('\n').filter(Boolean).slice(0, 2).join(' ');
  }).join('\n');
}

// ─── Tool handlers ────────────────────────────────────────────────────────────

async function handleMemSearch({ query, limit = 10 }) {
  if (!query) return { content: [{ type: 'text', text: 'query is required' }], isError: true };

  // Ensure today's file is indexed
  const today = formatDate(new Date());
  const todayFile = path.join(MEMORY_DIR, `${today}.md`);
  if (fs.existsSync(todayFile)) {
    try { indexFile(todayFile); } catch (_) {}
  }

  const results = await search(query, Number(limit));
  if (results.length === 0) {
    return { content: [{ type: 'text', text: 'No results found.' }] };
  }

  const text = results.map((r, i) =>
    `${i + 1}. [${r.date}] [${r.platform} ${r.channelName}] @${r.authorName} (score: ${r.score})\n   ${r.content}`
  ).join('\n\n');

  return { content: [{ type: 'text', text }] };
}

async function handleMemRead({ date, platform } = {}) {
  const targetDate = date || formatDate(new Date());
  const content = readDailyLog(targetDate);

  if (!content) {
    return { content: [{ type: 'text', text: `No log for ${targetDate}` }] };
  }

  let filtered = content;
  if (platform) {
    const lines = content.split('\n');
    const out = [];
    let inBlock = false;
    for (const line of lines) {
      if (line.startsWith('## ')) {
        inBlock = line.toLowerCase().includes(platform.toLowerCase());
      }
      if (inBlock || !line.startsWith('## ')) out.push(line);
    }
    filtered = out.join('\n');
  }

  return { content: [{ type: 'text', text: filtered }] };
}

async function handleMemStatus() {
  const running = isDaemonRunning();
  const total = totalMessages();
  const last = lastReceived();

  let indexedCount = 0;
  try {
    const db = openDb();
    indexedCount = db.prepare('SELECT COUNT(*) AS n FROM chunks').pluck().get() || 0;
  } catch (_) {}

  const text = [
    `daemonRunning: ${running}`,
    `totalMessages: ${total}`,
    `lastReceived:  ${last || 'none'}`,
    `indexedChunks: ${indexedCount}`,
  ].join('\n');

  return { content: [{ type: 'text', text }] };
}

async function handleMemInject({ query } = {}) {
  const today = formatDate(new Date());
  const yesterday = formatDate(new Date(Date.now() - 86400000));

  const todayContent = readDailyLog(today);
  const yestContent = readDailyLog(yesterday);
  const longTerm = readMemoryMd();

  const sections = [];

  const todaySummary = summarizeLog(todayContent);
  if (todaySummary) sections.push(`[최근 채널 대화 — ${today}]\n${todaySummary}`);

  const yestSummary = summarizeLog(yestContent, 10);
  if (yestSummary) sections.push(`[어제 — ${yesterday}]\n${yestSummary}`);

  if (longTerm.trim()) sections.push(`[장기 메모리]\n${longTerm.trim()}`);

  if (sections.length === 0) {
    return { content: [{ type: 'text', text: '<cc-channel-mem>\n(no data yet)\n</cc-channel-mem>' }] };
  }

  const text = `<cc-channel-mem>\n${sections.join('\n\n')}\n</cc-channel-mem>`;
  return { content: [{ type: 'text', text }] };
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'cc-channel-mem', version: '0.1.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'mem_search',
      description: 'Search channel message history with hybrid vector + keyword search',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Natural language search query' },
          limit: { type: 'number', description: 'Max results (default 10)' },
        },
        required: ['query'],
      },
    },
    {
      name: 'mem_read',
      description: 'Read a daily message log',
      inputSchema: {
        type: 'object',
        properties: {
          date: { type: 'string', description: 'YYYY-MM-DD (default: today)' },
          platform: { type: 'string', description: 'Filter by platform: discord | telegram' },
        },
      },
    },
    {
      name: 'mem_status',
      description: 'Get daemon status and message statistics',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'mem_inject',
      description: 'Get today + yesterday summary + long-term memory for session context injection',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional context hint for relevance filtering' },
        },
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params;
  switch (name) {
    case 'mem_search': return handleMemSearch(args || {});
    case 'mem_read':   return handleMemRead(args || {});
    case 'mem_status': return handleMemStatus();
    case 'mem_inject': return handleMemInject(args || {});
    default:
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stderr only — stdout is reserved for MCP protocol
  process.stderr.write('[cc-channel-mem] MCP server running\n');
}

main().catch((err) => {
  process.stderr.write(`[cc-channel-mem] MCP fatal: ${err.message}\n`);
  process.exit(1);
});
