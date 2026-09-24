import BigNumber from "bignumber.js";
import { Contract, JsonRpcProvider, VoidSigner } from "ethers";
import { Exchange, Portfolio } from "@wcm-inc/sdk";
import type { Candle, ChartPeriod, FillEvent, Order, Product } from "@aomi-telegram/core";
import spotBookAbi from "../abi/ISpotOrderBook.abi.json" with { type: "json" };
import type { AccountSnapshot, PerpLine, TokenLine } from "./snapshot.ts";
import { venueFetch } from "./net.ts";

export interface VenueConfig {
  rpcUrl: string;
  exchangeAddress: string;
  chainId: number;
  /** Seconds a per-account read stays fresh. The partner's warmer used 60. */
  cacheSeconds?: number;
}

/** The read surface the adapter and views need. Implemented by the SDK-backed venue and by test fakes. */
export interface Venue {
  snapshot(owner: string, accountId: bigint): Promise<AccountSnapshot>;
  headBlock(): Promise<bigint>;
  accountOwner(accountId: bigint): Promise<string>;
  scanFills(accountId: bigint, fromBlock: bigint, toBlock: bigint): Promise<FillEvent[]>;
  openOrders(accountId: bigint): Promise<Order[]>;
  products(): Promise<Product[]>;
  markPrice(symbol: string): Promise<BigNumber>;
  chart(symbol: string, period: ChartPeriod): Promise<Candle[]>;
  invalidate(accountId: bigint): void;
}

const QUOTE_TOKEN_ID = 1;
const SEARCH_DEPTH = 1000;
const SEARCH_MAX = 200;

/**
 * World Markets on UniFi through the partner's own SDK. One provider, one
 * read-only Exchange per owner (the SDK resolves "my account" from a signer),
 * and one shared cache keyed by account id.
 */
export class WorldVenue implements Venue {
  private readonly provider: JsonRpcProvider;
  private readonly reader: Exchange;
  private readonly byOwner = new Map<string, Exchange>();
  private readonly snapshots = new Map<string, { at: number; value: Promise<AccountSnapshot> }>();
  private productsCache: { at: number; value: Promise<Product[]> } | null = null;
  private readonly chartCache = new Map<string, { at: number; value: Candle[] }>();
  private readonly cacheMs: number;

  constructor(private readonly config: VenueConfig, private readonly fetchImpl: typeof fetch = venueFetch) {
    this.provider = new JsonRpcProvider(config.rpcUrl, { chainId: config.chainId, name: "unifi" }, { staticNetwork: true });
    this.reader = new Exchange({ contractAddress: config.exchangeAddress, provider: this.provider, cache: { enabled: true, ttl: 30_000 } });
    this.cacheMs = (config.cacheSeconds ?? 60) * 1000;
  }

  private exchangeFor(owner: string): Exchange {
    const key = owner.toLowerCase();
    let exchange = this.byOwner.get(key);
    if (!exchange) {
      exchange = new Exchange({ contractAddress: this.config.exchangeAddress, signer: new VoidSigner(owner, this.provider), cache: { enabled: true, ttl: 30_000 } });
      this.byOwner.set(key, exchange);
    }
    return exchange;
  }

  invalidate(accountId: bigint): void {
    this.snapshots.delete(accountId.toString());
  }

  snapshot(owner: string, accountId: bigint): Promise<AccountSnapshot> {
    const key = accountId.toString();
    const hit = this.snapshots.get(key);
    if (hit && Date.now() - hit.at < this.cacheMs) return hit.value;
    const value = this.readSnapshot(owner, accountId).catch((error) => {
      this.snapshots.delete(key);
      throw error;
    });
    this.snapshots.set(key, { at: Date.now(), value });
    return value;
  }

