import BigNumber from "bignumber.js";
import { escapeHtml, visibleLength } from "@aomi-telegram/core";
import { formatMoney, formatRatio, formatRisk } from "./money.ts";
import { dollarpower, notional, riskBand, type AccountSnapshot, type TokenLine } from "./snapshot.ts";

/** The partner's one-line lookups, rendered as Telegram HTML. Every figure is a <code> entity. */
export const LEFT_OUT = "I’ve left it out rather than guess.";
const TOP_N = 3;
export const POSITIONS_BUDGET = 180;

const code = (s: string) => `<code>${escapeHtml(s)}</code>`;

export function renderBalance(s: AccountSnapshot): string {
  return `Portfolio ${code(formatMoney(s.nav))}.`;
}

export function renderRisk(s: AccountSnapshot): string {
  const eligible = s.rapv.lt(0);
  const band = riskBand(s.riskScore, eligible);
  const figure = code(`${formatRisk(s.riskScore)}/10.`);
  if (band === "liquidation") return `Eligible for liquidation — liquidation risk ${figure}`;
  if (band === "high") return `Liquidation risk ${figure} — high.`;
  return `Liquidation risk ${figure}`;
}

export function renderAvailable(s: AccountSnapshot): string {
  return `Available to deploy ${code(formatMoney(s.cashAvailable))}.`;
}

export function renderDollarpower(s: AccountSnapshot): string {
  const d = dollarpower(s);
  return `Dollarpower ${code(`${formatRatio(d.ratio)}`)}× — your ${code(formatMoney(d.committed))} is doing the work of ${code(formatMoney(d.equivalent, d.isEstimate))}.`;
}

interface ClassRow { label: string; notional: BigNumber }

function rows(lines: TokenLine[], label: (line: TokenLine) => string): ClassRow[] {
  return lines
    .filter((line) => !line.quantity.isZero())
    .flatMap((line) => {
      const n = notional(line);
      return n ? [{ label: label(line), notional: n }] : [];
    })
    .sort((a, b) => b.notional.comparedTo(a.notional) ?? 0);
}

function classLine(label: string, glyph: string, all: ClassRow[]): string | null {
  if (all.length === 0) return null;
  const shown = all.slice(0, TOP_N).map((r) => code(`${r.label} ${formatMoney(r.notional)}`)).join(" · ");
  const rest = all.length > TOP_N ? ` +${all.length - TOP_N}` : "";
  return `<b>${label}</b> ${glyph} ${shown}${rest}`;
}

/** Fixed class order, never ranked across classes, later classes dropped whole to stay in budget. */
export function renderPositions(s: AccountSnapshot): string {
  const holdings = rows(s.holdings, (l) => l.symbol);
  const perps = rows(s.perps, (l) => `${l.symbol} ${(l as { side?: string }).side ?? ""}`.trim());
  const lent = rows(s.lent, (l) => l.symbol);
  const borrowed = rows(s.borrowed, (l) => l.symbol);
  const parts = [
    classLine("Holdings", "◆", holdings),
    classLine("Perps", "◇", perps),
    classLine("Lent", "◈", lent),
    classLine("Borrowed", "◈", borrowed),
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) {
    const cash = s.holdings.find((h) => h.symbol === s.quote)?.quantity ?? new BigNumber(0);
    return `No open positions. Cash ${code(formatMoney(cash))}.`;
  }
  const kept: string[] = [];
  for (const part of parts) {
    const candidate = [...kept, part].join(" · ");
    if (visibleLength(candidate) <= POSITIONS_BUDGET || kept.length === 0) kept.push(part);
    else break;
  }
  return kept.join(" · ");
}
