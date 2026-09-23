import type { Portfolio, Tenant } from "@aomi-telegram/core";
import type { Authorized } from "./auth.ts";

export interface Summary {
  mapped: boolean;
  tenant: string;
  botUsername: string;
  title: string;
  tagline: string;
  quote?: string;
  portfolio?: Portfolio;
  risk?: { score: number; band: string };
}

/** What the compact launch shows: the headline figures and what changed since the last visit. */
export async function buildSummary<A>(auth: Authorized<A>): Promise<Summary> {
  const { tenant, botUsername, binding, account } = auth;
  const base = { mapped: binding !== null, tenant: tenant.id, botUsername, title: tenant.copy.title, tagline: tenant.copy.tagline };
  if (!binding || !account) return base;
  const adapter = (tenant as Tenant<A>).adapter;
  const [portfolio, risk] = await Promise.all([
    adapter.portfolio(account),
    adapter.riskBand(account),
  ]);
  return {
    ...base,
    quote: portfolio.quote,
    portfolio,
    risk,
  };
}
