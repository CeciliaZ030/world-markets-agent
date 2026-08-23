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

- `get_world_pnl`
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

[`aomi-run`](https://aomi.dev/docs/build/toolchain/aomi-run) is the local dev
runtime: it loads this plugin, calls a real LLM, and shows which tools the model
selects. It is **not** the hosted Telegram backend.

```sh
cargo build   # rebuild after every skill or tool change — aomi-run loads the dylib from disk
aomi-run target/debug/libworld_markets.dylib \
  --env-file .env --provider openrouter
```

On Linux use `libworld_markets.so`. `/help` inside the REPL lists only host
commands (`/quit`, `/reset`, …) — not agent lookup tokens. Terse lookups (`b`,
`p`, `r`, …) are plain messages, not slash commands.

Set `WORLD_ACCOUNT_ID` in `.env` so account lookups work locally (see
[README-AOMI.md](README-AOMI.md) §3). The dev runtime stubs `evm-core` and
returns `None` for all handover state attributes per the
[aomi-run docs](https://aomi.dev/docs/build/toolchain/aomi-run#what-the-dev-runtime-stubs).

Smoke prompts:

- `b` → one line: `Portfolio [#].` (calls `get_world_account`)
- "What can't you do?" → §6.1 incapacity message (no numbers)
- "How am I doing?" → multi-line health card via `get_world_account` /
  `get_world_pnl` / `get_dollarpower`

PnL persistence (until Aomi host storage is agreed): realized and closed-position
figures are written under `WORLD_PNL_DIR`, else
`$XDG_DATA_HOME/aomi/world-markets/pnl`. Open PnL is live from the contract.

Deploy against the real backend for live handover and mandate context. This app
release remains intentionally non-executable.

## Deploy

The complete collaborator flow is in [README-AOMI.md](README-AOMI.md). After an
owner/admin connects the Project in Aomi Build:

```sh
cargo install --git https://github.com/aomi-labs/aomi-sdk \
  --features cli,dev-runtime aomi-sdk
aomi-build login \
  --build-url https://build-staging.aomi.dev \
  --backend https://api-staging.aomi.dev
```

After each code update, validate, commit, and push the exact revision that
should run:

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
