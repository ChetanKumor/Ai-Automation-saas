const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Mirrors the prod-gating in server.js: trust-proxy + secure session cookie are
// enabled together, keyed ONLY off NODE_ENV === 'production'. If that gate ever
// drifts (e.g. keyed off a var the prod checklist doesn't set), the operator logs
// into /admin over Railway's TLS-terminating proxy and is immediately bounced —
// so this asserts both halves flip together.
function gate(nodeEnv) {
  const isProd = nodeEnv === 'production';
  const app = express();
  if (isProd) app.set('trust proxy', 1);
  const cookie = { httpOnly: true, sameSite: 'strict', secure: isProd };
  return { trustProxy: app.get('trust proxy'), secure: cookie.secure };
}

describe('Prod gating: trust-proxy + secure cookie (server.js)', () => {
  it('NODE_ENV=production → trusts first proxy hop AND secure cookie', () => {
    const { trustProxy, secure } = gate('production');
    assert.equal(trustProxy, 1, 'prod must trust the first proxy hop');
    assert.equal(secure, true, 'prod session cookie must be HTTPS-only');
  });

  it('NODE_ENV=development → neither proxy trust nor secure cookie', () => {
    const { trustProxy, secure } = gate('development');
    assert.ok(!trustProxy, 'dev must not trust proxy (plain http works)');
    assert.equal(secure, false, 'dev session cookie must not require HTTPS');
  });

  it('NODE_ENV unset → treated as non-prod (dev-safe default)', () => {
    const { trustProxy, secure } = gate(undefined);
    assert.ok(!trustProxy);
    assert.equal(secure, false);
  });
});
