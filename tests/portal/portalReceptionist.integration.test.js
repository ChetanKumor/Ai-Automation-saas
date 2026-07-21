'use strict';

// Route-level tests for GET/POST /portal/api/config/receptionist (PORTAL-P5-S13)
// — persona + voice. Exercises the real /portal router over HTTP against a
// throwaway scratch DB (same genesis pattern as the other portal tests). Skips
// when DATABASE_URL is unset.
//
// Disjoint DB-name prefix (zyon_prcp_) so it can run in parallel with the other
// portal suites without dropping their scratch DBs.
//
// What we assert is the route's contract:
//   • write goes THROUGH configService (new version + revision recording the
//     acting owner, INV-4) and invalidates the cache (a re-read shows the change),
//   • PARTIAL-SECTION merge (this page's defining wrinkle): saving receptionist
//     must NOT wipe personality.custom_instructions or voice.enabled/did/
//     provider/sarvam_voice_id — none of which this page owns — on top of the
//     ordinary READ-MERGE regression (identity/hours/pricing/booking/safety
//     untouched),
//   • Tone maps onto 2 of `style`'s 4 real values (schema.js's documented
//     mapping) rather than being its own field,
//   • greeting is required for the default language and, left blank for another
//     enabled language, is materialised as a COPY of the default's line (the
//     schema requires a non-empty entry for every supported language — there is
//     no "inherit at render time" for an empty string),
//   • tenant scope (INV-1): a crafted tenantId in query/body is inert on read
//     AND write,
//   • PROMPT INTEGRATION: display name, greeting, tone and response length reach
//     the rendered prompt verbatim on both channels, and are all silent-on-
//     default (a config that never touches this page renders byte-identical to
//     before PORTAL-P5-S13),
//   • KNOWN GAP: voice_speaker/pace are saved to config but /internal/voice/
//     call/start — the only thing that bridges a real call — does not carry
//     them to the voice worker today. Pinned so the day someone wires it, this
//     test goes red and the gap is closed deliberately, not accidentally.

process.env.LOG_LEVEL = 'silent';
require('dotenv').config();

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const http = require('http');
const { Client } = require('pg');

const runner = require('../../src/db/migrate');
const { hashPassword } = require('../../src/portal/auth'); // auth lazy-requires db → safe at top

const ADMIN = process.env.DATABASE_URL;
const SSL = process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false;
const SILENT = { log() {}, error() {} };
const PREFIX = 'zyon_prcp_';
function swapDb(cs, name) { const u = new URL(cs); u.pathname = '/' + name; return u.toString(); }
function admin() { return new Client({ connectionString: ADMIN, ssl: SSL }); }

async function sweep() {
  const c = admin();
  await c.connect();
  try {
    const { rows } = await c.query("SELECT datname FROM pg_database WHERE datname LIKE 'zyon\\_prcp\\_%'");
    for (const r of rows) {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [r.datname]);
      await c.query('DROP DATABASE IF EXISTS ' + r.datname);
    }
  } finally { await c.end(); }
}

// ── HTTP helpers (mirror the other portal route tests) ───────────────────────
function req(server, { method = 'GET', path = '/', headers = {}, body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const port = server.address().port;
    const h = Object.assign({}, headers);
    let payload;
    if (body !== undefined) {
      payload = JSON.stringify(body);
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(payload);
    }
    if (cookie) h['Cookie'] = cookie;
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: h }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        let json; try { json = JSON.parse(data); } catch (_) { json = null; }
        resolve({ status: res.statusCode, headers: res.headers, setCookie: res.headers['set-cookie'] || [], body: json });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}
function sid(setCookie) {
  const c = (setCookie || []).find((s) => s.startsWith('portal.sid='));
  return c ? c.split(';')[0] : null;
}
function listen(app) { return new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); }); }
function buildPortalApp() {
  const express = require('express');
  const app = express();
  delete require.cache[require.resolve('../../src/portal/routes')];
  app.use('/portal', require('../../src/portal/routes'));
  return app;
}
async function start() { return listen(buildPortalApp()); }
function login(server, email, password) {
  return req(server, { method: 'POST', path: '/portal/api/login', body: { email, password } });
}
async function authedCookie(server, email, password) {
  return sid((await login(server, email, password)).setCookie);
}

