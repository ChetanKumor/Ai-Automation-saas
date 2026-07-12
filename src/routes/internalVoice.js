'use strict';

const express             = require('express');
const logger              = require('../infra/logging/logger');
const db                  = require('../db/db');
const tenantService       = require('../modules/tenant/tenantService');
const customerService     = require('../modules/customer/customerService');
const aiService           = require('../modules/ai/aiService');
const { assembleConversationContext } = require('../modules/conversation/contextAssembler');
const identityService     = require('../modules/identity/identityService');
const conversationService = require('../modules/conversation/conversationService');
const voiceChannelAdapter = require('../modules/channels/voice/voiceChannelAdapter');
const hmac                = require('../utils/hmac');
const requestContext      = require('../core/requestContext');
const { createTurnTimer } = require('../infra/logging/turnMetrics');
const traces              = require('../modules/traces/collector');
const eventBus            = require('../../core/events');
const EVENT               = require('../../core/eventTypes');

const router = express.Router();

/**
 * HMAC auth for the internal voice endpoint. Reuses the WhatsApp signature
 * scheme over the raw body (header `x-internal-signature: sha256=<hex>`).
 * The body arrives as a raw Buffer (express.raw) and is parsed here.
 */
function authenticate(req, res, next) {
  const secret = process.env.VOICE_INTERNAL_SECRET;
  if (!secret) {
    logger.error('internal voice: VOICE_INTERNAL_SECRET not set — rejecting');
    return res.sendStatus(401);
  }
  if (!hmac.verify(req.body, req.headers['x-internal-signature'], secret)) {
    logger.warn('internal voice: invalid signature');
    return res.sendStatus(401);
  }
  try {
    req.body = JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString('utf8') : req.body);
  } catch (err) {
    return res.status(400).json({ error: 'invalid json' });
  }
  next();
}

// ── PR9C: opt-in SSE turn mode ────────────────────────────────────────────────

// Brain-authored acknowledgment copy, per language (the worker NEVER authors
// language). Spoken the moment a turn resolves to a tool round. Constants for
// now; env-overridable copy is a later PR.
const VOICE_ACK_COPY = {
  'te-IN': 'ఒక్క నిమిషం, చూస్తున్నాను.',
  'hi-IN': 'एक मिनट, ज़रा देखते हैं।',
  'en-IN': 'One moment, let me check.',
};

const ackTextFor = (language) => VOICE_ACK_COPY[language] || VOICE_ACK_COPY['en-IN'];

// ── Issue 29: coordinated turn budget ────────────────────────────────────────
// The server-side deadline for one JSON turn. MUST stay strictly BELOW the
// worker's patience (voice-agent/agent.py TURN_TIMEOUT_S, env
// VOICE_TURN_TIMEOUT_S, default 10s): the server always gives up FIRST, so the
// worker's static apology only ever fires after the server has stopped
// spending. 8000 < 10000 is the pinned relationship — change them together.
// Read at call time so tests can vary it per case.
const turnBudgetMs = () => {
  const v = parseInt(process.env.TURN_BUDGET_MS, 10);
  return Number.isFinite(v) && v > 0 ? v : 8000;
};

/** Belt and braces: the worker opts into SSE with BOTH the Accept header and a
 * body flag. Anything else takes the JSON branch untouched. */
function wantsStream(req) {
  return String(req.headers.accept || '').includes('text/event-stream')
    && !!req.body && req.body.stream === true;
}

/**
 * POST /internal/voice/turn — route ONE finalized voice turn into the existing brain.
 *
 * Transport glue + persistence only. All business logic (tool selection,
 * booking guards, memory) lives in aiService.generateReply / the booking tools,
 * reached here with channel="voice" (spoken style). Outbound is RETURNED to the
 * worker (it does TTS), not pushed.
 *
 * Identity resolves ONCE at /call/start; every turn reuses the call_session's
 * customer + conversation. The worker supplies only call_session_id — it never
 * resolves tenant/customer/conversation itself. (This supersedes PR6's
 * worker-supplied customer_id/conversation_id.)
 *
 * req:  { call_session_id, channel:"voice", language, transcript }
 * res:  { reply_text, end_call:boolean, language }
 *
 * PR9C: when the request opts in (Accept: text/event-stream + body stream:true)
 * the turn is served as SSE by handleTurnSSE instead — the JSON body below is
 * byte-identical to the pre-PR9C contract and remains the default.
 */
