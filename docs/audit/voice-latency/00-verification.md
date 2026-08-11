# Voice latency — architecture verification

Read-only inspection session. Nothing under `src/`, `voice-agent/` runtime code,
package files or config was modified; the only file this session wrote is this one.

Inspected-at: `4c234afdabd344dba410e94aac24d8f752996365` (HEAD, clean tree, branch `main`)
Inspected-on: 2026-08-11
Phase 0 gate: `npm run os:check` → `os-check OK — state.md matches HEAD` at session start.
Baseline suite at start: `# tests 1043 / # pass 1043 / # fail 0 / # cancelled 0 / # skipped 0`.

Installed versions inspected under `voice-agent/.venv/Lib/site-packages/`:
`livekit-agents 1.6.4`, `livekit-plugins-sarvam 1.6.4`, `livekit-blingfire 1.1.0`.
Paths below written `livekit/agents/...` and `livekit/plugins/sarvam/...` are relative
to that site-packages root; all other paths are repo-relative.

⚠️ **`V1` and `V4` are not defined anywhere in this repository at HEAD.** There is no
voice-latency plan document (`docs/audit/voice-latency/` did not exist before this file),
and the `V-001`…`V-014` series in `docs/os/state.md` is the 2026-07 voice *review
findings*, a different numbering. Each section therefore closes with the implication
stated against **the mechanism the evidence establishes**, which is what a V1/V4 scope
can be checked against once those are written down. No implication below assumes what
V1 or V4 contain.

Measurements labelled *measured this session* were produced by executing the installed
library in `voice-agent/.venv` against literal strings, with no network and no writes.

---

## Q1 — TTS granularity

**VERIFIED.**

### Which path the wiring actually takes

`voice-agent/agent.py:368-372` constructs `sarvam.TTS(model="bulbul:v3", speaker="shubh", …)`.
That class declares `capabilities=tts.TTSCapabilities(streaming=True)`
(`livekit/plugins/sarvam/tts.py:486`). The framework's default TTS node wraps a
non-streaming TTS in a `StreamAdapter` and only then calls `.stream()`
(`livekit/agents/voice/agent.py:506-513`); because `streaming` is true the adapter is
skipped and `sarvam.TTS.stream()` (`tts.py:859-865`) returns a `SynthesizeStream`.

The batch-POST path in this plugin is `ChunkedStream._run`
(`tts.py:886-959`, `POST https://api.sarvam.ai/text-to-speech`, `tts.py:53`), reachable
only through `TTS.synthesize()` (`tts.py:851-857`). **This wiring never calls it.**

### Does synthesis start from the first chunk?

Partly — the *pipeline* does, the *provider* does not.

- A `str` yielded by `BrainAgent.llm_node` is forwarded to the text channel immediately,
  one chunk at a time: `livekit/agents/voice/generation.py:150-152`.
- The first chunk opens a TTS segment and starts a TTS inference task
  (`agent_activity.py:2778-2779` → `_start_segment` → `perform_tts_inference` at
  `:2752`), and every chunk is pushed on arrival (`agent_activity.py:2782`).
- Inside the plugin, the first `str` immediately creates the sentence stream and hands
  it to `_process_segments` (`tts.py:1000-1011`, `:1022-1024`), which acquires a pooled
  WebSocket and sends the `config` frame (`tts.py:1219`, `:1086`). So **connection setup
  overlaps text accumulation** — that part is genuinely incremental.
- But the first `{"type":"text"}` frame to Bulbul is sent only when the sentence
  tokenizer emits a token (`tts.py:1091-1097`), and `_mark_started()` — the framework's
  TTFB anchor — is at `tts.py:1093`, i.e. on that first token, not on connect.

Two further serialisation facts: segments are processed one at a time
(`tts.py:1022-1024`), and the next segment's TTS inference does not start until the
previous segment's inference task completes (`agent_activity.py:2749-2750`). And
`preemptive_tts` defaults to **False** (`livekit/agents/voice/turn.py:223-228`), so
synthesis begins after the speech is scheduled (`agent_activity.py:2818-2822`), not
before.

### Which tokenizer segments the text

