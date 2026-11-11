"""
Fund Pool logic tests — run with:  venv/Scripts/python backend/test_fund_pool.py

Covers the per-period paid/compound engine:
  1. 3-period contribution (principal 1000), actions paid/compound/paid:
     period 3's return must be 1050 * 0.05 = 52.50, not 50 — the compounded
     base carries forward.
  2. Flipping period 2 back to 'paid' after period 3 exists recomputes
     period 3 back down to 50.
  3. Rows with paid=True are immutable through any recompute.
  4. Mark-paid with a period_action='paid' override on a compound row flips
     it and cascades to later unpaid rows.
  5. Contribution edit (amount) keeps paid rows untouched, regenerates
     unpaid rows at the new principal.

Route-level checks (missing payment_method → 422, set-action on a paid row
→ 409) are HTTP validation and are exercised by the endpoint smoke test.
"""

from datetime import date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from database import Base, Contribution, EquitySnapshot, Investor, ReturnLedger
import fund_pool as fp

TODAY = date(2026, 7, 12)  # fixed so month counts are deterministic


def make_session():
    engine = create_engine("sqlite:///:memory:")
    Base.metadata.create_all(bind=engine)
    return sessionmaker(bind=engine)()


def seed(db, payout_type="monthly", amount="1000", start=date(2026, 3, 25)):
    """Contribution with 3 elapsed anniversary months by TODAY (Apr/May/Jun 25)."""
    investor = Investor(name="Alice")
    db.add(investor)
    db.flush()
    c = Contribution(
        investor_id=investor.id, amount=Decimal(amount),
        date_contributed=start, payout_type=payout_type,
    )
    db.add(c)
    db.flush()
    fp.sync_ledger(db, c, TODAY)
    db.commit()
    return c


def rows_of(db, c):
    return (
        db.query(ReturnLedger)
        .filter(ReturnLedger.contribution_id == c.id)
        .order_by(ReturnLedger.period_end.asc(), ReturnLedger.id.asc())
        .all()
    )


def test_compound_base_carries_forward():
    db = make_session()
    c = seed(db)  # monthly default → 3 rows, action 'paid', 50 each

    rows = rows_of(db, c)
    assert [float(r.amount) for r in rows] == [50.0, 50.0, 50.0]
    assert all(r.period_action == "paid" for r in rows)

    # Flip period 2 to compound: paid / compound / paid
    fp.set_period_action(db, rows[1], "compound")
    db.commit()

    rows = rows_of(db, c)
    assert float(rows[0].amount) == 50.0
    assert float(rows[0].running_balance) == 1000.0 and float(rows[0].post_action_balance) == 1000.0
    assert float(rows[1].amount) == 50.0
    assert float(rows[1].post_action_balance) == 1050.0, "compound adds the return to the balance"
    assert float(rows[2].amount) == 52.50, f"period 3 must compound off 1050, got {rows[2].amount}"
    assert float(rows[2].running_balance) == 1050.0
    assert float(rows[2].post_action_balance) == 1050.0  # 'paid' leaves balance unchanged
    assert float(fp.current_balance(db, c)) == 1050.0
    print("ok  paid/compound/paid: period 3 return = 52.50 off the compounded base")
    return db, c


def test_flip_back_recomputes_down():
    db, c = test_compound_base_carries_forward()
    rows = rows_of(db, c)

    fp.set_period_action(db, rows[1], "paid")
    db.commit()

    rows = rows_of(db, c)
    assert [float(r.amount) for r in rows] == [50.0, 50.0, 50.0], "period 3 must drop back to 50"
    assert float(rows[2].running_balance) == 1000.0
    assert float(fp.current_balance(db, c)) == 1000.0
    print("ok  flip period 2 back to paid: period 3 recomputed down to 50")


