# World Markets Agent — Telegram Messaging UX Implementation Plan

> **For Hermes:** Execute task-by-task. Each task is TDD where code is involved.

**Goal:** Pour the TELEGRAM-MESSAGING-UX-SPEC into the existing `world-markets`
Aomi plugin (`Desktop/World/aomi`) as (1) rewritten skill sections that carry the
§6 copy + §4 invariants the model follows, and (2) new deterministic
reporting-service tools so every number in a message originates from a tool
result, never the LLM.

**Architecture:** An AomiApp = Preamble + Tools + Skill sections (confirmed from
aomi.dev/docs/build/services/building-apps and .../toolchain/aomi-run). The Aomi
runtime — not the plugin — owns Telegram transport, edited messages, proactive
pushes, the simulation-first tx pipeline, and scheduling. Therefore this build
does NOT implement a Telegram bot or a message renderer. It implements:
- **Skill sections** (markdown the model obeys): persona/voice, the honest-numbers
  law, policies≠preferences, the symmetric rule pair, action classes, autonomy
  ladder, guardian inversion, notification budget, and the §6 templates as
  copy-exact response patterns with all five states.
- **Deterministic tools** (Rust, like the existing 7): the reporting-service
  functions that compute every number the templates interpolate. Real engine
  reads feed what exists today; derived numbers sit behind a fixture-backed
  reporting trait per spec §11, clearly labeled as estimates.
- **A test harness** proving §10 done-criteria without the live host.

**Tech stack:** Rust 2024, aomi-sdk 3.1.0, existing `world-markets` crate;
`rust_decimal` for money math; golden-file tests via `cargo test`; `aomi-run`
(dev-runtime feature) for interactive sanity.

**Number-safety boundary (the load-bearing rule):** The model may state a number
ONLY if it appears verbatim in a tool result from this turn. Enforced by (a)
skill copy stating the law explicitly and per-template, and (b) making every
figure the templates need reachable through a tool. Deterministic arithmetic
(deltas, savings, notionals) is done inside tools in Rust, never by the model.

---

## Phase 0 — Ground truth & scaffolding

### Task 0.1: Confirm the skill-section wiring contract
- Re-read `src/lib.rs` `dyn_aomi_app!` skill block: sections map keys →
  `skill/<file>.md` under `src/`. Note the existing 8 sections + order (the
  `app_skill_is_valid_and_mandate_aware` test asserts exact section names/order).
- Completion: documented list of section keys the test enforces; decide which we
  rewrite in place vs which new sections we add (adding sections requires editing
  both `lib.rs` and the test).

### Task 0.2: Snapshot current green state
- Run `cargo build` and `cargo test` (non-ignored). Record baseline pass/fail so
  regressions are attributable.
- Completion: baseline captured; if red at baseline, stop and report.

---

## Phase 1 — The reporting-service trait (numbers behind a boundary)

### Task 1.1: Define the reporting contract (§11 integration contract)
- Create `src/reporting.rs`: a `Reporting` trait returning structured, decimal
  number bundles for each template that needs derived figures:
  - `account_effect(before, action) -> AccountEffect` (yield %, exposure, avail,
    risk score, est cost) — §6.3, §6.5
  - `resize_solver(intent, floor) -> LargestCompliantSize` — §6.6 blocks, R3
  - `exit_cost(position) -> ExitCost` (impact %, time-to-flat p90, net result) — §6.17, §05
  - `slice_plan(order, book_depth) -> SlicePlan` (market cost, sliced cost, saved,
    null-case $0) — §6.16
  - `dollarpower(portfolio) -> Dollarpower` (ratio + dollar translation) — §6.15
  - `guardian_unwind(state, target, prefs) -> UnwindPlan` (ordered legs, per-step
    Δscore + cost, kept, cost-of-protection vs liq-avoided) — §6.8, R4
  - `negative_carry_state(position) -> CarryState` — §6.9
- All fields `rust_decimal::Decimal` or `String` (never `f64` for money). Every
  bundle carries an `is_estimate: bool` + `baseline: String` so copy can name the
  baseline (§4.1 "every counterfactual names its baseline").
- Completion: trait compiles; doc comments cite the spec section each method serves.

