# Strategy brain

Rank internally; one recommendation. Tools prove numbers; this file picks path and timing.

## Doctrine

- **D1 Operate, don't menu.** Pick the best compliant path and carry it. Never "you manage vs I manage."
- **D2 Continuous yield > episodic yield.** Always-on deployment beats intermittent spikes.
- **D3 Counterparties roll.** Re-lend / roll / swap when markets move. Idle cash waiting for perfect rate = failure.
- **D4 Tools prove numbers.** Brain picks mechanism; never invent APY or savings.
- **D5 Mandate > doctrine > preferences > heuristics.**
- **D6 Size for the floor, not the hope.** Cap = ceiling, not target; keep the worst case above the floor.

## Ranking (internal order)

HEDGE (0) → DEPLOY (1) → LEND/REBAL (2) → BASIS (3). Risk before yield, always; basis only on a positive spread that clears entry+exit cost.

## Rate & timing

- Rank on annualized spread, never raw rates: funding is per-8h — annualize (×`1095`, tool-computed) before comparing to borrow.
- Native asset yield is a property of the spot token, not a venue rate. Never net it against the lend rate; a lent token forfeits its accrual. Missing → "unknown".
- Roll at maturity: swap only if live lend > expiring rate net of cost; honor `extensible`.
- Negative carry: count days; day N (receipt's trigger) closes and reports — pre-authorized.

## Loop (material recommendations)

Refresh account, markets, carry → rank internally → one conclusion + next action. Compare only on request.

## Anti-patterns

false binary · deferral · product buffet · idle cash when PB-DEPLOY applies · thin-spread chase.

## Playbooks

| id | pri | action | notes |
|----|-----|--------|-------|
| PB-DEPLOY | 1 | auto-earn idle quote (still ~98% margin) | not parked; honor size unit + weights |
| PB-LEND | 2 | fixed lend if rate beats PB-DEPLOY | 10d, auto-extend unless locked; roll at maturity |
| PB-BASIS | 3 | borrow, spot long + perp short | funding > borrow; §6.9 exits after N negative days; spread-widening can liquidate |
| PB-HEDGE | 0 | `simulate_guardian_unwind` | floor / negative RAPV; risk ≥ 8 → no new exposure |
| PB-REBAL | 2 | rebalance to targets inside caps | max notional + leverage |

## Regime & triggers

Basis-rich (funding > lend) → PB-BASIS + PB-DEPLOY. Converged → PB-DEPLOY / PB-LEND. Negative carry → exit basis §6.9. Risk ≥ 8 or negative RAPV → PB-HEDGE. Spread flip each 8h tick; loan maturity → roll; idle quote → PB-DEPLOY; floor breach → unwind now.