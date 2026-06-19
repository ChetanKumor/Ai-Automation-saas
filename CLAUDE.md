# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Multi-tenant WhatsApp AI CRM. Businesses connect their WhatsApp number; inbound messages are handled by an AI agent (Gemini 1.5 Flash) or handed off to a human agent. Each conversation carries its own `mode` (`ai` | `human`) so the AI can be silenced per-conversation without affecting other threads.

## Commands

```bash
npm start        # production: node server.js
npm run dev      # development: nodemon server.js (auto-restart on file changes)
```

No test suite yet — `npm test` is a stub.

## Architecture

**Runtime:** Node.js + Express 5, PostgreSQL (via `pg` Pool), no ORM.

**Entry point:** `server.js` → mounts `/webhook` routes and `/health`.

**Request flow (inbound WhatsApp message):**
1. Meta posts to `POST /webhook` → `webhookController.handle()`
2. Resolve tenant from `phone_number_id` (cached 5 min in-memory)
3. Upsert customer by phone (`ON CONFLICT` on `tenant_id, phone`)
4. Get or create the single open conversation (`uniq_open_conversation_per_customer` partial index)
5. Insert message with `wamid` as idempotency key (`ON CONFLICT DO NOTHING`)
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

## Database Design Rules

- **Multi-tenant isolation:** Every table has `tenant_id`. Always filter by it in queries.
- **Idempotency:** `messages.wamid` is `UNIQUE` — use `ON CONFLICT (wamid) DO NOTHING` for inbound messages. If `rowCount === 0`, it's a duplicate.
- **One open conversation per customer:** Enforced by partial unique index `uniq_open_conversation_per_customer ON conversations(customer_id) WHERE status = 'open'`.
- **Coexistence mode:** `conversations.mode` is `'ai'` or `'human'`. AI must check this before replying. Human agents set it via `conversationService.setMode()`.
- **Message columns:** Use `direction` (`inbound`/`outbound`) + `sender` (`customer`/`ai`/`agent`), not a `role` column.
- **UUIDs everywhere:** All primary keys are `UUID DEFAULT gen_random_uuid()`.

## Environment Variables

Configured via `.env` (gitignored). Required:
- `DATABASE_URL` — PostgreSQL connection string
- `GEMINI_API_KEY` — Google Generative AI key
- `WEBHOOK_VERIFY_TOKEN` — Meta webhook verification token
- Tenant-level: `phone_number_id` and `wa_token` are stored per-tenant in the DB, not in env vars.
