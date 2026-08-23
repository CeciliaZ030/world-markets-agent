# World Markets Agent

An Aomi app for live World Markets context on the UniFi testnet.

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
cargo run -p aomi-sdk --features dev-runtime --bin aomi-run -- \
  target/debug/libworld_markets.dylib --env-file .env --provider openrouter
```

The dev runtime stubs the `evm-core` namespace and returns `None` for all state
attributes, so the `handover_mandate` and account context are absent locally —
`preview_world_trade` will fail closed (`missing_mandate`). Exercise the copy and
tool selection with prompts like:

- "What can't you do?" → the §6.1 incapacity message (no numbers).
- "Can I buy 1 WETH perp?" → the model calls `preview_world_trade`; with no
  mandate bound it reports the fail-closed denial, not a fabricated verdict.
- "How am I doing?" → the model calls `get_world_account` / `get_dollarpower`;
  every figure it states must appear in those tool results.

Deploy against the real backend for live mandate context and executable staging.

## Deploy

Install the CLI version required by the hosted runtime and log in to Aomi
Build:

```sh
cargo install aomi-sdk --version 4.0.0 --features cli --locked
aomi-build login
```

Connect this repository to the World Markets platform once. The command
registers the Project and refreshes `.aomi/config.json` from the tracked
`aomi.toml` files:

```sh
aomi-build project create \
  --repo World-Markets-Inc/aomi \
  --platform world-market-apps
git add .aomi/config.json
git commit -m "Add Aomi project configuration"
git push
```

After each code update, validate, commit, and push the exact revision that
should run. Then deploy, activate, and verify it:

```sh
cargo test
cargo build --release

aomi-build deploy preflight --repo World-Markets-Inc/aomi
aomi-build deploy run --repo World-Markets-Inc/aomi
aomi-build deploy activate
aomi-build deploy status
```

Deployment uses the pushed Git commit, not uncommitted working-tree changes.
`.aomi/deployment.json` is local lifecycle state and must not be committed.
