import BigNumber from "bignumber.js";
import { describe, expect, it } from "vitest";
import { visibleLength } from "@aomi-telegram/core";
import { formatMoney, formatRisk, formatRatio } from "../src/money.ts";
import { renderAvailable, renderBalance, renderDollarpower, renderPositions, renderRisk } from "../src/lookups.ts";
import { account20 } from "./fixtures.ts";

describe("money", () => {
  it("two decimals with thousands separators and a real minus", () => {
    expect(formatMoney("1204.1")).toBe("$1,204.10");
    expect(formatMoney("-0.5")).toBe("−$0.50");
    expect(formatMoney("0")).toBe("$0.00");
  });
  it("estimates round to whole dollars with ≈", () => {
    expect(formatMoney("1204.6", true)).toBe("≈$1,205");
  });
  it("risk keeps one decimal", () => {
    expect(formatRisk(1.4488)).toBe("1.4");
    expect(formatRisk(10)).toBe("10.0");
    expect(formatRatio("1.449")).toBe("1.4");
    expect(formatRatio("2.0")).toBe("2");
  });
});

describe("lookups, account 20", () => {
  const s = account20();
  it("b", () => {
    expect(renderBalance(s)).toBe("Portfolio <code>$88.63</code>.");
    expect(visibleLength(renderBalance(s))).toBeLessThanOrEqual(60);
  });
  it("r bands", () => {
    expect(renderRisk(s)).toBe("Liquidation risk <code>1.4/10.</code>");
    expect(renderRisk({ ...s, riskScore: 8.2 })).toBe("Liquidation risk <code>8.2/10.</code> — high.");
    expect(renderRisk({ ...s, rapv: new BigNumber(-1) })).toBe("Eligible for liquidation — liquidation risk <code>1.4/10.</code>");
  });
  it("a is the exact quote available", () => {
    expect(renderAvailable(s)).toBe("Available to deploy <code>$99.88</code>.");
  });
  it("d: gross notional over NAV", () => {
    // 99.8765 + 0.05 × 2494.3 = 224.5915 → / 88.6255 = 2.534…
    expect(renderDollarpower(s)).toBe("Dollarpower <code>2.5</code>× — your <code>$88.63</code> is doing the work of <code>$224.59</code>.");
    expect(visibleLength(renderDollarpower(s))).toBeLessThanOrEqual(80);
  });
  it("p: fixed class order, side on perps", () => {
    expect(renderPositions(s)).toBe("<b>Holdings</b> ◆ <code>USDT $99.88</code> · <b>Perps</b> ◇ <code>WETH long $124.72</code>");
  });
  it("p: empty shows cash", () => {
    expect(renderPositions({ ...s, holdings: [], perps: [] })).toBe("No open positions. Cash <code>$0.00</code>.");
  });
  it("p: drops later classes whole to stay within 180", () => {
    const many = { ...s, lent: Array.from({ length: 4 }, (_, i) => ({ tokenId: 10 + i, symbol: `TOK${i}`, quantity: new BigNumber(1000), mark: new BigNumber(1234.56) })) };
    const out = renderPositions(many);
    expect(visibleLength(out)).toBeLessThanOrEqual(180);
    expect(out).toContain("<b>Holdings</b>");
  });
});
