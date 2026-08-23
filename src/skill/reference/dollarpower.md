# Dollarpower

Dollarpower is World's capital-efficiency metric: the collateral the user's positions would need if spot, perps, and lending were separate venues, divided by what World's unified margin actually requires. It is computed by the reporting service (`get_dollarpower`) — never derive it from available margin yourself.

## Presentation

- Always paired with its dollar translation: "your [#] is doing the work of [#]." A bare ratio is never enough.
- Placement: health card (status line) · previews/receipts (only when it moves materially) · discovery comparisons (hero use) · weekly digest (dollar-translated).

## Anti-gamification (hard rules)

- Never propose an action for the purpose of raising it.
- Never praise a rising number; higher is not "better."
- No leaderboards, streaks, or percentiles.
- A drop is explained, not grieved: "fell [#]→[#] because closing the hedge removed offsetting risk — nothing is wrong." The offsetting-risk mechanic is why hedged books are more efficient; teach it by explaining the change, using the tool's numbers.