  private async readSnapshot(owner: string, accountId: bigint): Promise<AccountSnapshot> {
    const exchange = this.exchangeFor(owner);
    const resolved = await exchange.getAccountId({});
    if (resolved !== accountId) throw new Error(`owner ${owner} holds account ${resolved}, binding says ${accountId}`);
    const time = Math.floor(Date.now() / 1000);
    const portfolio = await Portfolio.init(exchange);
    const [nav, rapvMaybe] = await Promise.all([
      portfolio.evaluate({ time, riskMultiplier: 0 }),
      exchange.getRiskAdjustedPortfolioValue({ accountId }),
    ]);
    if (rapvMaybe == null) throw new Error(`no risk-adjusted portfolio value for account ${accountId}`);
    const rapv = rapvMaybe;
    const [riskScore, leverage] = await Promise.all([
      portfolio.calculateLiquidationRisk({ time, nav, prv: rapv }),
      portfolio.calculateLeverage({ time }),
    ]);
    const lines = portfolio.get() as Record<string, PortfolioLine>;
    const holdings: TokenLine[] = [];
    const perps: PerpLine[] = [];
    const lent: TokenLine[] = [];
    const borrowed: TokenLine[] = [];
    let quote = "USDT";
    let cashAvailable = new BigNumber(0);
    for (const line of Object.values(lines)) {
      const { tokenId, symbol } = line.config;
      const mark = line.markPrice ? new BigNumber(line.markPrice.toString()) : null;
      if (tokenId === QUOTE_TOKEN_ID) {
        quote = symbol;
        const balance = await exchange.getBalance({ tokenId, accountId });
        cashAvailable = new BigNumber(balance.balance.toString())
          .minus(balance.spotLendSequesteredAmount.toString())
          .minus(balance.perpSequesteredAmount.toString());
      }
      const balance = new BigNumber(line.balance.toString());
      if (!balance.isZero()) holdings.push({ tokenId, symbol, quantity: balance, mark: tokenId === QUOTE_TOKEN_ID ? new BigNumber(1) : mark });
      const qty = new BigNumber(line.aggPerp.quantity.toString());
      if (!qty.isZero()) perps.push({ tokenId, symbol, quantity: qty, mark, side: qty.lt(0) ? "short" : "long", entry: new BigNumber(line.aggPerp.price.toString()) });
      const lender = new BigNumber(line.aggLend.lenderQuantity.toString());
      if (!lender.isZero()) lent.push({ tokenId, symbol, quantity: lender, mark });
      const borrower = new BigNumber(line.aggLend.borrowerQuantity.toString());
      if (!borrower.isZero()) borrowed.push({ tokenId, symbol, quantity: borrower, mark });
    }
    return {
      accountId, owner, quote,
      nav: new BigNumber(nav.toString()), rapv: new BigNumber(rapv.toString()),
      riskScore, leverage: new BigNumber(leverage.toString()),
      cashAvailable, holdings, perps, lent, borrowed, readAt: Date.now(),
    };
  }

  async markPrice(symbol: string): Promise<BigNumber> {
    const products = await this.products();
    const product = products.find((p) => p.symbol.toUpperCase() === symbol.toUpperCase());
    if (!product) throw new Error(`unknown symbol ${symbol}`);
    if (product.tokenId === QUOTE_TOKEN_ID) return new BigNumber(1);
    const mark = await this.reader.getTokenMarkPrice({ tokenId: product.tokenId });
    if (mark == null) throw new Error(`no mark price for ${symbol}`);
    return new BigNumber(mark.toString());
  }

  products(): Promise<Product[]> {
    if (this.productsCache && Date.now() - this.productsCache.at < 10 * 60_000) return this.productsCache.value;
    const value = this.readProducts().catch((error) => {
      this.productsCache = null;
      throw error;
    });
    this.productsCache = { at: Date.now(), value };
    return value;
  }

  private async readProducts(): Promise<Product[]> {
    const configs = (await this.reader.getAllBulkVaultTokenConfigs()).filter((c) => c.tokenId !== QUOTE_TOKEN_ID);
    // Three book lookups per token, all independent; ethers batches the JSON-RPC calls per tick.
    const perToken = await Promise.all(configs.map(async (config) => {
      const lookups: [Product["product"], () => Promise<{ address: string } | null | undefined>][] = [
        ["spot", () => Promise.resolve(this.reader.getSpotOrderBook(config.tokenId, QUOTE_TOKEN_ID))],
        ["perp", () => Promise.resolve(this.reader.getPerpOrderBook(config.tokenId, QUOTE_TOKEN_ID))],
        ["lend", () => Promise.resolve(this.reader.getLendOrderBook(config.tokenId))],
      ];
      const found = await Promise.all(lookups.map(async ([product, lookup]): Promise<Product | null> => {
        try {
          const book = await lookup();
          if (!book?.address || /^0x0{40}$/.test(book.address)) return null;
          return { symbol: config.symbol, product, book: book.address, tokenId: config.tokenId, positionDecimals: config.positionDecimals };
        } catch {
          return null; // no such book for this token
        }
      }));
      return found.filter((p): p is Product => p !== null);
    }));
    return perToken.flat();
  }

