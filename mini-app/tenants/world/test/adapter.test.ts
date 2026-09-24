import { describe, expect, it } from "vitest";
import { WorldAdapter } from "../src/adapter.ts";
import { worldTenant } from "../src/index.ts";
import { decodeOrders, decodePrice, krakenPair } from "../src/venue.ts";
import { FakeVenue } from "./fixtures.ts";

describe("adapter", () => {
  it("maps the snapshot onto the tenant contract", async () => {
    const adapter = new WorldAdapter(new FakeVenue());
    const account = await adapter.resolveAccount({ tenant: "world", telegramUserId: "1", accountId: "20", chainId: 2092151908, ownerAddress: "0xB63F25bE257855010713BC80b53dB6b956A71101" });
    expect(await adapter.portfolio(account)).toEqual({ nav: "88.6255", rapv: "88.5219", quote: "USDT", eligibleForLiquidation: false });
    const positions = await adapter.positions(account);
    expect(positions.perps[0]).toMatchObject({ symbol: "WETH", side: "long", qty: "0.05" });
    expect(await adapter.riskBand(account)).toEqual({ score: 1.4488528539744774, band: "safe" });
  });
  it("commands answer unmapped users with the web pointer and never a menu", async () => {
    const tenant = worldTenant(new FakeVenue());
    const b = tenant.commands.find((c) => c.name === "b")!;
    const reply = await b.render({ binding: null, account: null, args: [], chatId: "1", message: { message_id: 1, date: 0, chat: { id: 1, type: "private" } }, miniAppUrl: () => null });
    expect(reply.text).toMatch(/World Markets web app/);
  });
});

describe("decoders", () => {
  it("Price59EN5", () => {
    expect(decodePrice((2494n << 5n) | 0n)).toBe("2494");
    expect(decodePrice((24943n << 5n) | 1n)).toBe("2494.3");
  });
  it("packed orders honour the cursor and skip zero words", () => {
    const product = { symbol: "WETH", product: "perp" as const, book: "0x", tokenId: 4, positionDecimals: 7 };
    const price = (24943n << 5n) | 1n;
    const qty = 5_000_000n; // 0.5 at 7 dp
    const word = price | (qty << 64n) | (77n << 128n) | (0n << 192n);
    const cursor = 2n; // returned = 2
    const orders = decodeOrders([cursor, word, 0n], product, "sell");
    expect(orders).toEqual([{ id: "77", symbol: "WETH", market: "perp", side: "sell", price: "2494.3", qty: "0.5", kind: "limit" }]);
  });
  it("kraken pairs", () => {
    expect(krakenPair("WETH")).toBe("ETHUSD");
    expect(krakenPair("cbBTC")).toBe("XBTUSD");
    expect(krakenPair("USDT")).toBeNull();
    expect(krakenPair("AAPLon")).toBeNull();
  });
});

describe("NewTrade decode", () => {
  it("reads the base quantity from the `from` leg and the match price", async () => {
    const { decodeNewTrade, decodeNewTradeData } = await import("../src/venue.ts");
    const product = { symbol: "WETH", product: "perp" as const, book: "0x", tokenId: 4, positionDecimals: 7 };
    const price = (24943n << 5n) | 1n; // 2494.3
    const data = (1n << 224n) | (price << 160n) | (7n << 96n) | (9n << 32n) | 5n;
    const quantities = (1_247_150n << 192n) | (5_000_000n << 128n); // to = 124.7150 USDT quote leg, from = 0.5 WETH base leg
    const hex = "0x" + quantities.toString(16).padStart(64, "0") + data.toString(16).padStart(64, "0");
    const [q, d] = decodeNewTradeData(hex);
    expect(decodeNewTrade(q, d, product, "buy", 4)).toEqual({ symbol: "WETH", side: "buy", price: "2494.3", qty: "0.5" });
  });
});