def test_paid_rows_immutable_through_recompute():
    db = make_session()
    c = seed(db)
    rows = rows_of(db, c)

    # Pay period 1 at the original terms
    rows[0].paid = True
    rows[0].paid_date = datetime.utcnow()
    rows[0].payment_method = "cash"
    db.commit()
    locked_amount = float(rows[0].amount)

    # Flip period 2 to compound (cascade) and edit the principal (regenerate)
    fp.set_period_action(db, rows[1], "compound")
    db.commit()
    c.amount = Decimal("2000")
    fp.recompute_unpaid_ledger(db, c, TODAY)
    db.commit()

    rows = rows_of(db, c)
    paid = [r for r in rows if r.paid]
    assert len(paid) == 1
    assert float(paid[0].amount) == locked_amount == 50.0, "paid row must keep its amount"
    assert paid[0].payment_method == "cash"

    unpaid = [r for r in rows if not r.paid]
    assert len(unpaid) == 2
    # Regeneration resets to the contribution default ('paid') at new principal
    assert all(float(r.amount) == 100.0 and r.period_action == "paid" for r in unpaid)
    print("ok  paid rows immutable; unpaid regenerated at new principal")


def test_mark_paid_override_flips_and_cascades():
    db = make_session()
    c = seed(db, payout_type="compound")  # 3 rows, all action 'compound'

    rows = rows_of(db, c)
    assert [float(r.amount) for r in rows] == [50.0, 52.50, 55.125], "compound chain"
    assert float(fp.current_balance(db, c)) == 1157.625

    # Investor wants period 1 in cash after all: override to 'paid' + mark paid
    row = rows[0]
    row.period_action = "paid"
    row.paid = True
    row.paid_date = datetime.utcnow()
    row.payment_method = "bank_transfer"
    fp.recompute_balances(db, c)
    db.commit()

    rows = rows_of(db, c)
    assert rows[0].paid and rows[0].period_action == "paid"
    assert float(rows[0].amount) == 50.0
    assert float(rows[1].amount) == 50.0, "period 2 base back to 1000 after the flip"
    assert float(rows[2].amount) == 52.50, "period 3 compounds off 1050"
    assert float(fp.current_balance(db, c)) == 1102.50
    print("ok  mark-paid with override: compound row flipped, later periods cascaded")


def test_summary_uses_per_row_actions():
    db = make_session()
    c = seed(db)  # 3 x 50 owed
    rows = rows_of(db, c)
    fp.set_period_action(db, rows[1], "compound")
    db.commit()

    s = fp.pool_summary(db, TODAY)
    assert s["total_pool"] == 1000.0
    assert s["returns_owed"] == 102.50, f"50 + 52.50 cash owed, got {s['returns_owed']}"
    assert s["total_after_returns"] == 1152.50, "pool + owed + 50 compound accrual"
    assert s["contributors_count"] == 1
    print("ok  summary sums per-row actions (owed 102.50, accrual 50)")


# ═══════════════════════════════════════════════════════════════════════════
# Liability partition, owner exclusion, and time-weighted growth
# ═══════════════════════════════════════════════════════════════════════════

LIABILITY_TODAY = date(2026, 8, 25)  # 3 elapsed months from 2026-05-01


def seed_liability_fixture(db):
    """
    Three non-owner contributions, all dated 2026-05-01, 3 elapsed periods:

      A  $5,000  paid, paid, paid          periods 1 & 2 settled, 3 unpaid
      B  $3,000  compound x3               3000 * 1.05^3
      C  $2,000  compound, paid, compound  P2 owed as cash, P3 accrues on 2100

    Hand-verified targets:
      B balance        3472.875   (150 -> 3150, 157.50 -> 3307.50, 165.375)
      C balance        2205.00    (P3's base is 2100, NOT 2205 — the cash
                                   period in between leaves the base alone)
      investor_balance 10677.875  (5000 + 3472.875 + 2205)
      returns_owed       355.00   (A's P3 250 + C's P2 105)
      total_liability  11032.875
    """
    investor = Investor(name="Pool Investors")
    db.add(investor)
    db.flush()

    def add(amount, actions):
        c = Contribution(
            investor_id=investor.id, amount=Decimal(amount),
            date_contributed=date(2026, 5, 1), payout_type="monthly",
        )
        db.add(c)
        db.flush()
        fp.sync_ledger(db, c, LIABILITY_TODAY)
        db.flush()
        rows = rows_of(db, c)
        assert len(rows) == 3, f"expected 3 periods, got {len(rows)}"
        for row, action in zip(rows, actions):
            row.period_action = action
        fp.recompute_balances(db, c)
        db.flush()
        return c

    a = add("5000", ["paid", "paid", "paid"])
    b = add("3000", ["compound", "compound", "compound"])
    c = add("2000", ["compound", "paid", "compound"])

    # A's first two periods are settled cash; the third is still owed.
    for row in rows_of(db, a)[:2]:
        row.paid = True
        row.paid_date = datetime.utcnow()
        row.payment_method = "bank_transfer"
    fp.recompute_balances(db, a)
    db.commit()
    return a, b, c


