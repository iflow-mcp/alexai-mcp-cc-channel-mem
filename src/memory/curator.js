'use strict';

/**
 * curator.js — MEMORY.md 자동 업데이트
 *
 * 일일 로그에서 안정적 사실/결정/선호를 추출해 MEMORY.md 장기 메모리를 갱신한다.
 * Claude API 없이도 동작하는 규칙 기반 추출을 기본으로 하고,
 * ANTHROPIC_API_KEY 있으면 Claude를 통해 고품질 큐레이션을 수행한다.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.cc-channel-mem');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const MEMORY_MD = path.join(DATA_DIR, 'MEMORY.md');

// ─── Rule-based extraction ────────────────────────────────────────────────────

const DECISION_PATTERNS = [
  /확정|결정|완료|선택|채택|합의/,
  /설정하기로|사용하기로|진행하기로|하기로/,
];

const PREFERENCE_PATTERNS = [
  /선호|좋아|싫어|원함|기준|손절|목표|방식|스타일/,
];

const PROJECT_PATTERNS = [
  /프로젝트|작업|개발|구현|설계|모델링|파트너십|계약|협력|검토|미팅|회의/,
];

function classifyContent(content) {
  if (DECISION_PATTERNS.some((p) => p.test(content))) return 'Decisions';
  if (PREFERENCE_PATTERNS.some((p) => p.test(content))) return 'Preferences';
  if (PROJECT_PATTERNS.some((p) => p.test(content))) return 'Projects';
  return null;
}

/**
 * Extract notable entries from a daily log file
 * Returns [{category, text, date}]
 */
function extractFromLog(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const dateMatch = path.basename(filePath).match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  const date = dateMatch ? dateMatch[1] : 'unknown';

  const entries = [];
  const blocks = raw.split(/\n(?=## \d{2}:\d{2} )/);

  for (const block of blocks) {
    // Prefer the S-summary line for concise facts
    const summaryMatch = block.match(/\nS @\S+: (.+)/);
    const content = summaryMatch ? summaryMatch[1].trim() : null;
    if (!content) continue;

    const category = classifyContent(content);
    if (category) {
      entries.push({ category, text: content, date });
    }
  }

  return entries;
}

// ─── Claude-based curation ────────────────────────────────────────────────────

async function curateWithClaude(logContent, existingMemory) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  try {
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic.default({ apiKey });

    const prompt = `You are a memory curator. Given recent channel messages and existing long-term memory, update the long-term memory.

Rules:
- Keep MEMORY.md concise (under 50 lines)
- Add new stable facts, decisions, preferences from the log
- Remove outdated or superseded entries
- Use Korean if the content is Korean
- Output ONLY the new MEMORY.md content, no explanation

## Existing MEMORY.md
${existingMemory || '(empty)'}

## Recent log
${logContent}

## Updated MEMORY.md:`;

    const msg = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    });

    return msg.content[0]?.text || null;
  } catch (_) {
    return null;
  }
}

// ─── MEMORY.md writer ─────────────────────────────────────────────────────────

function parseMemoryMd(content) {
  const sections = { Projects: [], Preferences: [], Decisions: [] };
  let current = null;

  for (const line of content.split('\n')) {
    const sectionMatch = line.match(/^## (.+)/);
    if (sectionMatch) {
      current = sectionMatch[1].trim();
    } else if (current && line.startsWith('- ')) {
      if (sections[current]) sections[current].push(line.slice(2).trim());
    }
  }
  return sections;
}

function buildMemoryMd(sections, date) {
  const lines = ['# Long-term Memory', ''];
  for (const [section, items] of Object.entries(sections)) {
    if (items.length === 0) continue;
    lines.push(`## ${section}`);
    for (const item of items) lines.push(`- ${item}`);
    lines.push('');
  }
  lines.push(`_Last updated: ${date}_`);
  return lines.join('\n');
}

function deduplicateItems(existing, newItems) {
  const seen = new Set(existing.map((s) => s.toLowerCase().trim()));
  const result = [...existing];
  for (const item of newItems) {
    const key = item.toLowerCase().trim();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(item);
    }
  }
  // Keep at most 20 items per section
  return result.slice(-20);
}

// ─── Main curate function ─────────────────────────────────────────────────────

/**
 * Run curation for a specific date's log (default: today)
 */
async function curate(date) {
  const targetDate = date || new Date().toISOString().slice(0, 10);
  const logFile = path.join(MEMORY_DIR, `${targetDate}.md`);

  if (!fs.existsSync(logFile)) {
    console.log(`[curator] no log for ${targetDate}`);
    return;
  }

  const logContent = fs.readFileSync(logFile, 'utf8');
  const existingMemory = fs.existsSync(MEMORY_MD) ? fs.readFileSync(MEMORY_MD, 'utf8') : '';

  // Try Claude first
  const claudeResult = await curateWithClaude(logContent, existingMemory);
  if (claudeResult && claudeResult.trim()) {
    fs.writeFileSync(MEMORY_MD, claudeResult.trim() + '\n', 'utf8');
    console.log(`[curator] updated MEMORY.md via Claude (${targetDate})`);
    return;
  }

  // Fallback: rule-based extraction
  const newEntries = extractFromLog(logFile);
  if (newEntries.length === 0) {
    console.log(`[curator] no notable entries in ${targetDate}`);
    return;
  }

  const sections = existingMemory ? parseMemoryMd(existingMemory) : { Projects: [], Preferences: [], Decisions: [] };

  for (const entry of newEntries) {
    if (!sections[entry.category]) sections[entry.category] = [];
    sections[entry.category] = deduplicateItems(
      sections[entry.category],
      [`${entry.text} (${entry.date})`]
    );
  }

  const updated = buildMemoryMd(sections, targetDate);
  fs.writeFileSync(MEMORY_MD, updated, 'utf8');
  console.log(`[curator] updated MEMORY.md via rules (${newEntries.length} entries, ${targetDate})`);
}

module.exports = { curate, extractFromLog, classifyContent };
