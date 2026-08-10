# RAG Audit — Phase 5: Tenant Isolation (adversarial), with Phase 3 §B folded in

**HEAD:** `da27980a3ab9ab56978f5b854b3cc62ae498f53d`
**Branch:** `main`
**Date:** 2026-08-09
**Type:** audit-only. No source, schema, migration, config, test, or dependency was modified.
No package installed. No fix implemented. All database writes were confined to scratch databases
created and dropped by this session.

**`npm test`:**

```
# tests 989
# suites 160
# pass 989
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 83813.9568
```

Matches `docs/os/state.md:69`, Phase 1 and Phase 2 exactly (989 / 160 / 0 fail). Neither known
intermittent (`traces.integration.test.js:247`, `portalLifecycle.integration.test.js:794`) fired on
this run.

---

## HEADLINE

**No leak was found, and the failure mode §H.4 exists to hunt was reproduced but is not reachable
through the plan Postgres actually chooses.** The two things this audit found that are *not*
already defended are both structural, not behavioural:

1. **Not one test in the suite would fail if `WHERE tenant_id = $1` were deleted from R1** —
   the single retrieval query in the repository. Measured, not argued: §F.3.
2. **On the `--kb-dir` provisioning path the tenant boundary is an operator typing a filename**,
   nothing detects a mis-aim, and the result is unremovable through any product surface (§A.6).

---

## 0. The isolation standard being audited against

**⚠️ `INV-1` … `INV-6` are NOT recorded anywhere in `docs/os/`.** They live at
`docs/specs/portal-v1-spec.md:40-45`, and are declared still binding by
`docs/design/portal-v2-spec.md:5` ("All security invariants (INV-1…INV-6) … survive unchanged and
are binding on this document"). Because they were *located* rather than absent, this audit quotes
INV-1 verbatim rather than inventing a substitute — but records the location discrepancy as a
finding in its own right, since the Phase 5 prompt expected `docs/os/` to hold them and the next
session will look there too.

**INV-1, verbatim (`docs/specs/portal-v1-spec.md:40`):**

> **INV-1** `tenant_id` derives **only** from the session's user row. No portal route ever reads a
> tenant identifier from params, body, or query. Cross-tenant negative tests are mandatory in the
> suite.

**INV-5, verbatim (`:44`)** — the only other invariant that names chunks:

> **INV-5** Uploads: type/size validated, stored outside the web root; derived chunks tenant-scoped
> like all others.

**INV-1 is scoped to the portal and covers two of the seven entry points.** For the other five
(WhatsApp, voice-JSON, voice-SSE, `validationService`, `provisioningService`) no written standard
exists in the repository. The standard this audit applied to them is stated here in its own words
and marked **UNVERIFIED** as a *recorded* standard — it is not quoted from anywhere:

> **Substitute standard (UNVERIFIED — this audit's own wording, for the five non-portal entry
> points).** A retrieval call must resolve `tenant_id` from a server-held authority — a row keyed
> by an authenticated identifier, or an argument supplied by a caller who is itself so scoped —
> never from unauthenticated request input. Resolution that fails or is ambiguous must **deny**,
> never default. Every read of `knowledge_chunks` must carry a parameterised `tenant_id` predicate.

The nearest thing to a written statement of the last clause is
`ARCHITECTURE.md:118` (§2.9), recorded ACCURATE by Phase 1 §5 D-11:

> the knowledge base is a per-tenant namespace within `knowledge_chunks` (no shared embedding space
> across tenants)

---

## 1. Phase 0 gate report

| # | Gate | Result |
|---|---|---|
| 1 | `docs/os/` registers read | ✅ `state.md`, `clocks.md`, `decisions.md`, `assumptions.md` |
| 1 | `01-map.md` + `02-ingestion.md` exist | ✅ 612 lines / 1,004 lines, both read before any scope work |
| 2 | HEAD matches both prior artifacts | ✅ **no drift** |
| 3 | Working tree: zero **modified tracked** files | ✅ **PASS** |
| 4 | Unscoped `knowledge_chunks` read on a reachable path | ✅ **NONE — no STOP** |
| 5 | Scratch database creatable | ✅ `zyon_iso_0e8ea25d` |
| 6 | Read-only confirmation | ✅ below |

**HEAD drift: none.** `git rev-parse HEAD` returns `da27980a3ab9ab56978f5b854b3cc62ae498f53d`,
byte-identical to `01-map.md:3` and `02-ingestion.md:3`. Zero commits between the map and this
session, so no staleness analysis of `src/modules/knowledge/`, `src/modules/conversation/`,
`src/modules/channels/`, `src/routes/internalVoice.js`, `src/portal/routes.js`,
`src/modules/validation/`, `src/modules/provisioning/`, `src/modules/tenant/`, `src/db/` or
`scripts/provision-tenant.js` is required.

**`git status --porcelain` at session start, verbatim:**

```
?? "Phase 1 \342\200\224 Map & DivergenceLedger.md"
?? docs/audit/rag-audit-workflow.md
?? docs/os/audits/
```

Enumerated with `-uall` so the collapsed directory is itemised:

```
?? "Phase 1 \342\200\224 Map & DivergenceLedger.md"
?? docs/audit/rag-audit-workflow.md
?? docs/os/audits/rag/01-map.md
?? docs/os/audits/rag/02-ingestion.md
```

Zero tracked files modified. The three untracked entries are the same markdown Phase 2 enumerated;
per the amended gate they do not block.

**`Verified-at` note (unchanged from Phases 1 and 2).** `state.md:5` records `424ca05`; HEAD is
`da27980`, which *is* the commit that stamped it. The string can never equal HEAD by construction;
`npm run os:check` is the operative provenance test.

**Gates:** G-CLOCK ❌ · G-PROOF ❌ · G-PAY ❌ · G-TEN ❌. Launch gates 4/7 (`state.md:57-65`).
**Zero tenants, zero production rows** (`state.md:36-40`) — every finding below is therefore latent
rather than live, and that is stated per finding rather than assumed globally.

**Clocks:** none bear on isolation. All three are `Filed: —`, `Reference: —`.

### 1.1 Phase 0 gate 4 — the STOP check, executed

The condition that would have stopped this session immediately is *a read of `knowledge_chunks`
with no tenant predicate on a reachable request path.* Enumerated exhaustively over `src/`,
`scripts/`, `core/` and `server.js`:

| Site | Predicate | Verdict |
|---|---|---|
| `knowledgeService.js:39-40` (R1) | `WHERE tenant_id = $1` | scoped |
| `knowledgeService.js:88-89` (R2) | `WHERE tenant_id = $1` | scoped |
| `knowledgeService.js:101-102` (R3) | `WHERE tenant_id = $1 AND id = $2` | scoped |
| `knowledgeService.js:112-113` (R4) | `WHERE tenant_id = $1 AND (source = $2 …)` | scoped |
| `validationService.js:212` (R5) | `WHERE tenant_id = $1` | scoped |
| `lifecycleService.js:167` (R6) | `WHERE tenant_id = $1` (×1 of 3 sub-selects) | scoped |
| `provisioningService.js:137` (R7) | `WHERE tenant_id = $1 AND source = $2` | scoped |
| `scripts/portal/f1.js:337,501` | `WHERE tenant_id = $1` | scoped; dev script, no request path |

**No STOP condition fired.** Phase 1 §3.2's inventory is confirmed complete and correct at HEAD.

**Confirmed in one line:** *Repository is read-only this session; DB writes confined to
`zyon_iso_0e8ea25d` (plus seven short-lived `zyon_iso_*` bisection databases, all dropped — §H.7).*

---

## A. Tenant resolution, per entry point

Phase 1 §7 Q5-2 pre-traced six origins; Phase 2 promoted a seventh. Each was **verified at HEAD**,
not inherited.

| # | Entry point | `tenant_id` origin (file:line) | Server-derived or request input? | On failure / ambiguity |
|---|---|---|---|---|
| 1 | WhatsApp inbound | `value.metadata.phone_number_id` → `tenantService.getByPhoneNumberId` (`whatsapp/routes.js:86-89`) | **Request input, HMAC-authenticated**, resolved through a `UNIQUE` column | `null` ⇒ `logger.warn` + `continue` (`:90-93`). **DENIES** |
| 2 | Voice turn, JSON | `SELECT tenant_id … FROM call_sessions WHERE id = $1`, `$1` = body `call_session_id` (`internalVoice.js:149-152`) | **Request input (body), HMAC-authenticated with a platform-wide secret**; the row is the authority | no row ⇒ 404 (`:153`); unbridged ⇒ 409 (`:158-160`); tenant gone ⇒ 404 (`:163`). **DENIES** |
| 3 | Voice turn, SSE | identical (`handleTurnSSE`, same `call_sessions` lookup) | identical | identical. **DENIES** |
| 4 | Portal FAQ CRUD | `req.portalUser.tenantId` ← `users.tenant_id` by session `userId` (`portal/auth.js:127-144`) | **Server-derived** | no session / inactive / stale epoch ⇒ 401 (`auth.js:124,133,141`). **DENIES** |
| 5 | Portal test turn | same session (`portal/routes.js:2045`) | **Server-derived** | same 401. **DENIES** |
| 6 | `validationService.checkKbRetrieval` | **caller-supplied `tenantId` argument** (`validationService.js:220`) | **argument** — see §A.5 | falsy ⇒ throws (`:330`); no tenant row ⇒ throws (`:352`). **DENIES** |
| 7 | `provisioningService.ingestKnowledge` via `scripts/provision-tenant.js` | **operator-supplied**: `def.slug` from the JSON definition file → `SELECT id FROM tenants WHERE slug = $1` (`provisioningService.js:233-236`), else the id of the tenant just created (`:262`) | **operator input (argv → file)** — see §A.6 | **no failure mode exists.** A valid slug always resolves. |

**Every entry point denies on resolution failure. There is no default-on-failure anywhere.**
Verified individually above; the two that carry weight are analysed below.

### A.1 WhatsApp — why request-supplied is nonetheless sound

`phone_number_id` arrives inside the webhook body, which is request input. Three properties make it
safe, each with the line that makes it so:

- The body is HMAC-SHA256 verified against `META_APP_SECRET` over the **raw** buffer, with
  `timingSafeEqual` and a length pre-check (`whatsapp/routes.js:30-40`). `server.js:26` mounts the
  route with `express.raw` *before* the global `express.json()` at `server.js:51`, so the bytes
  signed are the bytes verified.
- `tenants.phone_number_id` is `UNIQUE` (`schema.sql:55`), so `getByPhoneNumberId`'s `LIMIT 1`
  (`tenantService.js:46-48`) can never mask a second row. **This is the property Issue 11's
  `getByDid` could not inherit** (`state.md:166-173`) — worth restating, because the two resolvers
  look alike and only one has a uniqueness constraint behind it.
- The lookup additionally filters `active = true` (`tenantService.js:47`), so a deactivated tenant
  resolves to `null` and the message is dropped rather than served.

An attacker who can forge the HMAC already holds `META_APP_SECRET` and does not need a retrieval
bug. **Not a leak.**

### A.2 Voice — the tenant boundary is a UUID in the body, and there is no per-tenant authentication

`internalVoice.js:149-152` reads `call_sessions` by primary key with **no tenant predicate** —
correctly, because that row *is* the tenant authority; there is nothing to check it against. But
that makes the precise statement worth writing down, because it is not what "HMAC-authenticated"
suggests:

- `VOICE_INTERNAL_SECRET` is **one platform-wide secret** (`internalVoice.js:28-32`). It identifies
  *the worker*, not *a tenant*.
- Therefore **any holder of that secret can address any tenant** by signing a body carrying a
  different `call_session_id`. Nothing downstream would notice: the customer and conversation are
  then re-validated against the session's own `tenant_id` (`:167-179`), so the request is
  internally consistent for whichever tenant was named.
- This is the correct design for a trusted transport component (`ARCHITECTURE.md:38` requires the
  Python worker be transport only, and Phase 1 §2.4 verified it holds no retrieval code). It is
  recorded here so nobody later mistakes the HMAC for a per-tenant boundary.
- `/internal/voice/*` mounts only under `VOICE_ENABLED === 'true'` (`server.js:31-35`), so at HEAD
  the surface is not exposed by default.

**Not a leak.** Recorded as a property: on the voice path, tenant separation rests entirely on the
worker sending the right session id, and there is no second factor.

### A.3 Portal — INV-1 holds by construction on every retrieval-reaching route

`requirePortalAuth` (`auth.js:120-150`) is the only place tenant scope enters a portal request. It
reads `req.session.portal.userId`, loads `users`, and sets `req.portalUser.tenantId = user.tenant_id`
(`:144`). Every retrieval-reaching route opens with `const tenantId = req.portalUser.tenantId`:
`GET /api/faqs` (`routes.js:1959`), `POST /api/faqs` (`:1972`), `PATCH /api/faqs/:id` (`:1998`),
`DELETE /api/faqs/:id` (`:2021`), `POST /api/test/turn` (`:2045`),
`POST /api/readiness/check` (`:291`).

**No route reads a tenant identifier from params, body, query, or headers.** Verified by reading
each of the six. A crafted `?tenantId=` or `body.tenantId` is inert because nothing reads it — not
because it is filtered. Two existing tests assert exactly this
(`portalFaqs.integration.test.js:503-520`, `portalTestTurn.integration.test.js:420-436`).

**INV-3 also holds on the retrieval-adjacent path, and by the same technique.**
`validateTenant` honours `opts.deps` and `opts.skip` (`validationService.js:364-369`), which would
let a caller *replace `getRelevantChunks` outright*. The portal reaches `validateTenant` twice, and
neither call has an argument position for it: `routes.js:297` passes one argument, and
`runGoLiveChain` (`:326-329`) passes no third argument to `transition`. The admin route does pass
`{ validate: { skip } }` (`adminRoutes.js:728`) but `skip` is an array run through `expandSkips`
against a frozen catalogue (`:719-726`), and **`deps` is never constructed from a request body
anywhere.** Verified by reading every `validateTenant` / `transition` call site in `src/`.

### A.4 Portal test turn — same session, and one extra property worth naming

`testTurnService.runTestTurn(tenantId, question)` (`testTurnService.js:88`) takes the tenant from
the route, i.e. the session. It calls `getRelevantChunks(tenantId, question, RAG_TOP_K)` directly
(`:108`), bypassing `assembleConversationContext`. The bypass changes nothing about isolation: the
same `tenantId` reaches the same function. `fetchTenantForBrain` (`:68-76`) is deliberately
un-gated by lifecycle status so a draft tenant can test — correct, and it does not widen scope,
because the row is fetched `WHERE id = $1` from the session's own tenant.

### A.5 ADVERSARIAL FOCUS — `validationService.checkKbRetrieval`'s caller-supplied `tenantId`

`checkKbRetrieval` (`validationService.js:218-225`) calls
`ctx.deps.getRelevantChunks(ctx.tenantId, 'what are your timings', 1)`. `ctx.tenantId` is
`validateTenant`'s first argument. **The function itself performs no authorisation.** So the
question is entirely "who may call it, and with what".

Exhaustive caller list in `src/` and `scripts/` (`git grep validateTenant`), each traced to origin:

| Caller | `tenantId` origin | Authority |
|---|---|---|
| `portal/routes.js:297` (`POST /api/readiness/check`) | `req.portalUser.tenantId` | **session** ✅ |
| `portal/routes.js:327` via `lifecycleService.transition` | `req.portalUser.tenantId` | **session** ✅ |
| `lifecycleService.js:189` (`doValidate`) | `tenant.id` from `loadTenant(tenantId)` (`:265`) | inherits its caller's |
| `adminRoutes.js:728` | `req.params.id` | **operator, cross-tenant by design** — `adminRoutes.js:775` states the rule explicitly: *"INV-1 (tenant-from-session-only) is a PORTAL invariant"* |
| `scripts/validate-tenant.js:110` | operator CLI argv | operator |
| `scripts/portal/*.js` | fixtures | dev only, not shipped |

**Verdict: not a leak, and the reason is worth stating precisely.** A caller-supplied `tenantId`
is only as good as its callers, and every caller is either session-scoped or an operator surface
whose whole purpose is to act across tenants. What makes this *safe rather than lucky* is that
`checkKbRetrieval` reads only the tenant it is given and writes nothing — the worst a wrong
`tenantId` can do here is answer "does this other tenant's KB retrieve", which the same operator
can already ask directly.

**What would break it, recorded because nothing structural prevents it:** any future route that
accepts a tenant identifier from a request body and forwards it to `validateTenant`. There is no
type, no wrapper and no test standing between that change and a cross-tenant retrieval probe. See
§F.4's proposed test.

### A.6 ADVERSARIAL FOCUS — `provision-tenant.js --kb-dir`: the boundary is a human typing a filename

Phase 2 promoted this from "background CLI" to a first-class entry point because
`scripts/provision-tenant.js:62` prints `--kb-dir` as **step 3 of the onboarding runbook** — it is
the path clinic #1's knowledge base actually takes. Traced fully at HEAD.

**The two arguments name different things, and only one of them names the tenant:**

```
node scripts/provision-tenant.js  provision/clinic-A.json  --kb-dir ./kb/clinic-B
                                  └─ names the TENANT ─┘   └─ names the DOCUMENTS ─┘
```

`provisionTenant(definition, { kbDir })` resolves the tenant from `def.slug`
(`provisioningService.js:233-236`) and then calls `ingestKnowledge(report.tenant_id, kbDir)`
(`:285`). **There is no relation of any kind between `kbDir` and `def.slug`** — not a naming
convention, not a manifest, not a check. `ingestKnowledge` reads every `*.md`/`*.txt` in the
directory (`:132-134`) and stores each under `source = path.basename(file)` (`:135`).

**Does anything detect a mis-aim? No. Enumerated:**

| Candidate detector | Why it does not fire |
|---|---|
| `--dry-run` | Returns at `provisioningService.js:206-227`, **before** the slug lookup at `:233` and before the KB step at `:283`. It prints `plan.kb_dir` beside `plan.tenant.slug` — but both are **echoed from the operator's own input**; the dry run never reads the target tenant, so it cannot say "you are about to write into Smile Dental". |
| The dedup `SELECT` (R7) | `WHERE tenant_id = $1 AND source = $2` (`:137`). Scoped to the *wrong* tenant, so it finds nothing and ingests. It is a resume mechanism, not a guard. |
| `chunkText` / `storeChunks` | Content-blind (`knowledgeService.js:21-31`). |
| Validation (`kb.populated`, `kb.retrieval`) | Count ≥ 5 and one chunk back for `'what are your timings'` (`validationService.js:210-225`). A wrongly-populated KB clears both. |
| The CLI's own output | `provision-tenant.js:143` prints `kb: ingested N doc(s): <filenames>`. The filenames are the only signal, and they are the ones the operator just typed. |

**Is the result recoverable? Not through any product surface.** Document chunks carry a `source`
that is not `faq`/`faq:<lang>`, and `faqService.listFaqs` filters on exactly that
(`faqService.js:109-112`) — so mis-targeted document chunks are **invisible in the portal's FAQ
editor and therefore undeletable from it**. Phase 2 recorded this as Q2-P5-a. There is no admin
chunk surface either (`adminRoutes.js` has no `knowledge_chunks` route). Removal means `psql`, or
deleting the tenant and relying on `ON DELETE CASCADE` (`schema.sql:291`).

**Meanwhile the rows are live.** R1 selects no `source` and filters on none
(`knowledgeService.js:38-42`), so from the first turn onward clinic A's receptionist can retrieve
clinic B's document text and render it to a patient under
`Business knowledge (use ONLY this to answer questions — do not invent information)`
(`aiService.js:567-568`).

**Phase 2's D2-01 compounds it in one specific way.** If ingestion into the *wrong* tenant fails
part-way, the CLI prints `re-run resumes` (`provision-tenant.js:147`) — and a re-run into the wrong
tenant is skipped by R7's `source` dedup, so the wrong tenant is left holding a **truncated**
foreign document that no later run will complete or notice. Re-running into the *correct* tenant is
unaffected (different `tenant_id` ⇒ dedup miss ⇒ ingests), so the error is purely additive, never
self-correcting.

**Classification: this is not a code defect and not a leak.** Every SQL predicate is correct; the
data lands exactly where the operator said. It is an **undefended operator hop**, and it is the one
place in the whole retrieval subsystem where a single-keystroke mistake puts one clinic's text in
another clinic's prompt with no detection and no product-surface undo. Zero tenants today, so it is
latent; its trigger is customer #1. Filed for Phase 6 as **P5-1**; proposed test at §F.4.

### A.7 U-9 — CLOSED. `handleInbound` does not reach retrieval

Phase 1 could not rule out that `channels/index.js`'s `handleInbound` (reached from
`whatsapp/routes.js:130`) touches `knowledge_chunks`; the grep was negative but the file was never
opened. **Opened this session and read in full (118 lines).**

