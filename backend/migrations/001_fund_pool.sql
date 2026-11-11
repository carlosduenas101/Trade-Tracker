-- Migration 001 — Fund Pool investor-returns tracker
-- Target: Neon Postgres. Also created automatically by SQLAlchemy
-- Base.metadata.create_all() on app startup (init_db in database.py),
-- so this file is the canonical DDL record / manual-apply script.
--
-- Enums are modelled as VARCHAR + CHECK constraints (not native PG enums)
-- to stay compatible with the SQLite dev fallback.

CREATE TABLE IF NOT EXISTS investors (
    id          SERIAL PRIMARY KEY,
    name        VARCHAR(100) NOT NULL,
    contact     VARCHAR(255),
    created_at  TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS contributions (
    id                SERIAL PRIMARY KEY,
    investor_id       INTEGER NOT NULL REFERENCES investors(id),
    amount            NUMERIC(14, 2) NOT NULL CHECK (amount > 0),
    date_contributed  DATE NOT NULL,
    payout_type       VARCHAR(10) NOT NULL CHECK (payout_type IN ('monthly', 'compound')),
    status            VARCHAR(10) NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'withdrawn')),
    notes             VARCHAR(1000),
    created_at        TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_contributions_investor_id ON contributions (investor_id);
CREATE INDEX IF NOT EXISTS ix_contributions_status      ON contributions (status);

CREATE TABLE IF NOT EXISTS return_ledger (
    id               SERIAL PRIMARY KEY,
    contribution_id  INTEGER NOT NULL REFERENCES contributions(id),
    period_start     DATE NOT NULL,
    period_end       DATE NOT NULL,
    amount           NUMERIC(14, 2) NOT NULL,
    -- running_balance is only meaningful for compound contributions
    running_balance  NUMERIC(14, 2),
    paid             BOOLEAN NOT NULL DEFAULT FALSE,
    paid_date        TIMESTAMP,
    created_at       TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_return_ledger_contribution_id ON return_ledger (contribution_id);
CREATE INDEX IF NOT EXISTS ix_return_ledger_paid            ON return_ledger (paid);
