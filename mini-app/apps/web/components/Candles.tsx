import BigNumber from "bignumber.js";
import type { Candle } from "@aomi-telegram/core";

/** Plain SVG candlesticks. One scale, labels at the extremes, no library. */
export function Candles({ candles, mark }: { candles: Candle[]; mark: string | null }) {
  if (candles.length === 0) return <div className="empty">No candles for this market.</div>;
  const W = 640, H = 260, padL = 8, padR = 64, padT = 10, padB = 18;
  const highs = candles.map((c) => Number(c.h)), lows = candles.map((c) => Number(c.l));
  const max = Math.max(...highs, mark ? Number(mark) : -Infinity), min = Math.min(...lows, mark ? Number(mark) : Infinity);
  const span = max - min || 1;
  const y = (v: number) => padT + ((max - v) / span) * (H - padT - padB);
  const step = (W - padL - padR) / candles.length;
  const bw = Math.max(1.5, step * 0.6);
  const fmt = (v: number) => new BigNumber(v).toFormat(v >= 100 ? 0 : 2);
  return (
    <svg className="candles" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Price candles">
      <title>Price candles</title>
      {candles.map((c, i) => {
        const x = padL + i * step + step / 2;
        const o = Number(c.o), cl = Number(c.c);
        const up = cl >= o;
        const color = up ? "var(--good)" : "var(--bad)";
        return (
          <g key={c.t}>
            <line x1={x} x2={x} y1={y(Number(c.h))} y2={y(Number(c.l))} stroke={color} strokeWidth="1" />
            <rect x={x - bw / 2} y={y(Math.max(o, cl))} width={bw} height={Math.max(1, Math.abs(y(o) - y(cl)))} fill={color} />
          </g>
        );
      })}
      {mark ? <line x1={padL} x2={W - padR} y1={y(Number(mark))} y2={y(Number(mark))} stroke="var(--ink2)" strokeDasharray="3 3" strokeWidth="0.75" /> : null}
      <text x={W - padR + 6} y={y(max) + 4} fontSize="11" fill="var(--ink2)" fontFamily="var(--mono)">{fmt(max)}</text>
      <text x={W - padR + 6} y={y(min) + 4} fontSize="11" fill="var(--ink2)" fontFamily="var(--mono)">{fmt(min)}</text>
      {mark ? <text x={W - padR + 6} y={y(Number(mark)) + 4} fontSize="11" fill="var(--ink)" fontFamily="var(--mono)">{fmt(Number(mark))}</text> : null}
    </svg>
  );
}
