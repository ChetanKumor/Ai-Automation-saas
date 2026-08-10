const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('../../db/db');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const embeddingModel = genAI.getGenerativeModel({ model: 'gemini-embedding-001' });

// ── The deadline for ONE embedding call, per BUDGET CLASS ────────────────────
//
// D-010 bounded every embedding call at a single 3,000 ms constant. It was right
// that the call needed a bound and wrong that there was one bound: this function
// has three kinds of caller with unrelated budgets, and 3,000 ms was derived from
// exactly one of them. D-010's own recorded falsifier fired — in the suite rather
// than in production — when the portal FAQ save, which has no turn budget at all,
// exceeded a deadline derived from the voice turn's. See D-011.
//
// Each class names the budget it serves and what its number rests on. Every
// value is read at call time, the same shape as internalVoice.js:65-68's
// turnBudgetMs, so tests vary it per case instead of sleeping.
//
//   turn — getRelevantChunks below. Six production entry points (01-map.md §2.2);
//     the voice one must finish inside 8,000 ms (internalVoice.js:65-68) less
//     300–465 ms hydration, with generation, up to two tool rounds and outbound
//     persistence still to come. UNCHANGED at D-010's derived 3,000 ms — this
//     session scopes that derivation to the path it was derived for, it does not
//     revisit it. The asymmetry that justified the small value is still true only
//     here: a spurious expiry costs GROUNDING ON ONE TURN, because
//     contextAssembler.js:67-70 returns [] and the zero-chunk prompt still
//     carries the instruction not to invent (D-010's change 4). Firing early is
//     cheap; overrunning the turn budget loses the whole call.
//
//   interactive — createChunk / updateChunk below: an owner clicking Save in the
//     portal. 10,000 ms.
//     CEILING: nothing else on that request can end it — Node's server.timeout
//     defaults to 0 and public/portal/faqs.js sets no fetch timeout
//     (02-ingestion.md §D.3) — so this IS the request's bound. The largest bound
//     any other step carries is DB_STATEMENT_TIMEOUT_MS = 5,000 ms (db.js:16-23),
//     and §D.3's table lists five DB steps on this save, two of them plural — so
//     the route already tolerates tens of seconds of database. 10,000 ms keeps
//     the embedding call well inside a tail the request already has.
//     FLOOR: 3,000 ms is the only value ever observed to FIRE on this path, so
//     headroom is measured from it, not from the last healthy sample. Cold calls
//     have measured 613 / 653 / 756 ms (Session 3, under the same 20-way suite
//     parallelism that produced the red), 2,555 ms (D-010, uncontended), and
//     above 3,000 ms (Session 3's first attempt, under parallelism) — a spread of
//     at least 4.9x on one machine, one network, one region. 5,000 ms would sit
//     1.7x above the value known to fire, inside that spread. 10,000 ms sits 3.3x
//     above it, outside it. A spurious expiry here is a 500 on a save the owner
//     watched fail; a late one costs them patience.
//
//   batch — storeChunks below, reached only from scripts/ingest-knowledge.js and
//     provisioningService.ingestKnowledge:147. An operator at a terminal: no
//     socket, no budget, nothing waiting. 30,000 ms.
//     FLOOR: >=10x every cold measurement in the register and >=10x the value
//     known to fire. A batch call that reaches 30 s is wedged, not slow. It has
//     to be this generous because a spurious expiry here is the most expensive of
//     the three — storeChunks commits row by row with NO transaction, and
//     ingestKnowledge's resume check is `SELECT 1 … AND source = $2`, so an
//     expiry at chunk 14 of 25 leaves the document half-ingested AND makes the
//     re-run report it as `skipped`. That is a permanently partial knowledge base
//     reported as a clean skip.
//     CEILING: the run must still terminate. Measured with this file's own
//     chunkText, a 9–14 KB markdown document yields 23–26 chunks, so a fully
//     wedged file ends in ~12 minutes instead of never.
const EMBED_BUDGETS = Object.freeze({
  turn:        Object.freeze({ env: 'EMBED_TIMEOUT_MS',             ms: 3000 }),
  interactive: Object.freeze({ env: 'EMBED_TIMEOUT_INTERACTIVE_MS', ms: 10000 }),
  batch:       Object.freeze({ env: 'EMBED_TIMEOUT_BATCH_MS',       ms: 30000 }),
});

// The fallback is the TIGHTEST class, not the most generous, and an unknown name
// falls back too rather than throwing. A call site added later that forgets to
// classify itself, or misspells its class, gets the bound that costs one turn's
// grounding — never the one that lets a request hang for 30 s. Being wrong in the
// conservative direction is recoverable; the other direction reintroduces exactly
// the unbounded call D-010 exists to have ended.
const DEFAULT_EMBED_BUDGET = 'turn';

