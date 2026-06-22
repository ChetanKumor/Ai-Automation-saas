const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { register, execute } = require('../../core/actions');

describe('ActionRegistry', () => {
  it('executes a registered action', async () => {
    register('greet', (params) => ({ message: `hello ${params.name}` }));
    const result = await execute('greet', { name: 'world' });
    assert.deepEqual(result, { message: 'hello world' });
  });

  it('returns {skipped:true} for unknown actions without throwing', async () => {
    const result = await execute('nonexistent', {});
    assert.deepEqual(result, { skipped: true });
  });
});
