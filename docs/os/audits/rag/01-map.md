# RAG Audit — Phase 1: Map & Divergence Ledger

**HEAD:** `da27980a3ab9ab56978f5b854b3cc62ae498f53d`
**Branch:** `main`
**Date:** 2026-08-08
**Type:** audit-only. No source, schema, migration, config, test, or dependency was modified.

**`npm test`:**

```
# tests 989
# suites 160
# pass 989
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 86116.5395
```

This matches `docs/os/state.md:69` exactly (989 tests / 160 suites / 0 fail).

## 0.1 Phase 0 gate report

| Gate | Result |
|---|---|
| `docs/os/` readable | ✅ all four registers read |
| Module owning `knowledge_chunks` located | ✅ `src/modules/knowledge/` — `knowledgeService.js`, `faqService.js` |
| Working tree clean | ⚠️ **fired on a technicality — proceeded, see below** |

`git status --porcelain` at session start and at session end (excluding this artifact):

```
?? "Phase 1 \342\200\224 Map & DivergenceLedger.md"
?? docs/audit/rag-audit-workflow.md
```

**Zero tracked files are modified.** Both entries are untracked markdown that predate this
session: one is this phase's own prompt saved at the repo root, the other is the audit
workflow document that defines this phase. Neither is source, schema, config, or test, so
neither can make HEAD an unfaithful description of the runtime path — which is the only
property the dirty-tree gate protects. The non-destructive contract forbids deleting them,
so the Definition of Done's "`git status --porcelain` shows ONLY that one file" is
unachievable without violating the contract it sits beside. Recorded as a deviation rather
than silently satisfied.

**`Verified-at` note.** `docs/os/state.md:5` records `424ca05`; HEAD is `da27980`, which
*is* the commit that stamped it. The string can never equal HEAD by construction;
`npm run os:check` is the operative provenance test.

**Gate status:** G-CLOCK ❌ · G-PROOF ❌ · G-PAY ❌ · G-TEN ❌. Launch gates 4/7 at HEAD
(`state.md:57-65`).

**Clocks relevant to knowledge/RAG: none.** All three (`clocks.md`) are `Filed: —`,
`Reference: —`. C-2 (Plivo DID) and C-3 (Meta WABA) gate the two *channels* that reach
retrieval; neither gates the knowledge subsystem, and nothing in the retrieval path has an
external counterparty other than the Google embedding API, which is already in use.

## 0.2 Scale envelope (as supplied — founder planning estimates, not measured production values)

```
- Chunks per tenant, today:            0 (no tenants)  [HIGH]
- Chunks per tenant, at 10 clinics:    150 typical / 250 ceiling  [HIGH for FAQ half
                                       — MAX_FAQS=100, 1 FAQ = 1 chunk, chunkText not
                                       on the FAQ path; MEDIUM for document half]
- Total vectors at 10 clinics:         1,500 typical / 2,500 ceiling (~4.6 MB at
                                       vector(768))  [HIGH]
- Tenants, today:                      0        Tenants at G-TEN:  10
- Retrievals/day/tenant, expected:     200  [LOW]
- Total retrievals/day at 10 clinics:  2,000; peak ~10/minute system-wide  [LOW]
- Voice turn latency budget:           CANDIDATE 8,000 ms server / 10,000 ms worker
                                       — Phase 1 to confirm (see §4)
- WhatsApp turn latency budget:        UNKNOWN — Phase 1 to confirm (see §4)
- Embedding latency (measured, ingest): 600–900 ms
- Per-turn hydration (measured):       300–465 ms
- Infra:                               Railway, single region, one Postgres
- Embedding provider:                  Google, gemini-embedding-001, outputDimensionality
                                       768 (schema comment + migration 004 name
                                       text-embedding-004 — see §5 D-01)
- Cost ceiling that matters:           ₹4,999/month/clinic gross revenue
- Production traffic / transcripts:    none
```

Envelope items §A–§C were asked to resolve are settled in §4: **the voice budget is
confirmed at 8,000 ms**, and **the WhatsApp path has no deadline of any kind**.

---

# 1. Runtime path, per channel

## 1.0 The one-line summary

Every path converges on **one function**: `knowledgeService.getRelevantChunks`
(`src/modules/knowledge/knowledgeService.js:33`). There is exactly **one** vector query in
the repository (`:37-44`) and exactly **one** place retrieved chunks enter a prompt
(`src/modules/ai/aiService.js:567-569`). Three of the five production call sites reach
`getRelevantChunks` through the shared `assembleConversationContext`; two call it directly.

## 1.1 Channel A — WhatsApp inbound (production request path)

| # | file:line | function | what it actually does |
|---|---|---|---|
| 1 | `server.js:26` | mount | `app.use('/webhook', express.raw({type:'application/json'}), require('./src/modules/channels/whatsapp/routes'))` — mounted **before** `express.json()` (`server.js:51`) so the raw body survives for HMAC |
| 2 | `channels/whatsapp/routes.js:260` | router | `router.post('/', correlation, verifySignature, handle)` |
| 3 | `channels/whatsapp/routes.js:23-51` | `verifySignature` | HMAC-SHA256 over the raw body vs `x-hub-signature-256`, `timingSafeEqual`; parses JSON on success |
| 4 | `channels/whatsapp/routes.js:66-67` | `handle` | `res.sendStatus(200)` **first** — everything below runs after the response is sent |
| 5 | `channels/whatsapp/routes.js:89` | `tenantService.getByPhoneNumberId` | tenant from `value.metadata.phone_number_id`; `null` ⇒ `continue` (no retrieval) |
| 6 | `channels/whatsapp/routes.js:97-118` | owner detection | messages from `tenant.owner_notify_phone` are routed to `ownerCommands.handle` and **never** reach retrieval |
| 7 | `channels/whatsapp/routes.js:124-130` | `adapter.parseInbound` → `handleInbound` | envelopes persisted; result rows destructured at `:133` as `{ envelope, customer, conversation, timerLabel, messageId }` |
| 8 | `channels/whatsapp/routes.js:136-141` | non-text gate | `envelope.messageType !== 'text'` ⇒ stored, `continue`. **No retrieval.** |
| 9 | `channels/whatsapp/routes.js:147-151` | `traces.open` | opens the turn trace collector (channel `whatsapp`) — this is what makes the retrieval capture at step 12 non-null |
| 10 | `channels/whatsapp/routes.js:160-178` | mode gate | `freshConv.mode === 'human'` or `!tenant.ai_enabled` ⇒ `continue`. **No retrieval.** |
| 11 | `channels/whatsapp/routes.js:184-191` | **`assembleConversationContext`** | `{ tenantId, conversationId, customerId, currentMessageId: messageId, text: userText, onTiming }` — **no `signal`, no `ragTopK`** (defaults to 3) |
| 12 | `conversation/contextAssembler.js:66-76` | `Promise.all` | three parallel legs: `getRelevantChunks` ∥ `getRecentMessages` ∥ `customer_memory` SELECT |
| 13 | `knowledge/knowledgeService.js:34` | `embed(query, signal)` | **one HTTP call to Google** per turn; `signal` is `null` here |
| 14 | `knowledge/knowledgeService.js:37-44` | vector query | the single retrieval SQL (§3) |
| 15 | `conversation/contextAssembler.js:67-70` | `.catch` | **any RAG failure ⇒ `[]` + `logger.error('RAG failed (continuing without)')`. The turn proceeds ungrounded.** |
| 16 | `conversation/contextAssembler.js:83-88` | `trace.setRetrieval` | records `[{chunk_id, score}]`, or `null` when zero chunks — never content |
| 17 | `channels/whatsapp/routes.js:200-203` | `aiService.generateReply` | `(tenant, customer, conversation, userText, history, knowledgeChunks, facts, { channel:'whatsapp', metrics })` — **no `signal`** |
| 18 | `ai/aiService.js:224-225` | `resolveSystemInstruction` | → `buildSystemPrompt(..., knowledgeChunks, channel, config)` |
| 19 | `ai/aiService.js:567-569` | **`knowledgeSection`** | **the terminal hop — chunks enter the prompt here** |
| 20 | `ai/aiService.js:589-620` | prompt assembly | `knowledgeSection` interpolated between customer facts and the `Rules:` block |

