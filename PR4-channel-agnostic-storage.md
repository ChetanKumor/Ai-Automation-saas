# Zyon V2 — Channel-Agnostic Storage (spec PR4, migrations 016–017)

> Implementation package. Staff → Senior handoff. Read fully before coding.
> Source of truth: `ZYON_V2_SPEC.md` (Phase 3 Memory boundary, Phase 5 timeline, Phase 7 migrations 013–014, Phase 8 PR4). Evolution, not a rewrite.
> **Migration offset:** spec migration 013 → your **016**, spec 014 → your **017** (your head is 015 after identity). The spec's `wamid`-drop (013-spec-017) → your **~020**, and it is **PR8, not this PR**.

---

## 0. Deferred-deploy safety (read first)

You're developing locally and batching the production deploy. PR4 is the first **expand-contract** sequence, so two rules must survive the batched deploy:

1. **Expand before contract, across deploys.** PR4 is the *expand* half only: it adds `external_id`, backfills it from `wamid`, and dual-writes both. It does **not** drop the `wamid` column. The *contract* (drop `wamid` column) is PR8 / migration ~020. When you eventually batch-deploy, the expand migrations and the dual-writing code must be live and verified in production **before** the contract migration is ever applied. Do not let a batched deploy collapse expand and contract into one step — that is where dedup breaks and messages get lost.
2. **PR4 itself is safe to apply locally and deploy later.** Everything here is additive columns (defaulted), a backfill, and a constraint *relocation* that preserves the same dedup guarantee. Rollback is drop-new-columns + revert code. Nothing here is destructive.

So: build and apply 016/017 locally now. Just keep the wamid **column** drop quarantined to PR8 with its own production verification window.

---

## 1. PR Objective

Make conversations and messages channel-agnostic so the same storage serves WhatsApp, Voice, SMS, Email, and Instagram: add a `channel` dimension, record message `direction`, store non-text messages (type + media reference), and begin the `wamid → external_id` rename via expand-contract — without weakening idempotency and without dropping `wamid`.

---

## 2. Why This PR Exists

Today, message storage is implicitly WhatsApp-shaped: dedup keys on `wamid`, only text is stored, there's no channel or direction. Voice (PR6/7) will write `call_sessions` and message rows for the same customer; the channel abstraction (PR5) normalizes every adapter into a common envelope. Both need a storage layer that is not WhatsApp-specific. This PR generalizes the existing tables so the unified timeline (Phase 5) — all messages across all channels under one `customer_id` — becomes representable, while the live WhatsApp flow keeps working byte-for-byte.

It builds directly on PR3: messages attach to the `customer_id` that identity resolution returns.

---

## 3. Scope

1. **Migration 016** — `conversations`: add `channel` (default `'whatsapp'`); fix the partial unique to `(tenant_id, customer_id) WHERE status='open'`.
2. **Migration 017** — `messages`: add `channel` (default `'whatsapp'`), `direction`, `external_id` (backfill = `wamid`), `message_type` (default `'text'`), `media_ref`; **relocate** the dedup unique to `(tenant_id, channel, external_id) WHERE external_id IS NOT NULL`; keep the `wamid` column, dual-written.
3. **`conversationService`** — channel-aware: `getOpenConversation(tenantId, customerId, channel)`; persist `channel`.
4. **`webhookController` / WA write path** — on inbound and outbound: set `channel`, `direction`, dual-write `external_id` + `wamid`, set `message_type`, store `media_ref` for non-text; idempotent insert now targets the new constraint.
5. **`schema.sql`** — fresh-install DDL updated in lockstep.
6. **Tests** — non-text storage, dual-write, relocated idempotency, direction backfill, channel default, partial-unique behavior.

---

## 4. Out of Scope

- **Dropping the `wamid` column** (PR8 / ~020). This PR keeps it and dual-writes.
- `call_sessions`, any voice code (PR6).
- The `ChannelAdapter` interface/registry (PR5) — this PR still writes through the existing WhatsApp controller; it just writes channel-aware rows.
- `customer_memory` / write-back (PR8).
- Downloading or storing media binaries. Store the provider **media reference** (e.g. WA media id) only; fetching/persisting the actual file is a later concern.
- Any change to identity resolution (PR3) beyond consuming the `customer_id` it returns.
- The two tracked app bugs (Gemini model-role, extraction JSON).
- The `customers.phone` NOT NULL change (tracked separately, triggered by first non-phone channel — **not** here; PR4 does not touch `customers`).

