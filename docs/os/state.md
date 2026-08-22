# State

The company as of a commit. Amend whenever reality diverges. A stale line here is a defect, not a detail.

Verified-at: 2f39f2eae435aa4498d84543be18bc5187033395
Verified-on: 2026-08-22
Rule: when Verified-at != HEAD, every line below is unverified. Re-run `npm run os:check`.

⚠️ marks a line this session could **not** evidence from the repository. The reason is
stated inline. Absence of a marker means the line was checked against HEAD, not that it
is self-evident.

**Fully absorbed.** `docs/audit/2026-07-frontend.md` (`90d1da3`) is now reflected here in
full. The D-005 frontend modernisation program is **COMPLETE** — its ledger, including
what shipped, what stays open and why, and what was deliberately not scheduled, is under
*Frontend modernisation program (D-005)* below. Eight of the audit's nine findings closed;
**F-F003 is the only one open**, blocked on external clock C-1. **Issue 34 is now closed**
— F-F001 shipped the owner-facing warning at `6ceb8f0`, and option (a) removed the hazard
at `69ceb7f`. The precedence in `aiService.js` is deliberate and
remains untouched.

---

## Product

- **Prantivo** (formerly Zyon) — vernacular AI receptionist for Indian SMB dental clinics.
- Channels: **voice and WhatsApp**. Languages: Telugu, Hindi, English.
- Wedge: Hyderabad-area dental clinics.
- Product name in every surface and pitch: **AI Receptionist**. Retired framings: "AI Operating System for Businesses", "AI Employees".

Corroborated by `docs/decisions/2026-07-24-product-name-prantivo.md` and the `web/`
repositioning in `c8b1b9e`. Positioning itself is a founder judgement, not a repo fact.

## Customers

- Paying: **0** ⚠️ commercial state, not repo-derivable
- Pilots / live tenants: **0** ⚠️ commercial state, not repo-derivable
- Production deployments: **0** — verified: no prod evidence log exists anywhere in the
  repo; `docs/deploy/` contains only `prod-readiness.md` and `audit/`. First deploy is
  greenfield, DB initialised fresh from `schema.sql`.

## Gate status

| Gate | Status |
|---|---|
| G-CLOCK | ❌ false — no external clock filed (`docs/os/clocks.md`: C-1/C-2/C-3 all `Filed: —`, `Reference: —`) |
| G-PROOF | ❌ false — no production, no live call |
| G-PAY | ❌ false |
| G-TEN | ❌ false |

## Launch gates (from `docs/deploy/audit/2026-07-production-readiness.md` §2)

Verbatim gate text and identifiers from the audit. Two status columns on purpose: the
audit's own verdict, and the verdict at this commit. **The audit says 3/7. At HEAD it is
4/7.** Work ranked against the audit table alone has been ranked one gate out of date.

| # | Gate | Audit (2026-07-16) | **At HEAD** | Evidence for the HEAD verdict |
|---|---|---|---|---|
| 1 | Genesis bootstrap works | PASS | **PASS** | `src/db/migrate.js`; `db:genesis`/`db:migrate`/`db:status` in `package.json`. Unchanged since the audit's live throwaway-DB run. |
| 2 | Live WhatsApp round-trip on prod | PENDING | **PENDING** | No production deploy; no prod evidence log in the repo. Blocked on Issue 20. **Issue 20's scope is incomplete:** as scoped today it deploys the Express app and `public/**` and says nothing about `web/`, leaving the surface a prospect sees *first* un-deployed by any reviewable process. Issue 20 is not closeable until it carries a `web/` deploy line item — see F-F004 and the `web/` bullet under *Stack (frozen)*. **The `web/` half now has a reviewable process** (`d811910`): `docs/deploy/marketing-site.md`, and `web/` measured to need nothing outside itself. That is preparation, not a deploy — this gate still needs the founder to put it at an address, and the site goes up noindexed until the 24 legal placeholders are filled. |
| 3 | Issue 14 voice gate | PENDING-DID | **PENDING-DID** | **Issue 11 is now done** (`9be2382`) but is **unwired** — the resolver has no caller. Issues 12–13 still absent. External clock C-2 unfiled. |
| 4 | Tenant isolation audit clean | PASS | **PASS** | Unchanged. The two F-016 letter-violations (`appointmentService.js:171`; dead `identityService.getTimeline`) remain open with zero tenant-facing exposure. |
| 5 | Issue 18 closed | PASS | **PASS** | Plus `3584240`, which closed the audit's noted `SESSION_SECRET` → `ADMIN_PASSWORD` fallback residual. |
| 6 | Backups exist with a tested restore | **FAIL** | **PASS** (repo side) | Closed by `e071f69`: `scripts/db/backup.sh`, `scripts/db/restore.sh`, `docs/runbooks/backup-restore.md`, live restore drill. ⚠️ Residue: enabling backups on the *production* provider is unverifiable until Issue 20. |
| 7 | One call traceable end-to-end | PENDING (dev evidence in hand) | **PENDING** | Unchanged; blocked by gates 2–3. |

## Engineering

- Python worker suite: **97 passed / 0 failed** (`uv run pytest` in `voice-agent/`).
  Last moved by **Issue 41 — Hindi replies segment incrementally on the danda**
  (72 → 97: +15 in the new `tests/test_danda_tokenizer.py`, +10 in the new
  `tests/test_tts_node.py`; see the note below).
  Not counted by `npm run os:check`, which measures the Node suite only — a red
  Python suite does **not** turn os:check red, so it has to be run deliberately.
  **Machine-independent since `1bb1e6d`** (V1a-R1): `voice-agent/tests/conftest.py`
  pins every variable `agent.py` reads, and the verdict is now identical with and
  without the gitignored `voice-agent/.env`. Before that commit a developer's `.env`
  set the verdict — see the V1a note below for the mechanism and the red-check.
