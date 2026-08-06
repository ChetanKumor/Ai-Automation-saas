# Issue 35 — Migrate the voice worker to Sarvam realtime STT and apply telephony tuning

You are executing one scoped issue in the Prantivo repository. Follow the session protocol in `CLAUDE.md`. One issue, one session. Do not begin any edit until Phase 0 completes and reports.

---

## Phase 0 — Mandatory research and STOP conditions

Complete all of the following and emit a Phase 0 report before touching a single file. Any STOP means: write the report, make no changes, and end the session.

### 0.1 Load project state

Read `docs/os/state.md`, `docs/os/clocks.md`, `docs/os/decisions.md`, `docs/os/assumptions.md`. Run `npm run os:check`.

- **STOP** if `os:check` fails. `Verified-at` naming an ancestor commit is expected and is not a failure — the operative test is the script's own verdict, not literal sha equality.
- **STOP** if `git status` is not clean.
- **STOP** if `docs/os/state.md` contradicts anything asserted in this prompt. Report the divergence and the exact amendment text.

### 0.2 Capture the baseline

Record and quote in the report:
- `git rev-parse HEAD`
- `npm test` → the `# tests` / `# suites` / `# fail` lines
- `pytest` in `voice-agent/`, run with `VOICE_STREAM_TURNS` explicitly pinned to `false` in the invocation environment (finding F-014 is open; ambient `.env` leakage causes 4 spurious failures)

- **STOP** if the Node suite is not `fail 0`.
- **STOP** if the worker suite is not `37 passed` with the env pinned.

### 0.3 Research current vendor documentation

Fetch and read, in this order:

1. `https://docs.sarvam.ai/api/integration/livekit-production-best-practices`
2. `https://docs.sarvam.ai/api/getting-started/models`
3. `https://docs.sarvam.ai/api/getting-started/changelog`
4. `https://docs.sarvam.ai/api/api-guides-tutorials/speech-to-text/realtime-api`
5. The LiveKit Agents documentation for the version pinned in `voice-agent/pyproject.toml`

This session was scoped against those pages as read on 2026-08-07. Sarvam held its Epoch conference on 2026-07-30 and its documentation is visibly trailing its announcements, so the following must be re-verified rather than assumed:

- **STOP** if `sarvam.STTStreaming` is no longer Sarvam's recommendation for new cascading voice agents, or if the class is renamed, or if its constructor parameters differ from: `language`, `stream_type`, `mode`, `endpointing`, `encoding`, `sample_rate`, `prompt`, `return_timestamps`, `api_key`, `vad_sot_threshold`, `vad_min_speech_ms`, `vad_min_silence_ms`.
- **STOP** if the realtime model identifier is no longer fixed at `saaras:v3-realtime`.
- **STOP** if the documented event ordering is no longer end-of-speech before final transcript. The current legacy class emits the reverse, and this inversion is the single behavioural change with the widest blast radius in this migration.
- **STOP** if `saaras:v4` or `bulbul:v4` now appear as documented, callable API model strings in the models index or the API reference. Do not adopt them in this session under any circumstance. Report their appearance, propose a separate issue, and end.
- **STOP** if the `vad=None` guidance has changed, or if omitting `vad` no longer causes the framework to install a hosted Silero VAD.

### 0.4 Verify against the installed package, not the documentation

Documentation and the pinned plugin can disagree. Inspect the installed plugin source in the worker virtualenv (`voice-agent/.venv/.../livekit/plugins/sarvam/`) and confirm:

- `STTStreaming` is exported by `livekit-plugins-sarvam==1.6.4` and its signature matches §0.3.
- `sarvam.TTS` accepts `min_buffer_size`, `max_chunk_length`, `output_audio_codec`, `speech_sample_rate`, `pace`, `temperature`, `dict_id`, `send_completion_event`, and exposes `prewarm()`.
- The `AgentServer` / `setup_fnc` / `JobProcess` lifecycle used by Sarvam's reference configuration is available in `livekit-agents==1.6.4`. The worker currently uses `cli.run_app(WorkerOptions(entrypoint_fnc=...))`.

- **STOP** if any of the above requires bumping `livekit-agents` or `livekit-plugins-sarvam` beyond their current pins. A dependency bump is a separate issue with its own regression surface; report the exact minimum version required and end.
- If `prewarm()` cannot be reached without restructuring the entrypoint, prefer the smallest restructure that preserves the existing shutdown-callback and drain semantics. If no such restructure exists, drop `prewarm()` from scope, proceed with everything else, and file the gap.

### 0.5 Confirm the dead-code candidate

Run a call-site grep for `src/modules/voice/providers/sarvam.js` and for `voiceProvider` across `src/`, `scripts/`, `server.js`, and `tests/`.

- If any production call site exists, **skip step 9 only** — do not stop the session — and report the call site.

### 0.6 Phase 0 report

Emit: HEAD sha, both baseline test counts verbatim, one line per STOP condition with its verdict, a diff-style note of anything in vendor documentation that changed since 2026-08-07, and the grep result for §0.5. Then proceed.

