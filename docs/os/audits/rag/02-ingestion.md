# RAG Audit — Phase 2: Ingestion, Chunking & Embedding

**HEAD:** `da27980a3ab9ab56978f5b854b3cc62ae498f53d`
**Branch:** `main`
**Date:** 2026-08-09
**Type:** audit-only. No source, schema, migration, config, test, or dependency was modified.
No package installed. No database written. No embedding API call made (see §C.2 — none was needed).

**`npm test`:**

```
# tests 989
# suites 160
# pass 989
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 89138.1475
```

Matches `docs/os/state.md:69` and Phase 1 exactly (989 / 160 / 0 fail). Neither known
intermittent (`traces.integration.test.js:247`, `portalLifecycle.integration.test.js:794`)
fired on this run.

---

## 0. Phase 0 gate report

| Gate | Result |
|---|---|
| `docs/os/` registers read | ✅ `state.md`, `clocks.md`, `decisions.md`, `assumptions.md` |
| `docs/os/audits/rag/01-map.md` exists | ✅ 612 lines, read in full before any scope work |
| HEAD matches the map | ✅ **no drift** — `da27980a…` is byte-identical to `01-map.md:3` |
| Working tree: zero **tracked** files modified | ✅ **PASS** |
| Read-only | ✅ confirmed |

**HEAD drift: none.** `git rev-parse HEAD` = `da27980a3ab9ab56978f5b854b3cc62ae498f53d`, which
is exactly what `01-map.md:3` records. There are zero commits between the map and this session,
so no staleness analysis of `src/modules/knowledge/`, `src/modules/ai/aiService.js`,
`src/db/schema.sql` or `src/db/migrations/` is required.

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
```

**Zero tracked files are modified.** Three untracked entries, all markdown, all predating this
session: Phase 1's prompt saved at the repo root, the audit workflow document that defines these
phases, and Phase 1's own artifact. None is source, schema, config, or test. Per the amended
gate, this does not block. Proceeded.

**`Verified-at` note (unchanged from Phase 1).** `state.md:5` records `424ca05`; HEAD is
`da27980`, which *is* the commit that stamped it. The string can never equal HEAD by
construction; `npm run os:check` is the operative provenance test.

**Gates:** G-CLOCK ❌ · G-PROOF ❌ · G-PAY ❌ · G-TEN ❌. Launch gates 4/7 (`state.md:57-65`).
Zero tenants, zero production rows (`state.md:36-40`) — this number does most of the sizing work
below.

### 0.1 REPL route taken (the foreseen gotcha)

`require` **succeeded**. No file was edited to make it importable.

```
ROUTE: REQUIRE (module loaded successfully; no edit to the file)
GEMINI_API_KEY present in this REPL env: no
chunkText.length (arity) = 1
```

`new GoogleGenerativeAI(undefined)` (`knowledgeService.js:4`) does not throw, and
`getGenerativeModel({model})` (`:5`) constructs a client object without any network call, so the
module-load side effect Phase 1 warned about is real but inert: a client is constructed, nothing
is sent. The probe ran with `GEMINI_API_KEY` **unset**, so a live call was impossible by
construction rather than by care. Probe script lives in the session scratchpad, outside the repo.

---

## A. CHUNKING

### A.1 The algorithm, in plain terms

`knowledgeService.js:48-68`. **VERIFIED** by execution.

1. Split the whole document on blank lines: `text.split(/\n\s*\n/)` (`:49`).
2. Walk the resulting paragraphs, accumulating into `current`.
3. Before appending paragraph P: if `current` is non-empty **and**
   `current.length + P.length + 1 > maxLen`, flush `current` as a chunk, then start the next
   chunk as `current.slice(-overlap) + ' ' + P` (`:57-60`).
4. Otherwise append: `current = current + '\n' + P` (`:62`).
5. Flush whatever is left (`:65`).

Two properties follow directly and both are confirmed below:

- **A paragraph is the atomic unit and is never split.** `maxLen` is not an upper bound on chunk
  size; it is a threshold that decides *when to start a new chunk*. A paragraph larger than
  `maxLen` is emitted whole.
- **The overlap is `current.slice(-50)` — the last 50 UTF-16 code units of the accumulated
  buffer**, taken with no word, sentence, or paragraph awareness.

### A.2 Executed examples — actual chunk boundaries, pasted verbatim

Run against the real imported `chunkText` at default `maxLen=500 overlap=50`.

#### (a) A representative FAQ Q/A pair, byte-identical to `faqService.encode` output

```
=== (a) FAQ Q/A pair, exactly as faqService.encode writes it ===
input length (UTF-16 code units): 160 | paragraphs after split(/\n\s*\n/): 1 | maxLen=500 overlap=50
chunks produced: 1
  --- chunk[0] len=160  newlines=1
      HEAD(70): "Q: What are your clinic timings?\nA: We are open Monday to Saturday, 10"
      TAIL(70): "unday is closed. Walk-ins are seen between 10:00 AM and 12:30 PM only."
```

Unchanged, one chunk. Note this is a **counterfactual**: no FAQ ever reaches `chunkText`.
`createFaq` → `createChunk` (`faqService.js:123` → `knowledgeService.js:119`) embeds and inserts
`content` directly. Run here only to show that even if it did, the chunker would be a no-op on it.

#### (b) A 2,000-character multi-paragraph policy text

```
=== (b) 2,000-char multi-paragraph policy text ===
input length (UTF-16 code units): 1906 | paragraphs after split(/\n\s*\n/): 7 | maxLen=500 overlap=50
chunks produced: 7
  --- chunk[0] len=257  newlines=0
      HEAD(70): "Appointment policy. Patients are requested to arrive ten minutes befor"
      TAIL(70): "xt available slot, as this keeps the day running on time for everyone."
  --- chunk[1] len=356  newlines=0
      HEAD(70): "s this keeps the day running on time for everyone. Cancellations and r"
      TAIL(70): " second occurrence may require an advance deposit for future bookings."
  --- chunk[2] len=326  newlines=0
      HEAD(70): "ay require an advance deposit for future bookings. Payment. We accept "
      TAIL(70): "ditional interest, arranged at the front desk before treatment begins."
  --- chunk[3] len=320  newlines=0
      HEAD(70): "rranged at the front desk before treatment begins. Insurance and reimb"
      TAIL(70): "ease ask at reception on the day of your visit rather than afterwards."
  --- chunk[4] len=309  newlines=0
      HEAD(70): "n on the day of your visit rather than afterwards. Emergencies. Severe"
      TAIL(70): "ible. Call the clinic rather than booking online so we can advise you."
  --- chunk[5] len=317  newlines=0
      HEAD(70): "c rather than booking online so we can advise you. Children. Children "
      TAIL(70): " is usually a short familiarisation appointment rather than treatment."
  --- chunk[6] len=315  newlines=0
      HEAD(70): "familiarisation appointment rather than treatment. Records and privacy"
      TAIL(70): ", except where a treating specialist needs them for your ongoing care."
  >>> overlap into chunk[1]: carried=true | tail="s this keeps the day running on time for everyone." | char before tail="a" | starts mid-word=true
  >>> overlap into chunk[2]: carried=true | tail="ay require an advance deposit for future bookings." | char before tail="m" | starts mid-word=true
  >>> overlap into chunk[3]: carried=true | tail="rranged at the front desk before treatment begins." | char before tail="a" | starts mid-word=true
  >>> overlap into chunk[4]: carried=true | tail="n on the day of your visit rather than afterwards." | char before tail="o" | starts mid-word=true
  >>> overlap into chunk[5]: carried=true | tail="c rather than booking online so we can advise you." | char before tail="i" | starts mid-word=true
  >>> overlap into chunk[6]: carried=true | tail="familiarisation appointment rather than treatment." | char before tail=" " | starts mid-word=false
