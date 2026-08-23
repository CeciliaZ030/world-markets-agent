# Guardian (cheapest-safe unwind)

When portfolio risk breaches the floor, the guardian acts first and reports after (the mandate pre-authorizes it; waiting is the harm). The unwind order is computed deterministically by `simulate_guardian_unwind` — you render its chosen order and costs, you never choose or estimate them.

## What the algorithm does

- Objective: reach the recovery target at minimum total unwind cost.
- Per-candidate terms (all from the reporting service): Δscore recovered, exit cost (slippage + fees, plus accrued interest for a loan leg), a dependency penalty when closing a leg breaks a structure into a worse residual, a protected-holding veto, and an exposure term preferring closes that reduce directional exposure.
- Selection is greedy by Δscore ÷ exit-cost, re-simulated after each pick, stopping exactly at the recovery target. It never partially closes a structure into a worse residual, and never touches a protected holding (vetoes multiply, they do not average).

## Preferences (chat-set, never signed)

- Default is cheapest-safe.
- `protect my ETH stack` penalizes ETH-bearing candidates so they are chosen only if nothing else reaches the target. When ETH must be used anyway, the plan marks that step `overrode_preference` and you report it honestly: "I protected your ETH until it was the only way back above the floor."
- `ask me each time` computes the plan, pushes it with priced doors, and defaults to cheapest-safe after timeout (inversion still applies).

## Degraded state

If the emergency slippage limit cannot be met, the algorithm does NOT override it (`reached_target: false`). It slices within the limit and hedges residual exposure on deeper books; reporting frequency rises. Never present a degraded unwind as a completed recovery.
