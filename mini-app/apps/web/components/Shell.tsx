"use client";

import Link from "next/link";
import { WorldLogo } from "./WorldLogo.tsx";
import { useEffect } from "react";
import { tg } from "@/lib/tg.ts";

const TABS: [string, string][] = [["", "Home"], ["ledger", "Ledger"], ["portfolio", "Portfolio"], ["products", "Products"]];

export function Shell({ tenant, view, title, tagline, botUsername, children }: { tenant: string; view: string; title?: string | undefined; tagline?: string | undefined; botUsername?: string | null | undefined; children: React.ReactNode }) {
  useEffect(() => {
    const app = tg();
    app?.ready();
    app?.expand();
  }, []);
  return (
    <main className={tenant === "world" ? "world-shell" : undefined}>
      <header className="shell-header">
        {tenant === "world" ? <WorldLogo aria-hidden="true" /> : null}
        <div>
          <h1>{title ?? (tenant === "world" ? "World Markets" : "…")}</h1>
          {tagline ? <div className="tag">{tagline}</div> : null}
        </div>
      </header>
      <nav className="tabs" aria-label="Views">
        {TABS.map(([slug, label]) => (
          <Link key={slug} href={`/t/${tenant}${slug ? `/${slug}` : ""}`} className={view === slug ? "on" : ""} aria-current={view === slug ? "page" : undefined}>{label}</Link>
        ))}
      </nav>
      <div className="shell-content">{children}</div>
      <div className="bottom">
        {botUsername ? <a href={`https://t.me/${botUsername}`}>↩ Back to chat — say the word there</a> : <span className="muted">↩ Back to chat</span>}
      </div>
    </main>
  );
}
