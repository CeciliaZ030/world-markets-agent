# Conformance — Telegram Messaging UX Spec → world-markets app

**Chain target:** UniFi testnet — RPC `https://testnet-unifi-rpc.puffer.fi/`,
exchange `0xf6b54e033bb45a583aa642924bcef78b804588ae`, chain ID `2092151908`.
Live assets: USDT (1), WETH (4), WBTC (5), SOL (6); quote is USDT. Overridable via
`WORLD_RPC_URL` / `WORLD_EXCHANGE_ADDRESS`.

Maps each `TELEGRAM-MESSAGING-UX-SPEC` §10 done-criterion and §11 integration
contract to where it is satisfied in this plugin, and states the plugin/host
boundary explicitly.

## The plugin/host boundary (read first)

An Aomi App is **Preamble + Tools + Skill sections + Model** (confirmed:
aomi.dev/docs/build/services/building-apps). The Aomi **runtime**, not this
plugin, owns: the Telegram transport, edited-in-place messages (live leg-state),
proactive pushes, the Sunday-digest schedule, message bundling/priority, and the
simulation-first signing pipeline. This plugin therefore delivers exactly two
things and cannot implement the transport:

1. **Skill sections** (`src/skill/**`) — the persona, voice, honest-numbers law,
   all §4 invariants, and the §6 templates across five states, as the contract
   the model follows.
2. **Deterministic tools** (`src/tool.rs`, `src/reporting.rs`) — the
   reporting-service functions that compute every number a message interpolates,
   so the honest-numbers law holds by construction: the model can only state a
   figure returned by a tool.

The live-transport behaviors (edit-in-place glyphs, real pushes, digest cron,
bundling) are encoded here as **copy + trigger conditions** for the host to wire;
they are not unit-testable in this repo.

## §10 Done-criteria

| # | Criterion | Where satisfied | Test |
|---|---|---|---|
| 10.1 | Every §6 template renders all applicable states | `src/skill/workflows.md` §6.1–6.17, each with normal/risky/blocked/partial-failure/exit as applicable | `templates.rs::fill_*` (deterministic fill path) |
| 10.2 | No number originates from the model; zero-edge → "≈ $0" | Honest-numbers law in `instructions.md`; every figure sourced from a tool; `plan_large_order` `null_case` | `skill_conformance::workflows_contain_no_bare_response_numbers`, `templates::zero_edge_slice_renders_null_sentence`, `reporting::slice_null_case_reports_zero`, `tool::plan_large_order_tool_reports_zero_edge` |
| 10.3 | Blocks cite engine `rule` + exactly one number (floor); never warn band/recovery target | `workflows.md` §6.6 (a–e) keyed to real engine rules; `compute_resize` returns floor | `skill_conformance::blocks_cite_floor_and_engine_rule_only`, `templates::block_renders_single_floor_number`, `tool::compute_resize_carries_floor_and_rule` |
| 10.4 | "on-chain ✓" only on signed-policy facts | `action-rules.md` policies≠preferences + discipline statement | `skill_conformance::on_chain_marks_only_policy_facts` |
| 10.5 | Graduation notice, receipt silence-conditions, blocked standing-instruction present as isolated strings | `workflows.md` §6.4/§6.5/§6.11 verbatim | `skill_conformance::load_bearing_strings_present` |
| 10.6 | "Keep current position" + "View on World ↗" on every applicable surface; exit as prominent as entry | `workflows.md` §6.3/§6.5/§6.17; `action-rules.md` controls section | `skill_conformance::required_controls_present` |
| 10.7 | No banned vocabulary; no win rates/streaks/capital-asks | `instructions.md` banned list; anti-gamification in `dollarpower.md`; "never ask for more capital" | `skill_conformance::no_banned_vocabulary` |
| 10.8 | Notification budget holds (one weekly digest; silent renewals; guardian exempt from bundling) | `reference/notifications.md` event→channel table | `skill_conformance::notification_budget_stated` |

## §11 Integration contracts (placeholders the renderer tolerates)

