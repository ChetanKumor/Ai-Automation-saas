'use strict';

// turn.scripted (Issue 17) — the ONE dynamic check in the validation catalog.
//
// Drives a scripted booking conversation through the real brain (the same
// aiService.generateReply + booking tools + guards the voice turn calls, with
// channel='voice') against a SYNTHETIC customer identity, then proves:
//
//   1. the model answered (reply non-empty),
//   2. the booking tool actually fired (tool-call evidence from the metrics seam),
//   3. an appointment row was really written,
//   4. per-turn latency (recorded in the detail), and
//   5. the synthetic customer + every row it produced is GONE afterwards.
//
// ── Why not POST /internal/voice/turn? ───────────────────────────────────────
// The PR7 HTTP handlers re-resolve the tenant with `AND active = true` (see
// internalVoice.js). Validation runs BEFORE activation — a draft tenant is
// active=false, so the route would 404 by design. This check therefore invokes
// the same turn CORE the route invokes (persist inbound → assemble context →
// generateReply(channel:'voice') → persist outbound) while skipping the HTTP/
// HMAC shell and the active gate. That gate is precisely what activation flips,
// and it is proven separately (the paused-gate live proof). Honest boundary:
// this check does NOT exercise HMAC auth or the call_sessions bridge.
//
// ── Deliberate divergences from the route, and why ───────────────────────────
// • The probe emits NO domain events at all. The route emits MESSAGE_RECEIVED,
//   and identityService.resolveCustomer emits CUSTOMER_CREATED/CUSTOMER_IDENTIFIED.
//   workflowEngine.init() subscribes to `'*'` (every event) in the server process,
//   so an emitted event would match any enabled workflow_rule on this tenant and
//   RUN ITS REAL ACTION for a fake patient — and write a `workflow_executions`
//   row that is tenant-scoped with no customer FK, so it would never cascade away.
//   CRM extraction listens on MESSAGE_RECEIVED for the same reason. So we create
//   the synthetic identity with direct INSERTs and persist messages by hand: no
//   bus, no automations, no CRM, no timeline.
// • owner_notify_phone is forced null on the tenant copy handed to the brain, so
//   a synthetic booking can never send a real WhatsApp to a real owner. The
//   booking still INSERTs a `notifications` row (that write precedes the phone
//   check inside notificationService) — and `notifications` is tenant-scoped with
//   no customer FK, so it does NOT cascade. We delete it explicitly.
//
// ── Why the probe cannot race real traffic ───────────────────────────────────
// Validation only ever runs on a NON-SERVING tenant: lifecycleService refuses to
// validate a `live` tenant, and every other status (draft/validated/paused) has
// active=false, which is exactly the gate tenantService.getByPhoneNumberId honors.
// So while the probe holds a slot (uniq_doctor_slot) or a notification row is in
// flight, no real customer of this tenant can book or message. That is what makes
// the id-diff notification cleanup below exact rather than merely likely.
//
// ── Cleanup topology (verified against schema.sql) ───────────────────────────
// `DELETE FROM customers` cascades to conversations, messages, appointments,
// call_sessions, channel_identifiers, customer_memory, customer_tags and leads
// (all `customer_id … ON DELETE CASCADE`). `notifications` does not — hence the
// explicit delete, performed BEFORE the customer delete (reverse order). The
// check re-counts every table afterwards and FAILS if anything survived: leaving
// synthetic rows behind is worse than a failed validation.

const db = require('../../db/db');
const appointmentService = require('../appointment/appointmentService');
const aiService = require('../ai/aiService');
const conversationService = require('../conversation/conversationService');
const { assembleConversationContext } = require('../conversation/contextAssembler');

// A reserved, clearly-fake, E.164-valid number. NANP area code 999 is permanently
// unassigned and 555-01xx is the reserved fictional exchange, so this can never
// be a real customer's phone. Paranoia (§12) still applies: if ANY row already
// exists for it we abort with a fail rather than adopt a real thread.
const SYNTHETIC_PHONE = '+19995550100';
const SYNTHETIC_NAME = 'Zyon Validation Probe';

// How many scripted user turns we are willing to spend getting to a booking. The
// system prompt mandates "confirm first, book second", so a booking needs ≥2.
const MAX_TURNS = 3;

// How far ahead to hunt for a free slot. We scan from the FURTHEST day backwards
// and take the LAST free slot of the first day that has one: a probe booking
// briefly occupies a real slot (uniq_doctor_slot), so it should sit as far from
// a real customer's likely choice as possible. The row is deleted seconds later.
const SCAN_DAYS = 14;

const IST = 'Asia/Kolkata';

