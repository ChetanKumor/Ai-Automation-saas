# Retell Voice De-Risk Spike

Throwaway capture server — log every Retell webhook payload so PR6 can parse
real data instead of guessing from docs. Also capture Hindi/Telugu transcripts
for a human STT/TTS quality judgement.

**Delete this entire directory after PR6's parser is built.**

## Setup

```bash
cd spike/voice-retell
npm init -y && npm i express
```

## Run

```bash
node server.js                    # listens on :8787
ngrok http 8787                   # or any tunnel
```

## Configure Retell

1. Open the Retell dashboard → Agents.
2. Create **two agents** with a simple clinic-receptionist prompt:
   - Agent A: language = **Hindi**
   - Agent B: language = **Telugu**
   - Same prompt for both, e.g.:
     > You are a receptionist at a medical clinic. Greet the caller, ask how
     > you can help, take appointment details (name, date, time, doctor
     > preference), confirm, and say goodbye.
3. For each agent, set the **webhook URL** to `<ngrok-url>/retell/webhook`.

## Make test calls

Fastest path: use Retell's **web call** (no telephony needed).

- In the dashboard, click "Test call" on each agent, OR
- Use the trigger script:

```bash
RETELL_API_KEY=ret_xxx node trigger.js <agent_id>
# prints call_id and web-call access_token
```

For outbound phone calls (requires Retell telephony):

```bash
RETELL_API_KEY=ret_xxx node trigger.js <agent_id> +919876543210
```

**Do 5–10 calls per language.** Speak realistic patient utterances — include:
- Appointment request with a specific date/time
- Name spelling
- Rescheduling / cancellation
- Mixed language (Hindi+English, Telugu+English)

## Inspect output

- **stdout** — pretty-printed webhook bodies + transcript turns
- **events.jsonl** — one JSON object per webhook event with `received_at` timestamp
  - Feed this directly to PR6's webhook parser
- **Transcript blocks** — a Hindi/Telugu speaker judges:
  - STT accuracy (did it hear the patient correctly?)
  - TTS naturalness (did the agent sound acceptable?)
  - Turn-taking (did it interrupt or leave awkward gaps?)
- **received_at timestamps** — eyeball turn latency (formal <400ms check is PR7)

## Decision

- Telugu + Hindi judged **good enough** → proceed to PR6
- **Not good enough** → STOP; evaluate alternate voice provider before PR6
