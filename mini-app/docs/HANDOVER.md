> Current account authority: see [partner onboarding](partner-onboarding.md). Canonical Aomi handover lookup supersedes all ingest/local-binding descriptions in the historical notes below. The registration ingress is retired; no ingestion key is required.

# Security update (2026-09-14)

The browser-origin registration described in the historical handoff below is retired.
Only a trusted issuer bearing the tenant ingest key may register account bindings.
See `partner-onboarding.md` for the current contract and coordinated rollout.

# Handover: World Markets × aomi Telegram mini-app service

Date: 2026-09-14. Everything below is uncommitted working-tree state. No remote repo exists yet.

## Goal

A World Markets user sets up an agent on the Composite web app, scans a QR into Telegram, and then
trades through the aomi agent while a separate mini-app service answers `/b /p /r /a /d`, `/chart`,
`/tasks`, `/app` and serves a Telegram mini app. The agent and the aomi backend never know the mini
app exists. Zero backend changes was a hard requirement and has held.

## Architecture (decided, built)

```
Telegram ─► vendor edge (worker :8790, tunneled) ─┬─ /b /p /r /a /d /chart /tasks /app, t: callbacks, web_app_data → service
                                                  └─ text, /start, /help, /wallet, /permission, /transactions, /sign, panel: → aomi backend webhook (durable outbox)
mini app (Next.js :8791, tunneled) ─► BFF /api/t/world/* (verifies Telegram initData against Telegram's public key) ─► tenant adapter ─► venue
```

- `~/Code/aomi-telegram` — pnpm/TypeScript monorepo. `packages/core` (tenant contract, Postgres store
  + migrations, Bot API client, initData verifier, routing table, handover binding, chart SVG),
  `apps/worker` (edge, outbox drainer, 60 s scheduler: watches/liquidation alert/per-account fills
  index, chart PNG via resvg, onboarding CLI, partner ingest), `apps/web` (generic screens: home
  with since-you-looked, ledger WATCHING/OPEN/DONE, portfolio, products with chat-draft acts, chart,
  watch form), `tenants/world` (partner SDK `@wcm-inc/sdk` reads, five lookups in the partner's exact
  shapes and char budgets, NewTrade fills decoder verified on live trades).
- Identity: partner web posts `sha256(token)` + account + owner at issue time; the edge hashes the
  `/start` argument passing through and binds the Telegram user. Keyless ingest from allowlisted web
  origins is vetted by an on-chain owner check. Raw tokens are never stored.
- Handoff from the mini app to the agent is a Telegram draft prefill (`t.me/<bot>?text=`); the user
  presses send. Unverified on a real bot; fallback (clipboard + open chat) is planned in `lib/tg.ts`.
- Composite web (`~/Code/frontend`, branch `cecilia/agent-unifi-local`, uncommitted): added
  `registerHandoverWithMiniApp` in `shared/lib/aomi/client.ts`, `aomi.miniAppUrl` config
  (`app.dev.json` → `http://127.0.0.1:8790`), one fire-and-forget call in `use-agent-handover.ts`.
- Tests: 44 green across packages (`TEST_DATABASE_URL=… pnpm -r test`); `WORLD_LIVE=1` adds live
  UniFi reads. Plan of record: https://claude.ai/code/artifact/6f2c4795-ae2c-48b1-ab0a-45693c3eb804
  Review findings on the partner's original mini app and the Composite QR flow:
  https://claude.ai/code/artifact/97a81d85-64d3-478d-8d4a-f7b58916a301

## Verified end to end (local)

- Edge takeover against a fake Bot API, forward to the real local backend, agent reply streamed back.
- Lookups: warm `/b` ≈ 50 ms, cold ≈ 4 s on public UniFi, ≈ 150 s cold on the anvil fork
  (`WORLD_CACHE_SECONDS=600` mitigates).
- Mini app in browser: watch create → pause → resume → cancel; portfolio; products; chart with mark.
- Scheduler fired a watch and pushed; fills index found account 20's perp open.
- Real bot `@world_local_test_bot` (id 8716577788): webhook holds on the edge tunnel, command menu set.

## Current running rig (all local, all ephemeral)

- aomi local stack in real-Telegram mode from `~/Code/product-mono-worktrees/world-local-e2e/scripts/world-e2e`
  (backend :19080, api-server :19082, manager :19081, Postgres :19432, anvil UniFi fork :19545,
  Composite vite :19173). Backend tunnel URL in `state/logs/cloudflared.log`.
