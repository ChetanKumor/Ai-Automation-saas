const whatsappService = require('../whatsapp/whatsappService');

const handle = async (tenant, from, userText, wamid) => {
  console.log(`[Owner] Message from owner ${from}: "${userText}"`);

  // Stub — will be replaced in Step 3 with full command parsing
  await whatsappService.sendMessage(
    tenant,
    from,
    `✅ Owner detected. You said: "${userText}"\nCommands coming in Step 3.`
  );
};

module.exports = { handle };