async function handleTurn(req, res) {
  if (wantsStream(req)) return handleTurnSSE(req, res);

  const { call_session_id, language, transcript } = req.body || {};

  if (!call_session_id || !transcript) {
    return res.status(400).json({ error: 'missing required fields' });
  }

  // Per-turn stage timings (PR9A). Logging only: one structured line per turn,
  // emitted in the finally below on every exit path. No response-shape change.
  const turn = createTurnTimer({ call_session_id });

  // Turn trace (Issue 22): wraps the SAME timer (no second timing system) and
  // rides the request's ALS context so aiService/contextAssembler capture
  // provenance without threading. Flushed in the finally — after res.json has
  // handed the reply to the worker (TTS dispatch), success or failure.
  const trace = traces.open({ channel: 'voice', timer: turn, callSessionId: call_session_id });

  // ── Issue 29: cancellation + deadline (V-001/V-003) ──
  // ONE combined abort source, same plumbing as the SSE branch: the client
  // going away (res 'close' before we finished — the worker timed out or the
  // call died) and the server-side turn budget both abort the same controller.
  // The signal reaches every Gemini call, the RAG embedding call, and the
  // reply loop's checkpoints (aiService). DB statements are bounded separately
  // by the pool's statement_timeout (db.js).
  //
  // abort_reason precedence is decided at RECORD time, not abort time:
  // client_gone wins whenever the client is known to be gone, even if the
  // deadline timer technically fired first (double-abort race).
  let finished = false;    // set in the finally — the close listener then no-ops
  let clientGone = false;
  let committed = false;   // a mutating tool executed (point of no return)
  const abortController = new AbortController();
  // NOTE: res.on('close'), not req.on('close') — the request's 'close' fires
  // when the body is fully consumed (immediately here); the response's fires
  // when the connection actually goes away (same finding as the SSE branch).
  res.on('close', () => {
    if (finished) return;
    clientGone = true;
    abortController.abort();
  });
  const budgetTimer = setTimeout(() => abortController.abort(), turnBudgetMs());
  budgetTimer.unref();
  const signal = abortController.signal;
  const abortReason = () => (clientGone ? 'client_gone' : 'deadline');

  try {
    const endHydrate = turn.start('hydrate_validate');

    // Resolve customer/conversation/tenant from the call_session (bridged once at
    // /call/start). The call_session is the canonical owner of all three.
    const { rows: [session] } = await db.query(
      'SELECT tenant_id, customer_id, conversation_id FROM call_sessions WHERE id = $1',
      [call_session_id]
    );
    if (!session) return res.status(404).json({ error: 'call session not found' });

    const { tenant_id, customer_id, conversation_id } = session;
    turn.set({ tenant_id });
    trace.setIds({ tenant_id, conversation_id });
    if (!customer_id || !conversation_id) {
      return res.status(409).json({ error: 'call session not bridged to a customer/conversation' });
    }

    // Hydrate tenant (decrypted creds + cache) — same pattern as the WhatsApp adapter.
    const { rows: [t] } = await db.query(
      'SELECT phone_number_id FROM tenants WHERE id = $1 AND active = true', [tenant_id]
    );
    if (!t) return res.status(404).json({ error: 'tenant not found' });
    const tenant = await tenantService.getByPhoneNumberId(t.phone_number_id);
    if (!tenant) return res.status(404).json({ error: 'tenant credentials not found' });

    // Validate the customer + conversation belong to this tenant.
    const { rows: [customer] } = await db.query(
      'SELECT * FROM customers WHERE id = $1 AND tenant_id = $2', [customer_id, tenant_id]
    );
    if (!customer) return res.status(404).json({ error: 'customer not found' });

    const { rows: [conversation] } = await db.query(
      'SELECT * FROM conversations WHERE id = $1 AND tenant_id = $2 AND customer_id = $3',
      [conversation_id, tenant_id, customer_id]
    );
    if (!conversation) return res.status(404).json({ error: 'conversation not found' });

    // Honor the stored preferred_language prior; the request's STT-detected
    // language is used (and persisted) only when the prior is null.
    const effectiveLanguage = await customerService.resolveLanguage(tenant_id, customer_id, language);
    endHydrate();

    // Persist the inbound voice turn (channel='voice') BEFORE fetching history —
    // its id (inbound.id) is threaded to getRecentMessages so history excludes this
    // exact row by id (V-009), exactly as the WhatsApp path does.
    const endPersistIn = turn.start('persist_inbound');
    const { rows: [inbound] } = await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, direction, sender, content, channel, msg_type)
       VALUES ($1, $2, $3, 'inbound', 'customer', $4, 'voice', 'text')
       RETURNING id`,
      [tenant_id, conversation_id, customer_id, transcript]
    );
    endPersistIn();

    // CRM/memory/timeline parity: emit the SAME domain event WhatsApp emits for an
    // inbound message (handleInbound → MESSAGE_RECEIVED), via the existing bus.
    // Downstream consumers (workflow rules matching trigger_event, CRM extraction,
    // memory write-back) handle it with no voice special-casing. Emitted before the
    // mode gate, exactly as the WhatsApp path emits it before its reply check.
    eventBus.emit(EVENT.MESSAGE_RECEIVED, {
      tenant_id,
      customer_id,
      conversation_id,
      message_id: inbound.id,
      text: transcript,
      mode: conversation.mode,
      // Channel/type on the event (V-002) — mirrors the row just inserted.
      channel: 'voice',
      msg_type: 'text',
    });

    // Same mode/ai_enabled gate as the WhatsApp path.
    if (conversation.mode === 'human' || !tenant.ai_enabled) {
      logger.info({ tenant_id, mode: conversation.mode, aiEnabled: tenant.ai_enabled }, 'voice turn: AI skipped');
      await db.query(`UPDATE conversations SET last_message_at = NOW() WHERE id = $1 AND tenant_id = $2`, [conversation_id, tenant_id]);
      return res.json({ reply_text: '', end_call: false, language: effectiveLanguage });
    }

    // Abort checkpoint (Issue 29). Placed AFTER the inbound persist by design:
    // the inbound message always persists once hydrated — the caller spoke, it
    // happened; reply generation (fetch + Gemini + tools) is what stops.
    aiService.throwIfAborted(signal);

    // SHARED context-assembly path — the same helper the WhatsApp route uses.
    const endFetch = turn.start('fetch_parallel');
    const { knowledgeChunks, history, facts } = await assembleConversationContext({
      tenantId: tenant_id,
      conversationId: conversation_id,
      customerId: customer_id,
      currentMessageId: inbound.id, // V-009: exclude this turn's inbound row by id
      text: transcript,
      signal,
      onTiming: (name, ms) => turn.record(`fetch_parallel_${name}`, ms),
    });
    endFetch();

    // THE ONE BRAIN — same tools, same booking guards; channel only changes style.
    // The turn timer doubles as the metrics collector (gemini_call_<n> +
    // tool_exec_<n>_<name> land in this turn's stages).
    const reply_text = await aiService.generateReply(
      tenant, customer, conversation, transcript, history, knowledgeChunks, facts,
      { channel: 'voice', metrics: turn, signal, onCommitted: () => { committed = true; } }
    );

    // Persist the outbound voice turn (channel='voice'). Unconditional even if
    // the abort fired mid-generation past the point of no return: a committed
    // booking whose confirmation never persisted is a torn write (Issue 29).
    const endPersistOut = turn.start('persist_outbound');
    await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, direction, sender, content, channel, msg_type)
       VALUES ($1, $2, $3, 'outbound', 'ai', $4, 'voice', 'text')`,
      [tenant_id, conversation_id, customer_id, reply_text]
    );
    await db.query(`UPDATE conversations SET last_message_at = NOW() WHERE id = $1 AND tenant_id = $2`, [conversation_id, tenant_id]);
    endPersistOut();

    if (signal.aborted) {
      // The turn completed despite an abort firing after the last checkpoint
      // (typically past the point of no return). Trace it honestly (V-011);
      // still answer if the socket is alive — the worker may not have given
      // up yet (budget 8s < worker 10s) and the real reply beats an apology.
      trace.setAbort({ reason: abortReason(), afterCommit: committed });
      logger.info({ abort_reason: abortReason(), aborted_after_commit: committed },
        'internal voice turn: completed after abort signal');
      if (clientGone) return;
    }
    return res.json({ reply_text, end_call: false, language: effectiveLanguage });
  } catch (err) {
    if (signal.aborted && !committed) {
      // Cancelled turn (client gone or budget exceeded before any mutating
      // tool ran) — an expected outcome, not a failure. Distinct error body;
      // the worker treats any non-2xx as BrainError (static apology).
      trace.setAbort({ reason: abortReason(), afterCommit: false });
      logger.info({ err: err.message, abort_reason: abortReason() }, 'internal voice turn aborted');
      if (clientGone) return;
      return res.status(503).json({ error: 'turn aborted' });
    }
    logger.error({ err: err.message }, 'internal voice turn failed');
    // Failed turns trace too — this is precisely when a trace is needed.
    trace.setErrorFromException(err);
    if (clientGone) return;
    return res.status(500).json({ error: 'turn failed' });
  } finally {
    finished = true;
    clearTimeout(budgetTimer);
    turn.emit();
    trace.flush();
  }
}

