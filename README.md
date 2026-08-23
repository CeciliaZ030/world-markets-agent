# World Markets Agent

An Aomi app for live World Markets context on the UniFi testnet.

Collaborators: see [README-AOMI.md](README-AOMI.md) for the tested local and
hosted development workflow.

The app reads the World exchange contract directly and exposes typed tools in two
groups.

Live contract reads (mandate-aware, non-executable):

- `list_world_assets`
- `get_world_account`
- `get_world_market`
- `preview_world_trade`
- `check_world_mandate`
- `get_world_agent_permission`
- `get_world_open_orders`

Reporting-service tools (the honest-numbers layer — deterministic derived figures
so the message layer never authors a number; see `src/skill/` and the
`TELEGRAM-MESSAGING-UX-SPEC`):

- `preview_account_effect`
- `compute_resize`
- `preview_exit`
- `plan_large_order`
- `get_dollarpower`
- `simulate_guardian_unwind`
- `check_negative_carry`

Version 0.3 is mandate-aware and intentionally non-executable. It verifies the
active actor as the World account owner or an on-chain permitted trader, parses
mandate v1 with fail-closed unknown-key handling, evaluates structured intents
against live account and market state, and reads resting orders. Its app-scoped
skill cannot be discovered or activated by another Aomi app.

The app fails closed when it cannot prove post-trade risk-adjusted portfolio
value. Transaction staging remains disabled until the host can guarantee that
app policy cannot be bypassed through a host wallet tool and the app can compute
the full post-trade World risk state.

## Validate

```sh
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo test reads_live_world -- --ignored --nocapture
cargo build --release
```

## Interactive sanity (aomi-run)

The Aomi runtime — not this plugin — owns the Telegram transport, edited-message
live leg-state, proactive pushes, the Sunday-digest schedule, and the
simulation-first signing pipeline. This plugin ships only the skill sections (the
copy + behavioral contract the model follows) and the deterministic tools that
compute every number a message interpolates. To chat with it locally:

```sh
cargo build
aomi-run target/debug/libworld_markets.dylib \
  --env-file .env --provider openrouter
```

The dev runtime stubs the `evm-core` namespace and returns `None` for all state
attributes, so the `handover_mandate` and account context are absent locally.
World tools will ask for an account ID or fail closed when they cannot prove the
account or mandate. Exercise the copy and tool selection with prompts like:

- "What can't you do?" → the §6.1 incapacity message (no numbers).
- "Can I buy 1 WETH perp?" → the model calls the World policy tools; without
  account context it asks for an account ID or fails closed, never fabricating
  a verdict.
- "How am I doing?" → the model calls `get_world_account` / `get_dollarpower`;
  every figure it states must appear in those tool results.

Deploy against the real backend for live handover and mandate context. This app
release remains intentionally non-executable.

## Deploy

The complete collaborator flow, including the one-time organization-repository
import, is in [README-AOMI.md](README-AOMI.md). After an owner/admin connects the
Project in Aomi Build, install the current CLI and log in to staging:

```sh
cargo install --git https://github.com/aomi-labs/aomi-sdk \
  --features cli,dev-runtime aomi-sdk
aomi-build login \
  --build-url https://build-staging.aomi.dev \
  --backend https://api-staging.aomi.dev
```

After each code update, validate, commit, and push the exact revision that
should run. Then let the full lifecycle deploy, activate, and verify it:

```sh
cargo test
cargo build --release
git push

aomi-build deploy preflight --repo World-Markets-Inc/aomi
aomi-build deploy --repo World-Markets-Inc/aomi
aomi-build deploy status
```

Deployment uses the pushed Git commit, not uncommitted working-tree changes.
`.aomi/deployment.json` is local lifecycle state and must not be committed.