**Prompt insertion, verbatim (`aiService.js:567-569`):**

```js
const knowledgeSection = knowledgeChunks.length
  ? `\nBusiness knowledge (use ONLY this to answer questions — do not invent information):\n${knowledgeChunks.map(c => `- ${c.content}`).join('\n')}`
  : '';
```

*Why it matters:* chunks are rendered as a flat `- ${content}` list. **No delimiter, no
provenance label, no similarity score, no ordering marker, no dedup** reaches the model.
Zero chunks produce an empty string, so the prompt silently loses the "use ONLY this"
instruction along with the knowledge — the model then falls back to `Rules:` line 3
(`aiService.js:602`, "NEVER make up information").

## 1.2 Channel B — Voice turn, JSON branch (production request path)

| # | file:line | function | what it actually does |
|---|---|---|---|
| 1 | `server.js:31-35` | mount | `/internal/voice` mounts **only when `VOICE_ENABLED === 'true'`** |
| 2 | `routes/internalVoice.js:669` | router | `router.post('/turn', express.raw({type:'*/*'}), authenticate, correlation, handleTurn)` |
| 3 | `routes/internalVoice.js:27-43` | `authenticate` | HMAC over raw body vs `x-internal-signature`, secret `VOICE_INTERNAL_SECRET` |
| 4 | `routes/internalVoice.js:98` | `handleTurn` | `if (wantsStream(req)) return handleTurnSSE(req, res)` — the SSE fork |
| 5 | `routes/internalVoice.js:130-141` | abort plumbing | one `AbortController` fed by `res.on('close')` **and** `setTimeout(…, turnBudgetMs())` |
| 6 | `routes/internalVoice.js:149-152` | call_session lookup | `tenant_id, customer_id, conversation_id` — **tenant is never worker-supplied** |
| 7 | `routes/internalVoice.js:187-194` | persist inbound | inserted **before** context assembly so history can exclude it by id (V-009) |
| 8 | `routes/internalVoice.js:214-218` | mode gate | same gate as WhatsApp; returns empty reply. **No retrieval.** |
| 9 | `routes/internalVoice.js:223` | `aiService.throwIfAborted(signal)` | pre-fetch abort checkpoint |
| 10 | `routes/internalVoice.js:227-235` | **`assembleConversationContext`** | **passes `signal`** — the only retrieval call site in the repo that is abort-bounded |
| 11 | — | (identical to Channel A steps 12–16) | |
| 12 | `routes/internalVoice.js:241-244` | `aiService.generateReply` | `{ channel:'voice', metrics, signal, onCommitted }` |
| 13 | `ai/aiService.js:214-222` | voice prompt diet | history sliced to `VOICE_HISTORY_TURNS` (8), facts capped at `VOICE_MEMORY_FACTS_MAX` (10). **Knowledge chunks are NOT dieted** — they pass through untouched |
| 14 | `ai/aiService.js:567-569` | `knowledgeSection` | same terminal hop as WhatsApp |

## 1.3 Channel C — Voice turn, SSE branch (dark: `VOICE_STREAM_TURNS=false`)

Identical to Channel B through step 9, then:

| # | file:line | what it actually does |
|---|---|---|
| 10 | `routes/internalVoice.js:435-442` | **`assembleConversationContext` — WITHOUT `signal`** |
| 11 | `routes/internalVoice.js:451-474` | `aiService.generateReplyStream(...)` — signal reaches Gemini but not the embedding |
| 12 | `ai/aiService.js:359-360` | `resolveSystemInstruction(..., 'voice')` — same prompt path |

**This is the one place where two channels that claim to be mirrors are not.** The JSON
branch's docstring for the SSE branch (`internalVoice.js:296-299`) calls it "an intentional
mirror" of "the same hydrate/gate/fetch/persist-inbound flow", and `contextAssembler.js:42-47`
documents `signal` as the thing that "bounds the RAG embedding call". On the SSE branch that
sentence is false. See §5 D-09 — and note `ARCHITECTURE.md:90` states production sets
`VOICE_STREAM_TURNS=true` at deploy, so this is the branch a live call is intended to take.

## 1.4 Channel D — Portal "Test your receptionist" (owner-facing request path)