`livekit/plugins/sarvam/tts.py:549` — `word_tokenizer = tokenize.basic.SentenceTokenizer()`.
This is **hardcoded inside `TTS.__init__`**: `SarvamTTSOptions` declares a
`word_tokenizer` field (`tts.py:426`) but `:549` overwrites it unconditionally, so it is
not settable from `agent.py`.

That tokenizer's own header comment reads *"Really naive implementation … only English
is really tested"* (`livekit/agents/tokenize/basic.py:15-16`). Its defaults are
`language="english"`, `min_sentence_len=20`, `stream_context_len=10`
(`basic.py:34-48`), and `stream()` returns a `BufferedSentenceStream(min_token_len=20,
min_ctx_len=10)` (`basic.py:60-69`).

Three gates must all clear before one segment is released
(`livekit/agents/tokenize/token_stream.py`):

| Gate | Line | Rule |
|---|---|---|
| context | `:39-40` | nothing is tokenized until the input buffer reaches 10 chars |
| lookahead | `:42-45` | `if len(tokens) <= 1: break` — **a lone sentence is never emitted until a second one begins** |
| length | `:56` | the output buffer must reach 20 chars |

`FlushSentinel` bypasses all three: `tts.py:1012-1015` calls `word_stream.end_input()` →
`flush()` (`token_stream.py:70-91`), which emits whatever is buffered and then starts a
new segment.

### Telugu and Devanagari — measured, not inferred

The end-of-sentence character class is `([.!?。！？])`
(`livekit/agents/tokenize/_basic_sent.py:44-45`): ASCII `.!?` plus the CJK forms.
**The Devanagari danda `।` (U+0964) is absent**, and so is `॥`.

Measured this session against the installed tokenizer:

| Input | Result |
|---|---|
| Telugu, ASCII `.` (the `agent.py:90` apology, 2 sentences) | **2 segments** — splits correctly |
| Hindi, danda (the `agent.py:91` apology, 2 sentences) | **1 segment** — no split |
| English (the `agent.py:92` apology) | 2 segments |

Streamed, with realistic delta sizes, measuring the point of first release:

| Reply | First emit |
|---|---|
| Telugu, 89 chars, ASCII `.` | after **43** chars pushed |
| English, 85 chars | after **38** chars pushed |
| Hindi, 84 chars, danda + one ASCII `?` | after **72** chars pushed |
| Hindi, **pure danda**, 98 chars / 5 sentences | **no emit at all** — the whole reply held until flush, 1 segment |

The last row is the sharp one: for a Hindi reply punctuated the way Hindi is normally
punctuated, incremental synthesis does not happen. The reply is synthesized as one
segment after the generation stream ends.

Swapping tokenizers does not fix it. `livekit-blingfire` is installed and is what the
framework uses on the *non-streaming* fallback path
(`livekit/agents/voice/agent.py:509`); measured this session it also returns **1
sentence** for the same pure-danda Hindi input (it does split the Telugu into 3, where
`basic` merges to 2 under `min_sentence_len=20`).

### Does the plugin stream audio out of Bulbul, or batch-POST per segment?

**It streams, over one WebSocket per segment.** `_run_ws` (`tts.py:1046-1279`) checks out
a pooled connection to `wss://api.sarvam.ai/text-to-speech/ws` (`tts.py:54`, URL built at
`:596`), sends `config` (`:1082-1086`), then one `{"type":"text"}` frame per tokenizer
token (`:1095-1097`), then `{"type":"flush"}` (`:1099-1100`). Audio returns as
`{"type":"audio"}` messages and is pushed to the emitter as it arrives
(`:1339-1352`), terminated by an `event.final` (`:1395-1398`). Connections are pooled
and kept warm with a 20 s protocol heartbeat and a 30 s application ping
(`tts.py:68-69`, `:630-721`).

### SSE mode specifically

`agent.py:256-260` yields the brain-authored ack then a `FlushSentinel`, which is
forwarded verbatim (`generation.py:188-189`) and ends the segment
(`agent_activity.py:2775-2777`). So in SSE mode the ack is its own segment and *is*
released immediately regardless of the three gates — that is exactly what the sentinel
buys, and the docstring at `agent.py:233-239` describes the mechanism correctly. The
deltas that follow open a second segment and are then subject to all three gates again.

