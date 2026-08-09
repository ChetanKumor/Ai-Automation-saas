# Prantivo — RAG Audit Workflow (Claude Code)

**Type:** audit-only. No phase in this document modifies code, schema, config, dependencies, or data.
**Sessions:** 6 phases, 1 Claude Code session each, Opus / high effort.
**Artifacts:** `docs/os/audits/rag/0N-*.md`.

> **Why `docs/os/audits/` and not `docs/audits/`:** `scripts/os-check.js` tolerates a stale `Verified-at` only for changes under `docs/os/`. Committing audit artifacts anywhere else moves HEAD and trips the provenance guard, forcing a second provenance commit per phase. Flip this if you'd rather keep `docs/os/` to the four registers — in that case, leave the artifacts uncommitted and pass them between sessions by path.

---

## 0. Before you run anything

### 0.1 Scale envelope — fill this in once, paste into every phase

Claude Code will otherwise audit as if this were a 10-million-vector system, and that is exactly how you get a reranker and a hybrid BM25 index you do not need. These numbers are the single strongest defence against buzzword-driven recommendations.

Fill in the `?` values. Anything you leave as `?` must be flagged by Claude Code as an unverified input, not guessed.

```
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
'''

### 0.2 Verdict taxonomy — the anti-overengineering forcing function

Every technique the audit considers gets exactly one verdict:

| Verdict | Meaning |
|---|---|
| **A — Implemented** | Present and exercised on the runtime path |
| **B — Partial** | Present but not reached, not configured, or bypassed at runtime |
| **C — Missing, needed now** | Absence causes a defect that is *demonstrable at current scale* |
| **D — Useful later at scale** | Correct to skip now; needs a named numeric trigger |
| **E — Unnecessary for this project** | Would never pay for itself given the envelope |

**Burden of proof rule (paste into every phase):**

> The default verdict is **E**. A verdict of **C** requires a number extracted from this repository or from the scale envelope — a chunk count, a measured latency, a token count, a rupee figure, or a reproducible failure. "Best practice", "standard for production RAG", "most systems do", and "recommended in the literature" are not evidence and must not appear in any artifact. A verdict of **D** is invalid unless it names the specific numeric threshold at which it flips to **C** (e.g. "at >50,000 vectors per tenant", not "at scale").

### 0.3 Session hygiene reminders baked into every prompt

- PowerShell: `git grep`, never `grep`. Do not round-trip UTF-8 files through PowerShell (BOM corruption).
- Read `docs/os/state.md`, `clocks.md`, `decisions.md`, `assumptions.md` before Phase 0 reporting.
- `git status` must show only the phase's own artifact at session end. Anything else is scope leak.
- Test count must not change. `npm test` may be *run*; no test may be added, edited, or deleted.

### 0.4 Dependency graph

```
Phase 1 (Map) ──┬──▶ Phase 2 (Ingestion & embedding) ──┐
                ├──▶ Phase 3 (Storage, index, SQL) ─────┤
                ├──▶ Phase 4 (Retrieval, context, cost) ┼──▶ Phase 6 (Synthesis)
                └──▶ Phase 5 (Tenant isolation) ────────┘
