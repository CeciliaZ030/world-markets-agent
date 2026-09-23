import { json, route } from "@/lib/auth.ts";

const NINETY_DAYS = 90 * 24 * 3600 * 1000;

/** Direct venue reads only; Vercel owns no scheduler or local index. */
export const GET = route(async ({ tenant, account, binding }) => {
  if (!account || !binding) return json({ mapped: false });
  const since = new Date(Date.now() - NINETY_DAYS);
  const [open, fills] = await Promise.all([
    tenant.adapter.openOrders(account),
    tenant.adapter.fills(account, since),
  ]);
  return json({
    mapped: true,
    open,
    fills,
  });
});
