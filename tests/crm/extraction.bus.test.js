require('dotenv').config();

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

// ── LLM seam stub ───────────────────────────────────────────────────
// extractionHandler instantiates GoogleGenerativeAI at module load, so the
// stub must be in the require cache BEFORE the handler is required.
const FIXED_EXTRACTION = {
  name: 'Bus Test Lead',
  requirement: '2BHK flat',
  budget: '50L',
  intent_level: 'high',
};

let llmCalls = 0;

const genaiPath = require.resolve('@google/generative-ai');
require.cache[genaiPath] = {
  id: genaiPath,
  filename: genaiPath,
  loaded: true,
  exports: {
    GoogleGenerativeAI: class {
      getGenerativeModel() {
        return {
          generateContent: async () => {
            llmCalls += 1;
            return { response: { text: () => JSON.stringify(FIXED_EXTRACTION) } };
          },
        };
      }
    },
  },
};

// ── logger stub — capture every level so skip logs (policy name, fallback
// WARNs) are assertable. Must be cached before any src module loads. ────
const logs = [];       // reset per test
const allErrors = [];  // NEVER reset — the whole-matrix "nothing errored" proof
const loggerPath = require.resolve('../../src/infra/logging/logger');
require.cache[loggerPath] = {
  id: loggerPath,
  filename: loggerPath,
  loaded: true,
  exports: {
    debug: (ctx, msg) => logs.push({ level: 'debug', ctx, msg }),
    info:  (ctx, msg) => logs.push({ level: 'info',  ctx, msg }),
    warn:  (ctx, msg) => logs.push({ level: 'warn',  ctx, msg }),
    error: (ctx, msg) => { logs.push({ level: 'error', ctx, msg }); allErrors.push({ ctx, msg }); },
  },
};

const db = require('../../src/db/db');
const eventBus = require('../../core/events');
const EVENT = require('../../core/eventTypes');
const { encrypt } = require('../../src/utils/encryption');
const configService = require('../../src/modules/config/configService');
const tenantService = require('../../src/modules/tenant/tenantService');
const workflowEngine = require('../../src/modules/workflow/workflowEngine');
const extractionHandler = require('../../src/modules/crm/extractionHandler');

const TENANT_ID = '00000000-0000-0000-0000-dddddddd0001';
const PHONE = '919990001234';

let customerId;
let conversationId;

// Every MESSAGE_RECEIVED envelope as the workflow wildcard subscriber sees it.
const wildcardSeen = [];

async function waitFor(cond, timeoutMs = 3000, stepMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cond()) return true;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  return cond();
}

// For skip cases: long enough for the setImmediate dispatch + the handler's
// awaited (cached) reads to have run.
const settle = () => new Promise((r) => setTimeout(r, 250));

async function leadRows() {
  const { rows } = await db.query(
    'SELECT * FROM leads WHERE tenant_id = $1 AND customer_id = $2',
    [TENANT_ID, customerId]
  );
  return rows;
}

// Production envelope shape (channels/index.js + internalVoice.js emits):
// channel + msg_type ride the event since Issue 30 (V-002).
function emitMsg(overrides = {}) {
  eventBus.emit(EVENT.MESSAGE_RECEIVED, {
    tenant_id: TENANT_ID,
    customer_id: customerId,
    conversation_id: conversationId,
    message_id: `ext-${Math.random().toString(36).slice(2)}`,
    text: 'I want a 2BHK flat, budget 50 lakh',
    mode: 'ai',
    channel: 'whatsapp',
    msg_type: 'text',
    ...overrides,
  });
}

function skipLog(policy) {
  return logs.find((l) => l.level === 'debug'
    && /skipped by policy/.test(l.msg) && l.ctx.policy === policy);
}

function fallbackWarn() {
  return logs.find((l) => l.level === 'warn' && l.ctx.scope === 'config_fallback');
}

