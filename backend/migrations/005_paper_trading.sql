-- 005 — Paper trading for the Liq Ladder (backend/paper.py)
--
-- The backend creates these tables automatically on startup (init_db →
-- Base.metadata.create_all), so running this file by hand is optional.
-- It documents the schema and can be applied to Neon before deploying.

CREATE TABLE IF NOT EXISTS paper_bots (
    id               SERIAL PRIMARY KEY,
    user_id          INTEGER NOT NULL REFERENCES users(id),
    name             VARCHAR(80),
    symbol           VARCHAR(20) NOT NULL,
    side             VARCHAR(5)  NOT NULL,              -- long | short
    leverage         DOUBLE PRECISION NOT NULL,
    initial_capital  DOUBLE PRECISION NOT NULL,
    params_json      TEXT NOT NULL,                     -- ladder parameters (e1Pct, e2DistPct, ...)
    entry_mode       VARCHAR(10) NOT NULL,              -- market | price | zone
    entry_price      DOUBLE PRECISION,
    compound_pct     DOUBLE PRECISION NOT NULL DEFAULT 0,
    status           VARCHAR(10) NOT NULL DEFAULT 'running',
    balance          DOUBLE PRECISION NOT NULL,
    withdrawn        DOUBLE PRECISION NOT NULL DEFAULT 0,
    contributed      DOUBLE PRECISION NOT NULL,
    last_candle_ts   INTEGER NOT NULL,                  -- open time (unix s) of the last processed 1m candle
    last_price       DOUBLE PRECISION,
    last_error       VARCHAR(300),
    created_at       TIMESTAMP NOT NULL DEFAULT NOW(),
    updated_at       TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS ix_paper_bots_user_id ON paper_bots (user_id);
CREATE INDEX IF NOT EXISTS ix_paper_bots_symbol  ON paper_bots (symbol);
CREATE INDEX IF NOT EXISTS ix_paper_bots_status  ON paper_bots (status);

CREATE TABLE IF NOT EXISTS paper_cycles (
    id          SERIAL PRIMARY KEY,
    bot_id      INTEGER NOT NULL REFERENCES paper_bots(id),
    status      VARCHAR(5) NOT NULL DEFAULT 'open',     -- open | tp | sl | liq
    capital     DOUBLE PRECISION NOT NULL,
    e1_price    DOUBLE PRECISION NOT NULL,
    depth       INTEGER NOT NULL DEFAULT 1,
    fills_json  TEXT NOT NULL DEFAULT '[]',
    entry_ts    INTEGER NOT NULL,
    exit_price  DOUBLE PRECISION,
    exit_ts     INTEGER,
    pnl         DOUBLE PRECISION,
    worst_pnl   DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS ix_paper_cycles_bot_id ON paper_cycles (bot_id);
CREATE INDEX IF NOT EXISTS ix_paper_cycles_status ON paper_cycles (status);