describe('portal receptionist — persona & voice config (route-level)', { skip: ADMIN ? false : 'DATABASE_URL not set' }, () => {
  let scratchName, scratchCs, db, configService, renderSystemPrompt, hmac;
  let ownerA, ownerB, ownerC;

  before(async () => {
    await sweep();
    scratchName = PREFIX + crypto.randomBytes(6).toString('hex');
    const c = admin();
    await c.connect();
    await c.query('CREATE DATABASE ' + scratchName);
    await c.end();

    scratchCs = swapDb(ADMIN, scratchName);
    await runner.genesis({ connectionString: scratchCs, logger: SILENT });

    // db + config + prompts required only AFTER the env swap so the shared pool
    // binds to the scratch DB (S1 lesson: eager import binds to the wrong DB).
    process.env.DATABASE_URL = scratchCs;
    db = require('../../src/db/db');
    configService = require('../../src/modules/config/configService');
    renderSystemPrompt = require('../../src/modules/prompts').renderSystemPrompt;
    hmac = require('../../src/utils/hmac');

    ownerA = await seedOwner({ tenantName: 'Alpha Clinic', email: 'alice@alpha.test', password: 'alpha-pass-1' });
    ownerB = await seedOwner({ tenantName: 'Bravo Clinic', email: 'bob@bravo.test', password: 'bravo-pass-2' });
    ownerC = await seedOwner({ tenantName: 'Charlie Clinic', email: 'cara@charlie.test', password: 'charlie-pass-3' });

    // Seed A with every OTHER owner-writable section, PLUS fields this page does
    // NOT own but shares an object with (custom_instructions, voice.enabled/did/
    // provider/sarvam_voice_id) — the read-merge regression has real neighbours
    // to lose if the partial-section merge is wrong.
    await configService.writeTenantConfig(ownerA.tenantId, {
      business: { display_name: 'Sunrise Dental', address: '12 MG Road, Hyderabad' },
      hours: { sun: { open: '10:00', close: '13:00' } },
      pricing: { consultation_fee: 500 },
      booking: { slot_minutes: 15, cancellation_policy: 'Call 4 hours before.' },
      escalation: { enabled: true, phone_numbers: ['+919000011111'] },
      personality: { custom_instructions: 'Always mention our 20th anniversary offer.' },
      voice: { enabled: true, did: '+911234567890', sarvam_voice_id: 'bulbul:v3' },
    }, 'cli');
    await configService.writeTenantConfig(ownerB.tenantId, {
      greeting: { en: 'Bravo Clinic here, how can we help?', hi: 'नमस्ते! आपका स्वागत है। मैं आपकी कैसे मदद कर सकता/सकती हूँ?', te: 'నమస్తే! స్వాగతం. నేను మీకు ఎలా సహాయం చేయగలను?' },
    }, 'cli');
    await configService.writeTenantConfig(ownerC.tenantId, {}, 'cli');
  });

  after(async () => {
    process.env.DATABASE_URL = ADMIN;
    if (db) await db.close();
    const c = admin();
    await c.connect();
    try {
      await c.query('SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid()', [scratchName]);
      await c.query('DROP DATABASE IF EXISTS ' + scratchName);
    } finally { await c.end(); }
  });

  async function seedOwner({ tenantName, email, password }) {
    const t = await db.query('INSERT INTO tenants (business_name, active) VALUES ($1, true) RETURNING id', [tenantName]);
    const tenantId = t.rows[0].id;
    const u = await db.query(
      'INSERT INTO users (tenant_id, email, password_hash, role, active) VALUES ($1,$2,$3,$4,true) RETURNING id',
      [tenantId, email, hashPassword(password), 'owner']);
    return { tenantId, userId: u.rows[0].id, email, password };
  }
  async function versionOf(tenantId) {
    const r = await db.query('SELECT version FROM tenant_configs WHERE tenant_id=$1', [tenantId]);
    return r.rows[0] ? r.rows[0].version : 0;
  }
  async function latestRevision(tenantId) {
    const r = await db.query(
      'SELECT version, source, actor_user_id FROM tenant_config_revisions WHERE tenant_id=$1 ORDER BY version DESC LIMIT 1',
      [tenantId]);
    return r.rows[0];
  }
  async function preview(tenantId, channel = 'whatsapp') {
    return renderSystemPrompt(await configService.getTenantConfig(tenantId), { channel });
  }
  async function post(owner, body) {
    const server = await start();
    try {
      const cookie = await authedCookie(server, owner.email, owner.password);
      return await req(server, { method: 'POST', path: '/portal/api/config/receptionist', cookie, body });
    } finally { server.close(); }
  }
  async function get(owner, qs = '') {
    const server = await start();
    try {
      const cookie = await authedCookie(server, owner.email, owner.password);
      return await req(server, { method: 'GET', path: '/portal/api/config/receptionist' + qs, cookie });
    } finally { server.close(); }
  }

  const VALID = {
    display_name: 'Asha',
    greeting: { en: 'Hello! This is Sunrise Dental, how can I help you today?', hi: 'नमस्ते! सनराइज़ डेंटल में आपका स्वागत है।', te: 'నమస్తే! సన్‌రైజ్ డెంటల్‌కు స్వాగతం.' },
    tone: 'professional',
    response_length: 'concise',
    voice_speaker: 'ritu',
    pace: 1.1,
  };

  // ── Auth gate ───────────────────────────────────────────────────────────────
  it('unauthenticated GET → 401', async () => {
    const server = await start();
    try {
      const res = await req(server, { method: 'GET', path: '/portal/api/config/receptionist' });
      assert.equal(res.status, 401);
    } finally { server.close(); }
  });

  it('unauthenticated POST → 401 (and nothing written)', async () => {
    const server = await start();
    try {
      const before = await versionOf(ownerA.tenantId);
      const res = await req(server, { method: 'POST', path: '/portal/api/config/receptionist', body: VALID });
      assert.equal(res.status, 401);
      assert.equal(await versionOf(ownerA.tenantId), before, 'no write on an unauthenticated POST');
    } finally { server.close(); }
  });

  // ── GET ─────────────────────────────────────────────────────────────────────
  it('GET returns clinicDefaults for a fresh tenant — nothing blank that should have a safe default', async () => {
    const res = await get(ownerC);
    assert.equal(res.status, 200);
    assert.equal(res.body.receptionist.display_name, '', 'no self-intro name by default');
    assert.equal(res.body.receptionist.tone, 'warm', 'clinicDefaults style is warm_professional → "warm"');
    assert.equal(res.body.receptionist.response_length, 'standard');
    assert.equal(res.body.receptionist.voice_speaker, 'shubh', 'realigned default, matching the live voice worker');
    assert.equal(res.body.receptionist.pace, 1);
    assert.deepEqual(res.body.receptionist.languages.slice().sort(), ['en', 'hi', 'te']);
    assert.equal(res.body.receptionist.default_language, 'en');
    assert.ok(res.body.receptionist.greeting.en, 'default greeting is never blank');
    assert.ok(Array.isArray(res.body.speakers) && res.body.speakers.length > 0, 'the real speaker catalog is served');
    assert.ok(res.body.speakers.every((s) => typeof s.value === 'string'));
    assert.ok(!res.body.speakers.some((s) => s.value === 'anushka'), 'only the bulbul:v3 list, not legacy v2 speakers');
  });

  // ── Happy path ──────────────────────────────────────────────────────────────
  it('POST valid settings → new version, revision records the acting owner, cache invalidated, readiness returned', async () => {
    const before = await versionOf(ownerA.tenantId);
    const res = await post(ownerA, VALID);

    assert.equal(res.status, 200);
    assert.equal(res.body.version, before + 1);
    assert.equal(res.body.section.display_name, 'Asha');
    assert.equal(res.body.section.tone, 'professional');
    assert.equal(res.body.section.response_length, 'concise');
    assert.equal(res.body.section.voice_speaker, 'ritu');
    assert.equal(res.body.section.pace, 1.1);
    assert.equal(res.body.section.greeting.en, VALID.greeting.en);
    assert.ok(res.body.readiness && 'status' in res.body.readiness);

    const rev = await latestRevision(ownerA.tenantId);
    assert.equal(rev.version, res.body.version);
    assert.equal(rev.source, 'portal');
    assert.equal(rev.actor_user_id, ownerA.userId);

    const reget = await get(ownerA);
    assert.equal(reget.body.receptionist.display_name, 'Asha', 'cache invalidated — fresh GET shows the new value');
    assert.equal(reget.body.version, res.body.version);
  });

  // ── Tone mapping (the founder-approved 2-of-4 decision) ─────────────────────
  it('tone "professional" is stored as style "formal"; tone "warm" as style "warm_professional"', async () => {
    await post(ownerA, { ...VALID, tone: 'professional' });
    let cfg = await configService.getTenantConfig(ownerA.tenantId);
    assert.equal(cfg.personality.style, 'formal');

    await post(ownerA, { ...VALID, tone: 'warm' });
    cfg = await configService.getTenantConfig(ownerA.tenantId);
    assert.equal(cfg.personality.style, 'warm_professional');
  });

  it('a style set outside the portal (e.g. "friendly", via the admin JSON editor) still reads back as a safe "warm" — never crashes the page', async () => {
    // writeTenantConfig always materialises against clinicDefaults, never the
    // live document (S4 lesson) — a real admin editor reads current + merges
    // first, so this direct low-level call must too, or it wipes ownerA's
    // seeded config back to defaults.
    const current = await configService.getTenantConfig(ownerA.tenantId);
    await configService.writeTenantConfig(
      ownerA.tenantId,
      configService.deepMerge(current, { personality: { style: 'friendly' } }),
      'admin',
    );
    const res = await get(ownerA);
    assert.equal(res.status, 200);
    assert.equal(res.body.receptionist.tone, 'warm');
    await post(ownerA, VALID); // restore
  });

  // ── Greeting: required default, optional-fallback-by-copy for the rest ─────
  it('greeting is required for the default language → 400, no write, when it is blank', async () => {
    const before = await versionOf(ownerC.tenantId);
    const res = await post(ownerC, { ...VALID, greeting: { ...VALID.greeting, en: '' } });
    assert.equal(res.status, 400);
    assert.ok(res.body.fields.some((f) => f.field === 'greeting.en'));
    assert.equal(await versionOf(ownerC.tenantId), before);
  });

  it('leaving a non-default language blank materialises it as a COPY of the default line (schema requires non-empty per supported language)', async () => {
    const res = await post(ownerC, { ...VALID, greeting: { en: 'Custom hello for Charlie Clinic.', hi: '', te: '' } });
    assert.equal(res.status, 200);
    assert.equal(res.body.section.greeting.en, 'Custom hello for Charlie Clinic.');
    assert.equal(res.body.section.greeting.hi, 'Custom hello for Charlie Clinic.', 'hi falls back to the default line');
    assert.equal(res.body.section.greeting.te, 'Custom hello for Charlie Clinic.', 'te falls back to the default line');

    const cfg = await configService.getTenantConfig(ownerC.tenantId);
    const parsed = configService.configSchema.safeParse(cfg);
    assert.ok(parsed.success, 'every supported language still has a non-empty entry — the schema invariant holds');
  });

  // ── Bounds ───────────────────────────────────────────────────────────────────
  const REJECTED = [
    ['pace below 0.8', { pace: 0.5 }, 'pace'],
    ['pace above 1.2', { pace: 1.5 }, 'pace'],
    ['pace as a string', { pace: '1.0' }, 'pace'],
    ['an unknown speaker', { voice_speaker: 'invented-voice-9000' }, 'voice_speaker'],
    ['a legacy v2 speaker not offered by the portal', { voice_speaker: 'anushka' }, 'voice_speaker'],
    ['an unknown tone', { tone: 'sassy' }, 'tone'],
    ['an unknown response length', { response_length: 'verbose' }, 'response_length'],
    ['a display name over 80 characters', { display_name: 'x'.repeat(81) }, 'display_name'],
    ['a display name containing markup', { display_name: 'Asha <script>' }, 'display_name'],
    ['a greeting over 300 characters', { greeting: { ...VALID.greeting, en: 'x'.repeat(301) } }, 'greeting.en'],
    ['a greeting containing markup', { greeting: { ...VALID.greeting, en: 'Hello <b>there</b>' } }, 'greeting.en'],
  ];
  for (const [label, patch, field] of REJECTED) {
    it(`rejects ${label} → 400, no write`, async () => {
      const before = await versionOf(ownerC.tenantId);
      const res = await post(ownerC, { ...VALID, ...patch });
      assert.equal(res.status, 400, label);
      assert.ok(Array.isArray(res.body.fields));
      assert.ok(res.body.fields.some((f) => f.field === field), `error names ${field}, got: ${JSON.stringify(res.body.fields)}`);
      assert.equal(await versionOf(ownerC.tenantId), before, 'nothing was written');
    });
  }

  // ── READ-MERGE regression, including the partial-section wrinkle ───────────
  it('saving receptionist leaves identity/hours/pricing/booking/safety unchanged, AND preserves custom_instructions + voice.enabled/did/provider/sarvam_voice_id (partial-section merge)', async () => {
    const res = await post(ownerA, VALID);
    assert.equal(res.status, 200);

    const cfg = await configService.getTenantConfig(ownerA.tenantId);
    assert.equal(cfg.business.display_name, 'Sunrise Dental', 'identity survives');
    assert.deepEqual(cfg.hours.sun, { open: '10:00', close: '13:00' }, 'hours survive');
    assert.equal(cfg.pricing.consultation_fee, 500, 'pricing survives');
    assert.equal(cfg.booking.cancellation_policy, 'Call 4 hours before.', 'booking survives');
    assert.deepEqual(cfg.escalation.phone_numbers, ['+919000011111'], 'safety survives');

    // The wrinkle: personality and voice are PARTIALLY owned by this page.
    assert.equal(cfg.personality.custom_instructions, 'Always mention our 20th anniversary offer.',
      'custom_instructions is admin-only — this page must not touch it');
    assert.equal(cfg.voice.enabled, true, 'voice.enabled is not on this page');
    assert.equal(cfg.voice.did, '+911234567890', 'voice.did is not on this page');
    assert.equal(cfg.voice.provider, 'plivo');
    assert.equal(cfg.voice.sarvam_voice_id, 'bulbul:v3', 'voice.sarvam_voice_id is not on this page');
    // …while the fields it DOES own actually changed.
    assert.equal(cfg.voice.sarvam_speaker, 'ritu');
    assert.equal(cfg.voice.pace, 1.1);
  });

  // ── Cross-tenant (INV-1) ────────────────────────────────────────────────────
  it('a crafted tenantId is inert on read AND write — the session decides the tenant', async () => {
    const server = await start();
    try {
      const cookie = await authedCookie(server, ownerA.email, ownerA.password);
      const bVersion = await versionOf(ownerB.tenantId);

      const get = await req(server, {
        method: 'GET', path: `/portal/api/config/receptionist?tenantId=${ownerB.tenantId}`, cookie,
      });
      assert.equal(get.status, 200);
      assert.ok(!/Bravo/.test(get.body.receptionist.greeting.en), 'B’s greeting never crosses over');

      const write = await req(server, {
        method: 'POST', path: '/portal/api/config/receptionist', cookie,
        body: { ...VALID, tenantId: ownerB.tenantId, tenant_id: ownerB.tenantId, display_name: 'Alpha overwrote Bravo' },
      });
      assert.equal(write.status, 200);
      assert.equal(await versionOf(ownerB.tenantId), bVersion, 'B was not written');

      const bCfg = await configService.getTenantConfig(ownerB.tenantId);
      assert.equal(bCfg.greeting.en, 'Bravo Clinic here, how can we help?', 'B’s greeting is untouched');
      assert.notEqual(bCfg.personality.display_name, 'Alpha overwrote Bravo');
    } finally { server.close(); }
  });

  // ── Prompt integration ──────────────────────────────────────────────────────
  it('display name, greeting, tone and response length reach the rendered prompt verbatim, on both channels', async () => {
    const res = await post(ownerA, VALID);
    assert.equal(res.status, 200);

    for (const channel of ['whatsapp', 'voice']) {
      const prompt = await preview(ownerA.tenantId, channel);
      assert.ok(prompt.includes(VALID.greeting.en), `${channel}: greeting is verbatim`);
      assert.ok(prompt.includes('Polite and formal.'), `${channel}: tone "professional" renders the formal STYLE_LINE`);
      assert.ok(prompt.includes(`"${VALID.display_name}."`), `${channel}: the receptionist's own name appears`);
      assert.ok(prompt.includes('Never use this name to address the'), `${channel}: and the never-address-the-customer rule ships with it`);
    }
    // response_length: 'concise' adds the extra brevity line, channel-specific wording.
    assert.ok((await preview(ownerA.tenantId, 'voice')).includes('Keep answers to one short sentence whenever you can.'));
    assert.ok((await preview(ownerA.tenantId, 'whatsapp')).includes('Prefer the shortest complete answer — trim extra detail.'));
  });

  it('an empty name and "standard" length are SILENT — the prompt renders exactly as it did before PORTAL-P5-S13', async () => {
    await post(ownerA, { ...VALID, display_name: '', response_length: 'standard' });
    for (const channel of ['whatsapp', 'voice']) {
      const prompt = await preview(ownerA.tenantId, channel);
      assert.ok(!prompt.includes('introduce yourself by name'), `${channel}: no self-intro line with no name set`);
      assert.ok(!prompt.includes('Keep answers to one short sentence'), `${channel}: no extra brevity line at "standard"`);
      assert.ok(!prompt.includes('trim extra detail'), `${channel}: (whatsapp wording too)`);
    }
    await post(ownerA, VALID); // restore
  });

  it('tone "warm" renders the pre-existing warm_professional STYLE_LINE — unchanged prompt wording', async () => {
    await post(ownerA, { ...VALID, tone: 'warm' });
    const prompt = await preview(ownerA.tenantId);
    assert.ok(prompt.includes('Warm, professional, and reassuring.'));
    await post(ownerA, VALID); // restore
  });

  // ── KNOWN GAP: voice_speaker/pace are saved but never reach a live call ─────
  it('KNOWN GAP: /internal/voice/call/start does not carry voice_speaker or pace to the worker', async () => {
    await post(ownerA, { ...VALID, voice_speaker: 'kavitha', pace: 0.85 });
    const cfg = await configService.getTenantConfig(ownerA.tenantId);
    assert.equal(cfg.voice.sarvam_speaker, 'kavitha', 'the config really was saved');
    assert.equal(cfg.voice.pace, 0.85);

    const express = require('express');
    const app = express();
    delete require.cache[require.resolve('../../src/routes/internalVoice')];
    const SECRET = 'prcp-known-gap-secret';
    process.env.VOICE_INTERNAL_SECRET = SECRET;
    app.use('/internal/voice', require('../../src/routes/internalVoice'));
    const server = await listen(app);
    try {
      const raw = JSON.stringify({ tenant_id: ownerA.tenantId, caller_id: '+919812300000', channel: 'voice' });
      const httpRes = await fetch(`http://127.0.0.1:${server.address().port}/internal/voice/call/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-internal-signature': hmac.sign(raw, SECRET) },
        body: raw,
      });
      const json = await httpRes.json();
      assert.equal(httpRes.status, 200, JSON.stringify(json));
      assert.deepEqual(Object.keys(json).sort(), ['call_session_id', 'conversation_id', 'correlation_id', 'customer_id'],
        'the bridge response has no persona/voice fields at all today');
      assert.ok(!JSON.stringify(json).includes('kavitha'), 'the chosen speaker never reaches the bridge response');
    } finally {
      server.close();
    }
    await post(ownerA, VALID); // restore
  });
});
