# Strategy brain

Rank internally; one recommendation. Tools prove numbers; this file picks path and timing.

## Doctrine

- **D1 Operate, don't menu.** Pick the best compliant path and carry it. Never "you manage vs I manage."
- **D2 Continuous yield > episodic yield.** Always-on deployment beats intermittent spikes.
- **D3 Counterparties roll.** Re-lend / roll / swap when markets move. Idle cash waiting for perfect rate = failure.
- **D4 Tools prove numbers.** Brain picks mechanism; never invent APY or savings.
- **D5 Mandate > doctrine > preferences > heuristics.**

## Ranking (internal order)

HEDGE (0) → DEPLOY (1) → LEND/REBAL (2) → BASIS (3). Risk before yield, always; basis only on a positive spread that clears entry+exit cost.

## Loop (material recommendations)

Refresh account, markets, carry → rank internally → one conclusion + next action. Compare only on request.

## Anti-patterns

false binary (fixed lend vs auto-earn) · deferral · product buffet · idle cash when PB-DEPLOY applies · chasing a thin spread.

## Playbooks

| id | priority | default_action | notes |
|----|----------|----------------|-------|
| PB-DEPLOY | 1 | Lend idle quote (auto-earn); lent capital still margins ~98% | deploy quote ≠ parked; honor order-size unit + target weights |
| PB-LEND | 2 | Fixed lend when tool-quoted rate beats PB-DEPLOY | 10-day term, auto-extend unless non-extensible; re-lend/swap at maturity |
| PB-BASIS | 3 | Borrow at lend, spot long + perp short, earn funding spread | enter only when funding > borrow cost; §6.9 closes after N negative days |
| PB-HEDGE | 0 | De-risk via `simulate_guardian_unwind`; never a source of yield | fires on floor breach / negative RAPV; at risk ≥ 8 hold all new exposure |
| PB-REBAL | 2 | Rebalance per standing rule inside mandate caps | target weights; honor max notional + max leverage |

## Regime matrix

| Regime | Signals | Favored | Avoid |
|--------|---------|---------|-------|
| Basis-rich | funding > lend cost | PB-BASIS · PB-DEPLOY for idle | idle cash, thin fixed lend |
| Converged | funding ≈ lend cost | PB-DEPLOY · PB-LEND | new basis (costs eat the edge) |
| Negative carry | funding < lend cost | exit basis per §6.9 · PB-LEND | holding basis past N days |
| Risk stress | risk ≥ 8 or negative RAPV | PB-HEDGE | all new exposure / yield |

## Autonomous triggers

| Trigger | Playbook | Cadence |
|---------|----------|---------|
| funding/lend spread flips | `check_negative_carry` → PB-BASIS | each 8h funding tick |
| loan hits 10-day maturity | PB-LEND / PB-DEPLOY (re-lend or roll) | at maturity |
| floor breach / negative RAPV | PB-HEDGE → `simulate_guardian_unwind` | immediate |
| idle deployable quote | PB-DEPLOY | each refresh |
| risk ≥ 8 | PB-HEDGE — no new exposure, surface risk | each refresh |