```

**Seven paragraphs in, seven chunks out.** Every paragraph triggered a flush, because any two
realistic policy paragraphs (250–300 chars each) already exceed 500. At `maxLen=500` the
accumulate branch (`:62`) is effectively unreachable for prose of this shape: **`chunkText`
degenerates to one-chunk-per-paragraph plus a 50-character prefix.**

#### (c) A single paragraph longer than `maxLen`

```
=== (c) single paragraph longer than maxLen ===
input length (UTF-16 code units): 741 | paragraphs after split(/\n\s*\n/): 1 | maxLen=500 overlap=50
chunks produced: 1
  --- chunk[0] len=741  *** EXCEEDS maxLen ***  newlines=0
      HEAD(70): "Root canal treatment at this clinic is carried out over one or two vis"
      TAIL(70): "t for the whole course of treatment rather than the first stage alone."
```

**Not split at all.** 741 characters, 148% of `maxLen`, emitted whole.

#### (d) Text with no blank lines at all

```
=== (d) text with NO blank lines at all ===
input length (UTF-16 code units): 620 | paragraphs after split(/\n\s*\n/): 1 | maxLen=500 overlap=50
chunks produced: 1
  --- chunk[0] len=620  *** EXCEEDS maxLen ***  newlines=6
      HEAD(70): "Clinic address: 4th floor, Jubilee Arcade, Road No. 36, Jubilee Hills,"
      TAIL(70): "I and cards. Instalments available on plans above ten thousand rupees."
```

Seven single-newline lines → `split(/\n\s*\n/)` returns **one** element → **one chunk containing
the entire document**, at any length. `provisioningService.js:130` ingests `*.md` and `*.txt`; a
clinic information file written as a line-per-fact list — address, timings, doctors, languages,
payment — is exactly this shape.

#### (e) Telugu, same `maxLen`

```
=== (e) Telugu multi-paragraph (information density at the same maxLen) ===
input length (UTF-16 code units): 330 | paragraphs after split(/\n\s*\n/): 3 | maxLen=500 overlap=50
chunks produced: 1
  --- chunk[0] len=328  newlines=2
```

Measured directly, same sentence in both languages:

```
Telugu  : code units=107  graphemes=68  units/grapheme=1.57
English : code units=81   (same sentence, same facts)
ratio of code units for equivalent content (te/en) = 1.32
```

`maxLen` is counted in UTF-16 code units (`:57` uses `.length`). Telugu costs **1.32× the budget
for the same facts**, and averages **1.57 code units per grapheme**. The chunk-size knob therefore
means something different per language. **VERIFIED** by measurement.

#### (f) CRLF — checked, and it is fine

```
=== (f) CRLF blank-line separator ===
input length: 62 | paragraphs after split(/\n\s*\n/): 2 | chunks produced: 1
  chunk[0] "First paragraph about fees.\nSecond paragraph about timings."
```

`/\n\s*\n/` matches `\n\r\n` because `\s*` absorbs the `\r`, and the stray `\r` is removed by
`para.trim()` (`:54`). **Windows line endings do not break paragraph splitting.** Recorded so a
later session does not chase it.

#### (g) The duplicate-row case — reproduced on a realistic markdown document

Derived from the algorithm and then reproduced. A chunk is wholly duplicated into its successor
when it is **≤ `overlap` (50) characters**, because `slice(-50)` of a ≤50-char string is the whole
string. That can only happen to the **first** chunk (after any flush, `current` is already
≥ 51 chars), and the precondition is precise: **first paragraph ≤50 chars, and
first + second + 1 > `maxLen`.**

A markdown title line followed by an ordinary intro paragraph satisfies it:

```
title=35 body=489 -> title+body+1=525 vs maxLen=500
chunks: 3

chunk[0] len=35
  "# Smile Dental — Clinic Information"

chunk[1] len=525
  "# Smile Dental — Clinic Information Smile Dental has served Jubilee Hills since 2011. We are a six-chair practice with t" …

chunk[2] len=140
  "to have it stamped before they leave the building. ## Timings\nMonday to Saturday, 10:00 AM to 8:00 PM. Sunday closed exc" …

=== containment check ===
  chunk[0] (35 chars) WHOLLY CONTAINED in chunk[1] -> 2 rows, 2 vectors, duplicate text
```

Two rows, two embedding calls, two vectors, identical text — and **no dedup exists anywhere**
(Phase 1 §6.2). `chunk[1]` is additionally 525 chars, over `maxLen`, because the overlap is added
to an already-full paragraph.

#### (h) Markdown headings are separated from their own bodies

Not asked for, found while constructing (g), and it is the most consequential shape because
`--kb-dir` reads `*.md`:

```
input length: 758 | paragraphs: 7 | chunks: 3

chunk[0] len=268
  "# Smile Dental — Clinic Information\n## Timings\nMonday to Saturday, 10:00 AM to 8:00 PM. … for the rest of the day.\n## Fees"

chunk[1] len=333
  "ity over walk-ins for the rest of the day.\n## Fees A consultation is five hundred rupees … excluding the crown.\n## Payment"

chunk[2] len=251
  "usand for a molar, excluding the crown.\n## Payment We accept cash, UPI, and all major debit and credit cards. …"
```

`## Fees` is the **last** thing in `chunk[0]`, which contains no fee information; `## Payment` is
the last thing in `chunk[1]`, which contains no payment information. Every chunk ends with a
heading announcing a topic it does not contain, and begins with a truncated fragment of the
previous topic. Both are embedded (`:23`) and both are rendered verbatim to the model as
`- ${c.content}` (`aiService.js:568`).

### A.3 What `maxLen=500` and `overlap=50` actually do

`knowledgeService.js:48`. Both callers use the defaults — `scripts/ingest-knowledge.js:21` and
`provisioningService.js:146` both call `chunkText(text)` with one argument (Phase 1 §4). There is
no way to change either without editing the module.

**Does the overlap carry semantic content or a mid-word fragment?** Measured: **five of six
overlaps in (b) start mid-word** — `"s this keeps…"`, `"ay require…"`, `"rranged at…"`,
`"n on the day…"`, `"c rather than…"`. The sixth landed on a space by luck.

But mid-word truncation is the cosmetic half. The substantive half is what the fragment *is*:
`current.slice(-50)` is the tail of the **previous paragraph**, which under (b)'s
one-chunk-per-paragraph degeneracy is a **different topic** from the chunk it now opens.
`chunk[2]` reads `"ay require an advance deposit for future bookings. Payment. We accept cash,
UPI…"` — the cancellation policy's tail glued to the payment paragraph. The overlap does not
provide continuity between related text; it prepends a decontextualised fragment of an unrelated
topic. That fragment is inside the embedded vector and inside the prompt.

**Does a single oversized paragraph get split?** **No** — (c), 741 chars emitted whole; (d), 620
chars emitted whole; (g) `chunk[1]`, 525 chars. `maxLen` bounds nothing.

### A.4 Stakes — sizing every chunking finding above

Phase 1 §5 D-08 and §7 Q2-1 establish, and this session confirms by citation rather than
re-derivation, that:

- no shipped surface produces `source:'document'`;
- `chunkText` is reachable only from `scripts/ingest-knowledge.js:21` and
  `provisioningService.js:146`, both CLI;
- **the chunker touches zero request-path rows.**

All three hold at HEAD. Everything in §A.1–A.3 is therefore **off the request path**, and no
patient-facing turn can reach it today.

**But it is not off the customer-#1 path, and Phase 1 did not have this piece.** The provisioning
CLI's own operator-facing output actively directs the operator into the chunker:

```
scripts/provision-tenant.js:62   '  3. Ingest its knowledge base:  --kb-dir <path>  (resumable).'
scripts/provision-tenant.js:64   '  3. Knowledge base ingested. Add more docs any time with --kb-dir.'
```

