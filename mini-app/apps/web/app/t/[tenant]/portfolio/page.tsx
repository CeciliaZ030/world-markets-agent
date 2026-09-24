"use client";

import Link from "next/link";
import { use } from "react";
import type { Portfolio, Positions } from "@aomi-telegram/core";
import { Shell } from "@/components/Shell.tsx";
import { Unmapped } from "@/components/Unmapped.tsx";
import { useApi } from "@/lib/api.ts";
import { money, qty } from "@/lib/format.ts";
import type { Summary } from "@/lib/summary.ts";

interface PortfolioView { mapped: boolean; portfolio: Portfolio; positions: Positions; risk: { score: number; band: string }; accountId: string }

/** Fixed class order, never ranked across classes: Holdings, Perps, Lent, Borrowed. */
export default function PortfolioPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = use(params);
  const summary = useApi<Summary>(tenant, "/summary");
  const { data, error, reload } = useApi<PortfolioView>(tenant, "/portfolio");
  return (
    <Shell tenant={tenant} view="portfolio" title={summary.data?.title} tagline={summary.data?.tagline} botUsername={summary.data?.botUsername}>
      {!data && !error ? <p role="status">Loading your World account…</p> : null}
      {error ? <p className="error">Couldn’t load your account: {error} <button onClick={reload}>Retry</button></p> : null}
      {data && !data.mapped ? <Unmapped title={summary.data?.title ?? "partner"} /> : null}
      {data?.mapped ? (
        <>
          <div className="card">
            <div className="kicker">Portfolio · account {data.accountId}</div>
            <div className="big">{money(data.portfolio.nav)}</div>
            <div className="muted">
              risk-adjusted {money(data.portfolio.rapv)} · risk <span className={`pill ${data.risk.band}`}>{data.risk.score.toFixed(1)}/10 {data.risk.band}</span>
              {data.portfolio.eligibleForLiquidation ? <span className="pill liquidation"> eligible for liquidation</span> : null}
            </div>
          </div>
          <h2>Holdings ◆</h2>
          {data.positions.holdings.length === 0 ? <div className="empty">No holdings.</div> : data.positions.holdings.map((h) => (
            <div className="row" key={h.symbol}><span>{h.symbol}</span><span className="num">{qty(h.balance)}{h.available !== h.balance ? <span className="muted"> · {qty(h.available)} free</span> : null}</span></div>
          ))}
          <h2>Perps ◇</h2>
          {data.positions.perps.length === 0 ? <div className="empty">No perps.</div> : data.positions.perps.map((p) => (
            <div className="row" key={p.symbol}>
              <div><Link href={`/t/${tenant}/chart?symbol=${p.symbol}&period=d`}>{p.symbol} {p.side}</Link><div className="muted num">entry {money(p.entry)} · mark {p.mark ? money(p.mark) : "—"}</div></div>
              <span className="num">{qty(p.qty)}</span>
            </div>
          ))}
          <h2>Lent ◈</h2>
          {data.positions.lent.length === 0 ? <div className="empty">Nothing lent.</div> : data.positions.lent.map((l) => (
            <div className="row" key={l.symbol}><span>{l.symbol}</span><span className="num">{qty(l.qty)}</span></div>
          ))}
          <h2>Borrowed ◈</h2>
          {data.positions.borrowed.length === 0 ? <div className="empty">Nothing borrowed.</div> : data.positions.borrowed.map((l) => (
            <div className="row" key={l.symbol}><span>{l.symbol}</span><span className="num">{qty(l.qty)}</span></div>
          ))}
          <p className="muted">marked at current prices · portfolio value is after debt and margin</p>
        </>
      ) : null}
    </Shell>
  );
}
