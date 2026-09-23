import type { AccountBinding, Candle, ChartPeriod, Fill, FillEvent, Order, Portfolio, Positions, Product, TenantAdapter } from "@aomi-telegram/core";
import { riskBand, type AccountSnapshot } from "./snapshot.ts";
import type { Venue } from "./venue.ts";

export interface WorldAccount { accountId: bigint; owner: string; chainId: number }

/** Maps the venue snapshot onto the tenant contract. Views and commands that want the richer snapshot call `snapshot` directly. */
export class WorldAdapter implements TenantAdapter<WorldAccount> {
  constructor(readonly venue: Venue) {}

  async resolveAccount(binding: AccountBinding): Promise<WorldAccount> {
    return { accountId: BigInt(binding.accountId), owner: binding.ownerAddress, chainId: binding.chainId };
  }

  snapshot(account: WorldAccount): Promise<AccountSnapshot> {
    return this.venue.snapshot(account.owner, account.accountId);
  }

  async portfolio(account: WorldAccount): Promise<Portfolio> {
    const s = await this.snapshot(account);
    return { nav: s.nav.toFixed(), rapv: s.rapv.toFixed(), quote: s.quote, eligibleForLiquidation: s.rapv.lt(0) };
  }

  async positions(account: WorldAccount): Promise<Positions> {
    const s = await this.snapshot(account);
    const line = (l: { symbol: string; quantity: { toFixed(): string }; mark: { toFixed(): string } | null }) => ({ symbol: l.symbol, qty: l.quantity.toFixed(), mark: l.mark?.toFixed() ?? null });
    return {
      holdings: s.holdings.map((h) => ({ symbol: h.symbol, balance: h.quantity.toFixed(), available: h.symbol === s.quote ? s.cashAvailable.toFixed() : h.quantity.toFixed() })),
      perps: s.perps.map((p) => ({ ...line(p), side: p.side, entry: p.entry.toFixed() })),
      lent: s.lent.map((l) => ({ symbol: l.symbol, qty: l.quantity.toFixed(), rate: "" })),
      borrowed: s.borrowed.map((l) => ({ symbol: l.symbol, qty: l.quantity.toFixed(), rate: "" })),
    };
  }

  openOrders(account: WorldAccount): Promise<Order[]> {
    return this.venue.openOrders(account.accountId);
  }

  /** Fills are served from the service's index (see scanFills); the adapter has no store of its own. */
  async fills(): Promise<Fill[]> {
    return [];
  }

  /** UniFi exchange deployment block. */
  readonly fillsGenesis = 18_233_642n;

  headBlock(): Promise<bigint> {
    return this.venue.headBlock();
  }

  async accountOwner(accountId: string): Promise<string | null> {
    if (!/^\d+$/.test(accountId)) return null;
    const owner = await this.venue.accountOwner(BigInt(accountId));
    return /^0x0{40}$/i.test(owner) ? null : owner;
  }

  scanFills(account: WorldAccount, fromBlock: bigint, toBlock: bigint): Promise<FillEvent[]> {
    return this.venue.scanFills(account.accountId, fromBlock, toBlock);
  }

  async markPrice(symbol: string): Promise<string> {
    return (await this.venue.markPrice(symbol)).toFixed();
  }

  async riskBand(account: WorldAccount): Promise<{ score: number; band: ReturnType<typeof riskBand> }> {
    const s = await this.snapshot(account);
    return { score: s.riskScore, band: riskBand(s.riskScore, s.rapv.lt(0)) };
  }

  products(): Promise<Product[]> {
    return this.venue.products();
  }

  chart(symbol: string, period: ChartPeriod): Promise<Candle[]> {
    return this.venue.chart(symbol, period);
  }
}