- Test suite: **1111 tests / 180 suites / 0 fail** (`npm test`, raw: `# tests 1111 /
  # pass 1111 / # fail 0 / # cancelled 0 / # skipped 0 / # todo 0`)
  Moved at **the truth audit** (the site stops asserting what is not true):
  **+2 tests, +0 suites**, both bare `test()` calls in a new
  `tests/design/indexingFlagParity.test.js`. It is the **sixth** Node test with
  purchase over `web/`, and the first that guards a rule written in TWO files:
  `indexingAllowed` in `web/lib/siteConfig.ts` and the line restating it in
  `web/next.config.js`, which cannot import it because the Next CLI loads
  CommonJS before TypeScript compiles. Nothing failed if they drifted, and a
  drift ships a site whose `X-Robots-Tag` header and whose `<meta name="robots">`
  disagree about whether it may be indexed. It extracts both EXPRESSIONS and
  evaluates them against a 16-value environment matrix rather than comparing
  source text, so a reword passes and a semantic change does not.
  **RED-CHECKED IN BOTH DIRECTIONS OF DRIFT** — see the session entry.
  Moved before that at **the two-arm embedding transport** (`npm test` makes zero live external
  calls): **+2 tests, +0 suites**, both in
  `tests/portal/portalFaqs.integration.test.js` — the two error paths the previous
  stubs could not reach (a transport failure, and a call that never answers being
  ended by the `interactive` deadline). **The default arm is the same 1107 assertions
  it was, served offline.** See the session entry below.
  Previously moved at **HERO-1 phase 5** (the hero conversation replaces the WhatsApp
  mockup): **+1 test, +0 suites** — `tests/design/heroDisclosure.test.js`, one
  bare `test()` call. It is the **fifth** Node test with purchase over `web/`
  and it exists for one reason: phase 5 deleted the component that rendered the
  site's only visible "this is an example" disclosure, and nothing else in the
  repo would notice if the replacement stopped rendering one. `next build` does
  not care, and the pixel gate on `/` is gone by design.
  **IT READS SOURCE, AND SAYS SO.** It cannot prove the sentence reaches the
  DOM — that was measured off a running page at 360/768/1440 in all six
  playback states, see the phase 5 entry. What it can do is fail the moment the
  sentence stops being in `Hero.tsx`, which is how it would actually be lost.
  **MUTATION-CHECKED, because two source pins in this repo have gone quietly
  vacuous before.** Replacing the caption with a plausible substitute that keeps
  every product claim and drops only the words "An example" turns it **red**;
  restoring turns it green. It also carries a non-vacuity rail that requires
  each of its needles to be ABSENT from a control string built out of the
  hero's other copy.
  Moved before that at **HERO-1 phase 4.1** (the stale-rAF defect): **+1 test, +0 suites** —
  `tests/design/conversationPlayback.test.js`, one bare `test()` call. It is the
  **fourth** Node test with purchase over `web/` and the **second** that executes
  TypeScript from it, and it is the first that runs a REACT HOOK: the child that
  strips types also resolves the specifier `"react"` to a 72-line runtime
  implementing the five hooks `usePlayback` uses to their documented contract, so
  the hook is imported byte-for-byte unmodified and its stale closure is the one
  that ships. React is not installed at the repo root and needs a DOM to run
  effects; the hook does not.
  **THE CLOCK IS DRIVEN, NOT WAITED ON.** `requestAnimationFrame` and the
  reduced-motion media query are fakes the test steps by hand, 1 ms at a time —
  no `setTimeout`, no sleep, no real-rAF race. Six scenarios totalling **96 s of
  simulated playback** finish in a couple of seconds of wall time, and the file
  was run **20 consecutive times, 20/20 green** — determinism by construction,
  with the repetition as corroboration rather than as the argument.
  **IT ASSERTS PHRASE BOUNDARIES, NEVER TOTALS.** te 13207.5 ms and en
  13203.33 ms are 4.17 ms apart by design, so `data-playback-total`, completion
  time and total duration all pass on the broken code. The boundaries are
  1300–2200 ms apart under a switch and are the only signal that discriminates;
  the test computes that margin and **fails if it ever drops below 50 ms**, so it
  cannot go quietly vacuous when Hindi lands at a third CPS.
  **THE RUNTIME IS NOT TAKEN ON FAITH.** Two scenarios play a language straight
  through with no switch, and every boundary they produce is required to fall on
  the real `buildTimeline`'s step starts — asserted before anything is asked
  about a switch. A CDP probe against a real browser then reproduced both the red
  and the green to within one frame; see the phase 4.1 entry below.
  Moved before that again at **HERO-1 phase 4** (the language selector): **+1 test, +0 suites** —
  `tests/design/conversationLanguages.test.js`, one bare `test()` call, which is
  why the suite count does not move (see the note below on that asymmetry). It is
  the **third** Node test with purchase over `web/`, and the first that executes
  TypeScript from `web/`: the root suite is CommonJS with no loader, so it shells
  out to `node --experimental-strip-types` and imports the real `cadence.ts`
  rather than regexing it as text. `index.ts` is NOT reachable that way — it
  imports its JSON without an import attribute, which Next's bundler resolves and
  plain Node does not — so `getConversation` is covered by `next build` instead,
  positive-controlled this session by forcing `getConversation("hi")` into the
  page and watching the build fail with `conversation: no strings for "hi"`.
  ✅ **THE PHASE-3 UNATTRIBUTED INTERMITTENT DID NOT RECUR.** Phase 3 recorded one
  unnamed failure at `acd3e73` (`# pass 1103 / # fail 1`). This session ran the
  baseline at `910f196` **three times** — twice directly and once through
  `os:check` — and got `1104 / 180 / 1104 / 0 / 0 / 0 / 0` every time, then
  `1105 / 180 / 1105 / 0 / 0 / 0 / 0` after the change. That is six consecutive
  clean runs across two sessions against the one dirty run. It does not NAME the
  phase-3 failure and so does not close it; it does establish that nothing at this
  commit reproduces it. Left open, not chased — founder's instruction.
  Re-measured at **HERO-1 phase 3** (playback): all seven counters identical
  again, `1104 / 180 / 1104 / 0 / 0 / 0 / 0`. **The delta is zero by intent** —
  phase 3 adds a state machine, a cadence model and a client boundary, and no
  test, for the same reason phase 2 did not: the Node suite does not build,
  render or import anything under `web/`. What gated phase 3 instead was a
  build-id-interlocked pixel diff, a direct line-box comparison, and four
  live-DOM sweeps driven through all four playback states over CDP.
  ⚠️ **THE FIRST BASELINE RUN OF THIS SESSION WAS RED, AND THE FAILURE WAS NOT
  IDENTIFIED.** One test failed at `acd3e73` before any file was touched
  (`# pass 1103 / # fail 1`); the immediately following run at the same commit
  was `1104 / 1104 / 0`, as were both runs after the change. The failing test's
  NAME was not captured — the second run was filtered to summary lines only —
  so it is recorded as an unattributed intermittent rather than assigned to the
  known `serverListen.integration.test.js` load-sensitivity it resembles. A
  fourth recorded intermittent cannot be claimed on evidence this thin, and
  neither can a clean bill; what is established is that the tree was green
  three times out of four at this commit, twice of them after the change.
  **Phase 4 added three more clean runs at `910f196` without reproducing it** — see
  the ✅ note above.
  Re-measured at **HERO-1 phase 2** (the Conversation component on `/specimen`):
  all seven counters identical to phase 1's, `1104 / 180 / 1104 / 0 / 0 / 0 / 0`,
  taken twice at this commit — once before the change at `a071aa8` and once after.
  **The delta is zero by intent**: phase 2 adds a renderer and no test. It also
  cannot be otherwise — see the paragraph below on why the Node suite has no
  purchase over rendering.
  Last moved at **HERO-1 phase 1** (the hero conversation data model), which is the
  first session since Phase 1b to move the number at all. The baseline immediately
  before it, at `c2d94df`, was measured twice — once directly and once through
  `os:check` — at `# tests 1103 / # suites 180 / # pass 1103 / # fail 0 /
  # cancelled 0 / # skipped 0 / # todo 0`.
  ⚠️ **`# suites` did NOT move, and that is the correct result, not a miscount.**
  `tests/design/conversationProvenance.test.js` is a single bare `test()` call —
  the shape `tokenDrift.test.js` uses, for the reason stated in its header: the
  suite total is a tracked number, and a per-assertion block would move it every
  time a turn or a language is added. **A bare `test()` registers a test but no
  suite**; run alone, `tokenDrift.test.js` reports `# tests 1 / # suites 0`. A
  +1/+1 delta here would have meant a `describe()` wrapper added for no reason
  other than to move a counter.
  ⚠️ **THE FIRST RUN OF THE BASELINE WAS RED AND WAS NOT A DEFECT.** Three tests
  in `tests/infra/serverListen.integration.test.js` (`:222`, `:230`, `:243`)
  failed under CPU contention from two force-killed background runs: the suite
  spawns a child server with a 30 s boot timeout, and under load the child never
  reaches `app.listen`, so its captured stdout is the dotenv line and nothing
  else. 6/6 green in isolation and in two subsequent full runs. This is a **third**
  recorded intermittent, alongside `traces.integration.test.js:247` and
  TEST-FLAKE-03 — and unlike those two it is load-induced, so it is provoked by
  running anything heavy beside the suite rather than by a date or an ordering.
  Re-measured at **Phase 2 S2** (the whole site on Warm Paper):
  `# tests 1103 / # suites 180 / # pass 1103 / # fail 0 / # cancelled 0 /
  # skipped 0 / # todo 0`, all seven counters identical to the runs at
  `c7bcecf` (S1) and `9a024cc` (Phase 1b). The number carried here before those
  refreshes was recorded against `05fdf41` while HEAD was `9b95225` and was
  therefore formally unverified; it has been re-measured at each refresh since
  rather than carried forward. None of Phase 1b, S1 or S2 added a `test()`
  block, so the delta is zero by intent in all three.
  ⚠️ **THE NODE SUITE IS NOT THE INSTRUMENT FOR S1 OR S2 AND CANNOT BE.** It does
  not build, render or import anything under `web/` — `web/` has its own Next
  toolchain and zero tests, which is the standing gap recorded under *Stack
  (frozen)*. An unmoved 1103 says the change broke nothing it can see; it says
  nothing whatever about whether the conversion landed. **As of HERO-1 phase 5
  there are FIVE** Node tests that reach into `web/`, not one:
  `tests/design/conversationProvenance.test.js` reads
  `web/components/sections/conversation/{meta,te}.json` and compares the two
  captured turns byte-for-byte against `public/demo/fixture.json`. It has real
  purchase over `web/` content but none over rendering. **As of HERO-1 phase 2
  that data IS imported** — `/specimen` renders it through `Conversation` — so
  the test now guards strings that appear on a built page rather than strings
  that appear nowhere; what it still cannot see is whether they are laid out,
  coloured or scaled correctly, which is what the phase 2 gates measured on the
  live DOM instead. The third, new at phase 4, is
  `tests/design/conversationLanguages.test.js`,
  which pins `en.json`'s bytes, its phrase partition and the cadence parity
  between the two languages. The fourth, new at phase 4.1, is
  `tests/design/conversationPlayback.test.js`, which runs `usePlayback` itself
  under a driven clock and pins what the playhead does when the language changes
  mid-sequence. The fifth, new at phase 5, is
  `tests/design/heroDisclosure.test.js`, which pins the hero's visible honesty
  disclosure and the fact that `HeroChat.tsx` has not come back. It reads
  `Hero.tsx` as source and is explicit in its own header about what that cannot
  see. Those two are the only ones that EXECUTE `web/` code — see the
  suite note above for how, and for what that still cannot reach. The other is
  `tests/design/tokenDrift.test.js`, which parses
  `web/app/globals.css` as one of its four surfaces — and at S2 it is genuinely
  load-bearing rather than incidentally so: repointing `--accent` to `#0f766e`
  makes actual equal canonical, which **fails** unless the `--accent` @ `web`
  divergence row is deleted in the same commit. It stays inert for everything
  else. What actually gated S1 was a build-id-interlocked pixel diff (`/` at 0
  differing pixels across 3 widths); S2 gives that up — it repaints every route
  — and replaces it with a live-DOM token witness and a live-DOM contrast sweep
  across six routes × three widths. See the Phase 2 S1 and S2 entries below.
  ⚠️ **GREEN NOW MEANS THREE COUNTERS, NOT ONE.** `npm run os:check` refuses on
  `# fail`, `# cancelled` **and** `# skipped`, and on any of them being unparseable.
  Quoting `# fail 0` alone no longer establishes that a run was clean — see the
  RAG Session 3 note below. Three consecutive full runs at this commit:
  1043/173/0/0/0, and three at `0249814` before the change at 1028/171/0/0/0.
  Neither recorded intermittent fired in any of the six
  (`portalFaqs.integration.test.js:465` did not resurface, and
  `portalKnowledgeSummary` produced no cancellations) — twelve consecutive clean
  runs for both across Sessions 3, 4A and 5.
  ⚠️ **`portalFaqs:465` IS TWO FAULTS, AND ONE OF THEM IS NOW ATTRIBUTED.** It was
  chased in a dedicated session (entry below) and splits into an **embedding-call
  STALL** that expires the 10,000 ms `interactive` deadline — reproduced naturally
  at **1 red / 50 runs of the file alone**, with the failing call captured — and
  the **phase-5 607 ms red**, which is **not** that and stays unattributed. The
  live-Gemini quota/tier hypothesis this register was carrying is **ruled OUT** for
  the 607 ms red, on an induced comparison, not merely left unconfirmed. The
  location moved with the instrumentation commit: the signature to watch is now
  `portalFaqs.integration.test.js:538`, failing at **`:548`** (the POST — where
  every prior sighting landed) or **`:560`** (the PATCH — where the reproduction
  landed).
  Last moved by **HERO-1 phase 5 — the hero conversation replaces the WhatsApp
  mockup** (+1 test, **+0 suites** — `tests/design/heroDisclosure.test.js`),
  before that by **HERO-1 phase 4.1 — the stale-rAF defect in `usePlayback`**
  (+1 test, **+0 suites** — `tests/design/conversationPlayback.test.js`), before
  that by **HERO-1 phase 4 — the language selector** (+1 test, **+0
  suites** — `tests/design/conversationLanguages.test.js`), before that by
  **HERO-1 phase 1 — the hero conversation data model** (+1 test,
  **+0 suites** — `tests/design/conversationProvenance.test.js`; see the note
  above on why the suite count is right to stay still), before that by
  **Issue 39 — a listen failure is loud, not a successful boot**
  (+6 tests, +1 suite — `tests/infra/serverListen.integration.test.js`; three
  consecutive full runs at 1103/180/0/0/0; see the note below), before that by
  **Issue 38 — the greeting is synthesised in the language the
  brain resolved** (+16 tests, +1 suite — `tests/config/configLang.unit.test.js`
  at 7 in a new `speakableLang` suite, and 9 in the existing
  `tests/voice/callStartGreeting.integration.test.js`; three consecutive full
  runs at 1097/179/0/0/0; see the note below), before that by
  **V1c — the greeting is spoken on join**
  (+38 tests, +5 suites — `tests/voice/callStartGreeting.integration.test.js`
  at 14, `tests/prompts/voiceGreetingSuppressed.unit.test.js` at 10 across two
  suites, `tests/config/configLang.unit.test.js` at 9 and
  `tests/voice/ackLanguage.unit.test.js` at 5; see the note below), before that by
  **RAG Session 5 — the relevance floor and the data fence**
  (+15 tests, +2 suites — `tests/knowledge/relevanceFloor.integration.test.js`
  at 6 and `tests/prompts/knowledgeFence.unit.test.js` at 9; see D-013 and the
  note below), before that by
  **RAG Session 4A — the provisioning CLI reports the tenant**
  (+9 tests, +3 suites — `tests/provisioning/provisionCli.integration.test.js`
  at 7 across two suites and `tests/provisioning/kbTenantBinding.integration.test.js`
  at 2; see D-012 and the note below), before that by
  **RAG Session 3 — per-caller embedding deadlines** (+19 tests,
  +4 suites — `tests/knowledge/embedBudgets.unit.test.js` at 5,
  `tests/knowledge/embedWarmup.unit.test.js` at 6,
  `tests/infra/osCheckGate.unit.test.js` at 6 and
  `tests/infra/fixtureTenantIds.unit.test.js` at 2; see D-011 and the note
  below), before that by **RAG Session 2 — bounding the embedding call** (+9 tests, +3 suites —
  `tests/knowledge/embedTimeout.unit.test.js` at 4,
  `tests/prompts/knowledgeAbsent.unit.test.js` at 4, and
  `tests/voice/voiceStreamRagSignal.integration.test.js` at 1; see D-010 and the
  note below), before that by **RAG Session 1 — R1 negative tests** (+2 tests, +1 suite —
  `tests/knowledge/retrievalIsolation.integration.test.js`, the T-1/T-2 pair
  `docs/os/audits/rag/05-isolation.md` §F.4 specified; see D-009 and the
  note below), before that by
  **Issue 11** (+11 tests, +1 suite —
  `tests/voice/didResolution.integration.test.js`), before that by
  **F1** (+5 tests, +1 suite), **F2** (+4 tests, +1 suite), **F3**
  (+9 tests, +1 suite — `tests/portal/portalWizardExit.unit.test.js`), **B1**
  (+14 tests, +1 suite — `tests/notification/ownerBookingAlert.integration.test.js`,
  plus one test each in `tests/lifecycle/lifecycle.integration.test.js` and
  `tests/prompts/renderer.unit.test.js`), then **B2** (+23 tests, +1 suite —
  `tests/appointment/reschedule.integration.test.js` at 15, plus 6 in
  `ownerBookingAlert.integration.test.js` and 2 in
  `tests/voice/voiceCancellation.integration.test.js`), then **F1-R1** (+4 tests,
  **no new suite** — all four in `tests/portal/portalLifecycle.integration.test.js`,
  beside the two F1 already put there), then **B2-R1** (+32 tests, +2 suites —
  `tests/appointment/cancel.integration.test.js` at 17 and
  `tests/appointment/cancelTool.unit.test.js` at 7, plus 5 in
  `ownerBookingAlert.integration.test.js`, 2 in
  `tests/voice/voiceCancellation.integration.test.js` and 1 in
  `tests/portal/portalTestTurn.integration.test.js`), then **F3-R1** (+18 tests,
  +1 suite — `tests/admin/resetOwnerPassword.test.js`), all below. Every other
  line in this section that quotes 869/151, 874/152, 878/153, 887/154, 901/155,
  924/156, 928/156, 960/158, 978/159, 989/160 or 1028/171 is describing the commit
  it names and is left as written.
  **WHAT REACHES THE MODEL — what RAG Session 5's +15 buys, and what it does NOT.**
  Two findings that fired on every patient turn are now acted on. Q4-1: R1 took
  top-K with no threshold, so at 150–250 chunks per tenant and topK=3 all three
  rows always reached the prompt under *"use ONLY this to answer questions — do
  not invent information"* — an unrelated chunk presented to a patient as the
  clinic's own answer. A relevance floor of **0.25** cosine now stands between R1
  and prompt assembly (`RAG_MIN_SIMILARITY`, applied in `contextAssembler.js` and
  `testTurnService.js`, **not** inside `getRelevantChunks` — see D-013 for why).
  Q4-2: chunk content was interpolated bare, directly above the `Rules:` block that
  carries the no-medical-advice rule; it is now enclosed in a data fence whose
  marker is checked against the content and escalated on collision, at a measured
  cost of **+110 prompt tokens** on a populated turn and **+0** on a zero-chunk one.
  ⚠️ **Q4-1 IS SIZED AND INSTRUMENTED, NOT CLOSED.** The floor was derived from two
  measured bands (D-013) and is deliberately far below what would separate them:
  **at 0.25 it would not have removed a single one of the 41 real pairs measured**,
  including the root-canal query whose top three scored 0.6252 / 0.5802 / 0.4962.
  The separating value is near 0.67 and is not defensible from five positive
  examples — over-filtering silently deletes correct answers and is invisible
  without an evaluation set, which this repository does not have. The floor ships
  conservative, and the scores it discards are now recorded to
  `turn_traces.retrieval` as `below_floor` so the distribution needed to tune it
  accumulates. **The correct next instrument is an evaluation set, not a higher
  number.**
  ⚠️ **THE NUMBER THE SESSION WAS POINTED AT WAS MEASURING SOMETHING ELSE.**
  `05-isolation.md` §H.2's `~0.095` for "unrelated content" is the noise band of
  **random unit-Gaussian vectors** (§H.1 states the seed vectors were random), not
  of embedded text: `1/sqrt(768) = 0.0361` is the standard deviation of cosine
  between independent unit vectors, so 0.0955 is ~2.6 sigma over 1,200 draws. Real
  unrelated dental-clinic text under `gemini-embedding-001@768` measures
  **0.4204–0.6252**, and correct answers **0.7186–0.8603**. A floor derived from
  0.095 would have been inert. §H.2 is not wrong — it is being read as a claim it
  never made. Anything reusing it as a relevance number should read D-013 first.
  **RAG ISOLATION DEFENCE — what the +2 actually buys.** Before `ce7a213`, deleting
  `WHERE tenant_id = $1` from `knowledgeService.getRelevantChunks`
  (`knowledgeService.js:40`) left the suite at 989 pass / 0 fail, **byte-identical to
  baseline** — measured, not argued (`docs/os/audits/rag/05-isolation.md` §F.3,
  red-checked by execution at §F.5). R1 is the only vector query in the repository and
  the only read whose rows reach a patient-facing prompt; it does not select
  `tenant_id`, so nothing downstream can revalidate ownership (§B.R1). It is defended
  now: under the same mutation shim T-1 and T-2 fail and **only** those two of 991;
  with the predicate restored, 991/161/0. The invariant is named **INV-R1** in D-009.
  The tests never stub `getRelevantChunks` — 29 of its 30 other test references do,
  which is exactly why the predicate was undefended (§F.2) — and stub the embedding at
  the SDK boundary instead, so they cost no Gemini quota.
  **THE EMBEDDING CALL IS NOW BOUNDED — what RAG Session 2's +9 buys.** Before this
  commit there was **no bound of any kind** on the one outbound HTTP call in the
  retrieval path: five of `embed`'s six entry points passed no signal, the sixth
  (voice) passed one on the JSON branch only, and the SDK issues a bare `fetch` with
  no deadline unless `signal` or `timeout` is set — verified in
  `node_modules/@google/generative-ai/dist/index.js:443` this session, not assumed
  (`02-ingestion.md` §D.3). `embed` now carries a **3,000 ms** deadline
  (`EMBED_TIMEOUT_MS`) **inside the function body**, so all six entry points inherit it
  regardless of whether they call the local binding or `module.exports.embed`; it
  composes with a caller `signal` rather than replacing it. The SSE voice branch now
  passes its turn signal to retrieval, closing **D-09** — the branch production
  actually runs (`ARCHITECTURE.md:90` sets `VOICE_STREAM_TURNS=true` at deploy).
  ⚠️ **THE TIMEOUT ALONE WOULD HAVE MADE THINGS WORSE, AND THAT IS WHY Q4-3 SHIPPED
  WITH IT.** `contextAssembler.js:67-70` catches every RAG failure and returns `[]`,
  and zero chunks used to drop the whole knowledge section — including the only
  occurrence of *"do not invent information"* anywhere in `src/`. A deadline converts a
  hang into a fast RAG failure, so it *raises* the rate at which that path fires:
  shipping it alone would have traded a hung turn for a confidently invented one. The
  zero-chunk branch now keeps the anti-invention instruction. See **D-010** for the
  derivation of 3,000 ms and the coupling.
  **ONE DEADLINE CANNOT SERVE THREE CALLERS — what RAG Session 3's +19 buys, and
  why D-010 needed amending one commit after it landed.** D-010 bounded every
  embedding call at a single **3,000 ms** derived from the voice turn, and recorded
  its own falsifier: *"five samples on one machine against one region is not a
  distribution, so the cold-start floor in particular rests on a single
  observation."* **That falsifier fired** — in the suite rather than in production.
  `tests/portal/portalFaqs.integration.test.js:465` POSTs a FAQ;
  `createChunk` makes the first **cold** embedding call of that test process; under
  `node --test`'s 20-way file parallelism it exceeded 3,000 ms, `EMBED_TIMEOUT`
  propagated and the route **500'd**. An owner clicking Save had been held to a
  voice turn's deadline, and **that request has no turn budget at all** — nothing
  else on it can end it (`server.timeout` defaults to 0; `public/portal/faqs.js`
  sets no fetch timeout — `02-ingestion.md` §D.3).
  `embed` now takes a budget **class**, not a number, so the derivation lives in
  one table rather than at four call sites: **turn 3,000 ms** (unchanged —
  D-010's derivation, scoped to the path it was derived for), **interactive
  10,000 ms** (`createChunk`/`updateChunk`), **batch 30,000 ms** (`storeChunks`).
  The default, and the fallback for an unknown class name, is the **tightest**
  class. Both directions were proven against `portalFaqs:465` **unedited**:
  `EMBED_TIMEOUT_MS=50` used to fail it at `:474` (`500 !== 200`) and now fails it
  at `:477` instead (`EmbedTimeoutError … 'turn'` — the retrieval call, which is
  still turn-bound), while `EMBED_TIMEOUT_INTERACTIVE_MS=50` reproduces the
  original failure byte-identically.
  ⚠️ **The `:148-151` binding split is UNCHANGED** and so is `INV-R1`. The bound
  still lives inside `embed`'s body; only the *class* is chosen at the call site.
  **THE COLD CALL'S SPREAD IS THE FINDING, and it is why no bound derived from the
  last sample is safe.** Measured through the SDK boundary during a full suite run
  this session: cold **613 / 653 / 756 ms** under the same 20-way parallelism that
  produced the red, warm **431–478 ms** across 9 calls (median 459). D-010 measured
  **2,555 ms** cold uncontended. The first Session 3 attempt measured 1,281 and
  1,371 ms cold, and **above 3,000 ms** under parallelism. That is a spread of at
  least **4.9×** on one machine, one network, one region — so the interactive
  floor is measured from 3,000 ms, *the only value ever observed to fire*, not from
  the last healthy sample. Full derivation in **D-011** and at the table in
  `knowledgeService.js`.
  **The embedding path is warmed at boot** (`server.js`, after `app.listen`, never
  awaited, never under `node --test`, `EMBED_WARMUP=false` to disable). It is an
  **optimisation and not the fix** — a cold portal save succeeds now because the
  interactive bound accommodates it. What warming buys is the ~2,555 ms cold
  connection cost off the first request after a deploy, which on the genesis deploy
  is the demo. It is batch-classed so a slow cold start is *measured* rather than
  truncated at 3,000 ms, and it **logs its latency**, so every deploy contributes
  one sample to the residual D-010 left open. Real boot, measured: **729 ms** warm
  call, **458 ms** for the next embed in the same process.
  ⚠️ **`os:check` USED TO BE GREEN ON A RUN IT COULD NOT SEE.** It read `# fail`
  and nothing else, and `# fail` counts **one** of the three ways a test can end
  without passing. Session 2 hit `# cancelled 4, # fail 0` for real. Both
  `# cancelled` and `# skipped` are now gate conditions, both **named** rather than
  counted, and an *unparseable* counter is a refusal rather than a zero. Two
  asymmetries are pinned by test because neither is guessable: a throwing `before`
  hook yields `# fail 0` with every sibling `cancelledByParent`, and a skipped
  `describe` — the shape every DB-dependent suite here uses — **never increments
  `# skipped`** at all; its children vanish from `# tests`, which only the
  recorded-total comparison catches. Zero SKIP/TODO directives exist at HEAD, so
  making `# skipped` fatal costs nothing today. Validated against real captured
  output, not hand-written TAP: a clean 1000/164 run passes; a real red run is
  named; a real `# fail 0, # cancelled 2` run is refused with both names and
  `cancelledByParent`; a real skipped run names the skipped test *and* the skipped
  suite and says which of the two the counter missed.
  **U-4 / U2-1 / U5-4 are CLOSED.** The 600–900 ms embedding latency had been quoted in
  three audit artifacts across three phases and never once reproduced — it was UI copy
  at `public/portal/faqs.js:13`. Measured this session, 5 calls through `embed()`
  itself: **2,555 ms cold**, then 546 / 625 / 543 / 459 ms warm. The claim is roughly
  right for a warm process and silent about the cold one, which is 2.8× its ceiling and
  is the number a timeout has to clear. ⚠️ Residual: five samples on one machine
  against one region is **not a distribution**, and the cold-start floor rests on a
  single observation.
  ⚠️ **TWO VOICE SUITES SHARED A FIXTURE TENANT UUID, AND IT COST A FULL SUITE RUN.**
  `tests/voice/voiceStreamRagSignal.integration.test.js` was first written with
  `TENANT_ID = …aaaa00000029`, already owned by
  `tests/voice/voiceCancellation.integration.test.js`. Both `cleanup()` that id under
  `node --test`'s parallel file scheduling, so the new file deleted the other's tenant
  mid-run: **4 failures in `voiceCancellation`, 0 when that file ran alone**, and the
  loudest symptom (`customers_tenant_id_fkey` violation) named the victim, not the
  cause. Same class as the `zyon_test_%` scratch-DB race below, one layer up: the
  scratch-DB sweeps are disjoint by prefix now, but **fixture tenant UUIDs have no such
  discipline and no check**. A new voice suite must grep
  `00000000-0000-0000-0000-` across `tests/` and take an unused id.
  **THERE IS A CHECK NOW** (RAG Session 3): `tests/infra/fixtureTenantIds.unit.test.js`
  fails if two suites declare the same fixture tenant uuid, and **names both files
  and both line numbers** — the thing the original incident could not do, since the
  `customers_tenant_id_fkey` violation named the victim. Red-checked by
  construction: a scratch file re-declaring `…aaaa00000029` turns it red naming
  itself and `voiceCancellation.integration.test.js:25`. The five pre-existing
  cross-file uuid overlaps are benign and stay in scope only by a stated
  **property** — a file that replaces `src/db/db` in `require.cache` never reaches
  Postgres, so its "tenant" cannot collide with a row — rather than by a filename
  allowlist, so a suite that stops stubbing comes back under the guard on its own.
  A second test fails on any in-scope declaration the scan cannot resolve
  statically, so the scan's blind spot is loud rather than silent.
  ⚠️ **§F.4's OTHER THREE TESTS ARE NOT IMPLEMENTED.** T-4 (the three out-of-module
  readers, **P5-9**), T-5 (`getTrace` reachability, **P5-2**) and T-6
  (foreign-vs-fabricated FAQ id equality) defend different hops and remain open.
  **T-3 is now implemented** — see the next entry.
  **THE PROVISIONING CLI NOW REPORTS THE TENANT, NOT THE ARGUMENT — what RAG
  Session 4A's +9 buys, and what it deliberately did not buy** (**D-012**).
  P5-1 was the audit's second structural finding: on the `--kb-dir` path the tenant
  boundary is an operator typing a filename (§A.6). It was **measured, not argued**,
  against a seeded scratch database at `6c36259` — one missing hyphen in the slug
  (`smile-dental` → `smiledental`) with the same `--kb-dir` created a **second
  tenant**, ingested the clinic's whole knowledge base into it, and printed
  `✓ provisioned` plus *"Knowledge base ingested"* at **exit 0**. The operator's only
  signal was the filenames they had just typed.
  The CLI now resolves the target through `provisioningService.describeTarget` — the
  same `definitionSchema` the write uses, so the displayed slug is provably the
  written slug — and prints `business_name`, slug, tenant id, status/active, config
  version and chunk counts **by source prefix** from the ROWS, before the first write,
  then asks for confirmation (`--yes` skips it; **a missing terminal is a refusal, not
  a default-yes**). `--dry-run` performs the same resolution and display and then
  exits, where before it returned at `provisioningService.js:189-207`, **ahead of the
  slug lookup at `:210`**, and could only echo the operator's own input. After the run
  the tenant is read again and rows **actually present** are reported per source file
  beside the label the run assigned, with disagreements marked `⚠ DISCREPANCY`.
  ⚠️ **ONE behaviour is refused, and the scope is the decision**: `--kb-dir` against a
  slug that names no tenant. Not every unresolved slug — that would disable tenant
  creation, which is the CLI's purpose. `--kb-dir` is **step 3** of the runbook this
  CLI itself prints, so on the documented path the tenant already exists and a slug
  that misses there is a typo. It is **the one guard `--yes` cannot skip**, which is
  exactly where a confirmation prompt is worth nothing.
  ⚠️ **WRITE SEMANTICS ARE UNCHANGED AND THAT IS EVIDENCED, NOT ASSERTED.**
  `ingestKnowledge` (1,240 B), `provisionTenant` (4,659 B) and `writeConfigV1` (414 B)
  are **byte-identical** to `6c36259` — extracted from both revisions and compared —
  and the `provisioningService.js` diff is two hunks, both pure insertions
  (`@@ -156,0 +157,108 @@`, `@@ -299,0 +408,5 @@`), with **zero removed lines**. The
  `source` dedup, the skip semantics and the write order are what they were.
  ⚠️ **THE READ-BACK REVEALS SOMETHING IT CANNOT ANSWER, AND THAT IS THE HANDOFF.**
  `hours.md attempted skipped observed 4 row(s)` prints identically whether the
  document is complete or was truncated by a failure at chunk 5 of 26: **the schema
  records no expected chunk count and no completion flag** (`schema.sql:289-301`), so
  "fully ingested" and "partially ingested and skipped" are the same observation.
  That is D2-01 / Q2-4, now **visible** rather than invisible, which is as far as a
  reporting change reaches. Per-chunk dedup, resume-after-partial-failure, that
  distinction as a POLICY, the opposite retry semantics of
  `scripts/ingest-knowledge.js` (no dedup — a re-run duplicates rows 1..N−1), and a
  transaction around `storeChunks` are all deliberately **not** built.
  **T-3 (§F.4) is what pins the tenant half of the ingest dedup key.**
  `tests/provisioning/kbTenantBinding.integration.test.js` ingests one `--kb-dir` into
  tenant A and then tenant B and asserts both hold full copies with A's rows
  untouched. The write path is **not** stubbed — `ingestKnowledge → chunkText →
  storeChunks →` the real INSERT all execute; only the SDK transport is replaced, per
  Session 1's idiom, so no Gemini quota is spent. Red-checked by execution: dropping
  `tenant_id = $1` from `provisioningService.js:137` turns exactly that test red
  naming the key, and the sibling re-run test stays green. The CLI suite is
  red-checked the same way — removing the pre-write display reds tests 1 and 3,
  removing the read-back reds 3 and 5, removing the refusal reds 6, and neutering the
  confirmation reds 4, each **and nothing else**.
  ⚠️ **THE SUITE HAD A DATABASE-DESTROYING RACE BETWEEN TEST FILES, AND F3-R1
  FOUND IT BY PERTURBING THE SCHEDULE.** `tests/admin/tenantDetail.test.js` and
  `tests/config/configService.integration.test.js` both **created**
  `zyon_test_<hex>` and both **swept `zyon_test_%`** — which is a literal PREFIX
  of six other suites' scratch databases (`zyon_test_conv_`, `_cp_`, `_mig_`,
  `_prov_`, `_tr_`, `_val_`) and of each other. The sweep does
  `pg_terminate_backend` + `DROP DATABASE`, so under `node --test`'s parallel
  file scheduling either suite could destroy another's database **mid-genesis**.
  Adding one file to `tests/admin/` shifted the schedule and made
  `tests/admin/conversations.test.js` land inside that window: 2 collisions in 2
  runs with the new file, 0 in 2 runs at HEAD, with two different symptoms from
  the one cause — `57P01 terminating connection due to administrator command`
  raised inside `runner.genesis` (`migrate.js:122`), and `3D000 database ... does
  not exist`. The failure names a file that is not at fault and does not name the
  file that is.
  ⚠️ **Escaping the underscores would NOT have fixed it** — `zyon\_test\_%` still
  matches `zyon_test_conv_abc`, because `%` matches everything after the literal
  prefix. The prefix itself had to become disjoint: `zyon_tdet_` and
  `zyon_cfgs_`. **28 of the suite's 30 sweeps were already escaped and disjoint**;
  these two were the only exceptions, and `createOwner.test.js`'s header had been
  routing around them by name since PORTAL-P1-S3 rather than fixing them. No
  assertion changed and no test changed status; three consecutive full runs at
  978/159/0 after the fix.
  ⚠️ **B2 added no test to `tests/appointment/slotGrid.unit.test.js` or
  `bookingRules.unit.test.js` and edited neither.** That is the deliberate proof
  that extracting `validateSlot` out of `bookAppointment` was behaviour-preserving:
  had any assertion needed to move, the extraction would have changed behaviour.
  **TEST-FLAKE-03 is CLOSED** (`3765cdb`). It was a calendar-dependent failure in
  `tests/voice/voiceCancellation.integration.test.js:270`, red on every day when today+2
  landed on a Sunday and green the other six: the fixture seeded Dr. Rao for all seven days
  but seeded no `tenant_configs` row, so CLINIC hours — which are what `book_appointment`
  gates on — fell back to `clinicDefaults`, which closes Sunday. The fixture now seeds its
  own seven-day hours. `clinicDefaults` is unchanged; closing Sunday by default is correct
  product behaviour and the test was wrong to depend on it not being. No test was added:
  869/151 is unmoved across D3 and this fix.
  ⚠️ **A NEW intermittent, unexplained, filed not chased:
  `tests/portal/portalLifecycle.integration.test.js:794`** (F1-R1's own test, one
  commit old). 1 red in 2 full runs at a clean tree; 25/25 in isolation; three
  later full runs green. **The obvious hypothesis was measured and REJECTED** —
  millisecond truncation of `NOW()` in node-pg cannot be it: on the local
  Postgres the suite actually uses, `clock_timestamp()` granularity is **1µs**
  (200 000 distinct values from 200 000 calls) and an INSERT→UPDATE pair is never
  closer than **2ms** (0 collisions in 60). Full measurement in
  `docs/audit/2026-08-b2r1-filed.md` so nobody repeats it. Sibling of the
  recorded `tests/traces/traces.integration.test.js:247` intermittent; neither
  has an established frequency.
  **A third intermittent — `tests/portal/auth.unit.test.js:43` ('a tampered
  stored string fails closed') — was DIAGNOSED here and is now FIXED AND CLOSED
  by Issue 40 (`0eb67d2`); see the Issue 40 entry below for the fix, the
  determinism sweep and the four mutations. It was a bug in the test, never in
  `src/portal/auth.js`.** Caught red at `1bb1e6d` and green on
  the immediately following run. `auth.unit.test.js:49-50` read:

      const last = flip[5];
      flip[5] = (last[last.length - 1] === 'A' ? 'B' : 'A') + last.slice(1);

  It inspected the **last** character of the hash segment and rewrote the
  **first** one. When that first character already was `A`, the expression
  reproduced the segment byte-for-byte, nothing was tampered with, and
  `verifyPassword` correctly returned `true` against the assertion's `false`. The
  segment is base64 and always ends `=`, so the `'A' ? 'B' : 'A'` guard never
  selected `B`: the trigger was exactly *first char is `A`*, uniform at **1 in 64
  runs (~1.6%)**. Proven by construction, not inferred — hashing until a segment
  began with `A` (370 draws) and then running lines 48-51 verbatim gave
  `flip[5] === last  →  true` and `verifyPassword(...) → true`
  (`scratchpad/logs/flake-diagnosis.log`). **The test had therefore never once
  exercised the tampered-hash case it is named for on ~1.6% of runs, and on the
  other 98.4% it tampered with the first character while its comment claimed the
  last** — the assertion was real but weaker than it read. The remaining seven
  assertions in that test were unaffected.
  ⚠️ **THE ONE-LINE FIX PROPOSED HERE WAS WRONG, AND ISSUE 40 MEASURED IT RATHER
  THAN APPLYING IT.** This entry recommended
  `last.slice(0, -1) + (last[last.length - 1] === 'A' ? 'B' : 'A')` — flip the
  literal last character, matching the comment's wording. That character is
  base64 **padding**: the segment is 88 chars ending `==`, and node's decoder
  ignores what follows the `=`, so `…hA==` → `…hA=A` is a different STRING that
  decodes to the **same 64 bytes**. `verifyPassword` returns `true` on it, so
  that fix would have turned a 1-in-64 red into a red on **every** run — and it
  would have passed an anti-vacuity check written against the string. Measured,
  not reasoned: `01-reproduce.log` §E, and reproduced inside the suite as
  mutation M4.
  ⚠️ **The shared test database was one migration behind for a THIRD time.**
  `saas_crm_test` was missing `026` (`tenant_entities.updated_at` absent,
  `42703`). Nothing failed, because every suite reading that column mints a
  genesis scratch DB — but `025` sprang the same trap at B2 and `026` at F1-R1.
  Cleared before B2-R1's baseline. The durable fix is for the test bootstrap to
  refuse to run when `TEST_DATABASE_URL` has pending migrations; not built.
- **THE SITE ANSWERS `prefers-contrast: more` — HERO-1 phase 6, built** (`2f39f2e`).
  **One file: `web/app/globals.css`, +67 lines, 0 deletions.** No component, no
  module CSS, no markup, no copy, no dependency. Node **1111 / 180 suites / 0
  fail / 0 cancelled / 0 skipped / 0 todo** — unmoved; no test was added, because
  every claim here is a measurement on a built page under a forced media feature
  and none of it is assertable from Node. `npm run build` (in `web/`) exit 0, `/`
  at **115 kB** first load, unmoved. `git diff web/package.json` empty. No legal
  page opened. No `clocks.md`. ⚠️ The Python worker suite was **not re-run**; its
  **97** is carried forward.
  **FIVE TOKENS DARKEN AND NOTHING ELSE MOVES.** `--rule` 0.08→0.24 alpha,
  `--rule-strong` 0.17→0.51, `--ink-soft` `#57524A`→`#4B4640`, `--answered`
  `#166534`→`#14523A`, `--ink-faint` `#A8A199`→`#857F79`. Fifteen geometry cells —
  the control's top at 360/390/412/768/1440 in idle and complete, plus the five
  fold rows — are **bit-identical between `more` and normal**, so the accommodation
  is a colour change and provably nothing else.
  **THE FIFTH TOKEN IS NOT IN THE PLAN, AND OMITTING IT WOULD HAVE INVERTED A PAIR.**
  `--rule` at 0.24 is darker than `--rule-strong` at 0.17, so the four planned
  tokens alone would have made every `--border-strong` consumer draw its *strong*
  border **lighter** than the ordinary hairline it exists to outweigh. The alpha
  ratio is preserved rather than invented: 0.17 / 0.08 = 2.125, and 0.24 × 2.125 =
  0.51 — which also clears 1.4.11's 3:1 (3.51:1). Principle applied throughout:
  **fix what this change breaks; report what it merely fails to fix.**
  **THE PLACEMENT WAS MEASURED AGAINST THE TEST'S OWN PARSER BEFORE A DECLARATION
  WAS WRITTEN.** `tests/design/tokenDrift.test.js` matches `/:root\s*{([\s\S]*?)\n}/`
  — non-global, so the **first** `:root {` — and stops at the first `}` in column
  zero. Both orders were executed by pulling `SURFACES` and the parsing region
  verbatim into a `vm` context: the block **appended after** the base `:root` is
  never entered (55 declarations before and after, all five tokens at their
  canonical values, whole test PASS); **prepended above** it, the token map
  truncates 55→4 and the test **reds on its `>= 15` floor**. Even if it were parsed,
  `declarations()` is an object keyed by token, so a re-declaration overwrites
  rather than adding a surface, and none of the five is declared by any non-`web`
  surface — so none can become "shared" and **no `brand-values.md` row is required
  or made stale**. `git diff docs/design/brand-values.md` is empty.
  **CONTRAST, AND THE POSITIVE CONTROL.** Fourteen measurements under
  `prefers-contrast: more` — six states at 360, idle+complete at 390/768/1024/1440:
  **0 hero failures**, worst hero **8.08:1** and worst region **8.08:1** against a
  7:1 floor, `--ink-faint` on **0** glyphs and **0** non-text marks (3.42–3.96:1 on
  the three grounds, deliberately under 4.5:1 so D-016's non-text contract stays
  true on inspection). **Positive-controlled:** reverting `--ink-soft` alone to
  `#57524A` inside the media block — grep-verified in the source *and* in the
  emitted `.next/static/css`, rebuilt, re-interlocked — turns every cell red at
  **6.70:1**, 122 failures against 84, naming `Conversation_cardMeta` and
  `LanguageSelector_option`; restoring and re-verifying returns 0 and 8.08.
  **AT NORMAL CONTRAST NOTHING REGRESSED.** The same fourteen measurements with the
  feature off reproduce HEAD: worst hero **6.70:1** — the number phases 4, 5 and 5.1
  all recorded — worst page **4.84:1**, and 0 faint glyphs.
  **TEN ACCESSIBILITY ITEMS, MEASURED NOT ASSERTED.** Every turn's `lang` matches
  its script (6/6); the speaker is real text, not a colour; the hairline is
  `aria-hidden`; the card's tick is `aria-hidden` and the card carries its own
  title; the region is `aria-live="polite"`, not `role="img"`; Space **and** Enter
  both drive the control; three focus rings render at 17.22:1, 15.79:1 and 5.16:1
  against their backdrops.
  ⚠️ **THREE FINDINGS FOUND AND NOT FIXED — all pre-existing, none in an allowed
  file.** (1) The play control's focus ring is `--accent-on-ground` at **5.16:1**
  where every other ring on the page is `--ink-strong` at 15–17:1; the divergence is
  documented as deliberate in `PlayControl.module.css` and this session did not
  relitigate it. (2) The language selector's *selected* segment is bounded only by
  fill (1.156:1), an inset ring (1.67:1) and its ink (1.955:1) — none
  reaches 1.4.11's 3:1, so which segment is selected is carried by a boundary no
  low-vision user can see. High contrast improves it and does not close it.
  (3) `Problem.module.css`'s `.enq { opacity: .82 }` is the page's worst node at
  **4.84 → 5.59:1**, still under the 7:1 body floor at high contrast; `Problem`
  is not an allowed file this phase.
  ⚠️ **`/specimen`'s TWO SWATCH LABELS BECOME FACTUALLY WRONG UNDER HIGH CONTRAST.**
  They read `--ink-faint · 2.21:1 on sunk · WRONG` and `--ink-soft · 6.70:1 on sunk
  · CORRECT`; under the media query those are 3.42 and 8.08. Copy is frozen this
  phase, so they stand. The specimen page is not indexed and not linked.
  **PRESS FEEDBACK RE-VERIFIED, NOT REBUILT — and the measurement trap is real.**
  `will-change` is set on pointerdown and removed on `transitionend`, and the
  transform transition is 100ms, so a single sample at +160ms reads `auto` and looks
  exactly like proof the handler never ran. Sampled at +16/+40/+70/+160ms with the
  press held open by a real `Input.dispatchMouseEvent`: `:active` true at +16,
  `will-change: transform` at +16 **and** +40, `auto` by +70, transform
  `matrix(0.9897…)` → `0.9865` → `0.985`, playback state unmoved throughout, and
  `transform: none` / `will-change: auto` at rest.
  **NO OVERSHOOT ANYWHERE.** The confirmation card sampled across **1943 frames**:
  `translateY` 9.49 → 0 **monotone**, `overshoot: false`, the tick's `stroke-dashoffset`
  23 → 0 monotone. Nothing animates spontaneously at idle (0 animations over the
  observation window). The stillness between phrases never drops below **766.3ms**.
  **BOTH MEDIA QUERIES AT ONCE HOLD.** Under `prefers-reduced-motion: reduce` **and**
  `prefers-contrast: more` together, at 360 and 1440: `--ink-soft` `#4B4640`,
  `--rule` 0.24, `html { scroll-behavior: auto }`, every turn transform `none`, every
  phrase opacity `1`, all seven indices 0→6, twelve turns and the card, control top
  702.2344 / 609.2813 — identical to the non-reduced runs.
  **OVERFLOW AND THE FOLD, UNCHANGED.** 0 horizontal overflow at
  360/390/768/1024/1440 at rest and across **6573 samples** taken during the running
  sequence; `document.scrollWidth === innerWidth` at every width. Control bottom
  **750.23** at 360×780, **902.17** at 412×915, **657.28** at 1440×900; region top
  **438.2344** at 360×640, i.e. **201.77px** of conversation above that fold. Zero
  language layout shift survives with no tolerance: Δ 0.0000 in all ten pairs.
  ⚠️ **TWO PRIOR NUMBERS DID NOT REPRODUCE TO THE DIGIT, AND NEITHER IS A
  CONTRADICTION.** (1) Phase 5 recorded the page-scoped worst node at **4.81:1**;
  this session reads **4.84:1** on the same node (`Problem_enqTime`, `#75716B` on
  white at opacity 0.82) with the same cause — third decimal of the compositing
  arithmetic. (2) Phase 5.1 recorded the region's top at 360×640 as **438.25**
  (201.75px above the fold); this session reads **438.2344** (201.77px) — sixteen
  THOUSANDTHS of a pixel, on a floor of 140. Every other number reproduced to the
  digit: control bottom 750.2344 / 902.1719 / 657.2813, worst hero 6.70:1 at normal
  contrast, and the ten zero-shift pairs.
- **THE SITE NO LONGER NAMES A COMPANY THAT DOES NOT EXIST — the truth audit,
  built** (`c6bda00`). Three files: `web/lib/siteConfig.ts`, `web/app/layout.tsx`,
  and a new `tests/design/indexingFlagParity.test.js`. Node **1109 → 1111 / 180
  suites / 0 fail / 0 cancelled / 0 skipped / 0 todo** — **+2 tests, +0 suites**,
  two bare `test()` calls. `npm run build` (in `web/`) exit 0. No new dependency.
  No legal page opened. No `clocks.md`. ⚠️ The Python worker suite was **not
  re-run**; its **97** is carried forward.
  ⚠️ The new test lives in `tests/design/`, i.e. **outside `web/`**, against the
  session's own scope line. It has to: `web/` has no test runner and no test of
  any kind, and `npm run os:check` runs the ROOT suite. A guard placed in `web/`
  would never execute, which is the precise failure this session was called to
  fix. It is the **sixth** root test with purchase over `web/`.

  **THE ORGANIZATION JSON-LD WAS ASSERTING A COMPANY NAME THAT IS A PLACEHOLDER,
  ON EVERY ROUTE, TO MACHINES.** `siteConfig.legalEntityName` was the literal
  string `[REGISTERED ENTITY NAME]`, emitted unconditionally as `legalName` in
  the `Organization` block that `app/layout.tsx` puts in the `<body>` of every
  page. Measured off a running `next start`, not read off source: present in the
  rendered JSON-LD of all seven HTML routes — `/`, `/specimen` and all four legal
  pages, plus the 404. It is now `null`, and every render site omits the key
  entirely, the rule `sameAs` and `contactPoint` already followed. **An absent
  field is honest; a bracketed one is a claim.** The structured data still parses
  on every route (`JSON.parse` over each block, `@type` recovered).

  **THE GUARD'S CARVE-OUT WAS FOR THE ONE FIELD A CRAWLER PARSES.** The
  build-time placeholder guard is a module-scope loop over a hand-written
  `GUARDED` array. `legalEntityName` was not in it. The reason is in the code and
  is not carelessness — the array ended with a five-line comment naming the field,
  citing external clock **C-1** and audit finding **F-F003**, saying to remove the
  exemption in the same commit that fills the legal pages, and stating outright
  that "while this line exists, an unfiled external clock is holding a production
  build open on a knowingly false statement." The exemption existed because the
  guard's only verdict is *fail the build*, and the one value nobody could supply
  would have blocked every production build. **The cost of that trade was never
  paid by the person who made it: the build went green and the placeholder
  shipped.**
  The array is gone. The guarded set is now **derived** by walking `siteConfig`
  and `waMessages`, so there is no list to leave a field off — a field added to
  either object is checked from the moment it exists. `waMessages` is swept
  because its two strings are inlined into the `wa.me?text=` href of every CTA and
  reach the browser exactly as `siteConfig`'s do. `REQUIRED_IN_PRODUCTION` names
  which fields must be non-empty; **absence from it means optional, never
  unchecked**, and an optional field is still content-checked when present.
  **POSITIVE-CONTROLLED, in the field that was exempt.** Setting
  `legalEntityName` back to `[REGISTERED ENTITY NAME]` fails `next build` with
  **exit 1** — `siteConfig: legalEntityName still holds a placeholder (matched
  /\[[^\]]+\]/)` — and reverting passes. A guard never shown to fail is not a
  guard, which is what the carve-out taught.

  **THE INDEXING RULE IS STILL WRITTEN TWICE, AND NOW SOMETHING FAILS WHEN THE
  COPIES DISAGREE.** The predecessor recorded the duplication as a known,
  unguarded cost. `tests/design/indexingFlagParity.test.js` closes it.
  It does **not** compare source text: the two are worded differently on purpose
  (`next.config.js` inlines the trim, `siteConfig.ts` routes through `envOrNull`),
  so a text compare would fail on a reword and pass on a semantic change to the
  shared helper. It extracts each rule's **expression**, plus `envOrNull`'s body,
  and evaluates both in a `vm` context against a **16-value environment matrix** —
  unset, empty, whitespace, `true`, padded `true`, `TRUE`, `True`, `false`, `1`,
  `0`, `yes`, `no`, `ture`, `true!`, `"true"` — comparing verdicts. **Drift is
  measured as behaviour.** Every extraction is anchored and asserts its anchor,
  so a refactor that moves either rule turns it red rather than vacuous, and a
  degenerate pass (two expressions extracting to the same string) is rejected
  explicitly.
  **AGREEMENT ALONE IS NOT THE PROPERTY.** Both files flipped the same wrong way
  would satisfy a parity check and still leak a preview into Google, so a second
  test pins the truth table itself: only the exact string `true`, after trimming,
  may enable indexing.
  **RED-CHECKED TWICE, IN BOTH SHAPES OF DRIFT.** Dropping the `.trim()` from
  `next.config.js` alone → red, naming the two padded-`true` inputs where the
  header and the meta tag disagree. Inverting its default to `!== "false"` → red
  on **eleven** inputs including *unset*, which is the dangerous one: header says
  indexable, meta says not. `git checkout` on the file → green, 2/2.

  **NOTHING VISIBLE MOVED, AND THAT WAS MEASURED, NOT ASSUMED.** A headless
  Chrome under forced reduced motion (so every `<Reveal>` is in `innerText`)
  dumped `document.body.innerText`, every `<meta>`, the `<title>` and the
  canonical for all seven HTML routes, before and after. **Every route's rendered
  text is byte-identical**; every meta block is identical. The **only** difference
  anywhere on the site is one line removed from the `Organization` JSON-LD:
  `"legalName": "[REGISTERED ENTITY NAME]"`.

  **NOINDEX RE-VERIFIED IN BOTH FLAG STATES, ALL NINE ROUTES.** Flag unset:
  `X-Robots-Tag: noindex, nofollow, noarchive` on all nine (including
  `/robots.txt`, `/sitemap.xml` and the 404), `<meta name="robots">` on all seven
  HTML routes, `robots.txt` → `Disallow: /` with no sitemap pointer, `sitemap.xml`
  → empty `<urlset/>`. Rebuilt with `NEXT_PUBLIC_ALLOW_INDEXING=true`: header
  absent everywhere, meta `index, follow`, `Allow: /` plus the pointer, five URLs.
  `/specimen` and `/_not-found` stay noindex in both states, as designed.

  **THE INVENTORY IS THE SESSION'S MAIN DELIVERABLE, and it is not all fixed.**
  Every assertion on every rendered route was classified off the rendered DOM and
  the structured data. The three implemented items above were the whole mandate;
  everything else is reported. **The finding that matters most is not a
  placeholder — it is `Lakeview Dental`**, an invented clinic rendered in the
  final CTA as a WhatsApp contact chip with an avatar, a name and a green
  `online` dot, **with no disclosure anywhere near it**. The hero's conversation
  is fiction too, but the hero says so in a caption that has its own test
  (`heroDisclosure.test.js`). The CTA pill has nothing. A clinic owner reads that
  chip as a customer, and finds out otherwise in the one conversation the company
  cannot afford to lose. **The fix needs words, and words are a founder decision**
  — the minimal wording is proposed in the session report and NOT applied here.
  Also reported, not fixed: `/`'s `HowItWorks` step 02 renders `Lead added to
  CRM` and `runs any follow-ups you've set up` alongside four `LIVE` badges, and
  the FAQ states a `30-day exit`, an `80%`/`90%` usage notice and a `₹0.75`
  overage rate — commercial commitments with **zero paying customers and no
  billing system in the repository**. They are policy, not code, and only the
  founder can grade them true.

- **`web/` NEEDS NOTHING OUTSIDE `web/` — deploy prep, built** (`d811910`). Eight
  files: `next.config.js`, `lib/siteConfig.ts`, `app/layout.tsx`, `app/robots.ts`,
  `app/sitemap.ts`, `.env.example`, `README.md`, and a new
  `docs/deploy/marketing-site.md`. Node **1109 / 180 / 0 fail / 0 cancelled /
  0 skipped / 0 todo** — unmoved. `npm run build` (in `web/`) exit 0. No new
  dependency. No legal page opened. `git diff web/package.json` empty.
  ⚠️ The Python worker suite was **not re-run**; its **97** is carried forward.
  **THE DEPENDENCY QUESTION IS SETTLED BY MEASUREMENT: `web/` DOES NOT NEED THE
  BACKEND, FOR ANY ROUTE.** Not "no shared build" as `web/README.md` has always
  claimed — measured. Source: zero `fetch`, zero XHR, zero server actions, zero
  route handlers, zero `middleware.ts`, zero rewrites. Env: **five** variables,
  every one `NEXT_PUBLIC_*`, every one read at build time, none naming a backend.
  Routes: all nine — `/`, `/privacy`, `/terms`, `/data-deletion`,
  `/acceptable-use`, `/specimen`, `/robots.txt`, `/sitemap.xml`, `/_not-found` —
  `○ (Static)` prerendered; no ISR, no SSR. A **hostile arm** proved it:
  `.env.local` moved out of the tree, nothing listening on :3000, and all nine
  routes served (200, and 404 for the not-found probe).
  **TWO NETWORK CENSUSES, BOTH POSITIVE-CONTROLLED.** Server side,
  `scripts/net-census.js` preloaded into `next start`: **zero** outbound attempts
  across every route. The control is in-process and that matters — a census file
  that does not exist is indistinguishable from a preload that never loaded — so a
  canary dialling a non-resolving host was preloaded alongside it. It fired **4
  times**, which also established that `next start` runs a tree of four node
  processes and the recorder was live in all of them. Browser side, a CDP census
  over a real Chrome: **166 requests across the nine routes, 0 non-loopback**, with
  a `data:` page referencing a Google Fonts stylesheet as the control in the same
  session (2 external, caught). The same instrument found **82** external attempts
  from `next build`.
  **THE BUILD IS NOT OFFLINE EVEN THOUGH THE RUNTIME IS — not previously written
  down anywhere.** `next/font/google` fetches `fonts.googleapis.com` and
  `fonts.gstatic.com` at build time to self-host Geist, Geist Mono and Noto Sans
  Telugu. A build on a machine that cannot reach Google Fonts loses the Telugu
  face, and Telugu without its face renders as tofu, which reads as a content bug.
  `next build` also posts to `telemetry.nextjs.org` (**8** requests);
  `NEXT_TELEMETRY_DISABLED=1` is now documented.
  **NOINDEX IS A PROPERTY OF THE REPOSITORY, NOT OF A HOST.** Vercel’s
  preview-URL behaviour does this on Vercel and nowhere else.
  `NEXT_PUBLIC_ALLOW_INDEXING` must be **exactly** `"true"` to permit indexing;
  unset, empty, `false`, `1` and any typo all mean noindex, so a typo fails in the
  recoverable direction. One flag drives four mechanisms that must agree:
  `X-Robots-Tag: noindex, nofollow, noarchive` (`next.config.js` — it covers
  `/robots.txt`, `/sitemap.xml`, `og-image.png` and the JS chunks, which have no
  `<head>`), `<meta name="robots">` (`app/layout.tsx` — the only one that survives
  a host ignoring `next.config.js`), `robots.txt` → `Disallow: /` with **no**
  `Sitemap:` line, and `sitemap.xml` → an empty `<urlset/>` instead of the five
  URLs it advertises when on.
  **PROVED IN BOTH DIRECTIONS.** Rebuilt with the flag at its production value:
  header absent on all nine routes, meta `index, follow`, `robots.txt` `Allow: /`
  plus the sitemap pointer, `sitemap.xml` listing five URLs. Rebuilt with it unset:
  all of it back. A robots directive that cannot be turned off has not been shown
  to be on for a reason.
  **TWO ROUTES STAY NOINDEX IN BOTH STATES, DELIBERATELY.** `/specimen` sets its own
  (`app/(marketing)/specimen/page.tsx`) — an internal design surface, not a page
  that becomes public when the flag flips — and Next noindexes `/_not-found`
  itself. Anyone reading a future flip as "failed" because those two still say
  noindex is reading the wrong routes.
  **THE RULE IS WRITTEN TWICE AND THAT IS A KNOWN COST.** `indexingAllowed` in
  `lib/siteConfig.ts` serves the three TypeScript consumers; one line at the top of
  `next.config.js` serves the header. `next.config.js` is CommonJS, loaded by the
  Next CLI before any TypeScript compiles, so it cannot import the module. Both
  sites say so, and the deploy document’s Step 3 is what catches them
  disagreeing — but **nothing in the repo fails if they drift**. Open, and small.
  ✅ **CLOSED at `c6bda00`** by `tests/design/indexingFlagParity.test.js`. The
  duplication remains — it is forced by the loader — but a drift is now red.
  **SECRET AUDIT CLEAN, AND THE CONTROL USED REAL SECRETS.** Sixteen shapes (Google
  and OpenAI-style keys, Meta long-lived tokens, bearer tokens,
  Postgres/Mongo/Redis connection strings, AWS keys, PEM private keys, JWTs,
  Neon/Railway/LiveKit hosts, RFC1918 addresses, `localhost:3000`, internal TLDs)
  over **67** files served to the browser and **155** files of build output:
  **zero**. The one `.internal` hit is `u.internal`, a property access in minified
  Next internals. The positive control took **ten real values out of the
  repository’s root `.env`** — Gemini, Postgres, Meta, encryption, session,
  WhatsApp, Sarvam, LiveKit, voice-internal, admin — proved each findable by the
  same `grep -F`, and found each absent from every built file. Values were never
  printed; the report carries variable name, length and count only.
  **THE 24 PLACEHOLDERS NOW EXIST OUTSIDE A MEMORY**, enumerated by file, line and
  token in the deploy document’s appendix, with the command to re-derive them at
  any later commit. A 25th sits outside the legal pages:
  `siteConfig.legalEntityName` is `[REGISTERED ENTITY NAME]` and is **exempt** from
  the build guard, published in the Organization JSON-LD on every page. Filling it
  and deleting the exemption is one commit.
  ✅ **THE 25th IS GONE at `c6bda00`, and it was not filled — it was removed.**
  `legalEntityName` is `null`, `legalName` is omitted from the JSON-LD entirely
  while no entity exists, and the guard has no exemption because it no longer has
  a list to leave a field off. C-1 is still unfiled; the 24 in the legal pages
  still stand. Filling C-1 is now a one-line change with nothing to un-exempt.
  **NOT DONE, AND NOT THIS SESSION’S CALL:** no account created, no deploy, nothing
  pushed. The founder deploys.
- **THE SUITE TELLS THE TRUTH ABOUT WHAT IT RUNS — two-arm embedding transport,
  built** (`50c5690`). Seven files: a new `tests/_support/embedTransport.js` (the arm
  switch), a new `scripts/net-census.js` (the instrument), a new
  `docs/testing/live-arm.md`, one `--require` added to `package.json`'s `test`
  script, and comment/wiring changes in the three test files that were making live
  calls. Node **1107 → 1109 / 180 suites / 0 fail / 0 cancelled / 0 skipped /
  0 todo**. `npm run build` exit 0. **No new dependency.** Nothing under `web/`,
  no legal page opened, no production route or handler changed, no register file
  edited except this one.

  **THE SUITE'S LIVE-GEMINI FOOTPRINT WAS 12 CALLS ACROSS 3 FILES. IT IS NOW ZERO
  BY DEFAULT, AND STILL 12 ON DEMAND.** The predecessor's count was inherited but
  not trusted: it was re-measured with a new instrument, `scripts/net-census.js`,
  a preload that records every outbound request at the `fetch`, `http`/`https` and
  socket layers. Over a full `npm test` at `051ed7b` it recorded **976 outbound
  attempts, 15 of them non-loopback** — 12 `embedContent` fetches plus the 3 TLS
  connects they shared — split exactly `5 portalFaqs / 5 portalOnboarding /
  2 portalKnowledgeSummary`. **The predecessor's 12/3 holds, to the call.**

  The switch is `tests/_support/embedTransport.js`, loaded by `--require` from the
  `test` script (the `testEnv.js` seam, chosen for the same reason: `node --test`
  propagates `execArgv` to every per-file child, so it is installed before any
  test module in every process). `npm test` answers offline; `LIVE_GEMINI=1 npm
  test` makes the real call. Same tests, same code, one difference.

  **IT REPLACES THE WIRE, NOT THE SERVICE — which is why the error paths got
  BIGGER, not smaller.** The seam is `GenerativeModel.prototype.embedContent`, so
  everything in `knowledgeService.embed()` still runs in both arms: the budget
  class lookup, the `AbortController`, the deadline timer, the `signal` relay, the
  `result.embedding.values` unwrap. A `mock.method` on `knowledgeService.embed`
  skips all of it — and cannot see `getRelevantChunks`, which reaches `embed`
  through the module-local binding (`knowledgeService.js:111-118`). Both stub
  layers now coexist deliberately: the service seam for the tests that assert on
  call COUNTS, the transport underneath it for everything else.

  **THE TWO NEW TESTS ARE THE ERROR PATHS NO STUB IN THIS REPO COULD REACH.**
  `routes.js:1986-1990` turns any throw out of the embedding into a 500, and
  nothing exercised that line — which is why three historical `500 !== 200`
  sightings on the retrieval test had no companion showing what a real 500 there
  looks like. `embedTransport.failNext()` produces a transport rejection;
  `stallNext()` produces a call that never answers, so only the deadline ends it.
  Both assert the 500, the recorded latency, and that **no row is written**.

  ⚠️ **FAULT A REMAINS OBSERVABLE — this was the session's stop condition and it
  was cleared by measurement, not by argument.** The instrumentation `0fdf971`
  added did not move to a stub; it moved into the transport and runs in **both**
  arms, so a record has one shape whichever arm produced it. Measured live this
  session: two ordinary calls at `{"ok":true,"ms":626.8,"live":true}` and
  `{"ok":true,"ms":463.6,"live":true}` — inside the predecessor's 424–1903 ms
  band — and then, with `EMBED_TIMEOUT_INTERACTIVE_MS=1` forcing the deadline to
  fire on a genuinely in-flight live request:

  ```
  {"ok":false,"ms":4.5,"live":true,
   "err":"[GoogleGenerativeAI Error]: Request aborted when fetching
          …:embedContent: This operation was aborted"}
  ```

  Field for field the shape of the 10,085.7 ms stall record. A live run still
  produces it, and `docs/testing/live-arm.md` says what to do on the next
  sighting (record it; do not raise the deadline). **Fault A's production remedy
  was explicitly out of scope and was not begun** — no handler was touched.

  ✅ **THE GATE ALREADY SAW CANCELLATIONS. Scope item 1 required no change, and
  that is a finding rather than a failure.** Answered from the parsing logic, not
  the header: `scripts/os-check.js:196-206` refuses on a non-zero `# cancelled`
  and **also** refuses when the counter cannot be parsed at all ("a counter that
  cannot be read is not a zero"), and `:208-224` does the same for `# skipped`.
  `tests/infra/osCheckGate.unit.test.js:124-198` already covers both against real
  induced runs. **Demonstrated end to end anyway**, with a throwing `before` hook
  and three siblings: `# fail 0 / # cancelled 3` → `os:check` **exit 1**, with all
  three cancelled tests NAMED and their `cancelledByParent` reason given. Exit 1
  before the change and exit 1 after it.

  ⚠️ **`# todo` IS THE SAME BLIND SPOT, STILL OPEN — reported, not fixed (it was
  outside this session's scope).** The string `todo` does not occur anywhere in
  `scripts/os-check.js`. A `todo` test that THROWS is reported `not ok … # TODO`,
  counted under `# todo` and never under `# fail`, **and it still counts toward
  `# tests`** — so the recorded-total comparison cannot catch it either, unlike a
  skipped suite. Reproduced: a 2-test file whose todo test throws gives
  `# fail 0 / # todo 1`, `node --test` itself exits **0**, and `suiteGate` returns
  `[]` — green. The fix is three lines, symmetrical with the `cancelled` block:
  read `todo: got(/^# todo (\d+)$/m)`, refuse when it is `undefined` or not `'0'`,
  and name the directives (the `skipDirectives` scanner already has the shape —
  it needs `# TODO` alongside `# SKIP`). At HEAD the count is 0, so landing it
  cannot turn `os:check` red today.

  **THE TWO FALSE COMMENTS WERE CORRECTED BY MOVING THE CODE, NOT THE PROSE, IN
  BOTH CASES.** `portalOnboarding.integration.test.js`'s "stubbed exactly like the
  rest of the suite" was the accurate half — it described `validateTenant`'s
  `deps` argument, and that argument really is stubbed — while the five
  `faqService.createFaq` calls twelve lines above it went to Google for real. The
  code moved: those five are served offline now, and the sentence became true of
  the whole test rather than of one argument in it. `portalFaqs`'s header claim
  that real calls were "reserved for ONE test" was wrong by 2.4x; it now states
  the arm switch and the measured census instead, and **the count is a property of
  the transport rather than of a comment** — `scripts/net-census.js` re-checks it.
  `portalKnowledgeSummary` had no comment at all about its two live calls, which
  was the most dangerous of the three: they sit in a `before` hook, so one bad
  call reports `# fail 0 / # cancelled 7`. It says so now.

  **DETERMINISM: 20 consecutive `npm test` runs, in `os:check`'s ordering** —
  `os-check.js:264` spawns `npm test` verbatim, so there is no third ordering.
  **19 / 20 at `1109 pass / 0 fail / 0 cancelled / 0 skipped / 0 todo`**, and the
  twentieth is reported rather than re-rolled: **run 4 failed one test in
  `portalLifecycle.integration.test.js:794`, a file this session never touched**
  (see the new open risk below). Every run reported `# tests 1109 / # suites 180`
  and no run recorded a cancellation, a skip or a todo. The census over the
  default arm reports **961 outbound attempts, 0 of them external**; the same
  instrument over the live arm reports 12, which is the positive control that it
  measures anything at all.

  ⚠️ **THE SWEEP CAUGHT TWO DEFECTS IN THIS SESSION'S OWN NEW TESTS, and that is
  the argument for running it.** Neither would have been visible in a single
  green run. (1) The deadline test asserted a `Date.now()` ceiling of 5,000 ms;
  it went red once when the **host suspended for 2h25m mid-run** and the
  assertion measured the suspension. Removed rather than widened — it was also
  redundant, because `stallNext()` settles only on abort and the sole aborter on
  that path is `embed()`'s deadline, so the 500 already proves the deadline
  fired; a deadline that never fired hangs the request and surfaces as a
  CANCELLED test, which the gate refuses. (2) The same test then asserted the
  recorded latency was `>= DEADLINE_MS`, which is **wrong by construction and
  fired 1 run in 40 at 149.6 ms against 150**: `embed()` arms the timer BEFORE it
  calls `embedContent` (`knowledgeService.js:147-155`), so the recorded span
  starts later than the deadline's clock and is always slightly shorter. The
  floor is now 80% of a named `DEADLINE_MS`, which still separates "waited out
  the deadline" from "answered instantly" by two orders of magnitude.

  **BOTH NEW TESTS ARE MUTATION-CHECKED**, because this repo has shipped vacuous
  pins twice. Making `failNext` succeed reds exactly test 18; making `stallNext`
  answer normally reds exactly test 19. The first attempt showed a CASCADE — 18's
  leaked row reddening 19 — so both now clear their tenant in `finally`, and the
  re-check is one mutant, one red, each.

  ⚠️ **THE FREE-TIER ASSUMPTION IN THE REGISTER IS FALSIFIED and was NOT edited
  here** — `assumptions.md` is founder-landed. `portalFaqs`'s old header cited
  "Issue 21/30 — 20/day" for the embedding key's quota. The predecessor measured
  **334 live calls in one session, 334 answered, zero 429s at any point**, which
  is 16.7x that figure with no rate pressure observed. The proposed correction is
  written out in this session's report.

  **NOTHING ON THE FORBIDDEN LIST WAS USED.** No test was deleted or skipped to
  remove a live call — the retrieval test still runs, still asserts `strictEqual`
  against exactly 200, and gained two siblings. No `.skip`, no `.only`, no `todo`
  was added anywhere (`# skipped 0 / # todo 0` at HEAD). The live arm is
  runnable, documented and switched by a recorded flag. No stub is
  success-only — that is what the two new tests are for. And no cancellation was
  suppressed: the gate's refusal on `cancelled` is unchanged and re-demonstrated.
- **THE `portalFaqs` INTERMITTENT IS TWO FAULTS — attribution session, built**
  (`0fdf971`). One file changed: `tests/portal/portalFaqs.integration.test.js`
  (+78/-4 — a pass-through transport spy and three assertion messages). No `it()`
  added, so **1107 / 180 / 0 / 0 / 0 — UNMOVED**, by intent. `npm run build`
  exit 0. No new dependency. Nothing under `web/` and no legal page opened.
  **This session was scoped to attribute, not to fix**, and the outcome is one
  fault named on evidence and one explicitly not.

  ⚠️ **FAULT A — AN EMBEDDING CALL STALLS AND THE 10,000 ms `interactive`
  DEADLINE FIRES. Named, reproduced, and NOT fixed.** Caught naturally on run 20
  of 50 consecutive runs of the file alone, by the instrumentation this session
  added, on its first firing:

  ```
  PATCH /portal/api/faqs/8925cc09-… → HTTP 500, expected 200.
  body={"error":"Failed to save this FAQ"}
  liveEmbedCalls=[{"ok":true,"ms":816},{"ok":true,"ms":473.3},
                  {"ok":false,"ms":10085.7,"err":"[GoogleGenerativeAI Error]:
                   Request aborted when fetching …:embedContent:
                   This operation was aborted"}]
  ```

  `duration_ms 12050.0`, at the **PATCH** assertion (`:560`), not the POST. This is RAG
  Session 3's fault recurring at D-011's raised bound, and **D-011's derivation of
  10,000 ms is falsified by it.** That number was justified as sitting "3.3x above
  the value known to fire, outside [the measured spread]". The spread is real and
  the bound does clear it — **334 live embedding calls measured this session put
  p50 at 482 ms, p99 at 1571 ms, and the second-slowest call in the whole set at
  1903 ms** — but the failing call is not in that distribution. It is a separate
  **stall** mode with no upper latency at all; the deadline is the only reason any
  number was recorded for it. **No finite bound escapes a stall**, so the two
  obvious remedies are both wrong and both are on this session's forbidden list:
  raising the budget only lengthens the red, and a retry hides it. Recorded as
  open. The real remedy is a decision about what a stalled embedding should do to
  an owner's Save — which is a product question, not a constant.

  ⚠️ **FAULT B — THE PHASE-5 607 ms RED IS NOT FAULT A, AND ITS CAUSE IS NOT
  ESTABLISHED.** 607 ms against a 10,000 ms deadline was already recorded as not
  fitting; this session establishes what it also cannot be. Three arms were
  induced at this test and measured against it. Every arm is identical in every
  recorded field — same location, same `500 !== 200`, same response body, because
  `routes.js:1988` emits one string for every failure — and latency is the only
  field that separates them:

  | arm | how induced | `duration_ms` |
  |---|---|---|
  | Google ANSWERS with a rejection (quota / tier / auth) | whole suite run against a rejected key | **1925.6** (20-way) |
  | the fetch never reaches Google (DNS / connect / socket) | `globalThis.fetch` throws for that host | **1104.7** (20-way) / **601.0** (alone) |
  | a POST that does no network work at all | this file's own 400/404 tests | 548–690 (alone) / 712–1334 (20-way) |
  | the test passing | — | 4875.3 (20-way) / 3770.7 (alone) |
  | **the phase-5 red** | — | **607** |

  ⚠️ **THE LEADING HYPOTHESIS — the embedding credential's tier or quota — IS
  RULED OUT for Fault B, not left open.** Four independent lines, no one of which
  rests on the others. (1) **Induced comparison.** A rejected credential
  reproduces the signature byte-for-byte — `:465`, raised at `:474:14`
  (the pins as they stood before this session's change),
  `500 !== 200` — and costs **1925.6 ms** under the same 20-way parallelism, 3.2x
  the recorded 607 ms. (2) **Google has no fast answer.** Every answered call
  costs a full round trip: 424–1903 ms for a 200 (n=333), 535–575 ms for an
  induced `401 ACCESS_TOKEN_TYPE_UNSUPPORTED`, 981 ms for an induced
  `400 API_KEY_INVALID`. On top of this test's own start-server + login overhead —
  548–690 ms uncontended, 712–1334 ms contended — a 607 ms total leaves no room
  for one. (3) **Recovery pattern.** A daily-quota exhaustion cannot recover in
  minutes, and the second `os:check` at the same commit was green. (4) **No rate
  pressure exists to hit.** A census of every live call, taken by wrapping
  `fetch`, shows the suite issuing **at most 2 embedding requests in any wall-clock
  second**, and **334 of 334 calls today were answered — 333 with a 200 and one
  stalled — with no 429 at any point.**

  **Also eliminated for Fault B, each with the observation that did it:** the
  interactive deadline (607 ms ≪ 10,000 ms, and `.env` sets no `EMBED_TIMEOUT*`
  override); `DB_STATEMENT_TIMEOUT_MS` (5,000 ms ≠ 607 ms); **Postgres connection
  exhaustion** — `max_connections` is 100 and a 364-sample sweep across a full
  suite run peaked at **27**, and the app pool sets no `connectionTimeoutMillis`,
  so there is no fast-fail path there at all; and **"created, then failed
  afterwards"** — a successful embed costs ≥424 ms, so a run that reached the
  INSERT could not have finished in 607 ms. What survives is narrow and honest:
  **the 500 arose before Google answered.** That is either a transport-level
  failure on the embedding fetch (an induced one costs 64 ms and lands the test at
  601.0 ms, against the recorded 607 ms) or a fast failure earlier in the handler —
  `getConfigForSession`, `countFaqs`, or `requirePortalAuth`, whose own 500 carries
  a *different* body (`Auth check failed`, `auth.js:148`) that the assertion as it
  stood could not tell apart. Retrospectively these cannot be separated, because
  the evidence that would separate them was discarded at the moment of failure.

  **WHAT LANDED, AND WHY IT IS INSTRUMENTATION AND NOT A FIX.** The assertion had
  failed three times and been attributed once. Both places that know why are
  closed on this path: `routes.js:1988` collapses every failure into
  `Failed to add this FAQ`, and the file's `LOG_LEVEL = 'silent'` (`:35`)
  suppresses `routes.js:1987`, the only line carrying the cause. The test was
  therefore structurally incapable of reporting its own failure. It now installs a
  **pass-through** spy at `GenerativeModel.prototype.embedContent` — the live call
  still runs, its result and its errors pass through untouched, the spy only
  observes — and the three `assert.equal(…, 200)` calls carry the request, the
  response body, and every live call's latency and error. The spy sits at the
  transport rather than on `knowledgeService.embed` because `:551`’s
  `getRelevantChunks` reaches `embed` through the module-local binding, which a
  `mock.method` on the export cannot see (`knowledgeService.js:111-118`). Nothing
  was retried, loosened, skipped, deleted, stubbed or given a longer budget; the
  assertion is still `strictEqual` against exactly 200. It proved itself inside 50
  runs.

  **REPRODUCTION RATES, natural runs only** (the induced suite runs are excluded).
  `os:check` runs `npm test` verbatim — `scripts/os-check.js:264` is
  `spawnSync('npm', ['test'])` — so **there is no third ordering to test**; the
  full-suite row IS os:check's ordering. File alone: **1 red / 60** (10 before the
  change, 50 after). Full suite: **0 red / 10** (2 in Phase 0, 3 before the
  change, 5 after). Per live call, the stall rate is **1 in 334**.

  ⚠️ **THE SUITE'S LIVE-GEMINI FOOTPRINT IS 12 CALLS ACROSS 3 FILES, NOT ONE TEST
  — three adjacent defects found and left open.** `portalFaqs`'s own header says
  real Gemini calls are "reserved for ONE test", which is true inside that file and
  false of the suite. Established by running the whole suite against a rejected
  key, which names every live-call site at zero quota cost:
  `portalKnowledgeSummary.integration.test.js:185-186` makes **2 unstubbed calls in
  its `before` hook** — and because they sit in a hook, their failure reports
  `# fail 0 / # cancelled 7`, exactly the shape `os-check.js`'s own header warns a
  gate cannot see; `portalOnboarding.integration.test.js:398-402` makes **5**, in a
  test whose comment two lines below claims the network-bound work is "stubbed
  exactly like the rest of the suite" (true of `kb.retrieval` and `whatsapp.live`,
  not of the five `createFaq` calls above it); and any quota reasoning done from
  the `portalFaqs` header is therefore wrong by 2.4x. None of the three was fixed —
  all are behaviour changes outside an attribution session's scope.
- **THE HERO FITS A PHONE — HERO-1 phase 5.1, built** (`629412c`). Two files,
  both CSS: `Hero.module.css` and one `max-width` block in
  `Conversation.module.css`. Node **1109 / 180 / 0 fail / 0 cancelled / 0 skipped /
  0 todo** — unmoved; no test was added, because every claim here is a measurement
  on the built page and none of it is assertable from Node. `npm run build` exit 0.
  `git diff web/package.json` empty.
  ⚠️ The Python worker suite was **not re-run**; its **97** is carried forward.
  **THE TARGET WAS REVISED BY THE FOUNDER BEFORE ANY CODE CHANGED.** Phase 5's
  criterion — the control above a **360×640** fold — was unreachable: the hero copy
  alone is 518.58px there and the copy, selector, region and control together are
  1094.58px. 360×640 is a 2016-class viewport. The revised target is the control
  fully visible at **360×780**, with a floor of ≥140px of the conversation region
  above a 360×640 fold, and 1440×900 unchanged.
  **THE BUDGET WAS ITEMISED BEFORE ANYTHING MOVED, and it closes.** A ledger walked
  from `<body>` down the ancestor chain to the control, emitting each container's
  lead, each in-flow sibling's height and each inter-sibling gap, reconstructs
  phase 5's `1046.58` to the hundredth at 360×640 and its `609.28 / 657.28` at
  1440×900. The rows at 360×640: `108` hero padding-top · `5.8` first-line lead ·
  `18.42` eyebrow · `23.38` · `126` h1 (3 × 42) · `24` · `163.13` sub (6 lines) ·
  `36` · `89.14` CTAs · `14` · `18.72` micro · `40` grid gap · `40` selector ·
  `20` shell gap · `296` region · `24` host gap. **Four levers, and what each
  actually yielded** (against expectation): rhythm **−72.00** (−72 expected) —
  padding-top 108→76, grid gap 40→24, h1 margins 22/24→14/16, CTA margin-top 36→20,
  micro 14→10; type scale **−25.20** (−25.2) — the headline clamp minimum
  2.5rem→2rem, so 40px→32px below 480; the sub **−203.13** (−187.13 expected, and
  the extra 16 is real: hiding it also collapses the h1's 24px bottom margin into
  the CTA's own new 20px top margin, which phase 5's isolated injection could not
  see); the region **−56.00** (−56) — 296→240 below 480px.
  **THE RESULT.** Control bottom **750.23** at 360×780 (29.77px clear) and at
  390×844 (93.77 clear); **902.17** at 412×915 (12.83 clear); **657.28** at
  1440×900, byte-identical to phase 5. At 360×640 the region's top is **438.25**,
  so **201.75px** of the conversation is above the fold against a 140px floor — and
  in the complete state the fold cuts through the confirmation card, which is the
  affordance the floor exists to protect.
  ⚠️ **LEVER 4 WAS NEEDED, AND ONLY 412×915 NEEDED IT.** The sub stays visible at
  412 (the approved design drops it *below* 400), so that device had only rhythm
  and type to spend: 82 + 25.2 against a 152.39px deficit. Region height 296→240 at
  ≤480px closed it. Point 1 of `Conversation.module.css`'s own header still holds —
  a different fixed height, not `auto`. Measured at 360/390/412 in the complete
  state: **2 turns + the confirmation card** visible, `overflow:hidden`,
  `justify-content:flex-end`, content overflowing **544.87px above the box's top
  edge** and clipped there. What is lost is the *partially* rendered turn at the top
  edge: at 296 a quarter of the previous turn showed, at 240 the top turn starts
  4.18px below the edge and the one above is fully clipped. `/specimen`'s **five**
  instances (not four — the brief's count is stale) all move 296→240 at 360 and are
  unchanged at 768/1440.
  ⚠️ **THE BREAKPOINTS DO NOT ALL SIT AT 400, AND THE BRIEF ASKED THEM TO.** 412×915
  is one of the three devices the revised target names and 412 is above 400: with
  the rhythm and type steps scoped to 400 that phone keeps HEAD's layout and stays
  152px below its own fold. They are at **480**, the breakpoint the file already
  had. The type step is at **600** so that `6.67vw` meets the base rule's 2.5rem
  exactly at the boundary — at 480 it would be a visible 8px snap between 480 and
  481. Only the **sub** is at 400, and at `399.98` rather than `400` so it still
  renders AT 400px.
  **NO COPY CHANGED AND NO ELEMENT LEFT THE MARKUP.** The sub is present at every
  width measured (360/390/399/400/412/1440) with the same 216-code-unit string and
  the same hash; it is `display:none` at 360/390/399 and `block` at 400/412/1440.
  DOM order is identical before and after: **38 hero descendants in the same
  sequence** at 360, 412 and 1440, with the two pre-existing `order:1`/`order:2`
  declarations unchanged; the only difference in painted order is the sub, which at
  360 has no painted position at all.
  **ZERO LANGUAGE LAYOUT SHIFT SURVIVES, WITH NO TOLERANCE.** The control's top is
  bit-identical for `en` and `te` at **360, 390, 412, 768 and 1440**, in both idle
  and complete — Δ 0.0000 in all ten pairs. **Positive-controlled:** setting the
  region to `height: auto` at the mobile breakpoint (grep-verified in the source
  *and* in the emitted `.next/static/css`) turns six of the ten pairs red — Δ up to
  −110.44 — at exactly the three widths the breakpoint covers and nowhere else;
  reverting and re-verifying returns all ten to 0.0000.
  **CONTRAST, OVERFLOW, REDUCED MOTION.** Contrast swept over every text node in
  ten measurements — six states at 360, idle+complete at 390 and 412: **0
  failures**, worst node **6.70:1** (the selector's unselected segment, the same
  number phases 4 and 5 recorded), `--ink-faint` on **0** glyphs. Overflow at
  360/390/412/768/1024/1440, at rest and across **1034 samples taken during the
  running sequence**: **0** with `scrollWidth > clientWidth` on the document, body,
  host or region. Under `--force-prefers-reduced-motion=reduce` at 360 and 412 the
  full sequence runs — every `activeIndex` 0→6, six turns, the card — with the
  control's top unmoved.
  ⚠️ **A CAPTURE ARTIFACT WAS FOUND AND IS NOT A DEFECT.**
  `captureBeyondViewport: true` re-runs the hero's entrance animations from t=0, and
  the sub came back with **0 dark pixels** at 412 and 5539 instead of 14925 at 1440
  — a blank band that reads exactly like a rendering bug in a review image. On the
  same page at the same moment the element computes `display:block`, opacity 1,
  effective opacity 1, colour `rgb(87, 82, 74)`, identity transform, animation
  `finished`, and the same clip with `captureBeyondViewport` OFF paints it. The
  review captures pin the entrance to the end keyframe it is already in before
  shooting.

- **THE HERO CONVERSATION IS ON `/` — HERO-1 phase 5, built** (`8d67d47`).
  **HERO-1 ends here.** Six files: `Hero.tsx` and `Hero.module.css` rewritten,
  `HeroChat.tsx` **deleted**, one comment block in `PlayControl.module.css`, the
  `/specimen` kicker, and a new `tests/design/heroDisclosure.test.js`. Node
  **1106 → 1107 / 180 / 0 fail**. `npm run build` exit 0. No new dependency:
  `git diff web/package.json` is empty.
  ⚠️ The Python worker suite was **not re-run**; its **97** is carried forward,
  not verified. Nothing under `voice-agent/` is touched.
  **NO CONVERSATION MODULE CHANGED, AND THAT WAS THE ABSTRACTION TEST.** Phase 5
  mounts `<LanguageSwitchedConversation>` and nothing under
  `components/sections/conversation/` moved except one comment in
  `PlayControl.module.css`. `Conversation.tsx`, `ConversationPlayer.tsx`,
  `usePlayback.ts`, `cadence.ts`, `PlayControl.tsx`, `LanguageSelector.tsx`,
  `index.ts`, `types.ts`, `en.json`, `te.json` and `meta.json` are byte-identical
  to phase 4.1. The seam phase 2 drew — a stateless renderer, a client wrapper
  that owns which frame, a server that narrows the fixture — held when the
  second consumer arrived.
  ✅ **THE HONESTY LABEL SURVIVED, which is the thing this change could most
  easily have lost.** `HeroChat` rendered exactly one visible disclosure, a
  caption reading *"An example of Prantivo booking a patient appointment on
  WhatsApp, here in Telugu — the replies are translated beneath. It also answers
  in Hindi and English, and a staff member can take over the chat at any
  point."* Two of those clauses described `HeroChat`'s rendering rather than the
  product, and both became false: there is no gloss line beneath a reply, and
  with a selector the reader chooses the language. It was carried over **by
  deletion only** — `", here in Telugu — the replies are translated beneath"`
  removed, **no word authored** — on a founder ruling taken before any code
  changed. Both strings were read off the live DOM at 360 and 1440, before and
  after; every other visible string that changed is enumerated below.
  **THE `role="img"` WRAPPER WENT WITH IT, AND THAT IS AN IMPROVEMENT.**
  `HeroChat` hid its whole thread from assistive technology behind `role="img"`
  and substituted a 33-word `aria-label`. The conversation is real content — DOM
  order, `aria-live`, a readable confirmation record — so there is nothing left
  to summarise. Net on `/`: one `aria-label` removed, one added (`Conversation
  language`, the radiogroup's).
  **COPY IS OTHERWISE UNTOUCHED.** Headline (`Booked before` / `they message` /
  `another clinic.`) and sub are **byte-identical** off the live DOM at both
  widths, 222 bytes each side. 15 strings left `/` (the WhatsApp chrome, six
  Telugu bubbles, two English glosses, the old caption); 7 arrived (`English`,
  `తెలుగు`, `Patient`, two phrase spans of t0, `Play the conversation`, the
  migrated caption).
  ✅ **`Dr. Rao` LEFT THE CLIENT BUNDLE — phase 3's falsifiable prediction, and
  it held.** `.next/static/` (45 files) greps **0 hits**, alongside 0 for the
  appointment UUID, `Sravani Reddy`, `Smile Dental` and `2026-07-18`. Five
  positive controls were searched first — `Play the conversation`,
  `data-conversation-region`, `Prantivo`, `Conversation language`,
  `data-lang-option` — all found, so the zeros are real. `Hero.tsx` reads the
  fixture and is still a server component; three strings cross the boundary.
  **THE PROVENANCE COMMENT WAS ALREADY MIGRATED, at phase 1.** Verified
  byte-for-byte before the delete rather than by eye: sha256 of the
  CRLF-normalised block is
  `17088cf2c738ff8236ca728585c9d73ba4c1bf1d167e54da74ed979366374cfe` on both
  sides, 985 bytes each, matching the digest `index.ts` records for itself.
  ⚠️ One sentence in that header is now stale — it says `HeroChat.tsx` "keeps
  its own copy and keeps rendering until phase 5". `index.ts` is outside phase
  5's allowed files, so it was left alone.
  **THE HEADLINE IS STILL SERVER-RENDERED.** The raw HTML `next start` serves for
  `/` is 117,137 bytes and carries the headline, the sub, the caption, the play
  control's label and t0's Telugu **outside every `<script>`** — so they exist
  before any JS runs, even though the conversation is now a client component.
  **`--wa-*`: FOUR ORPHANED, FIVE KEPT, censused with positive controls.**
  Removed from `Hero.module.css` with the 172 lines of dead card CSS: `--wa-bg`,
  `--wa-meta`, `--wa-tick`, `--wa-gloss` — now zero consumers anywhere in
  `web/`. Kept because something else still reads them: `--wa-header`
  (`FinalCta:30`), `--wa-text` (`FinalCta:64`, `HowItWorks:97,142,189`),
  `--wa-online` (`FinalCta:72,79,88`, `HowItWorks:152`), `--wa-in`
  (`HowItWorks:96`), `--wa-out` (`HowItWorks:143`). ⚠️ **The four orphaned
  DECLARATIONS survive** at `globals.css:135,140,141,147`, because phase 5's
  allowed files exclude `globals.css`. Declared and unread — a tidy-up, not a
  defect.
  **BUNDLE, attributed.** `/` first-load JS **113 → 115 kB** against a 125 kB
  budget. The whole delta is two numbers: `chunks/29-*.js`, the conversation
  client graph, is **+3.65 kB gzip** and newly loaded by `/` (it was
  `/specimen`-only), and `/`'s own page chunk falls **7.42 → 5.75 kB** as
  `HeroChat` and its six hand-typed messages leave. `/specimen` page chunk **4.77
  → 1.18 kB**, first-load **107 kB** unchanged — the same code, now shared rather
  than route-local.
  **MEASURED ON THE BUILT PAGE, in six states × five widths.** The six are
  `te-idle`, `te-playing`, `te-paused`, `te-complete`, `en-idle`, `en-complete`,
  each driven over CDP with real pointer presses and read back off
  `[data-playback]`. **Contrast:** 0 failures in all 18 measurements at
  360/768/1440; worst text node **4.81:1** (`Problem_enqTime`, pre-existing, its
  0.82 opacity a documented design value) and worst node in the hero itself
  **6.70:1** (the selector's unselected segment) — the same number phase 4
  recorded. `--ink-faint` on **0** glyphs everywhere. **Token witness:** `body`
  background `rgb(250, 248, 245)` in all 18. **Overflow:** none at
  360/390/768/1024/1440 in any state, plus **~979 samples taken during the
  running animation** across the five widths, every index 0–6 observed, **0**
  showing `scrollWidth > clientWidth` on the document, the body, the host or the
  region. **Zero layout shift between states or languages:** the hero box is
  1223px at 360 and 792px at 1440 in all six states, and the full page is 15318 /
  11667 / 9739px at 360/768/1440 in all six.
  ⚠️ **CONTRAST IS MEASURED AT REST, DELIBERATELY.** `playing` is the one state
  that can be caught mid-fade, and a snapshot during a turn's 150ms arrival
  composites the glyph at a fractional opacity — one run read **2.47:1** at an
  accumulated opacity of 0.534, on text that is 7.31:1 the instant it settles.
  The probe therefore waits until nothing in the region is strictly between 0 and
  1 opacity before sweeping, and keeps the mid-flight reading separately rather
  than discarding it.
  **REDUCED MOTION.** Under `--force-prefers-reduced-motion=reduce` at 360 and
  1440 the sequence runs end to end: every `activeIndex` 0→6 observed, all six
  turns rendered, the confirmation card reached. The **only** turn transform ever
  observed across the whole run is `none`, and the **only** phrase opacity ever
  observed is `1` — phrases arrive per turn, whole, and nothing translates or
  scales.
  ⚠️ **THE PLAY CONTROL IS ABOVE THE FOLD AT 1440×900 AND NOT AT 360×640** —
  **SUPERSEDED at HERO-1 phase 5.1** (`629412c`), which closed it on the three
  devices the founder revised the target onto. What follows is phase 5's own
  measurement and stays as the record of what it found. Its
  rect is `top 609.28 / bottom 657.28` against a 900px viewport — above. At
  360×640 it is `top 1046.58 / bottom 1094.58`, **454.58px below**. The phase
  plan's proposed remedy — drop the sub below 400px — was **measured, not
  reasoned about**: injecting `display: none` on the sub moves the control from
  1094.58 to 907.45, saving **187.13px**, still **267.45px** short. It was
  therefore not implemented, because it deletes an approved visible string for no
  gain. Closing the remaining 267px needs a mobile layout decision — source
  order, or the region's 296px height — and neither is in phase 5's allowed
  files. **The hero column does not fit above a 640px fold on mobile:** the copy
  above it is 518.58px on its own, before the selector, the region and the
  control.
  **`/specimen` STILL WORKS**, and stays a design surface. Four static instances
  at `activeIndex` 0/2/5/6 render 1/3/6/6 turns with the card on the last only,
  all at the 376px region height; the live instance switches `te → en` and plays
  to `complete` with the card reading *"Appointment booked · Tomorrow, 9:00 AM ·
  Dr. Rao"*; the four statics are unmoved afterwards.
  ⚠️ **NO PIXEL GATE ON `/`, BY DESIGN.** Pixel equality was the phase 1–4
  instrument and it is meaningless here — the hero was replaced. The live-DOM
  gates above replace it. Do not read an absent pixel diff as a skipped check.
  ⚠️ **A MEASUREMENT HAZARD THAT IS NOW PERMANENT.** `globals.css:313` sets
  `scroll-behavior: smooth`, reverted to `auto` only under reduced motion — and
  every phase 5 measurement is on `/`, which does not force reduced motion.
  Phases 2–4 never hit it because their capture modes did. A probe calling
  `scrollTo(0, 0)` reads a **mid-flight** `scrollY`, indistinguishable from a
  layout shift. Every geometry expression in this session's harness therefore
  begins with `scrollTo({ behavior: 'instant' })` and **throws** if `scrollY !==
  0` afterwards.
  ⚠️ **`portalFaqs.integration.test.js:465` FIRED ONCE, IN THE FIRST OF TWO
  `os:check` RUNS AT `c0fa1fd`.** It is a recorded intermittent and it had not
  resurfaced since RAG Session 3; this is the first occurrence since. **Not
  attributed to this change, and the reason is structural rather than a shrug:**
  phase 5 touches `web/` and one new `tests/design/` file, while this test
  exercises the portal FAQ route, Postgres and a live Gemini embedding — no
  shared module, no shared fixture. `npm test` at `8d67d47` was **1107 / 0
  fail** fifteen minutes earlier, the file re-run alone at the same HEAD is
  **20 / 20 green**, and the second `os:check` is **1107 / 180 / 0 / 0 / 0**.
  Three green runs at this commit against one red.
  ⚠️ **ONE DETAIL DOES NOT FIT THE RECORDED MECHANISM, and is written down
  rather than smoothed over.** The location and assertion match exactly —
  `:474`, `500 !== 200`, the POST whose `createChunk` makes the process's first
  cold embedding call. But the failing test took **607 ms**, and `createChunk`
  has carried a **10,000 ms** interactive budget since RAG Session 3's amendment
  to D-010. A 607 ms 500 is therefore **not** that timeout, so either the 500
  has a second cause (a live Gemini error — quota is plausible, this key is a
  low-quota dev key and the suite ran four times this day) or the budget is not
  reaching that call site. The underlying route error was not captured: the TAP
  block carries only the assertion, and `.os-check-last.log` is overwritten by
  the next run. **Whoever picks this up should capture the route's log line
  first** — the assertion alone cannot distinguish the two.
  ⚠️ **TWO PROBE BUGS, FOUND BY THEIR OWN OUTPUT AND RECORDED BECAUSE THEY WILL
  RECUR.** (1) A contrast sweep that walks the backdrop from `el.parentElement`
  skips the element's OWN background and reports light-on-dark button text as
  **1:1** — it flagged both primary CTAs before the walk was corrected to start
  at `el`. (2) `display: none` **cancels** a running CSS animation, and restoring
  `display` restarts it from `t=0`; a screenshot taken after a hide/restore probe
  caught the hero sub at `opacity: 0` mid-delay and looked exactly like a
  rendering defect. Confirmed directly — after the cycle the element reports
  `opacity 0` with `fadeUp` `running` at `t=0` — and fixed by shooting before
  injecting.
- **THE CLOCK FOLLOWS THE LANGUAGE — HERO-1 phase 4.1, built** (`89927c9`).
  Two files: `usePlayback.ts` (+52 lines, one `useEffect` and one four-line
  helper) and a new `tests/design/conversationPlayback.test.js`. Node
  **1105 → 1106 / 180 / 0 fail**. `npm run build` exit 0. No new dependency.
  ⚠️ The Python worker suite was **not re-run**; its **97** is carried forward,
  not verified. Nothing under `voice-agent/` is touched.
  **THE DEFECT.** `tick` schedules its own successor, so the rAF chain in flight
  is a chain of ONE closure — the one built with the timeline current when it
  started. Rebuilding `tl` never reached it, so after a language change the new
  script's words arrived on the old script's cadence for the rest of the sequence,
  and the turn the reader was mid-way through never restarted.
  **THE FIX, ENTIRELY INSIDE `usePlayback.ts`.** One effect: when `tl` changes it
  re-anchors `elapsed` to the start of the turn the reader is in — the turn is the
  unit both languages agree on and the phrase boundaries inside it are precisely
  what they do not — and restarts the chain, **but only when `raf.current !== null`**.
  `state` would be the wrong guard: during the Replay crossfade the state is
  already `playing` while no chain has started, so `run()` there would leave the
  pending timer free to start a second, and two chains accumulating into one
  `elapsed` play the sequence at double speed. The straight-through and switch
  scenarios each assert that at most one rAF chain was ever in flight; it is 1 in
  all six.
  **RED BEFORE GREEN, ON PHRASE BOUNDARIES.** At `6be329f` the committed test
  reported `te 4 · en 0` and `en 4 · te 0` — every boundary after the switch
  within 0.5 ms of the OUTGOING timeline and ~2 s from the incoming one. After the
  fix: **`te 0 · en 7` and `en 0 · te 7`**, both directions, plus `te 0 · en 6`
  switching while PAUSED (nothing in flight to cancel, so a cancel-only fix would
  have left that broken) and `te 0 · en 3` under reduced motion.
  **CORROBORATED IN A REAL BROWSER.** The committed test drives a hand-rolled
  hooks runtime, which is the only way to make a timing assertion deterministic —
  so a CDP probe ran the same switch on both builds with real React, a real DOM,
  real rAF and real pointer presses, recording transitions in-page on rAF.
  Baseline `9RLMkXYOtJgLgKmNTs5bo`: `te 4 · en 0` / `en 4 · te 0`, d(stale)
  ≤ 11 ms. Fixed `0XdunxAf9NNu1meHzHdKY`: `te 0 · en 7` / `en 0 · te 7`,
  d(fixed) ≤ 21.3 ms, d(stale) ≥ 1357.9 ms. Under forced reduced motion turn 3 then
  holds the screen for **3711 ms** against English's full turn-3 duration of
  3686.67 ms, not Telugu's ~2017 ms remainder.
  **NOTHING ELSE MOVED.** `/` is **0 differing pixels** at 360/768/1440 under the
  build-id interlock, and so are the four static instances. The play control's
  `getBoundingClientRect().top` is still **10433.17 / 8931.17 / 8404.16**,
  identical across `en` and `te`, and switching at idle moves nothing but the
  language and the total. `/` first-load JS unchanged at **113 kB**; `/specimen`
  page chunk 4.68 → **4.77 kB**, first-load **107 kB** against the 140 kB budget.
  ⚠️ **RESIDUAL, NOT FIXED, NOT THE SAME DEFECT.** The Replay crossfade's pending
  `setTimeout` closes over its own `tl` and `run`, so a language switched during
  that 150 ms window leaves the restarted chain on the outgoing timeline until the
  next switch. It needs a two-click-in-150 ms sequence to reach and the effect
  above deliberately does not widen to cover it.
- **THE CONVERSATION HAS TWO LANGUAGES — HERO-1 phase 4, built** (`08120ad`).
  Four files new — `en.json`, `LanguageSelector.{tsx,module.css}` and
  `tests/design/conversationLanguages.test.js` — and three edited: `index.ts`
  (`LANGS` gains `en`, the runtime guards now run over every language rather than
  Telugu alone, and a new `LANGUAGES` export), `cadence.ts` (`en: 30`), and
  `/specimen`'s page. Node **1104 → 1105 / 180 / 0 fail**. No new dependency, no
  new token, no new font. `/` is **0 differing pixels** at 360/768/1440 under a
  build-id interlock, and so are the four static instances.
  ⚠️ The Python worker suite was **not re-run**; its **97** is carried forward,
  not verified. Nothing under `voice-agent/` is touched.
  **HINDI WAS CUT, AND THAT IS THE DECISION, NOT A SHORTFALL.** Its six turns need
  a native-speaker review that does not exist, and stilted Hindi under a claim of
  vernacular fluency is worse than no Hindi. `hi` stays in `LangCode` and stays
  out of both `LANGS` and `CPS`, so `getConversation("hi")` throws
  `conversation: no strings for "hi" — hi lands in phase 4b` and
  `buildTimeline(…, "hi")` throws `cadence: no CPS for "hi" — hi lands in phase
  4b`. Both were made to fire, the first through a real `next build`. No greyed
  third segment: a disabled option advertises an absence.
  **THE OPTION LIST IS DERIVED, NOT AUTHORED.** `LANGUAGES = Object.keys(LANGS)`,
  and the page builds its conversations map from the same list, so a segment
  cannot exist without strings behind it. "No option throws" is a property of the
  wiring rather than a rule anyone has to remember.
  **CPS en:30 IS TUNED TO TELUGU'S TOTAL, NOT TO ENGLISH.** 13,203 ms against
  Telugu's 13,207.5 ms — 4.17 ms apart, 0.03% — with identical phrase counts turn
  for turn (2/3/1/4/1/1). The two tracks walk at one pace, which is what makes
  switching mid-sequence coherent.
  **ZERO LAYOUT SHIFT BETWEEN LANGUAGES, AT NO TOLERANCE.** The play control's
  `getBoundingClientRect().top` is **10433.17 / 8931.17 / 8404.16** at
  360/768/1440 — identical for both languages, at idle and at `complete`. That
  holds because the region's height is a constant and the selector's is too.
  Positive-controlled: with `height: auto` on the region the two languages diverge
  by 8.63–12.94 px at idle and 38.82–97.28 px at complete, all six comparisons red.
  English's natural stack is **shorter** than Telugu's at every width
  (733/649/774 against 822/688/870), so nothing needed resizing.
  ✅ **SWITCHING MID-PLAYBACK LEFT THE CLOCK ON THE OUTGOING LANGUAGE — CLOSED at
  phase 4.1 (`89927c9`); the diagnosis is kept because it is how it was found.**
  `usePlayback.ts:81-96`: `tick` is `useCallback(…, [tl])` and schedules
  its own successor with `requestAnimationFrame(tick)`, so the running chain keeps
  the closure it started with. Changing `lang` rebuilds `tl` and updates
  `data-playback-total` (13207.5 → 13203.33, visible in the DOM) while the frames
  keep being derived from the OLD timeline. Measured, not inferred: after a switch
  at turn 3, **11 of 11 distinguishable transitions followed Telugu's phrase
  boundaries and 0 followed English's**, margins 137–371 ms. The totals are 4 ms
  apart and cannot discriminate; the phrase boundaries are hundreds of ms apart and
  can. This is a **phase-3 defect that phase 4 made reachable** — `lang` could not
  change before there was a selector — and the fix is in `usePlayback.ts`, which is
  outside phase 4's allowed files. It is also why "the current turn restarts" did
  not happen: the playhead IS preserved (playback resumed at **turn index 3**), but
  nothing rewinds `elapsed` to the new timeline's turn start. One effect that
  cancels the in-flight rAF and re-anchors `elapsed` on `tl` change delivers both
  — which is exactly what phase 4.1 shipped.
  **BUNDLE.** `/` first-load JS unchanged at **113 kB**. `/specimen` page chunk
  4.09 → **4.68 kB** (+0.59 kB, the selector), first-load **107 kB** against the
  140 kB budget.
  **A11Y, off the live DOM.** `role="radiogroup"` with an `aria-label`; one
  tabbable option (roving), proved by walking — 16 Tabs reach the group and the
  17th lands on the play control, not the other segment. Arrows traverse both
  directions with wrap-around, `Home`/`End` work, selection follows focus, each
  option carries its own `lang` so `తెలుగు` is not pronounced through an English
  voice. Focus ring measured at `2px solid rgb(23, 21, 15)` = `--ink-strong`.
  Contrast: worst text node **6.70:1** against a 4.5 floor, both languages × three
  widths × idle and complete; `--ink-faint` on **0** glyphs.
- **THE HERO CONVERSATION PLAYS — HERO-1 phase 3, built** (`d221c8f`).
  Nine files: `cadence.ts`, `usePlayback.ts`, `ConversationPlayer.tsx`,
  `PlayControl.{tsx,module.css}` new; `Conversation.{tsx,module.css}`,
  `te.json` and `/specimen`'s page edited. `activeIndex` walks **0 → 6 in
  13,207.5 ms**, measured off the running page, not computed on paper. Node
  **1104 / 180 / 1104 / 0 / 0 / 0 / 0 — UNMOVED**. No new dependency: `git diff
  web/package.json` is empty.
  ⚠️ The Python worker suite was **not re-run**; its **97** is carried forward,
  not verified. Nothing under `voice-agent/` is touched.
  **THE FIXTURE STAYED OUT OF THE BROWSER, DELIBERATELY THIS TIME.** Phase 2
  got that for free by being a server component. `ConversationPlayer.tsx` is
  the **only** file with `"use client"`, and it pulls `Conversation.tsx` into
  the client graph with it — so the card's data is narrowed at the boundary to
  `{ doctor, time, status }` and `public/demo/fixture.json` is read by the
  page, which is still a server component. `.next/static/` (45 files) greps
  **0 hits** for the appointment UUID, `Sravani Reddy`, `Smile Dental` and
  `2026-07-18`.
  ⚠️ **THAT GREP WAS POSITIVE-CONTROLLED, AND THE CONTROL FOUND SOMETHING.**
  Four needles known to be present were searched first, so a zero could not be
  a broken search: `Play the conversation` and `data-conversation-region` hit
  the `/specimen` chunk, `Prantivo` hits four files — and **`Dr. Rao` hits a
  client chunk**. It is not one of the four forbidden strings and it is not
  from this boundary: it is `HeroChat.tsx:31,43`, a pre-existing `"use client"`
  component on `/` carrying its own authored English translations. The
  `/specimen` client chunk contains none of the fixture strings, and `/` is
  pixel-identical, so nothing about it moved this phase. Worth knowing before
  phase 5 retires `HeroChat`.
  ✅ **CLOSED at HERO-1 phase 5 (`8d67d47`).** `HeroChat.tsx` is deleted and
  `Dr. Rao` now greps **0 hits** across all 45 files of `.next/static/`. The
  prediction was falsifiable and it held; the grep was re-run with five
  known-present needles first so the zero could not be a broken search.
  **CADENCE IS A MODEL, NOT EIGHTEEN NUMBERS.**
  `phraseDuration = max(MIN_PHRASE_MS, chars / CPS × 1000)`, plus **220 ms** of
  stillness after every turn including before the card. **CPS = 32** and
  **MIN_PHRASE_MS = 550** for Telugu, both in `cadence.ts` beside the language
  data so phase 4 adds two entries and nothing else moves. **Phase 4 added ONE**
  — Hindi was cut; see that entry. 450 ms was the
  brief's suggestion and was raised after measuring: at CPS 32 the sign-off
  `రేపు కలుద్దాం!` computes to 437 ms and `నమస్తే!` to 219 ms, so a greeting and a
  farewell — exactly what a floor is for — sat at or under it. 550 costs 319 ms
  over the whole sequence. **A turn's dwell is the sum of its phrase durations
  for patient turns too**; emergence decides how a turn's text arrives, not how
  long it stays, and without that split `అంతే, ధన్యవాదాలు.` would be on screen for
  one 150 ms fade.
  ⚠️ **t3 SEGMENTS INTO FOUR PHRASES, NOT THE THREE THE BRIEF PREDICTED.** The
  rule — split after `.` `!` `?` and after the em-dash in t3 — was applied as
  written and the result reported rather than the rule adjusted to fit. Per
  turn: **t0 → 2, t1 → 3, t2 → 1, t3 → 4, t4 → 1, t5 → 1** (nine spans over six
  turns). t3's em-dash clause `బుక్ అయింది —` is a fourth segment the prediction
  did not count. Offsets are stored in `te.json` as **end** offsets that
  partition the text losslessly; the round-trip is asserted at derivation time,
  and no turn's text bytes changed.
  **PAUSE FREEZES BECAUSE THERE IS ONLY ONE NUMBER.** `usePlayback` accumulates
  elapsed ms in a rAF loop and derives `(activeIndex, revealed)` from it with a
  pure function, so there is no cursor that can drift out of step with the
  clock. Demonstrated rather than asserted: paused at `idx=1 revealed=2` with a
  phrase **mid-fade**, still `idx=1 revealed=2` after 2,500 ms, and
  `idx=1 revealed=2` on the frame it resumed — no rewind, no settle, no jump.
  Replay dissolves rather than cuts, sampled at 30 ms intervals through the
  transition: opacity `1 → 0.211 → 0.018 →` swap `→ 0.957 → 0.998 → 1`.
  **PRESS FEEDBACK FIRES ON POINTER-DOWN, AND A SINGLE SAMPLE SAID OTHERWISE.**
  It is `:active` in CSS, not an `onClick` class toggle, so the browser sets it
  the instant the pointer goes down. Driven with real `Input.dispatchMouseEvent`
  presses: at **+16 ms** `:active=true` and `will-change=transform` while the
  transform is still `matrix(1,…)`; at +40/+70 ms `0.986464` / `0.985009`; at
  +300 ms settled at `0.985` with `will-change=auto`. `state=idle index=0`
  throughout, so the feedback provably precedes any click. ⚠️ A first pass read
  once at +160 ms, saw `will-change: auto`, and looked like proof the handler
  had never run — it is the "removed on settle" half working, because the 100 ms
  transform transition had already fired `transitionend`. **Only a sample inside
  the transition separates "never set" from "set and correctly cleared."**
  **REDUCED MOTION IS NOT REDUCED CONTENT.** Under
  `--force-prefers-reduced-motion=reduce` the sequence still walks 0 → 6 at all
  three widths with the same 13,207.5 ms timeline; all six turn transforms read
  **`none`** (recency scaling off), **0 of 9** phrase spans are hidden
  (per-phrase emergence off), the FLIP is skipped, and all six turns plus the
  card are present.
  ⚠️ **THE BRIEF'S "150 ms FADE" UNDER REDUCED MOTION IS NOT ACHIEVABLE AND WAS
  NOT ATTEMPTED.** `globals.css:369-375` applies `transition-duration` and
  `animation-duration` `0.01ms !important` to **every element on the site**;
  `globals.css` is NOT TOUCHED this phase, so every fade collapses to instant.
  That is the site-wide contract and this component does not fight it with a
  more specific `!important`. The substantive half of the requirement —
  phrases arriving per TURN rather than per phrase — is implemented in the hook.
  ⚠️ **THE REDUCED-MOTION LADDER IS SCOPED TO `.live`, AND IT HAS TO BE.**
  "No recency scaling" is applied only to the instance a client is playing.
  `prefers-reduced-motion` is a request about things that move, and the ladder
  on a static frame never moves — but the operative reason is that the phase-2
  pixel baseline is **captured under forced reduced motion**, so flattening the
  ladder globally would move every glyph in all four static instances and make
  G5 unsatisfiable by construction. A brief that demands both cannot have meant
  the global form.
  **GATES.** `/` at **0 differing pixels** at 360/768/1440, build-id interlocked
  (`IzBUe6QmGHTtk8R9FltH1` → `iB15ko_sT6AnIu55Feltv`), CSS hrefs unmoved, `/`
  unchanged at 7.42 kB / **113 kB** first-load JS. `/specimen` first-load JS
  **104 → 107 kB** against a 140 kB budget — the first client component in the
  tree, and the growth is 3 kB. Region height **296 / 340 / 376 px** and the
  play control's top **320 / 364 / 400 px**, both identical across all four
  states at all three widths. Contrast swept on the live DOM scoped to
  `[data-conversation-section]` in **idle, playing, paused and complete** ×
  three widths: **0 failures**, `--ink-faint` on **0** text nodes.
  ⚠️ **G5 DID NOT REACH 0 DIFFERING PIXELS, AND THE REASON IS THE PLATFORM.**
  Seven of the twelve static-instance crops are exactly 0; five differ by
  **85–175 px out of 118k–237k (≤0.08%)**, every one of them a warm colour
  fringe on a glyph edge. **Splitting a text run into inline spans is not
  pixel-free in Chrome**: each fragment is shaped separately and its origin
  quantised to a 1/64 px LayoutUnit, so a glyph after a boundary can land that
  far from where an unbroken run puts it, and LCD subpixel AA repaints the edge.
  This was **isolated, not inferred** — the same page, the same build, the same
  process, captured once as shipped and once after collapsing every paragraph
  back to a single text node reproduces the counts almost exactly
  (98/85/175/98/98/128 against 99/91/175/98/98/128). Nothing else contributes.
  **WHAT G5 EXISTS TO CATCH WAS MEASURED DIRECTLY AND IS CLEAN.** "It must not
  change layout": 276 measurements compared across twelve instances — identical
  line **count**, identical line **x**, **y** and **height**, **zero** gaps
  between fragments on any line, and identical region, turn, paragraph and card
  boxes. Only line *widths* move, by **≤0.02 px**, which is the arithmetic of
  summing two quantised fragments instead of measuring one. A single-phrase turn
  now renders **no span at all** — its one phrase is revealed the instant the
  turn activates, so the element could never do anything — which is why t2, t4
  and t5 are byte-identical to phase 2.
  ⚠️ **THE FIRST G5 RUN REPORTED TENS OF THOUSANDS OF DIFFERING PIXELS AND
  MEASURED ALMOST NOTHING.** The clip is in document coordinates and gets
  floored, so it samples on a grid whose phase is `frac(rect.y)`. Adding a fifth
  instance moves the four above it by a fractional CSS pixel, every glyph lands
  on a different subpixel offset, and identical text repaints — the first
  differing pixel was `rgb(250,232,196)`, a yellow fringe, on a palette with no
  yellow in it. **A crop-based pixel gate must phase-align its target first**,
  here with `position: relative` + `top`/`left`, which reflows nothing. ⚠️ And
  the nudge must be **iterative and full-precision**: Chrome stores used offsets
  as 1/64 px LayoutUnits and **floors** to them, so a nudge rounded to three
  decimals landed `0.531px` on 33/64 instead of 34/64 and left the origin at
  `9449.984375`.
  **NOT TOUCHED, and checked rather than assumed:** `Hero.tsx`, `HeroChat.tsx`,
  `Hero.module.css`, `(marketing)/page.tsx`, `globals.css`, `en.json`,
  `hi.json`, `meta.json`, `types.ts` (`phrases?: number[]` was already declared
  in phase 1 and needed no change), `brand-values.md`, the four `(legal)` pages,
  `public/**`, `src/`, `voice-agent/` and `scripts/`. `specimen.module.css` is
  **also** unchanged — the fifth instance reuses the existing `conv*` classes
  and two inline style props, which is why the file count is nine and not ten.
- **THE HERO CONVERSATION HAS A RENDERER — HERO-1 phase 2, built** (`a047378`).
  Four files: `web/components/sections/conversation/Conversation.{tsx,module.css}`
  new, `/specimen`'s page and stylesheet extended. Phase 1's data (`5f74598`) is
  consumed unedited. Node **1104 / 180 / 1104 / 0 / 0 / 0 / 0 — UNMOVED**,
  measured before and after at this commit. No new dependency: `git diff
  web/package.json` and `web/package-lock.json` are both empty.
  ⚠️ The Python worker suite was **not re-run**; its **97** is carried forward,
  not verified. Nothing under `voice-agent/` is touched.
  **IT IS A SERVER COMPONENT, AND THAT IS THE POINT.** `<Conversation turns
  activeIndex />` has no `"use client"`, no hook and no timer — "stateless" is
  structural here rather than promised, and the browser receives HTML. Two
  consequences worth knowing before phase 3: `/specimen`'s first-load JS did
  **not** move (104 kB; only its page size did, 1.07 → 1.43 kB), and
  `public/demo/fixture.json` never enters a client chunk — grepping
  `.next/static/` for `Sravani Reddy`, the dev tenant name and the appointment
  UUID returns nothing, so the synthetic and dev-tenant fields the card
  deliberately does not render are not shipped either. **Phase 3 will have to
  add a client boundary** to drive `activeIndex` over time, and that flip is
  what will put this module into a route chunk for the first time.
  **THE CARD IS THE TERMINAL VALUE OF `activeIndex`, NOT A SECOND PROP.**
  `activeIndex === turns.length` (6) is the only state that renders the
  confirmation record; `0 … 5` render turns `0…activeIndex` and nothing after.
  A `showCard` boolean would let a caller express states the thread cannot
  reach — a record at turn 2, a last turn with no record — so phase 3 has
  exactly one scalar to walk, `0 → 6`.
  **THE REGION IS BOTTOM-ANCHORED, NOT SCROLLED.** Fixed height,
  `justify-content: flex-end`, `overflow: hidden`; content overflows *upward*
  and clips. No JS, no scroll container, DOM order preserved for a screen
  reader, and turns that leave view stay in the DOM. Measured at
  **296 / 340 / 376 px** (<768 / ≥768 / ≥1180) and **identical across all four
  `activeIndex` values at all three widths** — the region does not grow with
  content, so nothing below it shifts as turns arrive.
  ⚠️ **`scrollHeight === clientHeight` on that region even when content
  overflows**, at every instance. Overflow past the *start* edge of a flex
  column is not counted by `scrollHeight`, so that pair is **not** evidence of
  clipping and must not be used as one; the evidence is the captures in
  `scratchpad/hero1p2-review/`, where the top turn is visibly cut mid-line.
  **RECENCY IS 1.000 / 0.955 / 0.930, FLOORED**, `transform-origin: left
  center`. The floor is load-bearing: without it six turns compound to ~0.70 and
  the thread ends unreadable at the top. Colour carries **one** step and only
  for Prantivo — an *active patient* turn stays `--ink-soft`, so at
  `activeIndex = 2` nothing on screen is `--ink-strong`, which is correct and
  looks like an omission if you do not know the rule. `--ink-faint` paints no
  glyph at any recency position (D-016), verified on the live DOM: 0 of 15
  distinct colour/backdrop pairs in the section, worst 6.70:1 against a floor
  of 4.5.
  ⚠️ **A CONTRAST SWEEP OF THE WHOLE `/specimen` PAGE WILL ALWAYS REPORT ONE
  FAILURE, AND IT IS NOT A DEFECT.** `.faintBad` (2.21:1, `#A8A199` on
  `--ground-sunk`) is Phase 1b's *deliberate* demonstration of the wrong
  colour, labelled `--ink-faint · 2.21:1 on sunk · WRONG` on the page itself.
  It is pre-existing and untouched. Scope a `/specimen` gate to
  `[data-conversation-section]` or it fails on a paragraph whose job is to fail.
  ⚠️ **`transform: scale()` DOES NOT MOVE COMPUTED `font-size`.** A probe that
  dedups text nodes on computed size cannot see that a floored turn rasterises
  at 0.930 — 23px reads as 21.39px at 1440. WCAG's large-text threshold is about
  rendered size, so the phase 2 sweep multiplies the ancestor scales itself.
  Same shape as the ancestor-*opacity* accumulation S2 needed, and for the same
  reason: the composited result is in no single element's computed style.
  **THE CARD SAYS "booked", NOT "confirmed", AND MUST NOT BE "FIXED".** The
  phase 2 brief graded the word *confirmed* REAL and attributed it to
  `fixture.appointment.status`; that field holds **`"booked"`**. Rendering
  *confirmed* while citing the field would be a provenance claim with nothing
  behind it — the exact failure the read-from-fixture rule exists to prevent —
  and *booked* also reads truer against t3, `బుక్ అయింది`. `doctor_name`
  (`Dr. Rao`) and `time` (`09:00`, rendered `9:00 AM` by pure string arithmetic,
  never `Date`/`Intl`, so the build machine's zone cannot reach it) come from
  the same block. `Tomorrow` is AUTHORED. `date` is **deliberately not
  rendered**: it is `2026-07-18`, four weeks stale, and "Saturday, 18 July"
  beside a thread saying *tomorrow* is incoherent — the incoherence is the
  data's age, not the copy's.
  **GATES.** `/` at **0 differing pixels** at 360/768/1440 (raw RGBA, build-id
  interlocked `XOO2GYNJO-3rJgzo1aFAV` → `UqOF5VfVnHesQbcV9wpzK`), with `/`'s
  three CSS hrefs **unmoved** — the new stylesheet is a CSS module only
  `/specimen` imports, so `/`'s chunks had no reason to move and did not.
  `/` unchanged at 7.42 kB / 113 kB first-load JS. No horizontal overflow at 360
  on **12 named elements** per width (`scrollWidth === clientWidth`, each
  printed with its tag and resolved class — an earlier session shipped a check
  that compared `undefined` to `undefined` and printed ok). Telugu resolves to
  **Noto Sans Telugu** with no tofu, proven by canvas width against the same
  string set in U+E000 rather than by reading the family name, which a stack
  whose face never loaded would also report.
  ⚠️ **`letter-spacing: 0` SERIALISES AS `normal`** in Chrome's computed style,
  so a probe asserting the literal string `0px` on the Telugu rule reads a false
  negative. The rule demonstrably applies — the same node reports Noto Sans
  Telugu and the Telugu clamp's floor of 18px, neither of which the base `.text`
  would give it.
  ⚠️ **A REVIEW HARNESS MUST RE-MEASURE BEFORE EVERY SHOT.** The first pass
  measured all five clip rects up front and then took five screenshots;
  the first two landed and the rest were offset by roughly two instance heights
  — the capture labelled `i2` photographed the tail of `i5`.
  `captureBeyondViewport` resizes the viewport to the content box and does not
  restore the scroll offset, so a document-coordinate clip is stale by the third
  shot. The harness now scrolls to origin, measures, captures, re-measures, and
  **throws** if the rect moved: a mislabelled capture is worse than no capture,
  because it looks like a review.
  **NOT TOUCHED, and checked rather than assumed:** `Hero.tsx`, `HeroChat.tsx`
  and `Hero.module.css` still render `/` unchanged; `globals.css`,
  `brand-values.md`, the four `(legal)` pages, `public/**`, `src/`,
  `voice-agent/`, `scripts/` (bar the gitignored `scripts/out/` the brief itself
  writes to) and phase 1's `types.ts`/`index.ts`/`meta.json`/`te.json` are
  byte-unchanged. `/specimen` keeps `robots: noindex, nofollow` (read off the
  built HTML **and** the live DOM), is absent from the built `sitemap.xml`
  (5 URLs, none of them it), and `a[href*="specimen"]` counts **0** on the live
  page — which includes Nav and Footer, since `/specimen` sits inside the
  `(marketing)` group.
  ⚠️ **A PRE-EXISTING STALE LINE ON `/specimen`, left alone:** its footer still
  reads "Consumers on shipping routes: zero", which Phase 2 S2 falsified when
  the whole site took the paper layer. Phase 2's brief forbids disturbing the
  token specimen, so it is recorded here rather than edited.
- **THE WHOLE SITE RENDERS WARM PAPER — Phase 2 S2, built** (`c47cd98`).
  `body` takes `--ground`. Every route in `web/` — `/`, `/specimen` and the four
  legal pages — is on the paper layer. The change is **atomic by construction**:
  every section in `web/` is transparent and inherits `body`, so there is no
  coherent intermediate state and no half-flipped site to review. Eighteen files.
  Node **1103 tests / 180 suites / 1103 pass / 0 fail / 0 cancelled / 0 skipped /
  0 todo — UNMOVED**, measured at this commit.
  ⚠️ The Python worker suite was **not re-run** and its **97** is carried
  forward, not verified. Nothing under `voice-agent/` is touched, so it is
  unmoved by construction — an argument, not a measurement.
  **THE MECHANISM IS ALIASES, NOT COPIED HEXES.** No paper hex was written into
  a dark token name. Nine tokens now point at the paper layer, which stays the
  single source of the values:
  `--ink-900`→`--ground`, `--surface-1`→`--ground-raised`,
  `--surface-2`/`--surface-3`→`--ground-sunk`, `--border`→`--rule`,
  `--border-strong`→`--rule-strong`, `--text-primary`→`--ink-strong`,
  `--text-secondary`/`--text-tertiary`→`--ink-soft`. Forward references are
  legal — custom properties substitute at computed-value time — so the alias
  block sits where the dark hexes sat and reads down to the paper block below
  it. Consequence, and the reason for the shape: the **166** declaration-level
  references to those nine tokens, across **fourteen** component stylesheets,
  **did not move** — counted with comments stripped rather than estimated
  (`--text-tertiary` 41, `--border` 37, `--text-secondary` 35, `--text-primary`
  21, `--border-strong` 14, `--surface-1` 9, `--ink-900` 4, `--surface-3` 3,
  `--surface-2` 2). So this is a colour change and not a rename, and S3 (delete
  the aliases, rename the consumers) can be gated on **pixel equality** — which
  S2 gives up and S3 gets back.
  **THE MAPPING IS BY ROLE, NOT BY NUMBER, AND ONE CONSUMER BROKE THE RULE.**
  `--surface-3` had three consumers that agreed on a dark ground and split on
  paper: `Why .mpPillSolid` and `Why .toggle` pair it with `--text-primary`,
  which the alias flips to ink, so both need a LIGHT fill; `HowItWorks
  .mvPillYou` pairs it with `--wa-text` (`#E9EDEF`), which does **not** flip
  because `--wa-*` survives S2 untouched. Near-white on `--ground-sunk` is
  1.06:1 — the "YOU" label would have vanished. So `--surface-3` takes
  `--ground-sunk` for the two, and `.mvPillYou` names `--ink-strong` directly
  (15.49:1 under `#E9EDEF`). This is the only alias a consumer could not follow.
  **F-F008 IS CLOSED.** `--accent` is `#0f766e`, the portal's value, and the
  `--accent` @ `web` divergence row is **deleted from `brand-values.md` in the
  same commit** — `tokenDrift` asserts a recorded divergence as strictly as a
  canonical value, so leaving the row would have failed the suite. `--accent-glow`
  is re-derived to `rgba(15, 118, 110, 0.35)` rather than left: it was never an
  independent colour (every design-reference file defines it as `--accent` at
  0.35 alpha), and moving one without the other would have left a `#14b8a6` halo
  around four `#0f766e` dots — the same silent hue split F-F008 names, one
  indirection deeper.
  ⚠️ **PIXEL EQUALITY IS GONE AS A GATE AND CANNOT COME BACK THIS SESSION.**
  S1 had `/` as a control arm at 0 differing pixels; S2 repaints every route, so
  there is nothing to hold still. What replaced it was measured on the live DOM
  at **six routes × three widths = 18 pairs**: `body` is `rgb(250, 248, 245)` on
  all eighteen, the alias layer resolves identically on all eighteen, and the
  contrast sweep covered **532 distinct colour/backdrop pairs** at
  **0 failures** — text, focus indicators and both translucent bars.
  `--ink-faint` paints no text node anywhere except `/specimen .faintBad`, which
  exists to render the prohibition and is exempted by name below. (Commit
  `c47cd98`'s message states that gate as "paints no text node on any shipping
  surface", which is the summary line; the exemption is named five lines under
  it. This sentence is the exact form.)
  ⚠️ **THE BUILD-ID INTERLOCK CHANGED SHAPE, AND S1'S ROOT CAUSE IS FIXED.**
  With no before/after pair to protect, comparing two runs proves nothing. The
  probe and the capture now each compare the id read **off the live page**
  against `.next/BUILD_ID` **on disk** — the build `npm run build` just made —
  which catches a stale server on a *single* run. S1 recorded that `taskkill` is
  not on PATH here; that was the mechanism, because `execFileSync('taskkill',…)`
  threw ENOENT every time and fell through to `server.kill()`. It is now invoked
  as `C:/Windows/System32/taskkill.exe`, and both ends are asserted: the port
  must be free **before** the server is spawned and free again **after** it is
  reaped, or the run fails loudly. It passed on all eight harness runs this
  session, spanning four builds — `weFtGLedeOdSxESfE9cmQ`,
  `d02dJ3QzHwkjWsPj4SqlQ`, `l5WpLFW56qhtEjPISloSV` and `d_vGR70QWue55Qwg5MyJv`.
  The gated numbers and the review captures in `scratchpad/s2-review/` are from
  the last of those, which is the committed tree.
  ⚠️ **THE SWEEP FOUND A REGRESSION THE BRIEF DID NOT ANTICIPATE, IN A FILE THE
  BRIEF DID NOT NAME.** `Problem .enq` carries `opacity: .62`, which composites
  its whole subtree — text included — **toward the page**. On the near-black
  ground that pulled the copy toward black and landed at **3.57:1**, already
  below AA and predating this session. On paper it pulls toward white:
  **3.06:1**. Same declaration, worse result, caused by the flip. Raised to
  `.82`, which is the measured floor plus margin and not a guess — `.78` gives
  4.42:1 and still fails, `.80` gives 4.64:1, `.82` gives **4.88:1**, and `1`
  would give 7.75:1 while deleting the point of the section (the cards are drawn
  faded because they are the enquiries nobody answered). All four dimmed strings
  share the colour, so one value fixes `.enqTime`, `.enqTag`, `.enqMsg` and
  `.enqFoot`. The 480px breakpoint already set `opacity: 1` and is untouched.
  **TWO SWEEP FINDINGS ARE EXEMPT, NAMED IN THE HARNESS AND STILL PRINTED.**
  (1) `/specimen .faintBad` at 2.21:1 is a **labelled counter-example** — the
  element renders the string `--ink-faint · 2.21:1 on sunk · WRONG` beside a
  `CORRECT` twin, to teach the NON-TEXT ONLY contract. (2) `--wa-meta` on
  `--wa-out` at **2.61:1** is the timestamp inside an outgoing bubble of the hero
  mockup; both tokens are `--wa-*`, `Hero.module.css` is unmodified in this
  commit, so the pair is byte-identical to HEAD, and `globals.css` already
  records it at the `--wa-gloss` declaration. Pre-existing, fenced, **an S4
  decision**. Neither is suppressed by narrowing a selector; both are printed
  with the reason attached.
  **FOUR ACCENT HAIRLINES DELETED, NOT RE-DERIVED — INCLUDING S1'S.**
  `linear-gradient(90deg, transparent, var(--accent), transparent)` across a
  card's top edge is a dark-ground device; on paper a hairline reads by being
  darker than its ground, and darkness does not fade to "transparent". S1
  replaced its one instance with a plain `--rule` and flagged the result as
  redundant under the card's own border. Checked per site, as the brief
  requires: `Platform .base`, `FinalCta .frame` and `Pricing .quote` each
  declare `border: 1px solid var(--border-strong)`, so all three are the same
  case. All four removed, S1's `.stepsCard::before` included.
  ⚠️ **THE BRIEF'S FIFTH HAIRLINE WAS NOT ONE.** `HowItWorks .mvScan` is
  `accent → transparent`, 2px tall and 70% wide, *inside* the micro-visual as
  the AI reading the message — content, not chrome. It survives the flip on its
  own terms: at 0.7 over `--ground` the repointed `#0f766e` composites to
  `rgb(86, 157, 151)`, plainly visible. Replacing it with a `--rule` hairline
  would have left a 1.18:1 smear and deleted the only thing that panel depicts.
  **THREE ZERO-CONSUMER TOKENS DELETED RATHER THAN ALIASED:** `--ink-850`,
  `--accent-hover` (`#2DD4BF`) and `--elev-1`. Choosing a paper value for
  something nothing renders is inventing a colour under cover of a migration.
  `--elev-2` **is** re-derived, because it has three: `rgba(0, 0, 0, 0.45)`
  measured 1.03:1 on the dark ground (invisible, which is why nobody noticed it
  was black at 45%) and **3.33:1** on paper (a grey smudge). Now
  `rgba(23, 21, 15, 0.06)` → 1.13:1. Geometry unchanged; only the colour was wrong.
  **ONE FOCUS INDICATOR FOR THE WHOLE SITE.** The remaining eight sites — five
  on the `0 0 0 2px var(--ink-900), 0 0 0 4px var(--accent)` idiom and three on
  the `0 0 0 3px var(--accent-glow)` idiom — converge on S1's pair,
  `0 0 0 2px var(--ground), 0 0 0 4px var(--ink-strong)`. All eight measure
  **17.22:1** outer-vs-backdrop on the live DOM. The glow ring composited to
  1.36:1 on paper and failed SC 1.4.11 outright; it was already failing at
  1.89:1 on the dark ground, so the flip surfaces that defect rather than
  introducing it.
  ⚠️ **HERO'S FOUR-LINE BUDGET WAS NOT SPENT, DELIBERATELY.** The brief allotted
  `Hero.module.css` lines 55, 73, 109 and 277. Under the aliasing the same brief
  mandates, all four already resolve correctly — 55/73/277 to `--ink-soft`
  (7.31:1) and 109 to the re-derived `--elev-2` — so editing them would have
  half-converted one stylesheet while thirteen others stay aliased, for no
  rendered difference. `Hero.module.css` is **unmodified**. Verified on the live
  DOM, not argued: `.sub`, `.heroMicro` and `.waCaption` all pass, and the
  phone card casts the paper shadow.
  **THE AVATAR CHIPS ARE LEFT DARK, ON PURPOSE.** Three
  `linear-gradient(135deg, #2A3942, #3B4A54)` and two `#8FA3AD` initials.
  `#2A3942` is 11.24:1 against `--ground` and `#8FA3AD` on it is 4.55:1, so both
  pass where they sit; two of the three are inside a `--wa-header` pill that
  stays dark by S2's rule. Whether the mockups move to WhatsApp's light theme is
  an **S4** call that takes the `--wa-*` tokens with it.
  **`color-scheme: light` IS NOW DECLARED**, on `:root`, where `web/` had never
  declared it at all. It selects the UA rendering of form controls, scrollbars
  and the default focus ring — which is load-bearing for one control: `Nav
  .brand` and `Footer .brand` declare **no** author `:focus-visible` rule and
  therefore fall to the UA outline, measured on the live DOM as
  `auto 1px rgb(16, 16, 16) offset 1px`. Indicated, at high contrast, but by a
  different mechanism from their eight siblings. **Filed as residue, not fixed.**
  ⚠️ **`/specimen`'s OWN COPY HAD TO BE CORRECTED — IT CONTRADICTED ITS OWN
  RENDERING.** The lede read "this page is their only reader, which is why the
  navigation above and the footer below are still painted from the old dark
  system", which was **true before this commit and false after it**, in the same
  viewport as the paper nav. Likewise `tokens.ts`'s `--accent-on-ground` note,
  which described `--ink-900` as near-black and `--accent` as a different hex.
  Both corrected. The dormancy claim was already stale from S1 and is now
  written as history rather than as fact. Note `--accent-on-ground` and
  `--accent` now hold the **same value**; merging them is an S3 job.
  **G10, the bundle interlock: `/` is 7.42 kB / 113 kB First Load JS before and
  after**, unchanged, as a colour change must be. Any movement would have meant
  something structural changed.
  **RESIDUES CARRIED TO S3/S4**, each measured, none blocking:
  (a) the legal group's `.paper` wrapper now repeats a ground `body` already
  paints — benign (same value, witnessed) and kept so the group can still be
  lifted out of this app; (b) `--r-*` (4/8/12) still serves marketing while the
  legal group and `/specimen` use `--rad-*` (2/6/10), so focus corners differ by
  2px between route groups until S3 migrates them — the three `--r-*` divergence
  rows in `brand-values.md` stay until then, by the brief; (c) `Platform .mod`
  is `--ground-raised` at rest and now darkens two steps on hover instead of
  lightening one — the right direction on paper, but a firmer hover than the
  dark original; (d) `Footer .social:focus-visible` was converted but has **zero
  DOM consumers** — `Footer.tsx` renders no socials, so the `.social`/`.socials`
  rules are dead CSS from the design reference.
- **THE LEGAL ROUTE GROUP RENDERS WARM PAPER — Phase 2 S1, built** (`c7bcecf`).
  `/privacy`, `/terms`, `/data-deletion` and `/acceptable-use` are the first
  shipping consumers of the Phase 1b token layer. Three files:
  `web/app/globals.css` (one added token), `web/app/(legal)/layout.tsx` (the
  ground wrapper) and `web/app/(legal)/legal.module.css`. Node
  **1103 / 180 / 0 / 0 / 0 — UNMOVED**, measured at this commit.
  ⚠️ The Python worker suite was **not re-run** this session and its **97** is
  carried forward, not verified. S1 touches three files under `web/` and
  nothing under `voice-agent/`, so it is unmoved by construction — but that is
  an argument, not a measurement, and the distinction is the point of this file.
  **`body` IS UNTOUCHED, AND THAT IS THE POINT.**
  `body { background: var(--ink-900) }` is shared with the still-dark marketing
  group, so the ground comes from a wrapper inside the route group instead.
  Witnessed on the live DOM rather than asserted from source: on all four legal
  routes `body` is still `rgb(11, 12, 14)` and the wrapper is
  `rgb(250, 248, 245)`; on `/` `body` is still `rgb(11, 12, 14)`.
  ⚠️ **THE CONTROL ARM'S PASS CONDITION IS THE ONE A STALE SERVER CAN FAKE, SO
  THE DIFF REFUSES RATHER THAN REPORTS.** `/` at **0 differing pixels** across
  360/768/1440 is exactly the result a surviving `next start` serving the
  pre-change build would produce — 15/15 identical, confirming the conclusion
  the session wanted. Both capture runs therefore record the Next build id read
  **off the live page**, and the diff exits 2 when they match. Reading
  `.next/BUILD_ID` would have described the build in the working tree, not the
  one the process under test was serving, which is the whole failure mode. The
  hazard is real and was observed: the harness reaps `next start` with
  `taskkill`, **which is not on PATH in this environment**, so the fallback
  `server.kill()` ran and one server survived a run. Runs compared:
  `mmX2KZYhpG8S3YnSu1z0P` → `RJ8A3hxAS5PqeY_87SCEB`.
  ⚠️ **THE BUILD ID IS NOT WHERE THE BRIEF SAID IT WAS.** `/_next/static/<id>/`
  is a pages-router artefact; this app is app-router and its HTML carries no
  such href (checked against `.next/server/app/privacy.html` — the only
  `/_next/static/` prefixes are `chunks/` and `css/`). The id is on the page in
  the RSC flight payload as `"b":"<id>"`, and is cross-checked against the
  stylesheet hrefs, which are content hashes.
  **CONTRAST WAS MEASURED FROM THE LIVE DOM ON BOTH SIDES, NOT ASSERTED.**
  Every text colour and every focus indicator against its actual composited
  backdrop, before and after: **5–6 failures per route → 0**. The pre-existing
  failures the flip closes are `--text-tertiary` at **3.89:1** on its four
  consumers here, the `--accent-glow` focus ring at **1.89:1**, and the `.ph`
  chip at **4.15:1** on the page ground and **3.87:1** inside a `.callout`
  (its fill was translucent, so its ratio varied with what was behind it; the
  paper chip is opaque and is a flat 4.74:1 everywhere).
  ⚠️ **A PROBE THAT READS A FOCUS RING TOO EAGERLY MEASURES THE WRONG THING.**
  The first sweep scored `.brand`'s ring **1:1 FAIL** on every route. It was an
  artefact: under `--force-prefers-reduced-motion=reduce` the reduced-motion
  block sets `transition-duration: 0.01ms !important` on `*`, and
  `transition-property` defaults to `all`, so `box-shadow` transitions on every
  element that does **not** declare its own `transition` shorthand. `.back`,
  `.toc a`, `.legalLinks a` and `.content a` all declare one and reset the
  property list; `.brand` declares none and was read at the interpolation
  start, `rgba(0,0,0,0) 0px 0px 0px 0px` twice over. The ring must be allowed
  to settle after `CSS.forcePseudoState` before it is read.
  **--rule-strong NEEDS NO `brand-values.md` ROW, AND THAT WAS VERIFIED WITH
  THAT FILE'S OWN PARSER.** `tokenDrift` demands a canonical row only for
  tokens declared by more than one of its four surfaces, and would flag a row
  for a single-surface token as **stale**. Checked by running its `rootBlock` +
  `declarations` functions verbatim against all four: `--rule-strong` is
  declared by `web` alone. `web/app/globals.css` parses at **58** custom
  properties, one more than before, and its first column-zero `}` is still
  `:root`'s own closing brace.
  ⚠️ **THE 24 PLACEHOLDERS WERE RESTYLED, NOT FILLED — F-F003 IS UNCHANGED.**
  `git diff` on the four `(legal)/*/page.tsx` is empty; the count is still
  2 + 5 + 10 + 7. They remain blocked on **C-1**, and a session that supplies a
  legal entity name has invented one.
  ⚠️ **KNOWN RESIDUE, ACCEPTED.** `body` still paints the overscroll
  rubber-band area, so a paper page inside a dark body flashes near-black on
  overscroll in iOS and macOS. Fixing it means touching `body` or `html`, which
  is the atomic change S1 exists to avoid; it goes away at S2. Second residue:
  `.stepsCard::before` is now a `--rule` hairline sitting directly under the
  card's own `--rule-strong` top border, so it carries no information —
  cosmetic, flagged for S2 rather than solved by inventing a paper accent
  hairline S1 had no mandate to design.
  **--accent is NOT repointed and F-F008 stays open.** It remains `#14b8a6` for
  the marketing group; `legal.module.css` uses `--accent-on-ground` instead.
  F-F008 closes at S2, when the ground flips under it.
  **SUPERSEDED at S2** — it did. See the S2 entry above: `--accent` is
  `#0f766e`, the divergence row is deleted from `brand-values.md`, and every
  other statement in this entry that begins "at S2" has been discharged.
- **THE TAMPERED-HASH TEST NOW ASSERTS THAT IT TAMPERED — Issue 40, built and
  CLOSED** (`0eb67d2`). `tests/portal/auth.unit.test.js:43` flips the FIRST
  character of the hash segment — the character it inspects — and asserts the
  segment changed before asserting `verifyPassword` returns false. Node
  **1103 / 180 suites / 0 fail / 0 cancelled / 0 skipped — UNMOVED**; Python
  unmoved at **72**. No test was added, and that is the shape of the fix: one
  corrected index and one assertion inside a test that already existed.
  **THE DIAGNOSIS WAS ALREADY WRITTEN DOWN AND IT HELD.** The V1a-R1 entry above
  had the mechanism exactly right; this session's Phase 0 reproduced it by
  construction rather than by waiting. Measured at HEAD: the segment is 88 chars
  and its last character is `=` in **200 of 200** draws, so the
  `=== 'A' ? 'B' : 'A'` guard never selected `B` and every flip wrote a literal
  `A`; the first character is `A` in **978 of 64,000** draws — **1 in 65.4**,
  against 1 in 64 for a uniform 64-symbol alphabet; and hashing until a segment
  began with `A` (10 draws) then running lines 48-51 verbatim gave
  `flip[5] === last → true` and `verifyPassword(…) → true`
  (`scratchpad/issue40/logs/01-reproduce.log`).
  ⚠️ **THE FAILURE DIRECTION IS A FALSE RED, NOT A FALSE GREEN, AND THAT CHANGES
  WHAT THE FIX CAN CLAIM.** In the trigger case the old test *failed* — it
  asserted `false` and got `true`. So there is no mutation under which the old
  assertion passes and the new one reds: the pre-fix test could not pass
  vacuously, it could only **fail vacuously**, at the wrong line, naming
  `verifyPassword` and implicating a module that was behaving correctly on a
  string it had every reason to accept, since the string handed to it was
  byte-identical to the one it had just produced. What the new assertion buys is
  therefore **attribution and an asserted precondition**, not a pass→fail
  conversion: the tamper is now checked rather than assumed, so a run that did
  not tamper can no longer be counted as coverage of the case the test is named
  for. That is worth stating plainly because the issue was written expecting the
  other direction.
  ⚠️ **THE OBVIOUS FIX — THE ONE THIS FILE ITSELF PROPOSED — IS WRONG, AND IT
  WOULD HAVE PASSED THE ANTI-VACUITY ASSERTION.** Flipping the literal last
  character tampers with base64 **padding**: `…hA==` → `…hA=A` is a different
  string that decodes to the **same 64 bytes**, so `verifyPassword` returns
  `true` and the test reds on **every** run. A guard comparing strings sees a
  difference and says nothing. The tamper has to land on a DATA character, which
  is why the fix moved the inspection to index 0 rather than moving the write to
  the end. Measured in `01-reproduce.log` §E and reproduced inside the suite as
  mutation M4 — the anti-vacuity assertion passes, and the line after it reds.
  **Red-checked by execution, four mutations, each verified APPLIED by grep
  before its run**, each reddening only what it should. **M1** (old flip logic +
  a forced `A` segment, guard present) reds **only** the tampered-hash test, at
  the guard, with `error: 'the tamper must actually change the hash segment'` and
  `expected`/`actual` printed **identical**. **M2** (the same, guard removed —
  the pre-fix test verbatim) reds the same test at `verifyPassword` instead,
  `expected: false / actual: true`: the flake exactly as it presented, blaming
  the innocent module. **M3** (the forced trigger alone, against the fixed flip)
  stays **green 6/6** — the diagnostic that M1's and M2's red comes from the flip
  logic and not from the forcing. **M4** is the padding trap above.
  **DETERMINISM — 200 CONSECUTIVE RUNS GREEN, AND THE SAME 200 AGAINST THE
  PRE-FIX FILE AS A CONTROL.** Fixed suite: **200 green / 0 red of 200**. The
  pre-fix file, extracted from `3714105` and run the same 200 times from a
  scratch path — `scratchpad/issue40/` sits exactly two directories below the
  root as `tests/portal/` does, so `require('../../src/portal/auth')` resolves to
  the same module without editing a line of it — **197 green / 3 red**, the reds
  at runs **36, 101 and 105**, each `not ok 5 - a tampered stored string fails
  closed` with `expected: false / actual: true`. Predicted reds at 1-in-64:
  **3.125**. Observed: **3**.
  ⚠️ **200 IS ENOUGH, BARELY, AND ONLY BECAUSE THE CONTROL ARM RAN TOO.** A green
  200 on its own is a **95.7%** instrument, not a proof: `(63/64)^200 = 0.043`,
  so a test carrying this defect survives 200 runs unscathed about **1 time in
  23**. 99% would need **293** runs and 99.9% **439**. So the green arm alone
  establishes the fix at roughly 23:1 and no better, which is a real check rather
  than a smoke test but is not the whole of it. What closes the gap is the
  control: the same harness, the same machine, the same 200 runs, reddening three
  times on the pre-fix file — the sweep is *demonstrably* capable of exposing
  this defect at this run count, rather than assumed to be. **Quote the power,
  not the run count**, and run the pre-fix arm whenever a flake fix claims
  determinism from repetition.
  **THE SWEEP FOR A SECOND SITE FOUND NONE, AND THE SWEEP IS WIDER THAN THE
  IDIOM.** V1c and Issue 39 each found a defective guard duplicated elsewhere, so
  five patterns were run across `tests/` (`scratchpad/issue40/logs/02-flip-sites.log`):
  the two-way character ternary — **one hit, this test**; `.length - 1` indexing
  — 3 other hits, all plain reads of a last element (`bookingRules:160`,
  `traces:502`) or a comment quoting Express (`serverListen:13`); head/tail slice
  reassembly — **one hit, this test**; byte-level buffer flips — 3 hits, all PRNG
  mixing or a probe vector; and everything self-described as tampering — whose
  only other genuine site is `tests/webhook/signature.test.js:93`, which tampers
  by building a **literally different JSON body** (`{amount:100}` →
  `{amount:999}`), statically distinct and incapable of being a no-op. **Nothing
  else was changed**, per scope.
- **HINDI REPLIES SEGMENT INCREMENTALLY NOW — Issue 41 (V1b), built and CLOSED**
  (`5ba2560`). `BrainAgent.tts_node` installs a sentence tokenizer whose
  terminator set is `[.!?。！？।॥]` and delegates to `Agent.default.tts_node`.
  Node **1103 / 180 / 0 / 0 / 0 — UNMOVED** (worker-only); Python **72 → 97**
  (`tests/test_danda_tokenizer.py` 15, `tests/test_tts_node.py` 10).
  **GEMINI PUNCTUATES HINDI WITH THE DANDA — THE FACT PHASE 0 COULD NOT GET FROM
  THE REPOSITORY, NOW MEASURED.** Every Hindi string in the tree is
  founder-authored config and the one recorded real-Gemini capture is Telugu, so
  the repo evidenced the fixture register and nothing else. Three real turns this
  session (live Gemini, live dev DB, real `/internal/voice/turn` SSE): **3 of 3
  terminated sentences with `।` and 0 of 3 with an ASCII period.** The single
  ASCII period that appeared was inside the abbreviation `डॉ.`, not a sentence
  end. So the defect was production behaviour, not a fixture artefact.
  ⚠️ **AT HEAD THE ONE HINDI REPLY THAT DID SEGMENT WAS SEGMENTED WRONG.** That
  same `डॉ.` reply released `'जी हाँ, आप कल आ सकते हैं। डॉ.'` — the library found
  its only "sentence end" at the abbreviation dot and sent *"…yes you can come
  tomorrow. Dr."* to Bulbul as a complete sentence. With the danda in the set it
  splits at the real boundaries and keeps `डॉ.` inside its own sentence. That
  mis-split is pre-existing and is neither caused nor deliberately fixed here.
  **RUNTIME EVIDENCE — TWO REAL DEV-ROOM CALLS, A/B, SAME ROOM AND SAME REPLY
  TEXT.** Real LiveKit rooms, the registered worker, real Sarvam STT and TTS,
  brain on `PORT=3001`. The caller's Hindi was synthesised with Sarvam REST and
  published as microphone audio, so the worker's own STT produced the transcript
  — the Issue 38 caller published silence, which elicits a greeting but never a
  turn. The observable is the TTS WebSocket itself, instrumented from outside by
  patching `aiohttp.ClientWebSocketResponse.send_str` (`scratchpad/issue41/probe_ws.py`,
  the Python shape of Issue 39's `NODE_OPTIONS` probe) — the plugin logs its
  `config` frame but not its `{"type":"text"}` frames, and those frames are the
  segment boundaries.

      FIX      TTS TEXT  'जी हाँ, हम रूट कैनल करते हैं।'
               stream_turn_total_ms=3902.6          <- generation COMPLETE
               TTS TEXT  '<the remaining 108 chars>'
               TTS FLUSH
      CONTROL  stream_turn_total_ms=3546.8          <- generation COMPLETE
               TTS TEXT  '<the entire 137-char reply, one frame>'
               TTS FLUSH

  The first segment left **before** the brain finished generating, 844 ms ahead
  of the second frame; the control — the same tree with the danda removed from
  the terminator set — put **one** frame on the wire and only after generation
  completed. The greeting split too: two frames instead of one.
  ⚠️ **PHASE 0's "OFFSETS ARE FAITHFUL, 18 OF 18" WAS A PROPERTY OF TWELVE
  FIXTURES, NOT OF THE LIBRARY, AND THE FIRST RULING WAS MADE ON IT.** Recovering
  each token by slicing the original at the returned offsets is the natural
  instinct — it looks obviously safer than substituting into the text — and it is
  wrong. `split_sentences` returns `(token, start, end)` where the token is **not**
  `text[start:end]`; the offsets are span markers and the library itself only uses
  `end` to advance its buffer (`token_stream.py:62`). On **unmodified** text with
  no substitution anywhere, **131 of 344 tokens violate**
  `tok == text[start:end].strip()` at HEAD. Two mechanisms:
  `_basic_sent.py:77` appends the **tail** token with `len(text) - 1`, one short,
  so slicing drops the last character (`split_sentences("Yes. No. Ok.")` returns
  `end=11` for 12 characters); and `_basic_sent.py:69`'s
  `buff += pre_pad + sentence` re-joins merged sentences with exactly one space,
  so the token is whitespace-normalised and no slice reproduces it when the
  separator was `''`, `'  '`, `'\n'` or `'\t'`.
  **It fails Telugu and English, not Hindi**: any reply whose final sentence is
  ≤20 chars fires the tail branch, so `"…five thousand rupees. Thank you."` loses
  its period and so does `"…రూపాయలు. ధన్యవాదాలు."`. Scored over one 234-input
  corpus: offset-slicing **141/234** lossless and **60/139** identical on
  danda-free input; the substitution that shipped is **234/234** and **139/139**,
  tuples and offsets included. Those two numbers **are** the byte-unchanged claim
  for Telugu and English and are asserted as such in
  `tests/test_danda_tokenizer.py`.
  **THE SUBSTITUTION'S ONE ASSUMPTION IS CHECKED, NOT ASSUMED.** `।`→`。`, `॥`→`！`
  — both already in the library's class, both single characters so `str.translate`
  is position-preserving — the library splits, the map is inverted per token. If
  the input already contains a substitute the inversion would rewrite a character
  the clinic typed, so that input takes `split_sentences` unmodified: **exactly
  HEAD**. That failure direction is the whole reason this mechanism won — a
  collision costs one reply its segmentation, where a bad slice puts corrupted
  text on the wire in the two languages that already work.
  ⚠️ **THE FIX ASSIGNS TO A PRIVATE PLUGIN ATTRIBUTE, AND THE GUARDS ARE THE
  SAFETY ARGUMENT.** `SarvamTTSOptions` declares `word_tokenizer` (`tts.py:426`)
  and `SynthesizeStream` reads it (`:1004-1008`), but `TTS.__init__` overwrites it
  at `:549` and takes no argument for it — the seam is real, read at synthesis
  time, and unreachable through the constructor. A dataclass accepts an unknown
  attribute **silently**, so a plugin bump renaming the field would leave the
  assignment writing to a name nothing reads, with every test green. Two guards,
  both naming the measured-against version in their failure message: the field is
  checked against the live dataclass before the write, and the assignment is
  asserted to survive `update_options()` — the mid-call language switch, i.e.
  exactly when a Hindi caller would otherwise lose it.
  ⚠️ **THE INSTALL SITE WAS FORCED BY THE TESTS, NOT CHOSEN.**
  `tests/test_greeting.py:102-118`'s `fake_tts` monkeypatches `sarvam.TTS` with a
  recorder that has **no `_opts`**, and `tests/test_agent_stream.py:49-55`'s
  `FakeTTS` goes straight into `BrainAgent.__init__`. Installing in `build_tts` or
  in `__init__` raises `AttributeError` across nine greeting tests and the whole
  stream suite. `tts_node` is reached only through a real `AgentSession`, and it
  covers **both** synthesis paths — `say()` (`agent_activity.py:2506`, the V1c
  greeting) and the reply pipeline (`:2753`). **Neither `test_greeting.py` nor
  `test_agent_stream.py` was modified**; the mid-call language-switch assertion is
  byte-unchanged.
  **THE ACK PATH IS UNAFFECTED, AND IT IS NOT A SUBSTITUTE FOR THIS.**
  `FlushSentinel` is consumed **upstream** of `tts_node`
  (`agent_activity.py:2775-2777`), so each segment gets its own `tts_node` call and
  its own `SynthesizeStream`, whose `end_input()` releases the buffer regardless of
  punctuation. But only the *ack* is flushed that way: the deltas after it open a
  second segment subject to all three gates again, which is the segment this
  change fixes.
  **Red-checked by execution, six mutations, each verified APPLIED by grep before
  its run**, each reddening only what it should. **M1** (danda out of the
  terminator set) reds **3, all Hindi**, with Telugu and English green — the DoD's
  central requirement, measured. **M2** (the collision check never fires) reds the
  3 collision tests and leaves `has_substitute_collision`'s own test green, the
  diagnostic that the function works and simply is not consulted. **M3** (the field
  constant names a field the plugin lacks) reds 5. **M4** (the existence check
  removed — the silent-attribute-creation defect) reds **exactly 1**. **M5** (guard
  B's survival check cannot fail) reds **exactly 1**, the control arm proving guard
  B has teeth — guard B's real subject is plugin behaviour, which cannot be mutated
  without patching `.venv`, so a simulated rebuilding plugin is the only honest
  red-check available. **M6** (the install writes to a copy) reds 4 including both
  guard B tests.
  ⚠️ **Residues, stated rather than hidden.** `U+0965` appears **nowhere** in this
  repository and in none of the three real replies; it is in the set because it is
  a strict superset and costs nothing, not because it was observed. The realised
  latency gain depends on how Gemini chunks its SSE deltas — on the three sampled
  replies the first segment was released 300 ms early, 0 ms early (the whole reply
  arrived in one final delta), and unchanged (HEAD had already mis-split at `डॉ.`).
  The dev caller created for the room runs (`+919000077041`, `preferred_language
  hi-IN`) was **deleted afterwards**, residue checked at 0 rows.
- **STANDING — A SOURCE PIN SHIPS WITH ITS RED-CHECK OR IT DOES NOT SHIP.** A
  test that asserts something about the **text of a source file** — located by
  `indexOf`, a hand-written regex, or an AST walk — is **vacuous until an applied
  mutation has been shown to red it**. Not "read carefully": applied, greped for
  in the file to prove it landed, and run. Four instances in three sessions, each
  green against a tree carrying the very defect it was written to pin:
  **V1c** — an AST pin on `agent.py` whose mutation silently failed to apply, and
  the test passed. **Issue 39, pin #1** — `/app\.listen\(([^)]*)\)/` stops at the
  first `)`, so `app.listen(PORT, HOST, () => {` captured `PORT, HOST, () ` and
  the callback fell outside the group. **Issue 39, pin #2** — after a balanced
  scan fixed that, `indexOf('app.listen(')` matched the phrase **inside the
  test's own new comment**, whose balanced scan returns the empty string, which
  contains no callback and passes. **Issue 40** — not a pin, but the same disease
  one layer out: the mutation harness's anchors missed **silently** (the tree is
  CRLF, the anchors were `\n`), and then a replacement containing
  `stored.split('$')` hit `String.replace`'s `$'` pattern — "everything after the
  match" — and spliced the rest of the file in twice, producing a mutation nobody
  wrote and a test file that ran **1 test instead of 6**. Both were caught only
  by the matched-**exactly-once** check and the grep-after-apply that Issue 39
  introduced; keep both, and use a **function** replacer so no `$` pattern is
  live. ⚠️ And never pipe a mutation script through `head`/`tail`: the SIGPIPE
  kills it between apply and restore and leaves the mutation sitting in the
  working tree. It happened this session. Write to the log, then read the log.
- **A LISTEN FAILURE IS NOW LOUD — Issue 39, built and CLOSED** (`c1645fb`).
  `server.js` no longer passes a callback to `app.listen`; it attaches
  `'listening'` and `'error'` itself, so the success log fires only on a real
  bind and a bind failure logs the code and **exits 1**. Node
  **1097 → 1103 / 180 suites / 0 fail / 0 cancelled / 0 skipped**; Python
  unmoved at **72**.
  ⚠️ **THE OBSERVATION WAS TRUE, AND THE CAUSE WAS EXPRESS — NOT AN
  UNCONDITIONAL LOG AND NOT WINDOWS.** The log had been inside the listen
  callback since `edabfa3`, which is exactly why nobody suspected it.
  **Express 5 registers the callback you hand `app.listen` on BOTH outcomes**
  (`node_modules/express/lib/application.js:598-606`, express@5.2.1):

      if (typeof args[args.length - 1] === 'function') {
        var done = args[args.length - 1] = once(args[args.length - 1])
        server.once('error', done)          // <-- the FAILURE path, same fn
      }
      return server.listen.apply(server, args)

  So the callback fired from the **error** path, logging a successful boot on a
  failed bind — and because that `once('error')` **consumed** the event, node's
  default unhandled-`'error'` throw never fired, so the process did not exit
  either. Our callback takes no `err` argument, so the error object was
  discarded unread.
  **MEASURED, NOT REASONED — five variants, all five reproducing.** A second
  `node server.js` against a held port logged `server started` with no
  `EADDRINUSE` and stayed alive in every one of `0.0.0.0`→`0.0.0.0`,
  `127.0.0.1`→`0.0.0.0`, `0.0.0.0`→`127.0.0.1`, `::`→`0.0.0.0`,
  `0.0.0.0`→`::`. The three candidate causes were then discriminated rather
  than assumed. *A different interface*: **rejected** — variant A is identical
  addresses. *The platform permits the co-bind*: **rejected** — two bare `net`
  sockets on this machine get `EADDRINUSE` on `0.0.0.0`, `127.0.0.1`, `::` and
  `::1` alike. *It genuinely bound*: **rejected** — `netstat -ano` with both
  processes up showed **one** LISTENING row, owned by the FIRST pid, and all
  seven HTTP probes were answered by that process (attributed by pid through
  the `incoming request` line). The decisive measurement was a
  `NODE_OPTIONS=--require` probe that instrumented `http.Server.prototype.listen`
  without touching `server.js`: for the second process it logged
  `'error' fired — code=EADDRINUSE` and **never** logged `'listening' fired`,
  while that same process emitted `"msg":"server started"`.
  **Exit behaviour at `c222006`, measured over a 45,015 ms window: it never
  exited.** Exit code null, no signal, `EADDRINUSE` absent from every line of
  its output, crons running, holding no listener. After the fix the same
  reproduction exits **1 in 823 ms** with
  `{"code":"EADDRINUSE","msg":"server failed to bind — exiting"}` and no
  success line.
  **IT ALSO EXPLAINS A WORKAROUND THAT HAD BEEN CARRIED FOR TWO SESSIONS.**
  The V1c and Issue 38 sessions both worked around "a stale process on :3000
  serves pre-edit code — run on PORT=3001" without ever explaining it. ⚠️ That
  note was a working note between sessions and was **never written down here**,
  which is why it survived as folklore rather than being diagnosed. It is this
  defect: the new process announced a successful start, bound nothing, and the
  old one kept answering every request.
  `process.exit(1)` rather than `process.exitCode = 1` is load-bearing — the
  crons start unconditionally and their timers hold the event loop open, so an
  exit code alone would leave running exactly the zombie this removes.
  **Red-checked by execution, four mutations, each verified APPLIED by grep
  before its run**, and each reddening only what it should: removing the
  `'error'` listener reds **only** test 3 (the failure is no longer logged —
  tests 1 and 2 stay green, because node's own throw still exits non-zero,
  which is the honest diagnostic that the handler buys the LOG, not the exit);
  restoring the express callback form **with** a correct error handler still
  present reds tests 1 and 6; restoring `c222006`'s exact shape reds **4 of 6**
  — 1, 2, 3 and 6, with the anti-vacuity test and the control staying green;
  `process.exit(0)` reds only test 2.
  ⚠️ **THE FIRST VERSION OF THE SOURCE PIN WAS VACUOUS, AND ONLY THE MUTATION
  CAUGHT IT.** Test 6 reads the argument text of `app.listen(...)` and asserts
  no callback. Two independent defects, both green against a tree carrying the
  bug: a naive `/app\.listen\(([^)]*)\)/` stops at the **first** `)`, so
  `app.listen(PORT, HOST, () => {` captures `PORT, HOST, () ` and the arrow
  falls outside the group; and once that was fixed with a balanced scan,
  `indexOf('app.listen(')` matched the phrase **inside the new comment block**
  — including the literal `app.listen()` — whose balanced scan returns the empty
  string, which contains no callback and passes. It now skips comment lines and
  asserts the captured text mentions `PORT`, so the empty-string case cannot
  come back silently. Residual, stated rather than hidden: a callback passed by
  NAME would still slip past the pin, and is left to the four runtime
  assertions.
  **The test is real runtime evidence: it spawns `node server.js` as a child**
  against a port the test process actually holds, and asserts the exit is
  non-zero, the failure is logged naming `EADDRINUSE` and the port, and the
  success log is ABSENT. The negative assertion is the actual bug and is the one
  that can pass vacuously, so two things stand against that: a **control run**
  on a free port asserting the success log appears **exactly once** (proving the
  harness can boot the server at all), and an explicit assertion that the
  blocked child died on the BIND and not in `env.js`. The children run with cwd
  set to a fresh empty directory, because `server.js:1` is
  `require('dotenv').config()` and its default path is
  `process.cwd() + '/.env'` — so a developer's `.env` cannot reach them.
  ⚠️ **ONE PRE-EXISTING TEST WAS EDITED, and my own change is what weakened it.**
  `tests/knowledge/embedWarmup.unit.test.js:125` located the call with
  `src.indexOf('app.listen(')` to assert the warm call comes after it. The new
  comment block names `app.listen()` in prose *above* the call, so that index
  now pointed at a comment and the assertion would have kept passing while
  measuring nothing. Changed to `indexOf('= app.listen(')`, which only the real
  call site matches. No assertion changed status.
  ⚠️ **MEASURED ON win32 10.0.22631, node v22.17.1 — NOT on Linux.** The
  swallowing mechanism is Express's and is platform-independent JavaScript, read
  at file:line rather than inferred, so the same shape is expected on Railway;
  but the reproduction itself was run on one platform and that is the whole
  evidence base.
  ⚠️ **THE SAME TRAP EXISTS ~30 MORE TIMES AND WAS DELIBERATELY LEFT.**
  `app.listen(0, resolve)` appears throughout `tests/` and `scripts/portal/`.
  It is benign there — an ephemeral port cannot collide, so the error path is
  unreachable — and rewriting 30 test helpers is not this issue. The only other
  production-shaped call site is `spike/voice-retell/server.js:61`, a spike that
  is not deployed. Issue **40** was allocated from here and is closed above;
  **Issue 41 is also closed above, and the next free issue number is 42.**
- **THE GREETING IS NOW SPOKEN IN THE LANGUAGE IT IS WRITTEN IN — Issue 38,
  built and CLOSED** (`1b7be6c`). `/internal/voice/call/start` returns `language`
  beside `greeting`; `voice-agent/agent.py` synthesises with it. Node
  **1097 / 179 suites / 0 fail / 0 cancelled / 0 skipped**; Python **57 → 72**.
  V1c resolved the greeting's language correctly and told the worker nothing
  about it, so the TEXT and the VOICE came from two unrelated sources — the
  worker built its TTS from `language_prior or DEFAULT_LANGUAGE`, a dev-room
  metadata hint or an env default.
  **ONE NAMESPACE, NOT TWO, AND THE DIRECTION IS THE DECISION.** The greeting
  resolves in the CONFIG namespace (`te`) and is synthesised in the SPEAKABLE one
  (`te-IN`) — the form the SSE `done` event already emits (`internalVoice.js:510`)
  and the form Sarvam TTS's `target_language_code` takes. The crossing is
  `speakableLang`, the inverse of `configLang` and its **neighbour in
  `src/modules/config/schema.js`**, because that file's claim to be the one place
  that knows two namespaces exist is only true if the inverse is there too. The
  brain emits the form its consumer needs; **Python receives a code and passes it
  through, mapping nothing**. A reverse map in the worker was refused by name.
  **PRECEDENCE IS ONE LINE AT ONE CALL SITE**:
  `build_tts(started.get("language") or language_prior or DEFAULT_LANGUAGE)`.
  Brain first — it wins even against a room prior that disagrees, since the text
  is already written in it — then the prior, then the env default. A brain with no
  `language` key (deploy skew) or a null one (no config row) collapses the
  expression to the **pre-change behaviour exactly**.
  ⚠️ **THE GUARD IS WHY `build_tts` EXISTS RATHER THAN AN INLINE CONSTRUCTOR
  CALL, and the plugin's behaviour was MEASURED, not read.** `sarvam.TTS.__init__`
  raises `ValueError` on `'   '` and `None`, and **`AttributeError`** on `123` or
  a dict — it calls `.strip()` before anything else. Either lands at bridge time:
  **a dropped call**, strictly worse than a wrong-language greeting, which
  self-corrects from the first turn. A blank string is **truthy in Python** and
  sails through the `or` chain, so the chain alone is not enough. What the plugin
  does **not** check is membership — `LanguageCode`
  (`livekit.agents.language`) is a permissive `str` subclass that accepts `'ta-IN'`
  and `'banana'` alike — so a well-formed unsupported code is deliberately passed
  through rather than second-guessed by a language table the worker must not own.
  **THE STT PRIOR IS UNTOUCHED, evidenced three ways**: the diff (a separate
  statement), a test pinning `language_prior or STT_AUTO_DETECT` against the
  shipped source by AST, and `language-code=unknown` on all three live STT
  sessions.
  ⚠️ **`entrypoint()` HAS NO TEST THAT CAN CALL IT, so the wiring is pinned by
  AST against its own source** — that `build_tts` is called exactly once with one
  argument reading `started`'s `language`, that `sarvam.TTS` is **not** constructed
  inline any more (a second site would bypass the guard), and that the STT line is
  unchanged. The five precedence tests then **execute that extracted expression**
  rather than a copy of it, so a mirror of the policy cannot drift from the policy.
  **Red-checked by execution, both sides, each mutation verified APPLIED by grep
  before the run** — last session a mutation silently failed to apply and the test
  passed. Hardcoding the `agent.py` call site to `build_tts("te-IN")` reds **12 of
  26**, including the `hi-IN` and `en-IN` cases and the wiring pin, with the
  **`te-IN` case staying green** — the diagnostic, since `te-IN` is both the
  hardcoded value and the old default. Hardcoding the Node `language` to `'te-IN'`
  reds **exactly 3 of 23**: `hi-IN`, the en-default tenant, and the namespace test.
  **RUNTIME EVIDENCE — real LiveKit dev rooms, the real registered worker, real
  Sarvam TTS, the live dev DB, brain on `PORT=3001`.** The language is read from
  the **plugin's own outbound wire config** (`Sending TTS config`, which carries
  `target_language_code`), not from a log line of ours: `en-IN` caller →
  `"target_language_code": "en-IN"` with the English transcript; `hi-IN` caller →
  `"hi-IN"` with the Hindi transcript. Three calls bridged, three configs matching
  the caller's stored language, and **zero `voice_worker_turn_metrics` lines** —
  V1c's `add_to_chat_ctx=False` property still holds. `/call/start` against the
  live dev DB: `en-IN`→`en-IN`, `hi-IN`→`hi-IN`, `te-IN`→`te-IN`, no stored
  language→`te-IN` (tenant default), `ta-IN`→`te-IN` (**tenant default, not
  English and not echoed back**).
  ⚠️ **ONE PRE-EXISTING TEST WAS EDITED, and it is not the mid-call switch test.**
  `tests/portal/portalReceptionist.integration.test.js:442` pins the `/call/start`
  key set **exhaustively**, on purpose — that is how it detects a persona field
  arriving — so it gained `'language'`. The gap it names is unchanged:
  `voice_speaker` and `pace` still never reach the worker, so the greeting still
  travels in the wrong voice, just no longer in the wrong language as well. The
  mid-call language-switch assertion (`tts.updates ==
  [{"target_language_code": "hi-IN"}]`) is **unmodified and green in all three
  files that carry it**.
  ⚠️ **ONE UNIDENTIFIED RED, RECORDED RATHER THAN CHASED.** A full Node run
  mid-session reported `# fail 1`; its log was lost to a `tee` path error, so the
  test cannot be named. It did **not** reproduce in the three consecutive full
  runs that followed at the same tree (1097/179/0/0/0 each). Most likely one of
  the three recorded intermittents (`auth.unit.test.js:43` at a diagnosed ~1.6%,
  `traces.integration.test.js:247`, `portalLifecycle.integration.test.js:794`),
  but that is a guess and is labelled as one.
- **THE GREETING IS SPOKEN ON JOIN — Q3's transport, built** (`dd93bec`).
  `/internal/voice/call/start` returns `greeting` beside its four existing fields;
  `voice-agent/agent.py`'s `speak_greeting` says it the moment the worker joins;
  the prompt's greeting instruction is suppressed **for voice only**. Before this,
  the greeting was a system-prompt instruction, so it was generated by Gemini
  inside an ordinary turn — the caller had to speak first and wait a full
  STT → brain → Gemini → TTS cycle to be greeted. `agent.py` already read
  `started["greeting"]` and `/call/start` never sent one, so that branch had been
  **dead code since it was written** (`docs/audit/voice-latency/00-verification.md`
  §Q3). Node **1043 → 1081**; Python **46 → 57**.
  ⚠️ **THE LANGUAGE WAS THE REAL BUG, AND IT WAS NOT IN THE TRANSPORT.**
  `customers.preferred_language` holds what Sarvam STT emitted — `agent.py:523-524`
  → `delegate_turn` → `customerService.js:69-73` writes it **verbatim** — so it
  holds `te-IN`. The config document is keyed on **bare** codes (`te`). Selecting a
  greeting with the stored value misses every key and falls through `pickLine`'s
  English fallback: **a Telugu clinic's returning Telugu caller greeted in English
  by a route returning 200**, with a WARN that reads as a stale-config notice
  rather than a bug. Not hypothetical — the dev database's own caller row holds
  `en-IN`, and flipping it through all four cases against the live database is part
  of this session's runtime evidence.
  **Fixed at ONE boundary, deliberately not with a lookup table in the greeting
  path** — that would have been a second convention for the same fact.
  `configLang(code)` is exported from `src/modules/config/schema.js` beside
  `LANG_CODES`: `te-IN`/`te`/`TE-in` → `te`, anything undeclared → **null, never a
  language**. Null means **tenant default plus a WARN naming the value**, never
  English by accident — which is the entire failure mode being bought out of.
  ⚠️ **THE ACK COPY WAS CORRECT ONLY BY COINCIDENCE, and is repointed through the
  same function.** `VOICE_ACK_COPY` was keyed on `te-IN`, which worked because
  `effectiveLanguage` reaches it from the STT-written column. A **tenant-default**
  `te` — what `config.languages.default` holds — missed the table entirely and was
  acknowledged in English mid-call. Two tables keyed two ways in one file is how
  that stays true and stays invisible; there is now one function and
  `tests/voice/ackLanguage.unit.test.js` pins it.
  ⚠️ **SUPPRESSION COVERS THE WHOLE §3 BLOCK, not just the greeting lines**, and
  that was a Phase 0 finding rather than the scope as written. The consent line rode
  inside the same `greetLines` array (`clinic.js:325-341`) and `/call/start`'s
  payload already carries it, so leaving `Then say exactly: "<consent>"` in the
  voice prompt would make the caller hear **a legal-floor line twice**.
  **WhatsApp is untouched and that is evidenced, not asserted:** the three committed
  `clinic.*.whatsapp.txt` snapshots show **zero content diff** in git; only the
  three voice snapshots changed, by exactly the removed line.
  ⚠️ **`add_to_chat_ctx=False` IS LOAD-BEARING, AND THIS COMMIT IS WHAT MADE THE Q6
  RESIDUAL REACHABLE.** With the default `True`, `agent_activity.py:2589` builds an
  assistant `ChatMessage` and fires `conversation_item_added` — the event
  `turn_metrics_listener` counts — so the greeting would emit a **phantom turn-1
  line with null stt/eou/llm fields** and shift every real turn's index by one. The
  Q6 note above says that residual "would mis-attribute only to a `session.say()`
  reply, and `say()` is unreachable at HEAD"; it is reachable now. Audio and
  transcript forwarding start at `agent_activity.py:2521`/`:2537`, **ahead of** that
  gate, so the caller still hears the greeting and the room still gets the
  transcript. `voice-agent/tests/test_greeting.py` pins that ordering against the
  **installed library by AST**, because a version bump could move it silently.
  ⚠️ **LEGACY `ai_prompt` TENANTS CHANGE BEHAVIOUR (A-007).** `resolvePromptHead`
  (`aiService.js:479-484`) returns `tenants.ai_prompt` verbatim when non-empty and
  never reaches this renderer, so such a tenant gets **no greeting instruction at
  all** today. With a `tenant_configs` row it now starts hearing a spoken config
  greeting on join; with **no** config row `/call/start` returns `''` and nothing
  changes. The precedence chain itself is untouched, per scope.
  **Red-checked by execution**, both required mutations plus one on a test's own
  guard: `configLang` reduced to the identity reds **7 of 14** greeting tests
  including *"THE BUG: 'te-IN' gets Telugu"* — and the **`en-IN` test stays green**,
  which is the diagnostic, since English is exactly what the broken path falls back
  to; blanking the `te` consent line reds **4**, all `te` consent-presence
  assertions, with `hi` and `en` green; injecting an `add_to_chat_ctx` gate around
  transcript forwarding reds the AST pin naming `perform_text_forwarding`. That
  third one earned its place — **the first attempt at that mutation silently failed
  to apply and the test passed**, which is what a vacuous guard looks like.
  **RUNTIME EVIDENCE — a real LiveKit room, the real registered worker, real Sarvam
  TTS, caller publishing silence** (the greeting precedes any utterance by
  construction, so no speech is needed to elicit it): `call bridged` at
  `15:25:04.769`, Sarvam TTS connecting at `15:25:05.091` — **+322 ms, with no
  caller speech** — and the room transcript reading
  `నమస్తే! స్వాగతం. నేను మీకు ఎలా సహాయం చేయగలను?`. That transcript arriving **with
  `add_to_chat_ctx=False`** is live proof of the property the AST test pins. Zero
  `voice_worker_turn_metrics` lines across three greeting-only calls. Against the
  live dev database: `te-IN` → Telugu, `hi-IN` → Hindi, `en-IN` → English,
  `ta-IN` → **tenant default (Telugu), not English**.
  ⚠️ **FILED, NOT BUILT — Issue 37, A-010. Issue 38 is now CLOSED at `1b7be6c`**
  (see the entry above this one). Issue 37: the writer at
  `customerService.js:69-73` is unvalidated, so the column keeps accumulating values
  no schema admits and every future reader inherits the obligation to normalise.
  Issue 38 was: the worker synthesises the greeting with
  `target_language_code = language_prior or 'te-IN'`, **independent of the language
  the brain resolved the TEXT in** — measured this session as an English greeting
  spoken by a Telugu-configured voice, self-correcting from the first turn. Out of
  scope then (no TTS changes). A-010 records the assumption that broke.
- **THE WORKER NOW TIMES ITS OWN TURNS — Q6's missing wiring, built** (`7abec81`).
  `docs/audit/voice-latency/00-verification.md` §Q6 established that the framework
  computes every stage timing and the worker subscribes to none of them. `agent.py`
  now emits **one** `voice_worker_turn_metrics` line per turn: `stt_final_ms`,
  `eou_delay_ms`, `llm_ttft_ms`, `tts_ttfb_ms`, `e2e_ms`, plus `call_session_id`,
  `correlation_id`, `turn` and `language`. Python suite **37 → 46**; Node suite
  **unmoved at 1043/173/0/0/0** (the change is confined to `voice-agent/`).
  ⚠️ **THE ISSUE NAMED `metrics_collected` AND THAT EVENT CANNOT DO THE JOB HERE.
  This is the session's substance, and it was found by reading the installed
  library rather than the prompt.** Two facts, both at file:line in
  `voice-agent/.venv` (livekit-agents **1.6.4**):
  (1) `MetricsCollectedEvent`'s own docstring — `voice/events.py:375-376` — reads
  *"Deprecated: … Per-turn latency metrics are available on `ChatMessage.metrics`."*
  (2) Decisively, it **cannot carry the llm_node timing on this wiring at all**.
  `LLMMetrics` is constructed at exactly one site — `llm/llm.py:315`, emitted at
  `:369` — inside `LLMStream._metrics_monitor_task`, and an `LLMStream` exists only
  when `LLM.chat()` is called. `BrainAgent.llm_node` overrides that slot and
  `BrainStubLLM.chat` **raises by contract**, so **`LLMMetrics` never fires**. The
  prompt anticipated exactly this as "the likeliest surprise", and it is real.
  **The number is not missing — it is carried elsewhere, and that is why the
  session did not stop.** `voice/generation.py:146-147` stamps
  `_LLMGenerationData.ttft` on the **first chunk the overridden node yields**, and
  `voice/agent_activity.py:2987-2988` publishes it as **`llm_node_ttft`** on the
  assistant message (built `:3028-3038`). So the source is `ChatMessage.metrics` —
  the `MetricsReport` TypedDict at `llm/chat_context.py:261-313`, attached to every
  message at `:324` — delivered on **`conversation_item_added`**.
  **TWO LEGS, TWO MESSAGES.** Endpoint and STT timings ride the **user** message
  (`agent_activity.py:3967-3986`, `_init_metrics_from_end_of_turn`); llm/tts ride
  the **assistant** message. The handler holds the user leg and emits once, when
  the assistant item lands — which is what makes it one line per turn rather than
  one per component.
  **Issue 21's correlation id ALREADY reaches the worker**, so the line is keyed on
  it rather than on a new identifier: `/call/start` returns it
  (`internalVoice.js:592-600`), `agent.py` stores it on `CallState` and already
  warns when a skewed brain omits it. `turn` disambiguates the many turns sharing
  one call's chain id. **No correlation id was added to the brain**, per scope.
  **AgentSession construction is untouched** — `session.on(...)` beside the
  existing `user_input_transcribed` handler. No turn behaviour changed, no
  dependency added, no SSE/Node/tokenizer/greeting/VAD change.
  ⚠️ **WHAT "MALFORMED" ACTUALLY MEANS HERE WAS MEASURED, AND IT INVERTED THE
  OBVIOUS GUESS.** `MetricsReport` is pydantic-validated on `ChatMessage`, so the
  values a defensive reader would expect to guard cannot occur: **`None` is
  rejected** at construction, `"0.18"` and `True` are silently **coerced**, unknown
  keys are **dropped**. What passes validation untouched is **`NaN` and `inf`** —
  which are also the dangerous ones, since a NaN in the line poisons every
  downstream average silently. Each field degrades to a logged null on its own.
  The unvalidated cases are still handled and still tested, because
  `getattr(item, "metrics", None)` is `None` for any item that is not a
  `ChatMessage`.
  ⚠️ **THE HANDLER'S OWN try/except IS LOAD-BEARING, NOT BELT-AND-BRACES.**
  `rtc.EventEmitter.emit` catches `Exception` and logs — **but re-raises
  `TypeError`** — and this handler runs inside the framework's reply task. So a
  `TypeError` from a metrics line really would land on the turn path.
  ⚠️ **A TURN WITH AN EMPTY REPLY PRODUCES NO LINE, by construction.**
  `agent_activity.py:3024` gates the assistant message on `forwarded_text`, so a
  human-mode / AI-disabled turn (empty `reply_text`) adds none and is not timed.
  Honest — there was no agent reply to time — but it means the line count is
  *spoken* turns, not turns. Its residual is documented at the fix site: that
  turn's user leg stays pending, and could in principle attach to a
  `session.say()` reply. ⚠️ **That "unreachable at HEAD" caveat expired at
  `dd93bec`** — V1c gave `session.say()` a caller. It is answered rather than
  merely re-dated: the greeting passes `add_to_chat_ctx=False`, so it never
  reaches `conversation_item_added` and cannot collect a pending leg, verified
  across three greeting-only dev-room calls at **zero** metrics lines. The
  underlying limitation is unchanged — nothing on the two messages links them, so
  a real fix still needs a turn id the framework does not expose.
  **Red-checked by execution**, four mutations, each reddening only the test that
  covers it: dropping the user-leg stash, emitting for every item, dropping the
  non-finite guard, narrowing the `except`.
  ⚠️ **NO LIVE DEV-ROOM TURN WAS PERFORMED, and no fixture is offered in its
  place.** LiveKit cloud is reachable and all worker credentials are present, but
  the Node brain was not running locally and a real line requires a participant
  **speaking audio** into the room — the transcript, the brain reply and the
  synthesis all have to happen. What was produced instead, and labelled as such:
  the line rendered through LiveKit's **own** formatters
  (`cli/log.py` `JsonFormatter` / `ColoredFormatter` with the exact format strings
  `setup_logging` installs), driven by the real handler and the real carrier. That
  evidences the line's **shape**, not a turn.
  **THE PYTHON SUITE WAS RED AT A CLEAN TREE ON THIS MACHINE. FIXED at `1bb1e6d`
  (V1a-R1).** It was not V1a's doing. `uv run pytest` at `0564a0b` gave
  **4 failed / 33 passed**, all four in `tests/test_agent_shim.py`
  (`test_happy_path_delegates_exact_contract_and_yields_reply_exactly`,
  `test_brain_language_switch_calls_update_options_before_reply`,
  `test_end_call_true_signals_shutdown_once_after_yield`,
  `test_empty_reply_stays_silent_and_keeps_call_open`). Cause: `agent.py:40` calls
  `load_dotenv()` **at import**, and the **gitignored** `voice-agent/.env:17` sets
  `VOICE_STREAM_TURNS=true`, so those JSON-path tests ran the SSE path and failed on
  `stream_turn failed: SSE stream ended without a done event`. `.env.example:32`
  ships `false`, so the suite was green on a machine without that line — which is
  why it went uncaught, and why **the Python suite's verdict depended on a file
  that is not in the repository**. (Re-measured at `004d00c` the same finding reads
  **4 failed / 42 passed**: the four failures are byte-identical and V1a's own nine
  `test_turn_metrics.py` tests account for the whole delta, 37 → 46.)
  **Fix: `voice-agent/tests/conftest.py`** sets every variable `agent.py` reads to
  `agent.py`'s own fallback, so the suite runs as if no `.env` existed. It turns on
  a property of the installed **python-dotenv 1.2.2** — `main.py:387`
  `load_dotenv(..., override=False)` and `main.py:105`
  `if k in os.environ and not self.override: continue` — so a key **set** before the
  first `import agent` survives. **The direction is a trap: `os.environ.pop()` would
  hand the key back to the file**, an absent key being exactly the one `load_dotenv()`
  fills in. Placed in `tests/` rather than the rootdir `voice-agent/conftest.py`
  (which owns only the `sys.path` insert) to keep the isolation beside the tests it
  governs; either is test-side, and no `agent.py` change was needed.
  **Verdicts are now identical with and without the file: 46 passed / 0 failed both
  ways**, same per-file distribution. **Red-checked by execution**, four mutations:
  deleting the conftest reproduces the original four failures exactly; the
  module-scope loop and the autouse fixture each alone fix those four, but only the
  loop reaches the **import-time** constants — with `VOICE_TURN_TIMEOUT_S=abc` in the
  environment the suite passes 46 with it and dies in **3 collection errors** on
  `agent.py:53`'s unguarded `float()` without it.
  ⚠️ **`VOICE_TURN_TIMEOUT_S` remains unguarded at `agent.py:53` in the RUNTIME.**
  The suite is now immune; the worker is not. A non-numeric value in a deployed
  environment crashes it at import. Out of scope for a test-side issue, unfiled.
  **Also corrected from V1a's report:** `VOICE_DEFAULT_LANGUAGE` (`agent.py:75`) is
  reached by the suite after all — indirectly, through `apology_for()` at
  `agent.py:99`, which `test_agent_shim.py:271-273` calls. It could not have flipped
  those assertions (`in APOLOGIES.values()` holds for any value, the fallback chain
  landing inside that set), but it is a live path, not an unread constant, and it is
  pinned. `VOICE_TENANT_ID` / `VOICE_DEV_CALLER_NUMBER` do gate a real branch
  (`agent.py:442`) but only inside `entrypoint()`, which **no test calls** — pinned
  to `""` anyway, so a future test that reaches it gets the deterministic
  empty-environment refusal rather than a developer's tenant.
  ⚠️ **`voice-agent/.env:16` sets `VOICE_METRICS=true` and NOTHING READS IT** —
  verified by grep across the repository, zero hits outside that file. A dangling
  flag suggesting someone once intended a metrics switch. The new line is **not**
  gated on it; wiring an env gate was not in scope and inventing a reader for a
  flag no one set deliberately would be worse than leaving it visible.
- **Issue 11 — DID→tenant resolution. DONE** (`9be2382`), and **UNWIRED**.
  `tenantService.getByDid(dialledNumber)` returns the tenant that owns an
  inbound dialled number, or null.
  ⚠️ **THE HONEST CLAIM IS NARROW AND THE COMMIT SAYS SO. This does NOT mean
  voice can route calls.** The resolver has **no production caller** — Issue 12
  supplies the dialled number — so passing tests are the only evidence available,
  which is weaker than this repository's usual runtime-evidence bar. Nothing was
  wired to it, deliberately: `src/routes/internalVoice.js` and the
  `/internal/voice/*` contract are untouched.
  **Placed in `src/modules/tenant/tenantService.js`**, beside `getByPhoneNumberId`
  and `getById` — CLAUDE.md assigns tenant lookup to that module, and this is the
  same operation keyed on a different channel identifier. `src/modules/voice/`
  holds call-session lifecycle and the provider seam; a tenant lookup there would
  split tenant resolution across two modules by channel.
  **NO MIGRATION AND NO INDEX.** The DID lives at `config.voice.did` in
  `tenant_configs.config` (JSONB), reached by
  `JOIN tenant_configs tc ON tc.tenant_id = t.id` — the same shape
  `retentionCron.js:24-35` already uses on that column. A column would duplicate a
  value the config document already owns *and* validates through `configSchema`,
  giving one fact two sources of truth with nothing syncing them, and would cost a
  schema change on a pre-genesis repo. No index at ≤10 tenants: one row per tenant,
  read once per call rather than per turn, and an expression index on a JSONB path
  is itself a migration whose write cost is paid on every config save.
  ⚠️ **THE AMBIGUITY GUARD IS THE POINT, AND IT COULD NOT BE COPIED FROM THE
  WHATSAPP RESOLVER.** `tenants.phone_number_id` is `UNIQUE` (`schema.sql:55`), so
  `getByPhoneNumberId` can carry `LIMIT 1` and never meets a second row. A DID in a
  JSONB document has **no uniqueness constraint behind it at all**, so the
  contested case is real here and `LIMIT 1` was deliberately not carried across —
  it would silently convert ambiguity into a first-row match, which is a
  cross-tenant leak. Two or more active tenants matching ⇒ **null plus a warning**,
  never a guess.
  ⚠️ **`t.active = true` IS ON BOTH QUERIES AND THE FIRST ONE IS LOAD-BEARING —
  measured, not argued.** Removing that single clause from the DID query (hydration
  still filters, since `getById` carries its own) turns test **(9)** red while test
  **(8)** stays **green**: an inactive tenant sharing a DID with an active one
  returns a second row, trips the ambiguity guard, and answers null for a clinic
  that is legitimately the only active owner of its number. So filtering only on
  hydration would have shipped the bug **with the obvious test still passing**. The
  matching red-check on the guard itself fails test (10) and nothing else.
  **Fails closed everywhere else too:** input that is not valid E.164 → null (not a
  throw — `normalizePhone` throws by contract, but every stored DID is validated on
  write by `configSchema`'s `E164`, which imports **the same** `E164_RE`, so a
  string that fails normalisation provably matches no tenant; null is *equivalent
  to* no-match, not a swallowed error), no match → null, tenant deactivated
  mid-resolution → null.
  ⚠️ **NOT a voice gate, and this is in the JSDoc rather than only in the commit
  message**, because Issue 12's author will read the function. A tenant with a DID
  set and `voice.enabled` **false WILL resolve** — the function answers "whose
  number is this", not "may this clinic take calls". Gating on `voice.enabled` and
  on lifecycle status is Issue 14's, and building a seam for it here was refused.
  **Hydration delegates to the existing `getById`** — one tenant-row shape, one
  lazy `wa_token` decrypt, one cache. No DID-keyed cache: it would need its own
  invalidation on *config* writes, which nothing provides.
  **PII:** tenant id on success; the dialled number never appears in full at any
  level, only a last-4 redaction, per open finding **V-014**. The correlation id
  rides the pino mixin and is not spelled at the call sites.
  ⚠️ **NAMED `getByDid`, NOT the plan's `getTenantByChannel('voice', did)`, and the
  plan was corrected in the SAME commit.** A two-argument dispatcher whose first
  argument has exactly one legal value is a seam for Issues 12/13; the codebase's
  real convention is one named resolver per channel identifier. The rename would
  otherwise have broken the evidence trail: the audit established this issue as
  MISSING via `VERIFIED grep: no getTenantByChannel`
  (`docs/deploy/audit/2026-07-production-readiness.md:77`), so a future session
  re-running that grep would read zero hits as *unstarted*.
  `docs/specs/zyon-first-launch-plan.md` now names `getByDid`;
  `docs/ZYON_V2_SPEC.md:118` is left alone as the historical spec it is.
  ⚠️ **FILED, NOT BUILT — Issue 36: no operator surface writes `voice.did`.**
  Verified by grep across `src/`, `scripts/` and `tests/`: the key is declared
  (`config/schema.js:257`, `defaults.js:109`), read by validation
  (`validation/validationService.js:259-264`) and now by `getByDid`, and written by
  **nothing with a UI or a CLI flag** — not the Issue 15 provisioning CLI, not the
  portal (`portal/routes.js:1433,1606` say so and preserve it across saves), not
  any script. Structurally the same shape as **B1's `tenants.owner_notify_phone`**,
  which was expensive precisely because it was found late. **NOT a launch blocker,
  and must not be read as one:** the admin JSON config editor can set a DID today
  through `configService.writeTenantConfig`, validated like any other field. What
  is missing is a labelled input, so setting a clinic's number means hand-editing
  JSON. Nothing to configure until Issue 12 or 13 needs it, and C-2 is still
  unfiled.
- **F3-R1 — the login page promised a password reset the system could not
  perform. FIXED** (`740c1c7`). `public/portal/login.html` has told owners
  since F3 to message Prantivo on WhatsApp for a reset;
  `POST /admin/api/tenants/:id/owner` **creates** an account and 409s when one
  exists (`adminRoutes.js:813-815`, `23505` backstop at `:829`), and the only
  `UPDATE users` in `src/` or `scripts/` was `last_login_at`. A reset meant
  hand-editing in `psql`.
  ⚠️ **PHASE 0 CHANGED THE SHAPE OF THE FIX, and this is the session's substance.
  A reset built as originally scoped would have been WORSE THAN NOTHING in the
  one case that matters.** `requirePortalAuth` re-read the user row on every
  request but selected only `id, tenant_id, role, active` — **`password_hash` is
  never consulted after login** — and the session payload was `{ userId }` and
  nothing else. So rotating the password left every live `portal.sid`
  authenticated for the rest of its 12h window. The owner who asks for a reset is
  frequently the owner who suspects compromise, so that reset would have handed
  back a false assurance while the intruder stayed signed in. Founder ruling:
  session invalidation is **mandatory, not preferred**.
  **Migration `027_password_changed_at.sql`** adds `password_changed_at
  TIMESTAMPTZ NOT NULL DEFAULT NOW()` to `users`; `schema.sql` in lockstep,
  inline. Login stamps it into the session (`pwAt`); `requirePortalAuth` compares
  the session's copy to the live row on every request and 401s on mismatch, so a
  reset evicts every session issued before it. `passwordEpoch` +
  `sessionEpochMatches` are **exported from `auth.js`** so the two call sites can
  never drift into two conventions — the discipline that keeps `hashPassword` the
  single hashing path.
  ⚠️ **NO TRIGGER on this column, deliberately, and it is the same reason
  `updated_at` could not have served.** `users` already has `updated_at` and
  `trg_users_updated`, but the login path itself UPDATEs this row
  (`last_login_at`) and fires that trigger — so `updated_at` **provably cannot
  distinguish a reset from a sign-in**, and a trigger on the new column would
  make every login invalidate every other session of the same user.
  `password_changed_at` is written at exactly two sites: the `DEFAULT` on INSERT,
  and the reset UPDATE. It moves for one reason and therefore means one thing.
  **THE COMPARISON IS STRICT, AND THE DEPLOY COST IS PAID KNOWINGLY.** Sessions
  minted before this migration carry no `pwAt`, and a session with no epoch is
  **rejected, never admitted** — so every owner signed in at deploy is signed out
  once and signs back in normally. The rejected alternative was a null-tolerant
  comparison, which reads as a migration accommodation and functions as a
  **permanent bypass**: it would admit forever exactly the pre-reset sessions the
  column exists to evict. `NOT NULL` is load-bearing for the same reason — it
  makes "no epoch on the row" unrepresentable. A stringified epoch, a stale
  epoch, `null` and a missing key are all asserted to fail.
  **AUDIT: the column IS the durable record; no `admin_audit` table was built.**
  Founder ruling — a table with exactly one writer is infrastructure looking for
  a second caller; build it when a second admin action needs auditing. Beside the
  column, a structured line follows `adminRoutes.js:824`'s shape:
  `{ scope, tenantId, userId, actor: 'admin_session' }` + the `adm_` correlation
  id the pino mixin attaches. ⚠️ **`actor` is `'admin_session'` and NOT a person,
  and that is honesty rather than laziness**: admin auth is one shared
  `ADMIN_PASSWORD` and `requireAuth` checks a boolean (`adminRoutes.js:48-51`),
  so there is no operator identity to record. **A fictional actor would be worse
  than an honest session.** A named operator requires operator accounts, which do
  not exist. The email is deliberately absent from the line (the `userId`
  identifies the row and carries less PII); the password never reaches it.
  ⚠️ **THE VERIFICATION ROUTE IS A PREREQUISITE, NOT A CONVENIENCE.** Before it,
  the owner's email was displayed **nowhere** in the admin panel — the create card
  renders it only in its one-time success message — so an operator performing a
  reset could not see which account they were resetting without opening `psql`.
  Acting blind on an auth action is a security defect in the feature itself. New
  read-only `GET /admin/api/tenants/:id/owner` returns exactly four fields:
  `owner_count`, `email`, `verify_number` and `verify_number_source`. The number
  is `config.notifications.owner_numbers[0]` — B1 established that is the real
  owner recipient, since `tenants.owner_notify_phone` has no production writer —
  surfaced as a **labelled** field, because "dig it out of the config JSON editor"
  is not a verification procedure. No `password_hash`, no other user columns.
  **`POST /api/tenants/:id/owner/reset`** carries the identical middleware chain
  to the create route (`requireAuth, apiLimiter, requireAdminHeader,
  requireTenantId`) and **reads no body at all** — there is no `express.json()`,
  so nothing a caller sends can influence the target. The tenant comes from the
  path; the user from that tenant's single owner row. The UPDATE repeats
  `tenant_id` in its own predicate rather than trusting the lookup, and
  `rowCount` reports the outcome.
  **The operator does NOT choose the password** — the server generates it
  (`generateTempPassword`, unchanged), returns it once, and the operator reads it
  out. An operator-typed password is an operator-known password. Hashing is
  `hashPassword` from `src/portal/auth.js`, the same single path account creation
  uses; asserted by **comparing the stored `scrypt$N$r$p$…` prefixes** of a
  created and a reset hash rather than assuming.
  **Ambiguity fails CLOSED.** `users` is `UNIQUE (tenant_id, email)`, so a tenant
  can legally hold two owner rows; the reset refuses with a 409 naming the count
  rather than resetting whichever sorted first, mirroring portal login's
  `rows.length === 1` rule. Handing a working password to the wrong person is the
  failure mode being bought out of.
  **UI follows the Pause pattern** (founder ruling — consistency in an admin panel
  is itself a safety property): same chain, client-side `window.confirm`, red
  button, no server-side two-step. The text names **both** consequences — the
  current password stops working, **and** anyone signed in is signed out — because
  the second is the whole point of the mechanism and is otherwise invisible. The
  one-time reveal panel is **shared** with create so the shown-once behaviour
  cannot drift between the two actions.
  ⚠️ **FILED, NOT BUILT:** an `admin_audit` table (above); operator accounts,
  without which no audit record can name a human; fan-out beyond
  `owner_numbers[0]`; and self-serve reset, which stays correctly out of scope —
  F3's Phase 0 confirmed zero email transport anywhere in the repo, so a token
  flow means a transport, an issue-and-expiry table and a reset route before a
  single paying customer. `login.html`'s copy is unchanged and still names
  WhatsApp.
- **B2-R1 — a patient could book and move, but not cancel. FIXED** (`8fc184c`).
  `status = 'cancelled'` had existed since migration `003` and **nothing in the
  system had ever written it** — verified, not assumed: `git grep` over `src/`,
  `tests/`, `scripts/` and `public/` returned ten hits and every one was a CHECK
  declaration, a comment, or the word used about something else. The value was
  dead for five months, so this session defined its semantics rather than
  inheriting them. A patient who could not attend had to ring the clinic — the
  thing this product exists to prevent — or not ring, and the clinic held a slot
  for someone who was not coming.
  **NO MIGRATION. None was needed and none was written.** `'cancelled'` is
  already in `appointments_status_check`, and `uniq_doctor_slot` is partial on
  `status = 'booked'`, so the flip **is** the slot release — the same mechanism
  B2's `'rescheduled'` uses, with no index change.
  ⚠️ **THE GATE, and why it is structural rather than prompt text — this is the
  session's whole substance.** Booking's "confirm first, book second" is really
  an INFORMATION DEPENDENCY WITH A BOUNCE: the model cannot name a slot without
  `check_availability`, and if it invents one `validateSlot` refuses it (off-grid,
  closed day, holiday, past, inside the buffer). **Every one of those walls passes
  a mis-parsed cancel.** The time is real, it is valid *precisely because* it is
  an existing booking, and it is already in the conversation — the patient said
  it, or the model booked it a turn ago. Nothing bounces. Phase 0 inventoried
  what would slow a destructive first-turn call and found the brake is **100%
  prompt-level and every instance names its tool by hand**: the tail's two
  confirm lines (`aiService.js:566-567`) both say `book_appointment`; the rest is
  per-tool declaration text and one renderer line (`clinic.js:313`). So cancel
  would have inherited **no protection at all**. Founder ruling: advisory is
  enough for an action with a wall behind it, not for the only irreversible
  action in the product.
  So `cancel_appointment` takes a **REQUIRED `confirmed` boolean**, compared
  **strictly `=== true`**. `confirmed` false/absent ⇒ **no write**, and a
  confirmation payload (doctor, date, time, patient name) for the model to read
  back. `confirmed === true` ⇒ the cancel. **The first call cannot write, whatever
  the model intends**, so a turn happens in between in which the patient either
  says yes or does not — the availability step booking gets for free, made
  explicit because cancel cannot earn it.
  ⚠️ **ONE TOOL NAME, TWO PHASES, and that is what makes it a gate.** A read-only
  lookup tool plus a destructive tool would let the model call the destructive one
  directly, which is advisory again. One door, whose first turn cannot write.
  ⚠️ **THE COST OF THAT, PAID KNOWINGLY: `mutating: true` covers both phases.**
  `TOOL_META` is keyed by declaration name, so one flag serves both. On the
  read-only phase `committed` therefore flips after a call that wrote nothing,
  disabling Issue 29's abort checks for the rest of the turn. **Accepted, on the
  asymmetry:** `mutating: false` would leave `committed` unset on a call that
  really did destroy a booking, so an abort between the cancel committing and the
  reply being spoken would tear exactly the write Issue 29 exists to prevent — the
  appointment gone, the patient never told. Over-declaring costs an abort
  opportunity on a turn with nothing to lose; under-declaring costs a real
  appointment. Both halves are asserted live in
  `voiceCancellation.integration.test.js` (8) and (9) — (9) exists specifically to
  pin the cost rather than let it be discovered later as a surprise.
  **NO TRANSACTION, deliberately.** B2 bought one because a move is two writes
  that must both land or neither. A cancel is a **single guarded UPDATE** —
  `WHERE id AND tenant_id AND customer_id AND status = 'booked'` — atomic on its
  own, with `rowCount` reporting the outcome, so "threw means committed nothing"
  holds trivially. That `status = 'booked'` predicate is also the analogue of B2's
  `same_slot` refusal (a cancel has no destination, so there is nothing to be
  *same* as): it makes a double-cancel and a cancel of an already-moved row fail
  cleanly, and it **transitions a row, never drops one**.
  **ONE resolution path, shared by BOTH phases and by the move.** `resolveOwn
  Appointment` — the `(tenant_id, customer_id, appointment_time)` lookup lifted
  verbatim out of `rescheduleAppointment` — is what the dry run and the write both
  call. **A confirmation that resolved differently from the write it authorises
  would be worse than no confirmation**, and that is asserted directly. No
  appointment UUID crosses in either direction on either phase, and the patient's
  **phone** is absent from both (the name is not: it is already in the prompt and
  on `bookAppointment`'s return).
  **`appointmentNotFound` took a verb PARAMETER, not a sibling function** — it was
  the one piece of B2 not reusable verbatim, since its text said "to move" and
  "before moving anything". Defaulting to `'move'` keeps the reschedule wording
  **byte-identical**, asserted.
  **Owner alert: a THIRD shape in the same function**, dispatched on a **declared**
  `cancelled` flag (B2's rule — never inferred; a mutation that infers it from
  `status` instead is proven to go red). `Appointment cancelled — {doctor}` with a
  single **`Freed:`** line, because the receptionist's actionable fact is *which
  slot just opened*, not that a cancellation occurred. `type` stays
  `'appointment_booked'` — load-bearing, since `scriptedTurnCheck` finds and
  cleans its own rows by an id diff scoped to exactly that literal. `Status:`
  reads the COLUMN and renders `cancelled` with no new code.
  **`reminder_status` is untouched, on purpose.** `reminderCron`'s claim query
  already filters `a.status = 'booked'`, so a cancelled row can never be claimed
  (asserted, and asserted **non-vacuously** — both rows are proven identical on
  every other dimension the claim query filters on). The column's CHECK carries no
  cancelled value, so the only reachable writes would be `'sent'` or `'failed'`,
  and both are lies.
  ⚠️ **FILED, NOT FIXED — the claimed-and-cancelled race.** A row already flipped
  to `'sending'` is still reminded: `processReminder` works from the row already
  fetched into `due` and never re-reads `status`, so the patient gets a reminder
  for an appointment they cancelled seconds earlier. Unfixable from the cancel
  side — it needs the send path to re-check status under the row lock. It **cannot
  repeat**, because `reapStuck`'s re-claim filters `status = 'booked'` again. The
  test records the real behaviour rather than pretending otherwise. Full analysis:
  `docs/audit/2026-08-b2r1-filed.md`.
  ⚠️ **Owner-initiated cancellation is still absent** (portal/admin — different
  actor, different auth), as is any re-fill or waitlist behaviour. **There is no
  undo, by design**: the slot is gone the moment it commits and another patient
  can take it, so an undo would be a promise the index cannot keep.
  ⚠️ **No owner-facing surface lists cancellations.** `adminRoutes.js:288` passes
  `a.status` through and `public/admin/appointments.html:104` renders only
  `reminder_status`, so a cancelled row looks identical to a booked one there —
  exactly as a `'rescheduled'` row already has since B2. Pre-existing, unchanged.
  ⚠️ **`clinic.js:312` — the VOICE variant of the booking-tools line drops the
  confirm-first clause its WhatsApp twin at `:313` carries.** Found here,
  pre-existing, left alone on instruction. Bounded: the prompt tail carries the
  per-tool confirm lines on every channel. Filed.
- **F1-R1 — F1's staleness fix only half worked. FIXED** (`f7e8a97`). F1 made
  the readiness formula read every storage home a persisted check measures. Two
  of that union's three legs read `max(created_at)` on tables that carry no
  `updated_at` and no trigger, so **a timestamp that can only be set at INSERT
  can only rise at INSERT.**
  **Three real writes were invisible, and all three are in-place UPDATEs.**
  Editing a FAQ (`knowledgeService.updateChunk` — 0.7 checked this specifically,
  it is an `UPDATE`, **not** delete-and-reinsert, so `created_at` genuinely could
  not move), editing a doctor's schedule (`doctorService.updateDoctor`), and
  **ARCHIVING a doctor** (`doctorService.setArchived` flips `type` with an
  UPDATE; reached from the portal's `DELETE /api/doctors/:id` on the
  has-appointments branch).
  ⚠️ **The archive is the sharp one and it was found in Phase 0, not planned.**
  It is how an owner takes a doctor OUT of booking: the register shrank while
  `doctor.schedule` kept reporting the verdict it reached when that doctor was
  still bookable — the ring reading one check **higher** than the truth. This is
  F1 inverted. F1 was "you did the work and the portal says you didn't"; this is
  "you undid the work and the portal says you're fine", on the surface that
  decides go-live.
  **Migration `026_knowledge_entity_updated_at.sql`** adds `updated_at
  TIMESTAMPTZ NOT NULL DEFAULT NOW()` to `knowledge_chunks` and
  `tenant_entities` and attaches the **EXISTING** `set_updated_at` — no new
  function; that one is defined once in `schema.sql`'s SETUP block and seven
  tables already use it. Guarded `DO $$ … IF NOT EXISTS (SELECT 1 FROM
  pg_trigger …)` form and `trg_<table>_updated` naming both follow `012`/`013`,
  the two migrations that attach this same function. `schema.sql` in lockstep,
  inline. `validationInputsChangedAt` reads `max(updated_at)` on both.
  ⚠️ **THE BACKFILL EXPIRES EVERY OUTSTANDING RUN, ONCE, AND THAT IS CORRECT.**
  `NOT NULL DEFAULT NOW()` stamps every pre-existing row with the migration
  instant, so any tenant holding a FAQ or a doctor row has its latest validation
  run go stale on the deploy. After the migration `max(updated_at)` is the honest
  answer to "when did this input last move", and for rows written before the
  column existed that answer is genuinely unknowable. A stale run costs a
  re-check, never a wrong verdict. Zero production tenants at this commit, so the
  real blast radius is the shared dev database.
  ⚠️ **STILL OPEN — the DELETE half, filed and deliberately not built.** Removing
  a FAQ **lowers** `max(updated_at)`, so deleting the 5th FAQ takes a clinic below
  `kbMin` while the run still reads fresh and the ring still reports the old,
  higher verdict. **No timestamp column fixes a max() that falls.** Two candidate
  signals for whoever picks it up: a tenant-level touch on delete, or a row count
  carried in the union beside the timestamp. Bounded meanwhile — `runGoLiveChain`
  re-validates at the press, so a clinic that has actually fallen below the
  minimum is still refused; what is exposed is the ring and the admin panel's
  separate activate path. Documented at the fix site, not only here.
  ⚠️ **The union's three legs are maintained by TWO mechanisms and the query does
  not show which is which** — `tenant_configs.updated_at` has no trigger,
  `configService` writes it explicitly; the two new columns are trigger-
  maintained. Recorded in both the migration and the helper, because the next
  reader will assume all three work the same way.
  **Four `created_at` readers were found and deliberately LEFT ALONE**:
  `knowledgeService.listChunks` (`ORDER BY created_at` — the FAQ list order),
  `doctorService.listDoctors` (`created_at` as the third-level tiebreaker under a
  name sort), and `created_at` on the FAQ API payload. Moving any of them to
  `updated_at` would reshuffle a register every time a row was edited.
  **Lockstep proven by construction, not by reading**: a genesis DB (new
  `schema.sql`) and a migrated DB (HEAD's `schema.sql` + the real `026` executed
  by the runner, every other file stamped) agree byte-for-byte on the columns,
  triggers and indexes of both tables, and both triggers resolve to
  `set_updated_at()`. Genesis records `026` as **stamped**; the migrate path
  records it as **run**. Re-applying `026` to a database that already has the
  column and both triggers is a clean no-op, so the file is re-runnable.
  ⚠️ Editing this migration's comment **after** applying it tripped `db:status`'s
  checksum-mismatch warning, exactly as designed. Cleared by unrecording the row
  and re-running, which is also where the idempotency above was proved.
- **B2 — a patient could book but not move. FIXED** (`c1e671f`). The portal has
  recited a reschedule policy since `PORTAL-P3-S9` that the receptionist could not
  act on — a settings page describing behaviour that did not exist, which is the
  F-006 class.
  **THE UNIQUENESS DECISION (option C, founder-ruled).** `uniq_doctor_slot` is a
  partial unique index `ON appointments(tenant_id, doctor_name, appointment_time)
  WHERE status = 'booked'`, so the old row's post-move status is what decides
  whether its slot frees. A move now writes a **NEW row with `status = 'booked'`**
  and flips the **OLD row to `'rescheduled'`**. The old row leaves the index the
  moment it flips; the slot is bookable again with **no index change at all**.
  ⚠️ **Every existing reader of this column filters POSITIVELY on `= 'booked'`**
  — `checkAvailability` (`appointmentService.js:237`), `reminderCron`'s claim
  query (`:98`), `scriptedTurnCheck.bookedAppointment` (`:159`) — so a superseded
  row is correctly excluded from all three with **zero changes to any of them**.
  `adminRoutes.js:288` selects `a.status` unfiltered and `public/admin/
  appointments.html` never renders it (its badge map is `reminder_status`), so no
  UI shows an unmapped value. `doctorService.hasAppointments` was already
  status-agnostic.
  ⚠️ **`reminderCron.js:98` was the one query that would have misbehaved
  SILENTLY** — had the row the patient actually holds carried anything other
  than `'booked'`, they would never be reminded, with no error, no log line and
  no failed status. It agrees with the index rather than fighting it, and it is
  why the NEW row is the `'booked'` one. The rejected alternative (UPDATE in
  place) was rejected on this axis: it needs **all five** reminder columns reset
  by hand and **four of the five fail silently if forgotten**, whereas a new row
  takes the column DEFAULTS, which *are* the correct reset. Correctness that
  cannot be bought back outranks atomicity that can.
  **Schema: one CHECK widening** (`025_appointment_rescheduled_status.sql`),
  `007`'s DROP/ADD pattern, plus `schema.sql` in lockstep. No column added, no
  index touched. The constraint is declared inline and unnamed in `003` and in
  `schema.sql`, so both the migrate path and a fresh genesis converge on
  `appointments_status_check`.
  **THE PRICE, paid: one explicit transaction.** `db.getClient()` +
  `BEGIN`/`COMMIT`/`ROLLBACK` on ONE connection, **INSERT the new row FIRST**.
  Two pooled `db.query` calls would be two independent transactions on two
  connections, and the failure mode is not theoretical: release the old slot,
  lose the race on the new one, and the patient holds **no appointment at all**.
  Inserting first means a 23505 rolls back with the original intact. This is
  load-bearing for Issue 29: `aiService.js:240-243` flips the point of no return
  only **after `executeTool` returns**, so "threw" must mean "committed nothing"
  — a guarantee that held until now only because booking was a single INSERT.
  Asserted with a **forced interleaving**, not a sleep: a rival booking is
  INSERTed uncommitted, the move blocks on the index, then the rival commits.
  **ONE validation path, and this was the session's most important structural
  change.** Gates 1–10 of `bookAppointment` — parse, past, `resolveBookingRules`,
  `evaluateDay` (past date / same-day / advance window / holiday / closed day),
  clinic hours, `buffer_minutes`, doctor match, doctor day off, doctor hours,
  **slot grid** — are extracted into `validateSlot`, which both write entry
  points call. `bookAppointment` = validate + INSERT; `rescheduleAppointment` =
  validate + (INSERT new, supersede old) in the transaction. Gate 11's
  patient-name backfill stays booking-only (it is not a validation); gate 12's
  23505 recovery is preserved **verbatim on both paths** — it is the only thing
  between two concurrent writers and a double-book. The extraction is
  **behaviour-preserving and the proof is that every pre-existing booking test
  passes untouched**: `slotGrid.unit.test.js` and `bookingRules.unit.test.js`
  were not edited, and no assertion moved.
  **The lookup is the ERROR, by design.** `reschedule_appointment(current_time,
  new_time, doctor_name?)` resolves the appointment server-side from
  `(tenant_id, customer_id, appointment_time)`. There is **no second tool and no
  appointment UUID in Gemini's context** — same discipline that kept the
  patient's phone out of B1's tool response: an identifier the model can read
  back to a caller eventually will be. `appointment_id` is deliberately **absent
  from the reschedule return** (asserted), while `bookAppointment`'s pre-existing
  one is untouched. An ambiguous reference returns `appointment_not_found`
  carrying the caller's **real upcoming appointments**, soonest first, so the
  refusal performs the lookup. **No fallback guesses the nearest appointment** —
  never invent a slot, same discipline as never inventing a price. A
  `same_slot` refusal catches "move it to the time it already has", which
  `uniq_doctor_slot` would otherwise report as `slot_taken` — true, and actively
  misleading, since the someone-else who took it is them.
  ⚠️ **THE OWNER ALERT — B1's recorded expectation was WRONG and is corrected
  below.** Under option C, `'rescheduled'` lands on the **superseded** row, which
  nobody is alerted about; the alert describes the **new** row, whose status is
  `'booked'`. So a move would have rendered **identically to a fresh booking**.
  That is worse than cosmetic: the receptionist would not know a slot had just
  freed, and could reasonably conclude the patient had booked twice.
  `formatOwnerBookingAlert` now carries **two shapes in one function** —
  `Appointment moved — {doctor}` with `Was:`/`Now:` replacing `Date:`/`Time:`.
  `Was:` leads because the freed slot is the actionable fact. Both instants use
  the same IST convention **recombined into one call** (`reminderCron.js:147`'s
  exact string) rather than split, because a move is read by comparing two
  instants and two four-line blocks would mean diffing eight fields. `Status:`
  still reads the COLUMN on both shapes. The move is **DECLARED** by a
  `rescheduled` flag, never inferred from the presence of a previous timestamp —
  a malformed field must not silently downgrade a move back into the shape this
  branch exists to prevent (asserted).
  ⚠️ **`type` stays `'appointment_booked'` on a move, and this is load-bearing,
  not laziness.** `scriptedTurnCheck` identifies the probe's own notifications by
  an **id diff scoped to exactly that type** (`:174-181`) and re-counts residue
  with the same predicate (`:227`). A second type would be invisible to both, so
  the probe would leave a row behind **and report a clean zero** — a leak its own
  leak-detector could not see. One function, one type; `turn.scripted`'s contract
  and cleanup topology are otherwise unchanged (a new tool declaration is not a
  new check, and `RESIDUE_TABLES` counts appointments with no status filter, so a
  superseded row would be caught if it ever leaked).
  ⚠️ **Two PRE-EXISTING voice-path exposures, filed not fixed — they are not
  this session's.** (a) `generateReplyStream` (`aiService.js:363-384`) has **no
  point of no return at all**: abort is checked before every tool
  unconditionally, by explicit decision ("unify when SSE goes live"). It is dark
  (`VOICE_STREAM_TURNS=false`). (b) `aiService.js:376` calls `executeTool` with
  **four arguments**, so `channel` defaults to `'whatsapp'` and the
  `channel === 'test'` gate does not apply on that path. Both have applied to
  `book_appointment` since PR9C; `reschedule_appointment` inherits exactly the
  same shape and adds no new exposure class. It carries the same `test` gate on
  the JSON path.
  **Cancellation as a patient-facing tool is still absent and is filed, not
  built.** `status = 'cancelled'` has existed since `003` and no tool, route or
  portal control writes it. Separate issue.
  ⚠️ **An existing dev or test database needs `npm run db:migrate`.** The shared
  test database was one migration behind and failed with
  `appointments_status_check` until it was applied; scratch-DB suites were green
  throughout because genesis reads the updated `schema.sql`. Normal migration
  contract, recorded because it is the first schema change in some weeks.
- **B1 — the owner booking alert was half a message sent to nobody. FIXED**
  (`29f95d6`). Two defects in one path, and the second one meant the first was
  academic.
  **A — the payload.** `New appointment: {name} with {doctor} at {time}` carried
  three fields. It now carries five, labelled, one per line, with the doctor on
  the title row: patient name, patient **phone**, appointment **date**,
  appointment **time** (IST), booking **status**. The IST rendering is
  `reminderCron.js:147`'s convention split in two (`'en-IN'` + `Asia/Kolkata`,
  `dateStyle:'full'` / `timeStyle:'short'`) — recombining the two fields yields
  that file's exact string, asserted, so there is one convention and not two.
  `status` reads the `appointments.status` COLUMN, never a literal: today it is
  only ever `'booked'`, and B2 adds `'rescheduled'` to the same column.
  ⚠️ **CORRECTED at B2 — the second half of that sentence was wrong in a way that
  mattered.** B2 does add `'rescheduled'` to the column, but it lands on the
  **superseded** row, and no alert is ever sent about that row. Reading the
  column on a move therefore yields `'booked'`, so a move would have rendered
  byte-identically to a fresh booking — leaving the receptionist unaware a slot
  had freed and free to conclude the patient had booked twice. The pass-through
  property this line records is real and still holds; what was wrong was the
  implication that a move would read differently **because of it**. It reads
  differently because B2 gave the function a second shape. See the B2 entry.
  ⚠️ **`bookAppointment` was already fetching what was missing and dropping it.**
  `RETURNING id, doctor_name, appointment_time, status` (`appointmentService.js:335`)
  then returned neither `appointment_time` nor `status` — so date/time splitting
  and the real status cost **zero extra reads**. The patient's phone did need
  threading: it is on the hydrated `customers` row the turn already holds, so
  `executeTool` now takes `customer` rather than `customer.id`.
  ⚠️ **The phone was deliberately NOT added to `bookAppointment`'s return.** That
  object is serialised into the model's tool-response, so a phone there enters
  Gemini's context and can be read back to the caller — a data-exposure change
  wearing a formatting change's clothes. Proven at runtime: across a real booking
  the model received 3 payloads, none containing the number, and the `turn_traces`
  row does not contain it either.
  **B — the recipient, and why nobody was ever alerted.** The send read
  `tenants.owner_notify_phone`, a column **no production path has ever written**:
  the only writers in the repo are `scripts/seed-schedules.js` (dev, and it writes
  a `phone_number_id`, which is not a phone) and a workflow test fixture. Both
  real create paths — the Issue 15 provisioning CLI and the portal's Safety &
  handoff page (`portal/routes.js:1395`) — write `config.notifications.owner_numbers`.
  **So on the first real tenant every booking alert would have taken the
  `no_phone` branch and no owner would ever have been notified.**
  `notifications.owner_numbers[0]` is now the single source of truth. The column
  is a **deprecated fallback**, read only when the array is empty and logged as
  such when it fires — kept because a dev or legacy tenant carrying only the
  column would otherwise go silent on the switch. It is **untouched elsewhere** and
  stays live for owner-command *authentication* (`whatsapp/routes.js:97`), the
  human-handoff forward (`:163,168`) and the `notify_owner` workflow action
  (`core/coreActions.js`) — none of them notification recipients. Retiring it
  entirely means moving an auth predicate, which is its own issue.
  **`notifications.on_booking` is honoured.** Declared since Issue 8, defaulted
  true, and read by nothing anywhere until now. `false` ⇒ no send and a
  `sent_status` of `skipped_disabled`, so the skip is visible in data on the
  `no_phone` pattern. No migration: `notifications.sent_status` is free `TEXT`
  with no CHECK (`schema.sql:349`).
  ⚠️ **THE PROBE GUARD — the load-bearing part of this session.**
  `scriptedTurnCheck` stopped a synthetic booking paging a real owner by nulling
  `owner_notify_phone` on the tenant copy handed to the brain. Moving the
  recipient into the config document **defeats that**: the config is read from the
  database by tenant id and a tenant copy cannot blank it. Since every clinic runs
  validation immediately before go-live, the un-guarded switch would have
  WhatsApp'd real owners an appointment for "Zyon Validation Probe" at the worst
  possible moment. The guard moved with the recipient:
  `notificationService.SUPPRESS_OWNER_ALERTS`, imported by the probe rather than
  spelled out there so a rename cannot silently unhook it, and checked **before
  the config is even read** so no recipient is ever resolved. `testTurnService`
  carries it too (its booking path was already hard-gated; this keeps the mirror
  true). The row is still INSERTed, with `sent_status = 'suppressed'`, so the
  probe's id-diff cleanup is unchanged.
  ⚠️ The validation probe's cleanup was **never** at risk from the content
  change: it matches by **id diff**, not by `content` text, and says so at
  `scriptedTurnCheck.js:160-166`.
  ⚠️ **The `Customer phone:` line in `aiService.buildSystemPrompt` (`:516`) is
  pre-existing and unchanged** — GUARD-01's identity guardrail is written against
  it. B1 adds the patient's phone to no NEW surface; the renderer's own guarantee
  (config in, no phone out) is now pinned by a test that also fails if anyone
  widens `renderSystemPrompt` to take a customer.
  **FILED, NOT BUILT:** `owner_numbers` is an array and only `[0]` is notified.
  Fan-out when a clinic asks for it. Two docs now describe the old behaviour and
  were left as written, being historical records:
  `docs/per-tenant-read-inventory.md:36` (Issue 9) and
  `docs/deploy/audit/2026-07-production-readiness.md:262-265`, which lists
  `notifications.on_booking` under *Inert config knobs*.
- **F3 — the onboarding wizard had no way out, and the login page's reset
  promise named no channel. BOTH FIXED** (`3b4cab8`). Two small issues from
  the portal-v1 §11 acceptance run, which otherwise **PASSED**: under 45 minutes
  on a phone, unaided, faster than pre-redesign.
  **A — "Save and finish later" (spec §3.8).** Progress was ALREADY persisted
  and always had been: `persistStep` writes `meta.onboarding_step` from `goTo`
  on every transition, and `main()` resumes from it on boot. Close the tab at
  step 5, sign back in, land on step 5. What was missing was only the control,
  so this is a button rather than a mechanism. It sits on the step-label row —
  the wizard's own top right, above the card, in the first viewport at 380px
  (measured: bottom at 269px of an 820px viewport, 165×44) — and NOT in the
  `.top` bar, which at 380px already carries burger + lifecycle + avatar and
  hides `.kbd` for want of room. Three cases: not-a-form or clean card leaves
  with no request at all; a dirty card saves through the step's OWN
  `form.requestSubmit()`, the same call Continue makes; a rejected save keeps
  the owner on the step with the page's inline field errors and everything
  typed intact. Dirty is read from `save-note--dirty`, the class the embedded
  page already writes and `shell.js`'s sticky save bar already observes — no new
  contract, and `wizard.js` still calls exactly two routes.
  ⚠️ **A pre-existing defect in `watchIframeSave` had to be fixed for any of
  this to work, and it was shared with Continue.** The watcher polled
  `saveBtn.disabled` every 120ms; a validation 400 is refused before the query
  runs and opens and closes that window in single-digit milliseconds, so
  `sawBusy` stayed false, the watcher sat out its full 20-second timeout and
  reported a REJECTED save as a HUNG one — a "taking a while" toast instead of
  the field error, twenty seconds late. Nondeterministic by construction: the
  same rejection on the same page reported correctly or not depending on where
  the sampling grid fell, and both outcomes were observed in consecutive runs.
  **Present since S16.** Proven not to be this session's by driving Continue
  through the identical rejection (`scripts/portal/f3.js` keeps that control
  run). Now a `MutationObserver`, which cannot miss a transition — a finer poll
  would have narrowed the window and kept the bug. `sawBusy` seeds from live
  state because `requestSubmit()` dispatches synchronously, so the busy flag is
  already set by the time the observer attaches.
  **B — login copy, one line.** `public/portal/login.html` read *"Forgot your
  password? Message Prantivo on WhatsApp to reset it."* — accurate and a dead
  end, naming a channel with no way to reach it. It now carries a `wa.me` link
  with a prefilled message, on the founder's number (`918309177158`, the same
  one `web/lib/siteConfig.ts:72` publishes for every marketing CTA; inlined
  because login.html is served statically and cannot read an env var). The
  surrounding block also moved off `--faint`, whose own token comment says
  "non-text only (2.8:1)" — a reset line an owner cannot read is not a channel.
  ⚠️ **No self-serve reset was built and none should be**: 0.3 confirmed zero
  email transport anywhere in the repo (no `nodemailer`/`sendgrid`/`smtp`/`ses`
  in `src/`, `scripts/` or the nine runtime dependencies), so a token flow would
  mean a transport, issue-and-expiry and a reset route — several sessions,
  before a single paying customer.
  ⚠️ **F3-R1 filed (open): the copy promises a reset no operator surface can
  perform.** `POST /admin/api/tenants/:id/owner` (`adminRoutes.js:791`) CREATES
  an owner account and **rejects with 409 when one already exists** (`:813-815`,
  with the `23505` backstop at `:829`). There is no `UPDATE users SET
  password_hash` anywhere, no delete/deactivate-user route, and no
  password-change route on either surface — the only other writes to `users` are
  `last_login_at` and the session lookup. The route's own header says it: *"a
  reset today is a deliberate operator action against a removed account, not
  this route"*, and removing the account means hand-editing in `psql`. Not fixed
  here (out of scope); the cheapest honest fix is an operator "reset password"
  action reusing `generateTempPassword` + `hashPassword` on the existing row.
  ✅ **CLOSED at F3-R1** (this commit) — see the F3-R1 entry at the top of this
  section. The predicted fix was right about the mechanism and **incomplete about
  the danger**: reusing `generateTempPassword` + `hashPassword` on the existing
  row is exactly what shipped, but on its own it would have left every live
  session authenticated, because `requirePortalAuth` never re-reads
  `password_hash`. Migration `027`'s session epoch is the half this line did not
  foresee.
  Evidence: `scripts/portal/f3.js` (scratch DB → genesis → real routers → CDP at
  380×820; the walk to step 5 and every exit are real clicks) and
  `scripts/portal/shots/f3-{wizard-step5-mobile,wizard-invalid-exit-mobile,wizard-invalid-exit-field,login-mobile}.png`.
- **F2 — the Test page's composer locked after one message. FIXED** (`9f17517`).
  Reported from the same acceptance attempt as F1: the first test message sends
  and replies, the counter reads 19 left, and the composer and Send are dead
  from then on. It blocked step (f) of portal-v1 §11, which needs a second
  message to confirm an edited price is quoted.
  **The cause was one line, and it was never the quota.** `sendQuestion`
  disables the composer on entry as the page's only double-submit guard
  (`test.js:130`); its `finally` then re-enabled only `if (!input.disabled)` —
  false on every path, because that same function had just set the flag true.
  One flag was carrying two meanings, "busy" and "out of messages", and the
  release point asked it the wrong question. It now clears against `exhausted`,
  set only where the cap is actually detected (`updateRemaining`'s `n <= 0`
  branch). Display and disable were always reading the same field; there was no
  off-by-one.
  ⚠️ **Present since the page's first commit** (`8b7c093`, 2026-07-21) — a
  behavioural bisect at `bde2aee~1` reproduces it identically, so D5a did not
  cause it despite touching this file. **The Test page has never sent a second
  message.** `git log -L` confirms neither block was edited after birth.
  ⚠️ **Why six weeks of harnesses missed it.** `sending` *does* clear in that
  same `finally`, so any driver calling `form.requestSubmit()` submits straight
  through the disabled controls and reports a working page. The bug is only
  visible to a probe that respects `disabled` the way a person does. The repro
  driver was wrong in exactly this way on its first run and reported a pass.
  Verified against a real portal and a real brain over CDP: 20 consecutive sends
  with the composer usable after each; the cap guard still firing at 0 with its
  reason visible and refusing sends 21–22 client-side; a rapid double-click
  issuing one request, not two; a forced 400 leaving the composer usable.
  ⚠️ **`Portal.setBusy` is NOT involved** — Test hand-rolls its busy state and
  uses only `Portal.toast` and `Portal.me`, so the seven pages that do use
  `setBusy` are unaffected and were not touched. The starter buttons are also
  disabled without a re-enable, and that stays: they live inside `#chatEmpty`,
  which is hidden from the first message onward, so they are unreachable rather
  than dead. Adding a second release path would have masked this bug rather than
  fixed it; a test now asserts there is exactly one.
  ⚠️ Tests are **source-shape** assertions, not DOM behaviour: `test.js` is a
  browser IIFE with no exports and the repo has no DOM library in its dependency
  tree. The behavioural proof is the CDP run, which lives in the session record
  and not in the suite. `tests/portal/portalTestComposer.unit.test.js`, 4 tests
  / 1 suite; two of the four fail against the pre-fix file (checked by stashing
  it), the other two are the constraint guards.
- **F1 — readiness did not reflect the FAQ count. FIXED** (`007f697`). Reported
  from the portal-v1 §11 acceptance attempt: six FAQs on file, Home reporting
  9/10 and *"Add at least 5 FAQs or upload one document"*, and **no Go-live
  control rendered at all** — so the acceptance run could not complete.
  **It was never a counting bug.** `checkKbPopulated`
  (`validationService.js:210-216`) counted correctly at every point and its
  boundary is exact (4 fails, 5 passes, re-proved this session). The run simply
  **predated the FAQ writes** — 906 ms, in the reproduction — and the portal
  reported that expired run as CURRENT, because staleness was computed from
  `tenant_configs.updated_at` alone while FAQs live in `knowledge_chunks`. A FAQ
  write moved the thing `kb.populated` counts without moving the measurement.
  With `run.passed` false and `run.stale` false, `deriveGoLive` (`shell.js:304`)
  returns ineligible and `renderLifecycle` emits a status object rather than a
  button: **go-live was unreachable and nothing on screen said why.**
  ⚠️ **The formula was WRONG IN TWO PLACES, not one.** `lifecycleService`'s
  `STALE_VALIDATION` activation guard carried its own copy of it, while
  `routes.js` claimed in terms that the two "can never disagree". Both now read
  one exported helper, `lifecycleService.validationInputsChangedAt`, whose union
  covers every storage home a persisted check measures:
  `tenant_configs.updated_at`, `max(knowledge_chunks.created_at)` (kb.populated /
  kb.retrieval), `max(tenant_entities.created_at)` (doctor.schedule /
  turn.scripted). One query, three tenant-scoped lookups, replacing the single
  query it grew out of — the readiness read is still three queries.
  ⚠️ **SUPERSEDED at F1-R1: the last two legs now read `max(updated_at)`, not
  `max(created_at)`.** The union's *shape* — three lookups, one query — is
  unchanged and the two column names above describe the commit this entry names.
  Neither table had an `updated_at` when F1 shipped, which is why it read
  `created_at`; that was the half of F1 that did not work. See the F1-R1 entry.
  ⚠️ **`tenants.updated_at` is deliberately EXCLUDED** even though
  `whatsapp.config`/`live` and `tenant.legacy_prompt` read that row: `writeStatus`
  UPDATEs `tenants` and the table has a `BEFORE UPDATE` trigger, so including it
  would bump the timestamp past the very run that just succeeded and mark every
  validated tenant permanently stale. Those columns are operator-written anyway.
  New **`POST /portal/api/readiness/check`** — the validate half of the go-live
  chain, on the owner's surface. It calls `validationService.validateTenant`
  directly rather than `transition(id, 'validate')`, because `doValidate` writes
  `status='validated'` on a pass; `validateTenant` persists the run and touches
  nothing else, so this route **cannot move a receptionist between states**
  (asserted). Session-scoped (INV-1), no options argument at all (INV-3), its own
  10/hour budget so re-checking cannot exhaust the go-live budget.
  **`run.stale` had been in the payload since S18 and NOTHING rendered it.** Home
  now states the condition and offers *Check again*; the header control becomes
  *Setup changed* + *Check & go live* rather than a bare *Go live* identical to a
  passing run. No auto-refresh on load, deliberately — it would hide the
  mechanism and spend a Meta ping plus a model turn on every visit to Home.
  **Decision recorded: validation is NOT re-triggered on FAQ/doctor write.** A run
  costs a Meta API ping and a live model turn (`turn.scripted`); firing that on
  every CRUD write is worse than the bug. The portal re-validates at every go-live
  press regardless, so the dangerous direction is already caught server-side.
  Evidence: `scripts/portal/f1.js` (scratch DB → genesis → real routers → CDP;
  the re-check is a real click on the rendered button) and
  `scripts/portal/shots/f1-{before,after,before-mobile}.png`.
- Audit findings closed: **F-001** (`2d5da98`), **F-003** (`d22dfc5`), **F-003b** (`7a505a6`),
  **F-004** (`e071f69`), **F-005** (`e15bbae`), **F-006** (`58aa1d5`), **F-007** (`d914649`),
  **F-010** (`ba45acc`). Open: F-002, F-008, F-009, F-011 – F-017.
- **Portal v1: COMPLETE.** Sessions S1–S18 merged to `main` (`cdc532e` … `9820685`).
  Two apparent holes in the sequence are not holes: **S7 landed under its finding
  identifier as F-006** (`58aa1d5`) — `docs/specs/portal-v1-spec.md` §10 defines S7 *as*
  the F-006 enforcement session — and **S12 (PDF upload) was deferred to v1.1**, which
  §10 explicitly authorises ("or defer to v1.1 and ship FAQ-only").
- Demo: DEMO-00 (real Sarvam Telugu booking fixture), DEMO-01 (two-pane patient thread
  proof surface), DEMO-02 (inbox + clinic snapshot).
- **Portal v2 Batch 1 is COMPLETE.** Six sessions, one issue each, `869 / 151 / fail 0`
  throughout — the count never moved, which was the plan's own signal that no session
  touched behaviour (`docs/specs/portal-v2-batch1.md` §5).

  | Session | Commit | What landed |
  |---|---|---|
  | D1 | `8559f19` | Tokens, self-hosted Noto Sans, token-drift guard |
  | D2 | `ae5e607` | Grouped navigation, top bar, lifecycle control, `⌘K` |
  | D3 | `be4c1e0` | Truth strip, readiness grouping, empty/loading/error sweep |
  | D4 | `08f2fa4` | Verbatim preview panel |
  | D5a | `bde2aee` | Component sweep, transitional teal tokens retired |
  | D5b | `bfdce87` | Table styles, tabular figures, mobile pass |

  **Outstanding — NOT closed by Batch 1.** Both are acceptance obligations, not
  new work, and neither is dischargeable from a keyboard in this repository:

  - **The portal-v1 §11 acceptance run is UNATTEMPTED.** `docs/specs/portal-v2-batch1.md`
    §5 defines batch acceptance as re-running that criterion end to end on a fresh
    tenant — operator creates an owner account, the owner completes the wizard **on a
    phone, unaided, in under 45 minutes**, readiness reaches green, Go live, then a
    treatment price is edited and the Test page quotes the new price on the next
    message — and the redesign is successful only if that run is *faster* than before.
    **Batch 1 is COMPLETE but not ACCEPTED until it passes.** If it comes back slower,
    §5 reopens D5 and names the sticky save bar and the table→card conversions as the
    suspects.
    ⚠️ **The run has now been ATTEMPTED AND PASSED — founder-reported, 2026-08-03.**
    Under 45 minutes on a phone, unaided, and **faster than pre-redesign**, which is
    the comparison §5 makes the redesign's success conditional on. So D5 does not
    reopen and the sticky save bar and table→card conversions are cleared.
    ⚠️ **This is founder-supplied, not repo-derivable** — the criterion is a human,
    on a phone, unaided, timed, and no timing artefact exists in the repository.
    No wall-clock figure was reported beyond "under 45 minutes".
    **Three earlier attempts produced defects that had to be fixed first**, each a
    hard stop in its own way: **F1** (six FAQs on file, no Go-live control, no
    explanation — the criterion could not be run to completion), **F2** (the Test
    page's composer died after one message, blocking step (f), which needs a second
    message to confirm an edited price is quoted) and **F3** (no way out of the
    wizard; a dead-end reset promise). All three are fixed and above.
    **Issues 3, 4 and 5 from the acceptance report are NOT yet filed here** — the
    §11 run raised five and only F1–F3 have been worked. ⚠️ Their content is not in
    the repository; whoever picks them up should get them from the founder before
    scoping.
  - **Telugu on a real Android device.** D4's DoD asks for it in terms ("verified on a
    real Android device, not an emulator"); D4 had no device and verified headless
    Chrome on Windows only, at 19/34 and 34/58. Conjuncts, matras and inline Latin
    digits were correct with no tofu, and the rupee sign was asserted objectively via
    `CSS.getPlatformFontsForNode` — but the device check itself is outstanding.

- **Portal v2 Batch 1: D5b landed** (harness `shootD5b.js`). Table
  rules, tabular figures, table→card below 640px, the sticky mobile save bar and
  the 320px sweep. Suite **869/151/0, unmoved**. Every changed path is under
  `public/portal/` bar the evidence harness. No route, no fetch, no dependency,
  no build step, **no test changed**.
  ⚠️ **The session's real finding was not a table.** `tokens.css:474` —
  `.ts__a { margin-left: 26px; flex-basis: 100% }` inside `.ts { padding: 9px
  16px }` — put a horizontal scrollbar on **eleven of the twelve navigation
  destinations**, at 320px and at 380px. `flex-basis: 100%` resolves against the
  flex container's *content* box and the margin is added on top, so the overflow
  is exactly `margin-left − padding-right` = 10px at every width. Shipped in D3;
  invisible for two sessions because no width measurement existed. Home measured
  clean only because D5a had suppressed the not-live strip there. **Baseline
  1/12 pages clean → 12/12 after.** The 640–767 band is measured too (7 pages ×
  3 widths, zero overflow), not argued from the content column's max-width.
  ⚠️ **`.golive .btn` was pinned to 32px** — the go-live control, the most
  consequential button in the product, was the smallest touch target on a phone.
  One of eight sub-44px targets found by measuring every interactive box on all
  twelve pages rather than the two the session required; the others were
  `.segmented__btn` (28), `.pace__slider` (20), `.switch` (20), `.starter` (41),
  `.ts__a` (21), `.top__burger` (38) and `.know-edit` (31 wide). `.switch`'s own
  comment claimed *"the hit area stays 44px via the label"* while its label
  measured 72×20.
  ⚠️ **Two elements the portal DELETED on mobile rather than laying out, both
  restored:** the `Past` badge on a holiday row (`hours.css:152`), the only thing
  explaining why a row is dimmed; and `.check__link` (`home.css:182`), the route
  to the fix on the surface that decides go-live, hidden on the exact device
  portal-v1 §11's 45-minute criterion is measured on — a mobile owner saw which
  check was failing and had no way to act on it. `.check__link` was also
  `--faint`, **2.8:1 on `--card`**, a step the token's own comment marks
  "non-text only"; it is `--teal-700` now.
  **No `.tb` component was built, deliberately.** There is no `<table>`,
  `<thead>` or `role="table"` anywhere in `public/portal/` — every register is
  div rows and each page owns its row class. A shared table class with no
  consumers would have been exactly the dead code `.tnum` had been since D5a
  (declared, and used only inside the evidence harness). `.tnum` is now the one
  block carrying tabular figures for all 25 numeric sites, with seven scattered
  copies folded in. It needs `!important`: `font:` resets
  `font-variant-numeric`, this portal's whole type scale is font shorthands by
  design, and three of the clobbering rules live in stylesheets that load after
  `tokens.css`.
  ⚠️ **Deviation from spec §3.3, recorded:** Pricing keeps INLINE editing on
  mobile — no bottom sheet. §3.3's rationale is that "inline cell editing on a
  phone is not viable", meaning click-a-cell-in-a-grid; this page never shipped
  that, `PORTAL-P2-S6` chose full-width stacked inputs on purpose, and a sheet
  would hold the same inputs the card already shows. The card form ships
  otherwise as specified. ⚠️ **Breakpoint is 640, not the spec's 768** — 768
  appears nowhere in this portal (860/640/560/520/480), and 640 sits inside
  §2.12's own `480–767` *tables → cards* band.
  ⚠️ **F-V006 filed** — the Verbatim panel's collapsed mobile sheet overlaps the
  last ~57px of page content when the card is clean; nothing pads for it.
  Pre-existing in D4. Its *other* half is fixed: the sheet was also covering the
  new save bar, and now yields to it.
- **Portal v2 Batch 1: D5a landed** (harness `shootD5a.js`). The shared component
  layer plus the six worklist items accumulated across D1–D4. Suite **869/151/0,
  unmoved**. Every changed path is under `public/portal/` bar the evidence harness.
  No route, no fetch, no dependency, no build step; **no test changed** — D5a's
  Phase 0 checked whether any test asserts the not-live condition's page coverage
  and none does, so the one permitted edit was never spent.
  **D5 was SPLIT.** D5b closed the remainder — see the D5b bullet above.
  ⚠️ **`--teal-hover`/`--teal-press` are GONE**, closing the transitional state D1
  opened. This was the session's real visual risk and it did not resolve the way
  the plan predicted: of the 17 consumers only **one** was a button-fill hover,
  two more were text-colour hovers, and the other **fourteen were resting or
  *selected*-state text colours** that the word "press" fitted only by accident.
  Those took `--teal-700` (the accent on the light ground), not `--teal-900`.
  A blanket replace would have darkened six selected-pill treatments that were
  never a press state. Recorded in `docs/design/brand-values.md` under
  *Not compared*, with the lesson stated: a token parked by a mechanical
  migration records where a value **was**, not what it **means**.
  ⚠️ **The portal had no global focus ring before this commit.** The plan called
  `H` a "retune" of two cited lines; both citations were stale and the real
  inventory was five component-local rules, with every button, link, nav item,
  truth-strip action and modal close falling through to the browser default.
  `booking-rules.css` was additionally stripping the outline and replacing it with
  a colour-only tint — forbidden by spec §2.11 — while the second copy of the same
  toggle in `safety.css` did it correctly. One `:focus-visible` rule now covers the
  portal; the ink ground keeps its own in `verbatim.css`.
  **F-V004's contradiction is CLOSED** (its missing-endpoint half stays open). On a
  legacy clinic the Verbatim panel called itself *Live preview* beside a pulsing
  teal dot while the truth strip 40px above said those settings were not reaching
  the receptionist. The header now reads `Saved settings` and drops the dot,
  sourced from the same `run.checks` field `shadow-notice.js` reads through the same
  shared readiness promise — no new fetch. Photographed with the amber strip in one
  frame, against a clean-tenant control.
  Also: the not-live strip is suppressed **on Home only** (the ring and the grouped
  checks say it better and more specifically; the legacy and paused conditions still
  fire everywhere including Home) · the last two card shadows (`.doc`, `.faq`) are
  gone · `.modal` moved to `--shadow-lg` (the drawer already had it; the toast
  correctly stays `--shadow-md`) · `--amber-50`/`--green-50`/`--red-50` are canonical
  with the padded names aliased, matching the teal convention · every disabled
  control now carries a visible adjacent reason · `.btn--danger` is no longer a solid
  red fill · error toasts persist with a Dismiss instead of fading out after 2.6s.
  ⚠️ **Two deliberate spec deviations, both recorded in
  `docs/specs/portal-v2-batch1.md` §3:** a busy button keeps `disabled` (it is the
  only double-submit guard on the save path, and the save discipline had to behave
  identically), and `Saved · v{N}` is not in `--mono` (the version is written with
  `textContent` by ten scripts; wrapping it means touching the save call).
  ⚠️ **F-V005 filed** — the Verbatim panel can contradict itself on first paint
  (a warning computed from an unfilled form, beside a FACTS row falling back to the
  saved value). Pre-existing in D4, **not** a D5a regression. Observed once;
  a scripted probe mirroring the shot's conditions returned 0/12, so the frequency
  is unestablished and the probe is retained as a reported diagnostic.
- **Portal v2 Batch 1: D4** — the **Verbatim preview panel**, the
  product's signature surface and the largest new one in Batch 1. New
  `public/portal/verbatim.{css,js}`, mounted on the eight editing pages plus Test
  (nine mounts), absent from Home, History and `knows.html`. Suite **869/151/0,
  unmoved**. Every changed path is under `public/portal/` bar
  `scripts/demo/fetch_fonts.js` (F-V001's generator, above) and the evidence
  harness `scripts/portal/shootD4.js`.
  **It reads `GET /portal/api/knowledge-summary` — an existing owner-scoped route,
  the one `knows.html` already consumes.** No route, endpoint, dependency or build
  step was added, and the panel has no write path of any kind: zero inputs, zero
  forms, no `configService` call. It is one added client call site, taken
  deliberately — see the next bullet.
  ⚠️ **There is no rendered-composite preview endpoint under `/portal/api/`, and
  the panel therefore shows STORED state, not what the renderer will emit.** All
  36 portal routes were walked; `knowledge-summary` is explicit that "their
  returned prompt TEXT never crosses this route". So the greeting bubble shows the
  clinic's saved greeting rather than a rendered turn. Filed as **F-V004**.
  ⚠️ **`knows.html` is NOT a subset of the panel and is RETAINED.** It carries
  whole-config breadth in one view and the built-in-protections card, which quotes
  verified guardrail instructions the panel never shows. The panel links to it
  ("See all"). This closes the question spec §1.3 left open for D4; `knows.html`
  was not modified and is not retired in D5.
  **The panel ships zero product-authored Telugu or Devanagari.** Every vernacular
  string in it is tenant-authored; empty states are English. The native-review gate
  named in `docs/specs/portal-v2-batch1.md` §6.2 therefore does not apply to D4.
  ⚠️ **Not verified on a real Android device.** Spec §3 D4 asks for it and this
  session had no device. Telugu was verified in headless Chrome on Windows at
  19/34 and 34/58 (conjuncts, matras and inline Latin digits correct, no tofu),
  plus an objective ink-clipping measurement on the collapsed sheet's handle. The
  Android check is outstanding.
- **Portal v2 Batch 1: D3** (`be4c1e0`, harness `503cd51`). The truth strip,
  readiness check grouping, the restyled ring, and the empty/loading/error sweep.
  Presentation only — no route, no fetch, no dependency, no behaviour change; suite
  **869/151 unmoved**, and the one permitted test edit was a string swap inside an
  existing `it()` (`portalShadowNotice.unit.test.js:235`), so the count did not move.
  Every changed path is under `public/portal/` bar that one test file.
  **This closes F-F001's portal half.** The strip was built by EXTENDING
  `shadow-notice.js`, not by adding a second component — a parallel global strip
  alongside the working per-page notice would have put two amber blocks on every
  shadowed page reporting one condition; a `probe()` pass in the harness asserts there
  is exactly one. The per-page notice did not go away: it is what the strip says when
  standing on a shadowed page, and its full text is the lead of the strip's
  *What this affects* modal.
  ⚠️ **The spec's fourth strip condition, *partially connected*, was NOT built.**
  `/portal/api/readiness` carries no channel-connection state, and deriving it from the
  whatsapp/voice checks is unsound twice over: a SKIPPED `voice.config` means voice is
  switched off for that clinic rather than unconfigured, and since `voice.config` is
  material a tenant with it failing can never be `live`, so the higher-priority
  not-live condition would always win. It would have been unreachable code.
  `validationService.js` was not opened; `material: false` is unchanged.
- **Portal v2 Batch 1: D2** (`ae5e607`). Grouped navigation, top bar,
  lifecycle control, command palette. Presentation only — no route, no fetch, no
  dependency, no behaviour change; suite **869/151/0, unmoved**. Every changed path is
  under `public/portal/` (16 files; new `cmdk.js`). The flat 12-item sidebar became four
  labelled groups plus an empty `TODAY` group reserved for Tier 2, and the active nav item
  gained a 2px bar that survives greyscale where the tint alone does not.
  ⚠️ **The spec's nav drawing did not match the shipped product**, and three corrections
  were folded back into `docs/design/portal-v2-spec.md` §3.0/§1.3/§3.7 in `3275eda`:
  the portal has **12 navigation destinations, not 14** (13 sidebar rows, 13 files with the
  shell, 14 `.html` — statements about *stylesheet* coverage saying "14 pages" remain
  correct); **`knows.html` was absent from the spec's nav entirely** and is now filed under
  CHECK, the sidebar being its only inbound link; and **`Documents` returns as an inert
  `Soon` row** (no page — `PORTAL-P6-S18` had removed it; the v2 spec reverses that).
  ⚠️ The sidebar footer ships **clinic name + role, not email** — `/portal/api/me` returns
  `{ id, role }` and no address, and surfacing one needs a route.
  ⚠️ **History's snapshot is a modal, but spec §3.7 specifies a full-page sub-view.**
  Unresolved, deferred to D5 or later; the top bar's breadcrumb slot stays empty for
  exactly as long as it stays a modal.
  ⚠️ `knows.html`'s future is **undecided** — D4 Phase 0 reads it and rules on retire vs
  retain as a linked advanced view (spec §1.3).
- **Portal v2 Batch 1: D1 landed** (`8559f19`). Token layer only — no markup, no
  JS, no behaviour. `--teal-600`/`--teal-700` changed meaning (old darker-steps convention
  → standard 50–900 ramp), so their 21 consumers across 11 stylesheets were migrated onto
  transitional `--teal-hover`/`--teal-press` in the same commit; teal renders unchanged
  (verified by resolving all 610 `var()` uses before and after — zero colour deltas).
  `--sans` no longer names a face the repo does not ship: Noto Sans Latin 400/500/600/700
  is self-hosted via `scripts/demo/fetch_fonts.js`, which now takes an output directory and
  a family list. Card shadow deleted; radius tightened to 4/6/10/14. New:
  `docs/design/brand-values.md` + `tests/design/tokenDrift.test.js`, which bind the four
  `:root` surfaces (portal, demo/shared, demo/styles, web) to one recorded table.
  ⚠️ D3–D5 are unstarted; `--teal-hover`/`--teal-press` are removed in D5.
- Portal v2's governing documents are now **in the repo** (`74e13e1`): the design spec
  (`docs/design/portal-v2-spec.md`), the approved Batch 1 mockups
  (`docs/design/prantivo-mockups-batch1.html`) and the 5-session plan
  (`docs/specs/portal-v2-batch1.md`). The mockups landed on disk as `portal-v2-spec.html`
  and were renamed to the path the plan's Basis line already cites. Docs only — no source
  file changed, so this is a provenance-only `Verified-at` bump.
  ⚠️ **The spec's own Status line still reads "Proposal"** while the plan and the commit
  that landed it both call it frozen. The required override exists — **D-005** overrides
  the H5 ranking §0.2 demands and carries its falsifiable prediction — so the work is
  authorised; only the Status line is stale.
  ⚠️ **D-005's budget is 10 sessions, hard cap, and 5 were spent before D1.** This line
  previously read "Batch 1 is D1–D5, so completing it lands exactly on the cap." **That is
  no longer true, and the reason is the D5 split.** Batch 1 shipped in **six** sessions —
  D1, D2, D3, D4, D5a, D5b — so the program has now consumed **11 of a 10-session hard
  cap. It is one session over.** Nobody authorised the eleventh; the split was a scoping
  decision taken inside D5 and its budget consequence was not carried back here at the
  time. Recorded rather than netted off, because a hard cap that quietly absorbs an
  overrun is not a cap.

  **SETTLED — the founder has written the overrun off.** The previous version of this
  line said the disposition was the founder's to make and that no session could treat it
  as settled until the entry existed. This is that entry, founder-supplied and recorded
  verbatim:

  > Batch 1 closed at 11 sessions against a cap of 10. Written off. The
  > eleventh was the D5 split (components / mobile), taken because a single
  > session touching every component, every register and the 320px sweep
  > produces a diff nobody can review. Root cause of the overrun is not the
  > split: four sessions were consumed by defects the plan could not have
  > listed, because the plan was written from a source-read audit and every
  > one of those defects was only findable by measuring a running portal —
  > the --teal-600/700 collision, the absent global focus ring,
  > tokens.css:474's 10px overflow, and eight sub-44px touch targets.
  > Carry forward: Batch 2's estimate is drawn from measurement, not reading.

  Written off means the eleventh session is not deducted from any future allocation and
  is not carried as a debt. It does **not** mean the cap was raised: D-005's cap stands
  at 10 and the program stands at 11 against it, on the record. The spec estimates 14–18
  sessions for the full document; **any Batch 2 needs a new decisions.md entry, not an
  extension** — D-005 says so in terms, and that requirement is now doubly binding.
  **Registered as `D-007`** (`docs/os/decisions.md`), which is the entry D-005's Budget
  clause requires. `D-006` was not free — it is claimed by the unappended `web/` deploy
  draft. D-007 carries the falsifiable prediction the write-off needs to be a decision
  rather than a preference: *Batch 2, if scoped from measurement rather than from reading
  source, comes in within its stated cap* — and if it overruns by more than one session,
  the estimating method is wrong and the cap mechanism is not the remedy.
  ⚠️ **D-007 is a write-off, not clearance.** **Batch 2 is not scheduled and nothing is
  queued behind Batch 1.** G-PROOF is still false — no production deploy, no live call —
  and D-005's terms require Batch 2 to have its own entry before a session may open it.
- **F-V001** — **CLOSED** at D4 Phase 0 on resolution path 1. `Noto Sans` now
  carries U+20B9 through four weight-distinct `text=`-subsetted faces of ~830
  bytes each (3.2 KB total), generated by a new `rupee` entry in
  `scripts/demo/fetch_fonts.js`; the ten pre-existing faces regenerated
  byte-identical and `public/demo/` was untouched. The sign and the digits beside
  it now render from one typeface at one weight, asserted with
  `CSS.getPlatformFontsForNode` against a control rather than eyeballed. Full
  finding and the `familyName`-vs-`postScriptName` trap in
  `docs/specs/portal-v2-batch1.md` §6.
- **F-V002** (open) — Variable-font duplication in `public/demo/`. Own session after
  Batch 1. See `docs/specs/portal-v2-batch1.md` §6, which now carries the
  **exclusion** that entry was missing: the four `noto-rupee-*.woff2` static faces
  F-V001 added are not duplication and must survive the consolidation unchanged.
  Folding them into a variable face silently reverts F-V001.
- **F-V004** — the **contradiction half is CLOSED** at D5a; the missing
  rendered-composite endpoint stays open. See the D5a bullet above.
- **F-V005** (open, new) — the Verbatim panel can contradict itself on first paint.
  Pre-existing in D4, found by D5a's evidence run, frequency unestablished.
  `docs/specs/portal-v2-batch1.md` §6 item 9.

### Remaining before first live call

By issue number, from `docs/specs/zyon-first-launch-plan.md`.

**Plan-of-record numbers are the only issue sequence this project has.** There is no
GitHub issue tracker in use and nothing in the repo references one, so the launch plan is
the numbering authority — allocate the next free number there. (Whether issues exist on
github.com is not repo-derivable; what is verified is that nothing in this repo cites
them.) The sequence runs to **36**, not 28: the original plan defined 1–28 and later work
kept counting.

- **Done:** 3, 4, 5, 6, 7, 8, 9, 10, **11**, 15, 16, 17, 18, 19, 21, 22, 29, 30, 31, 32, 33, 34,
  **38**, **39**, **40**
- **Not done:** 1 (ops), 2 (ops), 12, 13, 14, 20, 23, 24, 27, 28, **35**, **36**, **37**
- **Residue-only** (built and tested; awaiting Issue 20 for a prod render): 25, 26

⚠️ **11 is done but UNWIRED** — `getByDid` has no caller until Issue 12. Counting it
as done is correct and counting it as progress toward a live call is not; see the
Issue 11 entry above. **The sequence now runs to 40, not 36.** 35 (Sarvam realtime
STT) was allocated by `a797d14`'s prompt file and never written into the plan's
Phase 8; 36 (no operator surface writes `voice.did`) was filed by the Issue 11
session. Both are now recorded in `docs/specs/zyon-first-launch-plan.md` §Phase 8.
**Next free number is 41.**

⚠️ **THIS LIST WAS FOUR NUMBERS STALE, AND THE PLAN IS NO LONGER THE ONLY PLACE
NUMBERS ARE ALLOCATED.** It was last updated by the Issue 11 session (`671073c`);
37, 38, 39 and 40 were allocated and three of them closed without it moving.
Corrected here: 38, 39 and 40 are done, 37 is filed and not built. **39 and 40
exist only in `docs/os/state.md`** — neither was written into
`docs/specs/zyon-first-launch-plan.md`, whose §Phase 8 stops at 38 — so the claim
above that the plan is the numbering authority is now aspirational rather than
descriptive, and a session allocating a number must read both files.

**Issues 31–33 — verified complete (2026-07-28), was "allocated, unverified."** The
Issue-NN ↔ V-number mapping is still recollection, not a repo-written fact — no
`Issue NN` string exists anywhere in the repo for these three, and that residual is
unchanged. What this session verified is the underlying fix each number was allocated
to, independent of the numbering question:

- **31 / V-004** (terminal-transition guard on `call_sessions`, `5bb60ab`) —
  `callSessions.updateStatus` guards the terminal UPDATE on
  `WHERE status = 'in_progress'` (`src/modules/voice/callSessions.js:51-70`);
  `voiceChannelAdapter.endSession` emits `call.ended` only when a transition actually
  happened, never on the no-op path (`voiceChannelAdapter.js:69-83`). Three dedicated
  tests reproduce a sequential double-end, a failed→completed flip attempt, and a
  concurrent double-end, each asserting exactly one transition and one emission
  (`tests/voice/voiceLifecycle.integration.test.js:285-348`).
- **32 / V-008** (slot-grid validation, `629f7fb`) — `bookAppointment` rejects
  off-grid times before the INSERT (`src/modules/appointment/appointmentService.js:309-322`,
  `isOnGrid` at `:98-100`), sourced from the same `resolveBookingRules` both
  `bookAppointment` and `checkAvailability` share, so a slot never offered can never
  book and vice versa. `tests/appointment/slotGrid.unit.test.js` covers rejection,
  acceptance, grid-size variation, the IST timezone frame, and parity with
  `checkAvailability` (9 tests).
- **33 / V-009** (history excluded by id not `OFFSET 1`, `f097b77`) —
  `customerService.getRecentMessages` requires `excludeMessageId` and excludes
  `WHERE id <> $3` (`src/modules/customer/customerService.js:34-46`), threaded through
  the shared `assembleConversationContext` from both the WhatsApp and voice channels
  (`contextAssembler.js:54-56`, `internalVoice.js:184-186`).
  `tests/customer/historyExclusion.integration.test.js` reproduces the exact
  cross-channel race the old `OFFSET 1` query got wrong (a concurrent WhatsApp message
  landing mid-turn) and proves the fix keeps it while dropping only the current row.
  ⚠️ Residual: the review's recommended `id DESC` tiebreaker on the `ORDER BY` was not
  added — affects ordering among same-millisecond writes only, not the exclusion
  correctness the finding was about.

Verification this session: `node --test` on each file above (13/13, 9/9, 3/3), plus a
full `npm test` re-run clean at `95fbfde` (868/868, 151 suites — unchanged from the
recorded figure) and `npm run os:check` OK. No source file changed, so `Verified-at`
above is untouched — this commit only adds docs/os/ content.

Additions since the original 1–28, all in the plan's Phase 8:

- **29** — turn cancellation + coordinated deadlines (V-001/V-003), `1605954`. DONE.
  Referenced in 12 files incl. `src/routes/internalVoice.js:58,116,220,248`,
  `src/modules/ai/aiService.js:22,82,190,216,310`, `src/db/db.js:4`,
  `src/infra/config/env.js:59`, `tests/db/statementTimeout.test.js:3,17`.
- **30** — per-channel extraction policy (V-002), `2948a10`. DONE.
  `src/modules/config/schema.js:250`, `tests/crm/extraction.bus.test.js:94,312`,
  `tests/voice/voiceLifecycle.integration.test.js:181`.
- **34** — admin-created tenants silently ignore all portal-written prompt copy. **DONE**
  in two halves: the owner-facing warning (F-F001, `6ceb8f0`) and option (a), the removal
  of the hazard (`69ceb7f`). This is A-007/A-008 promoted to the queue. Full finding at
  `docs/specs/issue-34-legacy-prompt-shadows-portal-config.md`.
  The prompt field is gone from `public/admin/tenant-new.html` and
  `POST /admin/api/tenants` now refuses a non-empty `ai_prompt`
  (`src/admin/adminRoutes.js:104-121`) instead of forwarding it, so admin-created
  tenants are born on the renderer like `provisioningService.js:226` already did.
  **The capability was preserved, not removed** — `scripts/update-prompt.js` still sets a
  legacy prompt deliberately, and the F-F001 notice still fires for a tenant it creates
  (both proven by live run this session). `aiService.js`'s legacy precedence is unchanged.

## Frontend modernisation program (D-005) — COMPLETE

Authorised by `D-005` (`56e7f46`), specified by `docs/audit/2026-07-frontend.md`
(`90d1da3`). Closed at `e50d7ba`. The audit is the historical
record of what was found and is not edited; this section is the ledger of what was done
about it.

**Shipped — 8 of 9 findings**

| Finding | S | What closed it | Commit |
|---|---|---|---|
| F-F001 | S-B | Portal warns an owner when a legacy `tenants.ai_prompt` shadows their saved settings; names which fields are inert. **Portal half fully closed at `be4c1e0`** — the warning became the portal-wide truth strip, and Home no longer renders `Using the latest instruction format` on the clinics the check is warning about. The renderer is unchanged. | `6ceb8f0`, `be4c1e0` |
| F-F002 | S-A | `web/lib/siteConfig.ts` resolves from environment; production build refuses placeholders (**unblocked portion only** — see Open) | `9b5486a` |
| F-F004 | S-A | `web/` recorded as a first-class surface under *Stack (frozen)*; gate 2 names the gap in Issue 20's scope (**partial** — see Open) | `9b5486a` |
| F-F005 | S-A | Hero plays a Telugu conversation; `Noto_Sans_Telugu` with `subsets: ["telugu"]`; first two lines verbatim from `public/demo/fixture.json` | `634b7aa` |
| F-F006 | S-A | Mobile nav drawer closes on link tap and on Escape; focus returns to the toggle | `e50d7ba` |
| F-F007 | S-A | Collapsed FAQ answers carry `inert` + `visibility: hidden` — out of the a11y tree, out of Ctrl+F, out of the tab order | `e50d7ba` |
| F-F008 | S-A/S-B | `web/` adopts the portal's teal brand accent. The site moved, not the portal | `e50d7ba` |
| F-F008 · drift half | Phase 2 S2 | `e50d7ba` closed the *hue* (periwinkle → teal) but left `web/` on `#14b8a6` against the portal's `#0f766e`, recorded as a divergence row in `brand-values.md`. `#0f766e` measured 3.58:1 on the near-black ground and could not be adopted while `--accent` painted link text there. S2 flipped the ground, repointed `--accent` to `#0f766e` (5.16 / 4.74 / 5.47 on the three paper surfaces) and **deleted the divergence row**, so `tokenDrift` now enforces one value across both surfaces | `c47cd98` |
| F-F009 | S-A | Four colour-only focus indicators gained the existing 2px/4px ring | `e50d7ba` |

**Open, and why**

- **F-F003** — the legal pages still ship bracketed placeholders. Blocked on **C-1**
  (business entity registration, `docs/os/clocks.md`). Not schedulable: the fix is to
  write facts that do not exist yet.
- **F-F002 residual** — ✅ **the exemption half is CLOSED** at `c6bda00`.
  `legalEntityName` is `null`, `legalName` is omitted from the Organization JSON-LD
  rather than emitted as a placeholder, and the guard's field list is derived from
  `siteConfig` and `waMessages` instead of hand-written, so there is nothing left to
  exempt and no way to add a field without checking it. **Open:** the
  deploy-environment values are still unset, blocked on C-1 and on the domain
  purchase, which is deferred by founder decision. That half fails the build loudly
  and always did; it was only the exemption that shipped quietly.
- **F-F004 residual** — the `web/` deploy host is founder-unconfirmed. `D-006` is drafted
  in `docs/os/decisions.md.draft`, not `decisions.md`, awaiting that confirmation.

**Deliberately not scheduled**

- The **nine S5 appendix items** of the audit. Not cut for cost — they are below the
  threshold at which a prospect notices.
- The **cross-surface token values file and its drift test** (the audit's "token
  question" remedy). Cut by founder decision and still cut. `--accent` was the only one
  of the three divergences that carried brand meaning, and F-F008 resolved it directly.

**Spend against the cap**

Five sessions of D-005's ten-session hard cap: the Stage 1 audit (`90d1da3`), then
Stage 2 items 1 (`9b5486a`), 2 (`634b7aa`), 3 (`6ceb8f0`) and 4 (`e50d7ba`). The
audit's own effort lines budget **17h** for the eight findings that shipped, of a 20h
total; the 3h remainder is F-F003. ⚠️ Actual hours are not recorded anywhere in the
repository — no session log exists — so the 17h is the estimate, not a measurement.
⚠️ **Corrected at D5b.** This paragraph used to end "Five sessions remain unspent and are
**not** carried forward: D-005's terms cancel the unspent backlog if the prediction
fails." Those five were not left unspent — they were spent on Portal v2 Batch 1, which
took **six** sessions rather than five because D5 was split into D5a and D5b. The
program therefore stands at **11 sessions against a 10-session hard cap**.

**The cap question is SETTLED: written off by the founder.** The full text and what
"written off" does and does not mean are under *Portal v2's governing documents* above,
where the budget note lives. Summarised here so this ledger is not read alone: the
eleventh session is neither a debt nor a raised cap, and the founder's stated root cause
is that the plan was written from a source-read audit, so four sessions went to defects
only a running portal could have surfaced. **The entry is `D-007`** — appended to
`docs/os/decisions.md` in the same commit as this line, because D-005's terms say
"Overrun requires a new entry, not an extension of this one" and `decisions.md` is the
register a founder decision carrying a prediction and a review date belongs in. It
reviews at Batch 2 close or 2026-10-31, whichever is first. D-005 itself is untouched:
append-only means the cap of 10, its prediction and its 2026-10-01 review all stand as
written.

**Note for the D-005 review (2026-10-01, or ten logged clinic conversations)**

D-005's prediction is about **objections raised in clinic conversations**. Roughly
two-thirds of this program by effort is `web/` work, and `web/` is **undeployed by
founder decision** — no prospect has seen any of it. A review that scores the prediction
against conversations held before a `web/` deploy is testing the portal and demo
surfaces only. **The review is therefore partial, not failed**, and the Outcome must
record which of the two it is. Not written here: the review date has not arrived and
the judgement is the founder's.

## Stack (frozen)

Node reasoning brain (sole reasoning engine) · Python LiveKit worker (transport only) ·
PostgreSQL raw SQL + pgvector · Gemini 2.5 Flash · Sarvam saaras:v3 STT + bulbul:v3 TTS ·
Plivo · WhatsApp Cloud API · Railway · Neon (dev only)

Verified against `package.json` and `voice-agent/pyproject.toml` + `voice-agent/uv.lock`:

- `gemini-2.5-flash` — `src/modules/ai/aiService.js:13`
- `saaras:v3` / `bulbul:v3` — `voice-agent/agent.py:71-72`
- Worker deps: `livekit-agents==1.6.4`, `livekit-plugins-sarvam==1.6.4`, `httpx`,
  `python-dotenv`. **No LLM SDK** — architecture invariant 1 holds by dependency list.
- **Plivo is a throwing stub**, not a live component (`src/modules/telephony/providers/plivo.js`,
  every method raises `NotImplemented`). Listed here as the intended provider, not a
  shipped one.
- **`web/` is a separate Next.js 15 / React 19 / TypeScript application** — the marketing
  site, and the only prospect-facing surface. It carries its own dependency tree,
  `package-lock.json` and `node_modules/`, and nothing in this repository builds, serves,
  tests or lints it:
  - not served by `server.js` — `express.static` covers `public/` only (`server.js:90`;
    the admin mount at `src/admin/adminRoutes.js:62` is also `public/`-derived);
  - not built by any script in the root `package.json`;
  - **zero of the 869 tests touch it** — `tests/design/tokenDrift.test.js` parses
    `web/app/globals.css` as text but executes nothing in it. The root suite's green is
    silent about `web/` behaviour, so
    a `web/` change is evidenced by the build artifact, not by `npm test`.
  - `web/vercel.json` is **headers-only** — five security headers, no build command, no
    output directory, no root directory.
  Introduced `34db490` (2026-06-26), which **predates** `docs/specs/portal-v1-spec.md`
  (`5c6b4e2`, 2026-07-18) by three weeks. §2's static-stack constraint ("no SPA, no
  framework, no bundler") is scoped to the portal UI served by `express.static('public')`
  and does not govern `web/`; the surface has never been in breach of it.
  ⚠️ **The deploy host is founder-unconfirmed and not repo-derivable.** No `railway.json`,
  `Dockerfile`, `Procfile`, `nixpacks.toml` or CI workflow exists anywhere in the
  repository. `web/README.md` names Vercel and `vercel.json` implies it, but a headers
  file is not a deploy: it configures a host that something else must have chosen. Vercel
  is convention here, not evidence. The founder must confirm the target; a `D-006` draft
  awaiting that confirmation sits in `docs/os/decisions.md.draft`.
  **`docs/deploy/marketing-site.md` (`d811910`) now records what a person does, in order, to put `web/` at an address**, and settles by measurement that `web/` needs nothing outside `web/` for any route. The host is still founder-unconfirmed — the document is Vercel-first because `vercel.json` is, and carries a generic Node-host path alongside it. Site configuration is environment-resolved as of Stage 2 Item 1 — see `web/.env.example`
  for the variables a deploy must supply, and note that a production build **fails** if a
  required one is missing. See `docs/audit/2026-07-frontend.md` F-F004 and F-F002.
- **Corrected:** the previous "Neon (dev/test)" was drift. The test path is local
  Postgres via `TEST_DATABASE_URL` (`tests/_support/testEnv.js`, `c673673`). Neon is
  dev-only.

## Architecture invariants

Verified at HEAD:

- **Node is the sole reasoning brain** — the worker's dependency list contains no LLM SDK.
- **`tenant_id` scoping everywhere** — holds, with the two open F-016 letter-violations noted above.
- **`configService` is the single config path** — every reader and writer of the config
  document goes through it. `doctorService` (`tenant_entities`) and `faqService`
  (`knowledge_chunks`) use separate storage **by design**, per `docs/specs/portal-v1-spec.md` §7.
- **Parameterised SQL only** — 233 sites audited clean; unchallenged since.

⚠️ Not repo-derivable — these are process invariants, evidenced only by habit:
all branches fast-forward onto main · one issue per session · runtime evidence closes a session.

## Known open risks

- ⚠️ **`portalLifecycle.integration.test.js:794` FAILS WHEN THE MACHINE IS FAST —
  a latent flake, measured this session and NOT fixed** (untouched file, outside
  this session's scope). The assertion is
  `+e1.updated_at > +e0.updated_at` on `tenant_entities`, comparing two JS `Date`
  objects, which carry MILLISECOND resolution while Postgres timestamps carry
  microseconds. Measured directly at the test's own INSERT→UPDATE cadence, on an
  idle machine, **n=300: 63.7% of pairs land in the SAME millisecond**, where the
  strict `>` is false. It passes in the suite only because 20-way parallelism
  stretches the round trip past 1 ms — so the failure mode is an idle or
  momentarily fast machine, which is the inverse of the usual flake intuition and
  is why it reads as inexplicable. Seen once in 20 full-suite runs.
  **The fix is to stop comparing at millisecond resolution**: assert in SQL
  (`SELECT updated_at > created_at`) or compare
  `EXTRACT(EPOCH FROM …)` text, either of which keeps the microseconds the
  database already stored. Widening to `>=` would pass vacuously — it is true at
  INSERT too — so that is the wrong repair.
- ⚠️ **TWO CONCURRENT `npm test` RUNS CORRUPT EACH OTHER, silently and in a shape
  that looks like a product defect.** Observed this session: a full-suite run
  started while an earlier one was still finishing produced **8 failures in
  `workflowEngine.test.js`**, all `workflow_rules_tenant_id_fkey` violations. The
  mechanism is not specific to that file — the shared-DB suites seed FIXED UUIDs
  (`workflowEngine.test.js:18-19` uses `…0099` / `…00c1`) and delete them
  unconditionally in `after`, so one run's teardown pulls the row out from under
  the other run's inserts. The scratch-DB suites are safe (disjoint random
  prefixes); the fixed-UUID ones are not. Nothing in the repo detects the
  condition. **On Windows this is easy to hit by accident: stopping a test loop
  does not reliably reap the `node --test` descendants**, so a "stopped" run can
  still be executing against the database minutes later. Not fixed.
- **Distribution is the existential risk**, not capability. Clinic sales in India are
  trust-based; the durable asset is an exclusive channel plus outcome-labelled vernacular
  transcripts. ⚠️ market claim, not repo-derivable.
- `VOICE_STREAM_TURNS=true` is the only perceptual latency fix required at deploy.
- **Portal-written prompt copy is silently inert on any tenant carrying a legacy
  `tenants.ai_prompt`** — see A-007 in `docs/os/assumptions.md`. **No longer reachable by
  accident** (Issue 34): the admin form no longer offers the field and the create route
  refuses it, so every newly created tenant — admin or portal — is born on the renderer.
  The condition still exists for any tenant deliberately given a prompt via
  `scripts/update-prompt.js` or the voice seed script, and for any legacy tenant already
  carrying one; those keep their prompt and their precedence behaviour unchanged, and the
  F-F001 portal notice is what warns their owner. ⚠️ **Zero such tenants are known to
  exist** — there is no production deploy, so this is a hazard retained for a population
  that is currently empty.
- **F1-R1 — the EDIT half is CLOSED (this commit); the DELETE half remains open
  below.** Both tables carried `created_at` and no `updated_at` and no
  `set_updated_at` trigger, so `max(created_at)` could not rise on an in-place
  edit. Migration `026` added `updated_at` + the existing trigger to both, and
  `validationInputsChangedAt` now reads it — so an in-place FAQ edit, an in-place
  schedule edit and a doctor **archive** all expire the run. The archive was not
  in the original filing and is the case that mattered most; full entry under
  *F1-R1* in Engineering above.
- **F1-R2 (open, new) — a DELETE still cannot expire a validation run.** The
  residue of F1-R1, and the half no timestamp column can close: removing a row
  **lowers** `max(updated_at)` rather than raising it, so deleting the 5th FAQ
  takes a clinic below `kbMin` while the run still reads fresh and the ring still
  reports the old, **higher** verdict. ⚠️ *This identifier is minted here for
  bookkeeping — the founder filed the condition, not the name.*
  **Start from the analysis, not from rediscovery.** Two candidate signals, both
  named at the fix site (`lifecycleService.validationInputsChangedAt`):
  (a) a tenant-level touch on delete — cheap, but it puts a write on a read path
  and needs a home that `writeStatus` does not already bump (see the
  `tenants.updated_at` exclusion, which is why the obvious column is unavailable);
  (b) carry a **row count** in the union beside the timestamp and compare it to
  the count the run recorded — strictly more correct, since it catches any
  cardinality change in either direction, at the cost of the run having to persist
  what it counted.
  Blast radius unchanged and worth restating precisely: the portal's Go live
  always runs `validate` before `activate` (`runGoLiveChain`), so a deletion that
  drops a clinic below `kbMin` is still refused **at the press**. What is exposed
  is (a) the ring reading one check too high until the next run, and (b) the
  **admin** panel's separate `activate`, which can act on a passing run that a
  deletion has since invalidated.
- **B2-R1 (open, new) — there is no patient-facing way to CANCEL.**
  `appointments.status` has carried `'cancelled'` since migration `003` and
  **nothing writes it**: no tool, no route, no portal control, no script. A
  patient can now book and move; to cancel, someone edits the row by hand. Filed
  deliberately out of B2's scope. The shape is smaller than a reschedule — one
  status flip, no new slot to validate — and it reuses B2's server-side lookup and
  its `appointment_not_found` refusal wholesale.
- **The test suite makes live third-party API calls, so `# fail 0` is not purely a
  function of the code.** The Item 4 session saw `npm test` return `862 / fail 1` on a
  live Gemini embedding 503, then pass unchanged on re-run. This weakens every green
  claim in this file, including `os:check`'s — that script shells out to the same suite,
  so a third-party outage reads as state drift. **Open.** The obvious fix is a stubbed
  embedding in the test path; deliberately not done in the Issue 34 session that recorded
  it. Distinct from the Neon-latency nondeterminism under *Resolved* below, which was a
  different cause and is genuinely closed.

## Resolved

- ~~Test-suite nondeterminism traced to Neon network latency~~ — **resolved** by
  `c673673` (TEST-FLAKE-02). `tests/_support/testEnv.js` is the single seam that
  repoints the suite at a local Postgres via `TEST_DATABASE_URL`, loaded through
  `--require` so it beats every module-level pool construction. Neon is dev-only now.
  **This closed the database cause only.** A second, unrelated source of suite
  nondeterminism — live Gemini calls in the test path — is open under *Known open risks*.
  Do not read this entry as "the suite is deterministic."