const pass = (detail) => ({ severity: 'pass', detail });
const fail = (detail) => ({ severity: 'fail', detail });

function istDateString(daysAhead) {
  return new Date(Date.now() + daysAhead * 86400000).toLocaleDateString('en-CA', { timeZone: IST });
}

// Collector implementing the two methods aiService.generateReply calls on
// `metrics`. This is the tool-call evidence seam: every executed tool lands here
// with its name and latency, so "the booking tool was invoked" is observed, not
// inferred from the row alone.
function makeCollector() {
  return {
    toolCalls: [],
    geminiCalls: [],
    recordGeminiCall({ latency_ms }) { this.geminiCalls.push(latency_ms); },
    recordToolExec(name, latency_ms) { this.toolCalls.push({ name, latency_ms }); },
  };
}

// Furthest-first hunt for a bookable slot from the tenant's own schedules.
// Returns { doctor, date, time, iso } or null.
async function findFreeSlot(tenantId, deps) {
  for (let d = SCAN_DAYS; d >= 1; d--) {
    const date = istDateString(d);
    const res = await deps.checkAvailability(tenantId, date);
    if (!res || res.error || !Array.isArray(res.available)) continue;
    for (const entry of res.available) {
      if (entry.free_slots && entry.free_slots.length) {
        const time = entry.free_slots[entry.free_slots.length - 1]; // last slot of the day
        return { doctor: entry.doctor, date, time, iso: `${date}T${time}:00+05:30` };
      }
    }
  }
  return null;
}

// Has the reserved number already got rows under this tenant? If so we must NOT
// proceed: resolveCustomer would adopt that thread and cleanup would delete a
// real customer.
async function collision(tenantId) {
  const { rows: cust } = await db.query(
    'SELECT id FROM customers WHERE tenant_id = $1 AND phone = $2', [tenantId, SYNTHETIC_PHONE]);
  if (cust[0]) return `customers.id=${cust[0].id}`;
  const { rows: ci } = await db.query(
    'SELECT customer_id FROM channel_identifiers WHERE tenant_id = $1 AND identifier = $2',
    [tenantId, SYNTHETIC_PHONE]);
  if (ci[0]) return `channel_identifiers.customer_id=${ci[0].customer_id}`;
  return null;
}

// Create the synthetic identity WITHOUT going through identityService, whose
// resolveCustomer emits CUSTOMER_CREATED onto the bus that workflowEngine
// subscribes to with `'*'`. Direct INSERTs keep the probe silent. Mirrors the
// columns resolveCustomer would have written.
async function createSyntheticIdentity(tenantId) {
  const { rows } = await db.query(
    `INSERT INTO customers (tenant_id, phone, name, last_seen_at)
     VALUES ($1, $2, $3, NOW()) RETURNING *`,
    [tenantId, SYNTHETIC_PHONE, SYNTHETIC_NAME]);
  const customer = rows[0];
  await db.query(
    `INSERT INTO channel_identifiers (tenant_id, customer_id, channel_type, identifier)
     VALUES ($1, $2, 'voice', $3)
     ON CONFLICT (tenant_id, channel_type, identifier) DO NOTHING`,
    [tenantId, customer.id, SYNTHETIC_PHONE]);
  return customer;
}

// The booked appointment (if any) belonging to the synthetic customer.
async function bookedAppointment(tenantId, customerId) {
  const { rows } = await db.query(
    `SELECT id, doctor_name, appointment_time FROM appointments
     WHERE tenant_id = $1 AND customer_id = $2 AND status = 'booked'
     ORDER BY created_at DESC LIMIT 1`, [tenantId, customerId]);
  return rows[0] || null;
}

// Booking notifications the probe itself created = every appointment_booked row
// for this tenant that did not exist before the probe started.
//
// We identify them by ID DIFF, not by matching the patient name in `content`:
// notificationService builds that string from the model-chosen `patient_name`
// argument, which the model may paraphrase or re-case — a name match would then
// silently fail to find the row, and the residue check (using the same match)
// would report a clean zero over a leaked row. The id diff cannot lie. It is
// exact rather than merely likely because a non-serving tenant cannot receive a
// concurrent real booking (see the header).
async function bookingNotificationIds(tenantId, excludeIds = []) {
  const { rows } = await db.query(
    `SELECT id FROM notifications
     WHERE tenant_id = $1 AND type = 'appointment_booked'
       AND NOT (id = ANY($2::uuid[]))`,
    [tenantId, excludeIds]);
  return rows.map((r) => r.id);
}

