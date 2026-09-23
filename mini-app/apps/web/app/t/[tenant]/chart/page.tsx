"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, use } from "react";
import type { Candle } from "@aomi-telegram/core";
import { Candles } from "@/components/Candles.tsx";
import { Shell } from "@/components/Shell.tsx";
import { useApi } from "@/lib/api.ts";
import { money } from "@/lib/format.ts";
import type { Summary } from "@/lib/summary.ts";

export default function ChartPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = use(params);
  return <Suspense><ChartInner tenant={tenant} /></Suspense>;
}

function ChartInner({ tenant }: { tenant: string }) {
  const search = useSearchParams();
  const symbol = (search.get("symbol") ?? "WETH").toUpperCase();
  const period = search.get("period") ?? "d";
  const summary = useApi<Summary>(tenant, "/summary");
  const { data, error } = useApi<{ symbol: string; period: string; mark: string | null; candles: Candle[] }>(tenant, `/chart?symbol=${symbol}&period=${period}`);
  return (
    <Shell tenant={tenant} view="products" title={summary.data?.title} tagline={summary.data?.tagline} botUsername={summary.data?.botUsername}>
      <div className="row">
        <div><strong>{symbol}</strong> <span className="muted num">{data?.mark ? `mark ${money(data.mark)}` : ""}</span></div>
        <nav className="tabs" aria-label="Period">
          {(["d", "w", "m"] as const).map((p) => <Link key={p} className={p === period ? "on" : ""} href={`/t/${tenant}/chart?symbol=${symbol}&period=${p}`}>{p}</Link>)}
        </nav>
      </div>
      {error ? <p className="error">Couldn’t load the chart: {error}</p> : null}
      {data ? <Candles candles={data.candles} mark={data.mark} /> : <div className="empty">Loading…</div>}
      <p className="muted">candles from an off-venue spot feed · the mark line is the venue’s</p>
    </Shell>
  );
}
