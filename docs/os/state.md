# State

The company as of a commit. Amend whenever reality diverges. A stale line here is a defect, not a detail.

Verified-at: a33f54c021aedf911771a67eb5497d1440529696
Verified-on: 2026-07-25
Rule: when Verified-at != HEAD, every line below is unverified. Re-run `npm run os:check`.

⚠️ marks a line this session could **not** evidence from the repository. The reason is
stated inline. Absence of a marker means the line was checked against HEAD, not that it
is self-evident.

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
| 2 | Live WhatsApp round-trip on prod | PENDING | **PENDING** | No production deploy; no prod evidence log in the repo. Blocked on Issue 20. |
| 3 | Issue 14 voice gate | PENDING-DID | **PENDING-DID** | Issues 11–13 still absent. External clock C-2 unfiled. |
| 4 | Tenant isolation audit clean | PASS | **PASS** | Unchanged. The two F-016 letter-violations (`appointmentService.js:171`; dead `identityService.getTimeline`) remain open with zero tenant-facing exposure. |
| 5 | Issue 18 closed | PASS | **PASS** | Plus `3584240`, which closed the audit's noted `SESSION_SECRET` → `ADMIN_PASSWORD` fallback residual. |
| 6 | Backups exist with a tested restore | **FAIL** | **PASS** (repo side) | Closed by `e071f69`: `scripts/db/backup.sh`, `scripts/db/restore.sh`, `docs/runbooks/backup-restore.md`, live restore drill. ⚠️ Residue: enabling backups on the *production* provider is unverifiable until Issue 20. |
| 7 | One call traceable end-to-end | PENDING (dev evidence in hand) | **PENDING** | Unchanged; blocked by gates 2–3. |

## Engineering

- Test suite: **830 tests / 142 suites / 0 fail** (`npm test`, raw: `# tests 830 / # pass 830 / # fail 0`)
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

### Remaining before first live call

By issue number, from `docs/specs/zyon-first-launch-plan.md`.

- **Done:** 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 17, 18, 19, 21, 22
- **Not done:** 1 (ops), 2 (ops), 11, 12, 13, 14, 20, 23, 24, 27, 28
- **Residue-only** (built and tested; awaiting Issue 20 for a prod render): 25, 26

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

- **Distribution is the existential risk**, not capability. Clinic sales in India are
  trust-based; the durable asset is an exclusive channel plus outcome-labelled vernacular
  transcripts. ⚠️ market claim, not repo-derivable.
- `VOICE_STREAM_TURNS=true` is the only perceptual latency fix required at deploy.
- **Portal-written prompt copy is silently inert on any tenant carrying a legacy
  `tenants.ai_prompt`** — see A-007 in `docs/os/assumptions.md`. Affects admin-created
  tenants only; portal-provisioned tenants are born on the renderer.

## Resolved

- ~~Test-suite nondeterminism traced to Neon network latency~~ — **resolved** by
  `c673673` (TEST-FLAKE-02). `tests/_support/testEnv.js` is the single seam that
  repoints the suite at a local Postgres via `TEST_DATABASE_URL`, loaded through
  `--require` so it beats every module-level pool construction. Neon is dev-only now.
