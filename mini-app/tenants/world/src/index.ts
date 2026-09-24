import type { Tenant } from "@aomi-telegram/core";
import { WorldAdapter, type WorldAccount } from "./adapter.ts";
import { UNMAPPED, worldCommands } from "./commands.ts";
import { WorldVenue, type Venue } from "./venue.ts";

export { WorldAdapter, WorldVenue, type WorldAccount, type Venue };
export * from "./snapshot.ts";
export * from "./lookups.ts";
export * from "./money.ts";

export const WORLD_DEFAULTS = {
  rpcUrl: "https://testnet-unifi-rpc.puffer.fi/",
  exchangeAddress: "0xf6b54e033bb45a583aa642924bcef78b804588ae",
  chainId: 2092151908,
};

/** Build the World tenant over any venue. Production uses the SDK-backed venue from env. */
export function worldTenant(venue: Venue): Tenant<WorldAccount> {
  const adapter = new WorldAdapter(venue);
  return {
    id: "world",
    adapter,
    commands: worldCommands(adapter),
    watches: [
      { kind: "price_cross", description: "Mark price crosses a level" },
      { kind: "risk_band", description: "Liquidation risk enters a band" },
    ],
    copy: {
      unmapped: UNMAPPED,
      renderFailed: "Couldn’t read your World account just now. Try again in a moment.",
      title: "World Markets",
      tagline: "say the word",
    },
    compose: {
      buy: (symbol) => `buy 0.1 ${symbol}`,
      sell: (symbol) => `sell 0.1 ${symbol}`,
      long: (symbol) => `open long 0.1 ${symbol} perp`,
      short: (symbol) => `open short 0.1 ${symbol} perp`,
      lend: (symbol) => `lend 0.1 ${symbol}`,
      cancelOrder: (order) => `cancel ${order.market} ${order.side} order ${order.id} on ${order.symbol}`,
    },
  };
}

export function worldFromEnv(env: NodeJS.ProcessEnv = process.env): Tenant<WorldAccount> {
  return worldTenant(new WorldVenue({
    rpcUrl: env.WORLD_RPC_URL ?? WORLD_DEFAULTS.rpcUrl,
    exchangeAddress: env.WORLD_EXCHANGE_ADDRESS ?? WORLD_DEFAULTS.exchangeAddress,
    chainId: Number(env.WORLD_CHAIN_ID ?? WORLD_DEFAULTS.chainId),
    // A local fork proxies every state read upstream; a longer cache keeps lookups usable there.
    ...(env.WORLD_CACHE_SECONDS ? { cacheSeconds: Number(env.WORLD_CACHE_SECONDS) } : {}),
  }));
}

/** Default World deployment. Reads env lazily so tests can build tenants over fakes. */
export const world: Tenant<WorldAccount> = worldFromEnv();