`handleInbound` (`channels/index.js:51-116`) does exactly four things per envelope:
`identityService.resolveCustomer` or `customerService.findOrCreate` (`:60-67`),
`conversationService.getOrCreateOpenConversation` (`:71-73`), one
`INSERT INTO messages … ON CONFLICT DO NOTHING RETURNING id` (`:79-89`), and
`eventBus.emit(EVENT.MESSAGE_RECEIVED, …)` (`:96-107`). **There is no retrieval, no embedding call,
and no reference to `knowledge_chunks` or `knowledgeService`.** Every tenant reference is
`envelope.tenantId`, which `whatsapp/routes.js:127` sets from `tenant.id` — the resolved tenant, not
anything in the payload.

**U-9 is CLOSED: `handleInbound` is not a seventh entry point and does not belong in the table
above.** Phase 1's negative grep was correct.

---

## B. Full chain trace, per read path

`request → tenant resolution → retrieval call → SQL predicate → returned chunks → cache/shared
state → prompt assembly → LLM → response → logs/traces.` One section per read. Not summarised
together.

### B.R1 — `getRelevantChunks` (`knowledgeService.js:33-46`) — the only vector query

Six production entry points converge here (Phase 1 §2.2). Hop by hop:

| Hop | What carries the tenant boundary | If this hop were wrong |
|---|---|---|
| resolution | §A rows 1–6 | a wrong tenant is served that tenant's entire KB; nothing downstream re-checks |
| call | `tenantId` is argument 1 (`contextAssembler.js:67`; `testTurnService.js:108`; `validationService.js:220`) | as above — **the argument is the only boundary from here down** |
| SQL predicate | `WHERE tenant_id = $1`, parameterised (`:40,43`) | **the whole table** becomes one embedding space; §H.2 measures what that returns |
| returned chunks | `{id, content, similarity}` (`:38`) — no `tenant_id` column is selected | nothing downstream can *detect* a wrong tenant: the rows carry no ownership marker |
| cache / shared state | **none exists** (§D) | — |
| prompt assembly | `aiService.js:567-569` renders `- ${c.content}` verbatim | foreign text is presented as this clinic's approved knowledge |
| LLM | chunks are in the **system instruction** (`:589-620`) | model treats them as authoritative by construction |
| response | spoken/sent to the patient | — |
| logs / traces | `{chunk_id, score}` only (`contextAssembler.js:85-87`) | ids of foreign chunks recorded; no content (§E) |

**The load-bearing observation is the fourth row.** R1 deliberately does not select `tenant_id`
(`knowledgeService.js:35-36` explains `id` rides along only for trace provenance). That is correct
for payload minimisation and it means **no consumer can revalidate ownership**. The predicate is not
one of several checks; it is the only one. Everything after it trusts it completely.

### B.R2 — `listChunks` (`knowledgeService.js:86-93`) → `faqService.listFaqs` → `GET /api/faqs`

Resolution `req.portalUser.tenantId` (`routes.js:1959`) → `faqsPayload` (`:1950`) →
`listFaqs(tenantId)` (`faqService.js:109`) → `WHERE tenant_id = $1 ORDER BY created_at` (`:88-89`).
No cache. Rendered by the FAQ editor. Wrong tenant ⇒ another clinic's whole FAQ list rendered in the
owner's editor, and — because the ids come with it — **editable and deletable**, since W3/W4/W5 take
their id from that same list. This is the one read whose failure would escalate from disclosure to
mutation. Defended by `portalFaqs.integration.test.js:503-520`.

### B.R3 — `getChunk` (`:98-106`) → `updateChunk` (`:133`) → `PATCH /api/faqs/:id`

`isUuid(id)` first (`:99`) — a non-UUID returns `null` without touching the database, so a crafted
id can never raise `22P02` into a 500. Then `WHERE tenant_id = $1 AND id = $2`. Wrong tenant ⇒
`updateChunk` proceeds past `:134` and overwrites a foreign row. Defended by
`portalFaqs.integration.test.js:521-544`.

### B.R4 — `countChunksBySourcePrefix` (`:110-117`) → `faqService.countFaqs` → the `MAX_FAQS` gate

`WHERE tenant_id = $1 AND (source = $2 OR source LIKE $2 || ':%')`. Consumed only as an integer by
`createFaq:120`. Wrong tenant ⇒ the cap is computed against a foreign corpus: a clinic is refused
its 6th FAQ, or allowed a 300th. Availability, not disclosure — **the only read here whose failure
leaks nothing**. Not directly tested.

### B.R5 — `checkKbPopulated` (`validationService.js:210-216`) — **outside the owning module (D-06)**