```

Phase 1 is a hard prerequisite for all others. Phases 2–5 are mutually independent and may be run in any order, in parallel worktrees, or skipped. Phase 6 requires whichever of 2–5 were run and must state which were absent.

---

## Phase 1 — Map & Divergence Ledger

**Objective.** Produce the one artifact every other phase reads: the verified runtime path from inbound turn to LLM prompt, at HEAD, with file:line evidence — plus a ledger of every place documentation claims a retrieval capability the code does not exercise.

**Inspect.** `src/modules/knowledge/*`, `src/modules/conversation/contextAssembler.js`, `src/modules/ai/*`, `src/modules/channels/whatsapp/*`, `voice-agent/`, `src/portal/routes.js` (FAQ/document surfaces), `src/db/schema.sql`, all migrations touching `knowledge_chunks`, `src/modules/validation/validationService.js`, `docs/architecture/ARCHITECTURE.md`, `docs/specs/*`, `README.md`.

**Evidence.** Call graph with file:line at each hop; the exact SQL text of every query touching `knowledge_chunks`; every caller of the retrieval entry point; every writer of `knowledge_chunks`; documentation claim vs. runtime reality, paired.

**Output.** `docs/os/audits/rag/01-map.md`.

**Depends on.** Nothing.

**Type.** Audit-only.

```
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

SCALE ENVELOPE (binding — do not substitute your own assumptions):
<PASTE THE FILLED-IN SCALE ENVELOPE FROM §0.1 HERE>

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
```

---

## Phase 2 — Ingestion, Chunking & Embedding

**Objective.** Determine whether what goes *into* the index is well-formed for this corpus, and whether the write path is safe and affordable at 10 tenants — without assuming a document pipeline that may not exist yet.

**Inspect.** `knowledgeService.chunkText`, `storeChunks`, `createChunk`, `updateChunk`, `deleteChunk`; `faqService`; the portal FAQ routes; any PDF/document extraction path (verify whether it shipped or was deferred); the embedding call site, model, and `outputDimensionality`; re-embed triggers on edit; any background worker or job that touches ingestion.

**Evidence.** Actual chunk boundaries produced by `chunkText` on representative FAQ and document text; the real character/token distribution; embedding call count per save and per bulk ingest; sequential-vs-batch write pattern; failure and partial-write behaviour; whether the language tag on `source` is used at retrieval time.

**Output.** `docs/os/audits/rag/02-ingestion.md`.

**Depends on.** Phase 1 (reads the write inventory and config surface).

**Type.** Audit-only.

```
RAG AUDIT — PHASE 2 of 6: INGESTION, CHUNKING & EMBEDDING

Read docs/os/audits/rag/01-map.md FIRST. It is the map for this session. Do not
re-derive the runtime path — cite it. If anything in 01-map.md contradicts what you
find at HEAD, STOP, report the contradiction, and do not proceed on the stale premise.

NON-DESTRUCTIVE CONTRACT — binding for this entire session:
Do NOT modify source, schema, migrations, config, or tests. Do NOT install or add any
package. Do NOT write to any database. Do NOT implement anything you recommend.
You MAY execute existing pure functions in a throwaway node REPL to observe their
output (e.g. requiring the chunker and calling it on sample text) — this is
observation, not modification. You may NOT call the embedding API in a loop; if you
call it at all, call it at most twice and say why.

PHASE 0 — report, then STOP if a condition fires:
1. Read docs/os/, confirm 01-map.md exists and matches HEAD's sha or explain the drift
2. Report HEAD sha and `git status --porcelain` (must be clean)
3. STOP if 01-map.md is missing — Phase 1 is a hard prerequisite
4. Confirm read-only in one line

SCALE ENVELOPE:
<PASTE §0.1>

VERDICT TAXONOMY AND BURDEN OF PROOF:
<PASTE §0.2 IN FULL, INCLUDING THE BURDEN-OF-PROOF RULE>

SCOPE:

A. CHUNKING — audit against THIS corpus, not against a generic document pipeline.
   1. Read the chunker. State its actual algorithm in plain terms, then execute it
      on: (a) a representative FAQ Q/A pair, (b) a 2,000-character multi-paragraph
      policy text, (c) a single paragraph longer than the max length, (d) text with
      no blank lines at all. Paste the ACTUAL chunk boundaries produced.
   2. Report the real behaviour of the size limit and the overlap: does overlap carry
      semantic content or a mid-word fragment? Does a single oversized paragraph get
      split at all, or emitted whole? Show the evidence, not the intent.
   3. THEN answer the question that decides everything here: what fraction of rows in
      this system actually go through the chunker at all? Establish from the write
      inventory in 01-map.md whether FAQ rows are chunked or stored one-row-per-Q/A.
      If FAQs bypass the chunker, chunking quality is a low-stakes finding for a
      surface that may not have shipped — say that plainly and size the finding
      accordingly. Do not write a chunking-strategy essay for a code path nothing
      reaches.
   4. Assess whether Q/A pairs are stored in a form that embeds well — specifically,
      whether the question text is present in the embedded content. A stored answer
      without its question embeds poorly against a question-shaped query. This is
      testable by reading the ingestion code; do it.

B. METADATA.
   Inventory every column and every convention encoded into a column (e.g. language
   tags packed into `source`). For each: who writes it, who reads it, and whether any
   retrieval query filters or ranks on it. Flag any metadata written but never read —
   that is either dead weight or an unrealised retrieval improvement, and Phase 4
   needs to know which.

C. EMBEDDING.
   1. Model name, dimensionality requested, dimensionality stored — verify all three
      agree, at HEAD, in code and in schema. Report any mismatch between the model
      the code instantiates and the model any comment or migration names.
   2. Is the same model and dimensionality used for ingestion and for query
      embedding? Prove it from both call sites. A divergence here silently destroys
      relevance and is invisible in tests that mock the embedder.
   3. Does the provider distinguish document-embedding from query-embedding task
      types, and does this code use that distinction? Report what the code does; if it
      does not use task types, state the concrete relevance cost, or state honestly
      that the cost is unmeasurable without production queries.
   4. Multilingual reality check: this corpus is Telugu, Hindi, and English, and
      queries arrive transliterated and code-mixed. Does anything in the ingestion
      path account for that? Report what exists. Do not speculate about what would
      help — flag it as an OPEN QUESTION for Phase 4.

D. WRITE-PATH SAFETY AND COST.
   1. Is ingestion sequential or batched? Count embedding API calls for: one FAQ save,
      one edit that changes text, one edit that does not change text, a 100-FAQ import
      if such a path exists.
   2. Is the write transactional? What is the state after a failure halfway through a
      multi-chunk write? Show the code that determines the answer.
   3. Is ingestion synchronous on a request path? If yes, what is the worst-case
      request duration and does any timeout bound it?
   4. Is there re-embedding on edit, and is it correctly conditional?
   5. Compute actual embedding cost at the scale envelope — rupees per tenant per
      month for ingestion. If the figure is negligible, say the number and say it is
      negligible, and mark every cost-driven ingestion optimisation E.

E. VERDICTS.
   Apply the taxonomy to: semantic chunking, structural/markdown-aware chunking,
   recursive splitting, contextual chunk headers, parent-document retrieval,
   sentence-window retrieval, metadata enrichment at ingest, batch embedding, async
   ingestion queue, embedding model change, task-type embeddings, per-language
   embedding strategy. One verdict each, with the number that justifies it.

OUT OF SCOPE: retrieval, SQL, indexes, latency measurement, tenant isolation,
prioritisation across phases. Record cross-phase findings as OPEN QUESTIONS.

EVIDENCE FORMAT: file path → function → actual behavior → evidence → impact.

OUTPUT: docs/os/audits/rag/02-ingestion.md with: header (HEAD sha, date, test line);
chunking assessment with executed examples; metadata table; embedding assessment;
write-path safety and cost with arithmetic shown; verdict table (technique | verdict
A–E | justifying number | file:line); OPEN QUESTIONS tagged [P3]/[P4]/[P5]/[P6];
UNVERIFIED section.

DEFINITION OF DONE: artifact exists; `git status --porcelain` shows only it; `npm test`
count unchanged vs docs/os/state.md, fail 0 — paste the line; every verdict in the
table carries a number or is marked E. Report git status and the test line verbatim.
```

---

## Phase 3 — Storage, Index & Query Execution

**Objective.** Establish what the database actually does when a retrieval query runs — including whether the ANN index is used at all, and whether it *should* be at this corpus size. This is the phase where pgvector folklore most often produces wrong recommendations, so it is measurement-led.

**Inspect.** `schema.sql`, every migration touching `knowledge_chunks`, index definitions and their build parameters, the retrieval SQL verbatim, `db.js` pooling, and `EXPLAIN (ANALYZE, BUFFERS)` output against a local scratch database.

**Evidence.** Real query plans at three corpus sizes; index scan vs. sequential scan; whether the HNSW index is reachable given a `WHERE tenant_id = $1` predicate; recall behaviour when the filter is selective; `ef_search` / `m` / `ef_construction` actual values; whether `LIMIT` returns fewer rows than requested under filtering.

**Output.** `docs/os/audits/rag/03-storage-index.md`.

**Depends on.** Phase 1.

**Type.** Audit-only. Seeding is confined to a throwaway scratch database and is opt-in.

```
RAG AUDIT — PHASE 3 of 6: STORAGE, INDEX & QUERY EXECUTION

Read docs/os/audits/rag/01-map.md FIRST and cite it rather than re-deriving.

NON-DESTRUCTIVE CONTRACT:
Do NOT modify source, schema, migrations, config, or tests in the repository. Do NOT
install packages. Do NOT touch any database other than a throwaway scratch database
you create for this session, named with the repository's existing scratch prefix
convention (find it in the test bootstrap; do not invent one). Do NOT run repository
migrations against any shared or dev database. At session end, DROP the scratch
database and report that you did. If you cannot create a scratch database, do the
static half of this phase and mark the measurement half UNVERIFIED — do not measure
against a database you did not create.

PHASE 0 — report, then STOP if a condition fires:
1. docs/os/ read; 01-map.md present and consistent with HEAD
2. HEAD sha; `git status --porcelain` clean
3. Report whether you can create a scratch database, and its name
4. STOP if the only reachable database is one you did not create
5. Confirm: "Repository is read-only this session; DB writes confined to <scratch name>."

SCALE ENVELOPE:
<PASTE §0.1>
VERDICT TAXONOMY AND BURDEN OF PROOF:
<PASTE §0.2 IN FULL>

SCOPE:

A. STATIC SCHEMA AND INDEX AUDIT.
   1. Reconstruct the final state of knowledge_chunks from schema.sql AND from the
      migration sequence. Report any divergence between the two — a schema file that
      has drifted from its migrations is a genesis-deploy hazard and this repo's first
      deploy initialises fresh from schema.sql.
   2. List every index on the table, verbatim, with its operator class and any build
      parameters. State the defaults pgvector will have used for anything unspecified.
   3. Confirm the similarity operator in the retrieval SQL matches the index operator
      class. A cosine index with an L2 query operator means the index is silently
      unused; verify rather than assume.
   4. Check whether the vector column is nullable and whether any row can exist with a
      NULL embedding. If yes, trace what the retrieval query does with such a row.
   5. Report row-size and storage implications: vector dimensionality × rows at the
      scale envelope, and whether TOAST applies to this column.

B. QUERY PLAN MEASUREMENT — this is the core of the phase.
   Create the scratch database, apply the repo's schema, and seed synthetic rows with
   randomly generated vectors of the correct dimensionality across several tenant_ids.
   Then run `EXPLAIN (ANALYZE, BUFFERS)` on the EXACT retrieval SQL from 01-map.md
   (verbatim, same parameter shape) at three corpus sizes:
     (i)   the realistic size from the scale envelope
     (ii)  10× that
     (iii) 1000× that
   For each, report: plan node chosen, index used or sequential scan, rows returned
   vs. LIMIT requested, actual time, buffers.
   Then answer explicitly:
   - At size (i), does Postgres use the ANN index at all, or does the planner choose a
     scan because the table is small? Report what actually happened.
   - Does the tenant_id predicate combined with ANN ordering ever return FEWER rows
     than LIMIT? Test this deliberately with a tenant holding a small share of the
     corpus. This is the pgvector filtered-search failure mode and it is a CORRECTNESS
     issue, not a performance one — if it reproduces, it outranks everything else in
     this phase.
   - What is `ef_search` set to in this session, and does the code ever set it?
   Paste raw EXPLAIN output into the artifact. Do not paraphrase plans.

C. INDEX STRATEGY VERDICT.
   Given the measured plans and the scale envelope, deliver one verdict each on:
   HNSW as configured, IVFFlat instead, tuned HNSW build parameters, runtime
   ef_search tuning, a composite or partial index incorporating tenant_id, partitioning
   by tenant, dropping the ANN index entirely in favour of exact search, and a
   btree index on tenant_id.
   Explicitly evaluate the possibility that at this corpus size the ANN index is
   unnecessary and exact search is both faster and perfectly recalled. Do not treat
   "has an HNSW index" as automatically correct. Use the measured plan at size (i) to
   decide, and name the row count at which each verdict flips.

D. CONNECTION AND ROUND-TRIP BEHAVIOUR.
   Pooling configuration; number of database round trips per retrieval; whether
   retrieval shares a pool with the request path; any N+1 pattern in the read path.

E. GENESIS-DEPLOY READINESS.
   This system has never been deployed. State whether a fresh database initialised
   from schema.sql produces exactly the index set the retrieval path expects, and
   whether index build time at first ingest is material. Flag anything that would only
   surface on a fresh deploy.

OUT OF SCOPE: chunking, embedding quality, reranking, tenant-isolation logic above the
SQL layer (Phase 5), prioritisation.

OUTPUT: docs/os/audits/rag/03-storage-index.md with: header; static schema/index audit;
schema-vs-migration divergence; raw EXPLAIN output at all three sizes; the filtered-
search correctness result stated unambiguously; index strategy verdict table with flip
thresholds; connection/round-trip findings; genesis-deploy notes; OPEN QUESTIONS;
UNVERIFIED.

DEFINITION OF DONE: artifact exists; scratch database dropped and reported;
`git status --porcelain` shows only the artifact; `npm test` count unchanged, fail 0 —
paste the line. Report git status, the drop confirmation, and the test line verbatim.
```

---

## Phase 4 — Retrieval Quality, Context Construction, Token & Cost

**Objective.** Assess what actually reaches the model, what it costs per turn, whether the retrieval call fits inside the voice latency budget — and rule on every advanced RAG technique against the envelope rather than against fashion.

**Inspect.** `getRelevantChunks` and every caller; `contextAssembler`; `aiService.generateReply` prompt assembly; the voice turn deadline and AbortSignal machinery; `testTurnService`; `validationService` KB checks; `turn_traces` retrieval provenance capture.

**Evidence.** Token counts for each prompt component measured with a real tokenizer; the top-K value at each call site; the exact behaviour when zero chunks are returned; the exact behaviour when a low-similarity chunk is returned; measured or bounded embedding-call latency; per-turn rupee cost arithmetic.

**Output.** `docs/os/audits/rag/04-retrieval-quality.md`.

**Depends on.** Phase 1. Stronger with Phases 2 and 3.

**Type.** Audit-only.

```
RAG AUDIT — PHASE 4 of 6: RETRIEVAL QUALITY, CONTEXT, TOKEN & COST

Read docs/os/audits/rag/01-map.md first; also read 02 and 03 if they exist and cite
their findings rather than re-deriving them.

NON-DESTRUCTIVE CONTRACT:
Do NOT modify source, schema, config, or tests. Do NOT install packages. Do NOT
implement anything. You MAY run existing code read-only to measure token counts and
to render a prompt with synthetic inputs. Live LLM or embedding API calls: at most a
handful, only if genuinely necessary for a measurement, and each one justified in the
artifact. Prefer static token counting over live calls.

PHASE 0 — report, then STOP if a condition fires:
1. docs/os/ read; 01-map.md present and consistent with HEAD; note whether 02/03 exist
2. HEAD sha; `git status --porcelain` clean
3. Confirm read-only in one line

SCALE ENVELOPE:
<PASTE §0.1>
VERDICT TAXONOMY AND BURDEN OF PROOF:
<PASTE §0.2 IN FULL>

SCOPE:

A. RETRIEVAL PARAMETERS AS ACTUALLY CALLED.
   For every call site: the top-K value passed, whether it is configurable per tenant,
   whether any similarity threshold is applied, and what happens to a chunk whose
   similarity is near zero. Establish from the code whether an irrelevant chunk can
   reach the prompt. If no threshold exists, describe the concrete failure — an
   unrelated FAQ presented to the model as clinic-approved fact — and rule on whether
   a threshold is C or D, naming the number that would justify the choice.

B. FAILURE AND DEGRADATION SEMANTICS.
   Trace what happens on: embedding API failure, embedding timeout/abort mid-turn,
   zero chunks returned, database error, and a tenant with an empty knowledge base.
   For each, state what the caller does and what the patient hears. A best-effort
   degrade that silently produces an ungrounded answer is a safety finding, not a
   performance one — classify it accordingly.

C. CONTEXT CONSTRUCTION AND TOKEN BUDGET.
   1. Read the prompt assembly and report every component that reaches the model:
      system/persona, booking rules, retrieved chunks, conversation history, customer
      memory facts, tool definitions.
   2. Measure actual token counts per component for a realistic turn, using a real
      tokenizer. Show the table and the total.
   3. State the retrieved-chunks share of the total. If retrieval is a small fraction
      of the prompt, then context compression, chunk summarisation, and token-saving
      reranking are all E, and say so with the number. If it is a large fraction, say
      which component dominates and whether it is even the RAG component's problem.
   4. Report whether chunks are deduplicated, ordered by score, delimited clearly, and
      labelled with provenance in the prompt text.
   5. Check for prompt-injection surface: retrieved chunk content is tenant-authored
      text placed into a prompt. Is it delimited? Could an FAQ answer containing
      instruction-shaped text alter behaviour? This is a real finding class for a
      system where clinic staff type the corpus.

D. LATENCY.
   Extract the actual voice-turn deadline and any AbortSignal budget from the code —
   report the number and its file:line. Then decompose the retrieval contribution:
   embedding API round trip + vector query + assembly. Use measured numbers where you
   can obtain them read-only; otherwise state bounds and mark them UNVERIFIED rather
   than guessing. Answer directly: is the embedding API call on the critical path of a
   live voice turn, and what is the worst case if the provider is slow? State which
   mitigations are C and which are D, with thresholds.

E. COST.
   Per-turn arithmetic in rupees: embedding call + LLM input tokens attributable to
   retrieved chunks + LLM output. Then per clinic per month at the envelope's query
   volume, against ₹4,999 revenue. Show the arithmetic. If retrieval cost is a
   rounding error against revenue, say the number and mark every cost-motivated
   optimisation E.

F. CACHING.
   Report what caching exists today. Then evaluate: query-embedding cache, chunk-result
   cache, provider prompt caching. For each, estimate the actual hit rate given that
   clinic queries repeat heavily ("timings", "fees", "location") — and note that any
   cache keyed on query text MUST be tenant-scoped or it is a cross-tenant leak.
   Record that constraint as an input to Phase 5.

G. ADVANCED TECHNIQUE VERDICTS — the anti-overengineering core of this audit.
   One verdict each, with a number, for: hybrid vector+keyword search, BM25/full-text,
   reciprocal rank fusion, query rewriting, query expansion, HyDE, multi-query
   retrieval, MMR/diversity, cross-encoder reranking, LLM reranking, contextual
   compression, sentence-window or parent-document retrieval, self-query metadata
   filtering, agentic/iterative retrieval, and a knowledge graph layer.
   Two mandatory considerations:
   - Corpus size. With a per-tenant corpus in the low hundreds of chunks and a top-K
     of a few, several of these techniques are mathematically incapable of changing
     the result set. Where that is true, say so explicitly and mark E.
   - Multilingual retrieval. Telugu/Hindi/English with transliteration and code-mixing
     is the one place where a technique might genuinely earn its place. Evaluate it on
     the merits and separately from the rest.
   Finish with a short section: TECHNIQUES THAT WOULD BE ACTIVELY HARMFUL HERE — those
   that add latency to a voice turn or failure modes for no measurable gain.

OUT OF SCOPE: tenant isolation (Phase 5), cross-phase prioritisation (Phase 6),
implementing anything.

OUTPUT: docs/os/audits/rag/04-retrieval-quality.md with: header; parameters table;
failure semantics table; token budget table with totals; prompt-injection assessment;
latency decomposition with the extracted deadline; cost arithmetic; caching assessment
with the tenant-scoping constraint; advanced technique verdict table (technique |
verdict | justifying number | flip threshold if D); actively-harmful list; OPEN
QUESTIONS; UNVERIFIED.

DEFINITION OF DONE: artifact exists; `git status --porcelain` shows only it; `npm test`
count unchanged, fail 0 — paste the line; every technique in G carries a verdict and a
number. Report git status and the test line verbatim.
```

---

## Phase 5 — Tenant Isolation (adversarial)

**Objective.** Establish, adversarially rather than confirmingly, that no path can return one clinic's knowledge to another clinic's patient. This is the H1 safety-floor phase and the one whose findings are non-negotiable.

**Inspect.** Every read of `knowledge_chunks` from Phase 1's inventory; tenant resolution on every entry point (WhatsApp webhook, DID→tenant, portal session, admin, test turn); `configService`; any cache, memo, or module-level state; connection pooling; `turn_traces` retrieval capture; existing cross-tenant negative tests.

**Evidence.** For every read path: where `tenant_id` originates, whether it can be influenced by request input, and the negative test that proves it. Any shared mutable state keyed without a tenant. Any error, log, or trace that could echo another tenant's content.

**Output.** `docs/os/audits/rag/05-isolation.md`.

**Depends on.** Phase 1.

**Type.** Audit-only.

```
RAG AUDIT — PHASE 5 of 6: TENANT ISOLATION (ADVERSARIAL)

Read docs/os/audits/rag/01-map.md first and use its read/write inventory as your
checklist. Also read the INV-1..INV-6 definitions wherever they are recorded in
docs/os/ and treat them as the standard you are auditing against.

This is a safety-floor audit. Your stance is adversarial: you are trying to FIND a
leak, not to confirm there is none. A finding of "isolation is correct" is only
credible if you document the specific attacks you attempted and why each failed.

NON-DESTRUCTIVE CONTRACT:
Do NOT modify source, schema, config, or tests. Do NOT add a test — a missing negative
test is a FINDING for Phase 6, written into the artifact as a proposed test name and
assertion, never as a committed test. Do NOT install packages. Do NOT write to any
database.

PHASE 0 — report, then STOP if a condition fires:
1. docs/os/ read; INV-1 quoted verbatim; 01-map.md present and consistent with HEAD
2. HEAD sha; `git status --porcelain` clean
3. STOP and escalate IMMEDIATELY, before completing the audit, if you find a read of
   knowledge_chunks with no tenant predicate on a reachable request path. Report it as
   the first line of your output. Do not fix it.
4. Confirm read-only in one line

SCALE ENVELOPE:
<PASTE §0.1>

SCOPE:

A. TENANT RESOLUTION, PER ENTRY POINT.
   For each entry point that can reach retrieval — WhatsApp webhook, inbound voice
   call / DID resolution, portal session, portal test turn, admin panel, any internal
   or scheduled job — trace where tenant_id originates and answer:
   - Is it derived from a server-side authenticated source, or from request input?
   - Can any request-supplied value (body, query, header, path param, webhook payload
     field) influence it, directly or after a lookup?
   - What happens when resolution fails or is ambiguous — does it deny, or default?
   A default-on-failure is a leak even if no current caller triggers it.

B. FULL CHAIN TRACE, PER PATH.
   request → tenant resolution → retrieval call → SQL predicate → returned chunks →
   any cache or shared state → prompt assembly → LLM → response → logs/traces.
   Walk every read path in 01-map.md's inventory. For each hop, state what carries the
   tenant boundary and what would happen if that hop were wrong. Do not summarise
   several paths together — the value is in doing each one.

C. THE SQL LAYER.
   Confirm every read of knowledge_chunks carries a tenant predicate, parameterised,
   with the tenant value not derived from user input. Check specifically:
   - Any query built by string concatenation or template literal
   - Any query where the tenant predicate is optional or conditionally applied
   - Any ORDER BY / LIMIT applied before rather than after the tenant filter
   - Any function taking tenantId with a default value or accepting undefined
   - Whether an id belonging to another tenant returns null (inert) or errors (oracle)

D. SHARED STATE AND CACHES.
   Enumerate every cache, memo, module-level variable, singleton, or connection-scoped
   setting anywhere on the retrieval path. For each: is the key tenant-scoped? Would a
   future cache added at this point leak by default? Note that Phase 4 may have
   proposed caching — record the exact tenant-scoping requirement any such cache must
   satisfy, so a later implementation session cannot get it wrong.

E. OBSERVABILITY LEAKAGE.
   Do logs, traces, error messages, metrics labels, or turn_traces rows ever contain
   another tenant's chunk content or ids in a context readable by the wrong party?
   Check what retrieval provenance captures and who can read it.

F. NEGATIVE TEST COVERAGE.
   List the cross-tenant negative tests that exist today for retrieval, by file and
   test name. Then list the ones that SHOULD exist and do not, each as a proposed test
   name and the assertion it would make. Do not write them.

G. VERDICT.
   One of: ISOLATION HOLDS ON ALL AUDITED PATHS (with the attack list that failed) /
   ISOLATION HOLDS BUT IS UNDEFENDED AT <hop> (correct today, no test or structural
   guarantee) / LEAK FOUND (with reproduction). Nothing softer than these three.

OUT OF SCOPE: performance, retrieval quality, chunking, recommendations beyond the
proposed tests, and any fix.

EVIDENCE FORMAT: file path → function → actual behavior → evidence → impact.
Every "this is safe" claim must name the line that makes it safe.

OUTPUT: docs/os/audits/rag/05-isolation.md with: header; INV-1 as the standard;
entry-point resolution table; per-path chain traces; SQL layer findings; shared state
and cache findings including the caching constraint for Phase 4's proposal;
observability findings; existing vs. missing negative tests; the single verdict from
G; attempted attacks and why each failed; UNVERIFIED.

DEFINITION OF DONE: artifact exists; `git status --porcelain` shows only it; `npm test`
count unchanged, fail 0 — paste the line; verdict is one of the three exact forms.
Report git status and the test line verbatim.
```

---

## Phase 6 — Synthesis & Prioritised Recommendations

**Objective.** Collapse the phase artifacts into a single decision document with a defensible do/don't-do list, ranked, with the "do not build this" section given equal weight to the build list.

**Inspect.** Only `docs/os/audits/rag/01-05` and `docs/os/`. No fresh code exploration except to resolve a direct contradiction between artifacts.

**Evidence.** Every claim in the synthesis must trace to a phase artifact section, cited by artifact and section number.

**Output.** `docs/os/audits/rag/06-synthesis.md`.

**Depends on.** All executed phases. Must state which were not run.

**Type.** Audit-only.

```
RAG AUDIT — PHASE 6 of 6: SYNTHESIS & PRIORITISED RECOMMENDATIONS

Read every artifact in docs/os/audits/rag/ and docs/os/state.md, clocks.md,
decisions.md, assumptions.md.

NON-DESTRUCTIVE CONTRACT:
Do NOT modify source, schema, config, or tests. Do NOT install anything. Do NOT
implement any recommendation. This session produces one document.

PHASE 0 — report, then STOP if a condition fires:
1. List which of 01–05 exist. STOP if 01 is missing. Proceed if others are missing but
   name every absent phase and mark its sections DEFERRED, never inferred.
2. HEAD sha; `git status --porcelain` clean
3. Report any DIRECT CONTRADICTION between two artifacts. Resolve it by opening the
   code and citing HEAD — this is the ONLY code exploration permitted this session.
4. Confirm read-only in one line

SCALE ENVELOPE:
<PASTE §0.1>
VERDICT TAXONOMY AND BURDEN OF PROOF:
<PASTE §0.2 IN FULL>

BINDING CONSTRAINTS ON YOUR CONCLUSIONS:
- Every claim cites an artifact and section. An uncited claim is deleted.
- Where a phase was not run, its section says DEFERRED — never a guess.
- The goal is the SIMPLEST architecture with excellent retrieval quality, not the most
  sophisticated. A recommendation that adds a dependency, a network hop, or a failure
  mode must show what it buys, in a number.
- No recommendation may be justified by industry practice, literature, or what other
  RAG systems do. Only by this repository's evidence and this envelope.
- Recommendations must be ranked by the founder OS hierarchy: H1 safety and legal
  floor → H2 external clocks → H3 launch gates → H4 named customer evidence → H5
  everything else. State each recommendation's level. Anything landing at H5 is
  explicitly NOT scheduled and must be labelled as such.
- Distinguish DEFECT (behaves incorrectly today) from OPTIMISATION (behaves correctly,
  could be better). Defects and optimisations do not compete in the same ranking.

OUTPUT: docs/os/audits/rag/06-synthesis.md with these sections in order:
 1.  Current RAG architecture (one page, no code dumps)
 2.  Actual end-to-end retrieval flow, per channel
 3.  Chunking assessment
 4.  Embedding assessment
 5.  Vector database and index assessment
 6.  Retrieval algorithm assessment
 7.  Retrieval quality assessment — including an honest statement of what CANNOT be
     assessed without production queries, and what would produce that evidence
 8.  Latency assessment against the extracted turn deadline
 9.  Token and cost assessment with arithmetic
10.  Tenant isolation and security assessment — carries Phase 5's verdict verbatim
11.  Advanced RAG technique assessment — the full A–E verdict table, consolidated
12.  Top 5 strengths, each cited
13.  Top 5 weaknesses, each cited, each labelled DEFECT or OPTIMISATION
14.  Recommendations, P0/P1/P2/P3, each in this exact form:
       Problem → Evidence (artifact + file:line) → Proposed change → Expected benefit
       (in a number) → Complexity (in Claude Code sessions) → Cost impact (₹) →
       Hierarchy level (H1–H5) → Why it is justified NOW rather than later
     A recommendation missing any field is deleted, not softened.
15.  WHAT SHOULD NOT BE IMPLEMENTED — every E verdict with its one-line reason. Treat
     this as a first-class deliverable: it is the section that protects the next six
     months from RAG fashion. It should be the longest list in the document.
16.  What should be implemented now — P0/P1 only, with the gate or invariant each
     serves. If the honest answer is "nothing except the H1 items", say exactly that.
17.  What should wait until scale — each with its numeric trigger, in a form that can
     be checked later (e.g. "when any tenant exceeds N chunks", "when p95 retrieval
     exceeds N ms in production")
18.  Final RAG maturity score, 1–10, WITH the rubric you scored against, stated before
     the score. A score against an unstated rubric is decoration. Score against
     fitness for THIS product at THIS scale — not against a generic RAG maturity model.
19.  Final production-readiness assessment: READY / READY WITH P0 FIXES / NOT READY,
     with the specific blocking items and nothing hedged.
20.  PROPOSED ISSUES — each P0/P1 as a one-issue-per-session Claude Code scope, with
     its Phase 0 STOP conditions and its runtime-evidence definition of done, ready to
     be dropped into docs/specs/. These are proposals; do not execute any of them.

DEFINITION OF DONE: artifact exists; `git status --porcelain` shows only it; `npm test`
count unchanged, fail 0 — paste the line; every recommendation carries all eight
fields; §15 is non-empty. Report git status and the test line verbatim.
```

---

## Appendix — Running this without wasting sessions

- **Do not run all six.** Phases 1 and 5 answer the question that outranks everything (H1). Phases 2, 3, 4 answer quality and cost questions that are largely determined by corpus size and are better answered against real traffic.
- **Phase 3's filtered-search check is the one performance item worth doing early**, because it is a *correctness* question, not a tuning question: if `WHERE tenant_id = $1` + ANN ordering can return fewer than K rows, retrieval silently under-returns for small tenants, and every tenant is a small tenant right now.
- **Phase 4 §G will mostly return E.** That is the correct outcome, not a failed audit. A corpus of a few hundred chunks per tenant with top-K of 3 cannot benefit from most of the technique list, and the artifact saying so in writing is worth more than any of them.
- If a phase produces fewer than three findings, that is a signal the system is simple, not that the audit was shallow. Record it and stop.
