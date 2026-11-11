# Trade-Tracker
With this tool you will be able to collect relevant Data related to your trades

## Fund Pool — investor returns tracker

The Fund Pool card tracks investor contributions with a fixed 5%/month return
(`MONTHLY_RETURN_RATE` in `backend/fund_pool.py`). State is persisted in
Postgres (`investors`, `contributions`, `return_ledger`, `equity_snapshots`
— see `backend/migrations/`), so it survives refreshes and restarts.

Every active contribution accrues one return period per elapsed anniversary
month. The paid-vs-compound decision lives **per period** on the ledger row
(`period_action`); the contribution's payout type is only the default for
newly generated periods:

- **Paid** — that period's return (5% of the running balance) is owed as
  cash and settled with **Mark Paid** (payment method required). The balance
  base is unchanged for the next period.
- **Compound** — the return rolls into the balance and becomes the base for
  the next period's return.

A single contribution can mix both: some months cashed out, others
compounded. Flipping an unpaid period recalculates every later unpaid period
(the base changed); rows already marked paid are immutable — that cash moved.
Each row stores the balance before and after its action, shown in the
per-contribution payment history (click any row in the Fund Pool table).
**Withdraw** on a compound contribution pays out `balance - principal` in a
single ledger entry and closes it (no partial withdrawals in v1).

Months are counted by anniversary day with month-end clamping — a Jan 31
contribution has its February anniversary on the last day of February.

### Liability

What the fund owes is the sum of two buckets, and every ledger row belongs to
exactly one of them:

| Bucket | Rows | Where it counts |
|---|---|---|
| Compounded | `period_action = 'compound'` | already inside `post_action_balance` |
| Owed | `period_action = 'paid'`, `paid = false` | `returns_owed` |
| Settled | `period_action = 'paid'`, `paid = true` | neither — that cash already moved |

```
investor_balance = sum of each active contribution's latest post_action_balance
returns_owed     = sum of unpaid 'paid'-action rows
total_liability  = investor_balance + returns_owed
```

A compound row is never added to `returns_owed` (it is already in the
balance) and a cash row is never left out of it (a 'paid' period leaves the
balance base alone). `test_every_ledger_row_lands_in_exactly_one_bucket`
asserts the classification is total and exclusive, then reconciles each
bucket's sum against the reported aggregate.

Ledger amounts are `NUMERIC(14, 4)`, not cents. A compounded chain generates
sub-cent returns — 3307.50 x 5% = 165.375 — and rounding each period to cents
before it becomes the next period's base drifts the balance away from
`principal * 1.05^n`. The frontend still formats to 2dp.

## Owner equity — how much of the account is actually mine

One investor may be flagged `is_owner`. Owner money is **capital, not an
investment**:

- Owner contributions **never** generate `return_ledger` rows. The guard is in
  `fund_pool.sync_ledger`, the only place rows are created, so no route can
  bypass it.
- Owner rows are excluded from `investor_balance`, `returns_owed`,
  `total_liability`, `total_pool`, `contributors_count`, the pie chart and the
  growth chart.
- **Owner withdrawals are negative-amount contributions**, so
  `owner_capital_in = SUM(amount)` is net of withdrawals with no extra column.
  The DB check is `amount <> 0`; the `> 0` rule for investors is enforced in
  the route, which is the only layer that can see `is_owner`. Owner rows
  cannot be closed through **Withdraw** — that path writes a payout ledger row.

A partial unique index (`ux_investors_single_owner`) allows at most one owner.

### Snapshots

`account_equity` — total KCEX account value — is **entered by hand** and never
derived from the trade log. Each snapshot freezes the liability split as it
stood at that moment:

```
owner_equity_at = account_equity - (investor_balance_at + returns_owed_at)
```

Those derived values are stored, not recomputed on read: replaying today's
ledger against an old date would drift as periods accrue and rows get
flipped, silently rewriting the growth history.

The **My Equity** tile pairs the latest snapshot's `account_equity` with the
**live** liability, so it reflects returns that have accrued since. When it
goes negative the tile turns red and states the shortfall — it is never
clamped or hidden, because it is the number that matters most.
`break_even_account_return` sits underneath it: `rate * investor_balance /
account_equity`, the return the account needs next month just to stop equity
eroding.

### Growth is time-weighted

Between consecutive snapshots S0 and S1:

```
net_flow   = owner capital moved in (S0.date, S1.date]
r          = (S1.owner_equity - S0.owner_equity - net_flow) / S0.owner_equity
cumulative = prod(1 + r) - 1
```

Subtracting `net_flow` is the point: depositing 1000 of my own money raises
owner equity by 1000 without the account having returned anything, and a
naive `(end - start) / start` would book that as performance.

If a period's **starting** owner equity is `<= 0` there is no meaningful base
to divide by, so that period is skipped and flagged (`period_skipped`) rather
than fudged; the chain continues from the last good link.

### Endpoints

```
POST   /fund-pool/equity-snapshots       { snapshot_date, account_equity, note }
GET    /fund-pool/equity-snapshots       history + period and cumulative TWR
DELETE /fund-pool/equity-snapshots/{id}
GET    /fund-pool/owner-summary          equity vs liability, growth, break-even
```

Investors are fixed-rate creditors, not unit holders — there is no pro-rata
or unit-based NAV accounting, by design.

### The composition ring

The donut plots **claim on account equity**, not capital contributed —
principal is what someone put in, not what they can walk away with.

```
claim = latest post_action_balance
      + unpaid 'paid'-action rows for that contribution
```

Claims are grouped by investor (three contributions from one person is one
slice) and together they sum to exactly `total_liability`, which is the
consistency check the tests assert. `GET /fund-pool/equity-composition`
returns pre-computed `value` and `share` per slice; the frontend never
recomputes them.

| mode | when | ring |
|---|---|---|
| `solvent` | account equity exceeds the liability | investor claims + one **My Equity** slice for the remainder |
| `deficit` | liability meets or exceeds the account | investor claims + a synthetic **Deficit** slice; **no owner slice** |
| `unknown` | no snapshot on file | nothing — the empty state prompts for a reading |

`share` divides by the **sum of the emitted slice values** in every mode, so
the shares total 1.0 and the ring closes at 360°. In solvent mode that
denominator is `account_equity` by construction. In deficit mode it is the
liability plus the shortfall — dividing by the liability alone would give
shares summing to about 1.18 and a ring that cannot be drawn.

No slice value is ever negative and `owner_equity` is never `abs()`'d: a
shortfall rendered as a "My Equity" wedge would show a loss as if it were
wealth. At exactly break-even the deficit is zero and no wedge is emitted at
all, rather than an invisible slice carrying a legend entry.

Colours: the owner slice is the app accent and pinned to index 0 so it never
reshuffles; the deficit wedge is the warning colour, hatched and permanently
offset. Both hues are held out of the investor rotation — an investor sharing
a colour with either would read as if they were that slice.

A snapshot older than `SNAPSHOT_STALE_DAYS` (7) flags `is_stale`, which drives
the badge on both the chart and the Account Equity tile from one backend
decision, so the two can never disagree.

### Tests

```
venv/Scripts/python backend/test_fund_pool.py
```

