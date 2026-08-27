'use strict';

// conversations.disposition, DERIVED — the read that replaced the column.
//
// The audit's §8/P-3 proposed `disposition` as a materialised column on
// `conversations`, with CHECK (disposition IN ('open','handled','needs_staff',
// 'booked')) and a composite index to make the Inbox's "Needs staff" filter one
// index scan. It was DECLINED. The full argument is in
// docs/audit/2026-08-disposition-deferred.md; the short version is that two of
// the four values cannot be produced by any code, one of them (`booked`) is
// contradicted by the only surface that has ever rendered the field, a CHECK on
// a column maintained atomically with an INSERT into an OPEN-set `type` column
// can roll that INSERT back and silently lose the event, and no reader exists.
//
// What this file proves:
//   1. the four returns of deriveDisposition, each distinct and none collapsing
//      into another: undefined (not visible), 'open' (visible, no events),
//      'handled' (the one mapped type), null (events exist, latest unmapped)
//   2. it is the LATEST event that decides, not the first
//   3. tenant scoping is structural — a second tenant derives nothing, and gets
//      the same answer it would get for an id that does not exist
//   4. THE TAKEOVER DISAGREEMENT — the defect that killed the column, as a
//      live assertion of the WRONG behaviour rather than a paragraph (see below)
//   5. the reconciliation oracle detects that disagreement, does not
//      false-positive on a clean tenant, and does not leak across tenants
//
// It builds fixtures directly rather than through the webhook/voice routes:
// the emission path is already proved end-to-end by
// conversationEvents.integration.test.js, and what is under test here is a pure
// read over rows. The TAKEOVER fixture mirrors ownerCommands.js:91-103
// statement for statement, because that is the whole point of it.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

const db = require('../../src/db/db');
const conversationService = require('../../src/modules/conversation/conversationService');

const TENANT_ID       = '00000000-0000-0000-0000-d15900000030';
const OTHER_TENANT_ID = '00000000-0000-0000-0000-d15900000031';
const NO_SUCH_CONV    = '00000000-0000-0000-0000-000000000000';

const SKIP = process.env.DATABASE_URL ? false : 'DATABASE_URL not set';

async function cleanup() {
  for (const t of [TENANT_ID, OTHER_TENANT_ID]) {
    await db.query('DELETE FROM conversation_events WHERE tenant_id = $1', [t]);
    await db.query('DELETE FROM handoff_sessions   WHERE tenant_id = $1', [t]);
    await db.query('DELETE FROM messages           WHERE tenant_id = $1', [t]);
    await db.query('DELETE FROM conversations      WHERE tenant_id = $1', [t]);
    await db.query('DELETE FROM customers          WHERE tenant_id = $1', [t]);
    await db.query('DELETE FROM tenants            WHERE id = $1', [t]);
  }
}

async function ensureTenant(tenantId, name, pnid) {
  await db.query(
    `INSERT INTO tenants (id, business_name, phone_number_id, active)
     VALUES ($1, $2, $3, true) ON CONFLICT (id) DO NOTHING`,
    [tenantId, name, pnid]
  );
}

// One customer + their single open conversation, through the real writer.
async function newThread(tenantId, phone) {
  const { rows: [cust] } = await db.query(
    `INSERT INTO customers (tenant_id, phone) VALUES ($1, $2)
     ON CONFLICT (tenant_id, phone) DO UPDATE SET last_seen_at = NOW() RETURNING *`,
    [tenantId, phone]
  );
  const conv = await conversationService.getOrCreateOpenConversation(tenantId, cust.id, 'whatsapp');
  return { cust, conv };
}

// TAKEOVER, exactly as ownerCommands.js does it: setMode('human') at :91 and
// the handoff_sessions upsert at :98-104. Deliberately NOT wrapped in a helper
// that also emits an event — emitting one is precisely what the real path does
// not do, and inventing it here would fake away the defect under test.
async function takeover(tenantId, customerId, conversationId, ownerPhone) {
  await conversationService.setMode(tenantId, conversationId, 'human');
  await db.query(
    `INSERT INTO handoff_sessions (tenant_id, customer_id, started_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (tenant_id, customer_id) WHERE ended_at IS NULL
     DO UPDATE SET started_by = EXCLUDED.started_by, started_at = NOW(), message_count = 0`,
    [tenantId, customerId, ownerPhone]
  );
}

