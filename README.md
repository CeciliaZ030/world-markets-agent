# World Markets Agent

An Aomi app for live World Markets context and mandate-gated execution on the
UniFi testnet (chain ID 2092151908), plus the World Mini App it pairs with.

## Layout

- `src/`, `tests/` — the Rust Aomi app (this README). Deployed through Aomi Build.
- `mini-app/` — the World Mini App and deterministic command renders
  (`b`, `p`, `r`, …): a pnpm workspace with a Next.js app deployed on Vercel.
  See [mini-app/README.md](mini-app/README.md) and
  [mini-app/docs/deploy.md](mini-app/docs/deploy.md).

The two share a repository so World's assets ship together; they build and
deploy independently (`cargo` at the root, `pnpm` inside `mini-app/`).

The app reads the World exchange contract directly over its own RPC path,
evaluates every trade intent against the signed mandate (ATLAS post-trade
risk included), and ships its own skill catalog — including the execution
procedure and the guard table the host enforces on every staged transaction.

Reads (never execute):

- `list_world_assets`
- `get_world_account`
- `get_health_snapshot` (account card + PnL)
- `get_world_agent_permission` (owner · delegated trader · revoked)
- `get_world_market`
- `get_world_rates`
- `get_world_loans`
- `get_world_open_orders`
- `get_world_pnl`

Verdicts and simulations (never execute):

- `preview_world_trade` — resolved size, book, mark, limit price, and the
  deterministic mandate verdict under `preview.verdict`
- `check_world_mandate` — same body as the preview
- `preview_account_effect` — before/after exposure, available-to-deploy, and
  0–10 risk for a hypothetical, derived in Rust from live state
- `compute_resize` — the one number a block cites: the signed RAPV floor

Actions (the app encodes the venue call; the host stages, simulates, and
commits it atomically through a routed tool return):

- `execute_world_order` — same arguments as the preview; evaluates the mandate
  itself and, on allow, packs the order word and encodes `new*Order`. Spot and
  perp orders carry a limit price; lend-book orders (`side: lend | borrow`)
  carry an annual rate. Sizes come from the sentence: dollars, asset units, or a
  fraction of the held position ("half my WETH", "20%", "all")
- `cancel_world_order` — reads a spot or perp order by id, or a lend-book order
  by its resting rate, and encodes `cancel*Order`
- `renew_world_loan` / `pay_world_loan_interest` — one borrower loan per call,
  gated on a bound mandate, the floor, and liquidation eligibility

Each action tool returns `staged` (signature, args, calldata) and a route the
host follows: one `evm_stage_tx` with that exact calldata, then an enforced
`simulate_batch` and `evm_commit_txs` that stop on any failure. The model
never types a selector, an order word, or a number between tools.
`src/skill/guard.json` restricts staged calls to the exchange contract and the
fourteen trading selectors (six `new*Order`, six `cancel*Order`, `renewLoan`,
`payInterestAndFees`) on chain 2092151908. An asset World does not list stops
every action tool with a pasteable `unknown_asset` message rather than a guess.

The mandate fails closed: without a bound handover mandate every verdict is
`missing_mandate` and nothing is staged. The bound account comes from
`handover.account_ref`, then the mandate's `account.id`. Post-trade RAPV is
derived from ATLAS `evaluate` at unit risk, anchored to the live contract RAPV;
if that derivation cannot run, the verdict is `post_trade_risk_unavailable`.

## Validate

```sh
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test --locked
cargo test reads_live_world -- --ignored --nocapture
cargo build --release
```

## Interactive sanity (aomi-run)

[`aomi-run`](https://aomi.dev/docs/build/toolchain/aomi-run) is the local dev
runtime: it loads this app, calls a real LLM, and shows which tools the model
selects. It is **not** the hosted backend.

```sh
chmod +x scripts/dev-run.sh
./scripts/dev-run.sh
```

`dev-run.sh` builds with `--features local-dev`, which is the only build that
honours `WORLD_ACCOUNT_ID` (set it in `.env` so the app process inherits it via
`--env-file`). `aomi-run` stubs every handover attribute, so there is no
mandate locally: previews return `missing_mandate` and nothing can be staged.
Reads and lookups work. `WORLD_RPC_URL` / `WORLD_EXCHANGE_ADDRESS` are
local-only overrides; a hosted run takes the chain from the host and the
exchange from the handover.

On Linux use `libworld_markets.so`. Terse lookups (`b`, `p`, `r`) are plain
messages, not slash commands.

Hosted chat against staging: `./scripts/hosted-chat.sh`.

PnL persistence: realized and closed-position figures are written under
`WORLD_PNL_DIR`, else `$XDG_DATA_HOME/aomi/world-markets/pnl`. Open PnL is
live from the contract.

## Deploy

This app requires Aomi SDK 5.1.1 in both `Cargo.toml` and `Cargo.lock`, matching the current backend host ABI and app-skill guard contract.
Its hosted instructions are the two SDK 5 skills in `src/skill/` (trading + execution, reporting); each must
pass the 4,000-token validation limit. `cargo test --locked` checks the skills,
the guard table, and every provider-facing tool schema before publication.

An owner or repository administrator must first open the
[World Markets staging import page](https://build-staging.aomi.dev/operate/deployments/new?platform=world-market-apps&mode=import),
confirm the `world-market-apps` platform, and connect `World-Markets-Inc/aomi`.
Scope the staging Aomi GitHub App to this repository rather than every
organization repository.

![Connect the World Markets repository to its Aomi platform](docs/images/aomi-build-connect.jpg)

If Build reports that `.aomi/config.json` uses `world-market-apps` but the
Project uses `community`, no Project was created. Reopen the scoped staging
link above and retry on `world-market-apps`.

After the Project is connected:

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
cargo test --locked
cargo build --release
git push

aomi-build deploy preflight --repo World-Markets-Inc/aomi
aomi-build deploy --repo World-Markets-Inc/aomi
aomi-build deploy status
```

Deployment uses the pushed Git commit, not uncommitted working-tree changes.
`.aomi/deployment.json` is local lifecycle state and must not be committed.
