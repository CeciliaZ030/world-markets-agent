import type { CommandCtx, CommandReply, TenantCommand } from "@aomi-telegram/core";
import { formatMark } from "./money.ts";
import type { WorldAccount, WorldAdapter } from "./adapter.ts";
import { renderAvailable, renderBalance, renderDollarpower, renderPositions, renderRisk, POSITIONS_BUDGET } from "./lookups.ts";
import type { AccountSnapshot } from "./snapshot.ts";

export const UNMAPPED = "Set up your agent on the World Markets web app first.";

type Lookup = (snapshot: AccountSnapshot) => string;

function webApp(ctx: CommandCtx<WorldAccount>, text: string, view: string, query?: Record<string, string>): { text: string; url: string } {
  return { text, url: ctx.miniAppUrl(view, query) };
}

/** A one-line lookup: bound account → one venue read → one templated line, never a menu. The button is host chrome, never narrated. */
function lookup(adapter: WorldAdapter, name: string, description: string, budget: number, render: Lookup, button?: { text: string; view: string }): TenantCommand<WorldAccount> {
  return {
    name, description, budget,
    async render(ctx: CommandCtx<WorldAccount>): Promise<CommandReply> {
      if (!ctx.account) return { text: UNMAPPED };
      const text = render(await adapter.snapshot(ctx.account));
      return {
        text,
        context: { command: name, accountId: ctx.binding?.accountId ?? null, text },
        ...(button ? { button: webApp(ctx, button.text, button.view) } : {}),
      };
    },
  };
}

export function worldCommands(adapter: WorldAdapter): TenantCommand<WorldAccount>[] {
  const viewPortfolio = { text: "View portfolio", view: "portfolio" };
  return [
    lookup(adapter, "b", "Portfolio balance", 60, renderBalance, viewPortfolio),
    lookup(adapter, "p", "Positions", POSITIONS_BUDGET, renderPositions, viewPortfolio),
    lookup(adapter, "r", "Liquidation risk", 60, renderRisk),
    lookup(adapter, "a", "Available to deploy", 60, renderAvailable),
    lookup(adapter, "d", "Dollarpower", 80, renderDollarpower),
    {
      name: "chart", description: "Chart: /chart WETH [d|w|m]", budget: 120,
      async render(ctx) {
        const symbol = ctx.args[0]?.toUpperCase();
        if (!symbol) return { text: "Which market? Try <code>/chart WETH d</code>." };
        const period = (ctx.args[1]?.toLowerCase() ?? "d")[0];
        if (!period || !"dwm".includes(period)) return { text: "Period is d, w or m. Try <code>/chart WETH w</code>." };
        const [candles, mark] = await Promise.all([
          adapter.chart(symbol, period as "d" | "w" | "m"),
          adapter.markPrice(symbol).catch(() => null),
        ]);
        const button = webApp(ctx, "Open chart", "chart", { symbol, period });
        if (candles.length === 0) return { text: `No chart source for <code>${symbol}</code> yet.`, button, context: { symbol, period, candles: 0 } };
        const text = `<code>${symbol}</code> ${({ d: "day", w: "week", m: "month" } as Record<string, string>)[period]}${mark ? ` · mark <code>${formatMark(mark)}</code>` : ""}`;
        return { text, button, context: { symbol, period, mark, candles: candles.length } };
      },
    },
    {
      name: "tasks", description: "Open the ledger", budget: 120,
      async render(ctx) {
        const button = webApp(ctx, "Open ledger", "ledger");
        return { text: "Your ledger.", button };
      },
    },
  ];
}