**IMPLICATION FOR V1/V4:** Time-to-first-audio is governed not by the SSE transport but
by `tokenize.basic.SentenceTokenizer`'s three release gates inside the Sarvam plugin —
which for Hindi punctuated with `।` never release early at all, making the ack chunk the
only thing standing between a Hindi caller and a full-reply synthesis wait.

---

## Q2 — STT mechanics

**VERIFIED.**

### The final transcript comes from the streaming session, not the batch path

`voice-agent/agent.py:362-367` constructs
`sarvam.STT(model="saaras:v3", mode="transcribe", flush_signal=True, language=…)`.
That class declares `STTCapabilities(streaming=True, interim_results=True)`
(`livekit/plugins/sarvam/stt.py:514-519`). The framework wraps STT in a `StreamAdapter`
only when `not capabilities.streaming` (`livekit/agents/voice/agent.py:430-437`), so the
adapter is skipped and `wrapped_stt.stream(...)` (`agent.py:440`) reaches
`sarvam.STT.stream()` (`stt.py:753-882`) → `SpeechStream`.

The final transcript is emitted by `SpeechStream._send_final_transcript`
(`stt.py:1009-1033`) from `type: "data"` WebSocket messages
(`stt.py:1544-1545`, `:1577-1612`). The endpoint is
`wss://api.sarvam.ai/speech-to-text/ws` (`stt.py:60`); `saaras:v3` sets
`use_translate_endpoint=False` (`stt.py:179`) so `_get_urls_for_model`
(`stt.py:334-346`) selects the non-translate pair.

`_recognize_impl` (`stt.py:623-751`) — the multipart `POST` to
`https://api.sarvam.ai/speech-to-text` that `scripts/demo/capture_stt.py:6-8,34,69`
describes — is **not on this path**. It is reached only via `recognize()`, which this
wiring never calls. `capture_stt.py`'s own header already flags that it is a
reproduction of a path with a different endpoint.

### What performs utterance segmentation

**Sarvam's server-side VAD, over the same socket.** `_build_websocket_url`
(`stt.py:396-437`) hardcodes `vad_signals: "true"` (`:401`) and passes
`flush_signal=true` (`:408-409`) and `mode=transcribe` (`:410-411`).
`_handle_events` (`stt.py:1634-1690`) turns Sarvam's `START_SPEECH` / `END_SPEECH`
signals into the framework's `START_OF_SPEECH` / `END_OF_SPEECH` events. On `END_SPEECH`
it also sets `_should_flush` (`stt.py:1681`), which makes `_process_audio` send
`{"type":"flush"}` (`stt.py:1400-1408`) — that is what `flush_signal=True` buys: the
server is told to finalise rather than waiting on its own timer.

The framework commits the turn on that event: `audio_recognition.py:1167-1202` —
`END_OF_SPEECH` with `turn_detection_mode == "stt"` sets `_user_turn_committed = True`
and runs `_run_eou_detection(trigger="stt")`.

⚠️ **A default Silero VAD *is* loaded and wired, contrary to two comments in
`agent.py`.** `agent.py:360-361` says "no separate VAD model" and `agent.py:381-383` says
"no local VAD model", but `livekit/agents/voice/agent_session.py:413-416` instantiates
`inference.VAD(model="silero")` whenever `vad` is not given, and
`agent_activity.py:883-890` unwires it only when the LLM is a `RealtimeModel` with
turn-detection capability — `BrainStubLLM` (`agent.py:116-123`) is a plain `llm.LLM`, so
the VAD is passed to `AudioRecognition` at `agent_activity.py:895`. It does **not**
commit the turn (`audio_recognition.py:225` sets `_vad_base_turn_detection` False for
mode `"stt"`), but it is loaded and it participates in barge-in. The comments describe
an intent the framework overrides.

### Effective endpoint silence window

`agent.py:384-387` sets `turn_detection: "stt"` and `endpointing: {"min_delay": 0.07}`.