def test_liability_partition():
    db = make_session()
    a, b, c = seed_liability_fixture(db)

    assert float(fp.latest_balance(db, b)) == 3472.875, \
        f"B must be 3000 * 1.05^3, got {fp.latest_balance(db, b)}"
    assert float(fp.latest_balance(db, c)) == 2205.00, \
        f"C's P3 accrues on 2100, not 2205, got {fp.latest_balance(db, c)}"
    assert float(fp.latest_balance(db, a)) == 5000.00, "cash periods never move the base"

    parts = fp.liability_partition(db, LIABILITY_TODAY)
    db.commit()
    assert float(parts["investor_balance"]) == 10677.875, \
        f"5000 + 3472.875 + 2205, got {parts['investor_balance']}"
    assert float(parts["returns_owed"]) == 355.00, \
        f"A's unpaid 250 + C's unpaid 105, got {parts['returns_owed']}"
    assert float(parts["total_liability"]) == 11032.875, \
        f"balance + owed, got {parts['total_liability']}"
    print("ok  liability partition: balance 10677.875 + owed 355.00 = 11032.875")
    return db, a, b, c


def test_every_ledger_row_lands_in_exactly_one_bucket():
    """
    The partition is the whole point of the fix: a compound row is inside
    running/post balances and must NEVER also be counted as cash owed, and a
    cash row is outside the balance and must ALWAYS be counted. Assert the
    classification is total (no row unbucketed) and exclusive (no row in two),
    then reconcile each bucket's sum against the reported aggregates.
    """
    db, a, b, c = test_liability_partition()
    parts = fp.liability_partition(db, LIABILITY_TODAY)
    db.commit()

    buckets = {fp.BUCKET_COMPOUND: [], fp.BUCKET_OWED: [], fp.BUCKET_SETTLED: []}
    all_rows = []
    for contribution in parts["contributions"]:
        for row in rows_of(db, contribution):
            all_rows.append(row)
            matches = [
                name for name, predicate in (
                    (fp.BUCKET_COMPOUND, row.period_action == "compound"),
                    (fp.BUCKET_OWED, row.period_action == "paid" and not row.paid),
                    (fp.BUCKET_SETTLED, row.period_action == "paid" and row.paid),
                ) if predicate
            ]
            assert len(matches) == 1, f"row {row.id} matched {matches}, must match exactly one"
            assert fp.classify_ledger_row(row) == matches[0]
            buckets[matches[0]].append(row)

    assert len(all_rows) == 9, f"3 contributions x 3 periods, got {len(all_rows)}"
    assert sum(len(v) for v in buckets.values()) == len(all_rows), "every row bucketed once"
    assert len(buckets[fp.BUCKET_COMPOUND]) == 5, "B's 3 + C's 2"
    assert len(buckets[fp.BUCKET_OWED]) == 2, "A's P3 + C's P2"
    assert len(buckets[fp.BUCKET_SETTLED]) == 2, "A's P1 and P2"

    owed_sum = sum((Decimal(r.amount) for r in buckets[fp.BUCKET_OWED]), Decimal("0"))
    assert float(owed_sum) == float(parts["returns_owed"]) == 355.00

    # The compound bucket is inside the balances, never added on top.
    compound_sum = sum((Decimal(r.amount) for r in buckets[fp.BUCKET_COMPOUND]), Decimal("0"))
    principal = sum((Decimal(x.amount) for x in parts["contributions"]), Decimal("0"))
    assert float(principal + compound_sum) == float(parts["investor_balance"]) == 10677.875, \
        "investor_balance == principal + compounded returns, with no cash rows in it"
    print("ok  every ledger row lands in exactly one bucket; sums reconcile")


