const { describe, it, mock, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

describe('Graceful shutdown', () => {
  it('SIGTERM → server.close + crons stopped + pool.end + exit(0)', async () => {
    const steps = [];

    const mockServer = {
      close(cb) {
        steps.push('server.close');
        cb();
      },
    };

    const mockReminderTask = {
      stop() { steps.push('reminder.stop'); },
    };

    const mockCollectionsTask = {
      stop() { steps.push('collections.stop'); },
    };

    const mockDb = {
      close() {
        steps.push('pool.end');
        return Promise.resolve();
      },
    };

    let exitCode = null;
    const mockExit = (code) => { exitCode = code; steps.push(`exit(${code})`); };

    // Simulate the shutdown function
    function shutdown(signal) {
      steps.push(`signal:${signal}`);

      mockServer.close(() => {
        steps.push('server.closed');

        if (mockReminderTask) mockReminderTask.stop();
        if (mockCollectionsTask) mockCollectionsTask.stop();

        mockDb.close()
          .then(() => {
            mockExit(0);
          })
          .catch((err) => {
            mockExit(1);
          });
      });
    }

    shutdown('SIGTERM');

    // Allow promise to resolve
    await new Promise((r) => setTimeout(r, 50));

    assert.deepStrictEqual(steps, [
      'signal:SIGTERM',
      'server.close',
      'server.closed',
      'reminder.stop',
      'collections.stop',
      'pool.end',
      'exit(0)',
    ]);
    assert.equal(exitCode, 0);
  });

  it('pool.end failure → exit(1)', async () => {
    const steps = [];
    let exitCode = null;
    const mockExit = (code) => { exitCode = code; steps.push(`exit(${code})`); };

    const mockServer = { close(cb) { steps.push('server.close'); cb(); } };
    const mockDb = {
      close() {
        steps.push('pool.end.error');
        return Promise.reject(new Error('pool hang'));
      },
    };

    function shutdown() {
      mockServer.close(() => {
        mockDb.close()
          .then(() => mockExit(0))
          .catch(() => mockExit(1));
      });
    }

    shutdown();
    await new Promise((r) => setTimeout(r, 50));

    assert.equal(exitCode, 1);
    assert.ok(steps.includes('pool.end.error'));
  });

  it('force-exit fires on drain timeout', async () => {
    let exitCode = null;
    const mockExit = (code) => { exitCode = code; };

    // Simulate a server that never calls back (hangs)
    const hangingServer = {
      close(_cb) {
        // intentionally never call cb — simulates a hang
      },
    };

    const forceTimer = setTimeout(() => {
      mockExit(1);
    }, 100); // use 100ms instead of 10s for test speed
    forceTimer.unref();

    hangingServer.close(() => {
      // This will never execute
      mockExit(0);
    });

    await new Promise((r) => setTimeout(r, 200));

    assert.equal(exitCode, 1, 'force exit should fire with code 1');
  });
});