function embedBudget(name) {
  return Object.prototype.hasOwnProperty.call(EMBED_BUDGETS, name) ? name : DEFAULT_EMBED_BUDGET;
}

function embedTimeoutMs(budget) {
  const spec = EMBED_BUDGETS[embedBudget(budget)];
  const v = parseInt(process.env[spec.env], 10);
  return Number.isFinite(v) && v > 0 ? v : spec.ms;
}

// A deadline expiry is NOT just another RAG error. contextAssembler.js:68 logs
// every retrieval failure through one line, so a `22P02` from a malformed tenant
// id and a Google outage are already indistinguishable there (05-isolation.md
// P5-3). This carries its own `code` so the new timeout does not become a third
// case collapsed into that bucket.
//
// It names WHICH bound was exceeded, because with three of them "the embedding
// deadline fired" no longer identifies anything actionable: the same message from
// the turn class and from the batch class mean a slow Google and a wedged socket
// respectively, and they are fixed differently. `budget` rides as a field too, so
// a structured log can group on it without parsing prose.
class EmbedTimeoutError extends Error {
  constructor(ms, budget) {
    super(`embedding call exceeded its ${ms}ms '${budget}' deadline (${EMBED_BUDGETS[budget].env})`);
    this.name = 'EmbedTimeoutError';
    this.code = 'EMBED_TIMEOUT';
    this.budget = budget;
  }
}

// `signal` (Issue 29): the voice turn's combined close/deadline AbortSignal —
// aborts the in-flight embedding fetch.
//
// The deadline lives INSIDE this body rather than in a wrapper around the export,
// and that is load-bearing: getRelevantChunks:184 calls this local binding while
// createChunk/updateChunk call `module.exports.embed` (see :226-229 below). A
// wrapper on the export would bound four callers and miss R1 — the one call on
// the patient-facing path. Here, all six entry points inherit it. That split is
// UNCHANGED by the per-class deadlines: the class is chosen at the call site and
// the bound is applied here, so which binding a caller reaches through still does
// not matter.
//
// The internal deadline COMPOSES with `signal`, it does not replace it: a caller
// that passes one still aborts early (the voice turn giving up at 8,000 ms), and
// a caller that passes nothing — WhatsApp, the portal FAQ save, the provisioning
// CLI, validation, the portal test-turn — is bounded anyway, where before it was
// bounded by nothing at all.
//
// `budget` names which of the three deadlines above applies. It is the third
// argument rather than a per-call number so the derivation lives in ONE table
// instead of being spread across the call sites — a caller declares what kind of
// work it is, not how many milliseconds it thinks it deserves.
async function embed(text, signal = null, budget = DEFAULT_EMBED_BUDGET) {
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

  const cls = embedBudget(budget);
  const ms = embedTimeoutMs(cls);
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
    if (timedOut) throw new EmbedTimeoutError(ms, cls);
    throw err;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', relayAbort);
  }
}

async function storeChunks(tenantId, chunks, source) {
  for (const chunk of chunks) {
    // 'batch': CLI ingestion. Nothing is waiting, and a spurious expiry mid-loop
    // leaves the document half-committed — there is no transaction here.
    const embedding = await embed(chunk, null, 'batch');
    await db.query(
      `INSERT INTO knowledge_chunks (tenant_id, content, embedding, source)
       VALUES ($1, $2, $3::vector, $4)`,
      [tenantId, chunk, `[${embedding.join(',')}]`, source]
    );
  }
  return chunks.length;
}

