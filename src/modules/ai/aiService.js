const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const generateReply = async (tenant, customer, userMessage, history) => {
  const model = genAI.getGenerativeModel({
    model: 'gemini-1.5-flash',
    systemInstruction: buildSystemPrompt(tenant, customer)
  });

  // Convert DB history to Gemini format
  const chatHistory = history.map(m => ({
    role: m.role === 'user' ? 'user' : 'model',
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

const buildSystemPrompt = (tenant, customer) => `
${tenant.ai_prompt}

Rules:
- Keep replies SHORT (1-3 sentences max)
- Detect user's language (Hindi/Telugu/English) and reply in the SAME language
- NEVER make up information you don't have — say "Let me check and get back to you"
- Be conversational and friendly
- Customer phone: ${customer.phone}
`.trim();

module.exports = { generateReply };