Raw `SELECT count(*)::int AS n FROM knowledge_chunks WHERE tenant_id = $1`, `$1 = ctx.tenantId`.
Returns an integer into a go-live gate. Wrong tenant ⇒ a clinic goes live on another clinic's chunk
count — an empty KB passing `kb.populated` because a neighbour has 200 chunks. Disclosure is one
bit; the real cost is a false go-live.

**D-06 analysis (what would have to change for the predicate to stop being sufficient, and whether
anything would catch it):** this query is `count(*)` over the raw table, so it inherits *nothing*
from the `knowledge` module. If `knowledge` ever introduced a second axis of scoping — a
soft-delete flag, a workspace/branch column, an archived state, or the `source`-namespace split
Phase 2 §B.5 already half-exists (`faq*` vs. document) — `knowledgeService`'s own readers would be
updated and **this line would not be**, because it does not call them. It would then silently count
rows the module considers out of scope. **Nothing would catch it:** `validation.integration.test.js`
seeds chunks by raw INSERT and asserts a count, so it would agree with the drift.
**Cheapest structural fix (not implemented): route it through a
`knowledgeService.countChunks(tenantId)` so the module owns the definition of "a chunk that
counts".**

### B.R6 — `validationInputsChangedAt` (`lifecycleService.js:161-173`) — **outside the owning module (D-06)**

`(SELECT max(updated_at) FROM knowledge_chunks WHERE tenant_id = $1)` inside a three-way `GREATEST`,
one round trip, `$1` from the caller. Feeds readiness staleness and the go-live chain. Wrong tenant
⇒ a run marked fresh when its own inputs moved, or stale when they did not. Zero content crosses;
one timestamp does.

**D-06 analysis:** the failure mode here is subtler than R5's because the coupling is to a *column*,
not a row set. `updated_at` exists on this table only because F1-R1 added it (migration `026`) and
attached the shared `set_updated_at` trigger. `lifecycleService.js:167` depends on that trigger
firing for every write the `knowledge` module makes. If `knowledge` ever adopted a write path that
bypassed the trigger — a `COPY`, a bulk `INSERT … ON CONFLICT DO NOTHING` that no-ops, or a
statement-level rewrite — this reader would go quietly stale, and the module would have no reason to
know it had a second consumer. **The tenant predicate itself is not what would break**; what would
break is the assumption that `max(updated_at)` still means "when this tenant's KB last moved".
**Nothing would catch it.** And `state.md:458-466` already records the *live* instance of exactly
this class: a DELETE **lowers** `max(updated_at)`, so removing a FAQ leaves the run reading fresh —
open, filed, deliberately not built.

### B.R7 — `ingestKnowledge`'s dedup (`provisioningService.js:136-139`) — **outside the owning module (D-06)**

`SELECT 1 FROM knowledge_chunks WHERE tenant_id = $1 AND source = $2 LIMIT 1`. Decides
skip-vs-ingest. Wrong tenant ⇒ §A.6.

**D-06 analysis, and this is the sharpest of the three.** This reader does not merely touch another
module's table — it **depends on a convention in that table's `source` column that the owning module
does not enforce and has already documented as free-form.** `faqService.js:19-21` says *"Nothing
else reads `source` as anything but a free label today"*, which Phase 1 recorded as divergence D-10
because this line is a counter-example. `faqService` writes `faq` / `faq:<lang>` (`:51-53`),
`scripts/ingest-knowledge.js:25` writes a **full path**, and `provisioningService.js:135` writes a
**basename** — three conventions, one column, no schema constraint (`schema.sql:294`: plain `TEXT`,
nullable, no CHECK). If anyone widens or namespaces `source`, R7's dedup silently stops matching and
every re-run duplicates the entire knowledge base. The tenant predicate stays correct throughout;
what fails is the other half of the key. **Nothing would catch it** —
`provisioning.integration.test.js` writes its fixtures with the same basename convention it asserts.

### B.summary — the shape of the risk across all seven

| Read | Outside owning module? | Content crosses on failure? | Escalates to mutation? | Guarded by a test? |
|---|---|---|---|---|
| R1 | no | **yes — into the prompt** | no | **no (§F.3)** |
| R2 | no | yes | **yes** (ids feed W3–W5) | yes |
| R3 | no | yes | **yes** | yes |
| R4 | no | no (one integer) | no | no |
| R5 | **yes** | no (one integer) | no | no |
| R6 | **yes** | no (one timestamp) | no | no |
| R7 | **yes** | no | **yes** (ingest lands wrong) | no |

**The two reads whose failure reaches a patient — R1 and R2 — are the two inside the owning module.
The three outside it (D-06) leak at most an integer or a timestamp.** That ordering is fortunate
rather than designed, and it is the reason D-06 is a maintainability finding rather than a security
one at HEAD. It is also why R1 having no test is the more serious of the two structural gaps.

---

## C. The SQL layer

### C.1 String concatenation / interpolated identifiers — verified, not inherited

Phase 1 §3.1 reported zero interpolated table names. Re-run at HEAD:

```
git --no-pager grep -nE 'FROM \$\{|INTO \$\{|UPDATE \$\{|DELETE FROM \$\{' -- src scripts core server.js
→ zero hits
```

Every one of R1–R7 and W1–W5 is a template literal whose only interpolations are **`$n` placeholder
markers**, never values. There is no ORM (`db.js:33-37` exports `query`, `getClient`, `close` and
nothing else). `db.getClient()` hands out a raw client capable of arbitrary SQL, but any such SQL is
literal text in a repository file and therefore caught by the literal grep; no `getClient()` use
touches this table.

**One query in the repository does build a `WHERE` clause by concatenation**:
`traces/queryService.js:12-27` (`where.join(' AND ')`). It is not a `knowledge_chunks` read, and it
concatenates **fixed fragments** (`conversation_id = $1` etc.) while pushing values into `params` —
so it is parameterised despite the shape. Recorded because a reader grepping for concatenated SQL
will find it and should not be alarmed; §E covers its access control.

### C.2 Optional or conditional tenant predicates — none

Checked every read: no `if` guards a predicate, no predicate is appended conditionally, and no
function takes an "include all tenants" flag. `updateChunk` has a branch (`:136`) but **both arms
carry `WHERE tenant_id = $1 AND id = $2`** (`:139` and `:148`).

### C.3 `ORDER BY` / `LIMIT` applied before the tenant filter — not possible as written

R1's `WHERE tenant_id = $1` binds to the table scan; `ORDER BY` and `LIMIT $3` apply to the filtered
relation. **Confirmed against real plans, not just SQL semantics** — §H.3's `EXPLAIN` output shows
the filter inside the ordering node in every plan shape observed:

- exact plan: `Bitmap Index Scan on idx_knowledge_chunks_tenant → Index Cond: (tenant_id = …)`
  feeding a `Sort … top-N heapsort` feeding `Limit` — filter strictly below the sort;
- ANN plan: `Index Scan using idx_knowledge_chunks_hnsw` with
  `Filter: (tenant_id = …)` **on the same node** as `Order By`, and
  `Rows Removed by Filter: 3` proving the filter is applied to candidates before they reach `Limit`.

The ANN shape is the one where ordering precedes filtering *within* the node. It cannot leak (the
filter still runs before `Limit` takes rows), but it is precisely the shape that can **under-return**
— measured in §H.4.

### C.4 Functions taking `tenantId` with a default, or accepting `undefined`/`null`

**No function on this table has a default for `tenantId`.** Signatures:
`getRelevantChunks(tenantId, query, topK = 3, {signal})` (`:33`) — the defaults are on `topK` and
`signal`; `listChunks(tenantId)` (`:86`); `getChunk(tenantId, id)` (`:98`);
`countChunksBySourcePrefix(tenantId, prefix)` (`:110`); `createChunk(tenantId, {…})` (`:119`);
`updateChunk(tenantId, id, {…})` (`:132`); `deleteChunk(tenantId, id)` (`:156`);
`storeChunks(tenantId, chunks, source)` (`:21`).

**None validates `tenantId`.** `isUuid` exists (`:81-84`) and guards the *chunk id* on `getChunk`
and `deleteChunk` — never the tenant id. So the behaviour on a bad tenant id is whatever
node-pg and Postgres do. **Measured rather than assumed (§H.2):**

| `tenantId` | Behaviour | Verdict |
|---|---|---|
| `undefined` | node-pg sends SQL `NULL`; `tenant_id = NULL` is never true ⇒ **0 rows** | **fail-closed** |
| `null` | identical ⇒ **0 rows** | **fail-closed** |
| valid but non-existent UUID | **0 rows** | **fail-closed** |
| non-UUID string (incl. injection payloads) | Postgres raises `22P02 invalid input syntax for type uuid` | **fail-closed (throws)** |

**Q3's answer for R1 with `tenantId === undefined`: it returns nothing. It does not throw and it
does not return everything.** That is the right failure direction, but note what it costs in
observability: on the five entry points that reach R1 through `assembleConversationContext`, a
`22P02` throw is swallowed by the best-effort catch at `contextAssembler.js:67-70` and logged as
`RAG failed (continuing without)` — so a tenant-resolution bug and a Google outage produce **the
same log line**, and the turn proceeds ungrounded either way. Recorded as OPEN `[P4]`/`[P6]`
(**P5-3**); it is a diagnosability finding, not an isolation one.

### C.5 Q5-4 — inert vs. oracle. **CLOSED: inert, and one extra property makes it stronger**

Phase 1 asked whether `updateChunk` inherits the inert-id contract and whether the portal 404 is
distinguishable from "no such row anywhere".

**`updateChunk` inherits it.** `:133-134` — `const existing = await getChunk(tenantId, id); if
(!existing) return null;`. `getChunk` returns `null` both for a non-UUID (`:99`) and for a
well-formed id belonging to another tenant (`:100-105`). `faqService.updateFaq` maps `null` through
unchanged (`faqService.js:132-138`). `deleteChunk` (`:156-163`) returns `false` from `rowCount > 0`.

**The 404s are byte-identical.** `PATCH` (`routes.js:2005`) and `DELETE` (`routes.js:2024`) both
emit `res.status(404).json({ error: 'FAQ not found' })`. Same status, same body, same shape, for a
foreign id and for a fabricated one. **No existence oracle.**

**The property Phase 1 did not ask about, and it is the one that could have gone wrong.**
`updateChunk` checks ownership **before** it embeds: the re-embed at `:145` is downstream of the
`:134` early return. Had the order been reversed, a foreign id would have cost one Google round trip
(600–900 ms per `public/portal/faqs.js:13`) while a fabricated id returned in ~1 ms — **a timing
oracle for chunk existence across tenants, wide enough to read over the network.** It does not
exist: both cases perform exactly one `SELECT` and stop. Recorded because the ordering is load-
bearing and reads as incidental.

**One residual asymmetry, within a tenant and therefore not an isolation finding:** an owned chunk
whose text changed takes the W4 path and embeds (~600–900 ms); an owned chunk whose text is
unchanged takes W3 and does not (Phase 2 §D.4). That distinguishes "changed" from "unchanged" for
the tenant's *own* rows, which the tenant already knows.

---

## D. Shared state and caches

### D.1 The enumeration

Every module-level `Map`, memo, singleton and connection-scoped setting reachable from the retrieval
path (`git grep "new Map()\|const cache\|let cache\|Cache ="` over `src/`):

| # | State | file:line | Tenant-keyed? | On the retrieval path? |
|---|---|---|---|---|
| 1 | `genAI`, `embeddingModel` | `knowledgeService.js:4-5` | n/a — SDK handles, no tenant data | **yes** |
| 2 | tenant row cache + expiry timers | `tenantService.js:16-17` | **yes** — key is `phone_number_id` (`UNIQUE`, `schema.sql:55`) or `` `id:${tenantId}` `` (`:82`) | upstream of it |
| 3 | tenant config cache | `configService.js:26` | **yes** — key is `tenant_id` (`:25` comment) | upstream (prompt assembly) |
| 4 | trace collectors | `traces/collector.js:35` | **stronger than tenant-keyed** — a `WeakMap` on the ALS store *object*, so scope is one request | alongside |
| 5 | channel adapter registry | `channels/index.js:33` | n/a — keyed by channel type, holds no tenant data | upstream |
| 6 | voice / telephony provider registries | `voiceProvider.js:29`, `telephonyProvider.js:36` | n/a | not on it |
| 7 | `recentOwnerWamids` | `whatsapp/routes.js:21` | **no — a bare `Set` of message ids** | upstream; see D.2 |
| 8 | pg `Pool` | `db.js:21-27` | n/a — see D.3 | **yes** |

**No cache exists on the retrieval path itself.** Confirmed at HEAD: `knowledgeService.js` holds no
`Map`, no memo and no module-level mutable state beyond the two SDK handles at `:4-5`; R1 executes
on every call. Phase 1 §6.2's finding stands.

### D.2 The one non-tenant-keyed cache, and why it is not a leak