- `_resolve_endpointing` (`voice/turn.py:298-315`) merges over `_ENDPOINTING_DEFAULTS`
  (`turn.py:136-139`: `mode "fixed"`, `min_delay 0.5`, `max_delay 3.0`) — the string
  `"stt"` is not a `_StreamingTurnDetector`, so the legacy defaults are the base. Only
  `min_delay` is overridden: **`max_delay` stays 3.0 and `mode` stays `"fixed"`**.
- `mode: "fixed"` selects `BaseEndpointing` (`endpointing.py:310-322`), which is a plain
  constant — no adaptation.
- Because `turn_detection` is a string, `_turn_detector` is `None`
  (`audio_recognition.py:218`), so the branch that would raise the delay to `max_delay`
  (`audio_recognition.py:1399-1404`) is unreachable. `endpointing_delay` is therefore
  always `min_delay` = **0.07 s** (`audio_recognition.py:1343`). The 3.0 s `max_delay` is
  dead on this wiring.
- The wait is anchored, not absolute: `extra_sleep = endpointing_delay +
  (last_speaking_time - now)` (`audio_recognition.py:1509-1518`). Sarvam's EOS event
  carries no alternatives (`stt.py:1052-1059`), so `has_stt_end_time` is false
  (`audio_recognition.py:1035-1039`) and `last_speaking_time` is set to *now*
  (`:1194-1196`). The framework therefore adds **≈70 ms** after Sarvam's `END_SPEECH`.

So the effective window is **Sarvam's server-side VAD hangover + ~70 ms**. The
server-side half is **not configurable at HEAD**: every fine-grained VAD parameter
(`positive_speech_threshold`, `min_speech_frames`, `negative_frames_window`, …) defaults
to `None` (`stt.py:302-315`), `agent.py` passes none of them, and `_build_websocket_url`
omits any parameter that is `None` (`stt.py:415-435`) — so Sarvam's defaults apply and
this repo has no dial on them.

One tail case: if the final transcript has not arrived when `END_SPEECH` does, EOS is
held and emitted after `EOS_FALLBACK_TIMEOUT = 1.0` s (`stt.py:56`, `:1063-1071`,
`:1673-1678`). That is a **1.0 s** worst-case addition, not part of the normal path.

**IMPLICATION FOR V1/V4:** The endpoint window this repo controls is only the ~70 ms
`min_delay`; the dominant term is Sarvam's server-side VAD hangover, which is reachable
today only by passing the plugin's already-supported VAD parameters that `agent.py`
currently leaves unset.

---

## Q3 — Greeting

**VERIFIED.**

### `/internal/voice/call/start` returns no greeting at HEAD

`handleCallStart` returns exactly four fields (`src/routes/internalVoice.js:592-600`):
`call_session_id`, `customer_id`, `conversation_id`, `correlation_id`. A grep for
`greeting` across `src/routes/internalVoice.js` returns **zero hits**.

### The worker path is therefore dead code

`voice-agent/agent.py:410-415`:

```python
greeting = (started.get("greeting") or "").strip()
if greeting:
    session.say(greeting)
```

`started` is `/call/start`'s response, which has no `greeting` key, so the guard is never
true and `session.say()` never runs. The comment at `agent.py:410-411` already states
this ("`/call/start` does not currently return greeting text; if the brain adds one…") —
the code is a placeholder, correctly labelled.

### How the greeting actually reaches a caller today

Not as audio at call start — as an instruction inside the system prompt. The greeting is
a real, owner-editable config field: `src/modules/config/schema.js:307` declares it as a
per-language record capped at 300 chars, annotated *"it is SPOKEN as-is on voice calls"*;
defaults at `src/modules/config/defaults.js:30`; the portal editor writes it at
`src/portal/routes.js:1525-1560`, `:1611`. The renderer emits it into the prompt at
`src/modules/prompts/templates/clinic.js:327-331`, voice branch:
`Greet the caller with exactly: "<greeting>"`.

**Consequence:** on a live call the greeting is *generated by Gemini inside an ordinary
turn*. It cannot be spoken until the caller has spoken first and a full
STT → brain → Gemini → TTS cycle has completed, and it is then subject to every Q1 gate.

### Design note — what a per-tenant×language pre-synthesized greeting cache would require

