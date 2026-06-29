# Zyon V2 — Customer Identity (spec PR3, migrations 011–012)

> Implementation package. Staff → Senior handoff. Read fully before coding.
> Source of truth: `ZYON_V2_SPEC.md` (Phase 3 Identity boundary, Phase 5 resolution algorithm, Phase 7 migrations, Phase 8 PR3). Evolution, not a rewrite.
> **Gate:** M0 (Telugu voice spike) gates PR6, not this PR. Identity is channel-agnostic foundation and proceeds now.

---

## 1. PR Objective

Introduce the Customer Identity layer: a `channel_identifiers` table and a `resolveCustomer()` function that maps any channel identifier (phone, email, handle) to exactly one customer per tenant, creating on first contact. Wire the live WhatsApp inbound path to resolve through it, behind a feature flag, with zero change to who gets resolved.

This is the join key the entire V2 platform attaches to. It ships dark, is verified for parity against the existing path, then flipped on.

---

## 2. Why This PR Exists

The V2 differentiator is one customer, one memory, all channels. That requires a single customer entity that any channel can resolve to. Today, customer resolution is implicit in the WhatsApp path (phone → customer). For Voice, SMS, Email, and Instagram to share the same customer and memory, resolution must become an explicit, channel-independent contract that every adapter calls.

Without this layer:
- The Channel Adapter (PR5) has no customer to attach its normalized envelope to.
- The Voice inbound flow (PR6/7) cannot greet a caller with history, because there is nothing to resolve the caller's number to a known customer.
- Shared memory (PR8) has no stable key (`customer_id`) to hang a rolling summary on.

Identity is the dependency root for PR4, PR5, PR6, PR7, and PR8. It is built first because everything joins on it.

---

## 3. Scope

In scope, and only this:

1. **Migration 011** — create `channel_identifiers` table (additive).
2. **Migration 012** — backfill: link every existing customer's non-empty phone as a `whatsapp` identifier (idempotent).
3. **`modules/identity`** — new module exposing:
   - `resolveCustomer({ tenantId, channelType, identifier, profile? })` → `customer`
   - `getTimeline(customerId)` → ordered list of existing `messages`/`conversations` for the customer (minimal; extends to `call_sessions` in PR6 — do not join `call_sessions` now, it does not exist yet).
   - Emits `customer.created` (new customer) and `customer.identified` (existing customer gains a new channel identifier).
4. **WhatsApp inbound wiring** — the inbound controller's customer-resolution call site routes through `resolveCustomer` when `IDENTITY_RESOLUTION_ENABLED=true`; otherwise it uses the existing path unchanged.
5. **`schema.sql`** — updated in lockstep with 011 and 012.
6. **Tests** — resolution unit tests, backfill idempotency, old-vs-new parity, tenant isolation, concurrent-create race.

---

## 4. Out of Scope

Do not build, touch, or design any of the following in this PR:

- `customer_memory` / write-back loop (PR8, migration 016).
- `call_sessions` / any voice code (PR6, migration 015). `getTimeline` must not reference it.
- `channel` columns on `conversations`/`messages` (PR4, migrations 013–014). No `wamid → external_id` rename here.
- The `ChannelAdapter` interface or registry (PR5).
- Email / Instagram channel-specific logic. They become rows in `channel_identifiers` later; no per-channel code now.
- Wholesale relocation of `customerService.js` and its call sites. Reuse existing customer CRUD; introduce the identity module alongside it. Do not move files big-bang.
- The two tracked application bugs (Gemini leading `model` role; extraction malformed JSON). Explicitly excluded.
- Multi-customer handoff join table, RLS, composite-FK enforcement, migration-runner adoption, or any item on the spec's locked out-of-scope list.

---

## 5. Architecture Impact

- Adds the **Identity seam** — Phase 5's "center of the system." `customers` gains a satellite table (`channel_identifiers`), 1 customer → N identifiers.
- Establishes the **resolution contract** every future adapter calls: `resolveCustomer(...)`. PR5/PR6/PR7 depend on it.
- Two new domain events on the existing bus: `customer.created`, `customer.identified`. No bus changes; no new subscribers required in this PR.
- **Nothing else changes.** Event bus, workflow engine, memory, CRM, scheduling, crons, idempotency, multi-tenancy: untouched. Identity only adds a table, a module, two events, and one flagged call-site swap.

---

## 6. Files to Modify

