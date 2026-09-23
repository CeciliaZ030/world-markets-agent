import BigNumber from "bignumber.js";
import type { AccountSnapshot } from "../src/snapshot.ts";
import type { Venue } from "../src/venue.ts";

/** Account 20 on UniFi as read on 2026-09-13: 99.8765 USDT, 0.05 WETH long at 2470.90, mark 2494.3. */
export function account20(): AccountSnapshot {
  return {
    accountId: 20n, owner: "0xB63F25bE257855010713BC80b53dB6b956A71101", quote: "USDT",
    nav: new BigNumber("88.6255"), rapv: new BigNumber("88.5219"), riskScore: 1.4488528539744774,
    leverage: new BigNumber("1.4078"), cashAvailable: new BigNumber("99.8765"),
    holdings: [{ tokenId: 1, symbol: "USDT", quantity: new BigNumber("99.8765"), mark: new BigNumber(1) }],
    perps: [{ tokenId: 4, symbol: "WETH", quantity: new BigNumber("0.05"), mark: new BigNumber("2494.3"), side: "long", entry: new BigNumber("2470.8995527412") }],
    lent: [], borrowed: [], readAt: 0,
  };
}

export class FakeVenue implements Venue {
  reads = 0;
  constructor(private readonly snap: AccountSnapshot = account20()) {}
  async snapshot(): Promise<AccountSnapshot> { this.reads += 1; return this.snap; }
  async openOrders() { return []; }
  async products() { return [{ symbol: "WETH", product: "spot" as const, book: "0x1f137fdc6609532e3471d9F6513CB6b9eC37e6Db", tokenId: 4, positionDecimals: 7 }]; }
  async markPrice() { return new BigNumber("2494.3"); }
  async chart() { return []; }
  async headBlock() { return 19_300_000n; }
  async accountOwner() { return "0xB63F25bE257855010713BC80b53dB6b956A71101"; }
  async scanFills() { return []; }
  invalidate() {}
}
