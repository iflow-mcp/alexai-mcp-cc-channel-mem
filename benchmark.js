'use strict';

/**
 * cc-channel-mem composite benchmark
 *
 * Measures 3 metrics and outputs a single composite score (higher = better):
 *   score = search_mrr*40 + curation_rate*30 + write_perf*30
 *
 * Usage: node benchmark.js
 * Output last line: SCORE=<number>
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── Setup: write test fixtures to a temp dir ─────────────────────────────────

const TMP_DIR = path.join(os.tmpdir(), 'ccmem-bench-' + Date.now());
const MEMORY_DIR = path.join(TMP_DIR, 'memory');
fs.mkdirSync(MEMORY_DIR, { recursive: true });

// Patch DATA_DIR / MEMORY_DIR used by modules
process.env.CCMEM_DATA_DIR = TMP_DIR;

// Monkey-patch os.homedir so modules resolve to our temp dir
const origHomedir = os.homedir.bind(os);
os.homedir = () => {
  // Only intercept paths going into .cc-channel-mem
  return TMP_DIR.replace(/[/\\]\.cc-channel-mem.*/, '');
};

// We override DATA_DIR by directly writing test logs to TMP_DIR/memory/

const TEST_LOG = `# 2026-03-23

## 09:42 [Discord — #dev-channel] @Alex
강남 프로젝트 식재 수종 느티나무로 최종 확정.
S @Alex: 강남 프로젝트 식재 수종 느티나무로 최종 확정.

## 14:15 [Discord — #dev-channel] @Alex
EcoPro BM 손절 기준 -15%로 설정하기로 결정.
S @Alex: EcoPro BM 손절 기준 -15%로 설정하기로 결정.

## 16:30 [Telegram — @AlexMemBot] @Alex
다음 세션에서 강남 프로젝트 Blender 모델링 시작 예정.
S @Alex: 다음 세션에서 강남 프로젝트 Blender 모델링 시작 예정.

## 10:00 [Discord — #dev-channel] @Alex
Ontology MVP 개발 진행 중.
S @Alex: Ontology MVP 개발 진행 중.

## 11:00 [Discord — #dev-channel] @Alex
배성민과 파트너십 계약 검토 중.
S @Alex: 배성민과 파트너십 계약 검토 중.
`;

fs.writeFileSync(path.join(MEMORY_DIR, '2026-03-23.md'), TEST_LOG, 'utf8');

// ── Metric 1: Write Performance (lower ms → higher perf score) ──────────────

async function measureWritePerf() {
  const { writeMessage } = require('./src/daemon/writer');
  // Override MEMORY_DIR in writer by using env patching (writer uses os.homedir)
  // We'll measure directly
  const tmpLog = path.join(TMP_DIR, 'perf-test.md');

  const N = 100;
  const start = performance.now();
  for (let i = 0; i < N; i++) {
    const content = `메시지 번호 ${i}: 테스트 내용입니다.`;
    // Use fs directly (same pattern as writer.js)
    const entry = `\n## 09:${String(i % 60).padStart(2,'0')} [Discord — #test] @user\n${content}\nS @user: ${content.slice(0,50)}\n`;
    if (i === 0) {
      fs.writeFileSync(tmpLog, `# 2026-03-23\n${entry}`, 'utf8');
    } else {
      fs.appendFileSync(tmpLog, entry, 'utf8');
    }
  }
  const elapsed = performance.now() - start;
  // Score: 1000ms baseline = 30pts, faster = more pts (capped at 60)
  const perfScore = Math.min(60, (500 / elapsed) * 30);
  console.log(`[bench] write: ${N} messages in ${elapsed.toFixed(1)}ms → perf_score=${perfScore.toFixed(2)}`);
  return perfScore;
}

// ── Metric 2: Curation Quality (extraction_rate) ─────────────────────────────

async function measureCurationQuality() {
  // Use the actual curator module so changes to patterns are measured correctly
  // Clear require cache to pick up latest version
  delete require.cache[require.resolve('./src/memory/curator')];
  const { extractFromLog } = require('./src/memory/curator');

  const logFile = path.join(MEMORY_DIR, '2026-03-23.md');
  const raw = fs.readFileSync(logFile, 'utf8');
  // Count total messages (blocks with S-summary)
  const totalMessages = (raw.match(/\nS @\S+:/g) || []).length;
  const extracted = extractFromLog(logFile);
  const rate = totalMessages > 0 ? extracted.length / totalMessages : 0;
  // Score: rate * 30 (max 30 if all messages classified)
  const curationScore = rate * 30;
  console.log(`[bench] curation: ${extracted.length}/${totalMessages} messages extracted → rate=${rate.toFixed(3)} → curation_score=${curationScore.toFixed(2)}`);
  return curationScore;
}