---

## Scope

**In scope — `voice-agent/` only, plus the documentation files named in step 8.**

Replace the legacy `sarvam.STT` construction with `sarvam.STTStreaming`, apply Sarvam's documented telephony tuning to the STT, TTS and session configuration, expose every tuned value as an environment variable, and cover the change with worker tests.

**Explicitly out of scope. Do not touch, do not "improve while you're there," do not fix in passing:**

- Any file under `src/`, except the single deletion in step 9.
- The Node brain contract: `/internal/voice/call/start`, `/internal/voice/turn`, `/internal/voice/call/end`, their HMAC scheme, or the correlation-id echo.
- `VOICE_STREAM_TURNS`. It stays `false`. Do not flip it, do not test with it true, do not touch the SSE branch.
- Saaras V4, Bulbul V4, Sarvam LLM, Sarvam-105B, Sarvam-30B, Sarvam Vision, Samvaad, dubbing, translation, diarization, or `return_timestamps` for compliance capture.
- Issues 11, 12, 13: DID→tenant resolution, SIP metadata extraction, the Plivo provider. This session must not make them easier or harder; it must not anticipate them.
- Open findings F-012, F-014, V-005, V-011, and the `id DESC` residual on V-009.
- Any new runtime dependency, in either language.
- Portal, admin panel, `web/`, or any Node test file except as forced by step 9.

**Two behavioural changes are specifically forbidden**, because both would move language policy into a worker whose stated invariant is that it owns transport only:

- Do not call `update_options(language=...)` to re-pin the recognizer mid-call. STT stays in auto-detect. File it as a follow-up.
- Do not change the STT `mode` default away from `transcribe`. Make it environment-configurable; leave the default alone. Switching to `codemix` changes the text the brain receives and is a brain-side decision.

---

## Implementation steps, in order

### 1. Environment surface first

Add environment variables for every value tuned below, each with a default that is stated in `voice-agent/.env.example` alongside a one-line comment naming what it controls and which direction to move it. No tuned value may be a bare literal in `agent.py`. Follow the existing naming convention in that file.

Include a rollback switch — `VOICE_STT_REALTIME` or equivalent — that selects between `STTStreaming` and the current legacy construction, mirroring how `VOICE_STREAM_TURNS` already works. Both branches must be reachable and both must be test-covered. Document in the file's comment that the legacy branch is scheduled for deletion once the Issue 14 live-call gate passes.

### 2. Fix the VAD defect

Pass `vad=None` explicitly to `AgentSession`. This is a defect fix, not tuning: omitting the parameter causes the framework to install a hosted Silero VAD that requires LiveKit Cloud credentials and adds a network hop, which directly contradicts `voice-agent/README.md`'s claim that the worker runs "no local VAD model." Verify at runtime that no *TurnDetector requires a VAD* warning appears at startup.

### 3. Swap the STT class

Construct `STTStreaming` in place of `STT`. `flush_signal` does not exist on the new class and must be removed, not carried forward. Set `stream_type` to the low-latency option, `encoding` to the only accepted value, `sample_rate` defaulting to 16000, `endpointing` to the VAD mode, and the three server-side VAD parameters to Sarvam's documented telephony starting points rather than leaving them at server defaults.

Wire the STT `prompt` parameter to an optional field read from the `/call/start` response, defaulting to empty when absent — the same seam `greeting` already uses. **Do not add the field on the Node side.** Do the same for the TTS `dict_id`. This wires the seam without a brain change; populating it is a later issue.

### 4. Handle the event-order inversion

The realtime class emits end-of-speech before the final transcript; the legacy class emits the reverse. Audit every consumer of transcript and speech events — at minimum the `user_input_transcribed` handler that records the detected language onto call state — and confirm each still behaves correctly under the new ordering. State in the commit body what you checked and what you concluded.

### 5. Tune TTS

Set `min_buffer_size` to the documented minimum, `output_audio_codec` to a raw passthrough format appropriate to the sample rate (the mp3 default costs a decode hop per chunk), `speech_sample_rate` to a telephony-appropriate value, `pace` below 1.0 per Sarvam's comprehension guidance, and `temperature` toward the low end. Leave `send_completion_event` enabled. Call `prewarm()` at worker setup if §0.4 confirmed it is reachable.

### 6. Tune session turn handling

Within the existing nested `turn_handling` dictionary: raise `endpointing.min_delay` from its current `0.07` into Sarvam's documented range, set `interruption.mode` explicitly, set `interruption.min_words` to Sarvam's noisy-line value, and lower `false_interruption_timeout`. Set `aec_warmup_duration` to the telephony value — its current default suppresses interruptions for the first three seconds of every agent turn, which on a phone line means the caller cannot interrupt the receptionist.

Tighten STT, TTS, and LLM connection timeouts from the framework defaults toward Sarvam's guidance; a ten-second stall outlives the caller.