---

## 5. The idempotency relocation (reviewer: read this)

The standing invariant is "never weaken `wamid` dedup." This PR **relocates** that dedup; it does not remove it. Be explicit so the review doesn't (correctly) block:

- Today: a unique constraint on `wamid` + `ON CONFLICT DO NOTHING` gives exactly-once message insertion.
- After 017: dedup authority moves to `(tenant_id, channel, external_id) WHERE external_id IS NOT NULL`. For WhatsApp, `external_id = wamid`, so this enforces the **same** guarantee, now tenant- and channel-scoped (strictly stronger). The `wamid` **column** stays and is dual-written; only its **unique constraint** is dropped (because two unique constraints on the same logical key would make `ON CONFLICT` raise on the untargeted one).
- The insert's `ON CONFLICT` target changes from the `wamid` constraint to the new constraint. Idempotency is preserved end-to-end; verify with a duplicate-delivery test.

`external_id` is nullable (not every message has a provider id); the partial `WHERE external_id IS NOT NULL` mirrors the prior null-`wamid` behavior so null-id rows never collide.

---

## 6. Architecture Impact

- `conversations` and `messages` gain a `channel` dimension; storage is no longer WhatsApp-shaped. This is the substrate PR5/PR6/PR7 write through.
- The unified timeline (Phase 5) becomes representable: messages across channels under one `customer_id`, ordered by time. (`call_sessions` joins in PR6.)
- Idempotency invariant relocated, not weakened.
- No change to the event bus, workflow engine, crons, CRM, scheduling, knowledge, identity. PR4 touches only conversation/message storage and the WA write path.

---

## 7. Files to Modify

| File | Action | Why |
|---|---|---|
| `src/db/migrations/016_*.sql` | **New** | `conversations`: `channel` + partial-unique fix |
| `src/db/migrations/017_*.sql` | **New** | `messages`: channel/direction/external_id/type/media; relocate dedup |
| `src/db/schema.sql` | Edit | Sync fresh-install DDL |
| `conversationService.js` | Edit | Channel-aware open-conversation + persistence |
| `src/webhook/webhookController.js` | Edit | Non-text + dual-write + direction + channel; retarget `ON CONFLICT` |
| WA send/record path (`whatsappService.js`) | Edit | Outbound: channel/direction/external_id, dual-write |
| `core/eventTypes.js` | Edit only if needed | No new events required by PR4 |
| `tests/` | **New** | Storage, dual-write, idempotency, direction, partial-unique |

---

## 8. Database Migrations

Reconcile real constraint/index names and column types in Step 0 before writing DDL.

### 016 — conversations

```sql
-- 016_conversations_channel.sql
ALTER TABLE conversations
  ADD COLUMN channel TEXT NOT NULL DEFAULT 'whatsapp';

-- PRE-CHECK (run first; if this returns rows, the unique index will FAIL):
--   SELECT tenant_id, customer_id, count(*)
--   FROM conversations WHERE status='open'
--   GROUP BY tenant_id, customer_id HAVING count(*) > 1;
-- Remediation if any: close all but the most-recent open conversation per pair.

DROP INDEX IF EXISTS <existing_conversations_open_unique>;   -- reconcile real name
CREATE UNIQUE INDEX uniq_open_conversation
  ON conversations (tenant_id, customer_id) WHERE status = 'open';
```

- `channel` default keeps every existing row valid.
- The partial unique enforces **one open conversation per customer per tenant**, across channels. (See behavior flag in §9.)
- Med risk = index recreate. On the current small dataset a brief lock is fine; at scale use `CREATE UNIQUE INDEX CONCURRENTLY` (cannot run inside a txn). Rollback: drop the new index, restore the prior one, drop `channel`.

### 017 — messages

