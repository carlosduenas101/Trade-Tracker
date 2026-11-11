-- Migration 002 — payment_method on return_ledger
-- Target: Neon Postgres. Also applied automatically at startup by
-- _migrate() in database.py, so this file is the canonical DDL record.
--
-- Nullable until a row is marked paid; required by the mark-paid and
-- withdraw endpoints from this migration on. Modelled as VARCHAR + CHECK
-- (not a native PG enum) for SQLite dev-fallback compatibility.

ALTER TABLE return_ledger
    ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20)
    CHECK (payment_method IN ('bank_transfer', 'crypto', 'cash', 'other'));
