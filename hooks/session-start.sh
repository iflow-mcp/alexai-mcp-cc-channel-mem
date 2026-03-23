#!/bin/sh
# cc-channel-mem SessionStart Hook
# Claude Code settings.json 에 등록:
#   "hooks": {
#     "SessionStart": [{"matcher":"","hooks":[{"type":"command","command":"~/.cc-channel-mem/hooks/session-start.sh"}]}]
#   }

MCP_SCRIPT="$(dirname "$(dirname "$(realpath "$0")")")/src/mcp/index.js"

if [ ! -f "$MCP_SCRIPT" ]; then
  exit 0
fi

# Call mem_inject via node directly (no MCP transport needed for hooks)
node - <<'EOF'
const path = require('path');
const os   = require('os');
const fs   = require('fs');

const DATA_DIR   = path.join(os.homedir(), '.cc-channel-mem');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const MEMORY_MD  = path.join(DATA_DIR, 'MEMORY.md');

function formatDate(d) {
  return d.toISOString().slice(0, 10);
}

function readLog(date) {
  const f = path.join(MEMORY_DIR, date + '.md');
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : null;
}

function summarize(content, max) {
  if (!content) return '';
  const blocks = content.split(/\n(?=## \d{2}:\d{2} )/).filter(b => b.includes('##'));
  return blocks.slice(-max).map(b => {
    const h = b.match(/^## (\d{2}:\d{2}) \[([^\]]+)\] @(\S+)/);
    const s = b.match(/\nS @\S+: (.+)/);
    return (h && s) ? h[1] + ' [' + h[2] + '] @' + h[3] + ': ' + s[1].trim() : '';
  }).filter(Boolean).join('\n');
}

const today     = formatDate(new Date());
const yesterday = formatDate(new Date(Date.now() - 86400000));
const longTerm  = fs.existsSync(MEMORY_MD) ? fs.readFileSync(MEMORY_MD, 'utf8').trim() : '';

const sections = [];
const ts = summarize(readLog(today), 20);
if (ts) sections.push('[최근 채널 대화 — ' + today + ']\n' + ts);
const ys = summarize(readLog(yesterday), 10);
if (ys) sections.push('[어제 — ' + yesterday + ']\n' + ys);
if (longTerm) sections.push('[장기 메모리]\n' + longTerm);

if (sections.length > 0) {
  process.stdout.write('<cc-channel-mem>\n' + sections.join('\n\n') + '\n</cc-channel-mem>\n');
}
EOF
