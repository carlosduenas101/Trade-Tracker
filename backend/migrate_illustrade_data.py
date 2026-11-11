#!/usr/bin/env python3
"""
migrate_illustrade_data.py
───────────────────────────
One-shot migration: copies real trades + Fund Pool data (investors,
contributions, return_ledger) from IllusTrade (trading-tracker) into
Prometheus's finance_tracker, so the Trading tab shows your actual
trade history instead of placeholder data.

WHY THIS RUNS ON YOUR MACHINE, NOT IN THE SANDBOX:
IllusTrade's real database is Neon Postgres. The Claude sandbox that
built this feature has no network access to reach it. This script must
be run locally, where your machine can reach both databases directly.

WHAT IT DOES:
  1. Reads trading-tracker/backend/.env to find your IllusTrade DATABASE_URL
     (Postgres if configured, else falls back to its local SQLite file).
  2. Looks up your account (default username "carlos") in the users table
     and only reads TRADES BELONGING TO THAT ACCOUNT — other users' trades
     are never touched or copied. (Investors/contributions/return_ledger
     are not per-user in IllusTrade's schema, so all Fund Pool rows are
     migrated as-is.)
  3. Backs up finance_tracker/finance.db (timestamped copy, same folder).
  4. WIPES the existing trades/investors/contributions/return_ledger tables
     in finance.db and re-inserts the real data, preserving original IDs
     (so Fund Pool foreign keys stay valid).
  5. Prints a summary of what was migrated, including how many trades were
     excluded because they belonged to other accounts.

USAGE:
    cd "trading-tracker/backend"          # so it can see the same venv/deps
    python migrate_illustrade_data.py

    # Optional flags:
    #   --dry-run       show what would be migrated, write nothing
    #   --yes           skip the confirmation prompt
    #   --username NAME account to filter trades by (default: carlos)
    #   --all-users     skip the account filter, migrate every trade in the DB
    #   --trading-tracker-dir PATH   override path to trading-tracker/
    #   --finance-tracker-dir PATH   override path to Prometheus Claw/finance_tracker/

REQUIREMENTS:
  Run with the same Python environment trading-tracker's backend uses
  (it already has psycopg2-binary + python-dotenv installed, which this
  script needs for the Postgres connection). If you get an import error,
  run:  pip install psycopg2-binary python-dotenv
"""

import argparse
import shutil
import sqlite3
import sys
from datetime import datetime
from pathlib import Path

DEFAULT_TT_DIR = Path(r"D:\Alchemist Code\Programing\Agents\trading-tracker")
DEFAULT_FT_DIR = Path(r"D:\Alchemist Code\Programing\Agents\Prometheus Claw\finance_tracker")


def load_dotenv_manual(env_path: Path) -> dict:
    """Minimal .env parser — avoids a hard dependency on python-dotenv."""
    values = {}
    if not env_path.exists():
        return values
    for line in env_path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, val = line.partition("=")
        values[key.strip()] = val.strip().strip('"').strip("'")
    return values


def get_source_connection(tt_dir: Path):
    """
    Returns (conn, kind) where kind is 'postgres' or 'sqlite'.
    Prefers DATABASE_URL from trading-tracker/backend/.env; falls back to
    the local trading_tracker.db SQLite file if Postgres isn't reachable
    or isn't configured.
    """
    env_path = tt_dir / "backend" / ".env"
    env = load_dotenv_manual(env_path)
    db_url = env.get("DATABASE_URL", "")

    if db_url.startswith("postgres"):
        try:
            import psycopg2
            import psycopg2.extras
        except ImportError:
            print("ERROR: psycopg2 not installed. Run: pip install psycopg2-binary")
            sys.exit(1)
        print(f"Connecting to Postgres (from {env_path}) ...")
        try:
            conn = psycopg2.connect(db_url, cursor_factory=psycopg2.extras.RealDictCursor)
            print("  Connected to Postgres.")
            return conn, "postgres"
        except Exception as e:
            print(f"  Could not reach Postgres ({e}). Falling back to local SQLite.")

    sqlite_path = tt_dir / "backend" / "trading_tracker.db"
    if not sqlite_path.exists():
        print(f"ERROR: no reachable source DB. Tried Postgres and {sqlite_path} (missing).")
        sys.exit(1)
    print(f"Connecting to local SQLite fallback: {sqlite_path}")
    conn = sqlite3.connect(sqlite_path)
    conn.row_factory = sqlite3.Row
    return conn, "sqlite"


