# Future work & observations

Living notes for architectural decisions that are good enough for now but should be revisited.

---

## Liquidation risk (`liquidationRisk`)

### Current state

`liquidation_risk` is computed in Rust (`src/liquidation_risk.rs`) and returned from `get_world_account` under `metrics`. The algorithm is a port of `Portfolio.calculateLiquidationRisk` from the Composite frontend (`@composite/sdk` in the `frontend` monorepo).

### Observations

- **Two implementations.** The canonical logic lives in TypeScript (`frontend/web/packages/sdk/src/contracts/portfolio.ts` and `@wcm/tools`). The Rust port can drift when the SDK changes risk bounds, funding history, token decoding, or the health-score mapping.
- **Why Rust for now.** The Aomi plugin is a Rust `cdylib` with no Node runtime. A local port was the fastest path to ship the 0–10 score the Telegram agent and Composite UI both need, without a new deployable or subprocess dependency.
- **RPC overlap is acceptable today.** `WorldClient` already reads chain state for account tools; the metrics module reuses that data and adds `block_timestamp` + `readFundingRateHistory` calls. A future service could own all reads or accept a snapshot from Rust—TBD when we build (A).
- **Skill contract is stable.** Action rules and §6.13 health templates point at `get_world_account` → `metrics`. Changing the backend should not require copy changes if field names and semantics stay the same.

### Future intention: Option A — metrics sidecar (canonical SDK)

**Target:** Replace the Rust port with a small HTTP service (sidecar or shared World service) that depends on `@composite/sdk` and exposes portfolio metrics, including `liquidationRisk`.

Rough shape:

```
POST /portfolio-metrics
  → { nav, prv, liquidationRisk, liquidation_risk_band, … }
```

The plugin would call this service from `get_world_account` (or a dedicated tool) instead of `liquidation_risk::compute_metrics`.

**Why this over other options:**

| Option | Verdict |
|--------|---------|
| **A — Sidecar / microservice** | **Chosen target.** Single source of truth; SDK upgrades = redeploy service. |
| B — Node CLI subprocess | Acceptable for local dev only; awkward in production (spawn latency, `node_modules` on host). |
| C — Rust port + CI parity tests | **Current interim.** Reduces surprise drift but does not eliminate duplication. |
| D — Hosted World reporting API | Use if/when World exposes the same fields officially—could subsume the sidecar. |
| E — Shared WASM/native lib | High cost; SDK is Node/ethers-centric today. |

**Open questions when implementing (A):**

1. Who fetches chain state—the service (duplicate RPC) or Rust (pass a portfolio snapshot)?
2. Where does the sidecar live—`frontend` repo package, separate deploy, or World infrastructure?
3. Versioning: pin `@composite/sdk` in the service; how does the plugin handle version skew?
4. Failure mode: fallback to Rust, fail closed, or omit `metrics` if the service is down?

**When to revisit:** Before production Telegram traffic at scale, or on the first `@composite/sdk` change that touches `calculateLiquidationRisk`, `evaluate`, or related `@wcm/tools` helpers—whichever comes first.

### Interim maintenance (until A)

- When the SDK risk logic changes, update `src/liquidation_risk.rs` in the same PR (or immediately after) and note the SDK commit/version in the PR description.
- Consider adding CI parity tests (Rust vs Node on fixture accounts) if drift becomes painful before (A) ships.

---

## Template for new entries

```markdown
### <topic>

#### Current state
…

#### Observations
…

#### Future intention
…

#### When to revisit
…
```
