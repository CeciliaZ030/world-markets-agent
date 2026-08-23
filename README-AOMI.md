# Develop and deploy the World Markets Agent with Aomi

This is the collaborator runbook for `World-Markets-Inc/aomi`. It covers the
two separate loops:

- `aomi-run` loads the plugin locally and lets a real LLM call its tools.
- `aomi-build` deploys a pushed Git commit through the hosted World Markets
  platform, activates the resulting release, and verifies that the runtime
  loaded it.

The Aomi toolchain docs are the longer reference:

- [aomi-build](https://aomi.dev/docs/build/toolchain/aomi-build)
- [aomi-run](https://aomi.dev/docs/build/toolchain/aomi-run)
- [Developer Platform](https://aomi.dev/docs/build/developer-platform)

## 1. Install the toolchain

Install from the current Aomi SDK source. The feature set installs both
`aomi-build` and `aomi-run`:

```sh
cargo install --git https://github.com/aomi-labs/aomi-sdk \
  --features cli,dev-runtime aomi-sdk

aomi-build --help
aomi-run --help
```

The hosted World Markets platform currently requires the exact SDK version
already pinned in this repository's `Cargo.toml`. Do not replace it with a Git
dependency or a loose version range.

## 2. Validate the app

From the repository root:

```sh
cargo fmt --all -- --check
cargo clippy --all-targets -- -D warnings
cargo test
cargo build
```

The ordinary suite is deterministic. Tests marked `ignored` call the live UniFi
testnet and require valid live fixtures, so run those separately when their
account and market inputs have been confirmed:

```sh
cargo test -- --ignored --nocapture
```

## 3. Exercise the plugin locally

[`aomi-run`](https://aomi.dev/docs/build/toolchain/aomi-run) loads the compiled
plugin, stubs host namespaces, and opens a REPL connected to a real LLM. It does
not require a backend or deployment. Official flags: `--provider`, `--model`,
`--prompt` (one shot, no REPL), `--env-file`, `--max-turns`, `--verbose`.

Install (once):

```sh
cargo install --git https://github.com/aomi-labs/aomi-sdk \
  --features cli,dev-runtime aomi-sdk
```

Copy `.env.example` → `.env`. Set a provider key (`OPENROUTER_API_KEY`,
`ANTHROPIC_API_KEY`, or `OPENAI_API_KEY`). For account lookups locally, also set
`WORLD_ACCOUNT_ID` to a UniFi testnet World account id — the dev runtime returns
`None` for all handover state attributes (mandate, wallet, brief), so this env var
is the supported dev workaround until you deploy to staging.

**Rebuild after every skill or tool change** — `aomi-run` loads the dylib from
disk; markdown edits are not picked up until `cargo build`.

```sh
cargo build
aomi-run target/debug/libworld_markets.dylib \
  --env-file .env --provider openrouter
```

On Linux use `target/debug/libworld_markets.so`. One-shot smoke:

```sh
aomi-run target/debug/libworld_markets.dylib \
  --env-file .env --provider openrouter --prompt "b"
```

### What to expect at startup

A healthy boot shows `world-markets v0.3.0`, **15** plugin tools, and
`evm-core (stubbed)`. Inside the REPL, `/help` lists **host** commands only
(`/quit`, `/reset`, `/history`, `/help`) — not agent lookup tokens. Terse
lookups are plain messages:

| message | expected behavior |
|---|---|
| `b` | one line · `get_world_account` → `Portfolio [#].` |
| `p` | one line · top exposures |
| `r` | one line · liquidation risk score |
| `a` | one line · available to deploy or explicit refusal |
| `d` | one line · dollarpower |

The model must **not** ask "what did you mean?" or list capabilities for these.

Without `WORLD_ACCOUNT_ID`, account tools fail closed with a one-line error
(e.g. "No World account connected") — that is correct dev-runtime behavior.

Trade previews still lack mandate context locally; use hosted deployment for
real handover. See [what the dev runtime stubs](https://aomi.dev/docs/build/toolchain/aomi-run#what-the-dev-runtime-stubs).

## 4. One-time Project connection (owner/admin)

This repository already commits the V2 Project declaration:

```text
.aomi/config.json -> platform world-market-apps -> aomi.toml
```

An owner or repository administrator must connect the GitHub repository once
before any collaborator can deploy it. If the staging Aomi GitHub App is not
installed for the organization yet, a GitHub organization owner must approve
that installation first; scope it to `World-Markets-Inc/aomi`, not every
organization repository.

![Connect the World Markets repository to its Aomi platform](docs/images/aomi-build-connect.jpg)

1. Open [staging Aomi Build](https://build-staging.aomi.dev/) and sign in with
   GitHub.
2. Select the `world-market-apps` platform.
3. Open **Projects**, choose **New app**, then **Import from GitHub**.
4. Authorize the Aomi GitHub App for `World-Markets-Inc/aomi` if prompted.
5. Import `World-Markets-Inc/aomi` and confirm that Build shows it as a Project.

Repository write access is enough for normal pull requests, but the initial
organization-repository import is intentionally restricted to a GitHub repo
administrator, and first-time GitHub App installation may require organization
owner approval. A collaborator should not try to work around those boundaries
with an activation token. After the Project exists, collaborators deploy
through their own verified Builder login.

## 5. Deploy a pushed commit to staging

Log the CLI into the same staging Build environment used above:

```sh
aomi-build login \
  --build-url https://build-staging.aomi.dev \
  --backend https://api-staging.aomi.dev
```

Validate, commit, and push first. Hosted deployment always reads the immutable
Git commit from GitHub; it never uploads uncommitted working-tree changes.

```sh
cargo test
git status --short
git push

aomi-build deploy preflight --repo World-Markets-Inc/aomi
aomi-build deploy --repo World-Markets-Inc/aomi
```

The full `deploy` command runs preflight again, creates or updates the platform
deployment, waits for release CI, activates the release, and verifies runtime
loading. It writes local lifecycle state to `.aomi/deployment.json`; that file
is ignored and must not be committed.

To inspect or resume a deployment:

```sh
aomi-build deploy status
aomi-build deploy activate
```

Deployment is successful only when the selected app reports all three:

```text
active=true  artifact_ready=true  loaded=true
```

A PR merge, successful CI run, or HTTP 200 alone is not an end-to-end result.
Finish with a hosted chat that reaches a completed assistant response. For a
safe first smoke, ask what the agent cannot do; for a World-data smoke, bind a
known test account and verify that every number in the answer came from a tool
result.

## Troubleshooting

- **`repository is not connected as a Project`**: complete the one-time Build
  import in section 4.
- **`403 Forbidden` while creating a Project**: the signed-in GitHub user is
  not a repository administrator, or the Aomi GitHub App is not authorized for
  this repo. Ask an owner/admin to perform the import.
- **`Install requested` in Build**: a GitHub organization owner must approve
  the pending `aomi-build-staging` installation before the Project can be
  connected. Keep its repository access scoped to `World-Markets-Inc/aomi`.
- **Commit is not on any remote**: push the exact `HEAD` you intend to deploy.
- **SDK mismatch**: keep the exact registry pin required by the backend; run
  `aomi-build sdk check` for the expected version.
- **Local tool says account context is missing**: expected with `aomi-run` —
  [state attributes always return `None`](https://aomi.dev/docs/build/toolchain/aomi-run#what-the-dev-runtime-stubs).
  Set `WORLD_ACCOUNT_ID` in `.env` for account lookups; deploy for mandate/handover.
- **`b` / `p` / `r` get a capability menu instead of one line**: rebuild the
  plugin (`cargo build`) and confirm you are loading `target/debug/libworld_markets.dylib`
  from this repo, not an older build.
- **Activation is still building**: rerun `aomi-build deploy status`, then
  `aomi-build deploy activate` after release CI is ready.
