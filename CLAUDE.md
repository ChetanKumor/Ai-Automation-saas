# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Multi-tenant WhatsApp AI CRM. Businesses connect their WhatsApp number; inbound messages are handled by an AI agent (Gemini 1.5 Flash) or handed off to a human agent. Each conversation carries its own `mode` (`ai` | `human`) so the AI can be silenced per-conversation without affecting other threads.

## Commands

```bash
npm start        # production: node server.js
npm run dev      # development: nodemon server.js (auto-restart on file changes)
npm test         # node:test suite (node --test ...)

npm run db:genesis   # bootstrap a FRESH database from schema.sql, then stamp every migration as applied
npm run db:migrate   # apply pending migrations in order (an existing untracked DB is adopted in place)
npm run db:status    # list applied (stamped vs run) + pending; exits nonzero if anything is pending
```

## Architecture

**Runtime:** Node.js + Express 5, PostgreSQL (via `pg` Pool), no ORM.

**Entry point:** `server.js` → mounts `/webhook` routes and `/health`.

**Request flow (inbound WhatsApp message):**
1. Meta posts to `POST /webhook` → `webhookController.handle()`
2. Resolve tenant from `phone_number_id` (cached 5 min in-memory)
3. Upsert customer by phone (`ON CONFLICT` on `tenant_id, phone`)
4. Get or create the single open conversation (`uniq_open_conversation_per_customer` partial index)
5. Insert message with `external_id` as idempotency key (`ON CONFLICT (tenant_id, channel, external_id) DO NOTHING`)
6. If `conversation.mode === 'human'` or `tenant.ai_enabled === false` → stop (no AI reply)
7. Fetch recent message history → generate AI reply via Gemini
8. Store outbound message → send via WhatsApp Cloud API

**Key modules:**
- `src/webhook/` — controller + routes (webhook verify + message handling)
- `src/modules/tenant/` — tenant lookup with TTL cache
- `src/modules/customer/` — customer upsert + message history queries
- `src/modules/conversation/` — open-conversation management + mode switching
- `src/modules/ai/` — Gemini chat with system prompt built from tenant config + customer memory
- `src/modules/whatsapp/` — WhatsApp Cloud API send wrapper
- `src/db/db.js` — pg Pool, exports `query(text, params)`
- `src/db/schema.sql` — full DDL (tables, indexes, triggers, partial unique constraints)
- `src/db/migrate.js` — forward-only migration runner (`db:genesis` / `db:migrate` / `db:status`)

## Database Design Rules

- **Multi-tenant isolation:** Every table has `tenant_id`. Always filter by it in queries.
- **Idempotency:** inbound messages dedup on the partial unique index `uniq_msg_external (tenant_id, channel, external_id) WHERE external_id IS NOT NULL` — use `ON CONFLICT (tenant_id, channel, external_id) DO NOTHING`. If `rowCount === 0`, it's a duplicate. (The legacy `wamid` column was dropped in migration 019; `external_id` is the sole message identifier.)
- **One open conversation per customer:** Enforced by partial unique index `uniq_open_conversation_per_customer ON conversations(customer_id) WHERE status = 'open'`.
- **Coexistence mode:** `conversations.mode` is `'ai'` or `'human'`. AI must check this before replying. Human agents set it via `conversationService.setMode()`.
- **Message columns:** Use `direction` (`inbound`/`outbound`) + `sender` (`customer`/`ai`/`agent`), not a `role` column.
- **UUIDs everywhere:** All primary keys are `UUID DEFAULT gen_random_uuid()`.

## Migrations

Ordered SQL lives in `src/db/migrations/` (`NNN_name.sql`, currently `002`–`019`;
`001` is folded into `schema.sql` as the base). The runner is `src/db/migrate.js`
(pure node/pg, no dependency), applied via the `db:*` npm scripts. It never runs
on server boot — invoke it explicitly.

- **Lockstep rule (non-negotiable):** every migration PR updates **both**
  `src/db/migrations/NNN_*.sql` **and** `schema.sql` in the same change.
  `schema.sql` is the maintained fresh-install DDL and must reproduce exactly
  what replaying all migrations produces. Genesis trusts `schema.sql`; drift
  there silently ships a wrong prod database.
- **Genesis semantics:** `db:genesis` bootstraps a **fresh** database from
  `schema.sql`, then stamps every file in `migrations/` as already-applied
  (it does **not** replay `002`–`019`). It refuses to run if any user table is
  present. Issue 20's first production deploy runs exactly this.
- **`db:migrate`:** applies pending migrations in numeric filename order, each in
  its own transaction; stops at the first failure naming the file + SQL error.
  An existing database with no tracking table yet is **adopted in place** — the
  current migrations are stamped (never executed), so a dev DB starts tracking
  without a rebuild.
- **`schema_migrations`** (created by the runner): `filename` PK, `checksum`
  (sha256, CRLF-normalised), `applied_at`, `stamped` (true = baseline/adopted,
  false = actually run). `db:status` WARNs when a recorded file's checksum no
  longer matches disk (edited after apply).
- **Forward-only.** No down-migrations; recovery is a restore from backup.
  Migration files must be plain DDL: no `BEGIN`/`COMMIT` of their own (the runner
  wraps each file in one transaction) and no `CREATE INDEX CONCURRENTLY`.

## Environment Variables

Configured via `.env` (gitignored). Required:
- `DATABASE_URL` — PostgreSQL connection string
- `GEMINI_API_KEY` — Google Generative AI key
- `WEBHOOK_VERIFY_TOKEN` — Meta webhook verification token
- `META_APP_SECRET` — Meta app secret for webhook signature verification
- `ENCRYPTION_KEY` — 32-byte hex key for AES-256-GCM encryption of wa_token
- `ADMIN_PASSWORD` — single admin password for the `/admin` dashboard
- Tenant-level: `phone_number_id` and `wa_token` are stored per-tenant in the DB, not in env vars.