`printNextSteps` (`:54-69`) is described in its own comment as *"the seed of the onboarding
runbook"*, and `docs/specs/zyon-first-launch-plan.md:138` scopes Issue 15 as creating the tenant
*"(+ optional `--kb-dir` ingest)"*. So the first time a real clinic is provisioned, step 3 of the
printed runbook is the chunker.

**Correct sizing, applied to every chunking finding below:** these are **latent, not vacuous**.
They are worth **zero** as long as no `--kb-dir` document exists (today: 0 rows, 0 tenants), and
they become live the first time an operator follows step 3 — which is the next thing that happens
to this subsystem. That is what keeps them out of verdict **C** (no defect is demonstrable at
*current* scale, because current scale is zero rows) and out of verdict **E** (they are not
unreachable — the CLI prints the path to them). They are **D**, with the trigger being a row
count of 1, not a scale threshold.

This is also why §A does not contain a chunking-strategy essay. Every recommendation-shaped
question about splitting, headers, or windows is downstream of one fact: **nothing has ever been
chunked.**

### A.5 Q2-2 — does `Q: …\nA: …` embed better or worse than answer-only?

**What is decidable by reading code (VERIFIED):**

- `faqService.encode:63` stores `` `Q: ${question}\nA: ${answer}` ``; `createChunk` embeds
  `content` whole (`knowledgeService.js:120`). **The question text is inside the vector.**
- The identical string is what the model is shown — `aiService.js:568` renders `- ${c.content}`.
  `faqService.js:11-15` states this coupling as a design constraint: the stored text *"has to
  already read as a usable answer, not a record format the model would have to decode."*
- Therefore question and answer are coupled by **two** requirements at once: the blob must embed
  well **and** read well in the prompt.
- **The load-bearing consequence:** embedding answer-only is not a tuning change here, it is a
  **schema change**. `knowledge_chunks` has one `content` column and one `embedding` column
  (`schema.sql:289-301`); there is nowhere to put an embedding input that differs from the stored
  and rendered text. Any answer-only experiment requires a new column, a migration, and lockstep
  `schema.sql`.

**What is not decidable by reading code:** whether the concatenation embeds better or worse
against a question-shaped query. Settling it needs an eval set of (query → expected chunk) pairs.
**No such set exists in this repository** — every test stubs `getRelevantChunks` rather than
measuring it (Phase 1 §1.5, §2.2), there is no retrieval-quality fixture anywhere, there are zero
production queries and zero transcripts (`state.md:36-40`; envelope).

**Stated plainly, as instructed: undecidable without the eval set that does not exist. Not
guessed at.**

One code-derived observation offered as a *shape* observation and explicitly not a relevance
claim: the query is the raw patient utterance embedded verbatim (Phase 1 §6.2 — query rewriting
ABSENT; `contextAssembler.js:67` → `knowledgeService.js:34`), and the stored text is question-led.
Both strings are question-shaped. Whether that helps is the part requiring the eval set.

---

## B. METADATA

### B.1 Column inventory

`schema.sql:289-301`. Write IDs (W1–W6) and read IDs (R1–R7) are Phase 1 §3.2/§3.3's.

| Column | Written by | Read by | Does R1 (the only retrieval query) filter or rank on it? |
|---|---|---|---|
| `id` | DB default `gen_random_uuid()` (`:290`) | R1 `:38` (selected for trace provenance only — Issue 22); R2 `:88`; R3 `:101`; predicate in `getChunk:102`, `updateChunk:139,148`, `deleteChunk:159` | **selected, never filtered, never ranked** |
| `tenant_id` | W1 `:27`, W2 `:124` | **all seven reads** R1–R7 | **filters** — the only predicate on R1 |
| `content` | W1 `:27`, W2 `:124`, W4 `:149` (W3 does **not** touch it) | R1 `:38` → `aiService.js:568` (the prompt); R2/R3 → portal; `updateChunk:136` compares it to decide re-embed | selected, not filtered, not ranked |
| `embedding` | W1 `:27`, W2 `:124`, W4 `:149` | **R1 only** — `1 - (embedding <=> $2::vector)` and `ORDER BY embedding <=> $2::vector` | **ranks.** The only column that does |
| `source` | W1 `:27`, W2 `:124`, W3 `:140`, W4 `:149` | R2 `:88`, R3 `:101`, **R4 `:113`** (prefix match — the `MAX_FAQS` gate), **R7 `provisioningService.js:137`** (exact match — ingest dedup) | **neither selected nor filtered by R1** |
| `created_at` | DB default (`:295`) | R2 `ORDER BY created_at` (`:89`) — the FAQ list order; R3; `RETURNING` on W2/W3/W4; reaches the owner via `faqService.project:80` | no |
| `updated_at` | DB default + trigger `trg_knowledge_chunks_updated` (`:303-304`) | **R6 only** — `max(updated_at)` in `lifecycleService.validationInputsChangedAt:167`, the validation-staleness signal (F1-R1, migration 026) | no |

**`embedding` is nullable** — `vector(768)` with no `NOT NULL` and no `CHECK` (`schema.sql:293`).
All three writers always supply it and no write path can produce NULL: W3 (`updateChunk`
text-unchanged branch, `:137-141`) sets `source` only and cannot null an existing vector; no
INSERT omits the column. **Consequence forwarded to `[P3]` (Q3-2) — R1's behaviour on a
NULL-embedding row is not analysed here.**

**Metadata written but never read: none at the column level.** All seven columns have at least one
reader. There is one at the *value* level, in §B.3.

### B.2 Conventions encoded into a column

None has schema support; all are conventions in application code.

| # | Convention | Written at | Decoded / relied on at |
|---|---|---|---|
| 1 | `content` = `` `Q: <question>\nA: <answer>` `` | `faqService.encode:63` | `decode:68-76`, which splits on the **first** `\n` and relies on that being the **only** `\n` — guaranteed because `normalize:89-90` collapses `\s+` in both halves first |
| 2 | `source` = `'faq'` \| `'faq:<lang>'` | `sourceFor:51-53` | `isFaqSource:54-56`, `languageOf:57-60`, and R4's `source = $2 OR source LIKE $2 \|\| ':%'` |
| 3 | `source` = document filename **basename** | `provisioningService.js:135` (`path.basename(file)`) | R7's exact-match dedup (`:136-139`) |
| 4 | `source` = `--source` label, else the **full file path** | `scripts/ingest-knowledge.js:13` — `flag('--source') \|\| filePath` | nothing |
| 5 | `source` = `'document'` | **never written** — specified at `portal-v1-spec.md:99-100` (Phase 1 D-08) | nothing |

**Convention 1 is broken by the chunker, harmlessly today.** `decode`'s single-newline invariant
holds only for rows `faqService` wrote. Measured above: (d)'s chunk carries **6** newlines and
(h)'s carry several. `decode` is unreachable for those rows only because `listFaqs` filters to
`isFaqSource` before projecting (`faqService.js:111`). The invariant is protected by a filter, not
by the data. **READ** — recorded, not a live defect.

**Conventions 3 and 4 disagree about the same file.** `provisioningService` writes the basename;
`ingest-knowledge.js` writes the full path when `--source` is omitted. A document ingested by the
script and then re-ingested through `--kb-dir` writes rows under two different `source` values,
and R7's exact match does not recognise the first set. Two CLI paths into `storeChunks`, two
`source` conventions. **VERIFIED** by reading both call sites.

### B.3 Q2-6 — is the `faq:<lang>` tag dead weight or an unrealised improvement?

**Classification: unrealised — inert at retrieval, load-bearing at write. Not dead weight.**

The tag has three readers, none of them R1:

