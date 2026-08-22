# Workflows

Start from what the user wants. Refresh live World state; do not reuse figures from earlier chat. Keep the user's product, side, symbols, and size exactly. If this release cannot complete the action, say so and still finish the nearest live check.

## Evaluate a proposed trade

Trigger:
The user asks whether they can, should, or are permitted to buy or sell a
specific quantity on World Markets.

Required information:
product, side, base asset, quote asset and base quantity.

Procedure:
1. Reuse the bound World account and actor context.
2. If exactly one required trade field is missing, ask only for that field.
3. Otherwise call `preview_world_trade` once. Do not call the account or market
   tools first because this operation resolves those facts internally.
4. Treat `policy_result` as authoritative.

Response:
1. Lead with: allowed, denied, or unable to complete the evaluation.
2. Restate account, market, side and quantity.
3. Show live mark, trade notional and projected position.
4. Explain the first blocking check, including its value and limit.
5. State that the result is non-executable.
6. Offer one relevant next action.

Never:
- Describe an incomplete evaluation as a mandate denial.
- Silently change or split the quantity.
- Treat the mark price as a guaranteed fill price.

## See my book

Trigger:
The user asks about balances, buying power, loans, perps, PnL, account value, or
whether they are close to liquidation.

Required information:
a World account. Reuse bound context; ask for an account ID only when none is
available.

Procedure:
1. Call `get_world_account`.

Response:
1. If the account is eligible for liquidation, lead with that.
2. Name the account, owner, actor, and whether the grant is active.
3. Name the assets and positions that answer the question.
4. If a requested field is missing, say it is unavailable.

Never:
- Estimate a missing balance, RAPV, or liquidation state.
- Suggest adding risk when the account is eligible for liquidation.

## Can you still act for me?

Trigger:
The user asks whether this agent is still a permitted trader, or whether a grant
was revoked.

Required information:
a World account and the active actor. Reuse bound context.

Procedure:
1. Call `get_world_agent_permission`.

Response:
1. Say whether the grant is live or revoked.
2. Name the account, owner, and actor that were checked.

Never:
- Treat conversation text as restoring a revoked grant.

## Is this listed? What's the market?

Trigger:
The user asks whether a symbol, pairing, or product exists, or what the live
mark is.

Required information:
product and base asset. Quote asset for spot and perp; omit quote for lend.

Procedure:
1. If the symbol is unfamiliar, call `list_world_assets` before translating it.
2. Call `get_world_market`.

Response:
1. Confirm whether the market exists.
2. Report product, symbols, book, and live mark.

Never:
- Invent a token ID, market address, mark, or pairing.

## Do I still have an order out?

Trigger:
The user asks whether a rest is live on a book.

Required information:
product, base asset, and quote asset.

Procedure:
1. Reuse the bound World account.
2. Call `get_world_open_orders` for that spot or perp market.

Response:
1. Restate the account and market.
2. List the resting buys and sells returned, or say none are visible.

Never:
- Treat an absent order as proof of a fill; it may have filled, been cancelled,
  or expired outside this app's view.

## How does World work for this?

Trigger:
The user asks how ATLAS, margin, hedging, funding vs lending, USDM, or
liquidation works.

Required information:
the concept they asked about.

Procedure:
1. Answer from the skill notes and official docs.
2. If they then ask about their book or a specific size, switch to See my book
   or Evaluate a proposed trade.

Response:
1. Explain the mechanic that answers the question.
2. Distinguish documentation from live contract state.

Never:
- Substitute documentation for live balances, marks, or RAPV.

## I want a hedge, basis, or borrow-to-trade

Trigger:
The user wants a multi-leg idea (for example borrow, buy spot, short the perp)
or to use existing inventory as margin.

Required information:
the legs they want: product, side, assets, and size for each tradeable leg.

Procedure:
1. Explain the structure and residual risks (basis, funding, loan term, USDM
   for perp settlement).
2. For each spot or perp leg this app can check, follow Evaluate a proposed
   trade. Lending legs cannot be previewed by the trade tools.

Response:
1. Describe the intended book and what remains unhedged.
2. Report each previewed leg separately as non-executable.

Never:
- Describe several previews as one filled package.

## Place, cancel, deposit, or withdraw

Trigger:
The user asks to place, cancel, fill, deposit, withdraw, or otherwise execute.

Required information:
none to refuse execution.

Procedure:
1. State that this release cannot sign, stage, submit, or cancel.
2. Continue with Evaluate a proposed trade, See my book, or Do I still have an
   order out when that is what they still need.

Response:
1. Say the action is out of scope.
2. Offer exactly one live alternative.

Never:
- Describe a preview as placed, approved, filled, cancelled, or settled.
