const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('../../db/db');
const appointmentService = require('../appointment/appointmentService');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

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

async function executeTool(name, args, tenantId, customerId) {
  switch (name) {
    case 'check_availability':
      return await appointmentService.checkAvailability(tenantId, args.date);
    case 'book_appointment':
      return await appointmentService.bookAppointment(
        tenantId, customerId, args.doctor_name, args.appointment_time, args.patient_name
      );
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

const generateReply = async (tenant, customer, conversation, userMessage, history, knowledgeChunks = []) => {
  const { rows: facts } = await db.query(
    `SELECT key, value FROM customer_memory WHERE tenant_id = $1 AND customer_id = $2 ORDER BY key`,
    [tenant.id, customer.id]
  );

  const model = genAI.getGenerativeModel({
    model: 'gemini-3-flash-preview',
    systemInstruction: buildSystemPrompt(tenant, customer, conversation, facts, knowledgeChunks),
    tools: TOOLS
  });

  const chatHistory = history.map(m => ({
    role: m.sender === 'customer' ? 'user' : 'model',
    parts: [{ text: m.content }]
  }));

  const chat = model.startChat({
    history: chatHistory,
    generationConfig: {
      maxOutputTokens: 300,
      temperature: 0.7
    }
  });

  let result = await chat.sendMessage(userMessage);
  let loops = 0;

  while (result.response.functionCalls() && loops < 5) {
    const calls = result.response.functionCalls();
    const responses = [];

    for (const call of calls) {
      console.log(`  [tool] ${call.name}(${JSON.stringify(call.args)})`);
      const output = await executeTool(call.name, call.args, tenant.id, customer.id);
      console.log(`  [tool] → ${JSON.stringify(output).substring(0, 200)}`);
      responses.push({ functionResponse: { name: call.name, response: output } });
    }

    result = await chat.sendMessage(responses);
    loops++;
  }

  return result.response.text().trim();
};

const buildSystemPrompt = (tenant, customer, conversation, facts, knowledgeChunks = []) => {
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
`.trim();
};

module.exports = { generateReply };
