Phase 1 — Map & Divergence Ledger

Objective. Produce the one artifact every other phase reads: the verified runtime path from inbound turn to LLM prompt, at HEAD, with file:line evidence — plus a ledger of every place documentation claims a retrieval capability the code does not exercise.

Inspect. src/modules/knowledge/*, src/modules/conversation/contextAssembler.js, src/modules/ai/*, src/modules/channels/whatsapp/*, voice-agent/, src/portal/routes.js (FAQ/document surfaces), src/db/schema.sql, all migrations touching knowledge_chunks, src/modules/validation/validationService.js, docs/architecture/ARCHITECTURE.md, docs/specs/*, README.md.

Evidence. Call graph with file:line at each hop; the exact SQL text of every query touching knowledge_chunks; every caller of the retrieval entry point; every writer of knowledge_chunks; documentation claim vs. runtime reality, paired.

Output. docs/os/audits/rag/01-map.md.

Depends on. Nothing.

Type. Audit-only.

RAG AUDIT — PHASE 1 of 6: MAP & DIVERGENCE LEDGER

You are performing a strictly read-only architectural audit. This session produces
exactly one new file and changes nothing else.

NON-DESTRUCTIVE CONTRACT — binding for this entire session:
Do NOT modify source code, schema, migrations, config, or tests. Do NOT install,
add, or upgrade any package. Do NOT run any migration, seed, or write query. Do NOT
delete anything. Do NOT implement, refactor, or "quickly fix" anything you find —
findings go in the artifact, never in the code. If you believe a fix is urgent, write
it in the artifact under PROPOSED (Phase 6 decides), and continue.

PHASE 0 — report before doing anything else, then STOP if any condition fires:
1. Read docs/os/state.md, docs/os/clocks.md, docs/os/decisions.md, docs/os/assumptions.md.
   Report gate status and any clock relevant to knowledge/RAG.
2. Report `git rev-parse HEAD`, `git status --porcelain`, current branch.
3. STOP if the working tree is dirty. STOP if docs/os/ is unreadable. STOP if you
   cannot locate a module owning knowledge_chunks — report what you searched instead.
4. Confirm in one line: "This session is read-only and will create one artifact."

SCALE ENVELOPE (founder-supplied planning estimates — NOT measured production
values. No production traffic and no production transcripts exist. Every number
below is an estimate with a stated confidence; treat LOW-confidence values as
brackets, not facts.)

- Chunks per tenant, today:            0 (no tenants)  [HIGH]
- Chunks per tenant, at 10 clinics:    150 typical / 250 ceiling  [HIGH for FAQ
                                       half — MAX_FAQS=100 enforced in
                                       faqService.createFaq, 1 FAQ = 1 chunk,
                                       chunkText not on the FAQ path;
                                       MEDIUM for document half — S12 portal
                                       upload not shipped, documents enter only
                                       via scripts/ingest-knowledge.js and
                                       provisioningService.ingestKnowledge]
- Total vectors at 10 clinics:         1,500 typical / 2,500 ceiling (~4.6 MB
                                       at vector(768))  [HIGH]
- Tenants, today:                      0
- Tenants, target at G-TEN:            10
- Retrievals/day/tenant, expected:     200  [LOW — see note]
- Total retrievals/day at 10 clinics:  2,000; peak ~10/minute system-wide  [LOW]

  NOTE on query volume: retrieval fires ONCE PER TURN, not per call
  (assembleConversationContext → getRelevantChunks, one call site each in
  whatsapp/routes.js and internalVoice.js; the Gemini tool loop runs after
  retrieval and does not re-retrieve). Turns bypassing retrieval: non-text
  WhatsApp, conversation.mode='human', !tenant.ai_enabled, owner-phone messages.
  Additional retrieval sources: testTurnService (≤20/day/tenant),
  validationService.checkKbRetrieval, scriptedTurnCheck.
  Two conflicting repo signals bracket call volume:
  docs/deploy/audit/2026-07-production-readiness.md says "low hundreds of calls
  per month" (3–10/day); public/demo/dashboard.json shows 19–28/day but is a
  self-labelled illustrative sales fixture for a clinic one year in.
  Turns-per-interaction is UNKNOWN from the repository — 8 is an assumed
  planning multiplier, deliberately high.

- Voice turn latency budget:           CANDIDATE 8,000 ms server / 10,000 ms
                                       worker (internalVoice.js comment
                                       "budget 8s < worker 10s") — Phase 1 must
                                       confirm the actual constant at HEAD
- WhatsApp turn latency budget:        UNKNOWN — no deadline found in the
                                       snapshot; Phase 1 must confirm whether
                                       one exists at all
- Embedding latency (measured, same
  API, ingestion side):                600–900 ms (public/portal/faqs.js)
- Per-turn hydration (measured):       300–465 ms (docs/reviews/
                                       voice-review-2026-07.md)
- Infra:                               Railway, single region, one Postgres
- Embedding provider:                  Google, model gemini-embedding-001 with
                                       outputDimensionality 768 (NOTE: schema
                                       comment and migration 004 name
                                       text-embedding-004 — unresolved
                                       divergence, Phase 1 §D)
- Cost ceiling that matters:           ₹4,999/month/clinic gross revenue
- Production traffic to date:          none
- Production transcripts to date:      none

SCOPE — exactly this, nothing more:

A. TRACE THE RUNTIME PATH, at HEAD, for every channel that reaches retrieval.
   For each of: WhatsApp inbound, voice turn, portal test turn, and any other caller
   you find — produce the ordered call chain from entry point to the assembled LLM
   prompt, as file:line → function → what it actually does. Where a channel diverges
   from another, say exactly where and why. Where they converge on a shared path,
   name the file and prove it (list every caller of the shared function).

B. INVENTORY EVERY READ AND WRITE OF knowledge_chunks.
   Use `git grep` (PowerShell — never `grep`) for the table name, and separately for
   the service module. For each hit: file:line, the verbatim SQL or service call, the
   caller, and whether it is on a request path, a background path, or test-only.
   Missing one write path invalidates Phase 2; missing one read path invalidates
   Phase 5. Be exhaustive and say how you established exhaustiveness.

C. RECORD THE CONFIGURATION SURFACE.
   Every constant, env var, default parameter, and magic number that affects
   retrieval: top-K and every place it is overridden, chunk size, overlap, embedding
   model name, output dimensionality, any similarity threshold, any timeout, deadline,
   or AbortSignal that bounds a retrieval call. Give file:line and the actual value.
   State explicitly if a knob exists in config but no runtime code reads it.

D. BUILD THE DIVERGENCE LEDGER.
   Compare what docs/architecture/ARCHITECTURE.md, docs/specs/*, README.md, schema
   comments, and code comments CLAIM about retrieval against what the code at HEAD
   actually does. One row per divergence:
   claim (source file:line) | runtime reality (source file:line) | severity | who is wrong
   Include schema comments and code comments — a comment naming one embedding model
   while the code instantiates another is exactly the class of finding this section
   exists to catch. If you find no divergences, say so and list what you checked.

E. STATE WHAT DOES NOT EXIST.
   Explicitly enumerate retrieval machinery that is absent from the repository:
   reranking, hybrid/keyword search, query rewriting, multi-query, MMR, caching,
   batching, async ingestion, similarity thresholding, context compression. For this
   phase, ONLY record presence/absence with evidence of the search you performed.
   Do NOT evaluate whether any of them should exist — that is Phases 2–4. Do not
   recommend anything in this session.

OUT OF SCOPE — do not do these in this session:
- Any judgement about whether the design is good
- Any recommendation, prioritisation, or severity ranking beyond the divergence ledger
- Any performance measurement or EXPLAIN
- Any test execution beyond a single `npm test` to confirm the suite is green
- Reading transcripts or production data (there are none)

EVIDENCE FORMAT — every factual claim in the artifact uses:
  file path → function/class → actual behavior → evidence (verbatim snippet or SQL) → why it matters
A claim without a file:line is not a finding; delete it or mark it UNVERIFIED.
Never describe code you have not opened in this session. If you recall something about
this repository from earlier work, re-verify it at HEAD before writing it down.

OUTPUT: create docs/os/audits/rag/01-map.md containing:
  0. Header: HEAD sha, date, `npm test` result line, scale envelope as supplied
  1. Runtime path, per channel, as an ordered call chain with file:line
  2. Shared vs. channel-specific components, with the caller list that proves it
  3. Complete read/write inventory of knowledge_chunks
  4. Configuration surface table (knob | value | file:line | read at runtime? Y/N)
  5. Divergence ledger
  6. Absent machinery, with the search commands used
  7. OPEN QUESTIONS FOR LATER PHASES — numbered, each tagged [P2]/[P3]/[P4]/[P5]
  8. UNVERIFIED — anything you could not establish, and what would establish it

DEFINITION OF DONE:
- docs/os/audits/rag/01-map.md exists and every section above is present
- `git status --porcelain` shows ONLY that one file
- `npm test` reports the same test count as docs/os/state.md records, fail 0 — paste the line
- You have written zero lines of non-artifact content
Report the `git status --porcelain` output and the test line verbatim as your final message.