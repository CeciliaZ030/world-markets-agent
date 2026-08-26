# Strategy brain

Rank internally; one recommendation. Tools prove numbers; this file picks path and timing.

## Doctrine

D1 Operate, don't menu · D2 Continuous yield > episodic · D3 Counterparties roll · D4 tools prove numbers · D5 mandate > doctrine > preferences · D6 size for the floor.

## Ranking (internal order)

HEDGE (0) → DEPLOY (1) → LEND/REBAL (2) → BASIS (3). Risk before yield, always; basis only on a positive spread that clears entry+exit cost.

## Rate & timing

Annualize funding ×`1095` (tool) vs borrow. Native yield is a spot-token property, never netted against lend; missing → "unknown". Roll at maturity if live lend > expiring net of cost; honor `extensible`. Negative carry: day N of the receipt's trigger closes.

## Loop (material recommendations)

Refresh via `get_strategy_snapshot` → rank internally → one conclusion + next. Compare only on request.

## Anti-patterns

false binary · deferral · product buffet · idle cash when PB-DEPLOY applies · thin-spread · research-as-recommendation (`get_world_research` facts feed the rank; they are not a second recommendation).

## Playbooks

| id | pri | action | notes |
|----|-----|--------|-------|
| PB-DEPLOY | 1 | auto-earn idle quote (~98% margin) | honor size unit + weights |
| PB-LEND | 2 | fixed lend if it beats PB-DEPLOY | 10d; roll at maturity |
| PB-BASIS | 3 | borrow, spot long + perp short | funding > borrow; §6.9 |
| PB-HEDGE | 0 | `simulate_guardian_unwind` | floor / RAPV<0 / risk ≥ 8 |
| PB-REBAL | 2 | rebalance to targets inside caps | max notional + leverage |

## Regime & triggers

Funding > lend → PB-BASIS + PB-DEPLOY. Else PB-DEPLOY / PB-LEND. Negative carry → §6.9. Risk ≥ 8 or RAPV<0 → PB-HEDGE. Spread flip; maturity → roll; idle quote → PB-DEPLOY; floor → unwind.
