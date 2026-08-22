# Products

Resolve symbols and books with `list_world_assets` and `get_world_market`. Never invent a token ID, market, or pairing.

**Spot.** ERC-20s. Deposit, withdraw, and collateral only if spot-listed. Unlisted or raw `transfer` deposits can be lost; use `exchange.deposit`.

**Perps.** USDM-settled; 8-hour funding (so it can be arb'd against 10-day loans). Unrealized PnL margins but cannot pay funding until realized. No USDM for funding: a 24h 0-interest USDM loan, then a loan-book borrow; failure can liquidate. No ADLs.

**Lending.** Fixed rate, 10-day, hourly interest in the underlying. Default loans extend in 10-day steps after interest (and any required principal). Lenders may mark non-extensible. Missed interest auto-opens a new 10-day borrow ($1 fee) or may liquidate. Lender-side loans contribute 98% of notional to margin. Counterparties are visible and swappable for a rate difference.

**Orders.** Limit and market; GTC, fill-or-revert, fill-partial-kill-rest. Quantities snap to increment. `get_world_open_orders` is per book; an absent order is not proof of a fill.

**Bundles.** Several orders at once (e.g. levered basis). This app previews a single spot or perp intent; it does not assemble or execute bundles.
