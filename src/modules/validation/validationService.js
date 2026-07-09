'use strict';

// Validation service (Issue 16) — the STATIC go/no-go gate for a tenant.
//
// `validateTenant(tenantId, opts)` runs a frozen catalog of small, pure-ish
// checks (config integrity, prompt rendering, hours, numbers, consent, KB
// presence + retrieval smoke, WhatsApp/voice credentials), each yielding a
// severity of `fail | warn | pass`. The run PASSES iff zero checks fail; warns
// are surfaced, never blocking. Every run — even an all-skipped one — is
// persisted verbatim to `validation_runs`; "passed" must never silently mean
// "partially ran", so every skipped check is named with a reason.
//
// Contract (frozen for Issue 17's activation guard + the panel history):
//   • Check NAMES in CHECKS below are a downstream key — do not rename.
//   • Stored `result` shape: { checks:[{name,severity,passed,detail}],
//     skipped:[{name,reason}], duration_ms, service_version }.
//
// READ-ONLY except one write: the `validation_runs` INSERT. No status writes,
// no config writes, no cache pokes. The service NEVER throws on a broken tenant
// — a check that throws records `fail` + `internal_error…` and the run
// continues. (It DOES throw for a non-existent tenant: there's no valid FK to
// persist a run against — the CLI resolves slug/id to an existing tenant first.)

const db = require('../../db/db');
const { getTenantConfig, configSchema } = require('../config/configService');
const { renderSystemPrompt, estimateTokens } = require('../prompts');
const { getRelevantChunks } = require('../knowledge/knowledgeService');
const { pingNumber } = require('../channels/whatsapp/sender');
const { decrypt } = require('../../utils/encryption');

const SERVICE_VERSION = '1.0.0';

// E.164: leading '+', a non-zero country digit, then up to 14 more digits.
const E164_RE = /^\+[1-9]\d{1,14}$/;

// Estimated system-prompt token budgets, per channel. Over budget → WARN
// (never a fail): a fat prompt is a cost/latency smell, not a correctness bug.
// Voice pays prompt tokens on every turn (700 mirrors the renderer's budget
// test); WhatsApp carries the fuller wording and gets more headroom.
const TOKEN_BUDGET = { voice: 700, whatsapp: 1500 };

// The guardrail's anchor line — present in BOTH channel renders (see
// prompts/templates/clinic guardrailBlock). Its absence means the safety text
// didn't render, which is a hard fail.
const GUARDRAIL_ANCHOR = 'Medical safety rules';

const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const pass = (detail) => ({ severity: 'pass', detail });
const warn = (detail) => ({ severity: 'warn', detail });
const fail = (detail) => ({ severity: 'fail', detail });

// ── Check catalog ────────────────────────────────────────────────────────────
// Each entry: { name, fn(ctx), requiresConfig?, channel?, gate?, skippable? }.
//   requiresConfig  — auto-skip (prerequisite_failed) when the tenant has no config.
//   gate(config)    — enabled-driven skip when it returns false (channel toggled off).
//   skippable       — may be named in opts.skip (explicit skip).
// Order matters: checks run top-to-bottom; kb.retrieval keys off kb.populated's
// skip decision, so kb.populated must precede it.
const CHECKS = [
  { name: 'config.exists', fn: checkConfigExists },
  { name: 'config.schema', requiresConfig: true, fn: checkConfigSchema },
  { name: 'prompt.renders', requiresConfig: true, fn: checkPromptRenders },
  { name: 'hours.sane', requiresConfig: true, fn: checkHoursSane },
  { name: 'numbers.e164', requiresConfig: true, fn: checkNumbers },
  { name: 'consent.lines', requiresConfig: true, fn: checkConsent },
  { name: 'kb.populated', skippable: true, fn: checkKbPopulated },
  { name: 'kb.retrieval', skippable: true, fn: checkKbRetrieval },
  { name: 'whatsapp.config', requiresConfig: true, channel: 'whatsapp',
    gate: (c) => !!(c.whatsapp && c.whatsapp.enabled), fn: checkWhatsappConfig },
  { name: 'whatsapp.live', requiresConfig: true, channel: 'whatsapp', skippable: true,
    gate: (c) => !!(c.whatsapp && c.whatsapp.enabled), fn: checkWhatsappLive },
  { name: 'voice.config', requiresConfig: true, channel: 'voice',
    gate: (c) => !!(c.voice && c.voice.enabled), fn: checkVoiceConfig },
  { name: 'tenant.legacy_prompt', fn: checkLegacyPrompt },
];

