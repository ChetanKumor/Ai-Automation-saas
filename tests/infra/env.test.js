const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('child_process');
const path = require('path');

describe('Env validation (src/infra/config/env.js)', () => {
  const envScript = path.resolve(__dirname, '../../src/infra/config/env.js');

  function runWithEnv(envOverrides) {
    const env = {
      DATABASE_URL: 'postgres://localhost/test',
      GEMINI_API_KEY: 'test-key',
      WEBHOOK_VERIFY_TOKEN: 'test-verify',
      META_APP_SECRET: 'test-secret',
      ENCRYPTION_KEY: 'a'.repeat(64),
      ADMIN_PASSWORD: 'admin123',
      ...envOverrides,
    };

    // Remove any keys set to undefined/null
    for (const [k, v] of Object.entries(env)) {
      if (v === undefined || v === null) delete env[k];
    }

    return execFileSync(process.execPath, ['-e', `require('${envScript.replace(/\\/g, '\\\\')}')`], {
      env,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  }

  it('all required present → boots successfully', () => {
    assert.doesNotThrow(() => runWithEnv({}));
  });

  it('missing DATABASE_URL → exits naming the var', () => {
    try {
      runWithEnv({ DATABASE_URL: undefined });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.stdout.includes('DATABASE_URL'), `stdout should mention DATABASE_URL, got: ${err.stdout}`);
      assert.notEqual(err.status, 0);
    }
  });

  it('missing GEMINI_API_KEY → exits naming the var', () => {
    try {
      runWithEnv({ GEMINI_API_KEY: undefined });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.stdout.includes('GEMINI_API_KEY'));
      assert.notEqual(err.status, 0);
    }
  });

  it('missing META_APP_SECRET → exits naming the var', () => {
    try {
      runWithEnv({ META_APP_SECRET: undefined });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.stdout.includes('META_APP_SECRET'));
      assert.notEqual(err.status, 0);
    }
  });

  it('missing multiple vars → exits naming all missing', () => {
    try {
      runWithEnv({ DATABASE_URL: undefined, ENCRYPTION_KEY: undefined });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.stdout.includes('DATABASE_URL'));
      assert.ok(err.stdout.includes('ENCRYPTION_KEY'));
      assert.notEqual(err.status, 0);
    }
  });

  it('short SESSION_SECRET → exits with error', () => {
    try {
      runWithEnv({ SESSION_SECRET: 'tooshort' });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(err.stdout.includes('SESSION_SECRET'));
      assert.notEqual(err.status, 0);
    }
  });
});
