import BigNumber from "bignumber.js";

/** Everything the lookups and views need about one account, read in one pass. Plain data, exact decimals. */
export interface TokenLine { tokenId: number; symbol: string; quantity: BigNumber; mark: BigNumber | null }
export interface PerpLine extends TokenLine { side: "long" | "short"; entry: BigNumber }
export interface AccountSnapshot {
  accountId: bigint;
  owner: string;
  quote: string;
  /** Net asset value, evaluate at risk multiplier 0. */
  nav: BigNumber;
  /** Risk-adjusted portfolio value from the contract. Negative means liquidatable. */
  rapv: BigNumber;
  /** 0..10, higher is worse. */
  riskScore: number;
  leverage: BigNumber;
  /** Quote balance minus everything sequestered by resting orders. */
  cashAvailable: BigNumber;
  holdings: TokenLine[];
  perps: PerpLine[];
  lent: TokenLine[];
  borrowed: TokenLine[];
  readAt: number;
}

export type Band = "safe" | "elevated" | "high" | "liquidation";

export function riskBand(score: number, eligible: boolean): Band {
  if (eligible || score >= 10) return "liquidation";
  if (score >= 8) return "high";
  if (score >= 6) return "elevated";
  return "safe";
}

/** Absolute quote notional of a line, or null when the mark is missing. */
export function notional(line: TokenLine): BigNumber | null {
  return line.mark ? line.quantity.abs().times(line.mark) : null;
}

/** Dollarpower: gross notional at work divided by the capital committed (NAV). */
export function dollarpower(snapshot: AccountSnapshot): { ratio: BigNumber; committed: BigNumber; equivalent: BigNumber; isEstimate: boolean } {
  let total = new BigNumber(0);
  let isEstimate = false;
  for (const line of [...snapshot.holdings, ...snapshot.perps, ...snapshot.lent, ...snapshot.borrowed]) {
    const n = notional(line);
    if (n === null) isEstimate = true;
    else total = total.plus(n);
  }
  const committed = snapshot.nav;
  const equivalent = total.gt(0) ? total : committed;
  const ratio = committed.gt(0) ? equivalent.div(committed) : new BigNumber(0);
  return { ratio, committed, equivalent, isEstimate };
}