/**
 * PR9C — SSE branch of /internal/voice/turn (opt-in via wantsStream).
 *
 * Same HMAC (middleware, over the raw body — a 401 never emits SSE bytes),
 * same hydrate/gate/fetch/persist-inbound flow and status codes as the JSON
 * branch above (kept as an intentional mirror so the JSON branch stays
 * untouched code). Every pre-stream failure is a plain HTTP error exactly like
 * the JSON branch; headers switch to text/event-stream only once the turn is
 * fully validated.
 *
 * Event protocol (in order):
 *   ack   {text, language}                 at most once, only when the reply
 *                                          loop enters a tool round, BEFORE
 *                                          any tool executes
 *   delta {text}                           text chunks of the FINAL completion
 *   done  {reply_text, end_call, language} authoritative record, emitted AFTER
 *                                          outbound persistence completes
 *   error {message}                        model/tool failure after headers
 *
 * On client disconnect: abort the in-flight Gemini stream (AbortSignal), stop
 * the loop, persist the partial reply as the outbound message (sent-text may
 * exceed spoken-text — known approximation), clean up.
 */
async function handleTurnSSE(req, res) {
  const { call_session_id, language, transcript } = req.body || {};

  if (!call_session_id || !transcript) {
    return res.status(400).json({ error: 'missing required fields' });
  }

  const turn = createTurnTimer({ call_session_id });
  turn.annotate({ stream_mode: true });

  // Turn trace (Issue 22) — same wiring as the JSON branch (intentional mirror).
  const trace = traces.open({ channel: 'voice', timer: turn, callSessionId: call_session_id });

  // Disconnect plumbing. `finished` is set right before the normal res.end()
  // so the close listener only fires for a premature client disconnect.
  // NOTE: res.on('close'), not req.on('close') — on Node >= 16 the request's
  // 'close' fires when the request MESSAGE completes (body fully consumed,
  // i.e. immediately here), verified live on this runtime; the response's
  // 'close' fires only when the underlying connection actually goes away.
  let finished = false;
  let aborted = false;
  let streaming = false; // SSE headers sent
  const abortController = new AbortController();
  res.on('close', () => {
    if (finished || aborted) return;
    aborted = true;
    abortController.abort();
  });

  const sse = (event, data) => {
    if (aborted || res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const startSSE = () => {
    streaming = true;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
  };

  // Route-side accumulation of forwarded deltas: on disconnect this is "what
  // was generated so far" and becomes the persisted outbound message.
  let partialText = '';
  let tenantScope = null; // {tenant_id, conversation_id, customer_id} once hydrated

  try {
    const endHydrate = turn.start('hydrate_validate');

    const { rows: [session] } = await db.query(
      'SELECT tenant_id, customer_id, conversation_id FROM call_sessions WHERE id = $1',
      [call_session_id]
    );
    if (!session) return res.status(404).json({ error: 'call session not found' });

    const { tenant_id, customer_id, conversation_id } = session;
    turn.set({ tenant_id });
    trace.setIds({ tenant_id, conversation_id });
    if (!customer_id || !conversation_id) {
      return res.status(409).json({ error: 'call session not bridged to a customer/conversation' });
    }

    const { rows: [t] } = await db.query(
      'SELECT phone_number_id FROM tenants WHERE id = $1 AND active = true', [tenant_id]
    );
    if (!t) return res.status(404).json({ error: 'tenant not found' });
    const tenant = await tenantService.getByPhoneNumberId(t.phone_number_id);
    if (!tenant) return res.status(404).json({ error: 'tenant credentials not found' });

    const { rows: [customer] } = await db.query(
      'SELECT * FROM customers WHERE id = $1 AND tenant_id = $2', [customer_id, tenant_id]
    );
    if (!customer) return res.status(404).json({ error: 'customer not found' });

    const { rows: [conversation] } = await db.query(
      'SELECT * FROM conversations WHERE id = $1 AND tenant_id = $2 AND customer_id = $3',
      [conversation_id, tenant_id, customer_id]
    );
    if (!conversation) return res.status(404).json({ error: 'conversation not found' });

    const effectiveLanguage = await customerService.resolveLanguage(tenant_id, customer_id, language);
    endHydrate();
    tenantScope = { tenant_id, conversation_id, customer_id };

    const endPersistIn = turn.start('persist_inbound');
    const { rows: [inbound] } = await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, direction, sender, content, channel, msg_type)
       VALUES ($1, $2, $3, 'inbound', 'customer', $4, 'voice', 'text')
       RETURNING id`,
      [tenant_id, conversation_id, customer_id, transcript]
    );
    endPersistIn();

    eventBus.emit(EVENT.MESSAGE_RECEIVED, {
      tenant_id,
      customer_id,
      conversation_id,
      message_id: inbound.id,
      text: transcript,
      mode: conversation.mode,
      // Channel/type on the event (V-002) — mirrors the row just inserted.
      channel: 'voice',
      msg_type: 'text',
    });

    // Same mode/ai_enabled gate as the JSON branch — expressed as an SSE turn
    // with no ack/deltas and an empty authoritative record.
    if (conversation.mode === 'human' || !tenant.ai_enabled) {
      logger.info({ tenant_id, mode: conversation.mode, aiEnabled: tenant.ai_enabled }, 'voice turn: AI skipped');
      await db.query(`UPDATE conversations SET last_message_at = NOW() WHERE id = $1 AND tenant_id = $2`, [conversation_id, tenant_id]);
      startSSE();
      sse('done', { reply_text: '', end_call: false, language: effectiveLanguage });
      finished = true;
      res.end();
      return;
    }

    const endFetch = turn.start('fetch_parallel');
    const { knowledgeChunks, history, facts } = await assembleConversationContext({
      tenantId: tenant_id,
      conversationId: conversation_id,
      customerId: customer_id,
      currentMessageId: inbound.id, // V-009: exclude this turn's inbound row by id
      text: transcript,
      onTiming: (name, ms) => turn.record(`fetch_parallel_${name}`, ms),
    });
    endFetch();

    // Everything is validated — switch to the event stream.
    startSSE();

    let ackEmitted = false;
    let firstDelta = true;

    const reply_text = await aiService.generateReplyStream(
      tenant, customer, conversation, transcript, history, knowledgeChunks, facts,
      {
        metrics: turn,
        signal: abortController.signal,
        // Ack: at most once per turn, the moment the reply loop resolves to a
        // tool round — before any tool executes.
        onToolRound: () => {
          if (ackEmitted || aborted) return;
          ackEmitted = true;
          turn.annotate({ ack_emitted_ms: turn.elapsed() });
          sse('ack', { text: ackTextFor(effectiveLanguage), language: effectiveLanguage });
        },
        onDelta: (text) => {
          if (aborted) return;
          if (firstDelta) {
            firstDelta = false;
            turn.annotate({ first_delta_ms: turn.elapsed() });
          }
          partialText += text;
          sse('delta', { text });
        },
      }
    );

    if (aborted) {
      // Client went away mid-generation (barge-in / hangup). The Gemini stream
      // was aborted via the signal; persist what was forwarded so far.
      await persistPartialOutbound(tenantScope, partialText.trim(), turn);
      return;
    }

    // Same persistence semantics and ordering as the JSON branch: full reply
    // text, then last_message_at — done is emitted only after both complete.
    const endPersistOut = turn.start('persist_outbound');
    await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, direction, sender, content, channel, msg_type)
       VALUES ($1, $2, $3, 'outbound', 'ai', $4, 'voice', 'text')`,
      [tenant_id, conversation_id, customer_id, reply_text]
    );
    await db.query(`UPDATE conversations SET last_message_at = NOW() WHERE id = $1 AND tenant_id = $2`, [conversation_id, tenant_id]);
    endPersistOut();

    sse('done', { reply_text, end_call: false, language: effectiveLanguage });
    finished = true;
    res.end();
  } catch (err) {
    if (aborted) {
      // Disconnect abort surfaces as a stream-read error — expected teardown.
      logger.info({ err: err.message }, 'internal voice turn (sse): client disconnected, stream aborted');
      await persistPartialOutbound(tenantScope, partialText.trim(), turn);
      return;
    }
    logger.error({ err: err.message }, 'internal voice turn (sse) failed');
    trace.setErrorFromException(err);
    if (!streaming) {
      return res.status(500).json({ error: 'turn failed' });
    }
    sse('error', { message: 'turn failed' });
    finished = true;
    res.end();
  } finally {
    turn.emit();
    trace.flush();
  }
}

