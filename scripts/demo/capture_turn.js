'use strict';
/**
 * DEMO-00 booking capture — spends the ONE Gemini turn.
 *
 * Runs the founder's REAL Sarvam-transcribed Telugu utterance through the SAME
 * turn core the voice route uses (persist inbound -> assembleConversationContext
 * -> aiService.generateReply(channel:'voice') -> persist outbound), against a
 * SYNTHETIC patient identity, exactly like the validation probe
 * (src/modules/validation/scriptedTurnCheck.js). Captures the real Telugu AI
 * reply and the check_availability tool evidence.
 *
 * Then — per the founder's decision (DEMO-00 "Availability + real booked row") —
 * books a genuinely-available slot for the SAME patient DIRECTLY via
 * appointmentService.bookAppointment (NO Gemini), so the fixture carries a real
 * appointments row (doctor/date/time/status/id). The booking is programmatic,
 * not brain-driven — the provenance note states this plainly.
 *
 * Everything captured is written to scripts/demo/capture_result.json (utf-8;
 * the Windows console cannot print Telugu). The synthetic customer and every row
 * it produced are then purged (cascade) and a residue check runs — leaving
 * synthetic rows behind is worse than failing.
 *
 * ONE Gemini turn only. If the brain call fails (e.g. daily quota / 429) this
 * STOPS after cleanup and never fabricates a reply.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const db = require('../../src/db/db');
const tenantService = require('../../src/modules/tenant/tenantService');
const conversationService = require('../../src/modules/conversation/conversationService');
const appointmentService = require('../../src/modules/appointment/appointmentService');
const aiService = require('../../src/modules/ai/aiService');
const { assembleConversationContext } = require('../../src/modules/conversation/contextAssembler');
const traces = require('../../src/modules/traces/collector');

const TENANT_ID = '11111111-1111-1111-1111-111111111111'; // Smile Dental (Voice Dev), Dr. Rao
const IST = 'Asia/Kolkata';

// Demo patient persona (realistic Telugu name + demo Indian mobile). The DB row
// is synthetic and purged after capture; the fixture keeps these display values.
const PATIENT_NAME = 'Sravani Reddy';
const PATIENT_PHONE = '+919701234567';

const RAW = path.join(__dirname, 'stt_capture_raw.json');
const OUT = path.join(__dirname, 'capture_result.json');

function istDate(daysAhead) {
  return new Date(Date.now() + daysAhead * 86400000).toLocaleDateString('en-CA', { timeZone: IST });
}

// Abort unless the demo phone is genuinely unused under this tenant (never adopt
// a real thread, never delete a real customer). Dev DB, fresh number -> clean.
async function collision() {
  const { rows: c } = await db.query(
    'SELECT id FROM customers WHERE tenant_id = $1 AND phone = $2', [TENANT_ID, PATIENT_PHONE]);
  if (c[0]) return `customers.id=${c[0].id}`;
  const { rows: ci } = await db.query(
    'SELECT customer_id FROM channel_identifiers WHERE tenant_id = $1 AND identifier = $2',
    [TENANT_ID, PATIENT_PHONE]);
  if (ci[0]) return `channel_identifiers.customer_id=${ci[0].customer_id}`;
  return null;
}

async function createSyntheticIdentity() {
  const { rows } = await db.query(
    `INSERT INTO customers (tenant_id, phone, name, last_seen_at)
     VALUES ($1, $2, $3, NOW()) RETURNING *`,
    [TENANT_ID, PATIENT_PHONE, PATIENT_NAME]);
  const customer = rows[0];
  await db.query(
    `INSERT INTO channel_identifiers (tenant_id, customer_id, channel_type, identifier)
     VALUES ($1, $2, 'voice', $3)
     ON CONFLICT (tenant_id, channel_type, identifier) DO NOTHING`,
    [TENANT_ID, customer.id, PATIENT_PHONE]);
  return customer;
}

const RESIDUE = [
  ['customers', 'SELECT count(*)::int n FROM customers WHERE tenant_id=$1 AND id=$2'],
  ['conversations', 'SELECT count(*)::int n FROM conversations WHERE tenant_id=$1 AND customer_id=$2'],
  ['messages', 'SELECT count(*)::int n FROM messages WHERE tenant_id=$1 AND customer_id=$2'],
  ['appointments', 'SELECT count(*)::int n FROM appointments WHERE tenant_id=$1 AND customer_id=$2'],
  ['call_sessions', 'SELECT count(*)::int n FROM call_sessions WHERE tenant_id=$1 AND customer_id=$2'],
  ['channel_identifiers', 'SELECT count(*)::int n FROM channel_identifiers WHERE tenant_id=$1 AND customer_id=$2'],
];

async function residue(customerId) {
  const out = {};
  for (const [name, sql] of RESIDUE) {
    const { rows } = await db.query(sql, [TENANT_ID, customerId]);
    out[name] = rows[0].n;
  }
  return out;
}

(async () => {
  const raw = JSON.parse(fs.readFileSync(RAW, 'utf8'));
  const transcript = raw.transcript;
  if (!transcript || !transcript.trim()) throw new Error('no STT transcript in ' + RAW);

  const tenant = await tenantService.getById(TENANT_ID);
  if (!tenant) throw new Error('voice-dev tenant not found');
  // Belt-and-braces: the brain must never page a real owner about a demo patient.
  const tenantForBrain = { ...tenant, owner_notify_phone: null };

  const clash = await collision();
  if (clash) throw new Error(`demo phone ${PATIENT_PHONE} already has rows (${clash}) — aborting`);

  const result = { captured_at: new Date().toISOString(), stt: raw };
  let customer = null;

  try {
    customer = await createSyntheticIdentity();
    const conversation = await conversationService.getOrCreateOpenConversation(TENANT_ID, customer.id, 'voice');

    // ── ONE brain turn (the single Gemini spend) ──
    const trace = traces.open({ channel: 'voice', tenantId: TENANT_ID, conversationId: conversation.id });
    const { rows: [inbound] } = await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, customer_id, direction, sender, content, channel, msg_type)
       VALUES ($1,$2,$3,'inbound','customer',$4,'voice','text') RETURNING id`,
      [TENANT_ID, conversation.id, customer.id, transcript]);

    const { knowledgeChunks, history, facts } = await assembleConversationContext({
      tenantId: TENANT_ID, conversationId: conversation.id, customerId: customer.id,
      currentMessageId: inbound.id, text: transcript,
    });

    const t0 = Date.now();
    const reply = await aiService.generateReply(
      tenantForBrain, customer, conversation, transcript, history, knowledgeChunks, facts,
      { channel: 'voice', metrics: trace.timer });
    const latency = Date.now() - t0;
    await trace.flush();

    await db.query(
      `INSERT INTO messages (tenant_id, conversation_id, customer_id, direction, sender, content, channel, msg_type)
       VALUES ($1,$2,$3,'outbound','ai',$4,'voice','text')`,
      [TENANT_ID, conversation.id, customer.id, reply]);

    const tools = trace.timer.snapshot().tools || [];
    result.turn = { transcript, reply, latency_ms: latency, tools, language: raw.language_code };

    // ── Book a genuinely-available slot for the SAME patient (NO Gemini) ──
    const date = istDate(1); // tomorrow — the caller's "రేపు"; Dr. Rao works daily
    const avail = await appointmentService.checkAvailability(TENANT_ID, date);
    result.availability = avail;
    const slotSet = (avail.available || []).find(a => a.free_slots && a.free_slots.length);
    if (!slotSet) throw new Error(`no free slot on ${date}: ${JSON.stringify(avail)}`);
    const time = slotSet.free_slots[0]; // first offered slot
    const booking = await appointmentService.bookAppointment(
      TENANT_ID, customer.id, slotSet.doctor, `${date}T${time}:00`, PATIENT_NAME);
    if (!booking.success) throw new Error('booking failed: ' + JSON.stringify(booking));

    const { rows: [appt] } = await db.query(
      `SELECT id, doctor_name, appointment_time, status, created_at
         FROM appointments WHERE id = $1`, [booking.appointment_id]);
    result.appointment = {
      id: appt.id,
      doctor_name: appt.doctor_name,
      appointment_time: appt.appointment_time,
      appointment_time_ist: new Date(appt.appointment_time)
        .toLocaleString('en-IN', { timeZone: IST, dateStyle: 'full', timeStyle: 'short' }),
      status: appt.status,
      date, time,
      patient_name: PATIENT_NAME,
      patient_phone: PATIENT_PHONE,
    };
    result.ok = true;
  } catch (err) {
    result.ok = false;
    result.error = err.message;
  } finally {
    if (customer) {
      // Cascade delete (customers -> conversations/messages/appointments/...).
      await db.query('DELETE FROM customers WHERE id = $1 AND tenant_id = $2', [customer.id, TENANT_ID]);
      result.residue = await residue(customer.id);
    }
    fs.writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
    console.log('ok=' + result.ok + (result.error ? ' error=' + result.error : ''));
    console.log('tools=' + JSON.stringify((result.turn && result.turn.tools) || []));
    console.log('reply_len=' + ((result.turn && result.turn.reply || '').length));
    console.log('appointment=' + JSON.stringify(result.appointment || null));
    console.log('residue=' + JSON.stringify(result.residue || null));
    console.log('written -> ' + OUT);
    process.exit(result.ok ? 0 : 1);
  }
})();