const CHECK_NAMES = CHECKS.map((c) => c.name);

// ── Individual checks ────────────────────────────────────────────────────────
// Every fn is (ctx) => { severity, detail }. ctx = { tenantId, config, tenant,
// deps, kbMin }. `config` is the stored doc (possibly null / stale-schema —
// getTenantConfig returns stale docs as-is); checks defend accordingly.

function checkConfigExists(ctx) {
  return ctx.config
    ? pass('tenant_configs row present')
    : fail('no tenant_configs row for this tenant');
}

function checkConfigSchema(ctx) {
  const parsed = configSchema.safeParse(ctx.config);
  if (parsed.success) return pass('config matches current schema');
  const paths = parsed.error.issues.map((i) => i.path.join('.') || '(root)');
  return fail(`config fails current schema at: ${[...new Set(paths)].join(', ')}`);
}

function checkPromptRenders(ctx) {
  const cfg = ctx.config;
  const supported = (cfg.languages && Array.isArray(cfg.languages.supported) && cfg.languages.supported.length)
    ? cfg.languages.supported : ['en'];

  // Render for the channels this tenant actually serves (fall back to WhatsApp
  // so the check is never vacuous). Preview-style lang override: clone the doc
  // and swap languages.default, exactly like the panel's prompt-preview route.
  const channels = [];
  if (cfg.whatsapp && cfg.whatsapp.enabled) channels.push('whatsapp');
  if (cfg.voice && cfg.voice.enabled) channels.push('voice');
  if (channels.length === 0) channels.push('whatsapp');

  const overBudget = [];
  for (const channel of channels) {
    for (const lang of supported) {
      const preview = structuredClone(cfg);
      preview.languages = preview.languages || {};
      preview.languages.default = lang;
      const prompt = renderSystemPrompt(preview, { channel }); // may throw → caught by runner → internal_error fail
      if (!prompt || !prompt.trim()) {
        return fail(`empty render for ${channel}/${lang}`);
      }
      if (!prompt.includes(GUARDRAIL_ANCHOR)) {
        return fail(`guardrail text missing from ${channel}/${lang} render`);
      }
      const est = estimateTokens(prompt);
      const budget = ctx.budgets[channel];
      if (est > budget) overBudget.push(`${channel}/${lang} ≈${est}>${budget}`);
    }
  }
  const combos = channels.length * supported.length;
  if (overBudget.length) {
    return warn(`renders OK (${combos} channel×lang), but over token budget: ${overBudget.join(', ')}`);
  }
  return pass(`renders non-empty + guardrail-anchored across ${combos} channel×lang combos`);
}

function checkHoursSane(ctx) {
  const hours = ctx.config.hours;
  if (!hours || typeof hours !== 'object') return fail('hours block missing');
  let openDays = 0;
  for (const day of DAYS) {
    const d = hours[day];
    if (!d || typeof d !== 'object') return fail(`hours.${day} missing`);
    if (d.closed === true) continue;
    if (!HHMM_RE.test(d.open) || !HHMM_RE.test(d.close)) {
      return fail(`hours.${day} not a valid HH:MM open/close pair`);
    }
    if (d.open >= d.close) return fail(`hours.${day} has open >= close (${d.open}–${d.close})`);
    openDays += 1;
  }
  if (openDays === 0) return fail('no open days — the clinic is closed all week');
  return pass(`${openDays} open day(s), all intervals valid`);
}