/** Persist an interrupted turn's partial reply (existing columns only — the
 * row is a normal outbound voice message whose content is what was generated
 * before the disconnect). No-op when nothing was generated. */
async function persistPartialOutbound(scope, text, turn) {
  if (!scope || !text) return;
  try {
    const endPersistOut = turn.start('persist_outbound');
    await db.query(
      `INSERT INTO messages
         (tenant_id, conversation_id, customer_id, direction, sender, content, channel, msg_type)
       VALUES ($1, $2, $3, 'outbound', 'ai', $4, 'voice', 'text')`,
      [scope.tenant_id, scope.conversation_id, scope.customer_id, text]
    );
    await db.query(`UPDATE conversations SET last_message_at = NOW() WHERE id = $1 AND tenant_id = $2`, [scope.conversation_id, scope.tenant_id]);
    endPersistOut();
  } catch (err) {
    logger.error({ err: err.message }, 'internal voice turn (sse): partial outbound persist failed');
  }
}

/**
 * POST /internal/voice/call/start — bridge a call into the brain's identity model.
 *
 * Identity resolves ONCE here, at bridge time, via the SAME identityService the
 * WhatsApp path uses. For voice (a phone channel) a returning caller is matched
 * by phone and reuses their EXISTING open conversation — so voice and WhatsApp
 * share one customer, one conversation, one memory. A new caller creates the
 * customer + voice channel_identifier. Every subsequent turn reuses this
 * call_session's customer/conversation (the worker never resolves identity).
 *
 * req:  { tenant_id, caller_id, channel:"voice" }
 * res:  { call_session_id, customer_id, conversation_id }
 */