  /** Resting orders across every spot and perp book. Lend books use a different word layout and wait for M3. */
  async openOrders(accountId: bigint): Promise<Order[]> {
    const products = (await this.products()).filter((p) => p.product !== "lend");
    const reads = products.flatMap((product) => (["buy", "sell"] as const).map(async (side) => {
      const book = new Contract(product.book, spotBookAbi as never, this.provider);
      const fn = side === "buy" ? "searchBuyOrders" : "searchSellOrders";
      const words = (await book[fn]!(accountId, SEARCH_DEPTH, SEARCH_MAX, 0n)) as bigint[];
      return decodeOrders(words, product, side);
    }));
    return (await Promise.all(reads)).flat();
  }

  headBlock(): Promise<bigint> {
    return this.provider.getBlockNumber().then((n) => BigInt(n));
  }

  /** Owner address of a venue account, zero address when it does not exist. */
  accountOwner(accountId: bigint): Promise<string> {
    return this.reader.getAccountAddress({ id: accountId });
  }

  /**
   * Trade events for one account. NewTrade indexes buyer and seller, so two
   * topic-filtered getLogs across every spot and perp book address cover a
   * whole block range without scanning the books themselves.
   */
  async scanFills(accountId: bigint, fromBlock: bigint, toBlock: bigint): Promise<FillEvent[]> {
    const products = (await this.products()).filter((p) => p.product !== "lend");
    const byBook = new Map(products.map((p) => [p.book.toLowerCase(), p] as const));
    const acct = "0x" + accountId.toString(16).padStart(64, "0");
    const out: FillEvent[] = [];
    const blockTimes = new Map<number, number>();
    for (const side of ["buy", "sell"] as const) {
      const topics = side === "buy" ? [NEW_TRADE_TOPIC, acct] : [NEW_TRADE_TOPIC, null, acct];
      const logs = await this.provider.getLogs({ address: [...byBook.keys()], topics, fromBlock: Number(fromBlock), toBlock: Number(toBlock) });
      for (const log of logs) {
        const product = byBook.get(log.address.toLowerCase());
        if (!product) continue;
        const [quantities, data] = decodeNewTradeData(log.data);
        let at = blockTimes.get(log.blockNumber);
        if (at === undefined) {
          const block = await this.provider.getBlock(log.blockNumber);
          at = block?.timestamp ?? 0;
          blockTimes.set(log.blockNumber, at);
        }
        const fill = decodeNewTrade(quantities, data, product, side, 4);
        out.push({ ...fill, book: product.book, market: product.product, block: BigInt(log.blockNumber), logIndex: log.index, txHash: log.transactionHash, at: new Date(at * 1000) });
      }
    }
    return out;
  }

