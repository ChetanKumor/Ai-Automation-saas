const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('../../db/db');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });

// The deadline for ONE embedding call, in ms. Read at call time so tests can
// vary it per case (the same shape as internalVoice.js:65-68's turnBudgetMs).
//
// 3,000 ms is derived, not picked — see docs/os/decisions.md D-010. Measured
// this session through this very function against the live model (5 samples,
// one machine, one region — not a distribution): 459 / 543 / 546 / 625 ms warm,
// and 2,555 ms on the first call of a cold process, which pays the TLS
// handshake. That cold call is the FLOOR: a deadline below ~2.6 s would fire on
// the first turn after every deploy. The CEILING is the voice turn budget —
// 8,000 ms (internalVoice.js:65-68), less 300–465 ms hydration (01-map.md:75) —
// which must still leave generation, up to two tool rounds and persistence room
// to finish. 3,000 ms clears the cold call, is ~5.5x the warm median, and leaves
// 5,000 ms downstream.
const DEFAULT_EMBED_TIMEOUT_MS = 3000;

function embedTimeoutMs() {
  const v = parseInt(process.env.EMBED_TIMEOUT_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_EMBED_TIMEOUT_MS;
}

// A deadline expiry is NOT just another RAG error. contextAssembler.js:68 logs
// every retrieval failure through one line, so a `22P02` from a malformed tenant
// id and a Google outage are already indistinguishable there (05-isolation.md
// P5-3). This carries its own `code` so the new timeout does not become a third
// case collapsed into that bucket.
class EmbedTimeoutError extends Error {
  constructor(ms) {
    super(`embedding call exceeded its ${ms}ms deadline`);
    this.name = 'EmbedTimeoutError';
    this.code = 'EMBED_TIMEOUT';
  }
}

// `signal` (Issue 29): the voice turn's combined close/deadline AbortSignal —
// aborts the in-flight embedding fetch.
//
// The deadline lives INSIDE this body rather than in a wrapper around the export,
// and that is load-bearing: getRelevantChunks:106 calls this local binding while
// createChunk/updateChunk call `module.exports.embed` (see :148-151 below). A
// wrapper on the export would bound four callers and miss R1 — the one call on
// the patient-facing path. Here, all six entry points inherit it.
//
// The internal deadline COMPOSES with `signal`, it does not replace it: a caller
// that passes one still aborts early (the voice turn giving up at 8,000 ms), and
// a caller that passes nothing — WhatsApp, the portal FAQ save, the provisioning
// CLI, validation, the portal test-turn — is bounded anyway, where before it was
// bounded by nothing at all.
async function embed(text, signal = null) {
  const request = {
    content: { parts: [{ text }] },
    outputDimensionality: 768
  };

  // An already-aborted caller signal must never reach the SDK: it wires signals
  // with addEventListener (dist/index.js:448-452), which never fires for a signal
  // that aborted before the listener was attached — the fetch would go out with a
  // controller nothing can trip. Refuse before dispatch instead.
  if (signal && signal.aborted) {
    throw Object.assign(new Error('embedding aborted before dispatch'), { name: 'AbortError' });
  }

  const ms = embedTimeoutMs();
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ms);
  const relayAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', relayAbort, { once: true });

  try {
    // Passing `signal` is what makes the bound real: buildFetchOptions
    // (dist/index.js:441-456) constructs an AbortController — and therefore a
    // cancellable fetch — ONLY when `signal !== undefined || timeout >= 0`. With
    // no second argument it returns `{}`, a bare fetch with no deadline.
    const result = await embeddingModel.embedContent(request, { signal: controller.signal });
    return result.embedding.values;
  } catch (err) {
    // The caller's abort and our deadline both surface from the SDK as the same
    // AbortError. Only this frame knows which fired.
    if (timedOut) throw new EmbedTimeoutError(ms);
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relayAbort);
  }
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