def test_summary_matches_partition():
    db = make_session()
    seed_liability_fixture(db)
    s = fp.pool_summary(db, LIABILITY_TODAY)
    assert s["total_pool"] == 10000.0, "principal only"
    assert s["investor_balance"] == 10677.875
    assert s["returns_owed"] == 355.0
    assert s["total_liability"] == 11032.875
    assert s["total_after_returns"] == s["total_liability"], "the old tile now reads the fixed number"
    assert s["contributors_count"] == 1
    assert s["owner_capital_in"] == 0.0
    print("ok  pool_summary reports the partitioned liability")


# ── Owner ──────────────────────────────────────────────────────────────────


def seed_owner(db):
    """Owner with 4400 on 2026-05-01 and 1000 on 2026-07-15."""
    owner = Investor(name="Carlos", is_owner=True)
    db.add(owner)
    db.flush()
    for amount, when in (("4400", date(2026, 5, 1)), ("1000", date(2026, 7, 15))):
        c = Contribution(
            investor_id=owner.id, amount=Decimal(amount),
            date_contributed=when, payout_type="compound",
        )
        db.add(c)
        db.flush()
        fp.sync_ledger(db, c, LIABILITY_TODAY)
    db.commit()
    return owner


def test_owner_never_accrues_and_is_excluded():
    db = make_session()
    seed_liability_fixture(db)
    baseline = fp.pool_summary(db, LIABILITY_TODAY)

    owner = seed_owner(db)

    owner_rows = (
        db.query(ReturnLedger)
        .join(Contribution, ReturnLedger.contribution_id == Contribution.id)
        .filter(Contribution.investor_id == owner.id)
        .all()
    )
    assert owner_rows == [], \
        f"owner contributions must never generate ledger rows, got {len(owner_rows)}"

    s = fp.pool_summary(db, LIABILITY_TODAY)
    assert s["contributors_count"] == baseline["contributors_count"] == 1, \
        "the owner is not a contributor"
    assert s["investor_balance"] == 10677.875, "owner capital is not an investor balance"
    assert s["returns_owed"] == 355.0
    assert s["total_liability"] == baseline["total_liability"] == 11032.875, \
        "the owner's 5400 changes nothing on the liability side"
    assert s["total_pool"] == 10000.0, "owner principal is not pool principal"
    assert s["owner_capital_in"] == 5400.0
    print("ok  owner: zero ledger rows, excluded from every liability aggregate")


def test_owner_withdrawal_is_a_negative_contribution():
    """Capital out is a negative-amount row, so owner_capital_in nets by SUM."""
    db = make_session()
    owner = seed_owner(db)
    assert float(fp.owner_capital_in(db)) == 5400.0

    out = Contribution(
        investor_id=owner.id, amount=Decimal("-800"),
        date_contributed=date(2026, 8, 2), payout_type="compound",
    )
    db.add(out)
    db.flush()
    fp.sync_ledger(db, out, LIABILITY_TODAY)
    db.commit()

    assert float(fp.owner_capital_in(db)) == 4600.0, "5400 in, 800 out"
    assert rows_of(db, out) == [], "a withdrawal row does not accrue either"
    print("ok  owner withdrawal recorded as a negative contribution, nets to 4600")


# ── Time-weighted growth ───────────────────────────────────────────────────


