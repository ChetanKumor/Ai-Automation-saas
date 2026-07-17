-- Migration 023: portal owner auth — users.last_login_at (PORTAL-P1-S1)
--
-- The owner-facing portal reuses the existing `users` table rather than a new
-- accounts table. Two of the three columns the spec (§3) calls for already exist:
--   • password_hash TEXT NOT NULL  — present (schema.sql §2)
--   • role          (CHECK allows 'owner') — present
-- This migration adds the one missing column: last_login_at, stamped by portal
-- login on success. Everything else about portal auth is code (scrypt over
-- password_hash + a tenant-scoped session), never schema.
--
-- Additive, forward-only, nullable — no existing insert breaks. schema.sql is
-- updated in lockstep.

ALTER TABLE users ADD COLUMN last_login_at TIMESTAMPTZ;