def fetch_all(conn, kind, table, order_by="id ASC"):
    cur = conn.cursor()
    cur.execute(f"SELECT * FROM {table} ORDER BY {order_by}")
    rows = cur.fetchall()
    cur.close()
    return [dict(r) for r in rows]


def find_user_id(conn, kind, username):
    """
    Look up the users.id for the given username (case-insensitive, also
    tries matching as an email). Returns (None, "no_users_table") if there's
    no users table, or it exists but is completely empty (the local
    single-tenant SQLite fallback has this shape — every trade in it
    belongs to the one local account, so there's nothing to filter by).
    Returns (None, "not_found") if the table has real data but this
    particular username/email isn't in it — that's treated as an error
    upstream since we can't safely assume which rows are "yours".
    """
    cur = conn.cursor()
    try:
        cur.execute("SELECT COUNT(*) AS c FROM users")
        total = dict(cur.fetchone())["c"]
    except Exception:
        cur.close()
        return None, "no_users_table"

    if total == 0:
        cur.close()
        return None, "no_users_table"

    ph = "%s" if kind == "postgres" else "?"
    cur.execute(
        f"SELECT id, username, email FROM users "
        f"WHERE LOWER(username) = LOWER({ph}) OR LOWER(email) = LOWER({ph})",
        (username, username),
    )
    row = cur.fetchone()
    cur.close()
    if row is None:
        return None, "not_found"
    row = dict(row)
    return row["id"], row.get("username") or row.get("email")


def fetch_trades_for_user(conn, kind, user_id):
    ph = "%s" if kind == "postgres" else "?"
    cur = conn.cursor()
    cur.execute(f"SELECT * FROM trades WHERE user_id = {ph} ORDER BY id ASC", (user_id,))
    rows = cur.fetchall()
    cur.close()
    return [dict(r) for r in rows]


def count_other_trades(conn, kind, user_id):
    """How many trades exist that will be EXCLUDED (other users, or unattributed)."""
    ph = "%s" if kind == "postgres" else "?"
    cur = conn.cursor()
    cur.execute(f"SELECT COUNT(*) AS c FROM trades WHERE user_id IS NULL OR user_id != {ph}", (user_id,))
    row = dict(cur.fetchone())
    cur.close()
    return row["c"]