Stated as requirements found in the code; **not built, and nothing was changed.**

1. **A transport.** `/call/start` returns four fields
   (`internalVoice.js:592-600`); the greeting text (or a cache handle) would have to join
   them. The worker already reads `started.get("greeting")`, so the worker side needs no
   change for the text case.
2. **A resolvable key at say() time.** The cache key is (tenant, language), but language
   at bridge time is `meta.get("language")` or `None` (`agent.py:311`, `:326`) — on an
   unknown-language call, which is the default wiring (`agent.py:78` defines
   `STT_AUTO_DETECT = "unknown"`, passed at `:366`), the language is not known until the first
   `user_input_transcribed` fires (`agent.py:391-394`). Either the greeting is keyed to
   the tenant's configured default language, or it cannot be pre-selected.
3. **An invalidation edge.** The greeting is owner-editable through the portal
   (`portal/routes.js:1611`), so cached *audio* must be keyed to something that moves on
   write — `tenant_configs` already carries a version — or purged on config save.
   Cached text needs none of this.
4. **A playout route that bypasses the tokenizer, if audio is cached.**
   `AgentSession.say` accepts pre-rendered frames:
   `say(text, *, audio: NotGivenOr[AsyncIterable[rtc.AudioFrame]] = NOT_GIVEN, …)`
   (`livekit/agents/voice/agent_session.py:1166-1173`). Passing `audio` is what makes a
   cache worth having; passing text alone re-enters the same Sarvam synthesis path and
   saves only the Gemini turn.
5. **A decision this document does not make:** whether the greeting should be spoken
   proactively at all. Today it is model-generated, which means it is also
   consent-ordered by the prompt (`clinic.js:336-339` appends the recording-consent line
   after it). A proactive greeting moves that ordering out of the prompt and into the
   worker.

**IMPLICATION FOR V1/V4:** The greeting is currently a prompt instruction rather than a
`/call/start` payload, so the caller's first audio costs a full turn — and the worker
already has both the read (`agent.py:413`) and a pre-rendered-audio playout parameter
(`agent_session.py:1170`), leaving the transport and the key as the only missing pieces.

---

## Q4 — Empty-KB embed

**VERIFIED. The embedding call is still made. There is no short-circuit.**

Exact call site — `src/modules/knowledge/knowledgeService.js:184-199`:

```js
async function getRelevantChunks(tenantId, query, topK = 3, { signal = null } = {}) {
  const queryEmbedding = await embed(query, signal, 'turn');   // :187  ← unconditional
  const { rows } = await db.query(                             // :190
    `SELECT id, content, 1 - (embedding <=> $2::vector) AS similarity
     FROM knowledge_chunks
     WHERE tenant_id = $1
     ORDER BY embedding <=> $2::vector
     LIMIT $3`, …);
  return rows;
}
```

Line `:187` runs **before any database access**. There is no count, no existence probe,
no cache, and no early return anywhere in the function — the embedding is dispatched, and
only then does the query discover the tenant owns zero rows.

`embed` (`knowledgeService.js:130-168`) always reaches the network: the only pre-dispatch
exit is an already-aborted caller signal (`:140-142`), and `embeddingModel.embedContent`
is called unconditionally at `:157`.

No caller gates it either:

| Caller | Line | Gate? |
|---|---|---|
| `contextAssembler.js` (both channels, all six entry points) | `:67` | none — inside the unconditional `Promise.all` |
| `testTurnService.js` (portal test turn) | `:108` | none |
| `validationService.js` (`checkKbRetrieval`) | `:220` | none |

`countChunksBySourcePrefix` (`knowledgeService.js:347-356`) is the only chunk-count query
in the module and it is used by provisioning reporting, not by retrieval.

Cost of the non-short-circuit, from this repo's own measurements (D-010/D-011 tables in
`docs/os/decisions.md`): **431–478 ms warm**, **613 ms – 2,555 ms cold**, bounded at
3,000 ms by the `turn` budget class (`knowledgeService.js:64-68`). A zero-KB tenant pays
that on **every** turn, then a vector scan returning nothing, then
`applyRelevanceFloor([])` (`:276-285`) returns empty and the prompt takes D-010's
zero-chunk branch.

