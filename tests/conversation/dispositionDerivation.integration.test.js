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
//   2. it is the LATEST event that decides, not the first — both across
//      separate transactions (the real writer's shape) and WITHIN one
//      transaction, which is where the pre-030 ordering was a coin flip
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

  // ⚠️ THIS TEST PASSES FOR AN INCIDENTAL REASON, AND CANNOT CATCH THE ORDERING
  // DEFECT MIGRATION 030 FIXED. Read this before trusting it as ordering
  // coverage.
  //
  // It appends three events through the real writer, and `recordEvent` goes
  // through `db.query` — the pool (src/db/db.js:34) — so each call is its OWN
  // implicit transaction with its own NOW(). The three rows therefore get three
  // DISTINCT `created_at` values, and `ORDER BY created_at DESC` alone settles
  // them. It would have passed identically before 030, and it did.
  //
  // The defect lived one level below that: two events in ONE transaction share
  // NOW() to the microsecond, and the old tiebreak was `id DESC` on a random
  // gen_random_uuid() — measured at 48.8% wrong across 125 pairs. Nothing in
  // this test constructs that case, so nothing in it could ever see it.
  //
  // It is kept as-is rather than rewritten, because it covers something the
  // 030 test below deliberately does not: latest-wins through the REAL WRITER,
  // across separate turns, which is how events are actually produced. The
  // same-transaction case is proved immediately after, against raw INSERTs,
  // because `recordEvent` takes no client and cannot be made to share one
  // without widening its signature for a test.
  it('the LATEST event decides, not the first — across SEPARATE transactions', async () => {
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

  // ── 2b. THE SAME-TRANSACTION CASE — migration 030 ──────────────────────────
  //
  // The case the test above cannot construct, and the one the defect lived in.
  //
  // Before 030 this was a coin flip: `created_at` is NOW(), i.e. TRANSACTION
  // START time, so both rows share it exactly, and the tiebreak was `id DESC`
  // on a random gen_random_uuid(). Measured on a scratch database across 125
  // same-transaction pairs: created_at identical 125/125, and the SECOND event
  // — the one that actually happened later — named "latest" only 48.8% of the
  // time. After 030 the ordering key is `seq`, a BIGINT GENERATED ALWAYS AS
  // IDENTITY, and ties are impossible by construction.
  //
  // ── THE NON-VACUITY RAIL, and why it is the important half ────────────────
  // Asserting only "the second event wins" would ALSO pass if someone replaced
  // NOW() with clock_timestamp() and left `id DESC` in place — a change 030
  // explicitly rejected, because on the Neon server two consecutive
  // clock_timestamp() readings return the same microsecond 58-59% of the time,
  // making it a narrowing rather than a fix.
  //
  // So this test REQUIRES the two rows to still share `created_at` EXACTLY. If
  // a future session reaches for a clock, that assertion goes red rather than
  // the test going quietly green for the wrong reason. What is being proved is
  // that the ordering survives a genuine tie — not that ties were engineered
  // away underneath it.
  //
  // Raw INSERTs rather than recordEvent: recordEvent takes no client (it uses
  // the pool), and widening its signature so a test can share a transaction is
  // exactly the kind of production change a test should not force. The reader
  // under test — deriveDisposition — is the real one.
  it('two events in ONE transaction: the second wins, every time (migration 030)', async () => {
    const { cust, conv } = await newThread(TENANT_ID, '+919000000311');

    const ROUNDS = 30;
    const insert = `INSERT INTO conversation_events
                      (tenant_id, conversation_id, customer_id, type, channel, actor)
                    VALUES ($1, $2, $3, $4, 'whatsapp', $5)
                    RETURNING id, seq, created_at::text AS ts`;

    const derived = [];
    let sharedCreatedAt = 0;
    let seqOrdered = 0;

    const client = await db.getClient();
    try {
      for (let i = 0; i < ROUNDS; i++) {
        await client.query('BEGIN');
        // FIRST: an unmapped type, so the derivation says null if it wins.
        const { rows: [first] } = await client.query(insert,
          [TENANT_ID, conv.id, cust.id, 'escalated', 'system']);
        // SECOND: the mapped type, so the derivation says 'handled' if it wins.
        const { rows: [second] } = await client.query(insert,
          [TENANT_ID, conv.id, cust.id, 'handled', 'ai']);
        await client.query('COMMIT');

        // THE RAIL: compared as Postgres renders them, not as JS Dates —
        // Date.getTime() is millisecond resolution and would call two rows
        // 900 us apart identical.
        if (first.ts === second.ts) sharedCreatedAt++;
        if (BigInt(second.seq) > BigInt(first.seq)) seqOrdered++;

        derived.push(await conversationService.deriveDisposition(TENANT_ID, conv.id));
      }
    } finally {
      client.release();
    }

    assert.equal(sharedCreatedAt, ROUNDS,
      `created_at must still be IDENTICAL within the transaction in all ${ROUNDS} rounds — ` +
      'it was in ' + sharedCreatedAt + '. If this fails, NOW() was replaced by a clock and the ' +
      'ordering below is no longer being proved against a genuine tie');

    assert.equal(seqOrdered, ROUNDS,
      'seq must strictly increase in emission order within the transaction');

    // 100/0, where the old ordering was 48.8/51.2.
    const handled = derived.filter((d) => d === 'handled').length;
    assert.equal(handled, ROUNDS,
      `the SECOND event must win all ${ROUNDS} rounds — it won ${handled}. ` +
      'Anything less than 100% is the pre-030 coin flip');
    assert.equal(derived.filter((d) => d === null).length, 0,
      'the first event never wins — `null` here means `escalated` was read as the latest');

    const { rows } = await db.query(
      'SELECT count(*)::int AS n FROM conversation_events WHERE conversation_id = $1', [conv.id]);
    assert.equal(rows[0].n, ROUNDS * 2, 'every row was written — the log is append-only');
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
