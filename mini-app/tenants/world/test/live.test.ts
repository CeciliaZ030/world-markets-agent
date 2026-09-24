import { describe, expect, it } from "vitest";
import { visibleLength } from "@aomi-telegram/core";
import { renderBalance, renderDollarpower, renderPositions, renderRisk } from "../src/lookups.ts";
import { WorldVenue } from "../src/venue.ts";
import { WORLD_DEFAULTS } from "../src/index.ts";

// Hits the public UniFi RPC. Opt in with WORLD_LIVE=1.
const suite = process.env.WORLD_LIVE ? describe : describe.skip;

suite("live UniFi reads, account 20", () => {
  const venue = new WorldVenue(WORLD_DEFAULTS);
  it("snapshot renders every lookup within budget", async () => {
    const s = await venue.snapshot("0xB63F25bE257855010713BC80b53dB6b956A71101", 20n);
    expect(s.quote).toBe("USDT");
    expect(s.riskScore).toBeGreaterThanOrEqual(0);
    for (const [render, budget] of [[renderBalance, 60], [renderRisk, 60], [renderDollarpower, 80], [renderPositions, 180]] as const) {
      const out = render(s);
      expect(visibleLength(out)).toBeLessThanOrEqual(budget);
    }
    const again = await venue.snapshot("0xB63F25bE257855010713BC80b53dB6b956A71101", 20n);
    expect(again.readAt).toBe(s.readAt);
  }, 60_000);
  it("open orders and products", async () => {
    const products = await venue.products();
    expect(products.some((p) => p.symbol === "WETH" && p.product === "perp")).toBe(true);
    const orders = await venue.openOrders(12n);
    expect(Array.isArray(orders)).toBe(true);
  }, 120_000);
});