**`preemptive_generation` requires an explicit decision, recorded in the commit body.** It is inert on the legacy class but engages on the realtime class — and because this worker delegates the LLM node over HTTP, engaging it means speculative calls into the Node brain and therefore speculative Gemini spend. Finding V-002 already demonstrated live quota starvation on this key. Default it to disabled unless you can justify otherwise in writing.

### 7. Instrument

Log the per-turn metrics the framework exposes — end-to-end latency, transcription delay, end-of-turn delay, LLM time-to-first-token, TTS time-to-first-byte — plus the Sarvam STT request id and the TTS connection-reuse flag. Emit a false-interruption event handler.

This is not optional polish: Issue 14's definition of done requires a per-stage latency table, and the worker-side stages are not visible to Node's `turn_traces`. Use the existing worker logger and correlation-id field; do not add a new logging dependency and do not write to the database from this worker.

### 8. Documentation

Update, in the same commit as the code:

- `voice-agent/README.md` — the STT/TTS description, the environment table, and the "no local VAD model" claim now that it is actually true.
- `voice-agent/.env.example` — every new variable, with defaults and tuning direction.
- `scripts/demo/capture_stt.py` — its module docstring asserts that it reproduces the live worker's STT path. After this change that claim is false. Narrow it accurately; do not change the script's behaviour.
- `docs/specs/zyon-first-launch-plan.md` — allocate this work the next free plan-of-record number (verify it; the sequence runs to 34) with a definition of done, and note that it is sequenced between Issues 12 and 13.
- `docs/architecture/ARCHITECTURE.md` — only if §3.1's description of the voice stack is now inaccurate.

### 9. Dead-code deletion — conditional, separate commit

Only if §0.5 confirmed zero call sites. Delete `src/modules/voice/providers/sarvam.js`. It targets `saaras:v2`, `bulbul:v2`, and a translate endpoint, none of which appear in Sarvam's current model index; `scripts/demo/capture_stt.py` documents its own header that the file is not on the voice path. Remove its registry entry in `src/modules/voice/voiceProvider.js` and the registry assertions in `tests/voice/voice.unit.test.js` that reference it.

This is the only permitted change under `src/`. It will move the Node test count — report the delta explicitly. If removing the registry entry cascades into any other module, revert the deletion entirely and file it instead.

---

## Backwards compatibility — must hold

- The Node brain requires no change. If you find yourself editing anything under `src/routes/` or `src/modules/ai/`, stop.
- The pinned relationship between Node's turn budget and the worker's per-turn timeout is documented on both sides and must not drift.
- The never-dead-air guarantee stands: a failed delegation still speaks the static per-language apology and still ends the call as failed.
- Language values reaching `delegate_turn` keep the same BCP-47 shape.
- The worker authors no language. The apology strings stay hardcoded; nothing new is generated worker-side.
- `VOICE_STREAM_TURNS=false` remains byte-identical in behaviour.
- Every tuned default must be reachable via environment override without a code change.

---

## Validation

1. `pytest` in `voice-agent/`, env pinned per §0.2. Quote before and after counts. New tests must cover: the realtime constructor's parameters, `vad=None` reaching the session, the rollback flag selecting each branch, and correct language capture under the inverted event ordering.
2. `npm test`. **The count must be unchanged from baseline unless step 9 ran.** Any other movement is scope leak — find it and revert it.
3. `npm run os:check`.
4. **Runtime evidence. Passing tests do not close this session.** Run the worker against a real Sarvam key in a local dev room and capture: no VAD warning at startup, the TTS connection-reuse flag reading true from the second turn onward, one real Sarvam STT request id in the logs, and one logged end-to-end latency figure. Paste the log lines into the commit body. If no Sarvam key is available, say so plainly, mark the session incomplete, and do not claim done.

Compare the observed latency against Sarvam's published SLOs for a cascading pipeline and record the comparison. Do not tune further to chase the number — dev-environment latency is not production latency, and this repository's measurement discipline forbids optimizing against it.

---

## Commits

Conventional commits, fast-forward onto `main`, no merge commit, no PR. At most three:

1. `feat(voice): migrate worker to Sarvam realtime STT and apply telephony tuning` — code, tests, and the documentation in step 8. Body must record: the `preemptive_generation` decision and its reasoning, the event-order audit result, every tuned parameter with its old and new value, and the runtime evidence lines.
2. `chore(voice): remove dead Node Sarvam VoiceProvider` — step 9 only, if it ran.
3. `docs(os): record Issue <N> at <sha of commit 1>` — update `docs/os/state.md` with what shipped, both test counts, the vendor-documentation verification date, and a refreshed `Verified-at`. Note explicitly that Bulbul V4 and Saaras V4 were evaluated and deliberately not adopted, with the reason, so a future session does not relitigate it.

Anything you discover that is worth doing and is not in scope becomes a filed issue in the plan of record, not a commit.

---

## Final report

End with: both test counts before and after, the three commit shas, the runtime evidence, a one-line-per-item confirmation that each out-of-scope boundary held, any vendor-documentation drift found in Phase 0, and any follow-up issues filed.