`recentOwnerWamids` (`whatsapp/routes.js:21`) is a global `Set` of WhatsApp message ids used to
suppress duplicate owner commands (`:104-108`), with a 10-minute `setTimeout` eviction (`:109`). It
is keyed on `msg.id`, **not** on tenant. It is safe because WhatsApp message ids are globally unique
and the set stores only ids — no tenant data is retrievable from it. The worst cross-tenant effect
is that if two tenants ever saw the same `wamid` (they cannot), one owner command would be dropped.
**Not a leak.** Recorded because it is the only unkeyed cache in the request path and a future
reader will find it.

### D.3 The connection pool

`db.js:21-27` is one shared `Pool` for the whole process. Its only connection-scoped setting is
`options: '-c statement_timeout=…'` (`:23`), sent as a libpq startup parameter so it is **identical
on every connection** and carries no per-request state. There is no `SET ROLE`, no
`SET search_path`, no `SET app.tenant_id`, no session GUC of any kind, and **no RLS policy anywhere
in `schema.sql`**. Every connection is interchangeable.

**Two consequences, stated plainly:**

1. **Isolation depends on nothing connection-scoped**, so pool checkout order, connection reuse and
   `Promise.all`'s three concurrent legs (`contextAssembler.js:66-76`) cannot mix tenants. This is
   why the audit could stop at the predicate.
2. **The corollary is the hazard.** Because there is no session-state mechanism today, a future
   change that introduced one — `SET app.current_tenant` with RLS, a per-tenant `search_path`, a
   tenant-scoped `statement_timeout` — would be running on a **shared pool with no reset-on-release
   hook**. `db.js` exports `getClient` (`:35`) with no wrapper; callers `release()` directly
   (e.g. `provisioningService.js:250`), so nothing would clear a `SET` before the next tenant got
   that connection. Recorded as OPEN `[P6]` (**P5-4**).

### D.4 THE DELIVERABLE — the tenant-scoping requirement for any future cache

Phase 1 §7 Q5-3 asks for a constraint an implementation session cannot misread. **This is it.**
It is written to be copied verbatim into whichever session adds the first cache.

> ### Binding constraint — caching on the retrieval path
>
> There is **no cache on the retrieval path at HEAD** (`knowledgeService.js` holds only `genAI` and
> `embeddingModel`, `:4-5`). Any query-embedding cache, result cache, semantic cache, or prompt
> cache added later **must** satisfy every clause below. These are not preferences; a cache that
> violates any one of them leaks across tenants by default, because the thing being cached is keyed
> on text that different clinics routinely share.
>
> 1. **`tenantId` MUST be part of the cache key, as its own component — never interpolated into a
>    string with user text.** `` `${tenantId}:${query}` `` is forbidden: a query containing `:` can
>    forge another tenant's key. Use a two-level structure (`Map<tenantId, Map<key, value>>`) or a
>    key built from a fixed-width, unambiguous encoding of the tenant UUID.
> 2. **The key MUST NOT be the query text or its hash alone.** Two clinics asking
>    *"what are your timings"* is the expected case, not the edge case —
>    `validationService.js:219` sends that exact string for **every** tenant at every go-live.
>    A text-keyed result cache would serve clinic B's hours to clinic A on the very first
>    validation run after clinic B's.
> 3. **A cache of query *embeddings* MAY be keyed on text alone, and MUST NOT hold rows.** The
>    embedding of a string is tenant-independent, so caching `text → vector` leaks nothing. Caching
>    `text → chunks` leaks everything. **If one cache is ever made to hold both, it is a result
>    cache and clause 1 applies.** Keep them separate objects so the distinction cannot erode.
> 4. **A `tenantId` that is `undefined`, `null`, or not a UUID MUST NOT produce a cache entry and
>    MUST NOT produce a hit.** R1 today fails closed on all three (§H.2), returning zero rows or
>    throwing `22P02`; a cache that keys on `String(undefined)` would create a shared `"undefined"`
>    bucket that every mis-resolved request reads and writes. Reject before the key is computed.
> 5. **Eviction MUST be per-entry, not global-periodic**, and MUST NOT be the only tenant boundary.
>    Follow `tenantService.js:30-40`'s per-key `setTimeout` + `unref()` shape (Issue 4's ruling); a
>    lingering timer is a shutdown hazard and a shared expiry sweep is not isolation.
> 6. **Any write to `knowledge_chunks` MUST invalidate that tenant's entries.** The five write paths
>    are W1 `storeChunks` (`:21`), W2 `createChunk` (`:119`), W3/W4 `updateChunk` (`:132`), W5
>    `deleteChunk` (`:156`), plus the implicit `ON DELETE CASCADE` (`schema.sql:291`), which **no
>    application code can hook** — so a tenant deletion must be treated as a full flush.
>    ⚠️ Note the precedent this repository has already paid for: `state.md:193-195` records that
>    Issue 11 refused a DID-keyed cache precisely because *"it would need its own invalidation on
>    config writes, which nothing provides."* The same reasoning applies here with more force,
>    because chunks have five writers rather than one.
> 7. **The cache MUST NOT be the only thing standing between two tenants.** The SQL predicate stays.
>    A cache is an optimisation over a correct query, never a substitute for one.
> 8. **A cross-tenant negative test is mandatory and MUST fail if clause 1 is removed.** Two
>    tenants, identical query text, distinct corpora, assert each gets its own — the test §F.4
>    proposes for R1, extended to prove the second call is a hit rather than a miss (otherwise it
>    passes vacuously against a cache that never populated).
>
> **Scale note, so this is not read as urgent.** The envelope is 2,000 retrievals/day system-wide,
> peak ~10/minute (`SCALE ENVELOPE`), against a measured **1.30 ms** per R1 execution at 100× the
> envelope's corpus (§H.3). The SQL is not the cost; the Google embedding round trip is (600–900 ms,
> UNVERIFIED — U-4/U2-1). **A result cache would be optimising the cheap half.** Clause 3's
> embedding cache is the only one the numbers currently argue for.

---

## E. Observability leakage

### E.1 What is recorded

`contextAssembler.js:83-88` is the single capture point for both channels:

```js
trace.setRetrieval(knowledgeChunks.length
  ? knowledgeChunks.map((c) => ({ chunk_id: c.id ?? null, score: c.similarity ?? null }))
  : null);
```

