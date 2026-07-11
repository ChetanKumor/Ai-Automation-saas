# Production Readiness — Zyon (Issue 19)

**Status:** audit + conformance only. **Nothing in this document deploys.**
Issue 20 (genesis + smoke) executes from here; the checklist below ends
exactly where the Issue 20 runbook begins.

**Deploy topology (pinned):** one Railway *production* project holding a
Node service + a Railway Postgres. The Python voice worker gets a
service *placeholder* only (deploys in Issues 11–14, `VOICE_ENABLED=false`
until then). A LiveKit Cloud production project is created in the
colocated region but stays unused until telephony.

**Deploy source (pinned):** Railway deploys from GitHub `main`. The trunk
discipline we already run *is* the deploy pipeline. This doc documents the
wiring; it wires nothing.

---

## 1. Environment audit

Proven by a **scrubbed-env boot** (see §6): server.js was launched from an
empty working directory (so `dotenv.config()` re-injected **0** vars —
`injected env (0) from .env`) with only the variables marked *required*
below plus `NODE_ENV`/`PORT`. It booted clean, `/health` returned
`200 {status:ok, db:up}`, and all crons started. This is the control that
proves the required-list is complete and correct.

Legend — **Secret?** Y = never commit, store in Railway "Variables" (or a
secret manager); N = non-sensitive. **Required?** is for *this* deploy
(Node service, WhatsApp text path; voice deferred).

| Variable | Purpose | Required? | Secret? | Prod source / owner |
|---|---|---|---|---|
| `DATABASE_URL` | Postgres connection string. `sslmode=require`. | **Yes** | Y | **Railway-injected** by the attached Postgres plugin. Do **not** hand-type; reference the plugin var. Dev points at Neon `ap-southeast-1` — that value must **not** reach prod. |
| `GEMINI_API_KEY` | Google Generative AI (Gemini) key for AI replies. | **Yes** | Y | **Google AI Studio — a BILLING-ENABLED prod key, distinct from the dev key.** The dev key is now the paid dev key at 20 req/day and will rate-limit prod (429s observed in Issue 22). |
| `WEBHOOK_VERIFY_TOKEN` | Token Meta echoes on `GET /webhook` verification. | **Yes** | Y | Operator-chosen random string; must match the value entered in the Meta App webhook config. `generate: openssl rand -hex 24`. |
| `META_APP_SECRET` | Verifies `X-Hub-Signature-256` on inbound webhooks. | **Yes** | Y | **Meta Business → App → Settings → Basic → App Secret.** Copy at WhatsApp attach time. |
| `ENCRYPTION_KEY` | 32-byte hex key, AES-256-GCM for per-tenant `wa_token`. | **Yes** | Y | `generate: openssl rand -hex 32` (exactly 64 hex chars). **Rotating this orphans every stored wa_token** — set once, back it up in the secret store. |
| `ADMIN_PASSWORD` | Single-operator `/admin` login. Also the SESSION_SECRET fallback. | **Yes** | Y | Operator-chosen strong password. `generate: openssl rand -base64 24`. |
| `NODE_ENV` | `production` flips **trust-proxy + secure session cookie** on (server.js §gating). | **Yes (prod)** | N | **Operator must set `production` explicitly.** Railway/Nixpacks does *not* guarantee it. If unset, `/admin` login over Railway's TLS-terminating proxy is bounced immediately (insecure-cookie loop). See §4. |
| `PORT` | HTTP listen port. | No (injected) | N | **Railway-injected.** Code binds `process.env.PORT` (falls back to 3000). Do not hard-set. |
| `HOST` | Listen host. Defaults to `0.0.0.0`. | No | N | Leave unset — the default `0.0.0.0` is correct for Railway. (Conformance fix, §5.) |
| `SESSION_SECRET` | Session cookie signing secret. | Recommended | Y | `generate: openssl rand -hex 32` (**must be ≥32 chars or boot fails**). If unset it falls back to `ADMIN_PASSWORD`, then `'dev-fallback'` — set it in prod so rotating the admin password doesn't invalidate the secret too. |
| `LOG_LEVEL` | pino level. Defaults to `info`. | No | N | Leave unset (`info`). Do **not** ship `debug` to prod — it logs request bodies/volume. Called out as a dangerous-to-default-wrong knob. |
| `IDENTITY_RESOLUTION_ENABLED` | Feature flag, default `false`. | No | N | Leave unset/false for genesis. |
| `VOICE_ENABLED` | Master switch for the entire voice channel. | No | N | **`false` / unset for this deploy.** Gates `/internal/voice/*`, the telephony wiring, and the voice adapter. Flip on in Issues 11–14. |
| `TELEPHONY_PROVIDER` | Voice telephony provider. Defaults `noop`. | No | N | Leave `noop` (voice off). |
| `SARVAM_API_KEY`, `SARVAM_BASE_URL` | Sarvam STT/TTS. | No | Y / N | Voice-deferred (Issues 11–14). |
| `VOICE_INTERNAL_SECRET` | HMAC secret for `/internal/voice`. | No | Y | Voice-deferred; **required once `VOICE_ENABLED=true`.** |
| `VOICE_THINKING_BUDGET`, `VOICE_MAX_OUTPUT_TOKENS`, `VOICE_HISTORY_TURNS`, `VOICE_MEMORY_FACTS_MAX` | Voice turn-latency knobs (PR9A). | No | N | Voice-deferred; sane code defaults (0 / 150 / 8 / 10). |
| `TEST_CUSTOMER_PHONE`, `TEST_TENANT_PHONE_ID`, `VOICE_DEV_*`, `VOICE_TENANT_ID` | Dev/seed scripts only. | No | N | **Never set in prod** — referenced solely under `scripts/` (seed/test-chat), not in the runtime path. |

