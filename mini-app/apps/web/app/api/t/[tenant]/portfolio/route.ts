import { json, route } from "@/lib/auth.ts";

export const GET = route(async ({ tenant, account, binding }) => {
  if (!account || !binding) return json({ mapped: false });
  const [portfolio, positions, risk] = await Promise.all([
    tenant.adapter.portfolio(account),
    tenant.adapter.positions(account),
    tenant.adapter.riskBand(account),
  ]);
  return json({ mapped: true, portfolio, positions, risk, accountId: binding.accountId });
});
