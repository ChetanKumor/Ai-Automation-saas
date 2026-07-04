const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger     = require('../../infra/logging/logger');
const eventBus   = require('../../../core/events');
const EVENT      = require('../../../core/eventTypes');
const crmService = require('./crmService');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const EXTRACTION_PROMPT = `You are a lead extraction system. Analyze the customer message and extract structured data.
Return STRICT JSON only — no markdown, no code fences, no explanation.
Schema: {"name": string|null, "requirement": string|null, "budget": string|null, "intent_level": "low"|"medium"|"high"|null}
Rules:
- "name" — the customer's name if they mention it, else null.
- "requirement" — what the customer wants/needs, summarized in one short phrase, else null.
- "budget" — any mentioned budget or price range as a string, else null.
- "intent_level" — "high" if they want to buy/book now, "medium" if interested/asking questions, "low" if casual/browsing, null if unclear.
- If the message is a greeting or contains no lead signals, return all nulls: {"name":null,"requirement":null,"budget":null,"intent_level":null}`;

function parseExtraction(raw) {
  try {
    const text = raw.replace(/```json\s*/g, '').replace(/```\s*/g, '').trim();
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) return null;

    const allowed = ['low', 'medium', 'high'];
    return {
      name:         typeof parsed.name === 'string' ? parsed.name : null,
      requirement:  typeof parsed.requirement === 'string' ? parsed.requirement : null,
      budget:       typeof parsed.budget === 'string' ? parsed.budget : null,
      intent_level: allowed.includes(parsed.intent_level) ? parsed.intent_level : null,
    };
  } catch (err) {
    logger.warn({ err: err.message }, 'parseExtraction failed');
    return null;
  }
}

function hasSignal(data) {
  return data && (data.name || data.requirement || data.budget || data.intent_level);
}

function init() {
  eventBus.on(EVENT.MESSAGE_RECEIVED, async (envelope) => {
    const { tenant_id, customer_id, conversation_id, text, mode } = envelope.payload;

    if (mode === 'human') return;

    try {
      const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
      const result = await model.generateContent({
        contents: [{ role: 'user', parts: [{ text: `Customer message: "${text}"` }] }],
        systemInstruction: EXTRACTION_PROMPT,
        // gemini-2.5-flash has thinking ON by default, which silently ate the
        // old 200-token cap before the JSON closed (MAX_TOKENS ⇒ zero leads).
        // Disable thinking (PR9A idiom) — extraction is structured output at
        // temp 0, thinking adds cost and no value — and give the JSON headroom.
        generationConfig: { temperature: 0, maxOutputTokens: 512, thinkingConfig: { thinkingBudget: 0 } },
      });

      // Truncation must never be silent: if the model ran out of output budget
      // the JSON is cut mid-object and would parse to garbage. Warn (with tenant
      // + conversation context) and skip rather than write a partial lead.
      const finishReason = result.response.candidates?.[0]?.finishReason;
      if (finishReason === 'MAX_TOKENS') {
        logger.warn(
          { tenant_id, conversation_id, customer_id, finishReason },
          'CRM extraction response truncated (MAX_TOKENS) — skipping lead upsert'
        );
        return;
      }

      const raw = result.response.text().trim();
      const data = parseExtraction(raw);

      if (!data) {
        logger.warn({ raw: raw.slice(0, 200) }, 'LLM returned unparseable extraction output');
        return;
      }
      if (!hasSignal(data)) return;

      const lead = await crmService.upsertLead(tenant_id, customer_id, {
        conversation_id,
        name: data.name,
        requirement: data.requirement,
        budget: data.budget,
        intent_level: data.intent_level,
        source: 'whatsapp',
      });

      if (!lead) return;

      const eventType = lead.is_new ? 'lead_created' : 'lead_updated';
      eventBus.emit(eventType, {
        tenant_id,
        customer_id,
        lead_id: lead.id,
        name: lead.name,
        requirement: lead.requirement,
        budget: lead.budget,
        intent_level: lead.intent_level,
        stage: lead.stage,
      });

      logger.info({ eventType, leadId: lead.id, customerId: customer_id, intent: data.intent_level }, 'CRM extraction');
    } catch (err) {
      logger.error({ err: err.message }, 'CRM extraction failed (non-fatal)');
    }
  });

  logger.info('CRM lead extraction handler initialized');
}

module.exports = { init };