def test_time_weighted_return_chain():
    """
    owner_equity 4400 -> 5800 -> 6767.125 with a +1000 owner deposit inside
    the first interval.

      r1 = (5800 - 4400 - 1000) / 4400   = 0.090909   NOT 1400/4400 = 0.318
      r2 = (6767.125 - 5800 - 0) / 5800  = 0.166746
      cumulative = 1.090909 * 1.166746 - 1 = 0.272814

    The naive (6767.125 - 4400 - 1000) / 4400 = 0.2652 and the un-flowed
    (6767.125 - 4400)/4400 = 0.5380 are both wrong; 0.2532 (chaining without
    removing the flow from r1 only) is the trap this asserts against.
    """
    db = make_session()
    seed_owner(db)  # 4400 on 05-01, 1000 on 07-15 — the flow inside period 1

    for when, equity, owner_equity in (
        (date(2026, 6, 1), "4400", "4400"),
        (date(2026, 8, 1), "5800", "5800"),
        (date(2026, 9, 1), "6767.125", "6767.125"),
    ):
        db.add(EquitySnapshot(
            snapshot_date=when,
            account_equity=Decimal(equity),
            investor_balance_at=Decimal("0"),
            returns_owed_at=Decimal("0"),
            owner_equity_at=Decimal(owner_equity),
        ))
    db.commit()

    chain = fp.list_equity_snapshots(db)
    assert chain[0]["period_return"] is None, "no return on the first snapshot"
    assert chain[0]["cumulative_return"] is None

    assert abs(chain[1]["net_owner_flow"] - 1000.0) < 1e-9, \
        "the 07-15 deposit falls inside (06-01, 08-01]"
    assert abs(chain[1]["period_return"] - 0.090909) < 1e-6, \
        f"r1 must strip the 1000 flow, got {chain[1]['period_return']}"
    assert abs(chain[2]["net_owner_flow"]) < 1e-9, "no flow in the second interval"
    assert abs(chain[2]["period_return"] - 0.166746) < 1e-6, \
        f"r2, got {chain[2]['period_return']}"
    assert abs(chain[2]["cumulative_return"] - 0.272814) < 1e-6, \
        f"chained product, not 0.2532, got {chain[2]['cumulative_return']}"
    print("ok  TWR: r1 0.090909, r2 0.166746, cumulative 0.272814")


def test_non_positive_base_period_is_skipped_not_divided():
    """A period starting from owner_equity <= 0 is flagged, never divided by."""
    db = make_session()
    for when, owner_equity in (
        (date(2026, 6, 1), "1000"),
        (date(2026, 7, 1), "-500"),   # underwater
        (date(2026, 8, 1), "800"),    # recovered — but r off a negative base is meaningless
    ):
        db.add(EquitySnapshot(
            snapshot_date=when,
            account_equity=Decimal("0"),
            investor_balance_at=Decimal("0"),
            returns_owed_at=Decimal("0"),
            owner_equity_at=Decimal(owner_equity),
        ))
    db.commit()

    chain = fp.list_equity_snapshots(db)
    assert chain[1]["period_skipped"] is False
    assert abs(chain[1]["period_return"] - (-1.5)) < 1e-9, "1000 -> -500 is a real -150%"
    assert chain[2]["period_skipped"] is True, "starting base was -500 — unmeasurable"
    assert chain[2]["period_return"] is None
    # The chain survives the gap rather than blowing up or silently zeroing.
    assert chain[2]["cumulative_return"] == chain[1]["cumulative_return"]
    print("ok  non-positive starting equity: period skipped and flagged, chain intact")


def test_owner_summary_reports_negative_equity_unclamped():
    db = make_session()
    seed_liability_fixture(db)   # liability 11032.875
    seed_owner(db)               # 5400 of my own capital in

    # Account is worth less than the fund owes.
    account_equity = Decimal("9000")
    derived = fp.snapshot_derived_values(db, account_equity, LIABILITY_TODAY)
    db.add(EquitySnapshot(
        snapshot_date=date(2026, 8, 25),
        account_equity=account_equity,
        note="underwater",
        **derived,
    ))
    db.commit()

    s = fp.owner_summary(db, LIABILITY_TODAY)
    assert s["total_liability"] == 11032.875
    assert s["owner_equity"] == -2032.875, \
        f"9000 - 11032.875, reported as-is, got {s['owner_equity']}"
    assert s["owner_capital_in"] == 5400.0
    assert s["account_equity"] == 9000.0

    # Next period the liability grows by 5% of the investor balance; that is
    # what the account has to earn just to stop equity sliding further.
    expected_break_even = 0.05 * 10677.875 / 9000
    assert abs(s["break_even_account_return"] - expected_break_even) < 1e-9
    print(f"ok  owner summary: equity -2032.875 unclamped, break-even "
          f"{s['break_even_account_return'] * 100:.2f}%")


