-- Migration 003 — per-period paid/compound choice on return_ledger
-- Target: Neon Postgres. Also applied automatically at startup by
-- _migrate() in database.py, so this file is the canonical DDL record.
--
-- contributions.payout_type becomes a DEFAULT PREFERENCE only: it seeds
-- period_action when a ledger row is generated, but each period can be
-- flipped individually (until marked paid, which locks the row forever).
--
-- Balance columns per row:
--   running_balance      balance BEFORE this period's action (the base the
--                        period's return was computed from)
--   post_action_balance  balance AFTER the action ('paid' leaves it equal
--                        to running_balance; 'compound' adds the return)

ALTER TABLE return_ledger
    ADD COLUMN IF NOT EXISTS period_action VARCHAR(10) NOT NULL DEFAULT 'paid'
    CHECK (period_action IN ('paid', 'compound'));

ALTER TABLE return_ledger
    ADD COLUMN IF NOT EXISTS post_action_balance NUMERIC(14, 2);

-- Backfill: every pre-existing row represents either a monthly cash return
-- or a withdrawal payout — both are cash-out events, so 'paid' (the column
-- default) is correct. Compound contributions had no per-month rows before
-- this migration; the engine generates them (action='compound') on first read.
