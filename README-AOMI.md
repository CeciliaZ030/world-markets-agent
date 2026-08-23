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

Choose one provider and export its key in your shell. `aomi-run` recognizes
`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `OPENROUTER_API_KEY`. Never commit a
key or put one in a command example.

On macOS:

```sh
aomi-run target/debug/libworld_markets.dylib \
  --provider anthropic \
  --prompt "What can't you do?"
```

On Linux, use `target/debug/libworld_markets.so`. Omit `--prompt` for an
interactive chat. If the plugin needs additional non-secret configuration, put
it in a local ignored dotenv file and add `--env-file .env`.

A healthy startup identifies `world-markets v0.3.0`, registers 14 World tools,
and reports `evm-core` as stubbed. The local runtime deliberately has no hosted
handover state, wallet execution, or persisted account context. A trade prompt
may therefore ask for a World account ID and must fail closed when it cannot
prove the account or mandate. Use hosted deployment for real handover and
account context; do not treat a local stub response as an execution test.

## 4. One-time Project connection (owner/admin)

This repository already commits the V2 Project declaration:

```text
.aomi/config.json -> platform world-market-apps -> aomi.toml
```

An owner or repository administrator must connect the GitHub repository once
before any collaborator can deploy it:

1. Open [staging Aomi Build](https://build-staging.aomi.dev/) and sign in with
   GitHub.
2. Select the `world-market-apps` platform.
3. Open **Projects**, choose **New app**, then **Import from GitHub**.
4. Authorize the Aomi GitHub App for `World-Markets-Inc/aomi` if prompted.
5. Import `World-Markets-Inc/aomi` and confirm that Build shows it as a Project.

Repository write access is enough for normal pull requests, but the initial
organization-repository import is intentionally restricted to a GitHub repo
administrator. A collaborator should not try to work around that boundary with
an activation token. After the Project exists, collaborators deploy through
their own verified Builder login.

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
- **Commit is not on any remote**: push the exact `HEAD` you intend to deploy.
- **SDK mismatch**: keep the exact registry pin required by the backend; run
  `aomi-build sdk check` for the expected version.
- **Local tool says account context is missing**: expected with `aomi-run` until
  an account is supplied; hosted handover state is not emulated locally.
- **Activation is still building**: rerun `aomi-build deploy status`, then
  `aomi-build deploy activate` after release CI is ready.