// ── Metric 3: Search Quality (MRR via FTS5) ───────────────────────────────────

async function measureSearchQuality() {
  // Index test data into a temp SQLite DB
  const Database = require('better-sqlite3');
  const DB_PATH = path.join(TMP_DIR, 'bench.sqlite');
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT, platform TEXT, channel TEXT, author TEXT, content TEXT, embedding BLOB
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content, date UNINDEXED, platform UNINDEXED, channel UNINDEXED, author UNINDEXED,
      content='chunks', content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
    END;
  `);

  // Insert test chunks
  const testChunks = [
    { date: '2026-03-23', platform: 'discord', channel: '#dev', author: 'Alex', content: '강남 프로젝트 식재 수종 느티나무로 최종 확정' },
    { date: '2026-03-23', platform: 'discord', channel: '#dev', author: 'Alex', content: 'EcoPro BM 손절 기준 -15%로 설정하기로 결정' },
    { date: '2026-03-23', platform: 'telegram', channel: '@bot', author: 'Alex', content: '다음 세션에서 강남 프로젝트 Blender 모델링 시작 예정' },
    { date: '2026-03-23', platform: 'discord', channel: '#dev', author: 'Alex', content: 'Ontology MVP 개발 진행 중' },
    { date: '2026-03-23', platform: 'discord', channel: '#dev', author: 'Alex', content: '배성민과 파트너십 계약 검토 중' },
  ];

  const insert = db.prepare('INSERT INTO chunks (date, platform, channel, author, content) VALUES (?, ?, ?, ?, ?)');
  for (const c of testChunks) insert.run(c.date, c.platform, c.channel, c.author, c.content);

  // Test queries with known relevant chunk index (0-based)
  const testCases = [
    { query: '느티나무', relevantIdx: 0 },
    { query: '손절 기준', relevantIdx: 1 },
    { query: 'Blender 모델링', relevantIdx: 2 },
    { query: 'Ontology MVP', relevantIdx: 3 },
    { query: '파트너십', relevantIdx: 4 },
  ];

  const { VECTOR_WEIGHT, KEYWORD_WEIGHT } = (() => {
    // Read current weights from search.js
    const src = fs.readFileSync(path.join(__dirname, 'src/memory/search.js'), 'utf8');
    const vw = parseFloat((src.match(/VECTOR_WEIGHT\s*=\s*([\d.]+)/) || [,0.6])[1]);
    const kw = parseFloat((src.match(/KEYWORD_WEIGHT\s*=\s*([\d.]+)/) || [,0.4])[1]);
    return { VECTOR_WEIGHT: vw, KEYWORD_WEIGHT: kw };
  })();

  let totalRR = 0;
  for (const tc of testCases) {
    const safeQuery = tc.query
      .replace(/['"()\-]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t + '*')
      .join(' ');
    let rows = [];
    try {
      rows = db.prepare(`
        SELECT c.id, c.content, rank AS bm25_rank
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY rank
        LIMIT 10
      `).all(safeQuery);
    } catch (_) {}

    if (rows.length === 0) {
      rows = db.prepare('SELECT id, content, 0 AS bm25_rank FROM chunks ORDER BY id DESC LIMIT 10').all();
    }

    const scored = rows.map(r => ({
      id: r.id,
      score: 1 / (1 + Math.abs(r.bm25_rank || 0)),
    })).sort((a, b) => b.score - a.score);

    // Find rank of relevant chunk (chunk ids are 1-based)
    const relevantId = tc.relevantIdx + 1;
    const rank = scored.findIndex(r => r.id === relevantId) + 1;
    const rr = rank > 0 ? 1 / rank : 0;
    totalRR += rr;
  }

  db.close();
  fs.unlinkSync(DB_PATH);

  const mrr = totalRR / testCases.length;
  const searchScore = mrr * 40;
  console.log(`[bench] search: MRR=${mrr.toFixed(3)} → search_score=${searchScore.toFixed(2)}`);
  return searchScore;
}

// ── Run all and compute composite ─────────────────────────────────────────────

async function main() {
  console.log('[bench] starting cc-channel-mem benchmark');
  const [writeScore, curationScore, searchScore] = await Promise.all([
    measureWritePerf(),
    measureCurationQuality(),
    measureSearchQuality(),
  ]);

  const composite = writeScore + curationScore + searchScore;
  console.log(`[bench] composite: write=${writeScore.toFixed(2)} + curation=${curationScore.toFixed(2)} + search=${searchScore.toFixed(2)}`);
  console.log(`SCORE=${composite.toFixed(4)}`);

  // Cleanup
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
}

main().catch(err => {
  console.error('[bench] error:', err.message);
  process.exit(1);
});
