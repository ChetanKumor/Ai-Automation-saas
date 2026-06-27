const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

function buildApp() {
  const express = require('express');
  const app = express();

  app.use((req, res, next) => {
    req.id = crypto.randomUUID();
    res.setHeader('X-Request-Id', req.id);
    next();
  });

  return app;
}

describe('GET /health', () => {
  it('returns 200 with status ok and db up when DB is reachable', async () => {
    const app = buildApp();
    const mockDb = { query: () => Promise.resolve({ rows: [{ '?column?': 1 }] }) };

    app.get('/health', async (req, res) => {
      try {
        await mockDb.query('SELECT 1');
        res.json({ status: 'ok', db: 'up', ts: new Date().toISOString() });
      } catch (err) {
        res.status(503).json({ status: 'error', db: 'down', ts: new Date().toISOString() });
      }
    });

    const { status, body } = await injectGet(app, '/health');
    assert.equal(status, 200);
    assert.equal(body.status, 'ok');
    assert.equal(body.db, 'up');
    assert.ok(body.ts);
  });

  it('returns 503 with status error and db down when DB rejects', async () => {
    const app = buildApp();
    const mockDb = { query: () => Promise.reject(new Error('connection refused')) };

    app.get('/health', async (req, res) => {
      try {
        await mockDb.query('SELECT 1');
        res.json({ status: 'ok', db: 'up', ts: new Date().toISOString() });
      } catch (err) {
        res.status(503).json({ status: 'error', db: 'down', ts: new Date().toISOString() });
      }
    });

    const { status, body } = await injectGet(app, '/health');
    assert.equal(status, 503);
    assert.equal(body.status, 'error');
    assert.equal(body.db, 'down');
    assert.ok(body.ts);
  });

  it('does not leak error details or stack traces in 503 response', async () => {
    const app = buildApp();
    const secretError = new Error('FATAL: password authentication failed for user "admin"');
    secretError.stack = 'Error: FATAL...\n    at Pool.connect (/app/node_modules/pg/...)';
    const mockDb = { query: () => Promise.reject(secretError) };

    app.get('/health', async (req, res) => {
      try {
        await mockDb.query('SELECT 1');
        res.json({ status: 'ok', db: 'up', ts: new Date().toISOString() });
      } catch (err) {
        res.status(503).json({ status: 'error', db: 'down', ts: new Date().toISOString() });
      }
    });

    const { status, body, raw } = await injectGet(app, '/health');
    assert.equal(status, 503);
    assert.ok(!raw.includes('password'));
    assert.ok(!raw.includes('FATAL'));
    assert.ok(!raw.includes('stack'));
    assert.ok(!raw.includes('node_modules'));
    assert.deepStrictEqual(Object.keys(body).sort(), ['db', 'status', 'ts']);
  });
});

describe('Request-ID middleware', () => {
  it('sets X-Request-Id header with a valid UUID', async () => {
    const app = buildApp();
    app.get('/test', (req, res) => res.json({ ok: true }));

    const { headers } = await injectGet(app, '/test');
    const requestId = headers['x-request-id'];
    assert.ok(requestId, 'X-Request-Id header should be present');

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    assert.match(requestId, uuidRegex, 'X-Request-Id should be a valid UUID');
  });

  it('generates unique IDs per request', async () => {
    const app = buildApp();
    app.get('/test', (req, res) => res.json({ ok: true }));

    const r1 = await injectGet(app, '/test');
    const r2 = await injectGet(app, '/test');
    assert.notEqual(
      r1.headers['x-request-id'],
      r2.headers['x-request-id'],
      'each request should get a unique ID'
    );
  });
});

function injectGet(app, path) {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const port = server.address().port;
      const http = require('http');
      http.get(`http://127.0.0.1:${port}${path}`, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          let body;
          try { body = JSON.parse(data); } catch (_) { body = null; }
          resolve({ status: res.statusCode, headers: res.headers, body, raw: data });
        });
      }).on('error', (err) => { server.close(); reject(err); });
    });
  });
}
