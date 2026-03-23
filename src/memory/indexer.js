'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const chokidar = require('chokidar');
const Database = require('better-sqlite3');

const DATA_DIR = path.join(os.homedir(), '.cc-channel-mem');
const MEMORY_DIR = path.join(DATA_DIR, 'memory');
const DB_PATH = path.join(DATA_DIR, 'main.sqlite');

const CHUNK_SIZE = 512;
const CHUNK_OVERLAP = 64;

let db = null;

// ─── DB init ──────────────────────────────────────────────────────────────────

function openDb() {
  if (db) return db;
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');

  db.exec(`
    CREATE TABLE IF NOT EXISTS chunks (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      date      TEXT NOT NULL,
      platform  TEXT,
      channel   TEXT,
      author    TEXT,
      content   TEXT NOT NULL,
      embedding BLOB
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content,
      date UNINDEXED,
      platform UNINDEXED,
      channel UNINDEXED,
      author UNINDEXED,
      content='chunks',
      content_rowid='id'
    );

    CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
      INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;

    CREATE TABLE IF NOT EXISTS indexed_files (
      path  TEXT PRIMARY KEY,
      mtime REAL NOT NULL
    );
  `);

  return db;
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

/**
 * Parse a daily log .md file into message records
 * Returns [{date, platform, channel, author, content}]
 */
function parseLogFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const dateMatch = path.basename(filePath).match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  const date = dateMatch ? dateMatch[1] : 'unknown';

  const records = [];
  // Each entry starts with "## HH:MM [Platform — #channel] @author"
  const blocks = raw.split(/\n(?=## \d{2}:\d{2} )/);

  for (const block of blocks) {
    const headerMatch = block.match(/^## \d{2}:\d{2} \[([^\]]+)\] @(\S+)\n([\s\S]*?)(?:\nS @\S+:.*)?$/);
    if (!headerMatch) continue;

    const platformChannel = headerMatch[1]; // e.g. "Discord — #dev-channel"
    const author = headerMatch[2];
    const content = headerMatch[3].trim();
    if (!content) continue;

    const parts = platformChannel.split(' — ');
    const platform = parts[0] ? parts[0].toLowerCase() : 'unknown';
    const channel = parts[1] || platformChannel;

    records.push({ date, platform, channel, author, content });
  }

  return records;
}

/**
 * Sliding window chunking
 */
function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP) {
  if (text.length <= size) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    chunks.push(text.slice(start, start + size));
    start += size - overlap;
  }
  return chunks;
}

// ─── Indexing ─────────────────────────────────────────────────────────────────

function isFileIndexed(filePath) {
  const db = openDb();
  const stat = fs.statSync(filePath);
  const row = db.prepare('SELECT mtime FROM indexed_files WHERE path = ?').get(filePath);
  return row && row.mtime >= stat.mtimeMs;
}

function markFileIndexed(filePath) {
  const db = openDb();
  const stat = fs.statSync(filePath);
  db.prepare('INSERT OR REPLACE INTO indexed_files (path, mtime) VALUES (?, ?)').run(filePath, stat.mtimeMs);
}

function clearFileChunks(filePath) {
  const db = openDb();
  const dateMatch = path.basename(filePath).match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  if (!dateMatch) return;
  db.prepare('DELETE FROM chunks WHERE date = ?').run(dateMatch[1]);
}

function indexFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const db = openDb();
  const records = parseLogFile(filePath);
  if (records.length === 0) return;

  clearFileChunks(filePath);

  const insert = db.prepare(
    'INSERT INTO chunks (date, platform, channel, author, content) VALUES (?, ?, ?, ?, ?)'
  );
  const insertMany = db.transaction((recs) => {
    for (const rec of recs) {
      const chunks = chunkText(rec.content);
      for (const chunk of chunks) {
        insert.run(rec.date, rec.platform, rec.channel, rec.author, chunk);
      }
    }
  });
  insertMany(records);

  markFileIndexed(filePath);
  console.log(`[indexer] indexed ${filePath} (${records.length} messages)`);
}

// ─── Watcher ──────────────────────────────────────────────────────────────────

let watcher = null;

function startIndexer() {
  openDb();

  // Index existing files that are stale or new
  if (fs.existsSync(MEMORY_DIR)) {
    const files = fs.readdirSync(MEMORY_DIR).filter((f) => f.endsWith('.md'));
    for (const f of files) {
      const full = path.join(MEMORY_DIR, f);
      if (!isFileIndexed(full)) indexFile(full);
    }
  }

  watcher = chokidar.watch(path.join(MEMORY_DIR, '*.md'), {
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
  });

  watcher.on('add', indexFile);
  watcher.on('change', indexFile);
  console.log('[indexer] watching', MEMORY_DIR);
}

function stopIndexer() {
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { startIndexer, stopIndexer, openDb, indexFile, DB_PATH };
