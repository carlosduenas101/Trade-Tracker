-- Migration 004 — owner equity tracking
-- Target: Neon Postgres. Also applied automatically at startup by
-- _migrate() in database.py, so this file is the canonical DDL record.
--
-- Three changes, all in service of "how much of the account is actually MINE":
--   1. investors.is_owner  — one row may be flagged as the fund operator.
--      Owner money is capital, not an investment: it never accrues returns
--      and never appears in a liability aggregate.
--   2. Owner withdrawals are represented as NEGATIVE contribution amounts,
--      so owner_capital_in = SUM(amount) is net of withdrawals with no extra
--      column and no CASE in every query. The amount > 0 check therefore
--      relaxes to amount <> 0; the > 0 rule for non-owner investors is
--      enforced in the route, which is the only layer that can see is_owner
--      (a CHECK constraint cannot reach across to another table).
--   3. return_ledger amounts widen to NUMERIC(14, 4). A compounded chain
--      generates sub-cent returns (3307.50 * 5% = 165.375); rounding each
--      period to cents before it becomes the next period's base drifts the
--      balance off principal * 1.05^n. Cents are a display concern.

-- ── 1. Owner flag ────────────────────────────────────────────────────────
ALTER TABLE investors
    ADD COLUMN IF NOT EXISTS is_owner BOOLEAN NOT NULL DEFAULT FALSE;

-- At most one owner. Partial unique index: uniqueness on is_owner applies
-- only across rows where it is true, so any number of false rows coexist.
CREATE UNIQUE INDEX IF NOT EXISTS ux_investors_single_owner
    ON investors (is_owner) WHERE is_owner;

-- ── 2. Negative owner contributions ──────────────────────────────────────
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_amount_check;
ALTER TABLE contributions DROP CONSTRAINT IF EXISTS contributions_amount_nonzero;
ALTER TABLE contributions
    ADD CONSTRAINT contributions_amount_nonzero CHECK (amount <> 0);

-- ── 3. Sub-cent ledger precision ─────────────────────────────────────────
ALTER TABLE return_ledger ALTER COLUMN amount              TYPE NUMERIC(14, 4);
ALTER TABLE return_ledger ALTER COLUMN running_balance     TYPE NUMERIC(14, 4);
ALTER TABLE return_ledger ALTER COLUMN post_action_balance TYPE NUMERIC(14, 4);

-- ── 4. Equity snapshots ──────────────────────────────────────────────────
-- account_equity is entered by hand (never derived from the trade log).
-- The liability split is FROZEN at insert time: replaying today's ledger
-- against an old date would drift as periods accrue and rows get flipped,
-- silently rewriting the growth history.
CREATE TABLE IF NOT EXISTS equity_snapshots (
    id                   SERIAL PRIMARY KEY,
    snapshot_date        DATE NOT NULL UNIQUE,
    account_equity       NUMERIC(14, 4) NOT NULL,
    investor_balance_at  NUMERIC(14, 4) NOT NULL,
    returns_owed_at      NUMERIC(14, 4) NOT NULL,
    owner_equity_at      NUMERIC(14, 4) NOT NULL,
    note                 VARCHAR(500),
    created_at           TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_equity_snapshots_snapshot_date
    ON equity_snapshots (snapshot_date);