  /**
   * Off-chain candles. The venue has no OHLC source on UniFi; Kraken carries
   * the crypto instruments. Tokenized equities have no source yet, so they
   * return no candles rather than an error, and the view says so.
   */
  async chart(symbol: string, period: ChartPeriod): Promise<Candle[]> {
    const pair = krakenPair(symbol);
    if (!pair) return [];
    const key = `${pair}:${period}`;
    const hit = this.chartCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.value;
    const interval = { d: 15, w: 60, m: 240 }[period];
    const response = await this.fetchImpl(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${interval}`, { signal: AbortSignal.timeout(10_000) });
    const payload = (await response.json()) as { error: string[]; result: Record<string, unknown> };
    if (payload.error?.length) throw new Error(payload.error.join("; "));
    const rows = Object.entries(payload.result).find(([k]) => k !== "last")?.[1] as [number, string, string, string, string][] | undefined;
    const bars = { d: 96, w: 168, m: 180 }[period];
    const candles = (rows ?? []).slice(-bars).map(([t, o, h, l, c]) => ({ t, o, h, l, c }));
    this.chartCache.set(key, { at: Date.now(), value: candles });
    return candles;
  }
}

interface PortfolioLine {
  balance: { toString(): string };
  aggLend: { highestInterestRate: unknown; borrowerQuantity: { toString(): string }; lenderQuantity: { toString(): string } };
  aggPerp: { price: { toString(): string }; quantity: { toString(): string } };
  markPrice: { toString(): string } | null;
  config: { tokenId: number; symbol: string; positionDecimals: number };
}

const MASK64 = (1n << 64n) - 1n;

/** Price59EN5: mantissa in the high bits, decimal exponent in the low five. */
export function decodePrice(raw: bigint): string {
  const exponent = Number(raw & 0x1fn);
  return new BigNumber((raw >> 5n).toString()).shiftedBy(-exponent).toFixed();
}

/** Packed order word: price @0, quantity @64, order id @128, type @192. Word 0 is the cursor. */
export function decodeOrders(words: bigint[], product: Product, side: "buy" | "sell"): Order[] {
  const cursor = words[0];
  if (cursor === undefined) return [];
  const returned = Number(cursor & 0xffffffffn);
  return words.slice(1, 1 + returned)
    .filter((w) => w !== 0n)
    .map((w) => ({
      id: ((w >> 128n) & MASK64).toString(),
      symbol: product.symbol,
      market: product.product,
      side,
      price: decodePrice(w & MASK64),
      qty: new BigNumber(((w >> 64n) & MASK64).toString()).shiftedBy(-product.positionDecimals).toFixed(),
      kind: ({ 0: "limit", 2: "fill_all_or_revert", 3: "fill_partial_kill_rest" } as Record<number, string>)[Number((w >> 192n) & 0xfn)] ?? "unknown",
    }));
}

const KRAKEN_PAIRS: Record<string, string> = {
  WETH: "ETHUSD", ETH: "ETHUSD", WBTC: "XBTUSD", CBBTC: "XBTUSD", TBTC: "XBTUSD", "BTC.B": "XBTUSD", BTC: "XBTUSD",
  SOL: "SOLUSD", LINK: "LINKUSD", UNI: "UNIUSD", AAVE: "AAVEUSD", ARB: "ARBUSD", OP: "OPUSD", DOGE: "XDGUSD", XRP: "XRPUSD",
};

/** Only instruments Kraken actually quotes. Anything else has no chart source in v1. */
export const NEW_TRADE_TOPIC = "0x18552bd75bd768d6b943973270f4b4cb69370ade12f8e60e7cd6d5019b13467d"; // NewTrade(uint64,uint64,uint256,uint256)

export function decodeNewTradeData(data: string): [bigint, bigint] {
  const hex = data.replace(/^0x/, "");
  return [BigInt("0x" + hex.slice(0, 64)), BigInt("0x" + hex.slice(64, 128))];
}

/**
 * SpotMatchQuantities: toQuantity @192, fromQuantity @128, toFee @64, fromFee @0.
 * SpotMatchData: buyerIsMaker @224, price @160, buyerOrderId @96, sellerOrderId @32, tradeSeq @0.
 * Verified against live UniFi trades: `from` (@128) is the base leg in the base
 * token's position decimals for both spot and perp matches; `to` is the quote
 * leg for spot and zero for perps. The account's side comes from which indexed
 * topic matched it.
 */
export function decodeNewTrade(quantities: bigint, data: bigint, product: Product, side: "buy" | "sell", _quoteDecimals: number): Omit<FillEvent, "book" | "market" | "block" | "logIndex" | "txHash" | "at"> {
  const baseQuantity = (quantities >> 128n) & MASK64;
  const price = decodePrice((data >> 160n) & MASK64);
  return { symbol: product.symbol, side, price, qty: new BigNumber(baseQuantity.toString()).shiftedBy(-product.positionDecimals).toFixed() };
}

export function krakenPair(symbol: string): string | null {
  const s = symbol.toUpperCase();
  if (KRAKEN_PAIRS[s]) return KRAKEN_PAIRS[s];
  if (s.endsWith("BTC")) return "XBTUSD";
  return null;
}
