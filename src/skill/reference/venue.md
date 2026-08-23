# Venue

Contracts on the UniFi testnet (chain ID 2092151908). No backend. One exchange interface over several contracts plus one contract per book. RedStone is the primary oracle; book prices do not trigger liquidation. Oracle failure is first-rank risk. Testnet/Beta: contracts upgradable; treat balances as test value, not real funds. Circuit breakers are not yet triggerable.

**USDM.** The venue's settlement stablecoin (not issued by World). Perps settle in it. Full liquidation leaves USDM and no positions. Supply can be thin; do not treat it as a deep, World-controlled dollar.

**Liquidation.** Available margin at 0. Full unwind, taker orders, remainder in USDM. No ADLs; the venue does not take over a position outside liquidation. Bankruptcy losses are bilateral among direct counterparties. Missed loan interest may force a refinance borrow; if that cannot be placed, full liquidation. If tools report eligibility, say so urgently and do not encourage more exposure.

Deposit only spot-listed assets via `exchange.deposit`.
