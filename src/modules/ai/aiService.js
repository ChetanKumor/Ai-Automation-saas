const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('../../db/db');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const generateReply = async (tenant, customer, conversation, userMessage, history) => {
  const { rows: facts } = await db.query(
    `SELECT key, value FROM customer_memory WHERE tenant_id = $1 AND customer_id = $2 ORDER BY key`,
    [tenant.id, customer.id]
  );

  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: buildSystemPrompt(tenant, customer, conversation, facts)
  });

  // 'customer' → Gemini 'user'; 'ai' or 'agent' → Gemini 'model'
  const chatHistory = history.map(m => ({
    role: m.sender === 'customer' ? 'user' : 'model',
    parts: [{ text: m.content }]
  }));

  const chat = model.startChat({
    history: chatHistory,
    generationConfig: {
      maxOutputTokens: 200,
      temperature: 0.7
    }
  });

  const result = await chat.sendMessage(userMessage);
  return result.response.text().trim();
};

const buildSystemPrompt = (tenant, customer, conversation, facts) => {
  const factLines = facts.length
    ? facts.map(f => `- ${f.key}: ${f.value}`).join('\n')
    : 'None yet.';

  const summarySection = conversation.summary
    ? `\nConversation summary:\n${conversation.summary}`
    : '';

  return `
${tenant.ai_prompt}

Customer phone: ${customer.phone}${customer.name ? `\nCustomer name: ${customer.name}` : ''}

What we know about this customer:
${factLines}${summarySection}

Rules:
- Keep replies SHORT (1-3 sentences max)
- Detect user's language (Hindi/Telugu/English) and reply in the SAME language
- NEVER make up information you don't have — say "Let me check and get back to you"
- Be conversational and friendly
`.trim();
};

module.exports = { generateReply };
