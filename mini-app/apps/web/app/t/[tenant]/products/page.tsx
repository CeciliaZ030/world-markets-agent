"use client";

import Link from "next/link";
import { use, useMemo, useState } from "react";
import type { Product } from "@aomi-telegram/core";
import { Shell } from "@/components/Shell.tsx";
import { useApi } from "@/lib/api.ts";
import { openDraft } from "@/lib/tg.ts";
import type { Summary } from "@/lib/summary.ts";

/** Every live book, searchable. Acts open a chat draft; the agent trades, this page never does. */
export default function ProductsPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = use(params);
  const summary = useApi<Summary>(tenant, "/summary");
  const { data, error } = useApi<{ products: Product[] }>(tenant, "/products");
  const [q, setQ] = useState("");
  const bot = summary.data?.botUsername;

  const grouped = useMemo(() => {
    const bySymbol = new Map<string, Product[]>();
    for (const p of data?.products ?? []) {
      if (q && !p.symbol.toLowerCase().includes(q.toLowerCase())) continue;
      bySymbol.set(p.symbol, [...(bySymbol.get(p.symbol) ?? []), p]);
    }
    return [...bySymbol.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [data, q]);

  const draft = (text: string) => bot && openDraft(bot, text);
  return (
    <Shell tenant={tenant} view="products" title={summary.data?.title} tagline={summary.data?.tagline} botUsername={bot}>
      <input placeholder="Search markets" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search markets" />
      {error ? <p className="error">Couldn’t read the catalog: {error}</p> : null}
      {data && grouped.length === 0 ? <div className="empty">No markets match.</div> : null}
      {grouped.map(([symbol, books]) => {
        const has = (kind: string) => books.some((b) => b.product === kind);
        return (
          <div className="row" key={symbol}>
            <div>
              <div>{symbol}</div>
              <div className="muted">{books.map((b) => b.product).join(" · ")}</div>
            </div>
            <div className="acts">
              {has("spot") ? <><button className="ghost" onClick={() => draft(`buy 0.1 ${symbol}`)}>Buy</button><button className="ghost" onClick={() => draft(`sell 0.1 ${symbol}`)}>Sell</button></> : null}
              {has("perp") ? <><button className="ghost" onClick={() => draft(`open long 0.1 ${symbol} perp`)}>Long</button><button className="ghost" onClick={() => draft(`open short 0.1 ${symbol} perp`)}>Short</button></> : null}
              {has("lend") ? <button className="ghost" onClick={() => draft(`lend 0.1 ${symbol}`)}>Lend</button> : null}
              <Link className="btn" href={`/t/${tenant}/chart?symbol=${symbol}&period=d`}>Chart</Link>
            </div>
          </div>
        );
      })}
    </Shell>
  );
}
