# PR9C — Voice Latency: SSE Turn Mode + Brain-Authored Acknowledgment

Paste everything below into a fresh Claude Code session.

---

You are the lead engineer for the Zyon voice runtime (Node brain + Python worker).

The architecture is FROZEN. Do NOT redesign anything.

- The Node backend is the ONLY brain; it authors EVERY word the system speaks, including
  acknowledgments. The Python worker is transport only and generates zero language.
- WhatsApp behavior remains byte-for-byte identical. No shared-prompt, shared-tool, or default-path
  changes.
- The existing JSON contract on `POST /internal/voice/turn` → `{ reply_text, end_call, language }`
  remains byte-identical and remains the default. This PR ADDS an opt-in SSE mode — the previously
  planned "streaming PR" that the contract freeze was explicitly waiting for. No other endpoint
  changes.

## CONTEXT (measured)

Colocated-basis booking turn ≈ 3.0–3.3s: fetch_parallel ~0.3s (embed-bound) → gemini_call_1 ~1.2s
(returns a functionCall, 59 output tokens) → tool ~0.05s → gemini_call_2 ~1.2s (24-token
confirmation) → persist. The caller hears nothing until the end. Goal: first audio ≤2.0s on tool
turns via (a) a brain-authored ack event emitted the moment call 1 resolves to a tool round, and
(b) streaming the final completion's text as delta events so TTS starts at first-token instead of
last-token. Replies are short (24–59 tokens), so (a) is the dominant win; (b) additionally covers
long FAQ answers. thinking_tokens=0 is a live canary and MUST remain enforced on the streaming
path.

## PHASE 0 — Verify before coding (STOP conditions are real)

1. Installed SDK `@google/generative-ai@0.24.1` (deprecated; verify in node_modules, not memory):
   (a) confirm a streaming generate method exists and how streamed chunks surface functionCall
   parts vs text parts (file:line in dist); (b) confirm `generationConfig.thinkingConfig`
   pass-through works on the STREAMING method — write a live one-off probe like PR9A's: streamed
   trivial prompt with thinkingBudget:0 must show thoughtsTokenCount absent/0 on the aggregated
   response, and usageMetadata must still be retrievable. **STOP if streaming drops thinkingConfig
   or usageMetadata** — thinking would silently return at +2s/call. (c) Identify the abort
   mechanism for an in-flight stream in this SDK version (signal/requestOptions/iterator break) —
   record which; if none exists, iterator-break-plus-discard is acceptable, note it.
2. Tool loop in `aiService.js`: confirm call-1 responses on tool turns arrive as functionCall parts
   with no leading prose (check the scripted seam + one live probe). Design assumption: hold text
   deltas until the FIRST part of a call arrives; first part functionCall → tool round; first part
   text → final answer, start forwarding. If the model interleaves prose before functionCall in
   practice, report it and implement the buffer-first-sentence fallback described in Phase 1.3.
3. Worker: confirm (PR7B evidence) that `llm_node` yielding multiple chunks feeds the TTS segment
   incrementally starting from the first chunk, and identify how the framework/tokenizer
   sentence-chunks incremental text into Bulbul v3 streaming (file:line in installed plugin).
   Confirm generator cancellation on barge-in propagates (what the framework does to `llm_node`'s
   async generator when the user interrupts).
4. Confirm the call/end float fix is landed (route no longer 500s). Not blocking, but report.
5. Verify whether the owner-notify WhatsApp send inside `book_appointment` is awaited on the turn
   path or deferred. Report only — do NOT fix here.
6. `messages` schema: confirm how an interrupted/partial outbound can be persisted (existing
   columns only; no migration in this PR).

## PHASE 1 — Implementation

**Feature flags (dark ship both sides):** Node route serves SSE only when the request opts in
(header `Accept: text/event-stream` AND body flag `stream: true` — belt and braces); worker sends
that opt-in only when `VOICE_STREAM_TURNS=true` (default false). Flag off ⇒ every byte identical
to today on both sides.

**1. Node — SSE branch on `/internal/voice/turn` (same route, same HMAC on the raw request body,
same hydrate/gate/fetch/persist-inbound flow):**
Event protocol (SSE, in order):
- `event: ack` · `data: {"text": <string>, "language": <code>}` — emitted at most once per turn,
  ONLY when the reply loop enters a tool round, immediately BEFORE executing tools. Text comes from
  Node-owned per-language constants (`te-IN`, `hi-IN`, `en-IN`; e.g. te-IN "ఒక్క నిమిషం, చూస్తున్నాను")
  selected by the turn's effective language. Env-overridable copy later; constants now.
