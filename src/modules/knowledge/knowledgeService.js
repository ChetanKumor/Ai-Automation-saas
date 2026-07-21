const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('../../db/db');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });

// `signal` (Issue 29): the voice turn's combined close/deadline AbortSignal —
// aborts the in-flight embedding fetch. Absent (WhatsApp path, ingestion),
// behavior is unchanged.
async function embed(text, signal = null) {
  const request = {
    content: { parts: [{ text }] },
    outputDimensionality: 768
  };
  const result = signal
    ? await embeddingModel.embedContent(request, { signal })
    : await embeddingModel.embedContent(request);
  return result.embedding.values;
}

async function storeChunks(tenantId, chunks, source) {
  for (const chunk of chunks) {
    const embedding = await embed(chunk);
    await db.query(
      `INSERT INTO knowledge_chunks (tenant_id, content, embedding, source)
       VALUES ($1, $2, $3::vector, $4)`,
      [tenantId, chunk, `[${embedding.join(',')}]`, source]
    );
  }
  return chunks.length;
}

async function getRelevantChunks(tenantId, query, topK = 3, { signal = null } = {}) {
  const queryEmbedding = await embed(query, signal);
  // `id` rides along for trace retrieval provenance (Issue 22) — every
  // consumer reads only content/similarity, so this is capture-only.
  const { rows } = await db.query(
    `SELECT id, content, 1 - (embedding <=> $2::vector) AS similarity
     FROM knowledge_chunks
     WHERE tenant_id = $1
     ORDER BY embedding <=> $2::vector
     LIMIT $3`,
    [tenantId, `[${queryEmbedding.join(',')}]`, topK]
  );
  return rows;
}

function chunkText(text, maxLen = 500, overlap = 50) {
  const paragraphs = text.split(/\n\s*\n/);
  const chunks = [];
  let current = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

    if (current && (current.length + trimmed.length + 1) > maxLen) {
      chunks.push(current.trim());
      // Keep tail of previous chunk as overlap
      current = current.slice(-overlap) + ' ' + trimmed;
    } else {
      current = current ? current + '\n' + trimmed : trimmed;
    }
  }
  if (current.trim()) chunks.push(current.trim());

  return chunks;
}

// ── Per-row CRUD (PORTAL-P4-S11) ─────────────────────────────────────────────
// storeChunks/getRelevantChunks above are the ingestion/retrieval pair; the
// portal's FAQ (and future document) editors need per-row ownership instead —
// get/list/create/update/delete ONE chunk, tenant-scoped. Layered here rather
// than in the portal route per this session's rule: no raw SQL from routes.js.
//
// createChunk/updateChunk call `module.exports.embed`, not the bare `embed`
// reference, on purpose: tests stub it via node:test's
// `mock.method(knowledgeService, 'embed', ...)` to avoid a live Gemini call on
// every save, and that mock is only visible through the exported binding.

function isUuid(v) {
  return typeof v === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

async function listChunks(tenantId) {
  const { rows } = await db.query(
    `SELECT id, content, source, created_at FROM knowledge_chunks
     WHERE tenant_id = $1 ORDER BY created_at`,
    [tenantId]
  );
  return rows;
}

// One chunk, tenant-scoped. Returns null when the id belongs to another
// tenant (or isn't a UUID at all) — a crafted id is inert, not an information
// leak or a 500 (INV-1).
async function getChunk(tenantId, id) {
  if (!isUuid(id)) return null;
  const { rows } = await db.query(
    `SELECT id, content, source, created_at FROM knowledge_chunks
     WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  return rows[0] || null;
}

// Chunks whose source is exactly `prefix` or `prefix:<anything>` (the
// language-tag convention faqService uses on this column).
async function countChunksBySourcePrefix(tenantId, prefix) {
  const { rows } = await db.query(
    `SELECT count(*)::int AS n FROM knowledge_chunks
     WHERE tenant_id = $1 AND (source = $2 OR source LIKE $2 || ':%')`,
    [tenantId, prefix]
  );
  return rows[0].n;
}

async function createChunk(tenantId, { content, source }) {
  const embedding = await module.exports.embed(content);
  const { rows } = await db.query(
    `INSERT INTO knowledge_chunks (tenant_id, content, source, embedding)
     VALUES ($1, $2, $3, $4::vector) RETURNING id, content, source, created_at`,
    [tenantId, content, source, `[${embedding.join(',')}]`]
  );
  return rows[0];
}

// Re-embeds only when the text actually changed — an edit that only touches
// the language tag (or resaves identical content) doesn't need a fresh vector
// for text that hasn't moved. Returns null when the id isn't this tenant's.
async function updateChunk(tenantId, id, { content, source }) {
  const existing = await getChunk(tenantId, id);
  if (!existing) return null;

  if (content === existing.content) {
    const { rows } = await db.query(
      `UPDATE knowledge_chunks SET source = $3
       WHERE tenant_id = $1 AND id = $2 RETURNING id, content, source, created_at`,
      [tenantId, id, source]
    );
    return rows[0];
  }

  const embedding = await module.exports.embed(content);
  const { rows } = await db.query(
    `UPDATE knowledge_chunks SET content = $3, source = $4, embedding = $5::vector
     WHERE tenant_id = $1 AND id = $2 RETURNING id, content, source, created_at`,
    [tenantId, id, content, source, `[${embedding.join(',')}]`]
  );
  return rows[0];
}

// Returns false (not an error) when the id isn't this tenant's — same
// crafted-id-is-inert contract as getChunk.
async function deleteChunk(tenantId, id) {
  if (!isUuid(id)) return false;
  const { rowCount } = await db.query(
    `DELETE FROM knowledge_chunks WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id]
  );
  return rowCount > 0;
}

module.exports = {
  embed, storeChunks, getRelevantChunks, chunkText,
  listChunks, getChunk, countChunksBySourcePrefix, createChunk, updateChunk, deleteChunk,
};