**Ids and scores only — never content**, and the comment at `:78-82` states the reason ("content
already lives in `knowledge_chunks`"). `testTurnService.js:112-114` duplicates the identical shape
inline for the portal test turn. `traces/collector.js:65` (`setRetrieval`) stores it verbatim and
`traces/writer.js:67` persists it. **No transformation adds content anywhere.**

### E.2 Does any log line carry chunk content? **No — verified**

`git grep "knowledgeChunks"` over `src/` returns nine hits: seven are function signatures or
pass-throughs (`aiService.js:206,225,348,360,526,528,558`), and the only two that read `.content`
are `aiService.js:567-568` — the prompt interpolation. **Chunk content reaches exactly one
destination: the system instruction.** It is not logged at any level.

Phase 1 flagged `aiService.js:311` as needing confirmation: it truncates to 200 chars, and the
truncated value is **tool output**, not chunks. Confirmed — chunks never enter that path.

### E.3 Who can read `turn_traces`? **Operators only, and that is the whole answer**

Exhaustive reader list (`git grep "turn_traces"` over `src/`, `scripts/`, `public/`):

| Reader | file:line | Tenant-scoped? | Who reaches it |
|---|---|---|---|
| `tracesQuery.listTraces` | `queryService.js:12-28` | **optional** — `tenantId` is one of three filters; at least one is required (`:18`), but it may be `conversation_id` or `correlation_id` alone | `adminRoutes.js:1013` |
| `tracesQuery.getTrace` | `queryService.js:32-37` | **NO PREDICATE — `WHERE turn_id = $1` only** | `adminRoutes.js:1031` |
| `testTurnService.countTestTurnsToday` | `testTurnService.js:39-43` | **yes** — `WHERE tenant_id = $1 AND channel='test'` | portal route (session) |
| `retentionCron` DELETE / PREVIEW | `retentionCron.js:31-49` | joins `tt.tenant_id = t.id` per-tenant for the window; deletes across tenants by design | cron |

**`getTrace` has no tenant predicate.** Both its callers are admin routes behind `requireAuth`
(`adminRoutes.js:992,1026`), which is a **single shared `ADMIN_PASSWORD`** — an operator surface
that is cross-tenant by design and says so (`adminRoutes.js:775`: *"INV-1 (tenant-from-session-only)
is a PORTAL invariant"*). An operator reading any tenant's trace is the feature.

**No portal route reads trace content.** The portal touches `turn_traces` exactly once, to
`count(*)` its own tenant's test turns (`testTurnService.js:39-43`). **There is no owner-facing
trace viewer at HEAD.** So there is no admin surface that shows one tenant's rows to another
tenant — because there is no tenant-facing surface at all.

**The finding is forward-looking, and it is precise:** `getTrace(turnId)` is a tenant-blind function
sitting in a shared module. Issue 27's trace viewer page is documented as a future consumer
(`queryService.js:3-4`: *"Issue 27's viewer page will consume the same two functions"*). If that
viewer is ever built owner-facing, or if any portal route reuses `getTrace`, **it leaks another
tenant's retrieval provenance — chunk ids, similarity scores, prompt hash, config version, correlation
id, and the `error` envelope — on a single guessed or leaked UUID, with no second check.** Filed as
OPEN `[P6]` (**P5-2**). Not a leak at HEAD.

### E.4 Metrics and error messages

`turnMetrics` records stage names and durations, and tool names (`scriptedTurnCheck.js:263` reads
`trace.timer.snapshot().tools`). No chunk id, score or content appears in a metric label. Error
messages on the retrieval path are `err.message` from the embedding SDK or from pg
(`contextAssembler.js:68`); neither carries chunk text. `traces/writer.js` stores the error envelope
described at `collector.js:70-95`, which holds `stage`, `message`, `status` — no retrieval payload.

### E.5 Verdict for §E

**No observability leak between tenants exists at HEAD.** Retrieval provenance is ids and scores,
never content; the only tenant-blind reader is reachable only from a deliberately cross-tenant
operator surface; and no log line anywhere carries chunk content.

---

## F. Negative test coverage

### F.1 What exists today, by file and test name

| # | File | Test name | What it actually covers |
|---|---|---|---|
| 1 | `tests/portal/portalFaqs.integration.test.js:503` | `READ is scoped to the session tenant; a crafted tenantId is inert (INV-1)` | R2 via `GET /api/faqs?tenantId=<B>` — asserts A never sees B's FAQ |
| 2 | `tests/portal/portalFaqs.integration.test.js:521` | `owner A cannot read, edit, or delete tenant B's FAQ by id (INV-1)` | R3 + W3/W4 + W5 — PATCH ⇒ 404, DELETE ⇒ 404, and B's row asserted byte-unchanged |
| 3 | `tests/portal/portalTestTurn.integration.test.js:420` | `tenant comes from the session only — a crafted tenantId in the body is inert` | entry point 5 — but asserts on **pricing config** (`₹500` vs `₹999`), not on chunks |
| 4 | `tests/portal/portalLifecycle.integration.test.js:912` | `tenant scope (INV-1): a crafted tenantId in body and query cannot validate another tenant` | entry point 6 as reached from the portal; asserts the victim stays `draft` |
| 5 | `tests/portal/portalKnowledgeSummary.integration.test.js:378` | `Cross-tenant (INV-1)` block | the knowledge-summary read, not retrieval |

Plus ~15 further INV-1 cross-tenant blocks across the portal suite (doctors, hours, pricing, safety,
identity, history, onboarding, readiness, auth) which do not touch `knowledge_chunks`.

### F.2 What runs R1's real SQL

**Exactly one test in the suite executes R1 for real**:
`tests/portal/portalFaqs.integration.test.js:463` —
`real semantic retrieval: create → found by a related query → edit re-embeds → delete removes it`.
It calls `knowledgeService.getRelevantChunks(ownerC.tenantId, …)` at `:477`, `:488` and `:497`,
against a live Gemini embedding.

**It is a single-tenant test.** All three calls pass `ownerC.tenantId`; every assertion is about
tenant C's own rows appearing and disappearing. It makes **no cross-tenant claim of any kind**.

Every other reference to `getRelevantChunks` in `tests/` — 29 of them across 17 files — is a stub:
`mock.method(knowledgeService, 'getRelevantChunks', …)` or `deps: { getRelevantChunks: async () => …
}`. A stub replaces the export, so **those tests never execute the SQL at all.**

### F.3 The consequence, stated as a measurement rather than a claim

**Not one test in the suite asserts that R1 is tenant-scoped.** Deleting `WHERE tenant_id = $1` from
`knowledgeService.js:40` would leave:

- the 29 stubbing references untouched — they never reach the SQL;
- test F.1#1–#5 untouched — they exercise R2/R3/W3–W5/config, never R1;
- only `portalFaqs.integration.test.js:463` in contact with the change, where the effect depends on
  whether other tenants' chunks happen to out-rank tenant C's in the top 3 — an incidental
  outcome of fixture ordering, not a designed guard.

**This claim was red-checked, not asserted** — see §F.5.

**This is the evidence behind §G's verdict.** Isolation at the single most consequential hop in the
subsystem — the one query that puts text into a patient-facing prompt — is correct at HEAD and
**structurally undefended**: no test, no type, no schema constraint, and no RLS policy would object
if the predicate disappeared.

### F.4 Tests that SHOULD exist and do not

**Written as proposed names and assertions for Phase 6. None was created. No test file was touched.**

| ID | Proposed test | File it belongs in | The assertion it would make |
|---|---|---|---|
| **T-1** | `R1 is tenant-scoped: a query vector drawn from tenant B's own corpus returns zero of B's rows for tenant A` | new `tests/knowledge/retrievalIsolation.integration.test.js` | Seed two tenants with disjoint chunks in a scratch DB; stub `embed` to return a vector read back from one of B's rows; call `getRelevantChunks(A, …, 3)`; assert every returned id belongs to A **and** that B's source row is absent. **Must fail if `WHERE tenant_id = $1` is removed** — that is the test's whole purpose, and none of the existing 989 does it. Stubbing `embed` costs no Gemini quota; §H.2 is the executed prototype. |
| **T-2** | `R1 denies rather than defaults when the tenant cannot be resolved` | same file | `getRelevantChunks(undefined, …)` and `getRelevantChunks(null, …)` return `[]`; a non-UUID string rejects (`22P02`). Pins the fail-closed behaviour §H.2 measured, so a future "convenience" coercion cannot silently turn a resolution bug into a full-corpus read. |
| **T-3** | *(§A.6 — the operator-supplied tenant path)* `ingestKnowledge writes only to the tenant it was given, and a re-run into a different tenant does not dedup against the first` | `tests/provisioning/provisioning.integration.test.js` | Ingest the same `--kb-dir` into tenant A, then into tenant B; assert both hold full copies (R7's dedup is `(tenant_id, source)`, so the second must not skip), and that A's rows are untouched. Pins the tenant half of the dedup key, which today rests on one uncommented `$1`. |
| **T-4** | *(§B — the least-defended hop)* `the three out-of-module readers stay tenant-scoped` | `tests/validation/`, `tests/lifecycle/`, `tests/provisioning/` | For R5, R6, R7: seed two tenants with **deliberately different** counts / timestamps / sources, and assert each reader returns the value belonging to the tenant it was asked about. Today all three would pass with the predicate removed if the second tenant were empty — so **the fixture must give the other tenant a distinct non-zero value**, which is the part that makes it a real negative test. |
| **T-5** | `getTrace is never reachable from a portal route` | `tests/portal/` or a lint-style unit test | Source-text assertion that `src/portal/routes.js` does not import `traces/queryService`. Cheap, and it is the guard §E.3's forward-looking finding actually needs — the hazard is a future import, not current behaviour. |
| **T-6** | `an FAQ id from another tenant is indistinguishable from a fabricated one` | `tests/portal/portalFaqs.integration.test.js` | Extends F.1#2: assert the PATCH/DELETE responses for a **foreign** id and for a **random** UUID are equal in status *and* body. Pins §C.5's anti-oracle property, which is currently a behaviour nobody asserts. |

### F.5 Red-check of §F.3

§F.3's claim is falsifiable, so it was **executed rather than argued** — and the execution respected
the non-destructive contract exactly: **no repository file was modified.**

**Method.** A shim living in the session scratchpad (outside the repository) hooks `Module._load`,
identifies `knowledgeService` by its export signature, and replaces `getRelevantChunks` with the
identical query **minus `WHERE tenant_id = $1`** (parameters re-indexed, since Postgres rejects an
unreferenced `$n`). It is loaded with `NODE_OPTIONS=--require <shim>`, and its `require` of `db/db`
is lazy so `tests/_support/testEnv.js` still binds the pool. The repository is untouched;
`git status --porcelain` is identical before and after (§H.7).

```
NODE_OPTIONS="--require .../drop_predicate_shim.js" npm test

[red-check] knowledgeService.getRelevantChunks patched: tenant predicate REMOVED
  ...emitted in 40 of the suite's processes

# tests 989
# suites 160
# pass 989
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

**Result: 989 pass, 0 fail — byte-identical to the clean baseline.** With the tenant predicate
deleted from the single retrieval query in the repository, **the suite does not notice.**

**And the one test in contact with the change ran and passed under both conditions**, so this is not
an artefact of a skip:

```
clean baseline (npmtest.log:3687):
    ok 17 - real semantic retrieval: create → found by a related query → edit re-embeds → delete removes it
predicate removed (redcheck.log:3707):
    ok 17 - real semantic retrieval: create → found by a related query → edit re-embeds → delete removes it
```

`# skipped 0` on both runs.

**§F.3 is therefore VERIFIED, not READ.** The 40 patch confirmations prove the shim was loaded and
applied across the suite's child processes; the identical totals prove nothing asserted the
property. This is the measurement behind §G's `UNDEFENDED`.

---

## G. VERDICT

```
ISOLATION HOLDS BUT IS UNDEFENDED AT knowledgeService.getRelevantChunks (R1) —
src/modules/knowledge/knowledgeService.js:37-44
```

**Correct today.** Every one of the seven reads carries a parameterised tenant predicate (§1.1);
every one of the seven entry points denies on resolution failure (§A); no cache exists on the
retrieval path (§D.1); no observability surface crosses tenants (§E); and every attack executed
against a seeded three-tenant database failed closed (§H.2).

**Undefended, in four specific senses, each measured rather than asserted:**

1. **No test.** Not one of the 989 tests would fail if R1's `WHERE tenant_id = $1` were deleted
   (§F.3, red-checked at §F.5). The one test that runs R1 for real is single-tenant.
2. **No structural guarantee.** No RLS policy exists in `schema.sql`; no connection-scoped tenant
   state exists (§D.3); R1 does not select `tenant_id`, so **no consumer downstream can revalidate
   ownership** (§B.R1). The predicate is not one check among several — it is the only one, and
   nothing would notice its absence.
3. **One hop upstream is an operator keystroke.** On the `--kb-dir` provisioning path — step 3 of
   the onboarding runbook — nothing relates the documents to the tenant, nothing detects a mis-aim,
   and the result is undeletable through any product surface (§A.6).
4. **The plan that could under-return is one `SET` away.** R1 never under-returned in 1,060+
   executed queries under the planner's own choices, but forcing the ANN plan reproduced it
   immediately: 3/200 queries returned 2 rows instead of 3 (§H.4). Correctness here rests on a
   cost-model outcome, not an invariant.

Nothing in this list is a leak. All four are the difference between *is correct* and *cannot
silently stop being correct*, and that difference is what this verdict form exists to name.

### G.1 The attack list — everything tried, and why each failed

| # | Attack | Method | Result | The line that stopped it |
|---|---|---|---|---|
| 1 | Pull another tenant's chunks with a perfect-match query vector | R1 verbatim, `tenantId = A`, vector read byte-for-byte from a row **owned by B** (§H.2) | **0 cross-tenant rows.** Control with `tenantId = B` returned that row at similarity `1.000000`, proving the pull was real | `knowledgeService.js:40` |
| 2 | Unresolved tenant ⇒ full-corpus read | `tenantId = undefined` and `= null` | **0 rows** — `tenant_id = NULL` is never true | SQL null semantics; `:40` |
| 3 | Non-existent tenant ⇒ fallback | valid UUID, no such tenant | **0 rows** | `:40` |
| 4 | SQL injection via the tenant parameter | `' OR 1=1 --`, `' OR tenant_id IS NOT NULL --`, `*`, `1; DROP TABLE knowledge_chunks; --` | **All four raise `22P02`.** Table intact, 1,500 rows after | parameterised `$1` (`:43`); no interpolation (§C.1) |
| 5 | Over-large `topK` backfills from neighbours | tenant C (10 rows), `LIMIT 50` | **10 rows, 0 cross-tenant** — under-returns rather than backfilling | `:40` before `:42` |
| 6 | ANN ordering outranks the filter | 600 executed queries under the planner's choice, across three tenants at 0.67%/19%/80% share | **0 cross-tenant rows, 0 under-returns** | filter applied below `Limit` in every plan (§C.3) |
| 7 | Force the dangerous plan | `enable_seqscan=off`, `enable_bitmapscan=off`, 600 more queries | **0 cross-tenant rows** — but **3/200 under-returned** for the 19%-share tenant (§H.4b) | filter still below `Limit`; under-return is a completeness failure, not a leak |
| 8 | Poison the ordering with a `NULL` embedding | Insert a `NULL`-embedding row (`schema.sql:293` permits it) into tenant C, re-run R1 | **Sorted last, `similarity = NULL`, never in the top 3.** No poisoning, no error (§H.5) | `NULLS LAST` default for `ASC` ordering |
| 9 | Existence oracle via the portal 404 | PATCH/DELETE a foreign FAQ id vs. a fabricated one | **Byte-identical 404s** | `routes.js:2005,2024`; `knowledgeService.js:99,134,157` |
| 10 | Timing oracle via the re-embed | foreign id vs. fabricated id on PATCH | **Both perform one `SELECT` and stop** — ownership is checked *before* the embed | `knowledgeService.js:133-134` (early return precedes `:145`) |
| 11 | Crafted `tenantId` in portal query/body | existing suite tests, re-read at HEAD | **inert — nothing reads it** | `auth.js:144`; the six routes in §A.3 |
| 12 | Inject a replacement `getRelevantChunks` through `opts.deps` | traced every `validateTenant`/`transition` call site | **unreachable from HTTP** — portal passes no options; admin passes only a catalogue-validated `skip` | `routes.js:297,326-329`; `adminRoutes.js:719-728` |
| 13 | Reach retrieval through `handleInbound` | opened `channels/index.js` in full (U-9) | **no retrieval, no embedding, no `knowledge_chunks`** | `channels/index.js:51-116` |
| 14 | Read another tenant's retrieval provenance | traced every `turn_traces` reader | **admin-only**; no portal route reads trace content | `adminRoutes.js:992,1026` (`requireAuth`) |

**Attack 7 is the one that partially succeeded**, and it is recorded as a partial success rather
than a failure: it produced no cross-tenant row, but it did produce a wrong answer (2 chunks where 3
were asked for). See §H.4.

---

## H. Query plan measurement — executed, on the scratch database

**Environment.** PostgreSQL 18.4 (x86_64-windows), pgvector **0.8.1**, local Postgres named by
`TEST_DATABASE_URL`. `hnsw.ef_search = 40`, `hnsw.iterative_scan = off`,
`hnsw.max_scan_tuples = 20000` — all pgvector defaults, and the repository sets none of them
(Phase 1 §4). No repository migration was run against any shared or dev database; the scratch DBs
were built with `runner.genesis({connectionString})` against `src/db/schema.sql`, which reproduces
both indexes exactly (`knowledge_chunks` DDL verified post-genesis).

### H.1 Seed

Primary scratch DB **`zyon_iso_0e8ea25d`**, three tenants of deliberately unequal size, random
**unit-normalised Gaussian** 768-dim vectors (the shape a real embedding has — not zeros, which
would make every distance identical):

```
tenant A (large, 1200) = 571e06ec-34a0-45c3-9777-6220150c2420
tenant B (medium, 290) = 483e2c18-cdb1-4341-8d39-4ff004875862
tenant C (small,    10) = bb548b55-df46-4e65-a19a-9e6ef6b621f8

seeded 1500 rows in 6579 ms (228 rows/s)
  571e06ec-34a0-45c3-9777-6220150c2420  1200
  483e2c18-cdb1-4341-8d39-4ff004875862  290
  bb548b55-df46-4e65-a19a-9e6ef6b621f8  10
table+indexes: 12 MB
```

Tenant C holds **0.67%** of the corpus — the small share §H.4 needs.

### H.2 The executed isolation attack — raw output

R1's SQL **verbatim** from `knowledgeService.js:38-42`, with the same parameter shape
`[tenantId, '[…]', topK]`. The query vector is read back byte-for-byte from a row **owned by tenant
B**, which is the strongest possible cross-tenant pull: distance 0 to a row tenant A must never see.

```
query vector = tenant B row 4f4831ca-aae8-45d3-9e8b-f1ebc7c68e4f  (B chunk 0)

──────────────────────────────────────────────────────────────────────────────
ATTACK 1 — R1 with tenantId = A, query vector = a row OWNED BY B, LIMIT 3
──────────────────────────────────────────────────────────────────────────────
rows returned: 3
  owner=A  sim=0.095479  A chunk 371
  owner=A  sim=0.093996  A chunk 13
  owner=A  sim=0.088704  A chunk 376
cross-tenant rows (owner != A): 0
exact source row present?      : no

──────────────────────────────────────────────────────────────────────────────
CONTROL — same query vector, tenantId = B (proves the pull is real)
──────────────────────────────────────────────────────────────────────────────
rows returned: 3
  owner=B  sim=1.000000  B chunk 0
  owner=B  sim=0.100390  B chunk 195
  owner=B  sim=0.095894  B chunk 147
top hit is the source row?     : YES (similarity 1.0)

──────────────────────────────────────────────────────────────────────────────
ATTACK 2 — R1 with tenantId = undefined (what getRelevantChunks does with no tenant)
──────────────────────────────────────────────────────────────────────────────
rows returned: 0   → DENIES (fail-closed)

──────────────────────────────────────────────────────────────────────────────
ATTACK 2b — R1 with tenantId = null (explicit)
──────────────────────────────────────────────────────────────────────────────
rows returned: 0   → DENIES (fail-closed)

──────────────────────────────────────────────────────────────────────────────
ATTACK 3 — R1 with a valid but non-existent tenant UUID
──────────────────────────────────────────────────────────────────────────────
rows returned: 0   → DENIES (fail-closed)

──────────────────────────────────────────────────────────────────────────────
ATTACK 4 — R1 with a non-UUID tenantId string (no isUuid guard on this path)
──────────────────────────────────────────────────────────────────────────────
threw: 22P02 — invalid input syntax for type uuid: "' OR 1=1 --"

──────────────────────────────────────────────────────────────────────────────
ATTACK 5 — classic injection payload in the tenantId parameter position
──────────────────────────────────────────────────────────────────────────────
  "' OR tenant_id IS NOT NULL --" → threw 22P02
  "*" → threw 22P02
  "1; DROP TABLE knowledge_chunks; --" → threw 22P02
knowledge_chunks still present, rows = 1500

──────────────────────────────────────────────────────────────────────────────
ATTACK 6 — tenant C (10 rows) with LIMIT 50: can an over-large topK pull neighbours in?
──────────────────────────────────────────────────────────────────────────────
rows returned: 10 (C owns 10)
cross-tenant rows: 0
```

**The control is the part that makes attack 1 evidence rather than decoration.** The same vector
that returned tenant A's nearest neighbours at similarity **0.095** returns, for tenant B, the
source row at similarity **1.000000**. The pull was maximal; the predicate held.

### H.3 `EXPLAIN (ANALYZE, BUFFERS)` — raw output at three corpus sizes

Vector literals in the plans are elided as `'<768-dim vector>'` for readability; nothing else is
altered, and no plan is paraphrased.

#### (i) The envelope's realistic size — 1,500 rows

**Two shapes were measured at this size, because the envelope's shape and §H.1's deliberately-unequal
shape are different questions.**

**(i-a) The envelope exactly — 10 clinics × 150 chunks** (scratch DB `zyon_iso_04cfa4e1`):

```
tenant rows | share  | plan chosen                | <3 of 100 | min | avg ms
------------------------------------------------------------------------------------
        150 | 10.00% | tenant btree + top-N sort  |         0 |   3 |   1.38

Limit  (cost=30.38..30.39 rows=3 width=38) (actual time=0.863..0.863 rows=3.00 loops=1)
  Buffers: shared hit=904
  ->  Sort  (cost=30.38..30.75 rows=150 width=38) (actual time=0.862..0.863 rows=3.00 loops=1)
        Sort Key: ((embedding <=> '<768-dim vector>'::vector))
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=904
        ->  Bitmap Heap Scan on knowledge_chunks  (cost=5.44..28.44 rows=150 width=38) (actual time=0.059..0.834 rows=150.00 loops=1)
              Recheck Cond: (tenant_id = 'c295685d-c07f-4f5a-b665-7faae1566242'::uuid)
              Heap Blocks: exact=2
              Buffers: shared hit=904
              ->  Bitmap Index Scan on idx_knowledge_chunks_tenant  (cost=0.00..5.40 rows=150 width=0) (actual time=0.020..0.020 rows=150.00 loops=1)
                    Index Cond: (tenant_id = 'c295685d-c07f-4f5a-b665-7faae1566242'::uuid)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning:
  Buffers: shared hit=1
Planning Time: 0.082 ms
Execution Time: 0.879 ms
```

**(i-b) The unequal shape — A=1200 / B=290 / C=10** (`zyon_iso_0e8ea25d`):

```
==============================================================================
CORPUS: 1500 rows total  A=1200 B=290 C=10       size = 12 MB
==============================================================================

EXPLAIN (ANALYZE, BUFFERS) — R1, tenant A (large), LIMIT 3
Limit  (cost=25.21..32.97 rows=3 width=43) (actual time=4.752..4.797 rows=3.00 loops=1)
  Buffers: shared hit=973
  ->  Index Scan using idx_knowledge_chunks_hnsw on knowledge_chunks  (cost=25.21..3131.00 rows=1200 width=43) (actual time=4.751..4.794 rows=3.00 loops=1)
        Order By: (embedding <=> '<768-dim vector>'::vector)
        Filter: (tenant_id = '571e06ec-34a0-45c3-9777-6220150c2420'::uuid)
        Rows Removed by Filter: 3
        Index Searches: 0
        Buffers: shared hit=973
Planning:
  Buffers: shared hit=23
Planning Time: 0.266 ms
Execution Time: 5.134 ms

>>> rows returned = 3 / LIMIT 3   full

EXPLAIN (ANALYZE, BUFFERS) — R1, tenant B (medium), LIMIT 3
Limit  (cost=38.07..38.08 rows=3 width=43) (actual time=3.783..3.785 rows=3.00 loops=1)
  Buffers: shared hit=1747
  ->  Sort  (cost=38.07..38.80 rows=290 width=43) (actual time=3.781..3.781 rows=3.00 loops=1)
        Sort Key: ((embedding <=> '<768-dim vector>'::vector))
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=1747
        ->  Bitmap Heap Scan on knowledge_chunks  (cost=6.52..34.32 rows=290 width=43) (actual time=0.162..3.655 rows=290.00 loops=1)
              Recheck Cond: (tenant_id = '483e2c18-cdb1-4341-8d39-4ff004875862'::uuid)
              Heap Blocks: exact=5
              Buffers: shared hit=1747
              ->  Bitmap Index Scan on idx_knowledge_chunks_tenant  (cost=0.00..6.45 rows=290 width=0) (actual time=0.066..0.066 rows=290.00 loops=1)
                    Index Cond: (tenant_id = '483e2c18-cdb1-4341-8d39-4ff004875862'::uuid)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning:
  Buffers: shared hit=1
Planning Time: 0.231 ms
Execution Time: 3.826 ms

>>> rows returned = 3 / LIMIT 3   full

EXPLAIN (ANALYZE, BUFFERS) — R1, tenant C (SMALL SHARE), LIMIT 3
Limit  (cost=23.41..23.42 rows=3 width=43) (actual time=0.210..0.211 rows=3.00 loops=1)
  Buffers: shared hit=63
  ->  Sort  (cost=23.41..23.44 rows=10 width=43) (actual time=0.209..0.209 rows=3.00 loops=1)
        Sort Key: ((embedding <=> '<768-dim vector>'::vector))
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=63
        ->  Bitmap Heap Scan on knowledge_chunks  (cost=4.36..23.29 rows=10 width=43) (actual time=0.084..0.195 rows=10.00 loops=1)
              Recheck Cond: (tenant_id = 'bb548b55-df46-4e65-a19a-9e6ef6b621f8'::uuid)
              Heap Blocks: exact=1
              Buffers: shared hit=63
              ->  Bitmap Index Scan on idx_knowledge_chunks_tenant  (cost=0.00..4.35 rows=10 width=0) (actual time=0.029..0.029 rows=10.00 loops=1)
                    Index Cond: (tenant_id = 'bb548b55-df46-4e65-a19a-9e6ef6b621f8'::uuid)
                    Index Searches: 1
                    Buffers: shared hit=2
Planning:
  Buffers: shared hit=1
Planning Time: 0.203 ms
Execution Time: 0.244 ms

>>> rows returned = 3 / LIMIT 3   full
```

**Rows returned vs. `LIMIT` requested: 3 of 3 in every case.** The tenant A plan is the only one to
choose the ANN index, and it does so because A holds 80% of the table — a shape ten clinics cannot
produce (§H.6).

#### (ii) 10× — 15,000 rows

Corpus grown around a fixed envelope-typical tenant D (exactly 150 chunks), so the *tenant* is held
constant while the *corpus* moves. This is the measurement that answers "what happens as we add
clinics":

```
size | D share | plan for tenant D (150 rows) | <3 of 100 | min | avg ms | seed s
------------------------------------------------------------------------------------------------
   1650 |   9.09% | tenant btree + sort          |         0 |   3 |   1.38 |      0
   3000 |   5.00% | tenant btree + sort          |         0 |   3 |   1.36 |      6
   6000 |   2.50% | tenant btree + sort          |         0 |   3 |   1.26 |     14
  15000 |   1.00% | tenant btree + sort          |         0 |   3 |   1.27 |     48

table+indexes: 120 MB
```

#### (iii) 1000× — NOT RUN. 100× measured instead, and the reason is a number

**⚠️ Deviation, stated rather than hidden.** 1000× the envelope is 1,500,000 rows. At
`vector(768)` that is ~4.6 GB of heap plus an HNSW index of comparable size — measured at
**1,202 MB for 150,000 rows**, so ~12 GB extrapolated. The machine has **15 GB free on `C:`**
(`df -h /c` → `187G  172G  15G  93%`). Building it would take the system drive past 99% and risk
filling it. **Filling a user's system drive is not an acceptable side effect of a read-only audit**,
so the largest safe size was measured instead: **150,000 rows, 100× the envelope**, 1,202 MB.

```
current 24300 rows → target 150000
dropping idx_knowledge_chunks_hnsw for the bulk load…
bulk load done in 56 s
rebuilding the HNSW index exactly as schema.sql:309-310 declares it…
HNSW build: 100 s

corpus 150000 rows, 1202 MB

=== EXPLAIN (ANALYZE, BUFFERS) — R1, envelope-typical tenant D (150 rows), LIMIT 3 ===
Limit  (cost=24.30..24.31 rows=3 width=41) (actual time=1.880..1.881 rows=3.00 loops=1)
  Buffers: shared hit=1122 read=83
  ->  Sort  (cost=24.30..24.74 rows=175 width=41) (actual time=1.879..1.879 rows=3.00 loops=1)
        Sort Key: ((embedding <=> '<768-dim vector>'::vector))
        Sort Method: top-N heapsort  Memory: 25kB
        Buffers: shared hit=1122 read=83
        ->  Index Scan using idx_knowledge_chunks_tenant on knowledge_chunks  (cost=0.29..22.04 rows=175 width=41) (actual time=0.102..1.837 rows=150.00 loops=1)
              Index Cond: (tenant_id = '537da52e-387e-4979-b3a0-af6b6bb6c34d'::uuid)
              Index Searches: 1
              Buffers: shared hit=1122 read=83
Planning:
  Buffers: shared hit=1 read=8 dirtied=1
Planning Time: 0.249 ms
Execution Time: 2.113 ms

>>> tenant D (150 of 150000, 0.100%): plan=tenant btree + top-N sort, 0/100 under-returned, min 3, avg 1.30 ms

=== the same query for the FILL tenant (majority share) ===
Limit  (cost=1424.16..1430.88 rows=3 width=41) (actual time=32.121..32.196 rows=3.00 loops=1)
  Buffers: shared hit=144 read=2577
  ->  Index Scan using idx_knowledge_chunks_hnsw on knowledge_chunks  (cost=1424.16..312661.49 rows=138865 width=41) (actual time=32.120..32.194 rows=3.00 loops=1)
        Order By: (embedding <=> '<768-dim vector>'::vector)
        Filter: (tenant_id = 'd2e629c5-6694-4ce3-a8f9-07fb3c9e5958'::uuid)
        Index Searches: 0
        Buffers: shared hit=144 read=2577
Planning:
  Buffers: shared hit=1
Planning Time: 0.086 ms
Execution Time: 32.208 ms

>>> FILL tenant (139050 of 150000, 92.7%): plan=HNSW (ANN, approximate), 0/40 under-returned, min 3
```

**The 100× point is the load-bearing one.** At a corpus 100× the envelope, an envelope-typical
tenant holding **0.100%** of it still gets the **exact** plan, still returns 3 of 3, and still costs
**1.30 ms** — statistically identical to the 1.38 ms it cost at 1,500 rows. **Six corpus sizes were
measured (1,500 / 1,650 / 3,000 / 6,000 / 15,000 / 24,300 / 150,000) and the envelope tenant never
touched the ANN index at any of them.** 1000× is UNVERIFIED and recorded as such (**U5-1**); the
mechanism behind the trend is given in §H.6 and predicts it does not change.

### H.4 Does the tenant predicate + ANN ordering ever return fewer rows than `LIMIT`?

**NO — not under any plan Postgres chose, across 1,060 executed queries.**
**YES — under a plan Postgres can choose but did not, reproduced deliberately.**

That is a yes-and-no because the two halves are different facts, and collapsing them would lose the
one that matters. Precisely:

**Under the planner's own choices — 0 under-returns in 600 queries** (200 distinct query vectors ×
three tenants at 80% / 19.3% / 0.67% share), plus 100 more at 15,000 rows and 100 at 150,000:

```
§H.4 — UNDER-RETURN SWEEP: 200 distinct query vectors per tenant, LIMIT 3
  tenant A (owns 1200): 0/200 queries returned < 3 rows; minimum seen = 3
  tenant B (owns 290): 0/200 queries returned < 3 rows; minimum seen = 3
  tenant C (owns 10): 0/200 queries returned < 3 rows; minimum seen = 3
```

**With the exact plans disabled, forcing the ANN scan — it reproduces immediately:**

```
§H.4b — SAME QUERIES with seqscan/bitmap DISABLED (forces the ANN index plan)

--- tenant A (owns 1200) ---
Limit  (cost=25.21..32.97 rows=3 width=43) (actual time=1.426..1.458 rows=3.00 loops=1)
  ->  Index Scan using idx_knowledge_chunks_hnsw on knowledge_chunks  (cost=25.21..3131.00 rows=1200 width=43) (actual time=1.424..1.454 rows=3.00 loops=1)
        Order By: (embedding <=> '<768-dim vector>'::vector)
        Filter: (tenant_id = '571e06ec-34a0-45c3-9777-6220150c2420'::uuid)
        Rows Removed by Filter: 3
        Index Searches: 0
>>> 0/200 under-returned (<3); 0/200 returned ZERO; min = 3

--- tenant B (owns 290) ---
Limit  (cost=25.21..57.27 rows=3 width=43) (actual time=1.304..1.332 rows=3.00 loops=1)
  ->  Index Scan using idx_knowledge_chunks_hnsw on knowledge_chunks  (cost=25.21..3124.18 rows=290 width=43) (actual time=1.303..1.329 rows=3.00 loops=1)
        Order By: (embedding <=> '<768-dim vector>'::vector)
        Filter: (tenant_id = '483e2c18-cdb1-4341-8d39-4ff004875862'::uuid)
        Index Searches: 0
>>> 3/200 under-returned (<3); 0/200 returned ZERO; min = 2

--- tenant C (owns 10) ---
Limit  (cost=40.46..40.47 rows=3 width=43) (actual time=0.110..0.110 rows=3.00 loops=1)
  ->  Sort  (cost=40.46..40.49 rows=10 width=43) (actual time=0.109..0.109 rows=3.00 loops=1)
        Sort Key: ((embedding <=> '<768-dim vector>'::vector))
        Sort Method: top-N heapsort  Memory: 25kB
        ->  Index Scan using idx_knowledge_chunks_tenant on knowledge_chunks  (cost=0.28..40.33 rows=10 width=43) (actual time=0.046..0.100 rows=10.00 loops=1)
              Index Cond: (tenant_id = 'bb548b55-df46-4e65-a19a-9e6ef6b621f8'::uuid)
              Index Searches: 1
>>> 0/200 under-returned (<3); 0/200 returned ZERO; min = 3
```

**Tenant B: 3 of 200 queries returned 2 chunks where 3 were asked for.** That is the pgvector
filtered-search failure mode, executed. The mechanism is `hnsw.ef_search = 40` with
`hnsw.iterative_scan = off`: the ANN scan yields ~40 candidates in global distance order, the tenant
filter is applied on top, and when fewer than `LIMIT` survive the scan does not go back for more.
Tenant C escaped it only because at 10 rows the planner refused the ANN plan even with the
alternatives disabled.

**Why it does not fire in practice, and why that is a coincidence rather than a guarantee.** The
selectivity that makes the ANN plan *dangerous* is the same selectivity that makes the planner
*reject* it: HNSW is chosen only above ~28% tenant share (§H.6), and at that share ~11 of every 40
candidates already belong to the tenant. **The two effects are anti-correlated, so the dangerous
plan is the one Postgres does not pick.** That is a cost-model outcome, not an invariant. Three
things would break it, none of them exotic: stale statistics (a tenant that grew since the last
`ANALYZE`), a session with `enable_bitmapscan` off, or a future `SET hnsw.ef_search` tuning change
made for latency without knowing it is load-bearing for completeness.

**Classification, per the instruction: this is a CORRECTNESS issue, not a performance one — and it
does not reproduce at HEAD.** A silently short retrieval means the receptionist answers from two
chunks instead of three with no error, no log line and no trace signal (the trace records what it
got, `contextAssembler.js:85-87`). It does not belong in this artifact's header because **it did not
reproduce under any plan the system actually runs.** It belongs in OPEN QUESTIONS as **P5-5**, with
the forced-plan reproduction as the evidence that it is real rather than theoretical.

### H.5 Q3-2 rider — the `NULL`-embedding row. **CLOSED: excluded, never poisons**

`schema.sql:293` permits `NULL` (`embedding vector(768)`, no `NOT NULL`, no `CHECK`); Phase 1
established no writer produces one. Inserted one into tenant C (10 rows → 11) and re-ran R1:

```
inserted 195dfa94-fc8e-4e0b-8cde-b49328aaf781 into tenant C (C now owns 11, one with embedding IS NULL)

R1 for tenant C, LIMIT 20 → 11 rows (C owns 11):
   sim=0.044841  C chunk 9
   sim=0.044407  C chunk 0
   sim=0.006245  C chunk 5
   sim=0.005627  C chunk 7
   sim=-0.007045  C chunk 4
   sim=-0.010495  C chunk 6
   sim=-0.014766  C chunk 2
   sim=-0.040057  C chunk 8
   sim=-0.075323  C chunk 1
   sim=-0.089402  C chunk 3
   sim=NULL  NULL-EMBEDDING ROW

NULL-embedding row: position 11 of 11

At LIMIT 3 (the production topK):
   rows=3; NULL row present = false
   sim=0.044841  C chunk 9
   sim=0.044407  C chunk 0
   sim=0.006245  C chunk 5
```

**Answer: sorted LAST, never excluded from the relation, and it does not poison the ordering.**
`embedding <=> $2` is `NULL` for that row, and Postgres's default `ASC` ordering is `NULLS LAST`, so
it sorts behind every real row. At the production `topK = 3` it is unreachable unless the tenant owns
fewer than 3 embedded chunks. `similarity` comes back as SQL `NULL`, which `aiService.js:568` would
ignore anyway (it reads only `.content`) — so the worst case is one content-bearing row with no
score reaching the prompt, and only for a tenant below `kbMin`. **No error, no crash, no reordering
of real rows.** The nullable column is a latent data-quality hazard, not a retrieval hazard.

The rider row was deleted and the corpus restored before the growth measurements.

### H.6 The verdict this section owes — two numbers and one sentence

> **At the envelope's realistic size (1,500 rows, 10 clinics × 150 chunks), the planner chooses a
> Bitmap Index Scan on `idx_knowledge_chunks_tenant` feeding a top-N heapsort — the exact plan — at
> 0.879 ms; it flips to the HNSW ANN index when one tenant holds between 400 and 420 rows of that
> 1,500-row table (~27–28%), which is 1.6× the envelope's per-tenant ceiling of 250.**

Bisected, at a corpus held fixed at 1,500 rows:

```
  tenant =  250 of 1500 (16.7%)  →  tenant btree + top-N sort   under-return 0/60, min 3
  tenant =  400 of 1500 (26.7%)  →  tenant btree + top-N sort   under-return 0/60, min 3
  tenant =  420 of 1500 (28.0%)  →  HNSW (ANN, approximate)     under-return 0/60, min 3
  tenant =  450 of 1500 (30.0%)  →  HNSW (ANN, approximate)     under-return 0/60, min 3
  tenant =  480 of 1500 (32.0%)  →  HNSW (ANN, approximate)     under-return 0/60, min 3
  tenant =  500 of 1500 (33.3%)  →  HNSW (ANN, approximate)     under-return 0/60, min 3
  tenant =  550 of 1500 (36.7%)  →  HNSW (ANN, approximate)     under-return 0/60, min 3
  tenant =  600 of 1500 (40.0%)  →  HNSW (ANN, approximate)     under-return 0/60, min 3
  tenant =  800 of 1500 (53.3%)  →  HNSW (ANN, approximate)     under-return 0/60, min 3
  tenant = 1000 of 1500 (66.7%)  →  HNSW (ANN, approximate)     under-return 0/60, min 3
  tenant = 1200 of 1500 (80.0%)  →  HNSW (ANN, approximate)     under-return 0/60, min 3
```

**The threshold is a *share*, not an absolute count, and the planner's own cost estimates say why.**
At a 24,300-row corpus the exact plan's cost rises with the tenant's rows while the ANN plan's falls
with its share, and they had **not** crossed even at 55%:

```
corpus = 24300 rows

tenant rows | share  | CHOSEN     cost | HNSW-forced cost | HNSW cheaper?
------------------------------------------------------------------------------
         10 |  0.04% | btree+sort  39.69 | HNSW    16004.21 | no
        150 |  0.62% | btree+sort 284.62 | HNSW     2220.83 | no
        290 |  1.19% | btree+sort 369.91 | HNSW     1733.67 | no
        300 |  1.23% | btree+sort 373.18 | HNSW     1717.78 | no
        600 |  2.47% | btree+sort 399.56 | HNSW     1465.83 | no
       1200 |  4.94% | btree+sort 414.21 | HNSW     1340.29 | no
       2400 |  9.88% | btree+sort 466.08 | HNSW     1277.54 | no
       4800 | 19.75% | btree+sort 569.91 | HNSW     1246.13 | no
      13350 | 54.94% | seq+sort   923.71 | HNSW     1226.03 | no
```

The ANN plan's cost tracks the **whole index**; the exact plan's tracks **one tenant's rows**. Adding
clinics grows the former and leaves the latter alone, so **more tenants make the ANN index less
likely to be chosen, not more.** That is the mechanism behind the 100× result in §H.3(iii) and the
reason the untested 1000× point is predicted — not merely hoped — to behave the same way.

> **VERDICT on the HNSW index: at the envelope's scale it is not earning its existence.** It is
> never chosen for a tenant at or below the envelope's 250-chunk ceiling; the flip threshold is
> **400–420 rows for a single tenant in a 1,500-row table**, and no clinic in the envelope reaches
> it. The exact plan it is not being used instead of costs **0.879 ms** at the envelope and
> **1.30 ms** at 100× the envelope. The index's costs are real and paid on every write — **100 s to
> build over 150,000 rows** (§H.3(iii)), and per-row graph maintenance on every insert. The
> insertion rates measured this session are **228 rows/s with the index present** (table growing to
> 1,500), **187 rows/s with it present** (growing to 24,300), and **2,700 rows/s with it dropped**
> (growing to 150,000). ⚠️ **Those are not matched conditions** — the last is both index-free *and*
> on a much larger table — so the honest reading is directional rather than a clean ratio: index
> maintenance dominated insertion at every size measured, and that cost lands directly on the
> `--kb-dir` onboarding path and on every portal FAQ save. A matched measurement is Phase 3's, if
> the number is ever load-bearing.

`ef_search`, `m`, `ef_construction`, IVFFlat, partitioning and composite indexes are **OUT OF SCOPE**
per the instruction and are recorded as OPEN `[P3]` below. **No index change is recommended here** —
the verdict above is a measurement, and the decision is Phase 6's.

### H.7 Scratch databases dropped

**Every scratch database this session created has been dropped, and the drop was verified rather
than assumed.** Eight were created in total, all on the **local** Postgres named by
`TEST_DATABASE_URL` (the script refuses outright if that host is not `localhost`/`127.0.0.1`, so
Neon was never reachable): the primary `zyon_iso_0e8ea25d`, one envelope model
(`zyon_iso_04cfa4e1`), and six short-lived bisection databases. The bisection databases were dropped
inline as each measurement completed (`bisection scratch databases dropped …` in §H.6's run). The
primary was dropped at session end:

```
BEFORE DROP — zyon_iso_* databases present: 1
  zyon_iso_0e8ea25d  1211 MB
  DROPPED zyon_iso_0e8ea25d
AFTER DROP — zyon_iso_* databases remaining: 0
any other zyon_* databases: none
```

The prefix `zyon_iso_` was chosen to be **disjoint** from all 22 prefixes the suite already sweeps
(`zyon_test_`, `zyon_test_conv_`, `zyon_test_cp_`, `zyon_test_mig_`, `zyon_test_prov_`,
`zyon_test_tr_`, `zyon_test_val_`, `zyon_tdet_`, `zyon_cfgs_`, `zyon_own_`, `zyon_pauth_`,
`zyon_prdy_`, `zyon_cx_`, `zyon_lc_`, `zyon_lcr_`, `zyon_rs_`, `zyon_nb_`, `zyon_did_`, `zyon_pwr_`,
`zyon_hx_`, `zyon_pidn_`, `zyon_phrs_`) — the exact hazard `state.md:91-113` records as the
database-destroying race F3-R1 found by perturbing the schedule. **No repository migration was run
against any shared or dev database**, and `saas_crm_test` was neither written nor swept.

**`git status --porcelain` at session end, verbatim:**

```
?? "Phase 1 \342\200\224 Map & DivergenceLedger.md"
?? docs/audit/rag-audit-workflow.md
?? docs/os/audits/
```

Itemised with `-uall` so the collapsed directory is enumerated:

```
?? "Phase 1 \342\200\224 Map & DivergenceLedger.md"
?? docs/audit/rag-audit-workflow.md
?? docs/os/audits/rag/01-map.md
?? docs/os/audits/rag/02-ingestion.md
?? docs/os/audits/rag/05-isolation.md
```

`git diff --name-only` returns **empty — zero modified tracked files.** The five untracked entries
are the three markdown files Phase 2 enumerated at its own Phase 0, plus Phase 2's artifact and this
one. `git rev-parse HEAD` is still `da27980a3ab9ab56978f5b854b3cc62ae498f53d`.

---

## OPEN QUESTIONS

**`[P3]` Storage, index & query execution**

- **P5-6 `[P3]`** — `ef_search`, `m`, `ef_construction`, IVFFlat, partitioning and composite
  indexes were **out of scope** by instruction and were not investigated, beyond recording that
  `hnsw.ef_search = 40` and `hnsw.iterative_scan = off` are the live defaults and that the repository
  sets none of them. §H.6's finding — that the index is not chosen at the envelope's scale — is the
  input Phase 3 needs for any of these.
- **P5-7 `[P3]`** — A **composite/partial index or a partitioning scheme keyed on `tenant_id`** is
  the shape that would let an ANN scan be both fast *and* exact. Explicitly out of scope; recorded
  because §H.4's failure mode is the standard motivation for it and a future reader will ask.
- **P5-8 `[P3]`** — `idx_knowledge_chunks_tenant` is the index every envelope-scale query actually
  uses (§H.3). Whether it should carry additional columns (e.g. `INCLUDE (content)`) to avoid the
  heap fetch — 904 buffer hits for 150 rows at the envelope — is Phase 3's.

**`[P4]` Retrieval quality / diagnosability**

- **P5-3 `[P4]`/`[P6]`** — A `22P02` from a malformed `tenantId` and a Google outage produce the
  **same** log line (`RAG failed (continuing without)`, `contextAssembler.js:68`) and the same
  ungrounded turn. Fail-closed is right; indistinguishable is not. Interacts with Phase 1 Q4-4.
- **P5-5 `[P4]`** — The under-return mechanism (§H.4). It does not reproduce under any plan the
  system runs today, and its non-occurrence rests on a cost-model anti-correlation rather than an
  invariant. Whether that warrants a guard (an assertion that `rows.length === min(topK, tenant
  corpus)`, or pinning `hnsw.iterative_scan`) is Phase 4's to size and Phase 6's to decide.

**`[P6]` Decisions**

- **P5-1 `[P6]`** — §A.6. The `--kb-dir` tenant boundary is an operator typing a filename: nothing
  relates the directory to the slug, `--dry-run` echoes the operator's own input rather than reading
  the target tenant, and mis-targeted document chunks are unremovable through any product surface
  (Phase 2 Q2-P5-a). Compounds with D2-01. **The cheapest candidate fixes, none implemented:** print
  the resolved tenant's `business_name` and current chunk count before ingesting and require
  confirmation; or extend `--dry-run` past the slug lookup so it reports the real target.
- **P5-2 `[P6]`** — §E.3. `tracesQuery.getTrace(turnId)` carries no tenant predicate
  (`queryService.js:32-37`). Harmless at HEAD (admin-only callers) and a cross-tenant leak the day
  Issue 27's viewer, or any portal route, reuses it. Proposed guard: T-5.
- **P5-4 `[P6]`** — §D.3. The shared pool has no reset-on-release hook and `getClient` is exported
  raw (`db.js:35`). Harmless while nothing sets session state; a prerequisite to fix *before* any
  RLS or `SET app.tenant_id` work, not after.
- **P5-9 `[P6]`** — D-06's three out-of-module readers (§B.R5/R6/R7). All three carry a correct
  tenant predicate today; all three would miss a change to the `knowledge` module's scoping contract,
  and nothing would catch it. The cheapest structural fix is naming: `countChunks(tenantId)`,
  `lastChunkChangeAt(tenantId)`, `hasSource(tenantId, source)` on `knowledgeService`.
- **P5-10 `[P6]`** — **`INV-1`…`INV-6` are not in `docs/os/`.** They live in
  `docs/specs/portal-v1-spec.md:40-45`, are declared binding by `portal-v2-spec.md:5`, and are the
  standard three audit phases have now been asked to measure against. A pointer in `docs/os/` (or the
  definitions themselves) would have saved this session the search and will save the next one.
- **P5-11 `[P6]`** — INV-1's own text says *"Cross-tenant negative tests are mandatory in the
  suite."* That is honoured comprehensively for portal **routes** (§F.1) and not at all for the
  **retrieval query** (§F.3). Whether the invariant is meant to reach past the route layer is a
  founder call, and §G's verdict form is chosen to leave it open rather than assume.

---

## UNVERIFIED

| ID | What could not be established | What would establish it |
|---|---|---|
| **U5-1** | **The plan and under-return behaviour at 1000× the envelope (1,500,000 rows).** Not run: ~12 GB extrapolated from the measured 1,202 MB at 150,000 rows, against 15 GB free on `C:`. 100× was measured instead and six corpus sizes establish the trend, but the 1000× point itself is unmeasured. | A machine with ≥40 GB free, or a managed Postgres. ~10 min bulk load + ~17 min index build at the measured rates. |
| **U5-2** | **Whether the flip threshold holds on the production planner.** Everything here is PostgreSQL 18.4 on Windows with this machine's `shared_buffers`, `work_mem`, `random_page_cost` and CPU. Railway's Postgres will differ, and §H.6's threshold is a **cost-model** result, so it moves with those settings. | Re-run §H.6's bisection against the production instance after Issue 20. |
| **U5-3** | **Real embedding vectors.** All seeds are unit-normalised Gaussian noise, so inter-row distances are near-uniform. Real embeddings cluster, which changes how many of an ANN scan's top-40 candidates belong to one tenant — the exact quantity §H.4's mechanism turns on. The isolation results are unaffected (a predicate does not care about distribution); the under-return *rate* is. | An eval corpus of real clinic FAQs, or production traffic. Same blocker as U2-2/U2-3. |
| **U5-4** | ~~**The 600–900 ms embedding latency.** Carried forward unchanged from U-4 / U2-1: it is UI copy at `public/portal/faqs.js:13`, quoted in §D.4's scale note, never reproduced. No embedding API call was made this session.~~ **CLOSED 2026-08-10 (RAG Session 2)** with U-4 / U2-1 — measurements and verdict in `01-map.md` §8 U-4. Bears on §D.4's clause-3 note (*"a result cache would be optimising the cheap half"*): the warm embedding leg is 459–625 ms against a sub-millisecond R1, so the half-and-half framing understates it — the network leg dominates by three orders of magnitude, which strengthens rather than weakens that note's conclusion. ⚠️ Residual: 5 samples, one machine, one region. | ~~One instrumented call, or Phase 4 §D.~~ For the residual: production-region samples after Issue 20. |
| **U5-5** | **Whether `handleInbound`'s `identityService.resolveCustomer` branch** (`channels/index.js:60-66`, gated on `IDENTITY_RESOLUTION_ENABLED === 'true'`) touches retrieval. `identityService` was not opened; the exhaustive `knowledge_chunks` grep (§1.1) returns no hit in it, which is the same strength of evidence Phase 1 had for `handleInbound` itself — and that turned out to be correct when opened. | Open `src/modules/identity/identityService.js`. |
| **U5-6** | **Whether any *other* module reads `turn_traces` through a path not named in §E.3.** The reader list is a literal grep for the table name plus a grep for `queryService`; a future module could reach it through a helper this session did not anticipate. Strong negative evidence, not exhaustive proof. | Unchanged: the same greps, re-run at the commit that adds one. |

Phase 1 §8's **U-9 is now CLOSED** (§A.7). **U-2 and U-3 are CLOSED** by §H.3 and §H.4 respectively.
**U-1, U-4, U-5, U-6, U-7, U-8** are untouched and remain Phase 3/4's; U-4 is restated as U5-4.
**Superseded 2026-08-10 (RAG Session 2): U-4 / U2-1 / U5-4 are CLOSED** (with a stated residual —
see the U5-4 row). U-1, U-5, U-6, U-7, U-8 remain open and untouched.

---

## PHASE 1 QUESTION DISPOSITION — Q5-1 … Q5-5 and U-9

| ID | Status | Detail |
|---|---|---|
| **Q5-1** | **CLOSED** | §B.R5/R6/R7. All three out-of-module readers walked independently. All three carry a correct parameterised tenant predicate at HEAD. For each, the specific change that would make that predicate silently insufficient is named, and in all three cases **nothing would catch it** — the fixtures agree with the drift. Filed as **P5-9**. |
| **Q5-2** | **CLOSED** | §A. All six pre-traced origins verified at HEAD, plus Phase 2's seventh. Every entry point **denies** on failure or ambiguity; there is no default-on-failure anywhere. Two adversarial-focus rows analysed in depth (§A.5, §A.6). §A.6 produced this phase's principal finding, **P5-1**. |
| **Q5-3** | **CLOSED** | §D. The absence of a cache on the retrieval path is confirmed at HEAD and the deliverable is written as **eight binding clauses** an implementation session cannot misread (§D.4), with a scale note showing the numbers currently argue only for clause 3's embedding cache. The pool is covered (§D.3, **P5-4**), and the one non-tenant-keyed cache in the request path is named and cleared (§D.2). |
| **Q5-4** | **CLOSED** | §C.5. `updateChunk` inherits the inert contract via `getChunk` at `:133`; the PATCH and DELETE 404s are byte-identical for a foreign id and a fabricated one, so there is **no existence oracle**. Additionally established, and not asked: ownership is checked **before** the re-embed, so there is **no timing oracle** either — a reversed ordering would have opened a 600–900 ms side channel. |
| **Q5-5** | **CLOSED** | §E. Retrieval provenance is `{chunk_id, score}` and never content, at both capture sites. **No log line anywhere carries chunk content** — verified: `.content` is read at exactly one site, `aiService.js:568`, the prompt. `turn_traces` readers enumerated: admin-only, cross-tenant by design; no portal route reads trace content. One tenant-blind function, `getTrace` (`queryService.js:32-37`), filed forward as **P5-2**. |
| **U-9** | **CLOSED** | §A.7. `channels/index.js` opened and read in full. `handleInbound` performs customer resolution, conversation get-or-create, one `INSERT INTO messages`, and one event emit. **No retrieval.** It is not a seventh entry point. Phase 1's negative grep was correct. Residue: the `identityService` branch was not opened — **U5-5**. |

**All five are CLOSED, and U-9 is CLOSED. None remains open.**

---

## DEFINITION OF DONE

- **Artifact:** this file, `docs/os/audits/rag/05-isolation.md`. ✅
- **Scratch databases dropped, and the drop reported:** §H.7. ✅
- **`git status --porcelain` at session end:** §H.7, pasted verbatim — zero modified tracked files,
  this phase's artifact plus the pre-existing untracked markdown as the only entries. ✅
- **`npm test` unchanged vs `docs/os/state.md:69`** (989 tests / 160 suites / 0 fail), pasted
  verbatim in the header. ✅
- **No test added, edited, or deleted.** No source, schema, migration, config, or dependency
  touched. No package installed. No fix implemented. ✅
- **§G carries one of the three exact verdict forms and nothing softer.** ✅
- **§H.4 answers the under-return question with a yes and a no, each attached to a distinct
  measured condition** — not a hedge: no under-return under any plan the planner chose (0/1,060),
  and 3/200 under the forced ANN plan. ✅
- **§H.6 states a row count:** 400–420 rows for a single tenant in a 1,500-row table. ✅
- **Every Phase 1 question Q5-1 … Q5-5 and U-9 explicitly marked CLOSED**, above. ✅