- `event: delta` · `data: {"text": <chunk>}` — text chunks of the FINAL completion only. Never
  emit deltas for a completion that turns out to be a tool call (Phase 0.2 gating: hold until
  first part identifies the call type).
- `event: done` · `data: {"reply_text": <full>, "end_call": <bool>, "language": <code>}` — the
  authoritative record, emitted AFTER outbound persistence completes (same persistence semantics
  and ordering as today: full reply text, then `last_message_at`).
- `event: error` · `data: {"message": ...}` — on model/tool failure after headers are sent.
Mechanics: intermediate (tool-round) Gemini calls MAY use the non-streaming method unchanged;
final-candidate calls use the streaming method with the SAME voice generationConfig (thinking 0,
token cap). On client disconnect (`req.on('close')`), abort the in-flight Gemini stream (Phase 0.1c
mechanism), stop the loop, persist what was generated so far as the outbound message (known
approximation: sent-text may exceed spoken-text; note in report), and clean up. Metrics: extend the
PR9A turn line with `ack_emitted_ms`, `first_delta_ms`, `stream_mode: true`, and per-call
`streamed: bool`; thinking canary asserts stay on.

**2. Worker — SSE consumption in the delegation path (`brain_client.py` + `llm_node` shim):**
When `VOICE_STREAM_TURNS=true`: send the opt-in, consume SSE over the existing persistent client
(per-chunk read timeout of `VOICE_TURN_TIMEOUT_S` replacing whole-body timeout; overall hard cap
`VOICE_TURN_MAX_S`, default 60). Yield `ack.text` as the first chunk (TTS speaks it), then yield
each `delta.text` as received; on `done`, apply `end_call`/`language` exactly as the JSON path does
today (drain-then-shutdown, `update_options` on language change — note: language switching
mid-stream is NOT supported; the TTS language for the turn is fixed by the turn's start language,
`done.language` only updates state for the NEXT turn — record this limitation). On generator
cancellation (barge-in), close the HTTP stream so Node's disconnect abort fires. On transport error
mid-stream after the ack was spoken: yield the existing static per-language apology and end the
turn (never silence). Flag off ⇒ current JSON code path untouched, existing tests must pass
unmodified.

## PHASE 2 — Tests

Node (extend the scripted-model seam to script streamed parts): (1) tool turn → event order
ack→delta…→done, ack precedes tool execution timestamp, done carries full reply, outbound row
persisted before done; (2) plain turn → NO ack, deltas→done; (3) JSON mode with flag off →
byte-identical response body to a recorded pre-PR fixture; (4) client disconnect mid-stream →
model stream aborted (spy), partial outbound persisted, no crash; (5) HMAC failure → 401 before
any SSE bytes; (6) streamed calls carry the voice generationConfig and the metrics line shows
thinking_tokens=0 (canary); (7) mode/ai_enabled gate behaves identically in SSE mode.
Worker: (1) mock SSE server → llm_node yields ack then deltas verbatim, done handled, end_call
drain path invoked once; (2) barge-in/generator close → HTTP stream closed; (3) mid-stream
transport error → static apology yielded; (4) per-chunk timeout honored; (5) flag off → all
existing delegation tests pass untouched.
Full Node suite green; zero diffs in WhatsApp modules; worker suite green.

## PHASE 3 — Report + measurement protocol

Report: Phase 0 evidence (SDK streaming surfaces + thinking probe result + abort mechanism; plugin
incremental-TTS evidence; owner-notify finding; call/end status), files modified, env vars
(`VOICE_STREAM_TURNS` false, `VOICE_TURN_MAX_S` 60), tests + results, deviations/STOPs, known
limitations (mid-stream language, spoken-vs-sent on interrupt).

Measurement (operator, on COLOCATED infra — local WAN numbers are known-distorted): flag on; 3
Telugu bookings + 3 FAQ turns + 1 barge-in. Collect turn metrics + worker first-TTS-chunk times.
Success gate: tool-turn first audio ≤2.0s (ack), plain-turn first audio ≤1.5s, done.reply_text
persisted correctly, barge-in aborts cleanly, thinking_tokens 0 throughout.

## OUT OF SCOPE

KB-at-call-start / embed removal (next PR) · hydrate parallelization · fire-and-forget persistence
· owner-notify deferral (report only) · per-tenant ack copy config · mid-stream language switching
· Vertex/regional moves · WhatsApp anything · migrations · the extraction event-name bug.

Rollback: `VOICE_STREAM_TURNS=false` (worker) restores today's JSON path instantly; Node's JSON
branch is untouched code. Commits: atomic conventional, e.g. `feat(voice): opt-in SSE turn mode
with brain-authored ack`, `feat(voice-agent): consume SSE turn stream in llm_node`. If ANY Phase 0
check fails its STOP condition, stop and report before modifying code.
