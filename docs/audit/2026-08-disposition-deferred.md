# `conversations.disposition` — proposed, declined, deferred

**Status:** DECLINED at `7180738`. No migration written, no `schema.sql` change,
no column exists.
**Supersedes:** nothing. **Superseded by:** nothing yet.
**Source proposal:** `docs/audit/2026-08-conversation-model.md` §8/P-3, §9/M-3,
§9/A-3, §10 Phase 1.
**What shipped instead:** `conversationService.deriveDisposition` and
`conversationService.findDispositionDisagreements`, proved by
`tests/conversation/dispositionDerivation.integration.test.js`.

This entry exists so that the next session to reach for this column reads the
argument before rewriting it, and so that the conditions for revisiting are
written down rather than remembered.

---

## 1. What P-3 proposed

```sql
ALTER TABLE conversations
  ADD COLUMN disposition TEXT NOT NULL DEFAULT 'open'
    CHECK (disposition IN ('open', 'handled', 'needs_staff', 'booked'));

CREATE INDEX idx_conversations_tenant_disposition_updated
  ON conversations(tenant_id, disposition, updated_at DESC, id DESC);
```

> Strictly a materialised read of the latest `conversation_events` row.
> `conversation_events` is the truth; this column is what makes the Inbox's
> "Needs staff" filter one index scan instead of a correlated subquery.

Maintenance, per §9/A-3, is **application code**: *"Maintain
`conversations.disposition` from A-2's events, one shared helper"*, sized **S**.
Not a trigger and not a cron — §8's write table says "one shared helper, called
from both" channels. The proposal is sound in shape. What follows is about
whether it can be **correct** yet.

---

## 2. The three vocabularies, and their disagreement

This is the finding that decided it.

| Source | Vocabulary | Count |
|---|---|---|
| `public/demo/inbox.json` — the **only** surface that has ever rendered this field | `handled`, `needs_staff` | **2** |
| Emittable from `src/` today | `handled` | **1** |
| P-3's proposed CHECK | `open`, `handled`, `needs_staff`, `booked` | **4** |

Three vocabularies, no two the same. P-3's four values are not derived from the
demo, from the code, or from data. `open` is an artifact of needing a `DEFAULT`.
`booked` appears in no design and no emitter anywhere.

### 2.1 What any code can emit today

`recordEvent` (`src/modules/conversation/conversationService.js`) is the only
writer of `conversation_events`, and it has exactly three call sites in `src/`.
Every one passes the same literal.

| P-3 value | Emitter | Cite |
|---|---|---|
| `open` | **no event exists** — it is the value when the latest-event read finds nothing | — |
| `handled` | **yes, both channels** | `whatsapp/routes.js:266`; `internalVoice.js:288` (JSON), `:546` (SSE) |
| `needs_staff` | **ABSENT** | would derive from an `escalated` event; nothing emits one. `ownerCommands.js` calls `setMode` (`:68`, `:91`, `:180`) and writes `handoff_sessions`, and emits **zero** conversation_events. §9/A-2: escalation "needs the AI to have *any* escalation signal, which today it does not" |
| `booked` | **ABSENT** | requires widening `bookAppointment`'s signature; ruled out of M-2, belongs to M-4 |

One of four is emittable. And `open` already breaks P-3's own sentence: the
column cannot be *"strictly a materialised read of the latest
`conversation_events` row"* when its most common value is what you get from the
**absence** of one.

### 2.2 `booked` is the wrong SHAPE, not merely early

`public/demo/inbox.json:8-18`, the one **real captured patient**:

```json
{ "id": "sravani", "name": "Sravani Reddy", "channel": "voice", "language": "Telugu",
  "status": "handled",
  "snippet": "Booked with Dr. Rao — Sat 18 Jul, 9:00 AM",
  "real": true }
```

**She booked. Her status is `handled`.** The booking lives in the snippet; it is
not a disposition. §6.2's Inbox status column is `handled | needs_staff` and
nothing else, and §6.1 puts booking on a separate card sourced from
`appointments.booked_by` (M-4).

`booked` and `handled` are **not on the same axis**. A single-valued column
holding both encodes a precedence rule nobody has decided — and on the only
evidence that exists, the rule P-3 implies (`booked` wins) is *wrong*: it renders
Sravani as `booked` where the design of record renders her `handled`.

Migration 029's header names this failure and calls it the expensive direction:

> The expensive direction is different in kind. It is discovering that a value
> already written into the CHECK is the wrong SHAPE — needs splitting, merging
> or renaming — because then live rows violate the replacement and the
> constraint swap needs a data backfill inside it.

Widening a CHECK costs one `DROP`/`ADD CONSTRAINT` (migrations 007 and 025 are
each nothing else). Reshaping one costs a backfill inside the swap. P-3 asks for
the second, one migration after 029 argued against exactly this guess.

---

## 3. A CHECK on `disposition` can destroy `conversation_events` rows

The mechanical argument, and it is independent of the vocabulary one.

