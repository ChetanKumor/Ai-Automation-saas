require('dotenv').config();
const express = require('express');

const app = express();
app.use(express.json());

// Routes
app.use('/webhook', require('./src/webhook/webhookRoutes'));

// Health check
app.get('/health', (_, res) => res.json({ status: 'ok' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});