'use strict';

const { openDb } = require('./indexer');

const VECTOR_WEIGHT = 0.6;
const KEYWORD_WEIGHT = 0.4;

// ─── Embedding ────────────────────────────────────────────────────────────────

/**
 * Get embedding vector for a query string.
 * Priority: Ollama nomic-embed-text → Voyage-3 via Anthropic SDK → null (FTS5 only)
 */
async function getEmbedding(text) {
  // Try Ollama first
  try {
    const res = await fetch('http://localhost:11434/api/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'nomic-embed-text', prompt: text }),
      signal: AbortSignal.timeout(3000),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.embedding && data.embedding.length > 0) return data.embedding;
    }
  } catch (_) {}

  // Try Voyage-3 via Anthropic SDK
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (apiKey) {
    try {
      const res = await fetch('https://api.voyageai.com/v1/embeddings', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ model: 'voyage-3', input: [text] }),
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const data = await res.json();
        const emb = data?.data?.[0]?.embedding;
        if (emb && emb.length > 0) return emb;
      }
    } catch (_) {}
  }

  return null;
}

/**
 * Cosine similarity between two float arrays
 */
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, normA = 0, normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Serialize float array to BLOB (little-endian Float32)
 */
function floatArrayToBlob(arr) {
  const buf = Buffer.allocUnsafe(arr.length * 4);
  for (let i = 0; i < arr.length; i++) buf.writeFloatLE(arr[i], i * 4);
  return buf;
}

/**
 * Deserialize BLOB → float array
 */
function blobToFloatArray(blob) {
  if (!blob) return null;
  const buf = Buffer.isBuffer(blob) ? blob : Buffer.from(blob);
  const arr = new Array(buf.length / 4);
  for (let i = 0; i < arr.length; i++) arr[i] = buf.readFloatLE(i * 4);
  return arr;
}

// ─── Search ───────────────────────────────────────────────────────────────────

/**
 * Hybrid search: FTS5 keyword + optional vector cosine re-rank
 *
 * @param {string} query
 * @param {number} limit
 * @returns {Promise<Array>}  [{date, platform, channel, author, content, score}]
 */
async function search(query, limit = 10) {
  const db = openDb();

  // ── FTS5 keyword search ──────────────────────────────────────────────────
  let ftsRows = [];
  try {
    // Escape special FTS5 characters
    const safeQuery = query
      .replace(/['"()\-]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(Boolean)
      .map((t) => t + '*')
      .join(' ');
    if (safeQuery) {
      ftsRows = db.prepare(`
        SELECT c.id, c.date, c.platform, c.channel, c.author, c.content, c.embedding,
               rank AS bm25_rank
        FROM chunks_fts
        JOIN chunks c ON c.id = chunks_fts.rowid
        WHERE chunks_fts MATCH ?
        ORDER BY rank
        LIMIT ?
      `).all(safeQuery, limit * 3);
    }
  } catch (_) {}

  // ── Fallback: full table scan when FTS returns nothing ───────────────────
  if (ftsRows.length === 0) {
    ftsRows = db.prepare(
      'SELECT id, date, platform, channel, author, content, embedding, 0 AS bm25_rank FROM chunks ORDER BY id DESC LIMIT ?'
    ).all(limit * 3);
  }

  // ── Vector re-rank (if embedding available) ──────────────────────────────
  const queryEmb = await getEmbedding(query);

  const scored = ftsRows.map((row) => {
    const keywordScore = 1 / (1 + Math.abs(row.bm25_rank || 0));
    let vectorScore = 0;
    if (queryEmb) {
      const rowEmb = blobToFloatArray(row.embedding);
      vectorScore = rowEmb ? cosineSimilarity(queryEmb, rowEmb) : 0;
    }
    const score = queryEmb
      ? VECTOR_WEIGHT * vectorScore + KEYWORD_WEIGHT * keywordScore
      : keywordScore;

    return {
      date: row.date,
      platform: row.platform,
      channelName: row.channel,
      authorName: row.author,
      content: row.content,
      score: Math.round(score * 1000) / 1000,
    };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

/**
 * Store embedding for a chunk (called lazily when embedding is available)
 */
async function embedAndStore() {
  const db = openDb();
  const rows = db.prepare('SELECT id, content FROM chunks WHERE embedding IS NULL LIMIT 50').all();
  if (rows.length === 0) return;

  for (const row of rows) {
    const emb = await getEmbedding(row.content);
    if (emb) {
      const blob = floatArrayToBlob(emb);
      db.prepare('UPDATE chunks SET embedding = ? WHERE id = ?').run(blob, row.id);
    }
  }
}

module.exports = { search, embedAndStore };
