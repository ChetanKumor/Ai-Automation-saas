const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../../infra/logging/logger');
const appointmentService = require('../appointment/appointmentService');
const notificationService = require('../notification/notificationService');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Injectable model factory. Production uses Gemini; tests can script the tool
// loop deterministically without a live model. Not a business-logic seam.
let modelProvider = (config) => genAI.getGenerativeModel(config);
function _setModelProvider(fn) {
  modelProvider = fn || ((config) => genAI.getGenerativeModel(config));
}

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

// Read an optional integer env knob at call time (tests can set/unset per case).
const envInt = (name, fallback) => {
  const v = parseInt(process.env[name], 10);
  return Number.isFinite(v) ? v : fallback;
};

async function executeTool(name, args, tenant, customerId) {
  switch (name) {
    case 'check_availability':
      return await appointmentService.checkAvailability(tenant.id, args.date);
    case 'book_appointment': {
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

const generateReply = async (tenant, customer, conversation, userMessage, history, knowledgeChunks = [], facts = [], { channel = 'whatsapp', metrics = null } = {}) => {
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

  const model = modelProvider({
    model: 'gemini-2.5-flash',
    systemInstruction: buildSystemPrompt(tenant, customer, conversation, promptFacts, knowledgeChunks, channel),
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

  // Observability-only seam: when a metrics collector is passed (voice turn
  // path), record per-call latency + token usage and per-tool timings. The
  // WhatsApp path passes no collector — zero change there.
  const sendTimed = async (payload) => {
    const t0 = process.hrtime.bigint();
    const result = await chat.sendMessage(payload);
    if (metrics) {
      metrics.recordGeminiCall({
        latency_ms: Number(process.hrtime.bigint() - t0) / 1e6,
        usageMetadata: result.response.usageMetadata,
      });
    }
    return result;
  };

  let result = await sendTimed(userMessage);
  let loops = 0;

  while (result.response.functionCalls() && loops < 5) {
    const calls = result.response.functionCalls();
    const responses = [];

    for (const call of calls) {
      logger.info({ tool: call.name, args: call.args }, 'tool call');
      const t0 = process.hrtime.bigint();
      const output = await executeTool(call.name, call.args, tenant, customer.id);
      if (metrics) metrics.recordToolExec(call.name, Number(process.hrtime.bigint() - t0) / 1e6);
      logger.info({ tool: call.name, output: JSON.stringify(output).substring(0, 200) }, 'tool result');
      responses.push({ functionResponse: { name: call.name, response: output } });
    }

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

  const model = modelProvider({
    model: 'gemini-2.5-flash',
    systemInstruction: buildSystemPrompt(tenant, customer, conversation, promptFacts, knowledgeChunks, 'voice'),
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
  // The SDK only reacts to an abort that fires while a request is in flight
  // (it adds an 'abort' listener; an ALREADY-aborted signal is ignored) — so
  // check between calls/tools ourselves to stop the loop on disconnect.
  const throwIfAborted = () => {
    if (signal && signal.aborted) {
      const err = new Error('voice turn aborted');
      err.name = 'AbortError';
      throw err;
    }
  };

  let payload = userMessage;
  let finalText = '';
  let loops = 0;

  while (true) {
    throwIfAborted();
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
        throwIfAborted();
        logger.info({ tool: call.name, args: call.args }, 'tool call');
        const t1 = process.hrtime.bigint();
        const output = await executeTool(call.name, call.args, tenant, customer.id);
        if (metrics) metrics.recordToolExec(call.name, Number(process.hrtime.bigint() - t1) / 1e6);
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

const buildSystemPrompt = (tenant, customer, conversation, facts, knowledgeChunks = [], channel = 'whatsapp') => {
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

  return `
${tenant.ai_prompt}

Today is ${dayOfWeek}, ${todayIST} (IST — Asia/Kolkata timezone).

Customer phone: ${customer.phone}${customer.name ? `\nCustomer name: ${customer.name}` : ''}

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
};

module.exports = { generateReply, generateReplyStream, _setModelProvider };