def to_text(v):
    """Normalize datetime/date/Decimal/bool values to strings/ints for SQLite storage."""
    if v is None:
        return None
    if isinstance(v, bool):
        return int(v)
    if hasattr(v, "isoformat"):
        return v.isoformat()
    # Decimal -> float
    try:
        from decimal import Decimal
        if isinstance(v, Decimal):
            return float(v)
    except ImportError:
        pass
    return v


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--dry-run", action="store_true", help="Show what would be migrated, write nothing")
    ap.add_argument("--yes", action="store_true", help="Skip confirmation prompt")
    ap.add_argument("--trading-tracker-dir", type=Path, default=DEFAULT_TT_DIR)
    ap.add_argument("--finance-tracker-dir", type=Path, default=DEFAULT_FT_DIR)
    ap.add_argument("--username", default="carlos",
                     help="Only migrate trades belonging to this IllusTrade account "
                          "(matched against users.username or users.email). Default: carlos")
    ap.add_argument("--all-users", action="store_true",
                     help="Skip the per-user filter and migrate every trade in the source DB "
                          "(use only if you actually want other accounts' trades too)")
    args = ap.parse_args()

    tt_dir = args.trading_tracker_dir
    ft_dir = args.finance_tracker_dir
    finance_db = ft_dir / "finance.db"

    if not finance_db.exists():
        print(f"ERROR: finance.db not found at {finance_db}")
        sys.exit(1)

    src_conn, kind = get_source_connection(tt_dir)

    print("\nReading source data ...")

    if args.all_users:
        trades = fetch_all(src_conn, kind, "trades")
        print(f"  trades (ALL USERS, --all-users passed): {len(trades)}")
    else:
        user_id, matched_as = find_user_id(src_conn, kind, args.username)
        if matched_as == "no_users_table":
            # Single-tenant fallback DB (e.g. local SQLite dev copy) — no
            # users table means there's nothing to filter by; every trade
            # in this DB belongs to the one local account.
            trades = fetch_all(src_conn, kind, "trades")
            print(f"  no users table in source (single-tenant DB) — treating all "
                  f"{len(trades)} trades as yours")
        elif user_id is None:
            print(f"\nERROR: no user found matching username/email '{args.username}' in the "
                  f"source users table.")
            print("Pass the correct account with --username <name>, or pass --all-users "
                  "to skip this filter.")
            src_conn.close()
            sys.exit(1)
        else:
            trades = fetch_trades_for_user(src_conn, kind, user_id)
            excluded = count_other_trades(src_conn, kind, user_id)
            print(f"  matched account: '{matched_as}' (user_id={user_id})")
            print(f"  trades for this account: {len(trades)}")
            print(f"  trades excluded (other users / unattributed): {excluded}")

    investors, contributions, ledger = [], [], []
    try:
        investors = fetch_all(src_conn, kind, "investors")
        contributions = fetch_all(src_conn, kind, "contributions")
        ledger = fetch_all(src_conn, kind, "return_ledger")
        print(f"  investors: {len(investors)}")
        print(f"  contributions: {len(contributions)}")
        print(f"  return_ledger: {len(ledger)}")
    except Exception as e:
        print(f"  (Fund Pool tables not present in source — skipping. {e})")

    src_conn.close()

    if not trades and not investors:
        print("\nNothing to migrate — source has no trades or investors. Aborting.")
        sys.exit(0)

    print(f"\nTarget: {finance_db}")
    if args.dry_run:
        print("DRY RUN — no changes written.")
        sys.exit(0)

    if not args.yes:
        resp = input(
            f"\nThis will DELETE all existing rows in trades/investors/contributions/"
            f"return_ledger in {finance_db.name} and replace them with the {len(trades)} "
            f"trades + {len(investors)} investors above. A timestamped backup will be made first.\n"
            f"Continue? [y/N] "
        ).strip().lower()
        if resp != "y":
            print("Aborted.")
            sys.exit(0)

    backup_path = finance_db.with_name(f"finance.db.bak-{datetime.now().strftime('%Y%m%d-%H%M%S')}")
    shutil.copy2(finance_db, backup_path)
    print(f"\nBackup written: {backup_path}")

    dst = sqlite3.connect(finance_db)
    dst.execute("PRAGMA foreign_keys = OFF")
    try:
        cur = dst.cursor()

        # Wipe children before parents
        for table in ("return_ledger", "contributions", "investors", "trades"):
            cur.execute(f"DELETE FROM {table}")
            cur.execute("DELETE FROM sqlite_sequence WHERE name = ?", (table,))

        # trades
        trade_cols = ["id", "symbol", "side", "entry_price", "exit_price", "quantity",
                      "pnl", "roe", "is_win", "open_time", "close_time",
                      "duration_minutes", "risk_reward", "leverage", "notes",
                      "source", "entries", "created_at"]
        for t in trades:
            vals = [to_text(t.get(c)) for c in trade_cols]
            placeholders = ",".join("?" * len(trade_cols))
            cur.execute(
                f"INSERT INTO trades ({','.join(trade_cols)}) VALUES ({placeholders})",
                vals,
            )

        # investors
        inv_cols = ["id", "name", "contact", "created_at"]
        for i in investors:
            vals = [to_text(i.get(c)) for c in inv_cols]
            cur.execute(
                f"INSERT INTO investors ({','.join(inv_cols)}) VALUES ({','.join('?' * len(inv_cols))})",
                vals,
            )

        # contributions
        contrib_cols = ["id", "investor_id", "amount", "date_contributed",
                        "payout_type", "status", "notes", "created_at"]
        for c in contributions:
            vals = [to_text(c.get(col)) for col in contrib_cols]
            cur.execute(
                f"INSERT INTO contributions ({','.join(contrib_cols)}) VALUES ({','.join('?' * len(contrib_cols))})",
                vals,
            )

        # return_ledger
        ledger_cols = ["id", "contribution_id", "period_start", "period_end", "amount",
                       "period_action", "running_balance", "post_action_balance",
                       "paid", "paid_date", "payment_method", "created_at"]
        for l in ledger:
            vals = [to_text(l.get(col)) for col in ledger_cols]
            cur.execute(
                f"INSERT INTO return_ledger ({','.join(ledger_cols)}) VALUES ({','.join('?' * len(ledger_cols))})",
                vals,
            )

        dst.commit()
    except Exception:
        dst.rollback()
        raise
    finally:
        dst.close()

    print("\nMigration complete:")
    print(f"  trades:         {len(trades)}")
    print(f"  investors:      {len(investors)}")
    print(f"  contributions:  {len(contributions)}")
    print(f"  return_ledger:  {len(ledger)}")
    print(f"\nRestart the finance_tracker server (or refresh the dashboard) to see the real data.")
    print(f"If anything looks wrong, restore the backup:\n  copy \"{backup_path}\" \"{finance_db}\"")


if __name__ == "__main__":
    main()