async function getRelevantChunks(tenantId, query, topK = 3, { signal = null } = {}) {
  // 'turn': the patient-facing read. Stated rather than left to the default so a
  // reader sees the class at the site, but it IS the default — see embedBudget.
  const queryEmbedding = await embed(query, signal, 'turn');
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

// ── The relevance floor for chunks that reach a prompt (Q4-1) ────────────────
//
// R1 above takes top-K with no threshold. At the envelope's 150–250 chunks per
// tenant and topK=3 it ALWAYS returns three rows, and aiService.js renders every
// one of them under "Business knowledge (use ONLY this to answer questions — do
// not invent information)". The third row is therefore presented to the model as
// the authoritative answer to the question that was asked, whatever it is about.
//
// ── WHERE THE NUMBER COMES FROM ──────────────────────────────────────────────
// There is no evaluation set, no production traffic and no transcripts, so an
// OPTIMAL cut cannot be derived and this is not one. Two bands have been
// measured, and 0.25 is the midpoint between them:
//
//   UPPER BOUND — 0.4204. The lowest cosine similarity observed between ANY real
//     query and ANY real chunk, over 42 measured pairs of real dental-clinic FAQ
//     text under gemini-embedding-001 at outputDimensionality 768 (this session's
//     measurement; see D-013). It came from the most unrelated pair available —
//     an out-of-domain question about a metro train against a children's-dentistry
//     FAQ. Real text simply does not go below this, so a floor at or above it
//     would start cutting into the range honest content occupies, and with no
//     eval set nothing would report what it had cut.
//
//   LOWER BOUND — 0.0955. The highest similarity 1,200 random unit-Gaussian
//     768-dim vectors reached against a real query vector (05-isolation.md §H.2).
//     That is a max-of-N statistic on chance, not a property of embedded text:
//     1/sqrt(768) = 0.0361 is the standard deviation of cosine between independent
//     unit vectors, so 0.0955 is ~2.6 sigma. Below this a floor cannot separate
//     anything from coincidence.
//
//   (0.0955 + 0.4204) / 2 = 0.2580, rounded DOWN to 0.25 — every rounding on this
//   value goes toward keeping chunks, for the reason below.
//
// ── WHY IT IS DELIBERATELY TOO LOW ───────────────────────────────────────────
// The two failure directions are not symmetric, and only one of them is visible.
// Under-filtering leaves today's behaviour, which is a known and recorded finding.
// Over-filtering silently deletes a correct answer: the turn then takes the
// zero-chunk branch, the model says it will check and get back to them, and
// nothing anywhere records that an answer existed. Without an eval set that
// failure is undetectable, so the floor is set where it cannot cause it.
// Concretely: at 0.25 the floor would not have removed a single one of the 42
// measured pairs. It is a floor awaiting production data, not a tuned parameter,
// and applyRelevanceFloor's discarded rows are recorded to `turn_traces`
// (contextAssembler.js) precisely so the data to tune it accumulates.
//
// Cross-lingual retrieval was measured too, because this product's patients ask
// in Telugu and Hindi against FAQs written in English and R1 neither selects nor
// filters the language tag: correct answers scored 0.8087–0.8603 and ranked first
// every time. Vernacular turns are nowhere near this floor.
const RELEVANCE_FLOOR = Object.freeze({ env: 'RAG_MIN_SIMILARITY', value: 0.25 });

// Read at call time, same shape as embedTimeoutMs above, so a test varies it per
// case and an operator changes it without a restart. Out-of-range values fall
// back rather than throwing: cosine similarity is bounded to [-1, 1], so anything
// outside it is a typo, and a typo must not silently empty every prompt.
function minSimilarity() {
  const v = Number.parseFloat(process.env[RELEVANCE_FLOOR.env]);
  return Number.isFinite(v) && v >= -1 && v <= 1 ? v : RELEVANCE_FLOOR.value;
}

// Split R1's rows into the ones that may reach a prompt and the ones that may not.
//
// This is NOT applied inside getRelevantChunks, and that is deliberate twice over.
// R1's contract is "the nearest K rows this tenant owns" — a health probe
// (validationService.checkKbRetrieval) legitimately wants that and would start
// failing tenants whose knowledge base is fine if the floor moved underneath it.
// And whether a row is good enough to be presented to a patient as clinic-approved
// fact is a property of the PROMPT, conferred by the authority header, so it
// belongs at the layer that confers it. Session 1's retrievalIsolation tests call
// getRelevantChunks directly and are unaffected by this file's change.
//
// A row with no usable score is KEPT. The floor can only exclude what it can
// measure, and `embedding` is nullable (schema.sql:293), so a NULL-embedding row
// comes back with `similarity = NULL` (05-isolation.md §H.5). Excluding those
// would be the floor quietly doing something it was not derived to do; that case
// is Q3-2's and is closed separately.
function applyRelevanceFloor(rows, floor = minSimilarity()) {
  const kept = [];
  const filtered = [];
  for (const row of rows) {
    const score = row && Number.isFinite(row.similarity) ? row.similarity : null;
    if (score === null || score >= floor) kept.push(row);
    else filtered.push(row);
  }
  return { kept, filtered, floor };
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
  // 'interactive': an owner is holding a Save button. This bound is the only
  // thing on the request capable of ending it (02-ingestion.md §D.3).
  const embedding = await module.exports.embed(content, null, 'interactive');
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

  const embedding = await module.exports.embed(content, null, 'interactive'); // same Save button as createChunk
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
  embed, EMBED_BUDGETS, DEFAULT_EMBED_BUDGET,
  RELEVANCE_FLOOR, minSimilarity, applyRelevanceFloor,
  storeChunks, getRelevantChunks, chunkText,
  listChunks, getChunk, countChunksBySourcePrefix, createChunk, updateChunk, deleteChunk,
};
