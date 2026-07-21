const { GoogleGenerativeAI } = require('@google/generative-ai');
const crypto = require('crypto');
const logger = require('../../infra/logging/logger');
const appointmentService = require('../appointment/appointmentService');
const notificationService = require('../notification/notificationService');
const configService = require('../config/configService');
const traces = require('../traces/collector');
const { renderSystemPrompt, MINIMAL_SAFE_PROMPT } = require('../prompts');
const { unknownIdentityLine } = require('../prompts/guardrail');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const GEMINI_MODEL = 'gemini-2.5-flash';

// Injectable model factory. Production uses Gemini; tests can script the tool
// loop deterministically without a live model. Not a business-logic seam.
let modelProvider = (config) => genAI.getGenerativeModel(config);
function _setModelProvider(fn) {
  modelProvider = fn || ((config) => genAI.getGenerativeModel(config));
}

// Tool registry metadata (Issue 29), keyed by declaration name. `mutating`
// marks tools whose execution commits external state (bookings, notifications)
// — the reply loop's point of no return: once ANY mutating tool has EXECUTED
// (regardless of its reported outcome — a "failed" booking may still have
// side effects), abort checks stop and the turn completes persistence
// unconditionally. Read-only tools never cross the line. Every declaration in
// TOOLS must have an entry here.
const TOOL_META = {
  check_availability: { mutating: false },
  book_appointment:   { mutating: true },
};
const isMutatingTool = (name) => TOOL_META[name]?.mutating === true;

const TOOLS = [{
  functionDeclarations: [
    {
      name: 'check_availability',
      description: 'Check available appointment slots for a specific date. Call this BEFORE suggesting times to the customer.',
      parameters: {
        type: 'object',
        properties: {
          date: {
            type: 'string',
            description: 'Date in YYYY-MM-DD format. Resolve relative dates (tomorrow, next Wednesday, etc.) to absolute dates using today\'s date provided in the system prompt.'
          }
        },
        required: ['date']
      }
    },
    {
      name: 'book_appointment',
      description: 'Book an appointment. ONLY call this AFTER the customer has explicitly confirmed the doctor, date, and time. Never call on first mention — always confirm first.',
      parameters: {
        type: 'object',
        properties: {
          doctor_name:      { type: 'string', description: 'Full name of the doctor exactly as shown in availability results' },
          appointment_time: { type: 'string', description: 'ISO 8601 datetime with IST offset, e.g. 2026-06-23T10:30:00+05:30' },
          patient_name:     { type: 'string', description: 'Patient name as stated by the customer' }
        },
        required: ['doctor_name', 'appointment_time', 'patient_name']
      }
    }
  ]
}];

// Fail fast at load: every declared tool must state its mutability in
// TOOL_META — a missing entry would silently default to non-mutating and skip
// the point of no return (a torn-write hazard, not a style nit).
for (const d of TOOLS[0].functionDeclarations) {
  if (!(d.name in TOOL_META)) {
    throw new Error(`TOOL_META missing entry for tool: ${d.name} — declare its mutability`);
  }
}

// Read an optional integer env knob at call time (tests can set/unset per case).
const envInt = (name, fallback) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
};

// The ONE abort-check idiom for BOTH turn paths (Issue 29) — generateReply
// (JSON) and generateReplyStream (SSE) share it, and the voice route uses it
// for its pre-fetch checkpoint. Needed because the installed SDK
// (@google/generative-ai@0.24.1) only reacts to an abort that fires while a
// request is in flight (it adds an 'abort' listener; an ALREADY-aborted
// signal is ignored) — so the loop must check between calls/tools itself.
// Safe to call at any await point: it throws synchronously, never rejects late.
const throwIfAborted = (signal) => {
  if (signal && signal.aborted) {
    const err = new Error('voice turn aborted');
    err.name = 'AbortError';
    throw err;
  }
};