### Task 1.2: Fixture-backed implementation
- `FixtureReporting` impl returning deterministic values from a loaded fixtures
  file, so the harness + `aomi-run` produce stable golden output. Zero-edge cases
  return "≈ $0"-shaping values (e.g. `saved == 0`).
- Completion: unit test that `slice_plan` on a tiny order returns `saved = 0`
  and `null_case = true`.

### Task 1.3: Guardian cheapest-safe algorithm (R4 — the headline deliverable)
- Implement the greedy Δscore/exit_cost selection with re-simulation, the five
  per-candidate terms (Δscore, exit_cost, dependency_penalty, protected_veto,
  exposure_term), override penalties (`protect_eth`, `ask_each_time`), degraded
  state (slice within emergency slippage; never override it). Pure function over
  fixture candidate sets so it is unit-testable deterministically.
- Completion: tests — (a) protected holding never chosen unless it's the only
  path (then reported); (b) never partial-closes a structure into a worse
  residual; (c) stops exactly at recovery target.

---

## Phase 2 — Deterministic tools on the app

### Task 2.1: Add reporting tools mirroring the existing 7
- In `src/tool.rs`, add `DynAomiTool` impls that expose the reporting methods:
  `preview_account_effect`, `compute_resize`, `preview_exit`, `plan_large_order`,
  `get_dollarpower`, `simulate_guardian_unwind`, `check_negative_carry`.
- Each returns the structured bundle as JSON (numbers as strings, preserving
  exactness per skill action-rule "preserve raw amounts when exactness matters").
  Each JSON carries `source`, `is_estimate`, `baseline`.
- Register all in `src/lib.rs` `tools = [...]`.
- Completion: `cargo build`; each tool has a unit test asserting the JSON shape
  and that a zero-edge input yields the `$0`/`null_case` marker.

### Task 2.2: Wire real engine reads where they already exist
- `preview_account_effect` etc. take the same `DynToolCallCtx` account resolution
  as the existing tools (owner/permitted-trader check, handover account) so live
  RPC reads feed the real inputs; only the *derived* deltas come from `Reporting`.
- Completion: the ignored live-RPC test pattern extended with one derived-number
  path (kept `#[ignore]`, documented).

---

## Phase 3 — Skill sections (the copy + behavioral contract)

> Rewrite/extend the `src/skill/` markdown. Keep sections the lib test names;
> add new ones by editing `lib.rs` + the test together.

### Task 3.1: Rewrite `instructions.md` — persona, voice, honest-numbers law
- §2 persona ("a precise financial operator working inside rules I control"),
  §2 voice rules, banned/preferred vocab, and the §4.1 LAW stated as an absolute:
  *"You never write a number. State a figure only if it appears in a tool result
  from this turn; if you need one you don't have, call the tool that computes it.
  Never do arithmetic yourself."*
- Completion: instructions.md contains the law verbatim + banned-vocab list;
  lib test still green (section unchanged in name).

### Task 3.2: Rewrite `action-rules.md` — invariants
- Policies≠preferences (§4.2), symmetric rule pair (§4.3), action classes (§4.4),
  autonomy ladder (§4.5), guardian inversion (§4.6), notification budget (§4.7),
  message anatomy (§5), "on-chain ✓ only on policy facts", one dominant action.
- Map each rendered figure to its producing tool (so the model knows which tool
  supplies which number).
- Completion: every §4 invariant present with the tool that enforces/feeds it.

### Task 3.3: Rewrite `workflows.md` — the §6 templates, all five states
- Each §6 template as a workflow: trigger → required info → which tools to call →
  copy-exact response skeleton with `[#]` placeholders that map to tool fields →
  the normal/risky/blocked/partial-failure/exit variants that apply.
- Blocks (§6.6 a–e) keyed to the engine's real `rule` codes (`portfolio_floor`,
  `market_not_permitted`, `liquidatable`, `insufficient_spot_balance`,
  `withdraw_not_supported`) — copy uses the engine `rule`+`detail` verbatim and
  cites exactly one number (the floor).
- Completion: all §6.1–6.17 present; each names ≥1 tool; blocks cite one number.

### Task 3.4: Update `safety.md` + reference sections
- Safety: add the honest-numbers + notification-budget + guardian-inversion safety
  restatements; keep the non-executable guarantees.