Reconcile indicative paths against the live repo in Step 0.

| File | Action | Why |
|---|---|---|
| `infra/db/migrations/011_*.sql` | **New** | `channel_identifiers` table + indexes |
| `infra/db/migrations/012_*.sql` | **New** | Backfill whatsapp identifiers from `customers.phone` |
| `infra/db/schema.sql` | Edit | Keep fresh-install DDL in sync with 011, 012 |
| `modules/identity/` (index/service) | **New** | `resolveCustomer`, `getTimeline`, event emission |
| `core/events.js` (event constants) | Edit | Add `customer.created`, `customer.identified` constants |
| WhatsApp inbound controller (`webhookController.js`) | Edit (1 call site) | Route resolution through identity behind the flag |
| `infra/config/env.js` | Edit | Add `IDENTITY_RESOLUTION_ENABLED` (bool, default `false`) |
| `customerService.js` | Reuse, do not relocate | Identity reuses existing customer create/lookup; all exports preserved |
| `tests/` | **New** | Resolution, backfill, parity, isolation, race |

---

## 7. Database Migrations

Reconcile the PK/FK types of `tenants.id` and `customers.id` against the live schema (UUID vs BIGINT) and match them exactly. DDL below assumes you substitute the real types.

### 011 — `channel_identifiers`

```sql
-- 011_channel_identifiers.sql
CREATE TABLE channel_identifiers (
  id            BIGSERIAL PRIMARY KEY,
  tenant_id     <TENANT_ID_TYPE> NOT NULL REFERENCES tenants(id),
  customer_id   <CUSTOMER_ID_TYPE> NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  channel_type  TEXT NOT NULL,        -- 'whatsapp' | 'voice' | 'sms' | 'email' | 'instagram'
  identifier    TEXT NOT NULL,        -- phone, email, handle
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uniq_channel_identifier UNIQUE (tenant_id, channel_type, identifier)
);

CREATE INDEX idx_chident_lookup   ON channel_identifiers (tenant_id, channel_type, identifier);
CREATE INDEX idx_chident_customer ON channel_identifiers (customer_id);
```

- The unique constraint is both the dedup guard and the concurrency arbiter (see resolution race handling).
- `channel_type` is plain TEXT validated in the application against a `CHANNEL_TYPES` constant — no CHECK constraint, so adding a channel later needs no migration.
- Additive only. No existing table touched. Rollback: `DROP TABLE channel_identifiers`.

### 012 — backfill

```sql
-- 012_backfill_whatsapp_identifiers.sql
INSERT INTO channel_identifiers (tenant_id, customer_id, channel_type, identifier)
SELECT tenant_id, id, 'whatsapp', phone
FROM customers
WHERE phone IS NOT NULL AND btrim(phone) <> ''
ON CONFLICT (tenant_id, channel_type, identifier) DO NOTHING;
```

- Idempotent and re-runnable (`ON CONFLICT DO NOTHING`). Running twice yields the same rows.
- Skips null/empty phones.
- Single set-based insert — adequate even at thousands of tenants. If the `customers` table is large enough that this locks too long, batch by `tenant_id`; do not pre-build batching otherwise.
- **Duplicate-phone caveat:** if a tenant has two customers with the same phone, only the first links under `whatsapp`; the second falls through to the `customers.phone` fallback at resolve time. This is a pre-existing data-quality issue, surfaced here, not introduced here. Log it (see resolution).

Order: 011 → 012. Keep `schema.sql` updated.

---

## 8. Resolution Algorithm (implement exactly)

Per Phase 5, with production race handling made explicit.

```
resolveCustomer(tenantId, channelType, identifier, profile?):

  # 1. Direct lookup (the common path after backfill)
  row = SELECT customer_id FROM channel_identifiers
        WHERE tenant_id=$1 AND channel_type=$2 AND identifier=$3
  if row: return getCustomer(row.customer_id)

  # 2. Cross-channel phone join (phone is the clinic join key)
  if channelType in ('whatsapp','voice','sms'):
     c = SELECT * FROM customers
         WHERE tenant_id=$1 AND phone=$identifier
         ORDER BY id LIMIT 1            # deterministic; log if >1 candidate exists
     if c:
        INSERT INTO channel_identifiers (tenant_id, customer_id, channel_type, identifier)
        VALUES ($1, c.id, $2, $3) ON CONFLICT DO NOTHING
        emit customer.identified
        return c

  # 3. Create new — concurrency-safe get-or-create
  BEGIN
    c = INSERT INTO customers (tenant_id, phone?, name from profile) RETURNING *
    ins = INSERT INTO channel_identifiers (tenant_id, customer_id, channel_type, identifier)
          VALUES ($1, c.id, $2, $3)
          ON CONFLICT (tenant_id, channel_type, identifier) DO NOTHING
          RETURNING customer_id
    if ins has no row:                  # another request won this identifier
       ROLLBACK                          # discard the customer we just created
       winner = SELECT customer_id FROM channel_identifiers
                WHERE tenant_id=$1 AND channel_type=$2 AND identifier=$3
       return getCustomer(winner)
    COMMIT
  emit customer.created
  return c
```

