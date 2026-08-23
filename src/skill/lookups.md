# Lookups (one-line answers)

Read-only facts → **one line, answer only.** Actions keep full anatomy in `workflows.md`. Brevity never hides urgent risk.

Numbers from tools only. Every figure in monospace (`` ` `` code entity). Never explain formulas. Never gamify risk scores.

## Hard rules

Whole-message terse token → lookup; never clarify; never capability menus. Tool first, then one line.

## Lookup vs action

| kind | examples | response |
|---|---|---|
| Lookup | `b`, balance, `p`, `risk` | one line |
| Action | preview, receipt, block, guardian | full anatomy |
| Health | "how am I doing?" | §6.13 card — not a lookup |

## Terse tokens (whole-message match only)

Lone `b`/`balance`/`risk`/etc. = lookup. Inside prose, `a`/`d` are words. See tool column:

| token | tool(s) |
|---|---|
| `b` | `get_world_account` → `lookups.portfolio_value` |
| `p` | `get_world_account` → `lookups.positions` |
| `r` | `get_world_account` → `metrics.liquidation_risk`, `account.eligible_for_liquidation` |
| `a` | `lookups.available_to_deploy` only if present — else refuse |
| `d` | `get_dollarpower` |

## Core formats (`[#]` verbatim from tools, every figure in `` ` ``)

**`b`:** > Portfolio `[#]`. *(reducible until window P&L ships — never fabricate a delta.)*

**`p`** — from `lookups.positions`. Classes in fixed order, never ranked across classes. Class labels **bold**; spine glyphs in prose only (never inside mono blocks):

- **Holdings** ◆ — spot balances (cash is a holding, never ranked against a perp)
- **Perps** ◇ — perp notional; labels include side (e.g. `WBTC short`)
- **Lent** ◈ — lending credit
- **Borrowed** ◈ — lending debt (never summed with Lent)

Normal (hedged example):
> **◆ Holdings** `WETH` `$1,000.00` · `USDT` `$691.15`
> **◇ Perps** `WETH short` `$1,000.00`
> ↳ `WETH` nets `≈$0` directional — hedged

Truncated (per class, never global):
> **◇ Perps** `WBTC short` `$2,707.71` · and `2` more

Empty:
> No open positions. Cash `$691.15`.

Cash only:
> No open positions — all cash, `$691.15`.

Partial data (from `missing_mark_symbols`):
> **◆ Holdings** `SOL` `$161.92` · `USDT` `$691.15`
> ↳ `WETH` is missing a mark price — I've left it out rather than guess.

Netting lines (`lookups.positions.netting`) appear only when the reporting layer reports a relationship. Never compute a net from gross figures yourself.

**`r`** — 0–10, **higher = worse**. RAPV floor is for blocks only.

- Normal (score < 8): > Liquidation risk `[#]`/10.
- Danger (8 ≤ score < 10): > Liquidation risk `[#]`/10 — high.
- Liquidatable (score = 10 or `eligible_for_liquidation`): > Eligible for liquidation — liquidation risk `[#]`/10.

**`a`:** > Available to deploy `[#]`. — or if field absent: > Available to deploy isn't available from live reads yet — I can't quote it without an exact figure.

**`d`:** > Dollarpower `[#]`× — your `[#]` is doing the work of `[#]`.

## Secondary

funding → `get_world_market`: `[asset]` funding `[#]` per 8h. · orders → `get_world_open_orders`: `[#]` resting order(s) · `[#]` buys, `[#]` sells. · mark → `get_world_market`: `[asset]` mark `[#]`. · fills → when a fills tool exists: `[#]` fill(s) · [latest fill summary]. Missing data → one line, no padding.
