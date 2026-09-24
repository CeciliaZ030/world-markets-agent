"use client";

import Link from "next/link";
import { use } from "react";
import { Shell } from "@/components/Shell.tsx";
import { Unmapped } from "@/components/Unmapped.tsx";
import { useApi } from "@/lib/api.ts";
import { money } from "@/lib/format.ts";
import type { Summary } from "@/lib/summary.ts";

/** Compact launch: the headline figures and what changed since the last look. Drag up for the ledger. */
export default function Home({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = use(params);
  const { data, error, reload } = useApi<Summary>(tenant, "/summary");
  return (
    <Shell tenant={tenant} view="" title={data?.title} tagline={data?.tagline} botUsername={data?.botUsername}>
      {!data && !error ? <p role="status">Loading your World account…</p> : null}
      {error ? <p className="error">Couldn’t load your account: {error} <button onClick={reload}>Retry</button></p> : null}
      {data && !data.mapped ? <Unmapped title={data.title} /> : null}
      {data?.mapped && data.portfolio ? (
        <>
          <div className="card">
            <div className="kicker">Portfolio</div>
            <div className="big">{money(data.portfolio.nav)}</div>
            <div className="muted">
              risk <span className={`pill ${data.risk?.band ?? ""}`}>{data.risk ? `${data.risk.score.toFixed(1)}/10 ${data.risk.band}` : "—"}</span>
            </div>
          </div>
          <div className="acts">
            <Link className="btn primary" href={`/t/${tenant}/ledger`}>Ledger</Link>
            <Link className="btn" href={`/t/${tenant}/portfolio`}>portfolio ↗</Link>
          </div>
        </>
      ) : null}
    </Shell>
  );
}