| # | file:line | what it actually does |
|---|---|---|
| 1 | `src/portal/routes.js:2034-2039` | route header; `channel:'test'`, 20/day/tenant, no persistence |
| 2 | `ai/testTurnService.js:90-93` | `countTestTurnsToday` — rate limit counted from `turn_traces` |
| 3 | `ai/testTurnService.js:68-76` | `fetchTenantForBrain` — nulls `owner_notify_phone` **and** sets `SUPPRESS_OWNER_ALERTS` |
| 4 | `ai/testTurnService.js:106-111` | **`knowledgeService.getRelevantChunks(tenantId, question, RAG_TOP_K)` — direct, bypasses `assembleConversationContext`** |
| 5 | `ai/testTurnService.js:112-114` | `trace.setRetrieval` — duplicated inline (the shared assembler's capture is not reached) |
| 6 | `ai/testTurnService.js:126-129` | `generateReply(..., { channel:'test' })` with **empty history and empty facts** |
| 7 | `ai/testTurnService.js:149` | `knowledge_used: knowledgeChunks.length > 0` — surfaced to the owner as provenance |

**Why it diverges (stated at `testTurnService.js:100-105`):** the shared assembler requires
`currentMessageId`, and a test turn persists no inbound row — `contextAssembler.js:55-57`
throws without it. So the RAG leg is lifted out and the other two legs are dropped. The
`try/catch` at `:107-111` reproduces the shared assembler's best-effort degrade by hand.

## 1.5 Channel E — `validationService` KB retrieval smoke check (operator/portal, background)

| # | file:line | what it actually does |
|---|---|---|
| 1 | `validation/validationService.js:34` | `const { getRelevantChunks } = require('../knowledge/knowledgeService')` |
| 2 | `validation/validationService.js:364-369` | injected as `ctx.deps.getRelevantChunks` (overridable by `opts.deps` — this is how every test stubs it) |
| 3 | `validation/validationService.js:210-216` | `checkKbPopulated` — raw `count(*)` on `knowledge_chunks`, fails under `ctx.kbMin` (default **5**, `:360`) |
| 4 | `validation/validationService.js:218-225` | **`checkKbRetrieval` — `getRelevantChunks(tenantId, 'what are your timings', 1)`. topK = 1, hardcoded query.** Zero chunks ⇒ `fail` |
| 5 | `validation/validationService.js:309-311` | `kb.retrieval` is skipped when `kb.populated` was skipped |

**This is the only retrieval call in the repo with a topK other than 3, and the only one
whose query text is a constant rather than patient input.**

## 1.6 Channel F — `scriptedTurnCheck` (the dynamic `turn.scripted` validation check)

| # | file:line | what it actually does |
|---|---|---|
| 1 | `validation/scriptedTurnCheck.js:68` | imports the real `assembleConversationContext` |
| 2 | `validation/scriptedTurnCheck.js:280-288` | `deps` object — `assembleConversationContext` injected, overridable via `ctx.deps` |
| 3 | `validation/scriptedTurnCheck.js:240-244` | persists a synthetic inbound row (so `currentMessageId` exists) |
| 4 | `validation/scriptedTurnCheck.js:246-250` | **`deps.assembleConversationContext({...})` — no `signal`, no `ragTopK`** (defaults to 3) |
| 5 | `validation/scriptedTurnCheck.js:255-257` | `generateReply(..., { channel:'voice' })` against a synthetic customer |

This path runs **against the tenant's real `knowledge_chunks`** — it is a full-fidelity turn
whose only synthetic parts are the customer and conversation.

## 1.7 Channels G — non-production scripts (recorded for completeness, not on any request path)

| file:line | call | note |
|---|---|---|
| `scripts/test-chat.js:35` | `getRelevantChunks(tenant.id, text, 3)` | local CLI harness; hand-rolls the assembler's `Promise.all` (`:34-41`) rather than importing it — a **fourth copy** of the parallel-fetch shape |
| `scripts/demo/capture_turn.js:126-129` | `assembleConversationContext` | demo fixture capture |
| `scripts/ingest-knowledge.js:21-25` | `chunkText` + `storeChunks` | the **only** CLI document-ingestion path |

---

# 2. Shared vs. channel-specific — with the caller lists that prove it

## 2.1 Shared: `contextAssembler.assembleConversationContext`

`src/modules/conversation/contextAssembler.js:54`. **Exhaustive caller list**
(`git grep -n "assembleConversationContext"`, 5 call sites + 1 definition + 1 export + 1 test file):

| Caller | file:line | `signal`? | `ragTopK`? | Path type |
|---|---|---|---|---|
| WhatsApp inbound | `channels/whatsapp/routes.js:184` | ✗ | default 3 | request |
| Voice turn, JSON | `routes/internalVoice.js:227` | **✓** | default 3 | request |
| Voice turn, SSE | `routes/internalVoice.js:435` | ✗ | default 3 | request |
| `turn.scripted` validation | `validation/scriptedTurnCheck.js:246` | ✗ | default 3 | background |
| demo capture script | `scripts/demo/capture_turn.js:126` | ✗ | default 3 | script |
| *(tests)* | `tests/conversation/contextAssembler.test.js:34,61,76,86` | — | `:76` passes 5 | test-only |

**Nothing in this function branches on channel** (`contextAssembler.js:26-29` states this as
its design contract, and the body confirms it: `:66-76` has no conditional). The voice/WhatsApp
divergence is entirely upstream (which arguments are passed) and downstream (the prompt diet at
`aiService.js:214-222`, which does not touch chunks).

## 2.2 Shared: `knowledgeService.getRelevantChunks`

`src/modules/knowledge/knowledgeService.js:33`. **Exhaustive caller list** (production +
scripts; test stubs excluded):

| Caller | file:line | topK | `signal`? |
|---|---|---|---|
| `contextAssembler` (⇒ 5 callers above) | `contextAssembler.js:67` | passthrough `ragTopK` | passthrough |
| `testTurnService` | `ai/testTurnService.js:108` | `RAG_TOP_K` = 3 (`:28`) | ✗ |
| `validationService.checkKbRetrieval` | `validation/validationService.js:220` | **1** | ✗ |
| `scripts/test-chat.js` | `scripts/test-chat.js:35` | 3 | ✗ |

**Total production entry points that can reach a vector query: 6** (WhatsApp, voice-JSON,
voice-SSE, portal test turn, `kb.retrieval` validation, `turn.scripted` validation).

## 2.3 Channel-specific components

| Component | Channel | file:line | Effect on retrieval |
|---|---|---|---|
| Abort signal on the embedding call | voice-JSON only | `internalVoice.js:233` | bounds the Google HTTP call at 8 s; **absent everywhere else** |
| Prompt diet (history/facts) | voice + SSE | `aiService.js:214-222`, `:349-357` | **none** — chunks are not capped or trimmed |
| `voiceStyle` block | voice | `aiService.js:576-581` | none |
| `generateReplyStream` | voice-SSE | `aiService.js:348` | none — same `resolveSystemInstruction` |
| `channel === 'test'` tool gate | portal test turn | `aiService.js:156,168,182` | none — gates writes, not reads |
| Non-text / owner / mode gates | WhatsApp | `routes.js:136,102,160` | bypass retrieval entirely |

## 2.4 What the Python voice worker does with retrieval: **nothing**

`git grep -nEi "knowledge|chunk|embed|retriev|rag" -- voice-agent` returns **zero**
retrieval hits — every match is the word "chunk" meaning an HTTP/SSE body chunk
(`voice-agent/agent.py:129,187-188,218,233`) or a timeout doc line
(`voice-agent/README.md:36`). The worker is transport only, exactly as
`ARCHITECTURE.md:38` requires. Files inspected: `agent.py`, `brain_client.py`,
`turn_context.py`, `README.md`, `.env.example`, 4 test files.

---

# 3. Complete read/write inventory of `knowledge_chunks`

## 3.1 How exhaustiveness was established

1. `git --no-pager grep -n "knowledge_chunks" -- .` — every literal SQL reference in the
   repository, including docs, tests, and scripts (**73 hits**).
2. `git --no-pager grep -n "getRelevantChunks\|assembleConversationContext\|storeChunks\|chunkText\|knowledgeService\|faqService" -- .` — every service-level access (**~140 hits**).
3. `git --no-pager grep -nE 'FROM \$\{|INTO \$\{|UPDATE \$\{|DELETE FROM \$\{' -- src scripts core server.js` — **zero hits.** No table name is ever interpolated, so a literal grep is complete.
4. There is **no ORM** (`CLAUDE.md`; `src/db/db.js:33-37` exports only `query`, `getClient`, `close`), so no query can be generated outside these greps.

**Residual gap:** `db.getClient()` hands out a raw pg client that could execute arbitrary SQL —
but any such SQL is still literal text in a repository file and is therefore caught by grep (1).
I found no `getClient()` use touching this table.

## 3.2 READS — verbatim SQL

| # | file:line | Verbatim SQL | Caller(s) | Path |
|---|---|---|---|---|
| R1 | `knowledge/knowledgeService.js:38-42` | `SELECT id, content, 1 - (embedding <=> $2::vector) AS similarity FROM knowledge_chunks WHERE tenant_id = $1 ORDER BY embedding <=> $2::vector LIMIT $3` | `getRelevantChunks` ← 6 entry points (§2.2) | **request + background** |
| R2 | `knowledge/knowledgeService.js:88-90` | `SELECT id, content, source, created_at FROM knowledge_chunks WHERE tenant_id = $1 ORDER BY created_at` | `listChunks` ← `faqService.listFaqs:110` ← `portal/routes.js:1952` | request (portal) |
| R3 | `knowledge/knowledgeService.js:101-103` | `SELECT id, content, source, created_at FROM knowledge_chunks WHERE tenant_id = $1 AND id = $2` | `getChunk` ← `updateChunk:133` | request (portal) |
| R4 | `knowledge/knowledgeService.js:112-114` | `SELECT count(*)::int AS n FROM knowledge_chunks WHERE tenant_id = $1 AND (source = $2 OR source LIKE $2 \|\| ':%')` | `countChunksBySourcePrefix` ← `faqService.countFaqs:115` ← `createFaq:120` (the `MAX_FAQS` gate) | request (portal) |
| R5 | `validation/validationService.js:211-212` | `SELECT count(*)::int AS n FROM knowledge_chunks WHERE tenant_id = $1` | `checkKbPopulated` | background (validation) |
| R6 | `tenant/lifecycleService.js:167` | `(SELECT max(updated_at) FROM knowledge_chunks WHERE tenant_id = $1)` inside `validationInputsChangedAt` | readiness staleness / go-live chain | request (portal) + background |
| R7 | `provisioning/provisioningService.js:136-139` | `SELECT 1 FROM knowledge_chunks WHERE tenant_id = $1 AND source = $2 LIMIT 1` | `ingestKnowledge` — resume/dedup by filename | background (CLI) |

**All seven reads carry `WHERE tenant_id = $1`, parameterised.** R1 is the only read that
touches the `embedding` column, and the only one in the repository that performs a vector
comparison.

## 3.3 WRITES — verbatim SQL

| # | file:line | Verbatim SQL | Caller chain | Path |
|---|---|---|---|---|
| W1 | `knowledge/knowledgeService.js:25-26` | `INSERT INTO knowledge_chunks (tenant_id, content, embedding, source) VALUES ($1, $2, $3::vector, $4)` | `storeChunks` ← `scripts/ingest-knowledge.js:25` **and** `provisioningService.js:147` | background (CLI only) |
| W2 | `knowledge/knowledgeService.js:122-123` | `INSERT INTO knowledge_chunks (tenant_id, content, source, embedding) VALUES ($1, $2, $3, $4::vector) RETURNING id, content, source, created_at` | `createChunk` ← `faqService.createFaq:123` ← `POST /portal/api/faqs` (`routes.js:1979`) | **request (portal)** |
| W3 | `knowledge/knowledgeService.js:138-139` | `UPDATE knowledge_chunks SET source = $3 WHERE tenant_id = $1 AND id = $2 RETURNING …` | `updateChunk` **text-unchanged branch** ← `faqService.updateFaq:134` ← `PATCH /portal/api/faqs/:id` | request (portal) |
| W4 | `knowledge/knowledgeService.js:147-148` | `UPDATE knowledge_chunks SET content = $3, source = $4, embedding = $5::vector WHERE tenant_id = $1 AND id = $2 RETURNING …` | `updateChunk` **text-changed branch** (same chain) | request (portal) |
| W5 | `knowledge/knowledgeService.js:159` | `DELETE FROM knowledge_chunks WHERE tenant_id = $1 AND id = $2` | `deleteChunk` ← `faqService.deleteFaq:142` ← `DELETE /portal/api/faqs/:id` | request (portal) |
| W6 | `db/schema.sql:291` | `tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE` | **implicit** — deleting a tenant deletes its chunks; no application code involved | schema |

**There are exactly five application write paths and one implicit cascade.** W1 is the only
one that goes through the chunker; W2–W5 are the FAQ editor and store one row per Q/A pair.

## 3.4 Test-only and script-only touches (not production paths)

Raw SQL against the table appears in: `tests/admin/tenantLifecycle.test.js:147`,
`tests/lifecycle/lifecycle.integration.test.js:171`,
`tests/portal/portalFaqs.integration.test.js:181,185,193`,
`tests/portal/portalLifecycle.integration.test.js:197,208,457,683,798,804,807`,
`tests/provisioning/provisioning.integration.test.js:307`,
`tests/validation/validation.integration.test.js:156`,
`scripts/portal/f1.js:337,501,503,508`. Service-level FAQ creation in the portal screenshot
scripts: `shoot.js:387-393,448`, `shootD3.js:335`, `shootD4.js:376`, `shootD5a.js:473`,
`shootD5b.js:560`, `shootWizard.js:237`.

## 3.5 Schema at HEAD

`src/db/schema.sql:289-310`:

```sql
CREATE TABLE knowledge_chunks (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  content     TEXT NOT NULL,
  embedding   vector(768),         -- Google text-embedding-004 output dimension
  source      TEXT,                -- filename or label for traceability
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TRIGGER trg_knowledge_chunks_updated BEFORE UPDATE ON knowledge_chunks
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_knowledge_chunks_tenant ON knowledge_chunks(tenant_id);
CREATE INDEX idx_knowledge_chunks_hnsw
  ON knowledge_chunks USING hnsw (embedding vector_cosine_ops);
```

**`embedding` is nullable** — no `NOT NULL`, no `CHECK`. W2/W4 always supply it; nothing
structurally prevents a NULL-embedding row (see §7 Q3-2).

Migrations touching the table — the complete set (`git grep`):

| File | Effect |
|---|---|
| `002_knowledge_chunks.sql:4-13` | creates the table with `embedding vector(768)` and `idx_knowledge_chunks_tenant` |
| `004_embedding_768.sql:2-4` | `DROP COLUMN embedding` → `ADD COLUMN embedding vector(768)` → creates `idx_knowledge_chunks_hnsw` |
| `026_knowledge_entity_updated_at.sql:58,67-69` | adds `updated_at` + attaches the existing `set_updated_at` trigger |

**Replaying 002 → 004 → 026 reproduces `schema.sql` exactly** (columns, both indexes,
trigger). The lockstep rule holds for this table. Note `004` is a **no-op on
dimensionality** — see §5 D-02.

---

# 4. Configuration surface

| Knob | Actual value | file:line | Read at runtime? |
|---|---|---|---|
| **Retrieval** | | | |
| `getRelevantChunks` topK default | `3` | `knowledge/knowledgeService.js:33` | **Y** |
| `assembleConversationContext` `ragTopK` default | `3` | `conversation/contextAssembler.js:54` | **Y** |
| topK — WhatsApp | 3 (default, not passed) | `channels/whatsapp/routes.js:184-191` | **Y** |
| topK — voice JSON | 3 (default, not passed) | `routes/internalVoice.js:227-235` | **Y** |
| topK — voice SSE | 3 (default, not passed) | `routes/internalVoice.js:435-442` | **Y** |
| topK — portal test turn | `RAG_TOP_K = 3` | `ai/testTurnService.js:28`, used `:108` | **Y** |
| topK — `kb.retrieval` check | **`1`** (literal argument) | `validation/validationService.js:220` | **Y** |
| topK — `turn.scripted` | 3 (default) | `validation/scriptedTurnCheck.js:246-250` | **Y** |
| Similarity threshold | **none exists** | — | — |
| Minimum score / score filter | **none exists** | — | — |
| Result dedup | **none exists** | — | — |
| **Embedding** | | | |
| Model instantiated | `'gemini-embedding-001'` | `knowledge/knowledgeService.js:5` | **Y** |
| `outputDimensionality` | `768` | `knowledge/knowledgeService.js:13` | **Y** |
| Stored column dimension | `vector(768)` | `db/schema.sql:293` | **Y** (DDL) |
| Task type (`RETRIEVAL_QUERY`/`_DOCUMENT`) | **not set** — request is `{content:{parts:[{text}]}, outputDimensionality}` | `knowledge/knowledgeService.js:11-14` | **N** |
| Query vs document embedding path | **the same `embed()`** for both | `knowledge/knowledgeService.js:10` ← `:23` (ingest) and `:34` (query) | **Y** |
| SDK | `@google/generative-ai` `^0.24.1` | `package.json:19` | **Y** |
| API key | `process.env.GEMINI_API_KEY` | `knowledge/knowledgeService.js:4` | **Y** |
| **Chunking** (ingest only) | | | |
| `chunkText` `maxLen` | `500` | `knowledge/knowledgeService.js:48` | **Y** — but only from W1 |
| `chunkText` `overlap` | `50` | `knowledge/knowledgeService.js:48` | **Y** — but only from W1 |
| Split boundary | `text.split(/\n\s*\n/)` (blank-line paragraphs) | `knowledge/knowledgeService.js:49` | **Y** |
| Callers passing non-default maxLen/overlap | **none** — both callers call `chunkText(text)` | `scripts/ingest-knowledge.js:21`, `provisioningService.js:146` | — |
| **FAQ caps** | | | |
| `MAX_FAQS` | `100` | `knowledge/faqService.js:39` | **Y** (`createFaq:120`) |
| `MAX_QUESTION` | `200` | `knowledge/faqService.js:40` | **Y** |
| `MAX_ANSWER` | `800` | `knowledge/faqService.js:41` | **Y** |
| `SOURCE_PREFIX` | `'faq'` | `knowledge/faqService.js:38` | **Y** |
| Q/A storage encoding | `` `Q: ${question}\nA: ${answer}` `` | `knowledge/faqService.js:63` | **Y** |
| **Validation** | | | |
| `kbMin` | `5` (override `opts.kbMin`) | `validation/validationService.js:360` | **Y** |
| `kb.retrieval` query text | `'what are your timings'` | `validation/validationService.js:219` | **Y** |
| **Deadlines / timeouts** | | | |
| **Voice turn budget** | **`8000` ms**, env `TURN_BUDGET_MS` | `routes/internalVoice.js:65-68` | **Y** — ✅ envelope CANDIDATE **confirmed** |
| Worker patience | `VOICE_TURN_TIMEOUT_S`, documented default 10 s | `routes/internalVoice.js:59-63` (comment), `voice-agent/README.md:36` | see §8 U-1 |
| **WhatsApp turn deadline** | **NONE — no signal, no timer, no budget** | `channels/whatsapp/routes.js:184-203` | ✅ envelope UNKNOWN **resolved: none exists** |
| Abort signal reaching the embedding call | voice-JSON **only** | `routes/internalVoice.js:233` → `contextAssembler.js:67` → `knowledgeService.js:34` | **Y** (1 of 6 entry points) |
| DB `statement_timeout` | `5000` ms, env `DB_STATEMENT_TIMEOUT_MS` | `db/db.js:16-23` | **Y** — bounds R1's SQL, **not** the embedding HTTP call |
| **Client-side HTTP timeout on `embedContent`** | **NONE** | `knowledge/knowledgeService.js:10-19` | **N** |
| **pgvector index parameters** | | | |
| HNSW `m` | not specified ⇒ pgvector default | `db/schema.sql:309-310`, `004_embedding_768.sql:4` | **N** |
| HNSW `ef_construction` | not specified ⇒ pgvector default | same | **N** |
| `hnsw.ef_search` | **never set anywhere** | — | **N** |
| `ivfflat.probes` | n/a — no IVFFlat index | — | — |

## 4.1 Knobs that exist in config but no runtime code reads

**None for retrieval.** `git grep -nEi 'knowledge|kb|retriev|embed|chunk|top_?k' -- src/modules/config/schema.js src/modules/config/defaults.js` returns **zero hits**.

*Why it matters:* **retrieval is not tenant-configurable at all.** topK, the embedding model,
the chunk size, and the (absent) threshold are all module constants. There is no per-tenant
knob for a clinic with an unusual corpus, and no config-surface drift of the
`voice.did`/`owner_notify_phone` class to worry about here — the opposite risk applies:
changing any retrieval parameter is a code deploy affecting every tenant at once.

---

# 5. Divergence ledger

| ID | Claim (source file:line) | Runtime reality (source file:line) | Severity | Who is wrong |
|---|---|---|---|---|
| **D-01** | `db/schema.sql:293` — `embedding vector(768), -- Google text-embedding-004 output dimension`. And `004_embedding_768.sql:1` — `-- Switch embedding from 3072 (gemini-embedding-001) to 768 (text-embedding-004)` | `knowledge/knowledgeService.js:5` — `genAI.getGenerativeModel({ model: 'gemini-embedding-001' })`, `:13` `outputDimensionality: 768` | **HIGH** | **The comments.** Two sources name `text-embedding-004`; migration 004 additionally records a migration *away from* the model the code now uses. Anyone reading the schema to answer "what embedded these vectors?" gets the wrong model name. |
| **D-02** | `004_embedding_768.sql:1` — the file's stated purpose is changing the dimension from 3072 to 768 | `002_knowledge_chunks.sql:8` **already declares `embedding vector(768)`**; `004:2-3` drops and re-adds the identical type. On the migrate path the file's only real effect is `CREATE INDEX … hnsw` at `:4` | **MEDIUM** | **The migration comment.** A reader reconstructing dimension history from the migrations gets a change that, at HEAD, does not exist on disk. Also worth stating plainly: `004` is destructive — `DROP COLUMN embedding` discards every stored vector; it is safe only because it predates any data. |
| **D-03** | `ARCHITECTURE.md:108` (§2.7) — "`customer_memory` holds a rolling summary + embedding per customer … **retrieval** runs at the start of each new interaction and injects CRM fields, the rolling summary, and **top-k semantic recall** into the prompt." Repeated at `ZYON_V2_SPEC.md:122` and `:229` | `db/schema.sql:261-273` — `customer_memory` columns are `id, tenant_id, customer_id, key, value, source, created_at, updated_at`. **There is no embedding column.** `conversation/contextAssembler.js:72-75` reads `SELECT key, value, updated_at FROM customer_memory … ORDER BY key` — a key-ordered key/value fetch with no vector, no similarity, no top-k. `aiService.js:559-561` renders them as `- ${key}: ${value}` | **HIGH** | **The docs.** They describe a *second* retrieval system, over customer memory, that does not exist in code or schema. The one real semantic retrieval in this repo is over `knowledge_chunks`. Any Phase 2–5 work scoped from `ARCHITECTURE.md` §2.7 would be scoped against imaginary machinery. |
| **D-04** | `ARCHITECTURE.md:94` (§2.5) — inbound call flow: "brain `call/start`: … load CRM fields + rolling memory + top-k recall, return greeting context" | `routes/internalVoice.js:552-600` — `handleCallStart` resolves the customer (`:566`), gets/creates the conversation (`:573`), starts the call session (`:578`), and returns `{ call_session_id, customer_id, conversation_id, correlation_id }` (`:587-595`). **No retrieval, no memory load, no greeting.** Retrieval first happens on the *first turn*, at `:227` | **MEDIUM** | **The doc.** The retrieval exists but at a different point in the call, with different consequences for latency (per-turn, not once-per-call). |
| **D-05** | `ARCHITECTURE.md:96` (§2.5, "Hot-path rules (binding)") — "Everything heavy (summary, **embeddings**, CRM update, notifications, trace writes) runs after `call.ended`, off the hot path." Same claim at `ZYON_V2_SPEC.md:195` | One **synchronous Google embedding HTTP call sits on every voice turn's critical path**: `internalVoice.js:227` → `contextAssembler.js:67` → `knowledgeService.js:34` → `embedContent`. Measured 600–900 ms on the ingestion side (`public/portal/faqs.js:13`) against a turn budget of 8,000 ms (`internalVoice.js:67`) | **HIGH** | **The doc — with a caveat.** The rule's first clause scopes "no embeddings" to in-call *tools*, and retrieval is not a tool. But the second clause is unqualified, and a reader auditing the hot path against this rule would conclude no embedding call happens per turn. It does. |
| **D-06** | `ARCHITECTURE.md:59` (§2.3, binding boundary rule) — "each module owns its tables … cross-module communication is the event bus or an explicit service call — **never another module's tables**", with `knowledge_chunks` assigned to the `knowledge` module at `:74` | **Three modules query `knowledge_chunks` directly**: `validation/validationService.js:211-212`, `tenant/lifecycleService.js:167`, `provisioning/provisioningService.js:136-139` | **MEDIUM** | **The code.** The rule is the right one; three readers violate it. This matters for Phase 5: three of the seven tenant predicates on this table live outside the module that owns it, so a change to the module's isolation contract would not reach them. |
| **D-07** | `ARCHITECTURE.md:245` and `:283` (§6.6, §6.10) — the apply path for a learned KB entry is "`Knowledge.ingest` into the tenant namespace". `ZYON_V2_SPEC.md:138` — "API: `ingest(tenantId, doc)`, `retrieve(tenantId, query, k)`" | `knowledge/knowledgeService.js:165-168` exports `embed, storeChunks, getRelevantChunks, chunkText, listChunks, getChunk, countChunksBySourcePrefix, createChunk, updateChunk, deleteChunk`. **No `ingest`. No `retrieve`.** `git grep "Knowledge.ingest"` finds only the two doc hits | **LOW–MEDIUM** | **The docs.** Exactly the failure mode `state.md:199-206` records for Issue 11's `getTenantByChannel`: a future session greps for a documented symbol, finds zero hits, and concludes the capability is unbuilt. |
| **D-08** | `docs/specs/portal-v1-spec.md:99-100` (§5.8) — "Documents → `knowledge_chunks (source:'document')` … PDF upload ≤10MB → server-side text extraction → chunk → store; document list with delete". `:50` lists Documents among the portal's pages | **No document upload surface exists.** `git grep "'document'"` finds no writer; the only non-FAQ writer is `storeChunks` (W1), reachable only from `scripts/ingest-knowledge.js` and `provisioningService.ingestKnowledge` — both CLI. `docs/design/portal-v2-spec.md:43` and `:668` already record Documents as "never built" / an "inert `Soon` row" | **LOW** (already self-corrected) | **The v1 spec** — superseded by portal-v2-spec but still readable as shipped scope. Consequence for this audit: **the chunker (`chunkText`) is on no request path at all**, which sizes every chunking finding in Phase 2. |
| **D-09** | `routes/internalVoice.js:296-299` — the SSE branch is "an intentional mirror" carrying "the same hydrate/gate/fetch/persist-inbound flow" as the JSON branch. `conversation/contextAssembler.js:42-47` — `signal` is "the voice turn's combined close/deadline signal — **bounds the RAG embedding call**" | `internalVoice.js:227-235` (JSON) passes `signal`; **`internalVoice.js:435-442` (SSE) does not.** On the SSE branch the embedding call has no abort, no deadline, and no client-side HTTP timeout (`knowledgeService.js:10-19`), bounded only by the worker hanging up | **MEDIUM** (today: dark) → **HIGH at deploy** | **The code.** `ARCHITECTURE.md:90` states production sets `VOICE_STREAM_TURNS=true` at deploy, so this is the branch a live call is intended to take. `aiService.js:388-391` documents a *deliberate* SSE/JSON divergence, but it is scoped to the reply loop's point-of-no-return — not to the retrieval call. |
| **D-10** | `knowledge/faqService.js:19-21` — "Nothing else reads `source` as anything but a free label today (validationService's kb checks count/retrieve across all sources)" | Two structural readers exist: `knowledgeService.js:112-114` (`source = $2 OR source LIKE $2 \|\| ':%'`, called by `faqService` itself) and **`provisioningService.js:136-139`**, which reads `source` as an exact filename key for resume/dedup | **LOW** | **The comment**, narrowly. The claim holds for *retrieval* (R1 selects no `source` and filters on none), which is the part that matters; but a future session widening the `source` convention would break `provisioningService`'s dedup without the comment warning them. |
| **D-11** | `ARCHITECTURE.md:118` (§2.9) — "the knowledge base is a per-tenant namespace within `knowledge_chunks` (no shared embedding space across tenants)" | R1 (`knowledgeService.js:38-42`) filters `WHERE tenant_id = $1`; all seven reads do. One physical table, one shared HNSW index (`schema.sql:309-310`), separated by predicate | **NONE — accurate** | Neither. The doc says "namespace *within* `knowledge_chunks`", which is precisely what the predicate provides. Recorded so Phase 5 does not treat the shared index as an undocumented surprise. |

## 5.1 Claims checked and found ACCURATE

Recorded so §5's silence is not mistaken for "not checked":

- `ARCHITECTURE.md:74` — knowledge module = "per-tenant ingest and top-k retrieval (pgvector + HNSW)" ✅ (`knowledgeService.js:21-46`; `schema.sql:309-310`)
- `ARCHITECTURE.md:134` (§2.12) — `turn_traces` records "retrieved chunk IDs" ✅ (`contextAssembler.js:83-88` records `{chunk_id, score}`; `traces/collector.js:65`)
- `ARCHITECTURE.md:283` (§6.10) — "`turn_traces` already records retrieved chunk IDs per turn" ✅ (same evidence; scores are captured too, which the doc understates)
- `ARCHITECTURE.md:39` — "PostgreSQL, raw SQL, no ORM, with pgvector (HNSW)" ✅
- `docs/deploy/audit/2026-07-production-readiness.md:58` — "pgvector retrieval is tenant-filtered (`knowledgeService.js:38-43`)" ✅ substance correct; line range has drifted to `:37-44` at HEAD
- `docs/specs/portal-v1-spec.md:97` (§5.7) — "Save = upsert chunk (re-embed on edit)" ✅ (`knowledgeService.js:132-152`; re-embed is correctly conditional on text change at `:136`)
- `docs/specs/portal-v1-spec.md:146` (§7) — "`knowledge_chunks` — prose and long-tail … anything answered by retrieval" ✅
- `docs/design/portal-v2-spec.md:934` — "Editing re-embeds … `Saved · updating what it knows…` for the embedding window" ✅ matches `knowledgeService.js:145` and `public/portal/faqs.js:13,172`
- `README.md:33-36,129` — "Knowledge Base / RAG / AI context retrieval", checked ✅ true but contentless; nothing to diverge from
- `knowledge/knowledgeService.js:35-36` — "`id` rides along for trace retrieval provenance (Issue 22) — every consumer reads only content/similarity" ✅ (`aiService.js:568` reads `.content`; `contextAssembler.js:86` reads `.id`/`.similarity`; no other consumer)
- `conversation/contextAssembler.js:26-29` — "no channel-specific branching here" ✅ (`:54-91` contains no channel conditional)
- `knowledge/faqService.js:11-13` — "aiService renders every chunk as `- ${content}` straight into the prompt" ✅ exactly (`aiService.js:568`)

---

# 6. Absent machinery

**Presence/absence only. No evaluation of whether any of these should exist — that is Phases 2–4.**

## 6.1 Search commands used

```powershell
git --no-pager grep -nEi "rerank|re-rank|cross-encoder|bm25|tsvector|to_tsquery|websearch_to_tsquery|plainto_tsquery|ts_rank|full.?text|hybrid|reciprocal.rank|\bRRF\b|\bMMR\b|maximal.marginal|hyde|multi.query|query.rewrit|query.expansion|similarity.threshold|min_score|ef_search|hnsw.ef|ivfflat|lists =|probes|embedding.cache|chunk.cache|LRU|batchEmbed|embedContents|batchEmbedContents|task_type|taskType|RETRIEVAL_DOCUMENT|RETRIEVAL_QUERY|compress|summarize.chunk" -- src scripts voice-agent core server.js

git --no-pager grep -nEi "knowledge|chunk|embed|retriev|rag" -- voice-agent
git --no-pager grep -nEi "knowledge|kb|retriev|embed|chunk|top_?k" -- src/modules/config/schema.js src/modules/config/defaults.js
git --no-pager grep -nE "router\.(get|post)" -- src/modules/channels/whatsapp/routes.js
git --no-pager grep -nE "timeout|apiVersion|requestOptions" -- src/modules/ai/aiService.js src/modules/knowledge/knowledgeService.js
```

The first sweep returned **zero true positives.** Every hit was a false match: `hyde` inside
"Hyderabad" (9 script fixtures), `compress`/`full text` inside trace-privacy comments
(`schema.sql:614,631`, `aiService.js:524`, `022_turn_traces.sql:28`, `clinic.js:263`),
and `probes` nowhere at all.

## 6.2 Absence table

| Machinery | Present? | Evidence |
|---|---|---|
| Reranking (cross-encoder or LLM) | **ABSENT** | zero hits for `rerank\|cross-encoder`; R1 returns rows in `ORDER BY embedding <=> $2` order and `aiService.js:568` consumes them in that order |
| Hybrid vector + keyword search | **ABSENT** | R1 is the only query touching `embedding`; no second retrieval query exists |
| BM25 / Postgres full-text | **ABSENT** | zero hits for `tsvector\|to_tsquery\|ts_rank`; no `tsvector` column in `schema.sql:289-301`; no GIN index |
| Reciprocal rank fusion | **ABSENT** | zero hits; single result set, nothing to fuse |
| Query rewriting | **ABSENT** | `contextAssembler.js:67` passes `text` verbatim; `knowledgeService.js:34` embeds it verbatim. The raw user utterance is the query |
| Query expansion / multi-query | **ABSENT** | exactly one `embed()` call per retrieval (`knowledgeService.js:34`) |
| HyDE | **ABSENT** | zero true hits |
| MMR / diversity | **ABSENT** | zero hits; no post-processing between R1's `rows` and the prompt |
| Similarity threshold | **ABSENT** | `similarity` is computed (`knowledgeService.js:38`) and returned, but **no caller compares it to anything**. `contextAssembler.js:86` records it to the trace; `aiService.js:568` ignores it; `validationService.js:221` tests only `chunks.length === 0` |
| Result dedup | **ABSENT** | `aiService.js:568` maps `knowledgeChunks` directly with no `Set`/`uniq` |
| Query-embedding cache | **ABSENT** | zero hits for `embedding.cache\|LRU`; `knowledgeService.js:34` calls the API unconditionally on every turn |
| Chunk/result cache | **ABSENT** | R1 executes on every call; no memo, no module-level state in `knowledgeService.js` other than `genAI`/`embeddingModel` (`:4-5`) |
| Provider prompt caching | **ABSENT** | `modelProvider({model, systemInstruction, tools})` at `aiService.js:227-231` and `:362-366`; no `cachedContent` |
| Batch embedding | **ABSENT** | zero hits for `batchEmbedContents`; `storeChunks:22-29` is a **sequential `for` loop with `await embed()` per chunk** |
| Async ingestion queue | **ABSENT** | W2 (`createChunk`) awaits `embed()` **inline on the portal POST** (`routes.js:1979` → `faqService.js:123` → `knowledgeService.js:120`). No job table, no worker, no `setImmediate` |
| Context compression / chunk summarisation | **ABSENT** | `aiService.js:568` interpolates full `content` |
| Task-type embeddings | **ABSENT** | the request object is `{content:{parts:[{text}]}, outputDimensionality:768}` (`knowledgeService.js:11-14`) — no `taskType`. **Ingestion and query use the identical `embed()` function** (`:23` and `:34`) |
| `ef_search` runtime tuning | **ABSENT** | zero hits; never `SET`, and `db.js:21-27` sets only `statement_timeout` in `options` |
| HNSW build parameters (`m`, `ef_construction`) | **ABSENT (defaults)** | `schema.sql:309-310` and `004:4` specify neither |
| IVFFlat index | **ABSENT** | zero hits; HNSW only |
| Chunk provenance/labelling in the prompt | **ABSENT** | `- ${c.content}` only (`aiService.js:568`); `source` is not selected by R1 and never reaches the model |
| Per-tenant retrieval configuration | **ABSENT** | zero KB keys in `config/schema.js` or `config/defaults.js` (§4.1) |
| Retrieval on any path other than text turns | **ABSENT** | non-text WhatsApp (`routes.js:136-141`), human mode / `!ai_enabled` (`:160`, `internalVoice.js:214`), and owner messages (`routes.js:102-110`) all return before retrieval |
| Retrieval in the Python worker | **ABSENT** | §2.4 |

## 6.3 Machinery that IS present

| Machinery | file:line |
|---|---|
| HNSW ANN index, cosine operator class | `db/schema.sql:309-310` |
| Cosine distance operator matching that class (`<=>`) | `knowledge/knowledgeService.js:38,41` |
| Tenant predicate on every read | R1–R7 (§3.2) |
| `LIMIT $3` bound on result count | `knowledge/knowledgeService.js:42` |
| Best-effort degrade (RAG failure ⇒ empty context, turn continues) | `conversation/contextAssembler.js:67-70`; duplicated at `ai/testTurnService.js:107-111` |
| AbortSignal threading into the embedding fetch | `knowledge/knowledgeService.js:10,15-17` — reached from **one** of six entry points |
| Conditional re-embed on edit | `knowledge/knowledgeService.js:136-143` |
| Retrieval provenance capture (chunk ids + scores, never content) | `conversation/contextAssembler.js:83-88` |
| Ingestion resume/dedup by `source` | `provisioning/provisioningService.js:136-143` |
| Corpus-size cap | `knowledge/faqService.js:39` (`MAX_FAQS = 100`) |
| KB presence + retrieval smoke gates before go-live | `validation/validationService.js:210-225` |
| Staleness signal on KB writes | `tenant/lifecycleService.js:167` |

---

# 7. Open questions for later phases

**[P2] Ingestion, chunking & embedding**

1. **Q2-1** — `chunkText` (`knowledgeService.js:48-68`) is reachable **only** from `scripts/ingest-knowledge.js:21` and `provisioningService.js:146`, both CLI. Per D-08 no shipped surface produces `source:'document'`. What fraction of rows in a realistic tenant goes through the chunker at all — and does that make chunking quality a low-stakes finding? (Phase 1 answer: at 10 clinics under the envelope's FAQ-dominant mix, **the chunker touches zero request-path rows**.)
2. **Q2-2** — `faqService.encode` (`:63`) stores `Q: <question>\nA: <answer>`, so the question text **is** inside the embedded content (`createChunk` embeds `content` at `knowledgeService.js:120`). Does that Q+A concatenation embed better or worse than answer-only for a question-shaped query?
3. **Q2-3** — `embed()` (`knowledgeService.js:10`) is called identically for ingestion (`:23`, `:120`, `:145`) and for query (`:34`), with **no `taskType`**. `gemini-embedding-001` distinguishes `RETRIEVAL_DOCUMENT` from `RETRIEVAL_QUERY`; what is the concrete relevance cost of not using it, and is that cost even measurable without production queries?
4. **Q2-4** — `storeChunks` (`:22-29`) is a sequential embed-then-insert loop with **no transaction**. What is the state after a failure at chunk N of M? (`provisioningService.js:149-152` stops at the first failure and reports; the dedup at `:136-139` is by `source`, so a partially-ingested file is **skipped, not resumed**.)
5. **Q2-5** — `updateChunk`'s conditional re-embed (`:136`) compares `content === existing.content`. Since `faqService.encode` rebuilds the whole string, does a whitespace-only edit re-embed? (`normalize:89-90` collapses `\s+` first — worth confirming the round trip.)
6. **Q2-6** — Telugu/Hindi/English code-mixed and transliterated input: nothing in the ingestion path branches on language. `source` carries `faq:<lang>` (`faqService.js:51-53`) but **R1 neither selects nor filters on it**. Is the language tag dead weight or an unrealised retrieval improvement?

**[P3] Storage, index & query execution**

7. **Q3-1** — R1 combines `WHERE tenant_id = $1` with `ORDER BY embedding <=> $2 LIMIT $3`. **Does the tenant predicate plus ANN ordering ever return fewer than `topK` rows?** This is the pgvector filtered-search correctness failure mode, and every tenant here is a small tenant. Verbatim SQL for the EXPLAIN is at §3.2 R1.
8. **Q3-2** — `embedding` is **nullable** (`schema.sql:293`). No writer produces NULL today, but nothing prevents it. What does R1 do with a NULL-embedding row — is it sorted, excluded, or does it poison the ordering?
9. **Q3-3** — At the envelope's 150–250 chunks/tenant and 1,500–2,500 rows total, does the planner choose the HNSW index at all, or a sequential scan? Both indexes exist (`schema.sql:306,309-310`).
10. **Q3-4** — HNSW `m` and `ef_construction` are unspecified and `ef_search` is never set (§4). What are the effective defaults, and is index build time at first ingest material on a genesis deploy?
11. **Q3-5** — Round trips per retrieval: **one** embedding HTTP call + **one** SQL query, both inside `Promise.all` with two other queries (`contextAssembler.js:66-76`). Confirm no N+1 and check pool contention when three legs run concurrently against `db.js`'s single pool.

**[P4] Retrieval quality, context, token & cost**

12. **Q4-1** — **No similarity threshold exists anywhere** (§6.2). `similarity` is computed and discarded by every consumer. Can a chunk with near-zero similarity reach the prompt under `Business knowledge (use ONLY this to answer questions)` and be presented to a patient as clinic-approved fact? Size the finding; name the number that would justify a threshold.
13. **Q4-2** — **Prompt-injection surface.** Chunk content is clinic-staff-authored free text interpolated as `- ${c.content}` (`aiService.js:568`) with no delimiter, directly above the `Rules:` block (`:599-604`) and the booking rules (`:606-618`). An FAQ answer containing instruction-shaped text sits inside the system instruction. `faqService.normalize:89-90` collapses whitespace but performs no content sanitisation, and `MAX_ANSWER` is 800 chars.
14. **Q4-3** — Zero chunks removes the entire `knowledgeSection` **including the "use ONLY this" instruction** (`aiService.js:567-569`). Does the model behave more or less conservatively with an empty KB than with a populated one?
15. **Q4-4** — Retrieval failure is **silent to the patient**: `contextAssembler.js:67-70` logs and returns `[]`, and the turn proceeds. Classify — safety finding (ungrounded answer delivered as if grounded) or performance finding?
16. **Q4-5** — **Latency.** One embedding round trip (600–900 ms measured on the ingest side, `public/portal/faqs.js:13`) inside an 8,000 ms voice budget (`internalVoice.js:67`). Worst case if Google is slow: on voice-JSON the abort fires at 8 s; on **voice-SSE and WhatsApp there is no bound at all** (§4). What is the worst-case WhatsApp turn duration?
17. **Q4-6** — Token share: measure `knowledgeSection` against the whole prompt (`aiService.js:589-620`) at topK 3 with `MAX_ANSWER` 800. If retrieval is a small fraction, every token-saving technique is settled by that number.
18. **Q4-7** — Cost: one embedding call per turn × 200 turns/day/tenant × 10 tenants against ₹4,999/clinic/month.
19. **Q4-8** — `validationService.checkKbRetrieval` uses **topK 1** and the fixed query `'what are your timings'` (`:219-220`) while every real path uses topK 3. Does a go-live gate that probes with different parameters than production actually prove production retrieval works?

**[P5] Tenant isolation**

20. **Q5-1** — All seven reads carry a parameterised `tenant_id` (§3.2), but **three live outside the owning module** (D-06): `validationService.js:211`, `lifecycleService.js:167`, `provisioningService.js:137`. Walk each independently.
21. **Q5-2** — Per entry point, where does `tenant_id` originate and can request input influence it? WhatsApp: `phone_number_id` from the signed webhook payload (`routes.js:87-89`). Voice: `call_sessions` row keyed by `call_session_id` from the HMAC-authenticated body (`internalVoice.js:149-152`). Portal: `req.portalUser.tenantId` (`routes.js:1959,1972,1997,2021,2093`). Test turn: same session. Validation: caller-supplied `tenantId` argument.
22. **Q5-3** — **No cache exists on the retrieval path** (§6.2), which is itself the isolation property to preserve. If Phase 4 proposes a query-embedding or result cache, record the tenant-scoping requirement here so an implementation session cannot get it wrong.
23. **Q5-4** — `getChunk`/`deleteChunk` return `null`/`false` for another tenant's id (`knowledgeService.js:98-106,156-163`) — inert, not an oracle. Confirm `updateChunk` inherits this (it routes through `getChunk` at `:133`) and that the 404 at `routes.js:2005,2024` is indistinguishable from "no such row".
24. **Q5-5** — Observability: `contextAssembler.js:85-87` records chunk ids and scores but never content; `traces/collector.js:65` stores it verbatim. Who can read `turn_traces`, and does any log line carry chunk content? (`aiService.js:311` logs tool output truncated to 200 chars — tool output, not chunks.)

---

# 8. UNVERIFIED

| ID | What could not be established | What would establish it |
|---|---|---|
| **U-1** | The **worker-side** turn timeout's actual default. `internalVoice.js:59-63` asserts `voice-agent/agent.py TURN_TIMEOUT_S`, env `VOICE_TURN_TIMEOUT_S`, default 10 s, and `voice-agent/README.md:36` documents the env var — but I did not open `agent.py` this session, so the constant is cited, not read. The **server** side (8,000 ms) is verified at `internalVoice.js:65-68`. | Read `voice-agent/agent.py`'s `TURN_TIMEOUT_S` definition. |
| **U-2** | Whether R1's HNSW index is actually used by the planner at any corpus size. No `EXPLAIN` was run — explicitly out of scope this phase. | Phase 3 §B against a scratch database. |
| **U-3** | Whether the `WHERE tenant_id = $1` + ANN + `LIMIT` combination can under-return (Q3-1). Static reading cannot settle a planner behaviour. | Phase 3 §B, deliberately seeded with a tenant holding a small share of the corpus. |
| **U-4** | ~~Actual embedding latency **from this codebase's query path**. The 600–900 ms figure is a code comment about the *ingestion* side (`public/portal/faqs.js:13,172`) — same model and same `embed()` function, but the number is a UI-copy claim, not a measurement I reproduced.~~ **CLOSED 2026-08-10 (RAG Session 2)** — measured, 5 calls through `embed()` against live `gemini-embedding-001`: **2,555 ms** (first call of a cold process), then 546 / 625 / 543 / 459 ms. Median 546, mean 946. **Verdict on 600–900 ms: partially right, and wrong in the direction that mattered.** The warm band (459–625 ms) sits at or just *below* the claim's floor, so steady-state was if anything pessimistic — but the claim omits the cold call entirely, and at 2,555 ms that is 2.8× its stated ceiling. The cold number is the one a timeout has to clear, and it is the one no artifact had. Derived the 3,000 ms deadline in **D-010**. ⚠️ **Residual, not closed:** 5 samples, one machine, one region, one time of day is not a distribution, and the cold-start floor rests on a *single* observation. | ~~Phase 4 §D, or one instrumented live call.~~ For the residual: repeated cold-start samples from the production region after Issue 20. |
| **U-5** | Whether `gemini-embedding-001` was ever *actually* the model that produced 3072-dim vectors before migration 004, as `004:1` claims. `002:8` on disk says `vector(768)`, contradicting the comment. Resolving it would need commit archaeology, which I did not perform. | `git log -p -- src/db/migrations/002_knowledge_chunks.sql`. Does not affect HEAD behaviour — recorded only because D-01/D-02 rest on the comments being wrong rather than the code having changed. |
| **U-6** | Real chunk boundaries `chunkText` produces on representative input. Executing it is Phase 2's sanctioned observation, not this phase's. | Phase 2 §A. |
| **U-7** | Token counts for any prompt component. No tokenizer was run. | Phase 4 §C. |
| **U-8** | Whether any tenant, anywhere, holds a `source:'document'` chunk. There are **zero tenants** (`state.md:36-40`), so the question is currently vacuous — but it becomes real the moment `provisioningService.ingestKnowledge` is used for customer #1. | `SELECT DISTINCT source FROM knowledge_chunks` post-deploy. |
| **U-9** | Whether `handleInbound` (`channels/index.js`, reached from `routes.js:130`) can itself touch `knowledge_chunks`. I did not open that file; it is excluded by the grep in §3.1 (no hit for the table name or the service), which is strong negative evidence but not a read. | Open `src/modules/channels/index.js`. |

---

## PROPOSED

Per the non-destructive contract, nothing here was fixed. One item is recorded as
PROPOSED for Phase 6 to decide, because it is the only §5 finding whose blast radius grows
on the day of deployment rather than staying constant:

- **P-1 — pass `signal` at `routes/internalVoice.js:435-442`** (D-09). One argument, matching
  the JSON branch at `:233`. Today it is masked by `VOICE_STREAM_TURNS=false`; `ARCHITECTURE.md:90`
  says production flips that flag at deploy, at which point every live voice turn's embedding
  call becomes unbounded — no abort, no deadline, no HTTP timeout (§4). Phase 4 §D should
  size it; Phase 6 decides. Filed here, not fixed.