Whether this matters at customer #1 depends on whether tenants are provisioned with a
knowledge base — the runbook's step 3 is `--kb-dir` (D-012) — so this is a cost paid by
the *un-ingested* tenant, and by any tenant during the window between provisioning and
ingestion.

**IMPLICATION FOR V1/V4:** A tenant with an empty knowledge base pays a full Gemini
embedding round-trip (431 ms warm, up to 3,000 ms at the bound) on every single turn for
a query that provably cannot match anything, and the gate would sit at
`knowledgeService.js:187`.

---

## Q5 — `persist_inbound` ordering

**VERIFIED. Nothing inside `fetch_parallel` reads the just-persisted row's *content* — but
one leg has a hard dependency on its *id*, so the two cannot simply be made concurrent.**

The inbound row is written at `src/routes/internalVoice.js:186-194` (JSON branch) and
`:400-426` (SSE branch), both `RETURNING id`; `assembleConversationContext` is called at
`:226-235` and `:434-446` respectively.

The three parallel legs are `src/modules/conversation/contextAssembler.js:66-82`:

| # | Leg | Line | Tables read | Reads the new row? |
|---|---|---|---|---|
| 1 | `knowledgeService.getRelevantChunks` | `:67` | `knowledge_chunks` only (`knowledgeService.js:190-197`) | **No** — never touches `messages` |
| 2 | `customerService.getRecentMessages` | `:77` | `messages` | **Only to exclude it, by id** |
| 3 | customer memory | `:78-81` | `customer_memory` | **No** |

Leg 2's query — `src/modules/customer/customerService.js:38-44`:

```sql
SELECT sender, content FROM messages
 WHERE tenant_id = $1 AND conversation_id = $2 AND id <> $3
 ORDER BY created_at DESC
 LIMIT $4
```

`$3` is `inbound.id`. The row's **content is never read**; the id is used solely to keep
the current turn's own transcript out of its own history — that is V-009, and it is
enforced rather than assumed: `getRecentMessages` **throws** when the id is absent
(`customerService.js:35-37`), and `assembleConversationContext` throws before it
(`contextAssembler.js:55-57`).

Leg 3's query — `contextAssembler.js:78-81`:

```sql
SELECT key, value, updated_at FROM customer_memory
 WHERE tenant_id = $1 AND customer_id = $2 ORDER BY key
```

**What this means for concurrency.** The dependency is on the id, not on the row, and the
id is server-generated (`gen_random_uuid()` column default), so it does not exist until
the INSERT returns. Running persist concurrently with fetch as the code stands would
either fail leg 2's precondition (no id to pass) or, if the predicate were dropped,
admit the turn's own transcript into its own history — the row is committed and visible
by the time leg 2 runs, and `id <> $3` is the only thing excluding it. Making them
concurrent therefore requires breaking the id dependency first (a client-generated UUID,
or a different exclusion predicate), not merely reordering the awaits.

One pre-existing race worth recording, separate from the question asked:
`EVENT.MESSAGE_RECEIVED` is emitted at `internalVoice.js:201-211`, **before** the fetch,
and its consumers include memory write-back — so leg 3 already races an asynchronous
writer today, independent of where `persist_inbound` sits.

**IMPLICATION FOR V1/V4:** `persist_inbound` can be overlapped with `fetch_parallel` only
if the inbound row's id is minted before the INSERT (or the V-009 exclusion is re-expressed
without it), because no leg reads the row itself but leg 2 cannot run without its id.

---

## Q6 — Worker-side timing

**VERIFIED, with a corrected premise.**

⚠️ **`voice-agent/latency.py` does not exist.** A repo-wide `find -name "latency*"`
returns nothing, and `grep -i latency` over `voice-agent/**` excluding `.venv` (`.py`,
`.toml`, `.md`) returns **zero hits**. The worker is four files —
`agent.py`, `brain_client.py`, `turn_context.py`, `conftest.py` — plus `tests/`. What
follows is what *is* captured.

### What the worker captures today