- Worker :8790 and web :8791 with quick tunnels; launcher `scratchpad/real-mode.sh`, finisher
  `scratchpad/resume.sh`, secrets in `scratchpad/secrets.env` (bot token, Para key pulled from
  staging-1 `/opt/aomi/.env` via `ssh root@146.190.122.82`). Scratchpad:
  `/private/tmp/claude-501/-Users-cecilia-Code/57c88e80-95ba-42e9-b98e-cf090015176b/scratchpad`.
  Service Postgres :19532 (`aomi_telegram`), data under `scratchpad/pg`.
- Harness edits (world-local-e2e, uncommitted): `env.sh` honors `TG_BOT_ID`/`TG_BOT_USERNAME` from
  env; `up.sh` retries `setWebhook`. Fork account 21 was funded twice (2,000 USDT, 0.1 WETH): harmless.
- This machine reaches the internet only via `HTTPS_PROXY=http://127.0.0.1:7890`; core
  `proxyAwareFetch` (undici) covers Bot API, Kraken and forwarding. Launcher-started Next dev servers
  do not inherit the shell env, hence `HTTPS_PROXY` in `apps/web/.env.local`.

## Blocker to the goal

The Composite web app cannot hold a wallet chain long enough to issue the handover. In Cecilia's
Chrome the MetaMask network flips UniFi ↔ MegaETH Testnet v2 every 5–9 s. Traced with request hooks
in a single localhost:19173 tab: the World page issues **no** switch calls; cross-tab replication is
not it (one wallet-sync lock client). The switches come from outside that tab: most likely another
dapp tab on a different origin (dev.wcm.inc / world.inc / localhost:5173) whose remembered chain is
MegaETH and whose wallet-manager reconnect forces the chain on every reconcile, or the second
MetaMask build (MetaMask Flask) installed alongside MetaMask. Untested next step: close every dapp tab
in every window, disable Flask, reload one tab, watch the network for 30 s. Code-level fix if it is
the wallet package: `packages/wallet/src/lib/wallet-manager.ts` `_connect` forces the persisted chain
on every reconnect (NFR REL-1); follower reconciles should not switch the wallet's chain.

Everything after that is untested on a real phone: QR scan → claim → grant → activate → `/b` → mini
app → draft prefill.

## Next steps, in order

1. Resolve the chain flip (above), then run the test plan in the last assistant message of the
   original session, or `docs/deploy.md` + `docs/partner-onboarding.md`.
2. Verify `?text=` prefill on the real bot; switch on the clipboard fallback if it fails.
3. Commit: `~/Code/aomi-telegram` as a new repo (suggested `aomi-labs/telegram`), the Composite change
   on `cecilia/agent-unifi-local`, and the two harness fixes in `world-local-e2e`.
4. Rotate both bot tokens used today (8591768935 and 8716577788); they appeared in chat.
5. Deploy per `docs/deploy.md` (Fly worker, Vercel web, one Postgres), then staging soak with World.


## Codex verification — 2026-09-14

- Baseline committed and pushed to private `aomi-labs/telegram` (`0d33c9c`).
- Composite checkpoint `8b022339` and tenant-routing fix `e40f7397` are on
  `CeciliaZ030/frontend`, branch `cecilia/agent-unifi-local`; upstream access is read-only.
- Local backend/harness checkpoint `0fdaa0bff` is on `aomi-labs/product-mono`,
  branch `cecilia/world-local-e2e`. These are checkpoints, not release approvals.
- Standard MetaMask and Flask both emitted alternating UniFi/MegaETH chain events while
  the page recorded no switch requests. Disabling Flask and reloading with standard
  MetaMask stopped the observed loop; subsequent chain sampling stayed on UniFi.
- The fork was down. Restored using the scoped harness in persistent screen session
  `codex-world-fork`; account 21 has 1,000 USDT plus 0.05 WETH after this fresh bootstrap.
- Fixed Composite ingest routing: backend platform `world-market-apps` and mini-app
  tenant `world` are independent identifiers. The new `miniAppTenantId` config selects `world`.
  Browser SIWE issue succeeded, QR rendered, and the service stored the account-21 mapping.
- Service verification: 44 tests pass with an isolated local test database, 2 optional
  public-chain tests skipped. All packages typecheck. Edge tests inject their HTTP
  transport rather than replacing global fetch after the proxy transport was captured.
- Pending: real phone QR claim, owner grant, activation, real bot commands and mini-app
  initData, chat draft handoff, agent trade receipt and negative authorization cases.
- No deployment or bot-token rotation completed.