```sql
-- 017_messages_channel_agnostic.sql
ALTER TABLE messages ADD COLUMN channel       TEXT NOT NULL DEFAULT 'whatsapp';
ALTER TABLE messages ADD COLUMN direction     TEXT;                 -- 'inbound' | 'outbound'
ALTER TABLE messages ADD COLUMN external_id   TEXT;                 -- provider msg id
ALTER TABLE messages ADD COLUMN message_type  TEXT NOT NULL DEFAULT 'text';
ALTER TABLE messages ADD COLUMN media_ref     TEXT;                 -- provider media id/url, nullable

-- backfill external_id from wamid
UPDATE messages SET external_id = wamid
  WHERE wamid IS NOT NULL AND external_id IS NULL;

-- backfill direction from the EXISTING inbound/outbound signal (reconcile in Step 0)
UPDATE messages SET direction = <derive from existing column> WHERE direction IS NULL;

-- relocate dedup: drop the wamid UNIQUE constraint (keep the COLUMN), add the new unique
DROP INDEX IF EXISTS <existing_wamid_unique>;        -- reconcile real name; keep wamid column
CREATE UNIQUE INDEX uniq_msg_external
  ON messages (tenant_id, channel, external_id) WHERE external_id IS NOT NULL;
```

- `external_id` nullable; backfilled = `wamid` where present.
- `direction` backfill **requires** an existing signal — find it in Step 0 (a `sender`/`role`/`is_from_customer`-type field). If none is clean, document the heuristic before applying.
- Dedup relocated per §5. Rollback: drop the 5 new columns + the new index, restore the wamid unique.

Order: 016 → 017. Keep `schema.sql` in lockstep.

---

## 9. Behavior to confirm (flag, do not redesign)

The spec's partial unique is `(tenant_id, customer_id) WHERE status='open'` — **no channel in the key**. That means a customer has **one open conversation at a time across all channels**: if they're on a voice call and also WhatsApp, both append to the same open conversation (the `channel` column records the active/origin channel per message). Implement exactly this. If the existing code assumes per-channel open conversations, surface the conflict in Step 0 rather than changing the index. This is a real product behavior (unified live thread vs. per-channel threads) — implemented as specced; confirm it's intended when voice lands.

---

## 10. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Idempotency breaks during dedup relocation | Med | §5 relocation; duplicate-delivery test must still dedup; retarget `ON CONFLICT` precisely |
| Partial-unique index creation fails on existing duplicate open conversations | Med | Pre-check query in 016; remediate (close older) before creating index |
| `direction` backfill wrong (no clean existing signal) | Med | Identify the real signal in Step 0; document heuristic if ambiguous; test against sampled rows |
| Two unique constraints both fire → `ON CONFLICT` raises | Med | Drop the old wamid unique in the same migration; single dedup authority |
| Non-text messages dropped or crash the handler | Med | Map WA `type` → `message_type`; store `media_ref`; never drop a message |
| Batched deploy collapses expand + contract | High if ignored | §0 — wamid column drop quarantined to PR8 with its own prod verification |
| Outbound messages miss `external_id` | Low | Capture the wamid returned by WA send; set on the outbound row |

---

## 11. Backwards Compatibility

- All new columns are additive with defaults; existing rows stay valid.
- `external_id` backfilled = `wamid`; dual-write keeps both populated, so any not-yet-migrated reader still works.
- Dedup guarantee unchanged (relocated to an equivalent-or-stronger key).
- `wamid` column retained until PR8.
- No coupling to `IDENTITY_RESOLUTION_ENABLED`: the write path needs only a `customer_id`, which the controller already resolves regardless of flag state. Cross-channel value appears once identity resolution is on, but PR4 is correct either way.

---

## 12. Acceptance Criteria

1. 016 adds `channel` (default `whatsapp`) and creates `(tenant_id, customer_id) WHERE status='open'` unique; pre-check for duplicate open conversations passes or is remediated.
2. 017 adds the five columns, backfills `external_id = wamid`, backfills `direction` from the real signal, and relocates dedup to `(tenant_id, channel, external_id) WHERE external_id IS NOT NULL`; `wamid` column retained.
3. A duplicate WhatsApp delivery (same wamid) is still inserted exactly once.
4. Inbound text message stored with `channel='whatsapp'`, `direction='inbound'`, `external_id=wamid`, `wamid=wamid`, `message_type='text'`.
5. Inbound non-text (image/audio/document/location) stored with correct `message_type` and `media_ref`; not dropped, no crash.
6. Outbound message stored with `direction='outbound'` and `external_id` = the wamid returned by WA send.
7. `getOpenConversation(tenantId, customerId, channel)` returns the single open conversation (or creates one), respecting the partial unique.
8. Existing WhatsApp flow behaves identically end-to-end; all prior tests green.
9. No `wamid` column dropped; no invariant weakened (only relocated); no PR5+ work; no `customers` change.
10. `npm test` green (new + existing).