For the column to be trustworthy the maintenance write must be **atomic** with
the event insert — otherwise a crash between them leaves the cache wrong with
nothing to detect it. Atomicity is easy (one CTE; `recordEvent` is already a
single statement). Compose that with 029's central decision and the constraint
turns into a gate on the truth log:

- `conversation_events.type` is an **open set**. That is load-bearing, asserted
  in `tests/db/conversationEvents.test.js:172-178` and exercised live at
  `tests/conversation/conversationEvents.integration.test.js:377`, which inserts
  `type: 'escalated'` **today** and passes.
- Atomic maintenance + a `type` outside `disposition`'s CHECK domain ⇒ **23514 on
  the UPDATE rolls back the INSERT.** The event is gone.
- Both emitters wrap `recordEvent` in `try/catch` and only `logger.error`
  (`whatsapp/routes.js:269-273`, `internalVoice.js:291`, `:549`). So it is gone
  **silently**.

029's strongest claim — *"the day the escalation signal exists, `escalated` is an
INSERT, not a migration"* — would invert into: the day the escalation signal
exists, the first `escalated` event is silently discarded.

The escape is a helper that leaves `disposition` alone for unmapped types. But
then the helper is already the gate, and the CHECK's only remaining job is
catching a bug in the helper's own mapping table — which a unit test does for
free, without holding a rollback hazard over the event log.

**This applies to P-3's CHECK as drawn and to any narrowed version of it.**

---

## 4. The TAKEOVER gap — consistent with the log, still wrong

The column can be perfectly consistent with `conversation_events` and still be
wrong about the only thing the Inbox filter exists to show.

`ownerCommands.js` TAKEOVER does two things (`:91`, `:98-104`): `setMode(…,
'human')` and open a `handoff_sessions` row. It emits **no** conversation_event.
And the mode gate in `whatsapp/routes.js:160-178` returns *before* the emitter,
so no subsequent turn on that thread emits one either. Both are deliberate —
`handled` on a human turn would be a false claim, which
`conversationEvents.integration.test.js:320-322` asserts in those words.

Consequence: **a thread a human is actively working derives `handled`**, so the
materialised column would hold `'handled'`, and the "Needs staff" filter — the
one filter that carries the product's value proposition — would not show it.

This is asserted as a live, failing-by-design demonstration, not described:

> `tests/conversation/dispositionDerivation.integration.test.js`
> — *"⚠️ WRONG-BY-DESIGN: after TAKEOVER the thread derives `handled` while a
> human works it"*

It asserts the **current, wrong** behaviour on purpose. When A-2 lands and
`ownerCommands.js` emits on the TAKEOVER branch, that test **must fail**. The
failure is the signal that this defect is closed — not a regression. Verified by
falsification: adding an `escalated` emission to the fixture's `takeover()`
turns it red (2 tests red, 11 green), so it is not vacuous.

Two lesser paths in the same family:

- `persistPartialOutbound` (barge-in / hangup, `internalVoice.js:535-539`)
  deliberately emits nothing, so an interrupted turn leaves the previous
  disposition standing.
- Direct SQL — a test, a script, a `psql` session — leaves the cache stale with
  nothing to detect it.

---

## 5. No reader exists

Swept `src/`, `tests/`, `scripts/`, `public/`, `web/`: **zero** references to
`conversations.disposition`. The only `disposition` identifiers in the repo are
unrelated locals — the return of `classifySendError` in
`collectionsCron.js:153-169` and `reminderCron.js:203-219`.

The only `needs_staff` in the product is `public/demo/` (`inbox.html:42`,
`inbox.js:54,108,141`, `inbox.json:42,78`) — a fixture-driven sales demo reading
`inbox.json`, not the database.

The reader is **A-5** (`GET /portal/api/conversations`), audit §10 **Phase 3**.
Two phases out.

**The index itself is fine — that was checked, not assumed.** On a throwaway
scratch DB with the column and index added and 2000 `ANALYZE`d rows:

```
Limit  (cost=0.28..4.69 rows=26 width=24)
  ->  Index Only Scan using idx_conversations_tenant_disposition_updated on conversations c
        Index Cond: ((tenant_id = '…000') AND (disposition = 'needs_staff'::text))
```

Index Only Scan, no Sort node, `WHERE` and `ORDER BY` served together, exactly as
P-3 claims. It also does **not** displace `idx_conversations_tenant_updated` for
the Issue 26 list query that `provisioning.integration.test.js:111-126` pins
(checked at 0 rows and at 2000 `ANALYZE`d rows, `enable_seqscan=off`: still an
Index Only Scan on the old index, still no Sort). **The index is not the
problem.** It simply has no query to serve, and `needs_staff` — the one filter it
exists for — would match zero rows on every tenant until escalation ships.

---

## 6. What shipped instead

`conversationService.deriveDisposition(tenantId, conversationId)` — the read a
column would have served, computed on demand. Four returns, none collapsing into
another:

| Return | Meaning |
|---|---|
| `undefined` | the conversation is not visible to this tenant — foreign, or no such id. Same shape as `recordEvent`'s `undefined` and `getParticipatingChannels`' `[]`, and indistinguishable between the two cases |
| `'open'` | visible, **zero** events |
| `'handled'` | the latest event is `handled` |
| `null` | events exist and the latest is of a type this function will not name a disposition for |

**Why an unmapped type returns `null`:** not `'open'`, which would claim no
outcome was recorded when one was — the most dangerous wrong answer because it is
indistinguishable from the honest empty case. Not `'unknown'`, which invents a
disposition value and is lossy. And **not the raw type**: pass-through is
tempting because it mirrors 029's migration-free property one layer up, but it
returns EVENT vocabulary where a DISPOSITION is expected, so the first caller to
filter on `'escalated'` would have settled the deferred vocabulary question by
accident, in code.

The mapping is one frozen object, `EVENT_TYPE_TO_DISPOSITION = { handled:
'handled' }`. Note what is deliberately **not** in it: `escalated →
needs_staff`. That looks obvious and is precisely the guess being avoided —
`escalated` is an event, `needs_staff` is a disposition, and deciding they are
the same is A-2's call against real rows.

`conversationService.findDispositionDisagreements(tenantId)` — the
reconciliation oracle, and the reason deferring is not "do nothing". A
materialised column is a cache with one in-process writer, and a cache is only as
good as the query that can prove it has not drifted. **That query has to exist
before the column does**, or the column ships with drift assumed absent rather
than shown absent. With no column to compare against, drift is expressed against
the signals that ought to agree: `conversations.mode` and an open
`handoff_sessions` row. It reports three findings —
`mode_human_but_derived_<x>`, `open_handoff_but_derived_<x>`, and
`uninterpretable_latest_type` — and takes the same frozen mapping into SQL as
`jsonb` so the derivation and the oracle cannot drift apart.

Both are tenant-scoped structurally, as `recordEvent` is: `conversations` is the
`FROM`, and the events and handoff rows are joined on the `tenant_id` read off
**that row**, never on the caller's argument.

**Neither has a caller in `src/`.** This is the read and its proof, not a
surface.

---

## 7. Two things found along the way, worth carrying forward

**`conversation_events` has no monotonic sequence.** `created_at` defaults to
`NOW()`, which is *transaction* start time, so two events written in one
transaction share it exactly. `deriveDisposition` breaks the tie with `id DESC`,
which is **deterministic** — the same query returns the same row every time — but
`id` is a random `gen_random_uuid()`, so among simultaneous events the winner is
arbitrary rather than chronological. Nothing writes two events in one transaction
today, so this is latent. Anyone deriving "latest" from this table, or adding a
second emission to an existing transaction, inherits it.

**`'open'` is honest as a derivation and misleading as a product statement.**
`a550e900` on the dev database is a real, fully-conducted 115-message thread
(112 voice / 3 WhatsApp) that predates migration 029. It has zero events and
derives `'open'`. That is correct — no outcome was *recorded* — and it would be a
bad thing to render in an Inbox, which is a third reason the column is not ready.
Every historical thread reads `'open'` and no backfill can fix it, because the
events were never captured.

---

## 8. The precondition for revisiting

Both must hold. Neither is a matter of opinion.

1. **A settled vocabulary, from A-2 and from rows.** Escalation must exist and be
   emitting, so `needs_staff` has a producer and a meaning rather than a guess.
   The query that settles it is 029's own:
   `SELECT type, COUNT(*) FROM conversation_events GROUP BY type;`
   The `booked`-vs-`handled` axis question (§2.2) must be answered explicitly,
   not inherited from P-3.
2. **A reader.** A-5 / the Inbox, actually being built. An index whose filter
   matches zero rows on every tenant is not an optimisation.

When both hold, the column is a small migration and the oracle above is already
there to prove the cache correct. Until then the derivation is the read, and it
costs one index scan of `idx_conversation_events_conversation` per thread.

**What would change this ruling:** a reader that measurably cannot afford the
derivation. That is a performance finding with numbers attached, not a
sequencing argument — and if it arrives before the vocabulary settles, the column
should ship **unconstrained**, mirroring `conversation_events.type`, never with
P-3's CHECK.

---

## 9. Numbering note

Migration **030 was not taken.** `src/db/migrations/` ends at
`029_conversation_events.sql` and the next free number remains 030.

The audit's §9 table labels are **not filenames** and have not been for two
migrations. Current mapping:

| Audit label | Reality |
|---|---|
| M-1 `028_message_language.sql` | **not written.** `028` is `028_rename_conversations_origin_channel.sql`, which the audit did not contemplate |
| M-2 `029_conversation_events.sql` | **landed** as `029_conversation_events.sql` — label and filename coincide by luck |
| M-3 `030_conversation_disposition.sql` | **DECLINED — this document.** No file |
| M-4 `031_appointment_provenance.sql` | not written |
| M-5 `032_conversation_read_indexes.sql` | not written |

Read the labels as identifiers for the *work*, and the filenames in
`src/db/migrations/` as the only authority on what exists.