1. **The `MAX_FAQS` cap.** R4 (`countChunksBySourcePrefix:110-117`) matches
   `source = 'faq' OR source LIKE 'faq:%'`, and `createFaq:120` gates on it. The tag is *inside*
   the cap's predicate — a tag shape outside that pattern escapes the cap entirely.
2. **The owner's edit form.** `faqService.project:80` → `languageOf(source)` → the portal's
   language dropdown. It round-trips.
3. `isFaqSource` (`:111`), which is what hides document chunks from the portal (§B.4).

And it is **invisible to retrieval**: R1 (`knowledgeService.js:38-42`) selects
`id, content, similarity` and filters `tenant_id` only. Confirms Phase 1 §7 Q2-6.

**The structural consequence, decidable from code:** a clinic that authors one FAQ in Telugu,
Hindi and English holds **three rows** in one vector space with no language predicate at
retrieval. At `topK = 3` (the default on every production path — Phase 1 §4), a single question
answered in three languages can consume **all three slots**. The data needed to prevent that is
already written; the query that would use it does not exist. Retrieval-side use is **`[P4]`**'s.

### B.4 D-10 — the constraint, recorded

Phase 1 D-10 established that `faqService.js:19-21`'s comment — *"Nothing else reads `source` as
anything but a free label today"* — is wrong on two counts. Confirmed at HEAD, with the breakage
mode for each:

| Reader | Match | What a widened `source` convention does |
|---|---|---|
| `knowledgeService.js:112-114` (R4) | `source = $2 OR source LIKE $2 \|\| ':%'` | a new FAQ tag shape outside `faq` / `faq:<x>` **escapes the `MAX_FAQS` cap** — the corpus-size bound stops binding, silently |
| `provisioningService.js:136-139` (R7) | `source = $2`, **exact**, `$2 = path.basename(file)` | a prefix, namespace, or path change makes the dedup **miss**, and a re-run **re-ingests the whole file, duplicating every chunk** — the exact inverse of §D.2's failure, from the same key |

Both fail silently and neither has a test that would catch a convention change. **Constraint
recorded for Phase 4: `source` is a load-bearing key in two places and a free label in none.**

### B.5 Document chunks are write-only from every owner surface

The one value-level "written but not readable" finding. **VERIFIED** by caller-chain reading.

`listChunks` (R2) has exactly one caller: `faqService.listFaqs:110`, which filters to
`isFaqSource` (`:111`) and **drops every non-FAQ row**. Therefore a chunk written by W1
(`storeChunks`, the only chunker-fed writer):

- appears in **no** portal list;
- exposes its `id` on **no** surface — so `PATCH`/`DELETE /portal/api/faqs/:id`
  (`routes.js:1996,2020`), which need that id, cannot reach it;