---

## 13. Testing Strategy

- **Idempotency:** insert the same wamid twice → one row (now via the relocated constraint).
- **Inbound text / non-text:** each WA `type` maps to the right `message_type`; media types persist `media_ref`; nothing dropped.
- **Outbound:** recorded with `direction='outbound'` and the returned `external_id`.
- **Direction backfill:** sampled existing rows get the correct direction from the real signal.
- **Partial unique:** a second open conversation for the same (tenant, customer) is rejected; a closed one then a new open is allowed.
- **Channel default:** legacy rows read back as `channel='whatsapp'`.
- **Migration idempotency:** backfills re-runnable without error.
- Existing suite stays green; delete/skip nothing.

---

## 14. Rollback Strategy

- **Code:** revert the PR commits — dual-write stops, the controller writes as before.
- **DB:** drop the 5 new `messages` columns + `uniq_msg_external`, restore the wamid unique; drop `conversations.channel` + `uniq_open_conversation`, restore the prior open-conversation index. The `wamid` column was never dropped, so no data is lost.
- Because `wamid` is retained and dual-written, rollback is non-destructive at any point before PR8.

---

## 15. Atomic Commit Plan

1. `feat(memory): add channel + fix open-conversation partial unique (migration 016)`
2. `feat(memory): add channel/direction/external_id/type/media to messages; relocate dedup (migration 017)`
3. `chore(db): sync schema.sql with migrations 016, 017`
4. `feat(memory): make conversationService channel-aware (getOpenConversation by channel)`
5. `feat(whatsapp): dual-write external_id+wamid, store non-text, set channel/direction; retarget ON CONFLICT`
6. `test(memory): non-text, dual-write, relocated idempotency, direction, partial-unique tests`

---

## 16. Claude Code Implementation Prompt