describe('CRM extraction — per-channel policy gate on the real bus (V-002)', () => {
  before(async () => {
    // Cascade-clean any residue from a previous crashed run, then seed fresh.
    // wa_token must be a real ciphertext: the handler's ai_enabled guard rides
    // tenantService, which decrypts the token when it fills its cache.
    await db.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
    await db.query(
      `INSERT INTO tenants (id, business_name, phone_number_id, wa_token, active, ai_enabled)
       VALUES ($1, 'CRM Bus Test', 'pnid_crm_bus_test', $2, true, true)`,
      [TENANT_ID, encrypt('dummy-wa-token')]
    );
    const { rows: [customer] } = await db.query(
      'INSERT INTO customers (tenant_id, phone) VALUES ($1, $2) RETURNING id',
      [TENANT_ID, PHONE]
    );
    customerId = customer.id;
    const { rows: [conversation] } = await db.query(
      'INSERT INTO conversations (tenant_id, customer_id) VALUES ($1, $2) RETURNING id',
      [TENANT_ID, customerId]
    );
    conversationId = conversation.id;

    extractionHandler.init();
    // The real wildcard subscriber (workflow engine) rides along the whole
    // matrix: any throw on the new envelope fields would surface as an error
    // log, asserted against at the end.
    workflowEngine.init();
    eventBus.on('*', (env) => {
      if (env.type === EVENT.MESSAGE_RECEIVED) wildcardSeen.push(env);
    });
  });

  after(async () => {
    await db.query('DELETE FROM tenants WHERE id = $1', [TENANT_ID]);
    await db.close();
  });

  beforeEach(async () => {
    llmCalls = 0;
    logs.length = 0;
    await db.query('DELETE FROM leads WHERE tenant_id = $1', [TENANT_ID]);
  });

  it('negative control: an unrelated event does not invoke the extraction handler', async () => {
    eventBus.emit(EVENT.CALL_STARTED, {
      tenant_id: TENANT_ID,
      customer_id: customerId,
      conversation_id: conversationId,
      text: 'I want a 2BHK flat, budget 50 lakh',
      mode: 'ai',
    });
    await settle();

    assert.equal(llmCalls, 0, 'extraction must not run for unrelated events');
    assert.equal((await leadRows()).length, 0);
  });

  // ── Configless tenant (no tenant_configs row): clinicDefaults apply ──

  it('configless + whatsapp: defaults (per_message) run + config_fallback WARN', async () => {
    emitMsg();
    const ran = await waitFor(async () => llmCalls > 0 && (await leadRows()).length > 0);
    assert.ok(ran, 'whatsapp extraction must run on a configless tenant');

    const warn = fallbackWarn();
    assert.ok(warn, 'config_fallback WARN expected for a configless tenant');
    assert.equal(warn.ctx.reason, 'no_config');
    assert.equal(warn.ctx.policy, 'per_message');
  });

  it('configless + voice: defaults (off) skip, zero LLM calls', async () => {
    emitMsg({ channel: 'voice' });
    await settle();

    assert.equal(llmCalls, 0);
    assert.equal((await leadRows()).length, 0);
    assert.ok(fallbackWarn(), 'config_fallback WARN expected');
  });

  // ── Defaults config row written: whatsapp per_message, voice off ──

  it('whatsapp + defaults config: runs, lead written, source whatsapp (Issue 3 regression control)', async () => {
    await configService.writeTenantConfig(TENANT_ID, {}, 'test'); // materializes clinicDefaults
    logs.length = 0;

    emitMsg({ message_id: 'wamid.crm-bus-test-1' });
    const ran = await waitFor(async () => llmCalls > 0 && (await leadRows()).length > 0);
    assert.ok(ran, 'CRM handler never ran for the canonical message.received event');

    assert.equal(llmCalls, 1, 'handler must fire exactly once (single subscription)');
    assert.equal(fallbackWarn(), undefined, 'no fallback WARN with a config row present');

    const rows = await leadRows();
    assert.equal(rows.length, 1);
    const lead = rows[0];
    assert.equal(lead.tenant_id, TENANT_ID);
    assert.equal(lead.customer_id, customerId);
    assert.equal(lead.conversation_id, conversationId);
    assert.equal(lead.name, FIXED_EXTRACTION.name);
    assert.equal(lead.requirement, FIXED_EXTRACTION.requirement);
    assert.equal(lead.budget, FIXED_EXTRACTION.budget);
    assert.equal(lead.intent_level, FIXED_EXTRACTION.intent_level);
    assert.equal(lead.stage, 'new');
    assert.equal(lead.source, 'whatsapp');
  });

  it('voice + defaults config: skipped (policy off), zero LLM calls', async () => {
    emitMsg({ channel: 'voice' });
    await settle();

    assert.equal(llmCalls, 0, 'voice extraction must not run under default policy');
    assert.equal((await leadRows()).length, 0);
    assert.ok(skipLog('off'), 'skip log must name the policy');
  });

  it('voice + explicit per_message: runs, lead source voice', async () => {
    await configService.writeTenantConfig(TENANT_ID, { crm: { extraction: { voice: 'per_message' } } }, 'test');

    emitMsg({ channel: 'voice' });
    const ran = await waitFor(async () => llmCalls > 0 && (await leadRows()).length > 0);
    assert.ok(ran, 'voice extraction must run under explicit per_message');

    assert.equal((await leadRows())[0].source, 'voice', 'lead source is the envelope channel');
  });

  it('whatsapp + explicit off: skipped', async () => {
    await configService.writeTenantConfig(TENANT_ID, { crm: { extraction: { whatsapp: 'off' } } }, 'test');

    emitMsg();
    await settle();

    assert.equal(llmCalls, 0);
    assert.equal((await leadRows()).length, 0);
    assert.ok(skipLog('off'), 'skip log must name the policy');
  });

  it("voice + on_close: skipped-for-now, log names the policy", async () => {
    await configService.writeTenantConfig(TENANT_ID, { crm: { extraction: { whatsapp: 'per_message', voice: 'on_close' } } }, 'test');

    emitMsg({ channel: 'voice' });
    await settle();

    assert.equal(llmCalls, 0, 'on_close is a future feature — treated as skip');
    assert.equal((await leadRows()).length, 0);
    assert.ok(skipLog('on_close'), 'skip log must name on_close');
  });

  it('ai_enabled=false: skipped regardless of a per_message policy', async () => {
    await db.query('UPDATE tenants SET ai_enabled = false WHERE id = $1', [TENANT_ID]);
    tenantService.invalidateTenantCache(TENANT_ID);

    emitMsg(); // whatsapp per_message from the previous write
    await settle();

    assert.equal(llmCalls, 0, 'ai_enabled=false must silence extraction');
    assert.equal((await leadRows()).length, 0);

    await db.query('UPDATE tenants SET ai_enabled = true WHERE id = $1', [TENANT_ID]);
    tenantService.invalidateTenantCache(TENANT_ID);
  });

  it('non-text msg_type: skipped before any policy or LLM work', async () => {
    emitMsg({ msg_type: 'image', text: '[image]' });
    await settle();

    assert.equal(llmCalls, 0);
    assert.equal((await leadRows()).length, 0);
  });

  it('missing msg_type on the envelope: skipped with a WARN (contract violation)', async () => {
    emitMsg({ msg_type: undefined });
    await settle();

    assert.equal(llmCalls, 0);
    assert.ok(
      logs.find((l) => l.level === 'warn' && /no msg_type/.test(l.msg)),
      'missing msg_type must WARN, not silently skip'
    );
  });

  it('missing channel on the envelope: skipped with a WARN (contract violation, never inferred)', async () => {
    emitMsg({ channel: undefined });
    await settle();

    assert.equal(llmCalls, 0);
    assert.ok(
      logs.find((l) => l.level === 'warn' && /no channel/.test(l.msg)),
      'missing channel must WARN, not guess'
    );
  });

  it('empty-string text with msg_type text: existing behavior unchanged (extraction still runs)', async () => {
    emitMsg({ text: '' });
    const ran = await waitFor(async () => llmCalls > 0);
    assert.ok(ran, 'empty content passes the gate exactly as before Issue 30');
  });

  it('stale pre-schema config doc: Issue 8 WARN path + clinicDefaults for the missing field', async () => {
    // Inject a stored doc that predates the crm section entirely.
    await db.query('DELETE FROM tenant_config_revisions WHERE tenant_id = $1', [TENANT_ID]);
    await db.query('DELETE FROM tenant_configs WHERE tenant_id = $1', [TENANT_ID]);
    await db.query(
      `INSERT INTO tenant_configs (tenant_id, version, config, updated_at)
       VALUES ($1, 1, $2, now())`,
      [TENANT_ID, JSON.stringify({ business: { display_name: 'Stale Doc Clinic' } })]
    );
    configService.invalidateConfigCache(TENANT_ID);

    emitMsg({ channel: 'voice' });
    await settle();

    assert.equal(llmCalls, 0, 'voice falls back to the default off policy');
    assert.ok(
      logs.find((l) => l.level === 'warn' && /failed current schema/.test(l.msg)),
      'Issue 8 stale-schema WARN fires on the read'
    );
    const warn = fallbackWarn();
    assert.ok(warn, 'config_fallback WARN for the missing field');
    assert.equal(warn.ctx.reason, 'field_missing');
  });

  it('wildcard subscriber sees channel + msg_type; no handler errored anywhere in the matrix', async () => {
    assert.ok(wildcardSeen.length > 0, 'wildcard listener observed the matrix emits');
    // The matrix deliberately emits malformed envelopes (missing channel /
    // msg_type) to prove the handler's contract WARNs — exclude those; the
    // propagation claim is about well-formed production-shape envelopes.
    const carried = wildcardSeen.filter(
      (env) => env.payload.channel !== undefined && env.payload.msg_type !== undefined);
    assert.ok(carried.length > 0, 'the new fields propagate through the wildcard fan-out');
    assert.ok(carried.some((env) => env.payload.channel === 'whatsapp'));
    assert.ok(carried.some((env) => env.payload.channel === 'voice'));
    // The REAL workflow engine consumed every one of these envelopes; any
    // throw on the additive fields would have logged at error level.
    assert.deepEqual(
      allErrors.filter((l) => /workflow/.test(l.msg)), [],
      'workflow wildcard subscriber is inert to the new fields'
    );
  });

  it('warm caches: the gate adds ZERO DB queries (no tenants / tenant_configs reads)', async () => {
    await configService.writeTenantConfig(TENANT_ID, {}, 'test'); // valid defaults doc again
    // Warm both caches exactly as a live WA message would have.
    await configService.getTenantConfig(TENANT_ID);
    await tenantService.getById(TENANT_ID);

    const seen = [];
    const origQuery = db.query;
    db.query = (text, params) => {
      seen.push(text);
      return origQuery(text, params);
    };
    try {
      emitMsg();
      const ran = await waitFor(async () => llmCalls > 0 && (await leadRows()).length > 0);
      assert.ok(ran, 'extraction ran');
    } finally {
      db.query = origQuery;
    }

    const gateQueries = seen.filter((t) => /tenant_configs|FROM tenants/i.test(t));
    assert.deepEqual(gateQueries, [], 'policy + ai_enabled reads must ride the caches');
  });
});