- **counts toward `checkKbPopulated`** (`validationService.js:211-212`, raw `count(*)`, no source
  filter) but **not toward `MAX_FAQS`** (R4's prefix excludes it);
- can be removed only by `psql`, or by deleting the tenant via the `ON DELETE CASCADE` at
  `schema.sql:291`.

So a document ingested with a typo, a stale price, or a wrong timing is **not correctable by the
clinic owner and not correctable from the portal at all** — while still being retrievable into
every patient-facing turn. Sized per §A.4: zero rows today, live at the first `--kb-dir` run.

---

## C. EMBEDDING

### C.1 Model / dimension agreement at HEAD — verified by citation

| Fact | Value at HEAD | Citation |
|---|---|---|
| Model instantiated | `'gemini-embedding-001'` | `knowledgeService.js:5` |
| Requested dimensionality | `768` | `knowledgeService.js:13` |
| Stored column dimension | `vector(768)` | `schema.sql:293` |

**They agree.** 768 requested, 768 stored. **VERIFIED.**

**D-01 confirmed — the comments are the wrong party.** Both comments name a model the code does
not run, read verbatim at HEAD:

```
schema.sql:293                    embedding   vector(768),         -- Google text-embedding-004 output dimension
004_embedding_768.sql:1           -- Switch embedding from 3072 (gemini-embedding-001) to 768 (text-embedding-004)
```

The code runs `gemini-embedding-001` (`:5`). Anyone reading the schema to answer *"what produced
these vectors?"* gets `text-embedding-004`, which nothing in `src/` references.

**D-02 confirmed as well**, since it was cheap to check while reading 004 verbatim:
`002_knowledge_chunks.sql:8` already declares `embedding vector(768)`, so `004`'s `DROP COLUMN` →
`ADD COLUMN vector(768)` is a **no-op on dimensionality**; its only surviving effect on the
migrate path is `CREATE INDEX … hnsw` at `:4`.

Phase 1 §8 **U-5** (whether 3072 was ever real) is **out of scope** per this phase's instructions
and was not investigated. It does not affect HEAD behaviour.

### C.2 Ingestion and query use the identical model and dimensionality — proof from both sides

**VERIFIED, and the proof is stronger than a comparison of two call sites.**

There is exactly **one** function in the repository that calls `embedContent`: `embed`
(`knowledgeService.js:10-19`). Neither the model nor the dimensionality is a parameter of it:

- the model is closed over from module scope — `embeddingModel` (`:5`), constructed once at load;
- the dimensionality is a **literal inside the request object** — `outputDimensionality: 768`
  (`:13`).

| Side | Call site | Reaches |
|---|---|---|
| Ingestion — CLI documents | `:23` (`storeChunks`) | `embed` |
| Ingestion — portal FAQ create | `:120` (`createChunk`, via `module.exports.embed`) | `embed` |
| Ingestion — portal FAQ edit | `:145` (`updateChunk`, via `module.exports.embed`) | `embed` |
| **Query** | `:34` (`getRelevantChunks`) | `embed` |

All four reach the same function, and **no argument exists through which a caller could differ**.
Divergence is structurally impossible without editing `embed` itself. This is a stronger guarantee
than two call sites agreeing.

The one asymmetry between the sides is real and orthogonal: `:34` may pass `signal`; the three
ingestion sites never do. `signal` reaches the SDK's `buildFetchOptions` and affects cancellation
only — not model, not dimensionality.

**One thing the prompt's warning points at, worth recording precisely.** `:120` and `:145` call
`module.exports.embed` while `:23` and `:34` call the bare `embed` — a deliberate test-stubbing
seam, documented at `:76-79`. It means a test can stub the **portal write path's** embedder while
`storeChunks` and `getRelevantChunks` keep the real one. That is a divergence **in tests only**;
at runtime all four resolve to the same function. So the mock seam cannot hide a runtime
model/dimension divergence — but it *can* hide a portal-write-path change from a retrieval test,
which is the shape of hazard the warning describes.

### C.3 Q2-3 — task types, and the decision-timing cost

**What the code does (VERIFIED).** The request object is, verbatim (`knowledgeService.js:11-14`):

```js
const request = {
  content: { parts: [{ text }] },
  outputDimensionality: 768
};
```

No `taskType`. `gemini-embedding-001` distinguishes `RETRIEVAL_DOCUMENT` from `RETRIEVAL_QUERY`;
neither is set on either side. Because §C.2 proves both sides are the *same function*, the two
sides are **self-consistently symmetric**: whatever default the provider applies, it applies
identically to stored and query vectors, so they share one space. This is not accidental symmetry
that could drift — it is symmetry by construction.

**The relevance cost: honestly unmeasurable here.** Settling it requires production queries; there
are none, and there are no transcripts (`state.md:36-40`; envelope). It also cannot be inferred
from the one retrieval gate that exists: `validationService.checkKbRetrieval:218-225` uses
`topK = 1` and the single hardcoded query `'what are your timings'`, and passes if *anything* comes
back (`chunks.length === 0` is the only test) — a smoke check, structurally incapable of measuring
relevance. **Stated as unmeasurable rather than estimated.**

**The decision-timing property, as a number.** Adopting asymmetric task types requires re-embedding
every stored row, because query and document vectors must share a space:

| When | Rows to re-embed | Embedding calls |
|---|---|---|
| **Today** | **0** — zero tenants, zero rows (`state.md:36-40`) | **0** |
| **At the envelope's 10 clinics** | **1,500 typical / 2,500 ceiling** | **1,500 / 2,500** |

Two properties of that curve, both facts rather than advice:

- It is **monotonically increasing and never falls.** The cost of the decision today is zero and
  can only rise.
- **No backfill tool exists.** `git grep -li "backfill\|re-embed\|reembed" -- scripts src` returns
  `scripts/backfill-tenant-configs.js` (a *config* backfill) and migration files; nothing
  re-embeds. The 1,500–2,500 calls would need a tool that would have to be written first.

**This is a cost curve, recorded for Phase 6. No change is recommended here.**

### C.4 Multilingual reality check — what the ingestion path accounts for

**The complete list of what exists (exhaustive):**

1. `sourceFor(language)` → `source = 'faq:<lang>'` (`faqService.js:51-53`), written from the
   portal's language dropdown and validated against the tenant's enabled languages
   (`normalize:98-103`).

That is the entire list. **One tag, on one of the two ingestion paths** (documents never get one —
W1's `source` is a filename).

**What is absent from the ingestion path**, established by reading it end to end:

- **No Unicode normalization.** `normalize:89-90` collapses `\s+` and trims; there is no
  `.normalize('NFC')` or `NFKC` anywhere before `embed`. Two visually identical Telugu strings in
  different composition forms embed as different text.
- **No script detection, no transliteration handling, no romanisation.** `embed` receives the raw
  string (`:12`).
- **No language signal reaches the embedder.** The request object (`:11-14`) carries `text` and
  `outputDimensionality` and nothing else — the `faq:<lang>` tag stops at the `source` column.
- **`chunkText` measures in UTF-16 code units, not graphemes or tokens** (`:57`). Measured in
  §A.2(e): Telugu costs **1.32×** the budget for identical facts and averages **1.57 code units
  per grapheme**, so `maxLen=500` is a different-sized window per language.

**The one structural consequence that is decidable from code** is §B.3's: same-question-different-
language rows share one vector space with no language predicate at retrieval, so `topK = 3` can be
consumed by one answer three times.

**Everything else is flagged, not speculated on** — see OPEN QUESTIONS `[P4]`. In particular,
whether `gemini-embedding-001` places transliterated Telugu near native-script Telugu is not
answerable from this repository, and no answer is offered.

---

## D. WRITE-PATH SAFETY AND COST

### D.1 Embedding API calls per action

| Action | Calls | Evidence |
|---|---|---|
| One FAQ save (`POST /portal/api/faqs`) | **1** | `routes.js:1979` → `faqService.createFaq:123` → `knowledgeService.createChunk:120` |
| One edit that **changes** text (`PATCH`) | **1** | `updateChunk:136` false → `:145` embeds → W4 |
| One edit that does **not** change text | **0** | `updateChunk:136` true → `:137-142`, `UPDATE … SET source` only (W3) |
| 101st FAQ (cap refusal) | **0** | `createFaq:120` throws **before** `createChunk` |
| `PATCH` with another tenant's id | **0** | `updateChunk:133-134` returns null before embedding |
| `DELETE` | **0** | `deleteChunk:156-163` |
| One `--kb-dir` document of *C* chunks | **C** | `storeChunks:22-23` |
| **100-FAQ bulk import** | **n/a — no such path exists** | `git grep -Ei "bulk\|importFaq\|csv\|batch"` over `src/portal/routes.js`, `src/modules/knowledge`, `public/portal/faqs.js` → **zero hits**. 100 FAQs = 100 separate POSTs = 100 calls, one per request |

**Ingestion is sequential, never batched.** `storeChunks:22-29` is a `for` loop with
`await embed(chunk)` then `await db.query(INSERT)` per chunk. Zero hits for `batchEmbedContents`
(Phase 1 §6.2). Each chunk pays a full round trip before the next begins.

### D.2 Q2-4 — state after a failure at chunk N of M

**Phase 1's reading is CONFIRMED, and the resulting state is worse than it stated.**

The code that determines it, verbatim (`knowledgeService.js:21-31`):

```js
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
```

`db.query` is `pool.query` (`db.js:34`) — no `BEGIN` anywhere, so **each INSERT is its own
autocommit transaction** and commits immediately and independently.

**The precise data state after a failure at chunk N of M:**

- rows 1..N−1 — **committed, permanent**;
- row N — absent (whether `embed` threw or the INSERT threw);
- rows N+1..M — never attempted;
- the exception propagates out of `storeChunks`.

**And on the retry it is not resumed.** `ingestKnowledge` (`provisioningService.js:144-152`)
catches, sets `result.failed`, and returns immediately. On a re-run the dedup at `:136-139` —

```sql
SELECT 1 FROM knowledge_chunks WHERE tenant_id = $1 AND source = $2 LIMIT 1
```

— matches the N−1 committed rows, because they carry `source = path.basename(file)`. So
`result.skipped.push(source); continue`. **The file is skipped, not resumed. Confirmed.**

**The consequences, which follow from there:**

1. The tenant permanently holds a **truncated document** — the first N−1 chunks of it.
2. There is **no marker** distinguishing truncated from complete. `source` is a filename; there is
   no status column, no expected-chunk-count, no completion flag (`schema.sql:289-301`).
3. Every later run reports it as success: `provision-tenant.js:145` prints
   `kb: skipped 1 already-ingested: <file>`.
4. **Both KB go-live gates still pass.** `checkKbPopulated` (`validationService.js:210-216`) needs
   `count(*) >= kbMin` (default **5**, `:360`) and `checkKbRetrieval` (`:218-225`) needs one chunk
   back for one hardcoded query. A truncated document with ≥5 chunks clears both. **Nothing
   between a half-ingested knowledge base and go-live notices.**

**NEW DIVERGENCE — D2-01. The CLI's own failure message is false, in the half an operator acts
on.** Filed in Phase 1 §5's format.

| ID | Claim (source file:line) | Runtime reality | Severity | Who is wrong |
|---|---|---|---|---|
| **D2-01** | `scripts/provision-tenant.js:147` — `✗ kb: ingest failed on '<file>': <error> — re-run resumes` | A re-run resumes the **directory** (files never attempted are ingested) but **abandons the file that failed** — R7's `source` dedup (`provisioningService.js:136-139`) matches its partial rows and skips it permanently. On that re-run `report.kb.failed` is then null, so `printNextSteps:63-64` prints **"3. Knowledge base ingested. Add more docs any time with `--kb-dir`."** | **MEDIUM** (today latent — 0 rows) | **The CLI text.** The operator is told to re-run, does so, is told the KB is ingested, and holds a silently truncated document. |

**And the two CLI paths fail in opposite directions.** `scripts/ingest-knowledge.js:20-26` has
**no dedup at all** — read file, `chunkText`, `storeChunks`, no `SELECT`. Re-running it after a
partial failure **duplicates** rows 1..N−1 rather than skipping them. Same function, same table,
two opposite retry semantics, neither documented at the shared call site.

### D.3 Is ingestion synchronous on a request path? Yes — and the worst case is unbounded

**Confirmed.** `POST /portal/api/faqs` (`routes.js:1971`) awaits `embed()` inline:
`routes.js:1979` → `faqService.createFaq:123` → `knowledgeService.createChunk:120`.

Sequence, with what bounds each step:

| # | Step | Bound |
|---|---|---|
| 1 | `getConfigForSession` | `statement_timeout` **5,000 ms** (`db.js:16-23`) |
| 2 | `validateFaqBody` / `normalize` | pure |
| 3 | `countFaqs` → R4 | 5,000 ms |
| 4 | **`embed(content)` → Google HTTP** | **none** |
| 5 | INSERT (W2) | 5,000 ms |
| 6 | `faqsPayload` (config + `listFaqs`) | 5,000 ms each |
| 7 | `readinessSnapshot` | 5,000 ms each |

**The three bounds that do not exist, each verified rather than assumed:**

1. **No client-side HTTP timeout on `embedContent` — VERIFIED at the SDK, upgrading Phase 1 §4's
   READ.** `embed` calls `embeddingModel.embedContent(request)` with no second argument when
   `signal` is null (`knowledgeService.js:17`). In `@google/generative-ai`,
   `embedContent(request, requestOptions = {})` merges `this._requestOptions` — which is empty,
   because `getGenerativeModel({ model })` is called with **one** argument at
   `knowledgeService.js:5`. The merged options then reach `buildFetchOptions`, which creates an
   `AbortController` **only** under this condition:

   ```js
   if (requestOptions?.signal !== undefined || requestOptions?.timeout >= 0) {
   ```

   With `{}`, `undefined !== undefined` is false and `undefined >= 0` is false, so
   `fetchOptions` is `{}` — **a bare `fetch` with no signal and no deadline.** There is no default.

2. **No server response timeout.** `git grep -Ei "setTimeout\(|requestTimeout|headersTimeout|server\.timeout|keepAliveTimeout"` over `server.js`, `src/portal`, `src/db` returns exactly two hits, neither on this path: a shutdown force-timer (`server.js:138`) and a login-failure delay (`routes.js:105`). Node's `server.timeout` default is 0 (disabled); `requestTimeout` bounds *receiving* a request, not producing a response.

3. **No `AbortSignal`.** Phase 1 §4 establishes `signal` reaches `embed` on exactly one of six
   entry points (voice-JSON). The portal is not it.

**Worst-case request duration: unbounded.** Not a hypothesis — there is no component on the path
capable of ending the request. The response is held for as long as Google holds the socket. The
owner's browser is the only actor that can give up, and `public/portal/faqs.js` sets no fetch
timeout either; the Save button stays disabled reading "Saving…" (`faqs.js:13`).

**Typical case, for contrast:** ~600–900 ms. That figure was **UNVERIFIED** when this section
was written — it is UI copy at `public/portal/faqs.js:13` (*"~0.6–0.9s measured against the live
embedding model"*), describing the ingestion side. Read verbatim that session; not reproduced.

> **UPDATE 2026-08-10 (RAG Session 2) — measured, and §D.3's headline finding is now FIXED.**
> Five instrumented calls through `embed()` itself: 2,555 ms cold, then 546 / 625 / 543 / 459 ms.
> The typical case above is broadly right for a *warm* process and silent about the cold one,
> which is 2.8× its ceiling. **Row 4 of the table above no longer reads `none`:** `embed` now
> carries a 3,000 ms client-side deadline (`EMBED_TIMEOUT_MS`), so "worst-case request duration:
> unbounded" is retired for every one of the six entry points, this one included. The deadline's
> derivation and the reason the zero-chunk prompt fix had to ship with it are in **D-010**.
> U-4 / U2-1 / U5-4 are closed with a stated residual.

### D.4 Q2-5 — does a whitespace-only edit re-embed? **No. Traced concretely.**

The round trip for `PATCH /portal/api/faqs/:id`, where the owner changes only whitespace:

1. `validateFaqBody` (`routes.js:1996` → `:2001`) produces `{question, answer, language}`.
2. `faqService.updateFaq:133` → `normalize:87-107`. **`:89-90` collapses `\s+` → `' '` and trims
   both halves**:
   ```js
   const q = typeof question === 'string' ? question.replace(/\s+/g, ' ').trim() : '';
   const a = typeof answer   === 'string' ? answer.replace(/\s+/g, ' ').trim()   : '';
   ```
3. `updateFaq:135` → `encode(question, answer)` (`:63`) rebuilds `` `Q: ${q}\nA: ${a}` `` **from
   the collapsed halves**.
4. `knowledgeService.updateChunk:132` → `getChunk` (`:133`) fetches `existing.content`, which was
   written by the *same* `encode`-after-`normalize` pipeline (`createFaq:123-126`).
5. `:136` — `content === existing.content`.

**Because both strings pass through the identical collapse-then-rebuild, a whitespace-only edit
produces a byte-identical string.** Double spaces, trailing spaces, tabs, and newlines all collapse
to the same single space before `encode` runs. So `:136` is **true** → the W3 branch
(`:137-142`) → `UPDATE … SET source` only → **0 embedding calls**, vector untouched.

Two adjacent cases traced while there:

- **Language-tag-only edit:** `content` identical, `source` changes → same W3 branch → **0 calls**,
  and `updated_at` still moves via `trg_knowledge_chunks_updated` (`schema.sql:303-304`), so
  R6's staleness signal fires correctly. This is exactly what the comment at
  `knowledgeService.js:129-131` claims, and it holds.
- **The comparison is encoded-vs-encoded**, not decoded-vs-decoded (`updateFaq:135` passes the
  `encode` output). So a change to `encode`'s format would make **every** stored row compare
  unequal and re-embed the entire corpus on the next edit of each. Recorded as a latent coupling.

### D.5 Cost — call count computed, rupee figure not invented

**No per-token price exists in this repository or in the envelope.** The only cost statement
anywhere, found by `git grep -Ei "per (1|million|1k|thousand) token|\$0\.|price per token|token price|embedding cost|per-token" -- docs src scripts`, is:

```
docs/specs/portal-v1-spec.md:97   (Embedding cost is per-save; acceptable at this scale.)
```

— which carries no number. **A rupee figure is therefore UNVERIFIED and none is imported from
memory.** What follows is the call count, which is fully derivable.

**Assumption stated up front, because §D.5 requires it:** an **edit rate of 3 text-changing edits
per FAQ over a tenant's life** (initial authoring churn plus later corrections). Nothing in the
repository evidences this; it is deliberately generous, and the conclusion below is insensitive to
it.

**FAQ half** — the only half with a hard cap:

```
MAX_FAQS = 100 per tenant                          faqService.js:39, enforced createFaq:120
1 create = 1 call                                  knowledgeService.js:120
1 text-changing edit = 1 call                      knowledgeService.js:145
edits that change nothing = 0 calls                knowledgeService.js:136-142

per tenant   = 100 × (1 create + 3 edits)          = 400 calls
10 tenants   = 400 × 10                            = 4,000 calls
```

**Document half** — envelope gives 150 typical / 250 ceiling chunks per tenant; the FAQ half caps
at 100, leaving ~50 typical / ~150 ceiling document chunks:

```
1 chunk = 1 call                                   knowledgeService.js:23 (sequential)
re-run of an already-ingested file = 0 calls       provisioningService.js:136-143 (dedup)
assume one full corpus revision over the life      → ×2

per tenant   = 150 (ceiling) × 2                   = 300 calls
10 tenants   = 300 × 10                            = 3,000 calls
```

**Total ingestion embedding calls, ever, across the whole company at G-TEN: ≈ 7,000.**
That is **700 per clinic, for the lifetime of the clinic** — not per month.

**Sizing it without a price.** Against the ₹4,999/clinic/month ceiling:

```
1% of ONE month's revenue                  = ₹49.99
₹49.99 ÷ 700 lifetime calls                = ₹0.0714 per call
```

So a **single embedding call would have to cost more than about 7 paise** before the *entire
lifetime* ingestion embedding spend for a clinic reached 1% of *one* month's revenue. An
embedding call on this path carries at most ~500 characters (`chunkText` `maxLen`) or ~1,000
characters (`MAX_QUESTION` 200 + `MAX_ANSWER` 800 + the `Q:`/`A:` framing) — a few hundred tokens.
No plausible per-token price puts a few-hundred-token call above 7 paise.

**Conclusion, stated as instructed: the count is ~7,000 lifetime calls, and it is small enough
that the rupee figure is irrelevant at any plausible price. Every cost-driven *ingestion*
optimisation is therefore marked E on that basis** — batch embedding, async ingestion queues, and
call-count reduction generally.

**One contrast, to keep the number honest about where cost actually lives.** The retrieval side is
`[P4]`'s (Q4-7), quoted here only for scale: 200 retrievals/day/tenant × 10 tenants × 30 days =
**60,000 embedding calls per month, recurring** (Phase 1 §1, one `embed()` per turn at
`knowledgeService.js:34`). The **entire lifetime ingestion budget is ~12% of one month of
retrieval.** Ingestion is not where embedding cost lives, and optimising it cannot matter.

**Where the ingestion path does cost something real is latency on a request, not rupees** — §D.3.
That is a UX and availability finding, and it is not bought off by any of the E verdicts above.

---

## E. VERDICTS

Default is **E**. **C** requires a number showing a defect demonstrable at *current* scale
(0 tenants, 0 chunks — `state.md:36-40`). **D** requires a named numeric trigger.

Sizing note carried from §A.4: the chunker is CLI-only and touches zero request-path rows, but
`provision-tenant.js:62` prints it as step 3 of the onboarding runbook. Chunking findings are
therefore **latent, not vacuous**, and their trigger is a **row count of 1**, not a scale
threshold. That is why several are D rather than C or E.

| Technique | Verdict | Justifying number | file:line |
|---|---|---|---|
| **Semantic chunking** | **E** | Measured: on realistic prose the existing splitter already emits one chunk per paragraph at 257–356 chars (§A.2 b, 7 paragraphs → 7 chunks) — near what semantic splitting targets. It would cost extra embedding calls per document to improve ≤150 of ~150 chunks/tenant on a path with **0 request-path rows**. | `knowledgeService.js:48-68`; envelope |
| **Structural / markdown-aware chunking** | **D** — flips to **C** at the first `--kb-dir` document with headings or without blank lines | Measured: (d) 620 chars → **1 chunk** (124% of `maxLen`); (h) every chunk ends with a heading for a topic it does not contain. `provisioningService.js:130` ingests `*.md`. Today **0 such rows**. | `knowledgeService.js:49`; `provisioningService.js:130,146` |
| **Recursive splitting** (paragraph → sentence → word) | **D** — flips to **C** at the first `--kb-dir` document paragraph >`maxLen` | Measured: (c) 741 chars = **148% of `maxLen`** emitted whole; (g) chunk[1] = 525. `maxLen` bounds nothing today. At `topK=3` and no per-chunk cap, three oversized chunks enter the system instruction whole. Today **0 such rows**. | `knowledgeService.js:57-60`; `aiService.js:568` |
| **Contextual chunk headers** | **D** — flips to **C** at the first production tenant holding any `source != 'faq'` chunk | The slot is already occupied by something worse: `current.slice(-50)` prepends a mid-word fragment of a *different* topic (5 of 6 measured in §A.2 b), embedded **and** rendered verbatim to the model. Today **0 document chunks** (Phase 1 U-8). | `knowledgeService.js:60`; `aiService.js:568` |
| **Parent-document retrieval** | **E** | A whole tenant corpus is ~150 chunks × ~300 chars ≈ 45,000 chars, and `topK=3` selects from ~150 candidates. There is no context pressure for parent-lookup machinery to relieve. | envelope; `knowledgeService.js:33` |
| **Sentence-window retrieval** | **E** | FAQ rows are self-contained Q/A pairs capped at `MAX_ANSWER = 800`; **100 of ~150 chunks/tenant have no window to widen** — they are already the whole answer. | `faqService.js:41,63` |
| **Metadata enrichment at ingest** | **E** as scoped | **R1 reads 3 columns and filters on 1.** Any field added at write time is invisible to the only retrieval query in the repository, so enrichment alone buys exactly **0**. The retrieval-side change is `[P4]`'s. | `knowledgeService.js:38-42` |
| **Batch embedding** | **E** | **~7,000 ingestion calls ever, across all 10 clinics** (§D.5) vs. 60,000/month on the retrieval side. Batching applies only to `storeChunks`' loop — the portal path is 1 call per request, with nothing to batch. | `knowledgeService.js:22-29`; §D.5 |
| **Async ingestion queue** | **E** | The owner-facing path it would relieve is capped at **`MAX_FAQS = 100` saves per tenant, ever**. A job table + worker to move 100 lifetime operations off-request costs more than it returns; the unbounded-duration problem in §D.3 is a missing timeout, not a missing queue. | `faqService.js:39`; `routes.js:1979` |
| **Embedding model change** | **E** | Model, requested dimensionality and column agree at **768** (§C.1, verified). No relevance defect is demonstrable — **0 production queries, 0 transcripts, 0 eval fixtures**. Changing on no evidence, at a cost of 1,500–2,500 re-embeds at G-TEN, is unjustifiable. | `knowledgeService.js:5,13`; `schema.sql:293` |
| **Task-type embeddings** | **D** — see the trigger caveat | Cost curve, not a defect: **0 rows to re-embed today → 1,500 typical / 2,500 ceiling at 10 clinics**, plus a backfill tool that does not exist. Both sides are self-consistently symmetric today (§C.3), so nothing is broken. **The trigger is honest about its own limits: this flips to C only when an eval set demonstrates a relevance gap — and the numeric fact that matters is that the *decision cost* is 0 now and rises monotonically.** | `knowledgeService.js:11-14`; `state.md:36-40`; envelope |
| **Per-language embedding strategy** | **D** — flips to **C** at the first tenant with ≥2 enabled languages and ≥1 FAQ authored in both | At that point `topK = 3` loses **≥1 of 3 slots (33%)** to a translation of the same answer, because R1 neither selects nor filters `source` (§B.3). The tag needed to prevent it is already written. Ingestion-side verdict only; the retrieval predicate is `[P4]`'s. | `faqService.js:51-53`; `knowledgeService.js:38-42` |

---

## OPEN QUESTIONS

**`[P3]` Storage, index & query execution**

- **Q2-P3-a** — `embedding` is nullable with no `CHECK` (`schema.sql:293`). No write path can
  produce NULL today (W1/W2/W4 always supply it; W3 cannot null an existing vector). Forwarded per
  instruction; R1's behaviour on such a row is Phase 1 Q3-2's.
- **Q2-P3-b** — `storeChunks` issues one autocommit INSERT per chunk (`:24-28`) with no
  transaction and no batching. At a 150-chunk document that is 150 round trips against the pool
  `db.js:21-27`. Interacts with Phase 1 Q3-5's pool-contention question.

**`[P4]` Retrieval quality, context, token & cost**

- **Q2-P4-a** — The `faq:<lang>` tag is written, round-trips to the owner's form, and gates
  `MAX_FAQS`, but is invisible to R1 (§B.3). Whether retrieval should filter or boost on it, and
  whether that changes the `topK = 3` slot arithmetic, is Phase 4's.
- **Q2-P4-b** — **Transliterated and code-mixed input.** Nothing in ingestion normalizes Unicode,
  detects script, or handles romanised Telugu (§C.4). Whether `gemini-embedding-001` places
  "meeru ela unnaru" near native-script Telugu is **not answerable from this repository** and is
  flagged, not speculated on. Needs production queries or an eval set.
- **Q2-P4-c** — §A.5's Q+A-vs-answer-only question is undecidable without an eval set. Phase 4
  should record whether building one is in scope, since three findings now depend on it.
- **Q2-P4-d** — The overlap fragment (`current.slice(-50)`) is embedded **and** rendered verbatim
  into the system instruction as `- ${c.content}` (`aiService.js:568`), so a retrieved document
  chunk shows the model a truncated word from an unrelated topic. Sizing the prompt-quality cost
  belongs with Q4-2/Q4-6.
- **Q2-P4-e** — §D.3 establishes the portal FAQ save has **no bound of any kind**. The same
  missing bound applies to the WhatsApp and voice-SSE retrieval calls (Phase 1 §4, Q4-5). One
  finding, three surfaces.

**`[P5]` Tenant isolation**

- **Q2-P5-a** — §B.5: document chunks are unreachable from every owner surface (`listFaqs` filters
  them out), so they can be removed only by `psql` or the `ON DELETE CASCADE`. That is a data-
  lifecycle gap with an isolation flavour — a tenant cannot delete its own data through any
  product surface.

**`[P6]` Decisions**

- **Q2-P6-a** — **D2-01** (§D.2): `provision-tenant.js:147` tells the operator "re-run resumes"
  when a re-run abandons the failed file permanently, and the next run then reports the KB as
  ingested. Filed, not fixed.
- **Q2-P6-b** — Two CLI paths into `storeChunks` have **opposite** retry semantics (skip vs.
  duplicate) and two different `source` conventions (basename vs. full path). §B.2 conventions
  3 and 4; §D.2.
- **Q2-P6-c** — The task-type cost curve (§C.3): 0 rows today, 1,500–2,500 at G-TEN, no backfill
  tool. Recorded as a cost curve; Phase 6 decides.

---

## UNVERIFIED

| ID | What could not be established | What would establish it |
|---|---|---|
| **U2-1** | ~~**Actual embedding latency from this codebase.** The 600–900 ms figure is UI copy at `public/portal/faqs.js:13`, read verbatim this session but **not reproduced**. Carrying Phase 1 U-4 forward unchanged; no API call was made.~~ **CLOSED 2026-08-10 (RAG Session 2)** with U-4 — see `01-map.md` §8 U-4 for the five measurements and the verdict. For §D.3's purposes the relevant figure is the **cold** one: 2,555 ms, paid by the portal FAQ save on the first embedding of a fresh process. The unbounded-duration finding in §D.3 is now fixed, not merely sized — `embed` carries a 3,000 ms deadline (**D-010**). ⚠️ Residual: 5 samples is not a distribution. | ~~One instrumented call, or Phase 4 §D.~~ For the residual: production-region samples after Issue 20. |
| **U2-2** | **Whether Q+A concatenation embeds better or worse than answer-only** (§A.5). Requires an eval set of (query → expected chunk) pairs. **None exists** — every test stubs `getRelevantChunks`; there are 0 production queries and 0 transcripts. | Build an eval set, or wait for production traffic. |
| **U2-3** | **The relevance cost of omitting `taskType`** (§C.3). Same blocker as U2-2, plus: `checkKbRetrieval` is a topK-1 smoke test and structurally cannot measure relevance. | Same as U2-2. |
| **U2-4** | **Whether transliterated/code-mixed Telugu retrieves against native-script chunks** (§C.4). Not answerable from the repository. | Production queries, or an eval set with romanised variants. |
| **U2-5** | **Real per-token embedding price.** Absent from the repository and the envelope; the only cost statement (`portal-v1-spec.md:97`) carries no number. **No remembered price was imported.** §D.5's conclusion is deliberately price-*insensitive* — it names the ~7 paise/call threshold instead. | A pricing source outside this repository. |
| **U2-6** | **Whether any real clinic document actually exhibits (d)'s no-blank-line shape or (g)'s title precondition.** Both were reproduced on constructed input matching the `*.md`/`*.txt` format `--kb-dir` reads; **no real customer document exists to test** (0 tenants). | Customer #1's KB directory. |
| **U2-7** | **`gemini-embedding-001`'s default `taskType` when none is sent.** Not observable from the SDK source (the field is simply absent from the request). Does not affect §C.3's conclusion, which rests on both sides being the *same call*. | Provider documentation, or two instrumented calls. |

Phase 1 §8 **U-5** was **out of scope** this phase and was not investigated. **U-6 is now CLOSED**
by §A.2. U-1, U-2, U-3, U-7, U-8, U-9 are untouched and remain Phase 3/4's.

---

## PHASE 1 QUESTION DISPOSITION — Q2-1 … Q2-6

Every one is explicitly marked.

| ID | Status | Detail |
|---|---|---|
| **Q2-1** | **CLOSED** | §A.4. Phase 1's answer confirmed at HEAD — the chunker touches zero request-path rows — **and amended**: `provision-tenant.js:62` prints `--kb-dir` as step 3 of the onboarding runbook, so the chunker is on the customer-#1 path even though it is on no request path. Chunking findings are **latent, not vacuous**; their trigger is a row count of 1. All chunking verdicts in §E are sized on this. |
| **Q2-2** | **CLOSED** — as a question about what is decidable | §A.5. The concatenation **is** in the vector (verified). The relevance comparison is **undecidable without an eval set that does not exist**, stated plainly rather than guessed. The decidable and load-bearing finding: answer-only embedding is a **schema change**, not a tuning change, because `content` is simultaneously the embedded text and the text shown to the model. The relevance half is carried forward as **U2-2**. |
| **Q2-3** | **CLOSED** | §C.3. The code sets no `taskType`; both sides are symmetric **by construction** (same function — §C.2), not by coincidence. Relevance cost recorded as **unmeasurable without production queries** (U2-3). Decision-timing property recorded as a number: **0 rows today → 1,500 typical / 2,500 ceiling at 10 clinics**, no backfill tool exists. No change recommended, per instruction. |
| **Q2-4** | **CLOSED** | §D.2. Phase 1's reading **CONFIRMED**: partially-ingested files are skipped, not resumed. State stated precisely (rows 1..N−1 committed and permanent, no completion marker, reported as success, **both KB go-live gates still pass**). Produced one new divergence, **D2-01**, and one new finding: the two CLI paths have opposite retry semantics. |
| **Q2-5** | **CLOSED** | §D.4. Traced concretely: a whitespace-only edit **does not re-embed**. `normalize:89-90` collapses `\s+` on both halves before `encode:63` rebuilds, and the stored row went through the same pipeline, so `updateChunk:136` compares byte-identical strings → W3 branch → **0 embedding calls**. Language-tag-only edits likewise cost 0 and still move `updated_at` via the trigger. |
| **Q2-6** | **CLOSED** | §B.3. Classification: **unrealised, not dead weight.** The tag is inert at retrieval (R1 neither selects nor filters `source`) but load-bearing at write — it is inside the `MAX_FAQS` predicate and round-trips to the owner's edit form. The structural consequence for Phase 4 is named: at `topK = 3`, one question answered in three languages can consume all three slots. |

**All six are CLOSED. None remains open.** Two carry residue into the UNVERIFIED table (Q2-2 →
U2-2, Q2-3 → U2-3) because their remaining halves need an eval set or production traffic that does
not exist — the questions themselves are answered as far as this repository can answer them.

---

## DEFINITION OF DONE

- **Artifact:** this file, `docs/os/audits/rag/02-ingestion.md`. ✅
- **`npm test`:** `# tests 989 / # suites 160 / # pass 989 / # fail 0` — unchanged vs
  `docs/os/state.md:69` and Phase 1. Pasted verbatim in the header. ✅
- **No test added, edited, or deleted.** No source, schema, migration, config, or dependency
  touched. No database written. No embedding API call made. ✅
- **Every verdict in §E carries a number or is marked E with one.** ✅
- **Every one of Q2-1 … Q2-6 explicitly marked CLOSED.** ✅
- **`git status --porcelain` at session end**, verbatim:

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
  ```

  The only entries are the three pre-existing untracked markdown files enumerated at Phase 0 and
  this phase's own artifact. `git diff --name-only HEAD` returns **empty** — **zero modified
  tracked files**. ✅