function checkNumbers(ctx) {
  const cfg = ctx.config;
  const owner = (cfg.notifications && cfg.notifications.owner_numbers) || [];
  const esc = (cfg.escalation && cfg.escalation.phone_numbers) || [];
  const escEnabled = !!(cfg.escalation && cfg.escalation.enabled);

  const bad = [];
  for (const n of owner) if (!E164_RE.test(n)) bad.push(`owner:${n}`);
  for (const n of esc) if (!E164_RE.test(n)) bad.push(`escalation:${n}`);
  if (bad.length) return fail(`invalid E.164 number(s): ${bad.join(', ')}`);

  if (owner.length === 0) return fail('at least one owner notification number is required');
  if (escEnabled && esc.length === 0) {
    return fail('escalation.enabled is true but no escalation numbers are set');
  }
  return pass(`${owner.length} owner + ${esc.length} escalation number(s) valid`);
}

function checkConsent(ctx) {
  const rc = ctx.config.recording_consent;
  if (!rc || !rc.enabled) return pass('recording consent disabled — no lines required');
  const supported = (ctx.config.languages && ctx.config.languages.supported) || [];
  const line = rc.line || {};
  const missing = supported.filter((l) => typeof line[l] !== 'string' || line[l].trim().length === 0);
  if (missing.length) return fail(`consent enabled but no line for: ${missing.join(', ')}`);
  return pass(`consent line present for all ${supported.length} supported language(s)`);
}

async function checkKbPopulated(ctx) {
  const { rows } = await db.query(
    'SELECT count(*)::int AS n FROM knowledge_chunks WHERE tenant_id = $1', [ctx.tenantId]);
  const n = rows[0].n;
  if (n < ctx.kbMin) return fail(`only ${n} knowledge chunk(s); need ≥ ${ctx.kbMin}`);
  return pass(`${n} knowledge chunk(s) (≥ ${ctx.kbMin})`);
}

async function checkKbRetrieval(ctx) {
  const query = 'what are your timings';
  const chunks = await ctx.deps.getRelevantChunks(ctx.tenantId, query, 1);
  if (!chunks || chunks.length === 0) {
    return fail(`retrieval for "${query}" returned no chunks`);
  }
  return pass(`retrieval returned ${chunks.length} chunk(s) for a canned query`);
}

function checkWhatsappConfig(ctx) {
  const t = ctx.tenant;
  const missing = [];
  if (!t.phone_number_id) missing.push('phone_number_id');
  if (!t.waba_id) missing.push('waba_id');
  if (missing.length) return fail(`WhatsApp enabled but missing: ${missing.join(', ')}`);
  if (!t.wa_token) return fail('WhatsApp enabled but wa_token is not set');
  try {
    decrypt(t.wa_token);
  } catch (e) {
    return fail(`wa_token failed to decrypt (${e.message})`);
  }
  return pass('phone_number_id + waba_id present, wa_token decrypts');
}

async function checkWhatsappLive(ctx) {
  const t = ctx.tenant;
  if (!t.phone_number_id || !t.wa_token) {
    return fail('cannot ping: phone_number_id or wa_token missing');
  }
  let token;
  try {
    token = decrypt(t.wa_token);
  } catch (e) {
    return fail(`wa_token failed to decrypt (${e.message})`);
  }
  const name = await ctx.deps.pingNumber({ phone_number_id: t.phone_number_id, wa_token: token });
  return pass(`Meta API ping OK (${name})`);
}

function checkVoiceConfig(ctx) {
  const v = ctx.config.voice || {};
  if (!v.did) return fail('voice enabled but no DID is set');
  if (!E164_RE.test(v.did)) return fail(`voice DID is not E.164: ${v.did}`);
  if (!v.sarvam_speaker || !String(v.sarvam_speaker).trim()) {
    return fail('voice enabled but sarvam_speaker is not set');
  }
  return pass(`DID ${v.did} valid, speaker '${v.sarvam_speaker}' set`);
}

function checkLegacyPrompt(ctx) {
  const legacy = ctx.tenant.ai_prompt;
  if (legacy && String(legacy).trim().length > 0) {
    return warn('legacy ai_prompt is set — the config-driven renderer is dormant for this tenant');
  }
  return pass('no legacy ai_prompt override');
}