**Flagged: dev values that must NOT reach prod** — `DATABASE_URL` (dev
Neon), `GEMINI_API_KEY` (dev-quota key), and any `TEST_*` / `VOICE_DEV_*`.
Every prod secret is freshly generated/owned per the source column.

---

## 2. Region decision — **operator sign-off required**

**Criterion:** the PR9A voice-turn latency budget. Voice RTT is
STT (Sarvam) → LLM (Gemini) → TTS (Sarvam) → media (LiveKit), so the Node
brain, Postgres, LiveKit Cloud, and Sarvam should be **colocated** as
close to the India user base as the platforms allow. WhatsApp-only text
(this deploy) is latency-tolerant, but the region is chosen **once** and
voice inherits it — so decide for voice now.

**Known datapoint:** the dev database is Neon `ap-southeast-1`
(Singapore) — the nearest common low-latency region to India across these
PaaS providers.

**Recommendation (pending sign-off):** provision the Railway prod project,
its Postgres, and the LiveKit Cloud prod project in the
**Singapore / `ap-southeast-1`-equivalent** region, and use the
Sarvam endpoint closest to it.

**Cannot verify from within this session** — the *current* region menus of
Railway, LiveKit Cloud, and Sarvam are not fetchable here. The operator
must confirm, from each dashboard, that a mutually-colocated region near
India exists and fill the slots below. **No region list is invented here.**

| Platform | Region chosen | Confirmed available? | Operator |
|---|---|---|---|
| Railway (Node + Postgres) | ` ___________ ` (target: Singapore) | ☐ | |
| LiveKit Cloud (prod project) | ` ___________ ` (colocate w/ Railway) | ☐ | |
| Sarvam STT/TTS endpoint | ` ___________ ` (nearest) | ☐ | |

Sign-off gate: measured voice-turn RTT must land within the PR9A budget
once telephony is live (Issues 11–14). If no single colocated region
satisfies all three, the operator decides the trade-off — documented here,
not in code.

---

## 3. Railway service checklist (wiring steps — do not execute here)

Order matters; secrets go in before the first successful boot.

1. **Project** — create one Railway *production* project (region per §2).
2. **Postgres** — add the Railway Postgres plugin. It exposes
   `DATABASE_URL`; reference that variable in the Node service (do not
   copy the literal). Genesis (Issue 20) runs against this fresh DB.
3. **Node service**
   - **Source:** connect GitHub repo, deploy branch **`main`**, auto-deploy on push.
   - **Start command:** `npm start` (→ `node server.js`). Verified correct (§5).
   - **Build:** Nixpacks default (Node 22, `npm ci`). No custom build.
   - **Health check path:** `/health` — returns `200 {status:ok,db:up}`
     when the pool answers `SELECT 1`, else `503`. Stable, no auth.
   - **Health check timeout:** ≥ 5s (first hit does a DB round-trip to
     Neon/Railway PG; observed cold ≈ 1–2s). Operator sets from Railway's
     health-check field.
   - **Restart policy:** `on-failure` (Railway default) is fine — boot is
     idempotent, no genesis on boot.
   - **Port:** none needed — Railway injects `PORT`, code binds it on
     `0.0.0.0`.
4. **Secrets entry order** (before first deploy): `NODE_ENV=production`,
   then the six required secrets from §1 (`GEMINI_API_KEY`,
   `WEBHOOK_VERIFY_TOKEN`, `META_APP_SECRET`, `ENCRYPTION_KEY`,
   `ADMIN_PASSWORD`, `SESSION_SECRET`). `DATABASE_URL` comes from the
   plugin reference. Meta values (`META_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`)
   can be deferred until the WhatsApp number is attached, but the service
   won't fully function until they're present — `env.js` will refuse to
   boot without them, so set placeholders only if you intend a pre-attach
   boot, and replace before go-live.
5. **Worker placeholder** — add a *disabled* / not-yet-deployed service
   entry named e.g. `voice-worker`, `VOICE_ENABLED=false`. It ships in
   Issues 11–14. No image, no start command yet.