The rollback-on-conflict branch in step 3 prevents the duplicate-customer / orphan-identifier race that occurs when two channels (e.g. voice + WhatsApp) make first contact on the same new number simultaneously. The unique constraint is the arbiter; the loser discards its customer and returns the winner.

---

## 9. Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| WhatsApp regression — swap resolves a different/duplicate customer | Med | Feature flag (deploy dark → flip → verify → instant revert); backfill ensures identical resolution; parity test |
| Duplicate phones per tenant resolve ambiguously | Low-Med | Deterministic `ORDER BY id LIMIT 1`; log when fallback sees >1 candidate; flag as data-quality, do not auto-merge |
| Concurrent first-contact race → duplicate customers | Low | Insert-identifier-RETURNING + rollback-on-conflict (step 3); unique constraint arbiter |
| FK type mismatch (UUID vs BIGINT) | Med | Reconcile real PK types in Step 0 before writing DDL |
| Backfill locks a large `customers` table | Low | Single indexed set-based insert is fine; batch by tenant only if observed slow |
| `customerService` refactor breaks call sites | Low | Do not relocate; reuse; reviewer verifies every existing customer call site intact |

---

## 10. Backwards Compatibility Strategy

- **011** is additive — no existing query reads or writes it.
- **012** is idempotent backfill — `ON CONFLICT DO NOTHING`.
- The new read path **falls back to `customers.phone`**, so resolution is correct even before/without the backfill (dual-source until cutover, per spec).
- **Flag OFF = byte-for-byte existing behavior.** The new path is never exercised until the operator flips the env var.
- All existing `customerService` exports remain; no caller changes.
- No column dropped, no column renamed. (`wamid → external_id` is PR4.)

---

## 11. Acceptance Criteria

1. Migration 011 creates `channel_identifiers` with the unique constraint and both indexes; FK types match `tenants`/`customers`.
2. Migration 012 links every customer with a non-empty phone as a `whatsapp` identifier; running it twice changes nothing.
3. `resolveCustomer` returns the existing customer for a known identifier with no new rows written.
4. `resolveCustomer` links and returns the existing customer (emitting `customer.identified`) when the customer is found by phone but has no identifier row for that channel.
5. `resolveCustomer` creates exactly one customer + one identifier (emitting `customer.created`) for a brand-new identifier.
6. Under simulated concurrent first-contact on the same new identifier, exactly one customer exists, no orphan identifier, and both calls return the same `customer_id`.
7. Tenant isolation: the same identifier under two tenants resolves to two distinct customers.
8. Parity: for a sample of existing customers, the old resolution and `resolveCustomer` return the same `customer_id`.
9. Flag OFF → existing WhatsApp tests pass unchanged. Flag ON → inbound WhatsApp from a known number resolves the same customer; from a new number creates one customer + one `whatsapp` identifier.
10. No file moved/renamed; no invariant touched; no out-of-scope migration run; `npm test` green (new + existing).

---

## 12. Testing Strategy

- **Unit (`resolveCustomer`):** known identifier; phone-join link; new create; concurrent create (force conflict); non-phone channel (email) with unknown identifier creates new without phone join; tenant isolation.
- **Migration:** 011 structure (table, constraint, indexes); 012 idempotency (run twice → equal row count), correct linkage, null/empty phone skipped.
- **Parity (regression guard):** sample existing customers, assert old vs new resolution agree on `customer_id`.
- **Integration (flagged WA path):** flag OFF → existing behavior; flag ON → known number same customer, new number creates one customer + one identifier.
- Wire all into `npm test`. Mock the DB or use a test database per existing test convention. Existing suite stays green; no test deleted or skipped to pass.

---