async function executeTool(name, args, tenant, customerId, channel = 'whatsapp') {
  switch (name) {
    case 'check_availability':
      return await appointmentService.checkAvailability(tenant.id, args.date);
    case 'book_appointment': {
      // PORTAL-P5-S14 isolation guarantee: a test turn has no real customer row
      // (customerId is null), so a real INSERT would hit a FK violation. Gated
      // here rather than relying on that error, so the model gets an honest,
      // structured result to relay instead of the turn crashing.
      if (channel === 'test') {
        return {
          success: false,
          reason: 'test_mode',
          error: 'This is a test conversation, not a real one — bookings can’t be completed here. Tell the owner to confirm on a real WhatsApp message or phone call.',
        };
      }
      const result = await appointmentService.bookAppointment(
        tenant.id, customerId, args.doctor_name, args.appointment_time, args.patient_name
      );
      if (result.success) {
        notificationService.notifyOwnerOfBooking(tenant, result).catch(err =>
          logger.error({ err: err.message }, 'notification unexpected error')
        );
      }
      return result;
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

const generateReply = async (tenant, customer, conversation, userMessage, history, knowledgeChunks = [], facts = [], { channel = 'whatsapp', metrics = null, signal = null, onCommitted = null } = {}) => {
  // ── Voice prompt diet (channel === 'voice' ONLY; default path untouched) ──
  // History: keep the last VOICE_HISTORY_TURNS entries (one entry = one stored
  // message). Facts: keep the VOICE_MEMORY_FACTS_MAX most recently updated
  // (contextAssembler supplies updated_at), rendered most-recent-first; under
  // the cap the existing key order is kept unchanged.
  let promptHistory = history;
  let promptFacts = facts;
  if (channel === 'voice') {
    promptHistory = history.slice(-envInt('VOICE_HISTORY_TURNS', 8));
    const maxFacts = envInt('VOICE_MEMORY_FACTS_MAX', 10);
    if (facts.length > maxFacts) {
      promptFacts = [...facts]
        .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
        .slice(0, maxFacts);
    }
  }

  const systemInstruction = await resolveSystemInstruction(
    tenant, customer, conversation, promptFacts, knowledgeChunks, channel);

  const model = modelProvider({
    model: GEMINI_MODEL,
    systemInstruction,
    tools: TOOLS
  });

  const chatHistory = promptHistory.map(m => ({
    role: m.sender === 'customer' ? 'user' : 'model',
    parts: [{ text: m.content }]
  }));

  // Gemini requires the first content's role to be 'user'. A voice history window
  // can open with the AI greeting (role 'model'), which triggers a 500 ("First
  // content should be with role 'user', got model"). Drop leading non-user
  // entries so chatHistory[0].role === 'user' (or [] if none remain).
  while (chatHistory.length && chatHistory[0].role !== 'user') {
    chatHistory.shift();
  }

  // ── Generation config ──
  // Default channel: EXACTLY the pre-PR object (guarded by test). Voice:
  // thinking disabled (thinkingBudget 0) + tighter output cap, both env-tunable.
  // The installed SDK (@google/generative-ai@0.24.1) serializes generationConfig
  // verbatim into the v1beta request, and ChatSession reuses it for EVERY
  // sendMessage — so this covers tool-loop intermediate calls too.
  const generationConfig = channel === 'voice'
    ? {
        maxOutputTokens: envInt('VOICE_MAX_OUTPUT_TOKENS', 150),
        temperature: 0.7,
        thinkingConfig: { thinkingBudget: envInt('VOICE_THINKING_BUDGET', 0) }
      }
    : {
        maxOutputTokens: 250,
        temperature: 0.7
      };

  const chat = model.startChat({
    history: chatHistory,
    generationConfig
  });

  // Point of no return (Issue 29): flips when a MUTATING tool (TOOL_META)
  // executes. From then on: no abort checks, and Gemini calls drop the signal
  // — aborting between a committed booking and its persisted/spoken
  // confirmation would manufacture a torn write worse than the slow turn
  // being cancelled. The route learns of the crossing via onCommitted.
  let committed = false;

  // Observability-only seam: when a metrics collector is passed (voice turn
  // path), record per-call latency + token usage and per-tool timings. The
  // WhatsApp path passes no collector — zero change there.
  const sendTimed = async (payload) => {
    const t0 = process.hrtime.bigint();
    const result = (signal && !committed)
      ? await chat.sendMessage(payload, { signal })
      : await chat.sendMessage(payload);
    if (metrics) {
      metrics.recordGeminiCall({
        latency_ms: Number(process.hrtime.bigint() - t0) / 1e6,
        usageMetadata: result.response.usageMetadata,
        model: GEMINI_MODEL,
        finish_reason: finishReasonOf(result.response),
      });
    }
    return result;
  };

  // Abort checkpoints (Issue 29): before EVERY Gemini call and before EVERY
  // tool execution, until the point of no return. No signal (WhatsApp path,
  // pre-Issue-29 callers) ⇒ every check is a no-op — behavior unchanged.
  throwIfAborted(signal);
  let result = await sendTimed(userMessage);
  let loops = 0;

  while (result.response.functionCalls() && loops < 5) {
    const calls = result.response.functionCalls();
    const responses = [];

    for (const call of calls) {
      if (!committed) throwIfAborted(signal);
      logger.info({ tool: call.name, args: call.args }, 'tool call');
      const t0 = process.hrtime.bigint();
      const output = await executeTool(call.name, call.args, tenant, customer.id, channel);
      if (metrics) metrics.recordToolExec(call.name, Number(process.hrtime.bigint() - t0) / 1e6, toolOutcome(output));
      logger.info({ tool: call.name, output: JSON.stringify(output).substring(0, 200) }, 'tool result');
      if (!committed && isMutatingTool(call.name)) {
        committed = true;
        if (onCommitted) onCommitted();
      }
      responses.push({ functionResponse: { name: call.name, response: output } });
    }

    if (!committed) throwIfAborted(signal);
    result = await sendTimed(responses);
    loops++;
  }

  return result.response.text().trim();
};

/**
 * PR9C — streaming variant of generateReply for the VOICE SSE turn path ONLY.
 *
 * Mirrors generateReply's `channel === 'voice'` branch exactly (prompt diet,
 * system prompt, tools, generationConfig with thinkingBudget 0 + output cap);
 * the two MUST stay in sync — the WhatsApp/default path never reaches this
 * function. Every model call uses sendMessageStream: a call is a final
 * candidate until its FIRST streamed part turns out to be a functionCall
 * (verified live in Phase 0: tool-round completions arrive functionCall-first
 * with no leading prose).
 *
 * options:
 *   metrics     PR9A turn timer (recordGeminiCall gains streamed:true)
 *   signal      AbortSignal — aborts the in-flight Gemini stream (disconnect)
 *   onToolRound invoked when a completion resolves to a tool round, BEFORE any
 *               tool executes (the route emits the ack here; may fire once per
 *               round — the caller de-dupes)
 *   onDelta     invoked per text chunk of a final completion, in order
 *
 * Returns the full final reply text (the route persists it and emits `done`).
 */
const generateReplyStream = async (tenant, customer, conversation, userMessage, history, knowledgeChunks = [], facts = [], { metrics = null, signal = null, onToolRound = null, onDelta = null } = {}) => {
  // ── Voice prompt diet — mirror of generateReply (channel === 'voice') ──
  const promptHistory = history.slice(-envInt('VOICE_HISTORY_TURNS', 8));
  const maxFacts = envInt('VOICE_MEMORY_FACTS_MAX', 10);
  let promptFacts = facts;
  if (facts.length > maxFacts) {
    promptFacts = [...facts]
      .sort((a, b) => new Date(b.updated_at || 0) - new Date(a.updated_at || 0))
      .slice(0, maxFacts);
  }

  const systemInstruction = await resolveSystemInstruction(
    tenant, customer, conversation, promptFacts, knowledgeChunks, 'voice');

  const model = modelProvider({
    model: GEMINI_MODEL,
    systemInstruction,
    tools: TOOLS
  });

  const chatHistory = promptHistory.map(m => ({
    role: m.sender === 'customer' ? 'user' : 'model',
    parts: [{ text: m.content }]
  }));
  while (chatHistory.length && chatHistory[0].role !== 'user') {
    chatHistory.shift();
  }

  // Same voice generationConfig as generateReply — the thinking-0 canary and
  // the output cap apply to every streamed call (guarded by test).
  const generationConfig = {
    maxOutputTokens: envInt('VOICE_MAX_OUTPUT_TOKENS', 150),
    temperature: 0.7,
    thinkingConfig: { thinkingBudget: envInt('VOICE_THINKING_BUDGET', 0) }
  };

  const chat = model.startChat({ history: chatHistory, generationConfig });

  const requestOptions = signal ? { signal } : {};
  // Abort checks between calls/tools use the shared module-level
  // throwIfAborted (Issue 29) — one idiom for both turn paths. Note: the SSE
  // path deliberately keeps its pre-Issue-29 semantics (abort checked before
  // every tool, partial persisted on disconnect) — the JSON path's
  // point-of-no-return applies only there; unify when SSE goes live.

  let payload = userMessage;
  let finalText = '';
  let loops = 0;

  while (true) {
    throwIfAborted(signal);
    const t0 = process.hrtime.bigint();
    const streamResult = await chat.sendMessageStream(payload, requestOptions);
    // The SDK's aggregated-response promise rejects independently on abort;
    // without a handler the process dies on an unhandled rejection (observed
    // live in the Phase 0 probe).
    streamResult.response.catch(() => {});

    // Hold text until the FIRST part identifies the completion: functionCall
    // first ⇒ tool round (no deltas ever leave this call); text first ⇒ final
    // answer, forward every text part as it arrives.
    let kind = null;
    for await (const chunk of streamResult.stream) {
      const parts = chunk.candidates?.[0]?.content?.parts || [];
      for (const part of parts) {
        if (kind === null) {
          kind = part.functionCall ? 'tool' : 'text';
          if (kind === 'tool' && onToolRound) await onToolRound();
        }
        if (kind === 'text' && part.text) {
          finalText += part.text;
          if (onDelta) await onDelta(part.text);
        }
      }
    }

    const agg = await streamResult.response;
    if (metrics) {
      metrics.recordGeminiCall({
        latency_ms: Number(process.hrtime.bigint() - t0) / 1e6,
        usageMetadata: agg.usageMetadata,
        streamed: true,
        model: GEMINI_MODEL,
        finish_reason: finishReasonOf(agg),
      });
    }

    const calls = agg.functionCalls();
    if (calls && calls.length && loops < 5) {
      if (kind === 'text') {
        // Phase 0 says this doesn't happen (functionCall-first, no prose);
        // if the model ever mixes, keep booking-correct: the prose was already
        // forwarded, still execute the tools and let the next round finish.
        logger.warn({ loops }, 'streamed completion mixed text before functionCall');
      }
      const responses = [];
      for (const call of calls) {
        throwIfAborted(signal);
        logger.info({ tool: call.name, args: call.args }, 'tool call');
        const t1 = process.hrtime.bigint();
        const output = await executeTool(call.name, call.args, tenant, customer.id);
        if (metrics) metrics.recordToolExec(call.name, Number(process.hrtime.bigint() - t1) / 1e6, toolOutcome(output));
        logger.info({ tool: call.name, output: JSON.stringify(output).substring(0, 200) }, 'tool result');
        responses.push({ functionResponse: { name: call.name, response: output } });
      }
      payload = responses;
      loops++;
      continue;
    }

    return finalText.trim();
  }
};

// Prompt-head precedence (Issue 10). Order is pinned:
//   1. tenants.ai_prompt non-empty → used VERBATIM (legacy override) + WARN
//   2. tenant config present       → renderSystemPrompt(config, {channel})
//   3. neither                     → MINIMAL_SAFE_PROMPT + ERROR
// Never throws — a prompt problem must not take down a live turn.
const hasLegacyPrompt = (tenant) =>
  tenant.ai_prompt != null && String(tenant.ai_prompt).trim() !== '';

// Distinguishes "config read threw" from "tenant has no config row": both end
// at the safe prompt, but only the latter is a no_prompt_source ERROR (the
// former already logged its own, more accurate, ERROR in configForPrompt).
const CONFIG_FETCH_FAILED = Symbol('config-fetch-failed');

// Returns { head, mode } — mode is the trace-provenance label (Issue 22):
// 'legacy' (verbatim ai_prompt override), 'rendered' (config-rendered), or
// 'default' (minimal safe prompt, whatever the reason).
const resolvePromptHead = (tenant, config, channel) => {
  if (hasLegacyPrompt(tenant)) {
    logger.warn({ scope: 'prompts', tenantId: tenant.id, event: 'legacy_prompt_override' },
      'legacy ai_prompt overrides rendered prompt');
    return { head: tenant.ai_prompt, mode: 'legacy' };
  }
  if (config && config !== CONFIG_FETCH_FAILED) {
    try {
      const head = renderSystemPrompt(config, {
        channel,
        onWarn: (event, detail) =>
          logger.warn({ scope: 'prompts', tenantId: tenant.id, event, ...detail }, 'prompt render warning'),
      });
      return { head, mode: 'rendered' };
    } catch (err) {
      logger.error({ scope: 'prompts', tenantId: tenant.id, err: err.message },
        'prompt render failed — using minimal safe prompt');
      return { head: MINIMAL_SAFE_PROMPT, mode: 'default' };
    }
  }
  if (config !== CONFIG_FETCH_FAILED) {
    logger.error({ scope: 'prompts', tenantId: tenant.id, event: 'no_prompt_source' },
      'no tenant config and no ai_prompt — using minimal safe prompt');
  }
  return { head: MINIMAL_SAFE_PROMPT, mode: 'default' };
};

// Finish reason of a Gemini response (aggregated or unary) for trace llm meta —
// one definition so the streamed and unary capture paths stay in lockstep.
const finishReasonOf = (response) => response?.candidates?.[0]?.finishReason ?? null;

// Compact tool outcome for the trace row: status + the tool's own error string
// (+ success flag when the tool reports one) — NEVER the tool output itself.
const toolOutcome = (output) => {
  if (!output || typeof output !== 'object') return { status: 'ok' };
  if (output.error) return { status: 'error', error: String(output.error) };
  return output.success !== undefined
    ? { status: 'ok', success: !!output.success }
    : { status: 'ok' };
};

// Fetch config, build the system prompt, and record its provenance onto the
// active trace collector (Issue 22) — the ONE prompt-preparation path both
// generateReply and generateReplyStream call, so provenance can never diverge
// between the two intentional mirrors. Provenance is sha256 of the FINAL
// system prompt + the tenant-config version + which precedence branch produced
// the head. The hash is always computed (legacy included); the full text never
// reaches the trace. Provenance is a no-op outside a traced turn.
const resolveSystemInstruction = async (tenant, customer, conversation, facts, knowledgeChunks, channel) => {
  const { text, mode } = buildSystemPrompt(
    tenant, customer, conversation, facts, knowledgeChunks, channel, await configForPrompt(tenant));

  const trace = traces.current();
  if (trace) {
    trace.setPrompt({
      hash: crypto.createHash('sha256').update(text).digest('hex'),
      config_version: mode === 'rendered' ? configService.getCachedConfigVersion(tenant.id) : null,
      mode,
    });
  }
  return text;
};

// Fetch the config document only when the precedence chain can reach it (no
// legacy override). Legacy tenants take ZERO new calls — their path is
// byte-identical to pre-Issue-10. Config errors degrade to the safe prompt.
const configForPrompt = async (tenant) => {
  if (hasLegacyPrompt(tenant)) return null;
  try {
    return await configService.getTenantConfig(tenant.id);
  } catch (err) {
    logger.error({ scope: 'prompts', tenantId: tenant.id, err: err.message },
      'config fetch failed — prompt falls back to minimal safe prompt');
    return CONFIG_FETCH_FAILED;
  }
};

// Returns { text, mode }: the full system prompt plus the provenance mode of
// its head (see resolvePromptHead). Internal — both generateReply variants
// destructure it.
const buildSystemPrompt = (tenant, customer, conversation, facts, knowledgeChunks = [], channel = 'whatsapp', config = null) => {
  const factLines = facts.length
    ? facts.map(f => `- ${f.key}: ${f.value}`).join('\n')
    : 'None yet.';

  const summarySection = conversation.summary
    ? `\nConversation summary:\n${conversation.summary}`
    : '';

  const knowledgeSection = knowledgeChunks.length
    ? `\nBusiness knowledge (use ONLY this to answer questions — do not invent information):\n${knowledgeChunks.map(c => `- ${c.content}`).join('\n')}`
    : '';

  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const dayOfWeek = new Date().toLocaleDateString('en-US', { timeZone: 'Asia/Kolkata', weekday: 'long' });

  // Presentation-only branch. Business logic, tools, and guards are identical
  // across channels — voice differs only in how the reply is delivered (spoken).
  const voiceStyle = channel === 'voice'
    ? `\n\nVoice call style (your reply is spoken aloud on a phone call):
- Use plain spoken words ONLY — no markdown, asterisks, bullet points, emoji, or links
- 1-2 short sentences a caller can follow by ear; ask only one thing at a time
- Speak times and dates naturally (e.g. "ten thirty in the morning", "Wednesday the fifth")`
    : '';

  const { head, mode } = resolvePromptHead(tenant, config, channel);

  // GUARD-01: who's asking, for the identity guardrail's wording — mirrors
  // the clinic template's own voice/whatsapp 'who' split.
  const who = channel === 'voice' ? 'caller' : 'customer';

  const text = `
${head}

Today is ${dayOfWeek}, ${todayIST} (IST — Asia/Kolkata timezone).

Customer phone: ${customer.phone}${customer.name ? `\nCustomer name: ${customer.name}` : `\n${unknownIdentityLine(who)}`}

What we know about this customer:
${factLines}${summarySection}${knowledgeSection}

Rules:
- Keep replies SHORT (1-3 sentences max)
- Detect user's language (Hindi/Telugu/English) and reply in the SAME language
- NEVER make up information you don't have — say "Let me check and get back to you"
- If business knowledge is provided above, use it to answer. Do NOT add details beyond what is given.
- Be conversational and friendly

Appointment booking rules:
- When the customer mentions an appointment, booking, doctor, or availability: IMMEDIATELY call check_availability with the date — do NOT reply with text first
- Resolve relative dates BEFORE calling: "tomorrow" = next day, "Wednesday" = the next upcoming Wednesday, "kal" = tomorrow, "parso" = day after tomorrow
- After getting availability results, present the free slots and ask the customer to pick one
- ALWAYS echo back the exact doctor + date + time and get an explicit "yes"/"haan"/"avunu" BEFORE calling book_appointment
- Never call book_appointment on first mention — confirm first, book second
- All times are IST. If a day is closed or fully booked, say so and suggest the nearest open day
- Politely decline past dates or past times today
${voiceStyle}
`.trim();

  return { text, mode };
};

module.exports = { generateReply, generateReplyStream, throwIfAborted, _setModelProvider };