def test_snapshot_values_are_frozen_not_recomputed():
    """A stored snapshot keeps its numbers when the ledger moves on."""
    db = make_session()
    a, b, c = seed_liability_fixture(db)

    derived = fp.snapshot_derived_values(db, Decimal("20000"), LIABILITY_TODAY)
    snap = EquitySnapshot(
        snapshot_date=date(2026, 8, 25), account_equity=Decimal("20000"), **derived,
    )
    db.add(snap)
    db.commit()
    frozen = float(snap.owner_equity_at)
    assert frozen == 20000 - 11032.875

    # Ledger moves on: flip C's cash period to compound, cascading a recompute.
    fp.set_period_action(db, rows_of(db, c)[1], "compound")
    db.commit()
    live = fp.liability_partition(db, LIABILITY_TODAY)
    db.commit()
    assert float(live["total_liability"]) != 11032.875, "the live number moved"

    db.refresh(snap)
    assert float(snap.owner_equity_at) == frozen, "the stored snapshot did not drift"
    assert float(snap.investor_balance_at) == 10677.875
    print("ok  snapshot values frozen at insert; live liability moves independently")


# ═══════════════════════════════════════════════════════════════════════════
# Equity composition — the claim-on-account-equity ring
# ═══════════════════════════════════════════════════════════════════════════


def seed_composition_fixture(db):
    """
    The A/B/C ledger fixture, but as THREE separate investors so each one is
    its own ring slice. Amounts, dates and period actions are identical to
    seed_liability_fixture, so the liability is the same 11032.875.

    Per-investor claims (balance + unpaid cash owed):
      A  5000.000 + 250 unpaid  =  5250.000
      B  3472.875 +   0         =  3472.875
      C  2205.000 + 105 unpaid  =  2310.000
                                  -----------
                                   11032.875   == total_liability
    """
    made = []
    for name, amount, actions in (
        ("Ana",   "5000", ["paid", "paid", "paid"]),
        ("Bruno", "3000", ["compound", "compound", "compound"]),
        ("Cleo",  "2000", ["compound", "paid", "compound"]),
    ):
        investor = Investor(name=name)
        db.add(investor)
        db.flush()
        c = Contribution(
            investor_id=investor.id, amount=Decimal(amount),
            date_contributed=date(2026, 5, 1), payout_type="monthly",
        )
        db.add(c)
        db.flush()
        fp.sync_ledger(db, c, LIABILITY_TODAY)
        db.flush()
        rows = rows_of(db, c)
        for row, action in zip(rows, actions):
            row.period_action = action
        fp.recompute_balances(db, c)
        db.flush()
        made.append(c)

    # Ana's first two periods are settled cash; the third is still owed.
    for row in rows_of(db, made[0])[:2]:
        row.paid = True
        row.paid_date = datetime.utcnow()
        row.payment_method = "bank_transfer"
    fp.recompute_balances(db, made[0])
    db.commit()
    return made


def add_snapshot(db, equity, when=LIABILITY_TODAY):
    derived = fp.snapshot_derived_values(db, Decimal(str(equity)), LIABILITY_TODAY)
    db.add(EquitySnapshot(
        snapshot_date=when, account_equity=Decimal(str(equity)), **derived,
    ))
    db.commit()


def test_composition_claims_sum_to_liability():
    """Each claim is balance + unpaid cash; together they ARE the liability."""
    db = make_session()
    a, b, c = seed_composition_fixture(db)
    assert float(fp.contribution_claim(db, a)) == 5250.000, "5000 balance + 250 owed"
    assert float(fp.contribution_claim(db, b)) == 3472.875, "compounded, nothing owed as cash"
    assert float(fp.contribution_claim(db, c)) == 2310.000, "2205 balance + 105 owed"

    parts = fp.liability_partition(db, LIABILITY_TODAY)
    db.commit()
    total_claims = sum(float(fp.contribution_claim(db, x)) for x in (a, b, c))
    assert total_claims == float(parts["total_liability"]) == 11032.875, \
        "claims must reconcile with the partition, not drift from it"
    print("ok  composition claims reconcile with liability_partition (11032.875)")