## 13. Rollback Strategy

- **Instant (preferred):** set `IDENTITY_RESOLUTION_ENABLED=false`, redeploy. Reverts to the old path in seconds. `channel_identifiers` becomes dormant (written-but-unread); no data loss, no DB change.
- **Full (abandon seam):** `git revert` the PR commits, then `DROP TABLE channel_identifiers` (undoes 011 and 012 together). Safe because nothing else references the table yet.
- The flag gives behavioral rollback without DB changes; a code/DB revert is only needed to abandon the seam entirely.

---

## 14. Atomic Commit Plan

Conventional Commits, founder's git identity:

1. `feat(identity): add channel_identifiers table (migration 011)`
2. `feat(identity): backfill whatsapp identifiers from customers.phone (migration 012)`
3. `chore(db): sync schema.sql with migrations 011, 012`
4. `feat(identity): add resolveCustomer, getTimeline, customer.created/identified events`
5. `feat(identity): route WhatsApp inbound resolution through identity behind IDENTITY_RESOLUTION_ENABLED`
6. `test(identity): resolution, backfill idempotency, parity, isolation, and race tests`

---

## 15. Claude Code Implementation Prompt

Paste into a fresh Claude Code session.

```text
# Zyon V2 — PR3: Customer Identity (migrations 011–012)

You are the backend-engineer sub-agent. Follow your standing rules in
.claude/agents/backend-engineer.md (raw SQL, tenant scoping, invariants,
assess→build→review→commit, Conventional Commits under my git identity).
The code-reviewer sub-agent reviews read-only before commit.

Source of truth: ZYON_V2_SPEC.md (Phase 3 Identity, Phase 5 resolution
algorithm, Phase 7 migrations 011/012, Phase 8 PR3). Evolution, not a rewrite.

## Hard constraints
- Preserve all invariants: wamid dedup, ON CONFLICT, advisory locks,
  SKIP LOCKED, MAX_DEPTH, workflow claim-dedup, error classification,
  reaper, pgvector/HNSW, multi-tenancy, crons. Touch none of them.
- Do NOT move or relocate customerService.js or any existing file. Reuse it.
- Do NOT build: customer_memory, call_sessions, channel columns on
  conversations/messages, the ChannelAdapter interface, email/IG logic,
  or anything from PR4+.
- Do NOT touch the two tracked app bugs (Gemini model-role, extraction JSON).
- Do NOT touch web/.
- New behavior ships behind a flag, default OFF.

## Step 0 — Assess (output BEFORE editing)
Report:
- Real PK/FK types of tenants.id and customers.id.
- Current highest migration number (confirm 011 is next).
- Where the WhatsApp inbound controller resolves/creates a customer today
  (file + the exact call site).
- The existing customerService export surface (so nothing breaks).
- Where event-name constants live and how events are emitted/subscribed.
- How env is validated (infra/config/env.js from PR1) so the flag fits in.
- Planned diff per file.
Then build.

## Build

### Migration 011 — channel_identifiers (additive)
Create the table with columns: id BIGSERIAL PK; tenant_id FK->tenants(id);
customer_id FK->customers(id) ON DELETE CASCADE; channel_type TEXT;
identifier TEXT; created_at TIMESTAMPTZ default now().
UNIQUE (tenant_id, channel_type, identifier).
Indexes: (tenant_id, channel_type, identifier) and (customer_id).
Match tenant_id/customer_id types to the real schema. No CHECK on channel_type.

### Migration 012 — backfill (idempotent)
INSERT INTO channel_identifiers (tenant_id, customer_id, channel_type, identifier)
SELECT tenant_id, id, 'whatsapp', phone FROM customers
WHERE phone IS NOT NULL AND btrim(phone) <> ''
ON CONFLICT (tenant_id, channel_type, identifier) DO NOTHING;
Re-runnable. Skips null/empty phones.

### schema.sql
Update fresh-install DDL to include channel_identifiers (mirror 011) and note
the backfill is data-only (not in schema.sql).

### Event constants
Add customer.created and customer.identified to the central event-name
constants file. No inline string literals.

### modules/identity
Create the identity module. Reuse existing customer create/lookup from
customerService — do not duplicate or relocate it. Implement:

resolveCustomer({ tenantId, channelType, identifier, profile? }):
  1. Direct: SELECT customer_id FROM channel_identifiers
     WHERE tenant_id, channel_type, identifier. If found, return customer.
  2. If channelType in (whatsapp, voice, sms):
       SELECT * FROM customers WHERE tenant_id AND phone=identifier
       ORDER BY id LIMIT 1. (Log if more than one candidate.)
       If found: INSERT channel_identifiers (...) ON CONFLICT DO NOTHING;
       emit customer.identified; return that customer.
  3. Create (concurrency-safe, single transaction):
       BEGIN;
       INSERT customers (tenant_id, phone?, name from profile) RETURNING *;
       INSERT channel_identifiers (...) ON CONFLICT
         (tenant_id, channel_type, identifier) DO NOTHING RETURNING customer_id;
       If the identifier insert returned no row (another request won):
         ROLLBACK; SELECT the winning customer_id from channel_identifiers;
         return that customer.
       Else COMMIT; emit customer.created; return the new customer.
  All queries parameterised and tenant-scoped. channelType validated against
  a CHANNEL_TYPES constant.

getTimeline(customerId):
  Return existing messages/conversations for the customer ordered by time.
  Do NOT join call_sessions (does not exist yet; added in PR6).

### Feature flag + WhatsApp wiring
Add IDENTITY_RESOLUTION_ENABLED (boolean, default false) to env validation.
At the WhatsApp inbound resolution call site only:
  if flag ON  -> customer = resolveCustomer({tenantId, channelType:'whatsapp',
                  identifier: <phone>, profile:{name:<wa profile name>}})
  if flag OFF -> existing path, unchanged.
The returned customer must be shape-compatible with the existing path so all
downstream code is unaffected. Change no other call site.

## Tests (wire into npm test)
- resolveCustomer: known identifier (no new rows); phone-join link (emits
  customer.identified); new create (emits customer.created); concurrent create
  (force conflict -> one customer, no orphan, same id both calls); non-phone
  channel unknown identifier creates new without phone join; tenant isolation.
- Migration 012 idempotency: run twice -> equal row count; null/empty skipped.
- Parity: sample existing customers -> old resolution and resolveCustomer
  agree on customer_id.
- Flagged WA path: OFF -> existing WA tests pass; ON -> known number same
  customer, new number creates one customer + one whatsapp identifier.
- Existing suite stays green; delete/skip nothing.

## Acceptance criteria
1. 011 creates table + unique constraint + both indexes, FK types correct.
2. 012 links every non-empty-phone customer as whatsapp; idempotent.
3. Known identifier -> existing customer, no new rows.
4. Phone match without identifier -> links, emits customer.identified.
5. New identifier -> one customer + one identifier, emits customer.created.
6. Concurrent first-contact -> one customer, no orphan, same id.
7. Same identifier across two tenants -> two customers.
8. Parity holds for sampled existing customers.
9. Flag OFF unchanged; flag ON resolves correctly.
10. No file moved; no invariant touched; no PR4+ work; npm test green.

## Rollback
Instant: set IDENTITY_RESOLUTION_ENABLED=false and redeploy (no DB change).
Full: git revert the commits + DROP TABLE channel_identifiers (undoes 011+012).

## Commits (atomic, Conventional, my git identity)
1. feat(identity): add channel_identifiers table (migration 011)
2. feat(identity): backfill whatsapp identifiers from customers.phone (migration 012)
3. chore(db): sync schema.sql with migrations 011, 012
4. feat(identity): add resolveCustomer, getTimeline, customer.created/identified events
5. feat(identity): route WhatsApp inbound resolution through identity behind IDENTITY_RESOLUTION_ENABLED
6. test(identity): resolution, backfill idempotency, parity, isolation, race tests

## Finish with
A <=12-line summary: real paths changed, migration numbers applied, what
resolveCustomer does, test results, and the rollout: deploy with flag OFF,
run 011+012, verify parity test, flip IDENTITY_RESOLUTION_ENABLED=true,
send one real WhatsApp from a known number and confirm the same customer
resolves, then from a new number and confirm one customer + one identifier.
```

---

## Rollout sequence (operator)

1. Merge with flag **OFF**. Deploy. Run 011 + 012.
2. Run the parity test against production-like data.
3. Flip `IDENTITY_RESOLUTION_ENABLED=true`. Redeploy.
4. Send one WhatsApp from a known number → confirm same customer resolves.
5. Send one from a new number → confirm one customer + one `whatsapp` identifier.
6. If anything is off, flip the flag back to `false` — instant rollback, no DB change.
