const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8787;
const EVENTS_FILE = path.join(__dirname, 'events.jsonl');

app.use(express.json());

app.post('/retell/webhook', (req, res) => {
  res.sendStatus(200);

  const event = {
    received_at: new Date().toISOString(),
    body: req.body,
  };

  console.log('\n════════════════════════════════════════');
  console.log('WEBHOOK EVENT  @', event.received_at);
  console.log('════════════════════════════════════════');
  console.log(JSON.stringify(req.body, null, 2));

  printTranscript(req.body);

  fs.appendFileSync(EVENTS_FILE, JSON.stringify(event) + '\n');
});

function printTranscript(body) {
  const transcript =
    body.transcript_object ||
    body.transcript_data ||
    body.transcript;

  if (!transcript) return;

  console.log('\n────────────────────────────────────────');
  console.log('TRANSCRIPT');
  console.log('────────────────────────────────────────');

  if (Array.isArray(transcript)) {
    for (const turn of transcript) {
      const role = turn.role || turn.speaker || '??';
      const text = turn.content || turn.text || turn.transcript || JSON.stringify(turn);
      const ts = turn.words?.[0]?.start != null
        ? `  [${turn.words[0].start}s]`
        : '';
      console.log(`  ${role.toUpperCase()}${ts}: ${text}`);
    }
  } else if (typeof transcript === 'string') {
    console.log(' ', transcript);
  } else {
    console.log(JSON.stringify(transcript, null, 2));
  }

  console.log('────────────────────────────────────────\n');
}

app.get('/health', (_req, res) => res.sendStatus(200));

app.listen(PORT, () => {
  console.log(`Retell spike listening on :${PORT}`);
  console.log(`Events → ${EVENTS_FILE}`);
});