async function handleCallStart(req, res) {
  const { tenant_id, caller_id, channel = 'voice' } = req.body || {};

  if (!tenant_id || !caller_id) {
    return res.status(400).json({ error: 'missing required fields' });
  }

  try {
    const { rows: [t] } = await db.query(
      'SELECT id FROM tenants WHERE id = $1 AND active = true', [tenant_id]
    );
    if (!t) return res.status(404).json({ error: 'tenant not found' });

    // Same resolution WhatsApp uses (phone fallback + channel_identifier link).
    const customer = await identityService.resolveCustomer({
      tenantId: tenant_id,
      channelType: channel,
      identifier: caller_id,
    });

    // Returning customer → their existing open conversation; new → a fresh one.
    const conversation = await conversationService.getOrCreateOpenConversation(
      tenant_id, customer.id, 'voice'
    );

    // PR6 lifecycle: create call_session (in_progress) + emit call.started.
    const session = await voiceChannelAdapter.startSession({
      tenantId: tenant_id,
      customerId: customer.id,
      conversationId: conversation.id,
      provider: 'noop',
      direction: 'inbound',
      fromNumber: caller_id,
    });

    return res.json({
      call_session_id: session.id,
      customer_id: customer.id,
      conversation_id: conversation.id,
      // Issue 21: the call's correlation id. The worker keeps it in its
      // per-call state, echoes it (X-Correlation-Id) on every turn/end post,
      // and stamps its own log lines with it.
      correlation_id: requestContext.get()?.correlationId ?? null,
    });
  } catch (err) {
    logger.error({ err: err.message }, 'internal voice call/start failed');
    return res.status(500).json({ error: 'call start failed' });
  }
}

