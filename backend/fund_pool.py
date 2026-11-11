"""
Fund Pool business logic.

Every active contribution accrues one return period per elapsed anniversary
month (rate: MONTHLY_RETURN_RATE). What happens to each period's return is
decided PER PERIOD on the ledger row (period_action):

paid      The return is owed as cash (paid=False until settled via
          mark-paid). The balance base is unchanged for the next period.
compound  The return rolls into the balance and becomes the base for the
          next period's return.

contributions.payout_type is only the DEFAULT for newly generated periods
('monthly' → 'paid', 'compound' → 'compound'); individual unpaid rows can be
flipped, which cascades a recompute through every later unpaid row.

The balance walk (recompute_balances) is the single source of truth:

    balance = principal
    for each period row in chronological order:
        if row.paid:                       # cash moved — row is immutable
            if row.period_action == 'compound':
                balance += row.amount      # honour its stored effect
            continue
        row.amount          = balance * rate
        row.running_balance = balance      # before the action
        if row.period_action == 'compound':
            balance += row.amount
        row.post_action_balance = balance  # after the action

Anniversary months are counted by day-of-month with month-end clamping via
dateutil.relativedelta (contributed Jan 31 → Feb anniversary = last day of Feb).
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import ROUND_HALF_UP, Decimal
from typing import Optional

from dateutil.relativedelta import relativedelta
from sqlalchemy import func
from sqlalchemy.orm import Session

from database import Contribution, EquitySnapshot, Investor, ReturnLedger

# Fixed for now — change here (or lift into config/env) when the rate changes.
MONTHLY_RETURN_RATE = Decimal("0.05")

# Growth-chart constants (dashboard visualization only — see growth_series)
SAVINGS_BENCHMARK_APY = Decimal("0.005")  # 0.5% APY — flat low-yield savings comparison line
GROWTH_PROJECTION_MONTHS = 6              # months of projected trend plotted beyond today

# payout_type (contribution default preference) → period_action for new rows
DEFAULT_ACTION = {"monthly": "paid", "compound": "compound"}

# Ledger precision is 4dp, not cents. A compounded chain generates sub-cent
# returns (3307.50 * 5% = 165.375) and rounding each period to cents before it
# becomes the next period's base drifts the balance off principal * 1.05^n
# (3000 over three months: 3472.88 stored vs 3472.875 owed). Cents are a
# display concern — the frontend formats to 2dp.
_PRECISION = Decimal("0.0001")


def _money(value: Decimal) -> Decimal:
    """Round to 4dp, half-up (banker's rounding surprises investors)."""
    return value.quantize(_PRECISION, rounding=ROUND_HALF_UP)


def anniversary(start: date, months: int) -> date:
    """start + N months, clamped to month end (Jan 31 + 1 → Feb 28/29)."""
    return start + relativedelta(months=months)


def months_elapsed(start: date, today: Optional[date] = None) -> int:
    """
    Whole anniversary months between start and today.

    Counted by anniversary day, not calendar month: the Nth month has elapsed
    once `anniversary(start, N) <= today`.
    """
    today = today or date.today()
    if today <= start:
        return 0
    n = (today.year - start.year) * 12 + (today.month - start.month)
    if anniversary(start, n) > today:
        n -= 1
    return max(n, 0)


def next_due_date(start: date, today: Optional[date] = None) -> date:
    """date_contributed + N months, where N = months elapsed + 1."""
    return anniversary(start, months_elapsed(start, today) + 1)


def _ordered_rows(db: Session, contribution_id: int) -> list[ReturnLedger]:
    return (
        db.query(ReturnLedger)
        .filter(ReturnLedger.contribution_id == contribution_id)
        .order_by(ReturnLedger.period_end.asc(), ReturnLedger.id.asc())
        .all()
    )


def recompute_balances(db: Session, contribution: Contribution) -> Decimal:
    """
    Walk the contribution's periods chronologically, recomputing every unpaid
    row's return and balances from the running balance. Paid rows are
    immutable — their stored amount/action still shape the balance, but the
    rows themselves are never rewritten. Returns the final balance.

    Runs inside the caller's transaction — caller commits (or rolls back),
    so a partially recomputed ledger is never persisted.
    """
    balance = Decimal(contribution.amount)
    for row in _ordered_rows(db, contribution.id):
        if row.paid:
            if row.period_action == "compound":
                balance += Decimal(row.amount)
            continue
        row.amount = _money(balance * MONTHLY_RETURN_RATE)
        row.running_balance = _money(balance)
        if row.period_action == "compound":
            balance += Decimal(row.amount)
        row.post_action_balance = _money(balance)
    return _money(balance)


def is_owner_contribution(contribution: Contribution) -> bool:
    """True when this contribution is the fund operator's own capital."""
    return bool(contribution.investor and contribution.investor.is_owner)


def sync_ledger(db: Session, contribution: Contribution,
                today: Optional[date] = None) -> None:
    """
    Ensure an active contribution has one ledger row per elapsed anniversary
    month (period_action defaulting from payout_type), then recompute the
    balance walk. Idempotent. Caller is responsible for db.commit().

    Owner contributions never accrue: the owner's money is capital, not a
    fixed-rate loan from an investor, so paying itself 5% a month would
    manufacture a liability owed to nobody. The guard lives HERE, at the only
    place ledger rows are created, so no route or bulk path can bypass it.
    """
    if contribution.status != "active":
        return
    if is_owner_contribution(contribution):
        return
    elapsed = months_elapsed(contribution.date_contributed, today)
    existing = (
        db.query(ReturnLedger)
        .filter(ReturnLedger.contribution_id == contribution.id)
        .count()
    )
    for n in range(existing + 1, elapsed + 1):
        db.add(ReturnLedger(
            contribution_id=contribution.id,
            period_start=anniversary(contribution.date_contributed, n - 1),
            period_end=anniversary(contribution.date_contributed, n),
            amount=Decimal("0"),  # set by the balance walk below
            period_action=DEFAULT_ACTION[contribution.payout_type],
            paid=False,
        ))
    db.flush()
    recompute_balances(db, contribution)


def recompute_unpaid_ledger(db: Session, contribution: Contribution,
                            today: Optional[date] = None) -> None:
    """
    Regenerate a contribution's unpaid ledger after its terms changed
    (amount or date_contributed — a payout_type-only change just alters the
    default for future periods and is handled without regeneration).

    Paid rows represent money that actually moved — they are never touched.
    All unpaid rows are deleted and regenerated under the new terms at the
    contribution's current default action.
    """
    db.query(ReturnLedger).filter(
        ReturnLedger.contribution_id == contribution.id,
        ReturnLedger.paid == False,  # noqa: E712
    ).delete(synchronize_session="fetch")
    sync_ledger(db, contribution, today)


def set_period_action(db: Session, row: ReturnLedger, action: str) -> None:
    """
    Flip an UNPAID row's period_action and cascade the recompute through all
    later unpaid rows (the balance base changed). Caller must have verified
    row.paid is False and commits the transaction.
    """
    row.period_action = action
    recompute_balances(db, row.contribution)


def current_balance(db: Session, contribution: Contribution) -> Decimal:
    """Principal plus every compounded return (paid rows honoured as stored)."""
    balance = Decimal(contribution.amount)
    for row in _ordered_rows(db, contribution.id):
        if row.period_action == "compound":
            balance += Decimal(row.amount)
    return _money(balance)


def unpaid_cash_rows(db: Session, contribution: Contribution) -> list[ReturnLedger]:
    """Cash returns still owed: period_action='paid' and not yet settled."""
    return [
        r for r in _ordered_rows(db, contribution.id)
        if r.period_action == "paid" and not r.paid
    ]


def contribution_to_response(db: Session, contribution: Contribution,
                             today: Optional[date] = None) -> dict:
    """Build the ContributionResponse dict with computed fields."""
    elapsed = months_elapsed(contribution.date_contributed, today)
    is_active = contribution.status == "active"

    unpaid = unpaid_cash_rows(db, contribution)
    owed = float(sum((Decimal(r.amount) for r in unpaid), Decimal("0")))
    balance = float(current_balance(db, contribution)) if is_active else float(contribution.amount)

    if contribution.payout_type == "monthly":
        owed_or_balance = owed
        due = next_due_date(contribution.date_contributed, today) if is_active else None
        period_start = anniversary(contribution.date_contributed, elapsed) if is_active else None
    else:
        owed_or_balance = balance
        due = None
        period_start = None

    return {
        "id": contribution.id,
        "investor_id": contribution.investor_id,
        "investor_name": contribution.investor.name,
        "investor_contact": contribution.investor.contact,
        "investor_is_owner": bool(contribution.investor.is_owner),
        "amount": float(contribution.amount),
        "date_contributed": contribution.date_contributed,
        "payout_type": contribution.payout_type,
        "status": contribution.status,
        "notes": contribution.notes,
        "created_at": contribution.created_at,
        "months_elapsed": elapsed,
        "current_period_start": period_start,
        "oldest_unpaid_due_date": unpaid[0].period_end if unpaid else None,
        "current_owed_or_balance": owed_or_balance,
        "next_due_date": due,
        "unpaid_ledger_id": unpaid[0].id if unpaid else None,
    }


def withdraw_contribution(db: Session, contribution: Contribution,
                          payment_method: str,
                          today: Optional[date] = None) -> ReturnLedger:
    """
    Close a compound-default contribution: pay out balance - principal in one
    paid ledger row and mark the contribution withdrawn. v1 has no partial
    withdrawals. Caller is responsible for db.commit().
    """
    today = today or date.today()
    balance = current_balance(db, contribution)
    row = ReturnLedger(
        contribution_id=contribution.id,
        period_start=contribution.date_contributed,
        period_end=today,
        amount=_money(balance - Decimal(contribution.amount)),
        period_action="paid",
        running_balance=balance,
        post_action_balance=balance,
        paid=True,
        paid_date=datetime.utcnow(),
        payment_method=payment_method,
    )
    db.add(row)
    contribution.status = "withdrawn"
    return row


# ---------------------------------------------------------------------------
# Liability
# ---------------------------------------------------------------------------
#
# Every ledger row belongs to EXACTLY ONE of these buckets. The pair
# (period_action, paid) is total and mutually exclusive, so no row can be
# counted twice or dropped:
#
#   COMPOUND  action='compound'          the return rolled into the balance
#                                        and is ALREADY inside
#                                        post_action_balance. Adding it to
#                                        returns_owed would double-count it.
#   OWED      action='paid', paid=False  cash owed. NOT in the balance (a
#                                        'paid' period leaves the base
#                                        unchanged), so it must ALWAYS be
#                                        added.
#   SETTLED   action='paid', paid=True   cash that already moved. In neither
#                                        aggregate — it is history.

BUCKET_COMPOUND = "compound_in_balance"
BUCKET_OWED = "owed_as_cash"
BUCKET_SETTLED = "already_settled"


def classify_ledger_row(row: ReturnLedger) -> str:
    """Which liability bucket this row falls in. Total and exclusive."""
    if row.period_action == "compound":
        return BUCKET_COMPOUND
    return BUCKET_SETTLED if row.paid else BUCKET_OWED


def latest_balance(db: Session, contribution: Contribution) -> Decimal:
    """
    The contribution's balance as of its most recent period — the post-action
    balance of the last ledger row, which already carries every compounded
    return.

    Falls back to the principal when no periods have accrued yet, and to the
    compound walk for legacy rows written before post_action_balance existed.
    """
    rows = _ordered_rows(db, contribution.id)
    if not rows:
        return _money(Decimal(contribution.amount))
    last = rows[-1]
    if last.post_action_balance is None:
        return current_balance(db, contribution)
    return _money(Decimal(last.post_action_balance))


def active_investor_contributions(db: Session) -> list[Contribution]:
    """
    Active contributions that are somebody else's money. Owner rows are
    capital, not a liability, so they are excluded here once and every
    liability aggregate inherits the exclusion.
    """
    return (
        db.query(Contribution)
        .join(Investor, Contribution.investor_id == Investor.id)
        .filter(Contribution.status == "active", Investor.is_owner == False)  # noqa: E712
        .order_by(Contribution.id.asc())
        .all()
    )


def owner_capital_in(db: Session) -> Decimal:
    """
    Owner deposits net of owner withdrawals. Withdrawals are stored as
    negative-amount contributions, so this is a plain SUM.
    """
    total = (
        db.query(func.coalesce(func.sum(Contribution.amount), 0))
        .join(Investor, Contribution.investor_id == Investor.id)
        .filter(Investor.is_owner == True)  # noqa: E712
        .scalar()
    )
    return _money(Decimal(str(total)))


def liability_partition(db: Session, today: Optional[date] = None) -> dict:
    """
    What the fund owes its investors, split into the buckets above.

        investor_balance = sum of latest post-action balances (compounded
                           returns included; principal when nothing has
                           accrued yet)
        returns_owed     = sum of unpaid 'paid'-action rows
        total_liability  = investor_balance + returns_owed

    Materialises any periods that came due since the last read. Runs inside
    the caller's transaction — caller commits.
    """
    contributions = active_investor_contributions(db)
    for c in contributions:
        sync_ledger(db, c, today)
    db.flush()

    investor_balance = Decimal("0")
    returns_owed = Decimal("0")
    settled = Decimal("0")

    for c in contributions:
        investor_balance += latest_balance(db, c)
        for row in _ordered_rows(db, c.id):
            bucket = classify_ledger_row(row)
            if bucket == BUCKET_OWED:
                returns_owed += Decimal(row.amount)
            elif bucket == BUCKET_SETTLED:
                settled += Decimal(row.amount)
            # BUCKET_COMPOUND is already inside investor_balance — never here.

    investor_balance = _money(investor_balance)
    returns_owed = _money(returns_owed)
    return {
        "investor_balance": investor_balance,
        "returns_owed": returns_owed,
        "total_liability": _money(investor_balance + returns_owed),
        "settled_to_date": _money(settled),
        "contributions": contributions,
    }


def pool_summary(db: Session, today: Optional[date] = None) -> dict:
    """
    total_pool               sum of active non-owner principals
    investor_balance          sum of active non-owner balances — principal
                              plus every compounded return
    returns_owed              sum of unpaid cash returns (per-row period_action)
    total_liability           investor_balance + returns_owed — the real number
                              owed if every investor closed out today
    total_after_returns       alias of total_liability (the existing tile)
    contributors_count        distinct investors with >= 1 active contribution,
                              EXCLUDING the owner
    total_paid_out            sum of every ledger row ever actually settled
                              (paid=True) — monthly cash-outs and withdrawal
                              payouts, across active AND withdrawn contributions
    owner_capital_in          owner deposits net of owner withdrawals
    monthly_principal_base    sum of active 'monthly' contributions' principal —
                              the base the frontend's cosmetic live-ticker
                              accrues against between refreshes
    monthly_return_rate       MONTHLY_RETURN_RATE, so the frontend ticker rate
                              stays in sync with the backend without duplicating
                              the constant
    """
    parts = liability_partition(db, today)
    db.commit()
    contributions = parts["contributions"]

    total_pool = sum((Decimal(c.amount) for c in contributions), Decimal("0"))
    monthly_principal_base = sum(
        (Decimal(c.amount) for c in contributions if c.payout_type == "monthly"),
        Decimal("0"),
    )

    total_paid_out = db.query(
        func.coalesce(func.sum(ReturnLedger.amount), 0)
    ).filter(ReturnLedger.paid == True).scalar()  # noqa: E712

    return {
        "total_pool": float(_money(total_pool)),
        "investor_balance": float(parts["investor_balance"]),
        "returns_owed": float(parts["returns_owed"]),
        "total_liability": float(parts["total_liability"]),
        "total_after_returns": float(parts["total_liability"]),
        "contributors_count": len({c.investor_id for c in contributions}),
        "total_paid_out": float(_money(Decimal(str(total_paid_out)))),
        "owner_capital_in": float(owner_capital_in(db)),
        "monthly_principal_base": float(_money(monthly_principal_base)),
        "monthly_return_rate": float(MONTHLY_RETURN_RATE),
    }


def _contribution_value_at(contribution: Contribution, rate: Decimal, at: date) -> Decimal:
    """
    Approximate one contribution's total wealth generated by date `at` — its
    principal plus every return earned since (compounded in, or paid out as
    cash). Mirrors the rate/anniversary rules in recompute_balances without
    touching the DB or any per-period paid/compound overrides, so it's an
    approximation for the growth-chart trend line only — the ledger endpoints
    remain the source of truth for actual owed/paid amounts.
    """
    if at < contribution.date_contributed:
        return Decimal("0")
    n = months_elapsed(contribution.date_contributed, at)
    principal = Decimal(contribution.amount)
    if contribution.payout_type == "compound":
        return _money(principal * (Decimal(1) + rate) ** n)
    return _money(principal + principal * rate * n)


def _savings_benchmark_value_at(contribution: Contribution, apy: Decimal, at: date) -> Decimal:
    """What this contribution's principal would be worth in a flat-APY savings
    account (compounded monthly) instead, over the same elapsed time."""
    if at < contribution.date_contributed:
        return Decimal("0")
    n = months_elapsed(contribution.date_contributed, at)
    monthly_rate = apy / Decimal(12)
    principal = Decimal(contribution.amount)
    return _money(principal * (Decimal(1) + monthly_rate) ** n)


def growth_series(db: Session, today: Optional[date] = None,
                   projection_months: int = GROWTH_PROJECTION_MONTHS) -> dict:
    """
    Monthly pool-value trend from the first active contribution to today, plus
    `projection_months` of projected trend beyond today assuming today's active
    contributions keep accruing at MONTHLY_RETURN_RATE — alongside a benchmark
    of the same deposit schedule sitting in a flat SAVINGS_BENCHMARK_APY savings
    account. Only active contributions are included (matches pool_summary).

    Approximate — see _contribution_value_at — this powers the dashboard trend
    chart, not accounting.
    """
    today = today or date.today()
    active = active_investor_contributions(db)
    if not active:
        return {"points": [], "savings_apy": float(SAVINGS_BENCHMARK_APY)}

    start = min(c.date_contributed for c in active)
    end = anniversary(today, projection_months)

    points = []
    cursor = start
    while cursor <= end:
        pool_value = sum(
            (_contribution_value_at(c, MONTHLY_RETURN_RATE, cursor) for c in active),
            Decimal("0"),
        )
        benchmark_value = sum(
            (_savings_benchmark_value_at(c, SAVINGS_BENCHMARK_APY, cursor) for c in active),
            Decimal("0"),
        )
        points.append({
            "date": cursor,
            "pool_value": float(pool_value),
            "benchmark_value": float(benchmark_value),
            "projected": cursor > today,
        })
        cursor = anniversary(cursor, 1)

    return {"points": points, "savings_apy": float(SAVINGS_BENCHMARK_APY)}


# ---------------------------------------------------------------------------
# Owner equity — snapshots and time-weighted growth
# ---------------------------------------------------------------------------
#
#     owner_equity = account_equity - (investor_balance + returns_owed)
#
# account_equity is the total KCEX account value, entered by hand. Everything
# below the line is what the fund owes; whatever is left over is mine. It can
# go negative — that means the account no longer covers the obligations, and
# it is the single most important number on the page, so nothing here clamps
# or hides it.


def snapshot_derived_values(db: Session, account_equity: Decimal,
                            today: Optional[date] = None) -> dict:
    """
    The liability split and owner equity AS OF NOW, for freezing into a
    snapshot row. Callers store these — they are never recomputed later,
    because replaying today's ledger against an old date would drift as
    periods accrue and rows get flipped.
    """
    parts = liability_partition(db, today)
    investor_balance = parts["investor_balance"]
    returns_owed = parts["returns_owed"]
    return {
        "investor_balance_at": investor_balance,
        "returns_owed_at": returns_owed,
        "owner_equity_at": _money(account_equity - investor_balance - returns_owed),
    }


def owner_flow_between(db: Session, after: Optional[date], through: date) -> Decimal:
    """
    Net owner capital moved in the half-open interval (after, through].

    Deposits are positive contributions, withdrawals negative, so this is a
    plain SUM. Half-open on the left so a flow landing exactly on a snapshot
    date belongs to the period that ENDS on it — the snapshot was taken after
    the money moved.
    """
    q = (
        db.query(func.coalesce(func.sum(Contribution.amount), 0))
        .join(Investor, Contribution.investor_id == Investor.id)
        .filter(Investor.is_owner == True,  # noqa: E712
                Contribution.date_contributed <= through)
    )
    if after is not None:
        q = q.filter(Contribution.date_contributed > after)
    return _money(Decimal(str(q.scalar())))


def twr_chain(db: Session, snapshots: list[EquitySnapshot]) -> list[dict]:
    """
    Time-weighted return across consecutive snapshots, chained.

    Between S0 and S1:

        net_flow = owner capital moved in (S0.date, S1.date]
        r        = (S1.owner_equity - S0.owner_equity - net_flow) / S0.owner_equity

    Subtracting net_flow is what makes it time-WEIGHTED: depositing 1000 of my
    own money grows owner equity by 1000 without the account having returned
    anything, and a naive (end - start) / start would book that as performance.

    Chained: cumulative = prod(1 + r) - 1 over every measurable period.

    Guard: a period whose STARTING owner equity is <= 0 has no meaningful
    base — dividing by it yields either a zero-division or a sign-flipped
    return that would corrupt the whole chain. Such periods are skipped and
    flagged (period_skipped) rather than fudged, and the chain continues from
    the last good link.

    `snapshots` must be ordered by snapshot_date ascending.
    """
    out: list[dict] = []
    chain = Decimal("1")
    any_measured = False
    previous: Optional[EquitySnapshot] = None

    for snap in snapshots:
        net_flow = Decimal("0")
        period_return: Optional[Decimal] = None
        skipped = False

        if previous is not None:
            net_flow = owner_flow_between(db, previous.snapshot_date, snap.snapshot_date)
            base = Decimal(previous.owner_equity_at)
            if base <= 0:
                skipped = True
            else:
                gain = Decimal(snap.owner_equity_at) - base - net_flow
                period_return = gain / base
                chain *= (Decimal("1") + period_return)
                any_measured = True

        out.append({
            "id": snap.id,
            "snapshot_date": snap.snapshot_date,
            "account_equity": float(Decimal(snap.account_equity)),
            "investor_balance_at": float(Decimal(snap.investor_balance_at)),
            "returns_owed_at": float(Decimal(snap.returns_owed_at)),
            "total_liability_at": float(
                _money(Decimal(snap.investor_balance_at) + Decimal(snap.returns_owed_at))
            ),
            "owner_equity_at": float(Decimal(snap.owner_equity_at)),
            "note": snap.note,
            "created_at": snap.created_at,
            "net_owner_flow": float(net_flow),
            "period_return": float(period_return) if period_return is not None else None,
            "period_skipped": skipped,
            "cumulative_return": float(chain - Decimal("1")) if any_measured else None,
        })
        previous = snap

    return out


def list_equity_snapshots(db: Session) -> list[dict]:
    """Every snapshot oldest-first, each with its period and cumulative TWR."""
    snapshots = (
        db.query(EquitySnapshot)
        .order_by(EquitySnapshot.snapshot_date.asc(), EquitySnapshot.id.asc())
        .all()
    )
    return twr_chain(db, snapshots)


def break_even_account_return(investor_balance: Decimal,
                              account_equity: Decimal) -> Optional[Decimal]:
    """
    The account return needed next period just to stand still.

    Next period every active investor balance accrues one more 5% return —
    compounded into the balance or owed as cash, either way the liability
    grows by rate * investor_balance. Earn exactly this and owner equity is
    flat; earn less and it erodes.

    None when there is no positive account equity to measure against.
    """
    if account_equity <= 0:
        return None
    return (MONTHLY_RETURN_RATE * investor_balance) / account_equity


def owner_summary(db: Session, today: Optional[date] = None) -> dict:
    """
    The owner-equity tiles.

    account_equity and snapshot_date come from the most recent snapshot —
    manual entry is the only source. The liability figures are LIVE, so
    owner_equity is what I am worth RIGHT NOW against that last reading:
    if returns have accrued since, equity falls, which is exactly the drift
    the tile needs to surface. Period and cumulative returns come from the
    stored snapshot chain and are never recomputed.
    """
    parts = liability_partition(db, today)
    db.commit()
    investor_balance = parts["investor_balance"]
    returns_owed = parts["returns_owed"]
    total_liability = parts["total_liability"]

    latest = (
        db.query(EquitySnapshot)
        .order_by(EquitySnapshot.snapshot_date.desc(), EquitySnapshot.id.desc())
        .first()
    )

    chain = list_equity_snapshots(db)
    period_return = chain[-1]["period_return"] if chain else None
    cumulative_return = chain[-1]["cumulative_return"] if chain else None

    account_equity = Decimal(latest.account_equity) if latest else None
    owner_equity = (
        _money(account_equity - total_liability) if account_equity is not None else None
    )
    break_even = (
        break_even_account_return(investor_balance, account_equity)
        if account_equity is not None else None
    )

    # Same staleness rule the composition ring uses, so the tile badge and the
    # chart badge can never disagree.
    is_stale = bool(latest) and (
        (today or date.today()) - latest.snapshot_date
    ).days > SNAPSHOT_STALE_DAYS

    return {
        "account_equity": float(account_equity) if account_equity is not None else None,
        "snapshot_date": latest.snapshot_date if latest else None,
        "is_stale": is_stale,
        "investor_balance": float(investor_balance),
        "returns_owed": float(returns_owed),
        "total_liability": float(total_liability),
        "owner_equity": float(owner_equity) if owner_equity is not None else None,
        "owner_capital_in": float(owner_capital_in(db)),
        "period_return": period_return,
        "cumulative_return": cumulative_return,
        "break_even_account_return": float(break_even) if break_even is not None else None,
    }


# ---------------------------------------------------------------------------
# Equity composition — who has a claim on the account, as a ring
# ---------------------------------------------------------------------------
#
# The donut used to plot capital contributed, which answers the wrong
# question: principal is what people put in, not what they can walk away
# with. Every investor's claim is their compounded balance PLUS any cash
# return already accrued but not yet paid; whatever the account holds beyond
# the sum of those claims is mine.
#
# Two render modes, because a negative owner equity is not a small slice —
# it is a different picture:
#
#   solvent  account_equity > total_liability. Ring = account_equity:
#            every investor claim plus one owner slice for the remainder.
#   deficit  account_equity <= total_liability. There is no positive owner
#            claim to draw, so the owner slice is omitted entirely and a
#            synthetic Deficit slice carries the shortfall.
#
# In both modes `share` divides by the SUM OF EMITTED SLICE VALUES, so the
# shares always total 1.0 and the ring always closes at 360 degrees. In
# solvent mode that denominator IS account_equity (claims + owner equity ==
# account equity by construction). In deficit mode it is total_liability +
# the shortfall, which exceeds the liability — dividing by the liability
# alone would produce shares summing to ~1.18 and a ring that cannot be
# drawn.
#
# No slice value is ever negative, and owner_equity is never abs()'d — the
# sign is the signal.

# A snapshot older than this is flagged; account_equity is entered by hand,
# so a stale reading silently drifts from reality as the market moves.
SNAPSHOT_STALE_DAYS = 7


def contribution_claim(db: Session, contribution: Contribution) -> Decimal:
    """
    What one contribution could walk away with today: its current balance
    plus cash returns accrued but not yet settled.

    Both terms come from the buckets in classify_ledger_row — compounded
    returns are already inside the balance, unpaid cash rows are not.
    """
    owed = sum(
        (Decimal(row.amount) for row in _ordered_rows(db, contribution.id)
         if classify_ledger_row(row) == BUCKET_OWED),
        Decimal("0"),
    )
    return _money(latest_balance(db, contribution) + owed)


def equity_composition(db: Session, today: Optional[date] = None) -> dict:
    """
    The claim-on-account-equity ring. See the module comment above for the
    two modes and the share denominator.

    With no snapshot on file there is no account equity, so solvency is
    undecidable: mode is 'unknown', slices is empty and account_equity is
    None. Callers must render an empty state rather than invent a total.
    """
    today = today or date.today()
    parts = liability_partition(db, today)
    db.commit()
    total_liability = parts["total_liability"]

    # One slice per INVESTOR, not per contribution — someone with three
    # contributions holds one claim on the account.
    grouped: dict[int, dict] = {}
    for contribution in parts["contributions"]:
        entry = grouped.setdefault(contribution.investor_id, {
            "label": contribution.investor.name,
            "value": Decimal("0"),
        })
        entry["value"] += contribution_claim(db, contribution)

    # Ordered by investor id so colours stay put as investors are added.
    investor_slices = [
        {"label": e["label"], "value": _money(e["value"]), "is_owner": False}
        for _, e in sorted(grouped.items())
    ]

    latest = (
        db.query(EquitySnapshot)
        .order_by(EquitySnapshot.snapshot_date.desc(), EquitySnapshot.id.desc())
        .first()
    )

    if latest is None:
        return {
            "mode": "unknown",
            "account_equity": None,
            "snapshot_date": None,
            "is_stale": False,
            "slices": [],
            "deficit_amount": None,
            "total_liability": float(total_liability),
        }

    account_equity = Decimal(latest.account_equity)
    owner_equity = account_equity - total_liability
    is_stale = (today - latest.snapshot_date).days > SNAPSHOT_STALE_DAYS

    if owner_equity > 0:
        mode = "solvent"
        deficit_amount = None
        # Owner first so its position never shifts as investors come and go.
        slices = [{"label": "My Equity", "value": _money(owner_equity), "is_owner": True}]
        slices.extend(investor_slices)
    else:
        mode = "deficit"
        deficit_amount = _money(total_liability - account_equity)
        # No owner slice: there is no positive owner claim to draw.
        slices = list(investor_slices)
        # Exactly break-even (owner_equity == 0) is still the deficit mode —
        # there is no owner claim — but a zero-value wedge would be an
        # invisible slice carrying a legend entry, so it is not emitted.
        if deficit_amount > 0:
            slices.append({"label": "Deficit", "value": deficit_amount, "is_owner": False})

    denominator = sum((s["value"] for s in slices), Decimal("0"))
    for s in slices:
        s["share"] = float(s["value"] / denominator) if denominator > 0 else 0.0
        s["value"] = float(s["value"])

    return {
        "mode": mode,
        "account_equity": float(account_equity),
        "snapshot_date": latest.snapshot_date,
        "is_stale": is_stale,
        "slices": slices,
        "deficit_amount": float(deficit_amount) if deficit_amount is not None else None,
        "total_liability": float(total_liability),
    }