```text
# Zyon V2 — PR4: Channel-Agnostic Storage (migrations 016–017)

You are the backend-engineer sub-agent. Follow your standing rules in
.claude/agents/backend-engineer.md. code-reviewer reviews read-only before commit.

Source of truth: ZYON_V2_SPEC.md (Phase 3 Memory, Phase 5 timeline,
Phase 7 migrations 013/014 — which are your 016/017, Phase 8 PR4).
Evolution, not a rewrite.

## Critical context
- IDEMPOTENCY IS RELOCATED, NOT REMOVED. Today's wamid unique + ON CONFLICT
  becomes a unique on (tenant_id, channel, external_id) WHERE external_id IS NOT NULL.
  external_id = wamid for whatsapp, so dedup is preserved (and tenant/channel-scoped).
  Keep the wamid COLUMN, dual-write it. Drop only its UNIQUE constraint.
  Retarget the insert's ON CONFLICT to the new constraint.
- DO NOT drop the wamid column (that is PR8 / a later migration).
- DO NOT touch customers, call_sessions, the ChannelAdapter interface,
  customer_memory, identity resolution, or the two tracked app bugs.
- DO NOT download media binaries; store the provider media reference only.

## Step 0 — Assess (output BEFORE editing)
Report:
- Exact name + columns + scope of the current wamid unique constraint/index,
  and the exact ON CONFLICT target in the current message insert.
- The current open-conversation unique index name + columns.
- Whether duplicate OPEN conversations exist per (tenant_id, customer_id)
  (run: SELECT tenant_id, customer_id, count(*) FROM conversations
   WHERE status='open' GROUP BY 1,2 HAVING count(*)>1). If any, propose
   remediation (close all but most recent) BEFORE creating the unique index.
- The existing field that distinguishes inbound vs outbound messages
  (for the direction backfill). If none is clean, propose a heuristic.
- Whether wamid is currently nullable.
- Confirm current migration head is 015; next are 016, 017.
- Whether existing code assumes per-channel open conversations (the spec's
  partial unique is (tenant_id, customer_id) WHERE status='open' — NO channel.
  If code conflicts, surface it; do not change the index.)
- Planned diff per file.
Then build.

## Build

### Migration 016 — conversations
ALTER TABLE conversations ADD COLUMN channel TEXT NOT NULL DEFAULT 'whatsapp';
Run the duplicate-open pre-check; remediate if needed.
DROP the existing open-conversation unique (real name from Step 0).
CREATE UNIQUE INDEX uniq_open_conversation
  ON conversations (tenant_id, customer_id) WHERE status='open';

### Migration 017 — messages
ADD columns: channel TEXT NOT NULL DEFAULT 'whatsapp'; direction TEXT;
external_id TEXT; message_type TEXT NOT NULL DEFAULT 'text'; media_ref TEXT.
UPDATE messages SET external_id = wamid WHERE wamid IS NOT NULL AND external_id IS NULL.
UPDATE messages SET direction = <real signal> WHERE direction IS NULL.
DROP the wamid UNIQUE constraint (keep the wamid column).
CREATE UNIQUE INDEX uniq_msg_external
  ON messages (tenant_id, channel, external_id) WHERE external_id IS NOT NULL.

### schema.sql
Mirror 016 + 017 in fresh-install DDL. Backfills are data-only (not in schema.sql).

### conversationService — channel-aware
getOpenConversation(tenantId, customerId, channel): return the single open
conversation for the pair (create with channel if none open). Persist channel.
Respect the partial unique. All queries parameterised and tenant-scoped.

### webhookController + WA send path
Inbound: resolve customer (existing path) -> getOpenConversation(tenant, customer,
'whatsapp') -> insert message with channel='whatsapp', direction='inbound',
external_id=wamid, wamid=wamid (dual-write), message_type mapped from the WA
message type (text/image/audio/video/document/location/sticker/...),
media_ref = provider media id for non-text. Insert uses
ON CONFLICT (tenant_id, channel, external_id) DO NOTHING.
Never drop a non-text message.
Outbound: when recording a sent message, set channel='whatsapp',
direction='outbound', external_id = the wamid returned by the WA send call,
dual-write wamid, message_type, ON CONFLICT as above.

## Tests (wire into npm test)
- Duplicate wamid delivered twice -> exactly one row (relocated dedup).
- Inbound text -> channel/direction/external_id/wamid/message_type correct.
- Inbound image/audio/document/location -> correct message_type + media_ref, not dropped.
- Outbound -> direction='outbound', external_id = returned wamid.
- direction backfill -> sampled rows correct.
- Partial unique -> second open conversation per (tenant, customer) rejected;
  closed-then-new-open allowed.
- channel default -> legacy rows read 'whatsapp'.
- Backfills re-runnable.
- Existing suite green; delete/skip nothing.

## Acceptance criteria
1. 016/017 applied; columns + backfills + relocated dedup in place; wamid column retained.
2. Duplicate delivery deduped via the new constraint.
3. Inbound text + non-text stored correctly; nothing dropped.
4. Outbound stored with direction + external_id.
5. getOpenConversation honors the partial unique.
6. Existing WhatsApp flow identical end-to-end; prior tests green.
7. No wamid column dropped; no invariant weakened (only relocated); no customers
   change; no PR5+ work; npm test green.

## Rollback
Code: revert commits (controller writes as before).
DB: drop the 5 new message columns + uniq_msg_external (restore wamid unique);
drop conversations.channel + uniq_open_conversation (restore prior index).
wamid column never dropped -> non-destructive.

## Commits (atomic, Conventional, my git identity)
1. feat(memory): add channel + fix open-conversation partial unique (migration 016)
2. feat(memory): add channel/direction/external_id/type/media to messages; relocate dedup (017)
3. chore(db): sync schema.sql with migrations 016, 017
4. feat(memory): make conversationService channel-aware
5. feat(whatsapp): dual-write external_id+wamid, store non-text, set channel/direction
6. test(memory): non-text, dual-write, relocated idempotency, direction, partial-unique tests

## Finish with
A <=12-line summary: real paths + migration numbers, the exact constraint that
was dropped and the one that replaced it (proving dedup is relocated not removed),
how direction was backfilled, test results, and a deploy note: 016/017 are expand
only; the wamid COLUMN drop is a later PR and must NOT be deployed in the same
batch without a production verification window.
```

---

## Deferred-deploy checklist (when the batched deploy happens)

1. Apply 016 + 017; confirm `external_id` populated and dual-write live.
2. Run the duplicate-delivery test against the deployed build — dedup must hold.
3. Run live WhatsApp through it (text + one image) — both stored, nothing dropped.
4. Let it soak. **Do not** apply the `wamid`-column drop (PR8) in this same deploy — it gets its own verification window after all writers are confirmed on `external_id`.