def test_composition_solvent():
    db = make_session()
    seed_composition_fixture(db)
    add_snapshot(db, 17800)

    comp = fp.equity_composition(db, LIABILITY_TODAY)
    assert comp["mode"] == "solvent", comp["mode"]
    assert comp["deficit_amount"] is None
    assert len(comp["slices"]) == 4, f"3 investors + owner, got {len(comp['slices'])}"

    owner = [s for s in comp["slices"] if s["is_owner"]]
    assert len(owner) == 1
    assert owner[0]["value"] == 6767.125, \
        f"17800 - 11032.875, got {owner[0]['value']}"
    assert owner[0]["label"] == "My Equity"
    assert comp["slices"][0]["is_owner"], "owner slice is pinned first"

    total_share = sum(s["share"] for s in comp["slices"])
    assert abs(total_share - 1.0) < 1e-9, f"shares must close the ring, got {total_share}"
    total_value = sum(s["value"] for s in comp["slices"])
    assert abs(total_value - 17800.0) < 1e-9, \
        "in solvent mode the ring IS the account equity"
    assert all(s["value"] > 0 for s in comp["slices"]), "no non-positive slice"
    print("ok  solvent: 4 slices, owner 6767.125, shares sum to 1.0, ring == 17800")


def test_composition_deficit():
    db = make_session()
    seed_composition_fixture(db)
    add_snapshot(db, 9000)

    comp = fp.equity_composition(db, LIABILITY_TODAY)
    assert comp["mode"] == "deficit", comp["mode"]
    assert not any(s["is_owner"] for s in comp["slices"]), \
        "there is no positive owner claim to draw"
    assert comp["deficit_amount"] == 2032.875, \
        f"11032.875 - 9000, got {comp['deficit_amount']}"

    deficit = [s for s in comp["slices"] if s["label"] == "Deficit"]
    assert len(deficit) == 1 and deficit[0]["value"] == 2032.875
    assert deficit[0]["value"] > 0, "the shortfall is emitted positive, never as -owner_equity"

    assert all(s["value"] > 0 for s in comp["slices"]), "no non-positive slice"
    total_share = sum(s["share"] for s in comp["slices"])
    assert abs(total_share - 1.0) < 1e-9, f"shares must close the ring, got {total_share}"
    assert len(comp["slices"]) == 4, "3 investors + deficit"
    print("ok  deficit: no owner slice, deficit 2032.875 positive, shares sum to 1.0")


def test_composition_never_emits_a_negative_or_absolute_value():
    """Deep underwater: the shortfall grows, the owner slice stays absent."""
    db = make_session()
    seed_composition_fixture(db)
    add_snapshot(db, 1)

    comp = fp.equity_composition(db, LIABILITY_TODAY)
    assert comp["mode"] == "deficit"
    assert comp["deficit_amount"] == 11031.875, "11032.875 - 1"
    assert all(s["value"] > 0 for s in comp["slices"])
    assert not any(s["label"] == "My Equity" for s in comp["slices"])
    # abs(owner_equity) would have produced a 11031.875 "My Equity" slice —
    # a loss rendered as if it were wealth.
    print("ok  deep deficit: shortfall 11031.875, no abs()'d owner slice")


def test_composition_zero_owner_equity_is_deficit_not_solvent():
    """Exactly break-even has no owner claim to draw, so it takes the deficit path."""
    db = make_session()
    seed_composition_fixture(db)
    add_snapshot(db, 11032.875)

    comp = fp.equity_composition(db, LIABILITY_TODAY)
    assert comp["mode"] == "deficit", "owner_equity == 0 is not solvent"
    assert comp["deficit_amount"] == 0.0
    # A zero-value wedge would be an invisible slice with a legend entry.
    assert all(s["value"] > 0 for s in comp["slices"]), \
        "a zero deficit must not be emitted as a slice"
    print("ok  owner_equity == 0 takes the deficit path with no zero-width wedge")


