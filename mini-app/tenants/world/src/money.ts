import BigNumber from "bignumber.js";

/** The partner's money rule: exactly 2 dp, thousands separators, ≈ and whole dollars for estimates, U+2212 minus. */
export function formatMoney(value: BigNumber.Value, isEstimate = false): string {
  const v = new BigNumber(value);
  const dp = isEstimate ? 0 : 2;
  const body = v.abs().toFormat(dp, BigNumber.ROUND_HALF_UP, { groupSeparator: ",", groupSize: 3, decimalSeparator: "." });
  const sign = v.isNegative() && !v.isZero() ? "−" : "";
  return `${sign}${isEstimate ? "≈" : ""}$${body}`;
}

/** Risk score to one decimal, always carrying the ".0". */
export function formatRisk(score: BigNumber.Value): string {
  return new BigNumber(score).toFixed(1, BigNumber.ROUND_HALF_UP);
}

/** Mark price the way a trader reads it: whole dollars at or above 100, else 2 dp. */
export function formatMark(mark: BigNumber.Value): string {
  const v = new BigNumber(mark).abs();
  return v.toFormat(v.gte(100) ? 0 : 2, BigNumber.ROUND_HALF_UP, { groupSeparator: ",", groupSize: 3, decimalSeparator: "." });
}

/** One decimal, trailing zeros dropped, for ratios like dollarpower. */
export function formatRatio(value: BigNumber.Value): string {
  const s = new BigNumber(value).toFixed(1, BigNumber.ROUND_HALF_UP);
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}
