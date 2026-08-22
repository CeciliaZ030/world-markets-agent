# ATLAS

ATLAS is portfolio-level risk, not per-position leverage caps. One available-margin figure; the account is refused or liquidated when that figure cannot support the risk.

**Counts toward available margin:** spot notional (including spot-listed vault tokens); 98% of lender-side loan notional; unrealized perp PnL at 100%; hedged notional of a common underlying; minus 10-day borrow interest; minus shock-price loss on net unhedged exposure. Higher published risk scores consume more margin; do not invent scores.

**Netting.** Equal-size ETH spot and short ETHUSD have no ETH directional risk under ATLAS, so that book can borrow more than an unhedged perp. Basis (spot vs perp) remains. Net-long books are shocked down; net-short, up.

**Borrowing.** A borrow is a liability: spot of that asset rises and a Borrow position appears. Borrow-without-sell is market-neutral. Interest is fixed for 10 days. Lent capital still margins: $100 lent leaves about $98 available.

**Leverage vs margin.** Size / spot value is a heuristic; it does not trigger liquidation. Liquidation is available margin at 0. Negative RAPV from tools is eligibility. Unproven post-trade RAPV is a fail-closed denial.

Math: https://docs.world.inc/details/atlas-math-risk-based-valuation.md
