const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { emit, on } = require('../../core/events');
const requestContext = require('../../src/core/requestContext');

const flush = () => new Promise((r) => setImmediate(() => setTimeout(r, 20)));

describe('EventBus', () => {
  it('delivers to typed and wildcard listeners', async () => {
    const received = [];
    const off1 = on('test_event', (env) => received.push(['typed', env]));
    const off2 = on('*', (env) => {
      if (env.type === 'test_event') received.push(['wild', env]);
    });

    const envelope = emit('test_event', { tenant_id: 't1', foo: 1 });
    await flush();

    assert.equal(received.length, 2);
    assert.equal(received[0][0], 'typed');
    assert.equal(received[1][0], 'wild');
    assert.equal(received[0][1].type, 'test_event');
    assert.equal(received[0][1].tenant_id, 't1');
    assert.ok(received[0][1].event_id);
    assert.equal(typeof received[0][1].ts, 'number');
    assert.equal(envelope.depth, 0);

    off1();
    off2();
  });

  it('isolates handler failures — a throwing handler does not break others', async () => {
    const results = [];

    const off1 = on('fail_test', () => { throw new Error('boom'); });
    const off2 = on('fail_test', (env) => results.push(env.type));
    const off3 = on('fail_test', () => results.push('third'));

    emit('fail_test', { tenant_id: 'x' });
    await flush();

    assert.equal(results.length, 2);
    assert.equal(results[0], 'fail_test');
    assert.equal(results[1], 'third');

    off1();
    off2();
    off3();
  });

  it('isolates async handler failures — a rejecting handler does not break others', async () => {
    const results = [];

    const off1 = on('async_fail', async () => { throw new Error('async boom'); });
    const off2 = on('async_fail', (env) => results.push(env.type));

    emit('async_fail', { tenant_id: 'x' });
    await flush();

    assert.equal(results.length, 1);
    assert.equal(results[0], 'async_fail');

    off1();
    off2();
  });

  it('propagates causation_id and depth from meta', async () => {
    let captured;
    const off = on('meta_test', (env) => { captured = env; });

    emit('meta_test', { tenant_id: 't' }, { causation_id: 'parent-1', depth: 2 });
    await flush();

    assert.equal(captured.causation_id, 'parent-1');
    assert.equal(captured.depth, 2);

    off();
  });

  // ── Issue 21: correlation context propagation ──────────────────────────────

  describe('correlation context (Issue 21)', () => {
    const CID = 'wa_' + '1a'.repeat(8);

    it('envelope carries the emitter chain id; null outside any chain', async () => {
      let inChain, outside;
      const off = on('corr_env', (env) => {
        if (env.payload.k === 'in') inChain = env;
        else outside = env;
      });

      requestContext.runWith({ correlationId: CID }, () => {
        emit('corr_env', { tenant_id: 't', k: 'in' });
      });
      emit('corr_env', { tenant_id: 't', k: 'out' });
      await flush();

      assert.equal(inChain.correlation_id, CID);
      assert.equal(outside.correlation_id, null);
      off();
    });

    it('handlers run inside the captured context — even across the setImmediate hop', async () => {
      let handlerCtx, hopCtx;
      const off = on('corr_handler', () => {
        handlerCtx = requestContext.get();
        // A further fire-and-forget hop inside the handler must inherit too —
        // this is the case that fails on naive ALS usage.
        setImmediate(() => { hopCtx = requestContext.get(); });
      });

      requestContext.runWith({ correlationId: CID, channel: 'whatsapp' }, () => {
        emit('corr_handler', { tenant_id: 't' });
      });
      await flush();

      assert.equal(handlerCtx.correlationId, CID);
      assert.equal(handlerCtx.channel, 'whatsapp');
      assert.equal(hopCtx.correlationId, CID);
      off();
    });

    it('an emit inside a handler inherits the chain: correlation, depth+1, causation', async () => {
      let parent, child;
      const off1 = on('corr_parent', (env) => {
        parent = env;
        emit('corr_child', { tenant_id: env.tenant_id });
      });
      const off2 = on('corr_child', (env) => { child = env; });

      requestContext.runWith({ correlationId: CID }, () => {
        emit('corr_parent', { tenant_id: 't' });
      });
      await flush(); await flush();

      assert.equal(parent.depth, 0);
      assert.equal(child.correlation_id, CID);
      assert.equal(child.depth, 1, 'nested emit must increment depth');
      assert.equal(child.causation_id, parent.event_id, 'nested emit must carry causation');
      off1(); off2();
    });

    it('regression (finding #6): the lead-event chain carries correlation + cause', async () => {
      // Mirrors extractionHandler: a MESSAGE_RECEIVED handler that (after
      // async work — the LLM call) emits lead_created with NO explicit meta.
      // Before Issue 21 that envelope had depth 0 and no causation, blinding
      // the workflow depth guard.
      let received, lead;
      const off1 = on('f6_message_received', async (env) => {
        received = env;
        await new Promise((r) => setTimeout(r, 5)); // the extraction LLM call
        emit('f6_lead_created', { tenant_id: env.tenant_id, lead_id: 'l1' });
      });
      const off2 = on('f6_lead_created', (env) => { lead = env; });

      requestContext.runWith({ correlationId: CID, channel: 'whatsapp' }, () => {
        emit('f6_message_received', { tenant_id: 't', text: 'I want to book' });
      });
      await flush(); await flush();

      assert.equal(lead.correlation_id, CID);
      assert.equal(lead.causation_id, received.event_id);
      assert.equal(lead.depth, received.depth + 1);
      off1(); off2();
    });

    it('explicit meta still wins over inherited context', async () => {
      let child;
      const off1 = on('meta_wins_parent', (env) => {
        emit('meta_wins_child', { tenant_id: 't' },
          { depth: 4, causation_id: 'explicit-cause', correlation_id: 'call_' + 'ff'.repeat(8) });
      });
      const off2 = on('meta_wins_child', (env) => { child = env; });

      requestContext.runWith({ correlationId: CID }, () => {
        emit('meta_wins_parent', { tenant_id: 't' });
      });
      await flush(); await flush();

      assert.equal(child.depth, 4);
      assert.equal(child.causation_id, 'explicit-cause');
      assert.equal(child.correlation_id, 'call_' + 'ff'.repeat(8));
      off1(); off2();
    });

    it('explicit NULL/0 meta also wins — no half-inherited lineage', async () => {
      // Callers that thread meta by hand (collectionsService passes
      // `depth: ctx?.depth ?? 0, causation_id: ctx?.causation_id ?? null`)
      // must keep their exact pre-Issue-21 envelope even inside a handler:
      // explicit depth 0 with an INHERITED cause would reset the workflow
      // depth counter mid-chain while claiming a causal parent.
      let child;
      const off1 = on('null_meta_parent', () => {
        emit('null_meta_child', { tenant_id: 't' }, { depth: 0, causation_id: null });
      });
      const off2 = on('null_meta_child', (env) => { child = env; });

      requestContext.runWith({ correlationId: CID }, () => {
        emit('null_meta_parent', { tenant_id: 't' });
      });
      await flush(); await flush();

      assert.equal(child.depth, 0);
      assert.equal(child.causation_id, null);
      assert.equal(child.correlation_id, CID, 'correlation (absent from meta) still inherits');
      off1(); off2();
    });

    it('a re-emitting handler chain reaches the workflow depth guard threshold', async () => {
      // Each hop re-emits with no meta; depth must climb 0,1,2,… so a guard
      // like workflowEngine's `depth >= MAX` actually halts runaway chains.
      const depths = [];
      const off = on('depth_chain', (env) => {
        depths.push(env.depth);
        if (env.depth < 3) emit('depth_chain', { tenant_id: 't' });
      });

      emit('depth_chain', { tenant_id: 't' });
      for (let i = 0; i < 6; i++) await flush();

      assert.deepEqual(depths, [0, 1, 2, 3]);
      off();
    });
  });
});