// aiService fires notifyOwnerOfBooking WITHOUT awaiting it (`.catch()` only), so
// its notifications INSERT races our teardown. When we know a booking happened we
// wait (bounded) for that row to land before deleting — otherwise it could be
// written a moment AFTER cleanup and stay behind forever.
async function waitForBookingNotification(tenantId, preIds, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await bookingNotificationIds(tenantId, preIds)).length > 0) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// Reverse-order teardown: the one table that does NOT cascade first, then the
// customer (whose cascade takes everything else). Safe to call twice.
async function cleanupSynthetic(tenantId, customerId, { booked, preNotifIds } = {}) {
  if (booked) await waitForBookingNotification(tenantId, preNotifIds);
  await db.query(
    `DELETE FROM notifications
     WHERE tenant_id = $1 AND type = 'appointment_booked'
       AND NOT (id = ANY($2::uuid[]))`,
    [tenantId, preNotifIds]);
  await db.query('DELETE FROM customers WHERE id = $1 AND tenant_id = $2', [customerId, tenantId]);
}

// Post-teardown proof. Every count must be zero.
const RESIDUE_TABLES = [
  ['customers', 'SELECT count(*)::int AS n FROM customers WHERE tenant_id = $1 AND id = $2'],
  ['conversations', 'SELECT count(*)::int AS n FROM conversations WHERE tenant_id = $1 AND customer_id = $2'],
  ['messages', 'SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND customer_id = $2'],
  ['appointments', 'SELECT count(*)::int AS n FROM appointments WHERE tenant_id = $1 AND customer_id = $2'],
  ['call_sessions', 'SELECT count(*)::int AS n FROM call_sessions WHERE tenant_id = $1 AND customer_id = $2'],
  ['channel_identifiers', 'SELECT count(*)::int AS n FROM channel_identifiers WHERE tenant_id = $1 AND customer_id = $2'],
  ['customer_memory', 'SELECT count(*)::int AS n FROM customer_memory WHERE tenant_id = $1 AND customer_id = $2'],
  ['leads', 'SELECT count(*)::int AS n FROM leads WHERE tenant_id = $1 AND customer_id = $2'],
];

async function residue(tenantId, customerId, preNotifIds) {
  const out = {};
  for (const [name, sql] of RESIDUE_TABLES) {
    const { rows } = await db.query(sql, [tenantId, customerId]);
    out[name] = rows[0].n;
  }
  // notifications has no customer_id — count the rows the probe itself added.
  out.notifications = (await bookingNotificationIds(tenantId, preNotifIds)).length;
  return out;
}

// One scripted user turn through the turn core: persist inbound, assemble the
// same context the route assembles, run the brain, persist outbound.
async function runOneTurn(deps, tenantForBrain, customer, conversation, transcript, collector) {
  const { id: tenantId } = tenantForBrain;
  await db.query(
    `INSERT INTO messages (tenant_id, conversation_id, customer_id, direction, sender, content, channel, msg_type)
     VALUES ($1, $2, $3, 'inbound', 'customer', $4, 'voice', 'text')`,
    [tenantId, conversation.id, customer.id, transcript]);

  const { knowledgeChunks, history, facts } = await deps.assembleConversationContext({
    tenantId, conversationId: conversation.id, customerId: customer.id, text: transcript,
  });

  const t0 = Date.now();
  const reply = await deps.generateReply(
    tenantForBrain, customer, conversation, transcript, history, knowledgeChunks, facts,
    { channel: 'voice', metrics: collector });
  const latency = Date.now() - t0;

  await db.query(
    `INSERT INTO messages (tenant_id, conversation_id, customer_id, direction, sender, content, channel, msg_type)
     VALUES ($1, $2, $3, 'outbound', 'ai', $4, 'voice', 'text')`,
    [tenantId, conversation.id, customer.id, reply]);

  return { reply, latency };
}

