# World Markets — execution procedure

One action tool per instruction: it reads live state, evaluates the signed mandate, and on allow encodes the exact venue call and hands it to the host, which stages, simulates, and commits it atomically. That chain is host-enforced. Run it in silence; stop at the first failure.

Every staged call goes `to` the exchange `0xf6b54e033bb45a583aa642924bcef78b804588ae` on chain 2092151908; the guard admits only the fourteen trading functions. Placing or cancelling a lend/borrow *order* has no action tool yet — say so, never encode one.

## New order (spot or perp)

1. `execute_world_order` with product, side, symbols, the user's whole sentence as `text` (plus `price` / `order_type` / `slippage` when named). Do not preview first: it evaluates the same mandate and returns the authoritative `preview.verdict`.
   - `deny` → stop; nothing is staged; report the block. A sizing result (`size_ambiguous`, `size_denomination_mismatch`) → ask its one question verbatim.
   - `allow` → the result carries `staged` (`signature`, `args` `[book, word]`, `calldata`, `description`) and the host has queued the next step.
2. `evm_stage_tx` exactly as the host suggests it, every field and the routed plan id verbatim.
3. `simulate_batch` then `evm_commit_txs` are enforced by the host. A revert or guard block stops the chain; report the reason verbatim. The host's receipt hash is the only fill evidence.

One instruction = one call, one stage, one simulate, one commit; a second order starts again at step 1.

## Cancel a resting order

`get_world_open_orders` for the product and pair → `order_id` and `side` (none → say so). Then `cancel_world_order` with product, side, symbols, `order_id`; `error: no_such_order` → stop. Stage as suggested; simulate and commit are enforced. A cancel never trades.

## Loans

Borrower loans only, one per call, gated on a bound mandate, the floor, and liquidation eligibility; a stop comes back as `verdict` (`liquidatable`, `portfolio_floor`, or a mandate-absent rule).

- Renew: `renew_world_loan { position_id }` → `renewLoan(account, account, position_id)`.
- Pay dues: `pay_world_loan_interest { position_id, reduce_quantity_raw?, extend_period? }` → `payInterestAndFees`; repay principal or extend only when the user asked.
- `error: position_id_unavailable` → the exchange exposes only an aggregated view of that loan; say its id is not available. Never guess an id.

## Never

- Never call `batchCommands`, `liquidate`, `bankruptcy`, `lifoLenderSwap`, `requestPerpTrueUp`, or any deposit, withdrawal, transfer, approval, or bridge; a guard block is a report, not a retry.
- Never call `evm_stage_tx` with data you typed, never stage to another address or chain, never edit a word, selector, or calldata, never re-type a number between tools.
- Never stage after `deny`, `no_such_order`, or a failed simulation; never split a batch, commit twice, or fall back to EOA execution.

After commit: the RECEIPT (reporting skill) from the host receipt and a fresh `get_world_account`; no hash → never claim a fill.