describe('conversations.disposition — derived, not stored (audit §8/P-3, DECLINED)', { skip: SKIP }, () => {
  before(async () => {
    await cleanup();
    await ensureTenant(TENANT_ID, 'Disposition Derivation Co', 'pnid_disp_30');
    await ensureTenant(OTHER_TENANT_ID, 'Disposition Other Co', 'pnid_disp_31');
  });

  after(cleanup);

  // ── 1. The four returns ────────────────────────────────────────────────────

  it("a thread with no events derives 'open' — recorded, not asserted about reality", async () => {
    const { conv } = await newThread(TENANT_ID, '+919000000301');

    assert.equal(await conversationService.deriveDisposition(TENANT_ID, conv.id), 'open');

    // Read it as "no outcome has been RECORDED", never as "nothing happened".
    // a550e900 on the dev database is a real 115-message thread that predates
    // migration 029 and derives exactly this. 'open' is the honest derivation
    // and would still be a misleading thing to render in an Inbox — a third
    // reason the column is not ready, filed with the deferral.
    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM conversation_events WHERE conversation_id = $1', [conv.id]);
    assert.equal(rows[0].n, 0, 'the derivation read zero events, so this is the empty case');
  });

  it("the one emitted type maps: a `handled` event derives 'handled'", async () => {
    const { conv } = await newThread(TENANT_ID, '+919000000302');

    const ev = await conversationService.recordEvent(TENANT_ID, conv.id, {
      type: 'handled', channel: 'whatsapp', actor: 'ai',
    });
    assert.ok(ev, 'the event was written');

    assert.equal(await conversationService.deriveDisposition(TENANT_ID, conv.id), 'handled');
  });

  it('an unmapped type derives null — not `open`, not the raw type, not a guess', async () => {
    const { conv } = await newThread(TENANT_ID, '+919000000303');

    // `escalated` is accepted today: conversation_events.type is an open set,
    // which is migration 029's central design decision.
    await conversationService.recordEvent(TENANT_ID, conv.id, {
      type: 'escalated', channel: 'whatsapp', actor: 'system',
    });

    const d = await conversationService.deriveDisposition(TENANT_ID, conv.id);
    assert.equal(d, null, 'events exist but no disposition is named for this type');

    // The three wrong answers, each ruled out explicitly.
    assert.notEqual(d, 'open',
      "'open' would claim no outcome was recorded when one was — the most dangerous wrong answer, because it is indistinguishable from the honest empty case");
    assert.notEqual(d, 'escalated',
      'pass-through would return EVENT vocabulary where a DISPOSITION is expected, settling the deferred vocabulary question by accident in code');
    assert.notEqual(d, 'needs_staff',
      "mapping escalated -> needs_staff is the guess this session declined to make: `escalated` is an event, `needs_staff` is a disposition, and deciding they are the same is A-2's call against real rows");
  });

  it('a conversation that does not exist derives undefined', async () => {
    assert.equal(await conversationService.deriveDisposition(TENANT_ID, NO_SUCH_CONV), undefined);
  });

  // ── 2. Latest wins ─────────────────────────────────────────────────────────

  it('the LATEST event decides, not the first', async () => {
    const { conv } = await newThread(TENANT_ID, '+919000000304');

    await conversationService.recordEvent(TENANT_ID, conv.id, {
      type: 'handled', channel: 'whatsapp', actor: 'ai',
    });
    assert.equal(await conversationService.deriveDisposition(TENANT_ID, conv.id), 'handled');

    await conversationService.recordEvent(TENANT_ID, conv.id, {
      type: 'escalated', channel: 'whatsapp', actor: 'system',
    });
    assert.equal(await conversationService.deriveDisposition(TENANT_ID, conv.id), null,
      'the second event superseded the first');

    await conversationService.recordEvent(TENANT_ID, conv.id, {
      type: 'handled', channel: 'voice', actor: 'ai',
    });
    assert.equal(await conversationService.deriveDisposition(TENANT_ID, conv.id), 'handled',
      'and the third superseded that');

    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM conversation_events WHERE conversation_id = $1', [conv.id]);
    assert.equal(rows[0].n, 3, 'all three rows are still there — the log is append-only');
  });

  // ── 3. Tenant scoping, structural ──────────────────────────────────────────

  it('tenant scoping is structural: a second tenant derives nothing', async () => {
    const { conv } = await newThread(TENANT_ID, '+919000000305');
    await conversationService.recordEvent(TENANT_ID, conv.id, {
      type: 'handled', channel: 'whatsapp', actor: 'ai',
    });

    // The owning tenant sees it.
    assert.equal(await conversationService.deriveDisposition(TENANT_ID, conv.id), 'handled');

    // A real, active tenant passing a real conversation id that is not its own
    // gets undefined — and crucially the SAME answer it gets for an id that
    // does not exist at all, so the two cases are indistinguishable.
    const foreign = await conversationService.deriveDisposition(OTHER_TENANT_ID, conv.id);
    assert.equal(foreign, undefined, 'a foreign tenant derives nothing');
    assert.equal(foreign, await conversationService.deriveDisposition(OTHER_TENANT_ID, NO_SUCH_CONV),
      'and cannot tell a foreign thread from a non-existent one');

    // Not 'open': that would confirm the thread exists.
    assert.notEqual(foreign, 'open', 'undefined, never `open` — `open` would confirm existence');
  });

  // ── 4. THE TAKEOVER DISAGREEMENT — the defect that killed the column ───────

  it('⚠️ WRONG-BY-DESIGN: after TAKEOVER the thread derives `handled` while a human works it', async () => {
    const { cust, conv } = await newThread(TENANT_ID, '+919000000306');

    // The AI handles a few turns. Real emission, real writer.
    await conversationService.recordEvent(TENANT_ID, conv.id, {
      type: 'handled', channel: 'whatsapp', actor: 'ai',
    });
    assert.equal(await conversationService.deriveDisposition(TENANT_ID, conv.id), 'handled');

    // The owner types TAKEOVER. mode flips to 'human', a handoff session opens,
    // and NO conversation_event is written — ownerCommands.js emits none, and
    // the mode gate in whatsapp/routes.js:160-178 returns before the emitter, so
    // every subsequent turn on this thread emits nothing either. Both are
    // deliberate: `handled` on a human turn would be a false claim.
    await takeover(TENANT_ID, cust.id, conv.id, '+919888800001');

    const { rows: [state] } = await db.query(
      `SELECT c.mode,
              (SELECT count(*)::int FROM handoff_sessions h
                WHERE h.tenant_id = c.tenant_id AND h.customer_id = c.customer_id
                  AND h.ended_at IS NULL) AS open_handoffs,
              (SELECT count(*)::int FROM conversation_events e
                WHERE e.conversation_id = c.id) AS events
         FROM conversations c WHERE c.id = $1`, [conv.id]);

    assert.equal(state.mode, 'human', 'a human is on this thread');
    assert.equal(state.open_handoffs, 1, 'and there is an open handoff session saying so');
    assert.equal(state.events, 1, 'and TAKEOVER emitted NO event — still just the AI `handled`');

    // ── THE ASSERTION THIS TEST EXISTS FOR ────────────────────────────────
    // This is the CURRENT behaviour and it is WRONG. A thread a human is
    // actively working derives `handled`, so §8/P-3's materialised column would
    // hold 'handled', and the Inbox's "Needs staff" filter — the one filter
    // that carries the product's value proposition — would not show this row.
    //
    // It is asserted rather than skipped or TODO'd on purpose: this is the
    // load-bearing evidence for declining the column, and a skipped test proves
    // nothing. When A-2 lands and ownerCommands.js emits on the TAKEOVER
    // branch, THIS LINE MUST FAIL. That failure is the signal that the defect
    // is closed and the column can be reconsidered — not a regression.
    assert.equal(await conversationService.deriveDisposition(TENANT_ID, conv.id), 'handled',
      'WRONG, and asserted so it breaks loudly when A-2 fixes it: the thread reads `handled` while a human works it');
  });

  // ── 5. The reconciliation oracle ───────────────────────────────────────────

  it('the oracle detects the TAKEOVER disagreement, on both signals', async () => {
    const { cust, conv } = await newThread(TENANT_ID, '+919000000307');
    await conversationService.recordEvent(TENANT_ID, conv.id, {
      type: 'handled', channel: 'whatsapp', actor: 'ai',
    });
    await takeover(TENANT_ID, cust.id, conv.id, '+919888800002');

    const rows = await conversationService.findDispositionDisagreements(TENANT_ID);
    const hit = rows.find((r) => r.conversation_id === conv.id);

    assert.ok(hit, 'the oracle flagged the thread');
    assert.equal(hit.mode, 'human');
    assert.equal(hit.open_handoff, true);
    assert.equal(hit.derived, 'handled');
    assert.equal(hit.latest_type, 'handled');

    // Both signals fire independently, and both name what the derivation said —
    // an oracle that only reported "disagrees" would not tell an operator which
    // direction it disagreed in.
    assert.ok(hit.findings.includes('mode_human_but_derived_handled'), hit.findings.join(','));
    assert.ok(hit.findings.includes('open_handoff_but_derived_handled'), hit.findings.join(','));
  });

  it('the oracle flags an uninterpretable latest type without calling it drift', async () => {
    const { conv } = await newThread(TENANT_ID, '+919000000308');
    await conversationService.recordEvent(TENANT_ID, conv.id, {
      type: 'booked', channel: 'voice', actor: 'ai',
    });

    const rows = await conversationService.findDispositionDisagreements(TENANT_ID);
    const hit = rows.find((r) => r.conversation_id === conv.id);

    assert.ok(hit, 'flagged');
    assert.equal(hit.derived, null, 'the derivation named no disposition');
    assert.deepEqual(hit.findings, ['uninterpretable_latest_type'],
      'flagged as vocabulary arriving, NOT as a human-on-the-thread disagreement');
    assert.equal(hit.mode, 'ai');
    assert.equal(hit.open_handoff, false);
  });

  it('a human-worked thread whose latest type is unmapped still reports the human finding', async () => {
    const { cust, conv } = await newThread(TENANT_ID, '+919000000309');
    await conversationService.recordEvent(TENANT_ID, conv.id, {
      type: 'escalated', channel: 'whatsapp', actor: 'system',
    });
    await takeover(TENANT_ID, cust.id, conv.id, '+919888800003');

    const rows = await conversationService.findDispositionDisagreements(TENANT_ID);
    const hit = rows.find((r) => r.conversation_id === conv.id);

    // The regression this guards: `'mode_human_but_derived_' || derived` with a
    // NULL derived yields NULL in SQL, which ARRAY_REMOVE would then strip —
    // silently dropping the one finding that must never go missing. COALESCE
    // renders it as '_null' instead.
    assert.ok(hit.findings.includes('mode_human_but_derived_null'), hit.findings.join(','));
    assert.ok(hit.findings.includes('uninterpretable_latest_type'), hit.findings.join(','));
  });

  it('the oracle does not false-positive: a clean tenant returns []', async () => {
    // OTHER_TENANT_ID has a thread and a `handled` event, mode 'ai', no handoff.
    const { conv } = await newThread(OTHER_TENANT_ID, '+919000000310');
    await conversationService.recordEvent(OTHER_TENANT_ID, conv.id, {
      type: 'handled', channel: 'whatsapp', actor: 'ai',
    });
    assert.equal(await conversationService.deriveDisposition(OTHER_TENANT_ID, conv.id), 'handled');

    assert.deepEqual(await conversationService.findDispositionDisagreements(OTHER_TENANT_ID), [],
      'agreement is silence');
  });

  it('the oracle is tenant-scoped: one tenant never sees another tenant\'s disagreements', async () => {
    // TENANT_ID has several by now, from the tests above.
    const mine = await conversationService.findDispositionDisagreements(TENANT_ID);
    assert.ok(mine.length > 0, 'this tenant does have disagreements');

    const theirs = await conversationService.findDispositionDisagreements(OTHER_TENANT_ID);
    const mineIds = new Set(mine.map((r) => r.conversation_id));
    for (const r of theirs) {
      assert.ok(!mineIds.has(r.conversation_id), 'no conversation crosses the tenant boundary');
    }

    // And a tenant that does not exist gets [], not everything.
    assert.deepEqual(
      await conversationService.findDispositionDisagreements('00000000-0000-0000-0000-0000000000ff'), []);
  });

  it('the mapping is the single source of truth for both the derivation and the oracle', async () => {
    // If a future session adds a mapping entry, both move together — the oracle
    // takes the same frozen object into SQL as jsonb rather than restating it.
    assert.deepEqual(conversationService.EVENT_TYPE_TO_DISPOSITION, { handled: 'handled' });
    assert.ok(Object.isFrozen(conversationService.EVENT_TYPE_TO_DISPOSITION));
  });
});
