import { json, route } from "@/lib/auth.ts";

export const GET = route(async ({ tenant }, request) => {
  const url = new URL(request.url);
  const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase();
  const period = url.searchParams.get("period") ?? "d";
  if (!symbol || !["d", "w", "m"].includes(period)) return json({ error: "symbol and period=d|w|m required" }, 400);
  const [candles, mark] = await Promise.all([
    tenant.adapter.chart(symbol, period as "d" | "w" | "m"),
    tenant.adapter.markPrice(symbol).catch(() => null),
  ]);
  return json({ symbol, period, mark, candles });
});
