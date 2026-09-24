import BigNumber from "bignumber.js";

export function money(value: string | number | null | undefined, dp = 2): string {
  if (value === null || value === undefined || value === "") return "—";
  const v = new BigNumber(value);
  if (!v.isFinite()) return "—";
  const sign = v.isNegative() && !v.isZero() ? "−" : "";
  return `${sign}$${v.abs().toFormat(dp, BigNumber.ROUND_HALF_UP, { groupSeparator: ",", groupSize: 3, decimalSeparator: "." })}`;
}

export function qty(value: string | null | undefined, maxDp = 6): string {
  if (!value) return "—";
  const v = new BigNumber(value);
  return v.isFinite() ? v.toFormat(Math.min(maxDp, Math.max(0, v.dp() ?? 0)), { groupSeparator: ",", groupSize: 3, decimalSeparator: "." }) : "—";
}

export function ago(iso: string | Date | null | undefined): string {
  if (!iso) return "first visit";
  const t = new Date(iso).getTime();
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 90) return `${s}s ago`;
  if (s < 5400) return `${Math.round(s / 60)}m ago`;
  if (s < 172800) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function dateShort(iso: string | Date): string {
  return new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