/**
 * POST /internal/voice/call/end — close the call_session + emit call.ended.
 *
 * The worker supplies only the call_session_id (the canonical owner of the
 * tenant), so tenant scope is resolved server-side before the tenant-scoped
 * update. Drives PR6's call_sessions.updateStatus + call.ended.
 *
 * req:  { call_session_id, status:"completed"|"failed", duration_seconds:int>=0 }
 * res:  { ok:true }
 */
async function handleCallEnd(req, res) {
  const { call_session_id, status = 'completed', duration_seconds } = req.body || {};

  if (!call_session_id) {
    return res.status(400).json({ error: 'missing required fields' });
  }
  if (status !== 'completed' && status !== 'failed') {
    return res.status(400).json({ error: 'invalid status' });
  }
  // call_sessions.duration_seconds is int (migration 018): coerce at the process
  // boundary and reject malformed input instead of 500ing inside the UPDATE.
  const d = Math.round(Number(duration_seconds));
  if (!Number.isFinite(d) || d < 0) {
    logger.warn({ call_session_id, duration_seconds }, 'internal voice call/end: invalid duration_seconds');
    return res.status(400).json({ error: 'invalid duration_seconds' });
  }

  try {
    const { rows: [row] } = await db.query(
      'SELECT tenant_id, status FROM call_sessions WHERE id = $1', [call_session_id]
    );
    if (!row) return res.status(404).json({ error: 'call session not found' });

    const session = await voiceChannelAdapter.endSession(call_session_id, row.tenant_id, {
      status,
      durationSeconds: d,
    });

    // Terminal-transition guard (V-004): the row exists (SELECT above) but the
    // UPDATE touched nothing → the session was already terminal. This is an
    // idempotent no-op: respond 200, do NOT re-emit call.ended, leave the
    // recorded status/duration untouched. A duplicate or late call/end (worker
    // restart mid-teardown, retried delivery) lands here.
    if (!session) {
      logger.debug(
        { call_session_id, from: row.status, to: status },
        'internal voice call/end: no-op (session already terminal)'
      );
      return res.json({ ok: true });
    }

    return res.json({ ok: true });
  } catch (err) {
    logger.error({ err: err.message }, 'internal voice call/end failed');
    return res.status(500).json({ error: 'call end failed' });
  }
}

// Correlation context (Issue 21). These endpoints sit behind HMAC auth, so a
// worker-supplied X-Correlation-Id is trusted and ADOPTED (the worker echoes
// the call_ id it got from /call/start on every turn/end); absent or
// malformed, a fresh call_ id is generated. Mounted AFTER authenticate — an
// unauthenticated caller can never place an id into our logs.
const correlation = requestContext.middleware({ prefix: 'call', channel: 'voice', trusted: true });

router.post('/call/start', express.raw({ type: '*/*' }), authenticate, correlation, handleCallStart);
router.post('/call/end',   express.raw({ type: '*/*' }), authenticate, correlation, handleCallEnd);
router.post('/turn',       express.raw({ type: '*/*' }), authenticate, correlation, handleTurn);

module.exports = router;
module.exports._authenticate = authenticate;
module.exports._handleTurn = handleTurn;
module.exports._handleCallStart = handleCallStart;
module.exports._handleCallEnd = handleCallEnd;
module.exports._handleTurnSSE = handleTurnSSE;
module.exports._VOICE_ACK_COPY = VOICE_ACK_COPY;

