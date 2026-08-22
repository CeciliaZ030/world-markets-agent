# World Markets Agent

An Aomi app for live World Markets context on MegaETH mainnet.

The app reads the World exchange contract directly and exposes seven typed tools:

- `list_world_assets`
- `get_world_account`
- `get_world_market`
- `preview_world_trade`
- `check_world_mandate`
- `get_world_agent_permission`
- `get_world_open_orders`

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

## Deploy a fork

Install the CLI version required by the hosted runtime and log in to Aomi
Build:

```sh
cargo install aomi-sdk --version 4.0.0 --features cli --locked
aomi-build login
```

For a newly connected fork, create its platform-bound Project once from a
checkout whose `origin` points to that fork. This refreshes the committed
`.aomi/config.json` from the repository's tracked `aomi.toml` files:

```sh
aomi-build project create \
  --repo <owner>/world-markets-agent \
  --platform world-market-apps
git add .aomi/config.json
git commit -m "Add Aomi project configuration"
git push
```

After every code update, validate and push the exact commit that should run.
Then deploy, activate, and verify it:

```sh
cargo test
cargo build --release
git push

aomi-build deploy preflight --repo <owner>/world-markets-agent
aomi-build deploy run --repo <owner>/world-markets-agent
aomi-build deploy activate
aomi-build deploy status
```

Deployment uses the pushed Git commit, not uncommitted working-tree changes.
`.aomi/deployment.json` is local lifecycle state and must not be committed.