// ── Skip decision ────────────────────────────────────────────────────────────
// Returns a reason string when a check should be skipped, else null. Precedence:
// explicit (--skip) → prerequisite (no config) → kb.retrieval's dependency on
// kb.populated → enabled-driven (channel gate). Every skip is recorded so a
// "passed" run can always be audited for what it did NOT run.
function skipReason(def, ctx, skipSet, skippedNames) {
  if (def.skippable && skipSet.has(def.name)) return 'explicitly skipped (--skip)';
  if (def.requiresConfig && !ctx.config) return 'prerequisite_failed: config.exists failed';
  if (def.name === 'kb.retrieval' && skippedNames.has('kb.populated')) {
    return 'kb.populated was skipped';
  }
  if (def.gate && ctx.config && !def.gate(ctx.config)) {
    return `${def.channel}.enabled is false`;
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

// Run the static catalog against a tenant and persist the result.
//
//   opts.skip   — array of skippable check names to explicitly skip.
//   opts.kbMin  — knowledge-chunk threshold for kb.populated (default 5).
//   opts.deps   — override { getRelevantChunks, pingNumber } (tests inject
//                 mocks / poison a check to prove throw-isolation).
//
// Returns { passed, checks, skipped, duration_ms, service_version } — the same
// object stored in validation_runs.result (plus the top-level `passed`).
async function validateTenant(tenantId, opts = {}) {
  if (!tenantId) throw new Error('validateTenant: tenantId is required');
  const started = Date.now();

  const { rows: trows } = await db.query(
    `SELECT id, ai_prompt, phone_number_id, wa_token, waba_id, status
     FROM tenants WHERE id = $1`, [tenantId]);
  const tenant = trows[0];
  if (!tenant) throw new Error(`validateTenant: tenant not found: ${tenantId}`);

  const config = await getTenantConfig(tenantId); // null when configless; stale docs returned as-is

  const ctx = {
    tenantId,
    config,
    tenant,
    kbMin: opts.kbMin != null ? opts.kbMin : 5,
    // Per-channel token budgets; opts.tokenBudget overrides (tests exercise the
    // over-budget WARN without contorting a config past the schema's char caps).
    budgets: { ...TOKEN_BUDGET, ...(opts.tokenBudget || {}) },
    deps: {
      getRelevantChunks,
      pingNumber,
      ...(opts.deps || {}),
    },
  };

  const skipSet = new Set(opts.skip || []);
  const skippedNames = new Set();
  const checks = [];
  const skipped = [];

  for (const def of CHECKS) {
    const reason = skipReason(def, ctx, skipSet, skippedNames);
    if (reason) {
      skipped.push({ name: def.name, reason });
      skippedNames.add(def.name);
      continue;
    }
    let severity, detail;
    try {
      const r = await def.fn(ctx);
      severity = r.severity;
      detail = r.detail;
    } catch (err) {
      // A broken check must never sink the run — record it as a fail and go on.
      severity = 'fail';
      detail = `internal_error: ${err.message}`;
    }
    checks.push({ name: def.name, severity, passed: severity !== 'fail', detail });
  }

  const passed = checks.every((c) => c.severity !== 'fail');
  const result = {
    checks,
    skipped,
    duration_ms: Date.now() - started,
    service_version: SERVICE_VERSION,
  };

  await db.query(
    'INSERT INTO validation_runs (tenant_id, passed, result) VALUES ($1, $2, $3)',
    [tenantId, passed, JSON.stringify(result)]);

  return { passed, ...result };
}

// Latest run for a tenant (Issue 17's activation guard reads this). Returns
// { id, passed, result, created_at } or null when the tenant has never been run.
async function getLatestValidation(tenantId) {
  if (!tenantId) return null;
  const { rows } = await db.query(
    `SELECT id, passed, result, created_at
     FROM validation_runs WHERE tenant_id = $1
     ORDER BY created_at DESC LIMIT 1`, [tenantId]);
  return rows[0] || null;
}

module.exports = {
  validateTenant,
  getLatestValidation,
  CHECK_NAMES,
  SERVICE_VERSION,
  TOKEN_BUDGET,
};
