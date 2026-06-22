const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { emit, on } = require('../../core/events');

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
});