| Contract | Status |
|---|---|
| **Risk-score mapping** (0–10 vs RAPV floor) | `liquidation_risk` in `get_world_account` → `metrics` is computed by `src/liquidation_risk.rs` using the same `Portfolio.calculateLiquidationRisk` algorithm as the Composite frontend (`@composite/sdk`). Mandate floors remain in RAPV units via `compute_resize`. |
| **Reporting-service field list** (net carry/day, resize solver, exit-cost at live books, time-to-flat p90, liquidation-path check) | Defined as the `Reporting` trait in `src/reporting.rs`; `FixtureReporting` supplies deterministic values today. Swap the impl for the real service without changing tool signatures. |
| **Guardian unwind algorithm** (R4, cheapest-safe) | Implemented as `guardian_cheapest_safe` (pure fn) with the five per-candidate terms, greedy Δscore/exit-cost selection, protected veto, worse-residual refusal, ProtectEth override + honest reporting, and the degraded (`reached_target: false`) state. Unit-tested. |
| **Dollarpower** | Behind `Reporting::dollarpower` / `get_dollarpower` tool; ratio + committed + effective, always dollar-translatable. Never derived by the model. |
| **PnL** | Behind `get_world_pnl`. Open perp PnL is mark versus contract entry minus unpaid funding (live contract reads; no store). Realized / closed-position PnL is kept in an app-local JSON ledger (`WORLD_PNL_DIR` or `$XDG_DATA_HOME/aomi/world-markets/pnl`) until Aomi host persistence is agreed. Window is position lifetime, not an arbitrary calendar range. Coverage is perpetual positions only. |

## Concision & lookup layer (`CONCISION-AND-COMMANDS.md` v2.0)

| Wire checklist item | Where satisfied | Test |
|---|---|---|
| Lookup vs action split | `instructions.md` voice carve-out; `lookups.md` §Lookup vs action | `skill_conformance::concision_split_stated` |
| Core-five + secondary lookup formats | `lookups.md` one-line templates | `skill_conformance::lookup_formats_present` |
| Risk three forms (0–10, higher = worse) | `lookups.md` §`r` / risk; `liquidation_risk.rs` | `skill_conformance::risk_lookup_forms_present`, `liquidation_risk::risk_bands_match_composite_ui` |
| `liquidationRisk` + NAV consumed, not re-derived | `get_world_account` → `metrics` | `liquidation_risk` unit tests |
| Terse-token whole-intent match | `lookups.md` §Terse tokens | `skill_conformance::terse_token_whole_message_rule` |
| Top exposures by USDT notional (top 3) | `get_world_account` → `lookups.top_exposures` | `lookups::ranks_and_truncates_top_three` |
| `available_to_deploy` — exact only | Omitted until reporting service ships; `lookups.md` §`a` | `lookups::account_lookups_omit_available_to_deploy` |
| Enriched `/b` window P&L | Deferred — reducible `Portfolio [#].` only | `lookups.md` §`b` |
| Shortcut registry | Explicitly deferred — not built | — |

## Honest-numbers enforcement (defense in depth)

1. **Preamble law** — `instructions.md`: "You never write a number… never do
   arithmetic yourself."
2. **Capability** — every figure the §6 templates need is reachable only via a
   tool; arithmetic (deltas, notionals, savings) is done in Rust with
   `rust_decimal`, string-serialized so no `f64` rounding enters a receipt.
3. **Authoring-time test** — `workflows_contain_no_bare_response_numbers` fails
   the build if a bare digit appears in any `>` response skeleton.

Residual risk: the LLM ultimately types the message and the plugin cannot
hard-intercept a rogue token at transport time. The host runtime's own guardrails
may further close this; within the plugin, the three layers above are the
mitigation.

## Source-hierarchy note

Per the spec's §1 precedence and the workstream handoff, on any conflict the
governing workstream spec wins, then the round-2 owner resolutions, then v1/v2
canon, then the live engine's field/rule names. The block forms here use the
engine's actual `rule` codes (`portfolio_floor`, `market_not_permitted`,
`liquidatable`, `insufficient_spot_balance`, `withdraw_not_supported`) from
`src/mandate.rs`, which is the only authority on what a verdict is.
