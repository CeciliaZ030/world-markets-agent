"use client";

import { use } from "react";
import type { Fill, Order } from "@aomi-telegram/core";
import { Shell } from "@/components/Shell.tsx";
import { Unmapped } from "@/components/Unmapped.tsx";
import { useApi } from "@/lib/api.ts";
import { ago, money, qty } from "@/lib/format.ts";
import { openDraft } from "@/lib/tg.ts";
import type { Summary } from "@/lib/summary.ts";

interface Ledger { mapped: boolean; open: Order[]; fills: Fill[] }

/** OPEN and DONE are read directly from the venue. Nothing here signs or executes. */
export default function LedgerPage({ params }: { params: Promise<{ tenant: string }> }) {
  const { tenant } = use(params);
  const summary = useApi<Summary>(tenant, "/summary");
  const ledger = useApi<Ledger>(tenant, "/ledger");
  const bot = summary.data?.botUsername;
  const d = ledger.data;
  return (
    <Shell tenant={tenant} view="ledger" title={summary.data?.title} tagline={summary.data?.tagline} botUsername={bot}>
      {ledger.error ? <p className="error">Couldn’t read the ledger: {ledger.error}</p> : null}
      {d && !d.mapped ? <Unmapped title={summary.data?.title ?? "partner"} /> : null}
      {d?.mapped ? (
        <>
          <h2>Open {d.open.length ? `· ${d.open.length}` : ""}</h2>
          {d.open.length === 0 ? <div className="empty">No resting orders.</div> : null}
          {d.open.map((o) => (
            <div className="row" key={`${o.market}-${o.side}-${o.id}`}>
              <div>
                <div>{o.symbol} {o.market} {o.side}</div>
                <div className="muted num">{qty(o.qty)} @ {money(o.price)} · {o.kind.replace(/_/g, " ")}</div>
              </div>
              {bot ? <button className="ghost" onClick={() => openDraft(bot, cancelText(summary.data, o))}>Cancel in chat</button> : null}
            </div>
          ))}

          <h2>Done</h2>
          {d.fills.length === 0 ? <div className="empty">No fills in the last 90 days.</div> : null}
          {d.fills.map((f, i) => (
            <div className="row" key={`fill-${i}`}><div>{f.symbol} {f.side} <span className="num">{qty(f.qty)} @ {money(f.price)}</span></div><span className="muted">{ago(f.at)}</span></div>
          ))}
        </>
      ) : null}
    </Shell>
  );
}

/** The cancel draft text is tenant copy, but the page only knows the summary; keep it generic and readable. */
function cancelText(_summary: Summary | null, o: Order): string {
  return `cancel ${o.market} ${o.side} order ${o.id} on ${o.symbol}`;
}