def test_composition_groups_contributions_by_investor():
    db = make_session()
    investor = Investor(name="Marta")
    db.add(investor)
    db.flush()
    for amount in ("1000", "4000"):
        c = Contribution(
            investor_id=investor.id, amount=Decimal(amount),
            date_contributed=date(2026, 5, 1), payout_type="compound",
        )
        db.add(c)
        db.flush()
        fp.sync_ledger(db, c, LIABILITY_TODAY)
    db.commit()

    # 1000 * 1.05^3 + 4000 * 1.05^3 = 5000 * 1.05^3
    expected = 5000 * 1.05 ** 3
    add_snapshot(db, 99000)

    comp = fp.equity_composition(db, LIABILITY_TODAY)
    investor_slices = [s for s in comp["slices"] if not s["is_owner"]]
    assert len(investor_slices) == 1, \
        f"two contributions, one investor, one slice — got {len(investor_slices)}"
    assert investor_slices[0]["label"] == "Marta"
    assert abs(investor_slices[0]["value"] - expected) < 1e-6, \
        f"claims must sum, got {investor_slices[0]['value']} vs {expected}"
    print(f"ok  two contributions collapse to one slice worth {expected:.3f}")


def test_composition_without_a_snapshot_is_unknown():
    """No account equity on file means solvency is undecidable — never faked."""
    db = make_session()
    seed_composition_fixture(db)

    comp = fp.equity_composition(db, LIABILITY_TODAY)
    assert comp["mode"] == "unknown"
    assert comp["account_equity"] is None
    assert comp["slices"] == [], "no ring without a denominator"
    assert comp["deficit_amount"] is None
    assert comp["total_liability"] == 11032.875, "the liability is still known"
    print("ok  no snapshot: mode 'unknown', empty slices, no fabricated equity")


def test_composition_staleness_matches_the_tiles():
    db = make_session()
    seed_composition_fixture(db)
    add_snapshot(db, 17800, when=LIABILITY_TODAY - timedelta(days=7))

    comp = fp.equity_composition(db, LIABILITY_TODAY)
    assert comp["is_stale"] is False, "exactly 7 days old is still fresh"
    assert fp.owner_summary(db, LIABILITY_TODAY)["is_stale"] is False

    db.query(EquitySnapshot).delete()
    db.commit()
    add_snapshot(db, 17800, when=LIABILITY_TODAY - timedelta(days=8))

    comp = fp.equity_composition(db, LIABILITY_TODAY)
    assert comp["is_stale"] is True, "8 days old is stale"
    assert fp.owner_summary(db, LIABILITY_TODAY)["is_stale"] is True, \
        "the tile and the chart must never disagree about staleness"
    print("ok  staleness: fresh at 7 days, stale at 8, tile and chart agree")


if __name__ == "__main__":
    # Per-period paid/compound engine
    test_compound_base_carries_forward()
    test_flip_back_recomputes_down()
    test_paid_rows_immutable_through_recompute()
    test_mark_paid_override_flips_and_cascades()
    test_summary_uses_per_row_actions()
    # Liability partition
    test_liability_partition()
    test_every_ledger_row_lands_in_exactly_one_bucket()
    test_summary_matches_partition()
    # Owner
    test_owner_never_accrues_and_is_excluded()
    test_owner_withdrawal_is_a_negative_contribution()
    # Owner equity growth
    test_time_weighted_return_chain()
    test_non_positive_base_period_is_skipped_not_divided()
    test_owner_summary_reports_negative_equity_unclamped()
    test_snapshot_values_are_frozen_not_recomputed()
    # Equity composition ring
    test_composition_claims_sum_to_liability()
    test_composition_solvent()
    test_composition_deficit()
    test_composition_never_emits_a_negative_or_absolute_value()
    test_composition_zero_owner_equity_is_deficit_not_solvent()
    test_composition_groups_contributions_by_investor()
    test_composition_without_a_snapshot_is_unknown()
    test_composition_staleness_matches_the_tiles()
    print("all fund-pool tests passed")