// ── The check ────────────────────────────────────────────────────────────────
// ctx = { tenantId, config, tenant, deps } (validationService's ctx). Returns
// { severity, detail }. Throwing is allowed — the runner records it as an
// internal_error fail — but we go out of our way to clean up first.
async function runScriptedTurn(ctx) {
  const { tenantId, tenant } = ctx;
  const deps = {
    getSchedules: appointmentService.getSchedules,
    checkAvailability: appointmentService.checkAvailability,
    generateReply: aiService.generateReply,
    createSyntheticIdentity,
    getOrCreateOpenConversation: conversationService.getOrCreateOpenConversation,
    assembleConversationContext,
    ...(ctx.deps || {}),
  };

  const schedules = await deps.getSchedules(tenantId);
  if (!schedules || !schedules.length) {
    return fail('no doctor schedules configured — a scripted booking cannot run');
  }

  const slot = await findFreeSlot(tenantId, deps);
  if (!slot) {
    return fail(`no free appointment slot found in the next ${SCAN_DAYS} day(s) — cannot script a booking`);
  }

  const clash = await collision(tenantId);
  if (clash) {
    return fail(
      `reserved synthetic number ${SYNTHETIC_PHONE} already has rows (${clash}) — ` +
      'aborting rather than adopting a real customer thread');
  }

  // The brain must never page a real owner about a fake patient.
  const tenantForBrain = { ...tenant, owner_notify_phone: null };

  const script = [
    `Hello, I would like to book an appointment with ${slot.doctor} on ${slot.date} at ${slot.time}. My name is ${SYNTHETIC_NAME}.`,
    `Yes, that is correct. Please confirm and book it.`,
    `Yes, please go ahead and book it now.`,
  ].slice(0, MAX_TURNS);

  // Every appointment_booked notification that exists BEFORE the probe runs is
  // somebody else's; cleanup must never touch these.
  const preNotifIds = await bookingNotificationIds(tenantId);

  let customer = null;
  const collector = makeCollector();
  const turns = [];
  let appt = null;

  try {
    customer = await deps.createSyntheticIdentity(tenantId);
    const conversation = await deps.getOrCreateOpenConversation(tenantId, customer.id, 'voice');

    for (const transcript of script) {
      const { reply, latency } = await runOneTurn(deps, tenantForBrain, customer, conversation, transcript, collector);
      turns.push({ transcript, reply, latency_ms: latency });
      appt = await bookedAppointment(tenantId, customer.id);
      if (appt) break; // booked — no need to spend another model call
    }

    const lastReply = turns.length ? turns[turns.length - 1].reply : '';
    const booked = collector.toolCalls.filter((c) => c.name === 'book_appointment');
    const latencies = turns.map((t) => `${t.latency_ms}ms`).join('/');
    const toolSummary = collector.toolCalls.length
      ? collector.toolCalls.map((c) => `${c.name}(${Math.round(c.latency_ms)}ms)`).join(', ')
      : 'none';

    if (!lastReply || !lastReply.trim()) {
      return fail(`the brain returned an empty reply after ${turns.length} turn(s); tools: ${toolSummary}`);
    }
    if (!booked.length) {
      return fail(
        `book_appointment was never invoked across ${turns.length} turn(s) ` +
        `(tools: ${toolSummary}); last reply: "${truncate(lastReply)}"`);
    }
    if (!appt) {
      return fail(`book_appointment was invoked but no appointment row exists; tools: ${toolSummary}`);
    }

    return pass(
      `booked appointment ${appt.id} (${appt.doctor_name} @ ${slot.date} ${slot.time}) ` +
      `in ${turns.length} turn(s); tools: ${toolSummary}; turn latency ${latencies}; ` +
      `reply: "${truncate(lastReply)}"`);
  } finally {
    // Always tear down, on every exit path — pass, fail, or throw. The residue
    // proof is folded into the returned detail by the wrapper below.
    //
    // `booked` is re-queried rather than read off `appt`: a throw mid tool-loop
    // can leave a booked row behind with `appt` still null, and that is exactly
    // the case where the fire-and-forget owner notification is in flight.
    if (customer) {
      const booked = appt || await bookedAppointment(tenantId, customer.id).catch(() => null);
      await cleanupSynthetic(tenantId, customer.id, { booked: !!booked, preNotifIds });
      ctx._syntheticResidue = await residue(tenantId, customer.id, preNotifIds);
    }
  }
}

function truncate(s, n = 120) {
  const t = String(s).replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

// Public check entry: run the probe, then fold the cleanup proof into the result.
// A perfectly-booked turn that LEAKS rows is still a fail — the operator must
// never be told "pass" while synthetic data sits in their tenant.
async function checkScriptedTurn(ctx) {
  const result = await runScriptedTurn(ctx);
  const res = ctx._syntheticResidue;
  if (!res) return result; // never created a customer (aborted before identity)

  const leaked = Object.entries(res).filter(([, n]) => n > 0);
  if (leaked.length) {
    return fail(
      `synthetic cleanup INCOMPLETE — residual rows: ${leaked.map(([t, n]) => `${t}=${n}`).join(', ')}` +
      ` (probe result was: ${result.severity} — ${result.detail})`);
  }
  return { ...result, detail: `${result.detail}; synthetic customer purged (0 residual rows)` };
}

module.exports = {
  checkScriptedTurn,
  SYNTHETIC_PHONE,
  SYNTHETIC_NAME,
  MAX_TURNS,
  SCAN_DAYS,
};