- Add reference sections as needed: `dollarpower.md`, `guardian.md` (the R4 algo
  described for the model), `notifications.md` (event→channel table). Wire new
  section keys into `lib.rs` + the lib test.
- Completion: lib `app_skill_is_valid_and_mandate_aware` test updated + green.

---

## Phase 4 — Verification harness (§10 done-criteria)

### Task 4.1: Golden-file template test
- `tests/templates.rs`: for each §6 template × each applicable state, assemble the
  tool-result fixtures, render the skeleton via a pure Rust `fill(template, fields)`
  helper (NOT the LLM — the test proves the deterministic substitution + that
  placeholders only resolve from fixture fields), assert against golden files in
  `tests/golden/`.
- Assert §10: (2) zero-edge slice → "≈ $0 difference"; (3) every block golden
  cites exactly one number and never the warn band/recovery target; (4) "on-chain ✓"
  appears only in policy-fact goldens; (7) no banned vocabulary in any golden
  (regex scan of the banned list).
- Completion: `cargo test` green; goldens committed.

### Task 4.2: Number-provenance test
- Static test: scan `workflows.md` for any literal digit outside a `[#]`
  placeholder or an illustrative-example fence; fail if a bare number sits in a
  response skeleton (guards the honest-numbers law at authoring time).
- Completion: test passes on authored copy.

### Task 4.3: aomi-run interactive sanity (manual, documented)
- Document the `cargo run -p aomi-sdk --features dev-runtime --bin aomi-run --
  target/debug/libworld_markets.dylib --env-file .env` invocation and 3 scripted
  prompts (evaluate-trade allow, a floor block, "what can't you do?") with the
  expected shape. Note the dev-runtime stubs (`evm-core`, state attributes → None)
  that make live mandate context absent locally.
- Completion: README "Validate" section extended with this.

---

## Phase 5 — Reconcile & finish

### Task 5.1: Full validate
- `cargo fmt --all -- --check`, `cargo clippy --all-targets -- -D warnings`,
  `cargo test`, `cargo build --release`. All green.

### Task 5.2: Spec conformance pass
- Walk §10 Done + §11 contracts + the standards checklist (HANDOFF §9). Confirm:
  five states per applicable template, honest-numbers enforced, blocks one-number,
  on-chain✓ discipline, "Keep current position"+"View on World ↗" on every
  applicable skeleton, notification budget, no banned vocab, no capital-asks.
- Completion: a short CONFORMANCE.md mapping each §10 item → where it's satisfied.

---

## Files likely to change
- `src/lib.rs` — register new tools + new skill section keys; update lib test.
- `src/tool.rs` — new reporting `DynAomiTool` impls.
- `src/reporting.rs` — NEW: trait + fixture impl + guardian algorithm.
- `src/skill/instructions.md`, `action-rules.md`, `workflows.md`, `safety.md` — rewrite.
- `src/skill/reference/{dollarpower,guardian,notifications}.md` — NEW.
- `tests/templates.rs`, `tests/golden/*`, `tests/fixtures/*` — NEW.
- `Cargo.toml` — no new runtime deps expected (rust_decimal already present).
- `README.md`, `CONFORMANCE.md` — docs.

## Risks / open questions
- **Section-count coupling:** adding skill sections forces a `lib.rs` + lib-test
  edit in lockstep; keep them in the same task.
- **Risk-score mapping (§11):** engine exposes an RAPV floor, not a 0–10 score.
  Copy cites the engine's value in engine units until the mapping exists — do NOT
  invent a 0–10 number. Flag in CONFORMANCE.
- **Runtime-owned features:** edited-message live leg-state, proactive pushes,
  Sunday digest scheduling, bundling/priority are HOST features. We encode the
  copy + trigger conditions in skill sections and provide the number tools; we
  cannot unit-test the transport. State this boundary explicitly in CONFORMANCE.
- **The LLM still ultimately types the message.** The plugin cannot hard-intercept
  a rogue number. Mitigation is defense-in-depth: the law in the preamble, numbers
  made available as tools, and the authoring-time provenance test — documented as
  a residual risk the host's own guardrails may further close.