6. **LiveKit Cloud** — create the prod project in the §2 region. Unused
   until telephony; capture its keys in the secret store for later.

**Cost note (one line):** Railway Node (hobby/usage) + Railway Postgres +
LiveKit Cloud free/dev tier is the launch footprint; Gemini is
pay-as-you-go on the billing-enabled key. No CDN/APM/log-drain/IaC added.

---

## 4. SIGTERM / lifecycle findings

**What the drain does today** (server.js): on `SIGTERM`/`SIGINT`, sets a
10s force-exit timer (`unref`'d), then `server.close()` → on close stops
**every** registered timer — `reminderTask`, `collectionsTask`,
**`traceRetentionTask`** (the newest, Issue 22), and `tenantService.stop()`
(clears the per-entry TTL cache timers) — then `db.close()` and
`process.exit(0)`. A second signal is ignored (`shuttingDown` guard).

**Verified covering ALL registered handles.** Every `setInterval`/cron in
the process is in the drain. Two remaining `setTimeout`s are per-request
and harmless: the 300ms delayed-401 in `adminRoutes` and the 10-minute
owner-wamid dedup cleanup in the WhatsApp route — neither blocks exit
because the drain calls `process.exit(0)` explicitly rather than waiting
for the loop to empty. (Minor finding, not fixed: the 10-min wamid timer
isn't `unref`'d; irrelevant under explicit `process.exit`, but worth an
`unref` if that route is ever refactored to rely on natural exit.)

**Timing (measured, §6):** from `shutdown received` to `DB pool closed`
was **≈ 10 ms** with all crons + voice enabled. The internal force-exit is
10s.

**Railway grace window:** Railway sends `SIGTERM`, then `SIGKILL` after its
grace window. **Operator to confirm the current value from Railway docs**
(not verifiable in-session). Our drain finishes ~three orders of magnitude
under 10s, so any grace window ≥ a few seconds is comfortably sufficient.

**Platform note:** on Windows dev, the OS delivers `SIGTERM` to a native
child as a hard terminate — the handler does not run (confirmed: child
exits on signal in ~40ms with no drain log). Railway (Linux) delivers a
catchable `SIGTERM`; the in-process proof in §6 exercises the identical
registered listener and shows the full drain.

---

## 5. Conformance fixes shipped in this PR

Each minimal, each tested; behavior otherwise unchanged.

- **Port/host binding** — `app.listen(PORT, '0.0.0.0', …)` (was
  host-default). Explicit IPv4 all-interfaces bind; `HOST` overridable.
  Proven by the boot log `host:"0.0.0.0" port:"8080"`.
- **Start command** — `npm start` → `node server.js`. Already correct;
  verified.
- **Health path** — `/health` stable, DB-ping gated, no auth, leaks no
  error detail (existing `health.test.js`).
- **Trust-proxy / secure-cookie gating** — confirmed keyed off
  `NODE_ENV==='production'`, the var the prod checklist sets (§1). New
  `tests/server/trustProxy.test.js` asserts prod ⇒ trust-proxy + secure,
  dev/unset ⇒ neither.
- **Graceful-shutdown coverage** — extended `tests/server/shutdown.test.js`
  to assert the drain stops the **trace-retention cron and tenant cache**,
  not just reminder + collections (mirrors server.js).

Full suite: **406/406 green**.

---

## 6. Runtime evidence (pasted)

**Scrubbed-env boot** — cwd = empty temp dir (dotenv finds no `.env`), env =
only the six required + `NODE_ENV=production PORT=8080`:

```
◇ injected env (0) from .env
... "collections cron started — runs every 30 minutes"
... "reminder cron started — runs every 15 minutes"
... "trace retention cron started — runs daily at 03:15"
... {"host":"0.0.0.0","port":"8080","msg":"server started"}
=== HEALTH: {"status":200,"body":"{\"status\":\"ok\",\"db\":\"up\",\"ts\":\"...\"}"}
```

**Drain** — in-process `process.emit('SIGTERM')` (identical listener to an
OS signal; used because Windows can't deliver a catchable SIGTERM):

```
=== emitting SIGTERM at 2026-07-11T02:58:58.881Z
{"signal":"SIGTERM","msg":"shutdown received — draining"}
{"msg":"HTTP server closed"}
{"msg":"cron tasks stopped + tenant cache timers cleared"}   # reminder+collections+traceRetention+tenant
{"msg":"DB pool closed"}                                       # ≈10ms after signal → exit(0)
```

---

## 7. Handoff

**next: Issue 20 runbook — genesis + smoke.** Run `db:genesis` (Issue 6
machinery) against the fresh prod `DATABASE_URL`, then a boot + `/health` +
webhook-verify smoke.

**Operator actions queued before Issue 20:** (a) region sign-off §2;
(b) create/own every secret in §1 — notably a **billing-enabled prod
Gemini key distinct from dev**; (c) Railway project + Postgres + GitHub-main
wiring per §3; (d) LiveKit Cloud prod project in the chosen region.