| Signal | Site | Spans | Path |
|---|---|---|---|
| `delegate_rtt_ms` | `agent.py:207-210`, `t0` at `:194` | entry of `llm_node` → `delegate_turn` returns | JSON only |
| `stream_turn_total_ms` | `agent.py:283-286`, `t0` at `:247` | entry of `_llm_node_streamed` → `done` event received | SSE only |
| call duration | `agent.py:112-113`, reported at `:344-347` | whole call | both |

`brain_client.py:176,190` uses `time.monotonic()` only to enforce the SSE deadline; the
value is never recorded. Nothing else in the worker measures anything.

### What the framework computes but nobody consumes

`livekit-agents` already computes exactly the numbers this question asks for —
`EOUMetrics.end_of_utterance_delay` and `.transcription_delay`
(`livekit/agents/metrics/base.py:94-102`), `TTSMetrics.ttfb` (`:59-64`),
`LLMMetrics.ttft` (`:26`) — and emits them on the session's `metrics_collected` event.
**`agent.py` never subscribes.** Its only session handler is
`@session.on("user_input_transcribed")` at `:391`. So those metrics are computed and
discarded.

### What the Node side captures

`src/infra/logging/turnMetrics.js:36-124` emits one `voice_turn_metrics` line per turn
with stages `hydrate_validate`, `persist_inbound`, `fetch_parallel` (+ the
`fetch_parallel_knowledge` / `_history` / `_memory` sub-timings recorded from
`internalVoice.js:234`/`:446`), `gemini_call_<n>`, `tool_exec_<n>_<name>`,
`persist_outbound`, and `total_node_ms`. All of it is bounded by request receipt and
response — it says nothing about audio at either end.

### Can it attribute STT-final → first-TTS-audio without new code?

**No.** Both ends of that interval are unmeasured:

- **Start.** Nothing timestamps the STT final transcript. The earliest worker timestamp
  is `t0` *inside* `llm_node` (`agent.py:194`/`:247`), which is already downstream of the
  ~70 ms endpointing delay (Q2), of the up-to-1.0 s EOS fallback (`stt.py:56`), and of
  speech scheduling. The gap between STT-final and `t0` is precisely the part not
  captured.
- **End.** Nothing timestamps first TTS audio anywhere. `stream_turn_total_ms` stops at
  the brain's `done` event, which is upstream of synthesis; everything in Q1 — the three
  tokenizer gates, the segment serialisation, the WebSocket round trip — sits between
  that stop and the first audio frame.

The interval is therefore not derivable from any two existing signals. It is, however,
one subscription away: the framework's `metrics_collected` stream already carries
`EOUMetrics` and `TTSMetrics.ttfb`, so the missing work is wiring, not measurement.

**IMPLICATION FOR V1/V4:** STT-final → first-TTS-audio cannot be attributed from anything
logged today, because the worker's two timers both bracket the brain HTTP call and never
touch audio — while the framework already computes both endpoints and the worker simply
does not subscribe to them.

---

## Summary of verification status

| Q | Status | The load-bearing fact |
|---|---|---|
| Q1 | VERIFIED | `tokenize.basic.SentenceTokenizer` is hardcoded at `sarvam/tts.py:549`; its punctuation class excludes the danda; a pure-danda Hindi reply produces **no** incremental segment |
| Q2 | VERIFIED | Streaming WS session, Sarvam server-side VAD segments; effective window = Sarvam hangover (no dial at HEAD) + ~70 ms; a default Silero VAD is wired despite the comments |
| Q3 | VERIFIED | `/call/start` returns four fields, none of them a greeting; `agent.py:415` is unreachable; the greeting ships as a prompt instruction |
| Q4 | VERIFIED | `knowledgeService.js:187` embeds unconditionally, before any DB access, with no caller gate |
| Q5 | VERIFIED | No leg reads the row; leg 2 (`customerService.js:38-44`) depends on its server-generated id |
| Q6 | VERIFIED (premise corrected) | No `latency.py` exists; two brain-RTT timers only; the framework's `metrics_collected` is never subscribed |

Nothing in this document was inferred from documentation where source was available. The
five measurements marked *measured this session* were produced by executing the installed
`voice-agent/.venv` libraries against literal strings.
