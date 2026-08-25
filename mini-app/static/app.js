/* global Telegram, LightweightCharts */
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const app = document.getElementById("app");
let sessionToken = "";
let chartHandle = null;
let candleSeries = null;

function haptic(kind, arg) {
  const h = tg && tg.HapticFeedback;
  if (!h) return;
  try {
    if (kind === "impact") h.impactOccurred(arg || "light");
    else if (kind === "notify") h.notificationOccurred(arg);
    else if (kind === "select") h.selectionChanged();
  } catch (_) { /* WebView without haptics */ }
}

function closeChat() {
  haptic("impact", "light");
  if (tg && typeof tg.close === "function") tg.close();
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Presentation only: group the integer part of an API decimal string. */
function usd(raw) {
  if (raw == null || raw === "") return "—";
  const negative = String(raw).charAt(0) === "-";
  const body = negative ? String(raw).slice(1) : String(raw);
  const parts = body.split(".");
  const grouped = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = parts[1];
  const shown = !frac || frac === "00" ? grouped : grouped + "." + frac;
  return (negative ? "−" : "") + "$" + shown;
}

function dash(v) {
  return v == null || v === "" ? "—" : v;
}

function topbar(titleHtml) {
  return `<header class="topbar"><button type="button" class="exit" id="exit" aria-label="Close">×</button><div class="topbar-main">${titleHtml}</div></header>`;
}

function bindExit() {
  const exit = document.getElementById("exit");
  if (exit) exit.addEventListener("click", closeChat);
}

function bindRetry(handler) {
  bindExit();
  const retry = document.getElementById("retry");
  if (retry) retry.addEventListener("click", handler);
}

function retryBlock() {
  return `<div class="actions"><button type="button" id="retry">Retry</button></div>`;
}

function renderLoading() {
  document.body.className = "";
  app.innerHTML = `
    ${topbar("<h1>Portfolio</h1>")}
    <p class="muted">Loading...</p>
    <div class="skel"></div>
    <div class="skel" style="width:72%"></div>
    <div class="skel" style="width:88%"></div>
  `;
  bindExit();
}

function renderError() {
  haptic("notify", "error");
  document.body.className = "";
  app.innerHTML = `
    ${topbar('<h1 class="error">Portfolio</h1>')}
    <div class="center">
      <p>Could not load portfolio</p>
      <p class="sub">Try again or check back later.</p>
    </div>
    ${retryBlock()}
  `;
  bindRetry(() => boot());
}

function renderUnauthorized() {
  document.body.className = "";
  app.innerHTML = `
    ${topbar("<h1>Portfolio</h1>")}
    <div class="center">
      <p>Session expired. Open from the bot again.</p>
    </div>
  `;
  bindExit();
}

function renderEmpty() {
  haptic("impact", "light");
  document.body.className = "";
  app.innerHTML = `
    ${topbar("<h1>Portfolio</h1>")}
    <div class="center">
      <p>No open positions.</p>
      <p class="sub">Your portfolio is empty.</p>
    </div>
  `;
  bindExit();
}

function changeCell(p) {
  if (p.change_24h_pct == null) return `<td class="chg num">—</td>`;
  const dir = p.change_direction;
  const cls = dir === "up" ? "up" : dir === "down" ? "down" : "";
  const mark = dir === "up" ? "▲ " : dir === "down" ? "▼ " : "";
  return `<td class="chg num ${cls}">${mark}${escapeHtml(p.change_24h_pct)}%</td>`;
}

function renderLoaded(data) {
  haptic("impact", "light");
  document.body.className = "";
  const est = data.dollarpower && data.dollarpower.is_estimate;
  const approx = est ? "≈ " : "";
  const dp = data.dollarpower;
  const risk = data.risk;
  const fill = dp && dp.fill_pct != null ? dp.fill_pct : "0";
  const ratio = Number(dp && dp.ratio);
  if (Number.isFinite(ratio) && ratio < 2) haptic("notify", "warning");

  const rows = (data.positions || [])
    .map(
      (p) => `
      <tr class="pos">
        <td class="sym">${escapeHtml(p.symbol)}</td>
        <td class="qty num">${escapeHtml(p.quantity)}</td>
        <td class="usd num">${usd(p.usd_value)}</td>
        ${changeCell(p)}
        <td class="lev num">${p.leverage == null ? "—" : escapeHtml(p.leverage) + "×"}</td>
      </tr>`
    )
    .join("");

  const headerChg =
    data.total_change_24h_pct == null
      ? "—"
      : (Number(data.total_change_24h_pct) < 0 ? "▼ " : "▲ ") +
        escapeHtml(data.total_change_24h_pct) +
        "%";

  const score = risk && risk.liquidation_score;
  const distance =
    score != null && score < 9 && risk.distance_from_floor_pct != null
      ? `<div class="distance num">Liquidation distance: ${escapeHtml(
          risk.distance_from_floor_pct
        )}% from floor</div>`
      : score != null && score >= 9
        ? `<div class="distance high">Near liquidation.</div>`
        : "";

  const riskEst = risk && risk.is_estimate ? "≈ " : "";

  app.innerHTML = `
    ${topbar("<h1>Portfolio</h1>")}
    <div class="pos-head"><span>Positions</span><span class="num">${headerChg}</span></div>
    <table><tbody>${rows}</tbody></table>
    <section class="block">
      <div class="label">Dollarpower</div>
      <div class="dp-top">
        <div class="bar"><span style="width:${escapeHtml(fill)}%"></span></div>
        <span class="dp-ratio num">${approx}${escapeHtml(dp.ratio)}×</span>
      </div>
      <div class="dp-dollars num">${approx}${usd(dp.equivalent_usd)} eq. / ${approx}${usd(dp.committed_usd)} committed</div>
    </section>
    <section class="block">
      <div class="label">Risk</div>
      <div class="risk-row">
        <span class="dot ${escapeHtml(risk.band)}"></span>
        <span class="${escapeHtml(risk.band)}">${riskEst}${escapeHtml(risk.band)}</span>
      </div>
      ${distance}
    </section>
  `;
  bindExit();
  app.querySelectorAll("tr.pos").forEach((row) => {
    row.addEventListener("click", () => haptic("select"));
  });
}

/** Localhost layout fixture only. Live numbers never come from this object. */
const PREVIEW_LOADED = {
  positions: [
    {
      symbol: "ETH",
      quantity: "2.35",
      usd_value: "8432.50",
      change_24h_pct: "3.1",
      leverage: "1.2",
      change_direction: "up",
      asset_type: "spot",
    },
    {
      symbol: "USDC",
      quantity: "12800",
      usd_value: "12800.00",
      change_24h_pct: null,
      leverage: null,
      change_direction: null,
      asset_type: "spot",
    },
    {
      symbol: "wstETH",
      quantity: "4.0",
      usd_value: "6100.00",
      change_24h_pct: "0.8",
      leverage: "1.0",
      change_direction: "up",
      asset_type: "spot",
    },
  ],
  dollarpower: {
    ratio: "6.8",
    equivalent_usd: "43100.00",
    committed_usd: "6338.00",
    fill_pct: "15",
    is_estimate: false,
  },
  risk: {
    liquidation_score: 3,
    band: "safe",
    distance_from_floor_pct: "47",
    is_estimate: false,
  },
  total_usd_value: "27332.50",
  total_change_24h_pct: "1.8",
};

function previewCandles() {
  const out = [];
  let p = 100;
  const end = Math.floor(Date.now() / 1000);
  for (let i = 0; i < 48; i++) {
    const o = p;
    const c = o * (1 + Math.sin(i / 6) * 0.01 + (i % 5 === 0 ? -0.012 : 0.006));
    out.push({
      t: end - (47 - i) * 300,
      o,
      h: Math.max(o, c) * 1.004,
      l: Math.min(o, c) * 0.996,
      c,
    });
    p = c;
  }
  return {
    symbol: "AAPL",
    feed_symbol: "AAPL",
    period: "d",
    period_label: "1D",
    bar_label: "5M",
    source: "preview",
    candles: out,
  };
}

function previewState() {
  if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
    return null;
  }
  return new URLSearchParams(location.search).get("preview");
}

function parseStartapp(raw) {
  const m = String(raw || "").trim().match(/^(.+)_([dwm])$/i);
  if (!m) return null;
  return { symbol: m[1], period: m[2].toLowerCase() };
}

function chartParams() {
  const q = new URLSearchParams(location.search);
  let symbol = q.get("symbol");
  let period = (q.get("period") || "").toLowerCase();
  const start =
    (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) ||
    q.get("startapp") ||
    "";
  if (!symbol) {
    const parsed = parseStartapp(start);
    if (parsed) {
      symbol = parsed.symbol;
      period = period || parsed.period;
    }
  }
  const onChart =
    location.pathname === "/chart" ||
    location.pathname.endsWith("/chart") ||
    !!symbol;
  if (!onChart) return null;
  if (!symbol) symbol = "AAPL";
  if (period !== "d" && period !== "w" && period !== "m") period = "d";
  return { symbol, period };
}

function destroyChart() {
  if (chartHandle) {
    chartHandle.remove();
    chartHandle = null;
    candleSeries = null;
  }
}

function fmtChartPrice(v) {
  if (!Number.isFinite(v)) return "—";
  const d = Math.abs(v) >= 1000 ? 1 : Math.abs(v) >= 10 ? 2 : 4;
  return (
    "$" +
    v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })
  );
}

function mountCandles(el, bars) {
  destroyChart();
  const LC = window.LightweightCharts;
  if (!LC || !el) return false;
  chartHandle = LC.createChart(el, {
    layout: {
      background: { color: "#070605" },
      textColor: "rgba(255,252,245,0.55)",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
    grid: {
      vertLines: { color: "rgba(255,252,245,0.06)" },
      horzLines: { color: "rgba(255,252,245,0.06)" },
    },
    rightPriceScale: { borderColor: "rgba(255,252,245,0.12)" },
    timeScale: {
      borderColor: "rgba(255,252,245,0.12)",
      timeVisible: true,
      secondsVisible: false,
    },
    crosshair: { mode: LC.CrosshairMode.Normal },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
    handleScale: { axisPressedMouseMove: true, pinch: true, mouseWheel: true },
  });
  candleSeries = chartHandle.addCandlestickSeries({
    upColor: "#22E08A",
    downColor: "#FF4D4D",
    wickUpColor: "#22E08A",
    wickDownColor: "#FF4D4D",
    borderVisible: false,
  });
  const data = bars
    .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.o))
    .map((b) => ({
      time: b.t,
      open: b.o,
      high: b.h,
      low: b.l,
      close: b.c,
    }));
  candleSeries.setData(data);
  chartHandle.timeScale().fitContent();
  const ro = new ResizeObserver(() => {
    if (!chartHandle) return;
    chartHandle.applyOptions({
      width: el.clientWidth,
      height: el.clientHeight,
    });
  });
  ro.observe(el);
  chartHandle.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  return true;
}

function renderChartShell(params, status, data) {
  document.body.className = "page-chart";
  document.title = params.symbol + " · World Markets";
  const last = data && data.candles && data.candles.length
    ? data.candles[data.candles.length - 1]
    : null;
  const first = data && data.candles && data.candles[0];
  const up = last && first ? last.c >= first.o : true;
  const px = last ? fmtChartPrice(last.c) : "—";
  const sub = data
    ? `${escapeHtml(data.period_label)} · ${escapeHtml(data.bar_label)} bars · pinch to zoom`
    : "Loading…";
  const periods = ["d", "w", "m"]
    .map((p) => {
      const label = p === "d" ? "1D" : p === "w" ? "1W" : "1M";
      const on = params.period === p ? " active" : "";
      return `<button type="button" class="${on}" data-period="${p}">${label}</button>`;
    })
    .join("");
  let body = "";
  if (status === "loading") {
    body = `<p class="chart-sub">Loading…</p><div class="skel"></div>`;
  } else if (status === "error") {
    body = `<div class="center"><p>Could not load chart</p><p class="sub">Try another period or open from the bot again.</p></div>${retryBlock()}`;
  } else if (status === "empty") {
    body = `<div class="center"><p>No bars for ${escapeHtml(params.symbol)}.</p></div>`;
  } else {
    body = `<div id="plot"></div>`;
  }
  app.innerHTML = `
    ${topbar(`<h1>${escapeHtml(params.symbol)}</h1>`)}
    <div class="chart-page">
      <div class="chart-meta">
        <span class="chart-sym">${escapeHtml(params.symbol)}</span>
        <span class="chart-px num ${up ? "up" : "down"}">${px}</span>
      </div>
      <div class="chart-sub">${sub}</div>
      <div class="periods">${periods}</div>
      ${body}
    </div>
  `;
  bindExit();
  app.querySelectorAll("[data-period]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.getAttribute("data-period");
      if (!next || next === params.period) return;
      haptic("select");
      const url = new URL(location.href);
      url.pathname = "/chart";
      url.searchParams.set("symbol", params.symbol);
      url.searchParams.set("period", next);
      history.replaceState({}, "", url);
      loadChartView({ symbol: params.symbol, period: next });
    });
  });
  if (status === "error") {
    bindRetry(() => loadChartView(params));
  }
  if (status === "ready") {
    const plot = document.getElementById("plot");
    if (!mountCandles(plot, data.candles)) {
      plot.innerHTML = `<div class="center"><p>Chart library failed to load.</p></div>`;
    }
  }
}

async function ensureSession(initData) {
  if (sessionToken) return sessionToken;
  const authRes = await fetch("/api/v1/mini-app/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ init_data: initData }),
  });
  if (authRes.status === 401) throw new Error("unauthorized");
  if (!authRes.ok) throw new Error("auth");
  const auth = await authRes.json();
  sessionToken = auth.token;
  return sessionToken;
}

async function loadChartView(params) {
  const preview = previewState();
  if (preview === "chart") {
    renderChartShell(params, "ready", previewCandles());
    return;
  }
  renderChartShell(params, "loading", null);
  const initData = (tg && tg.initData) || (preview === "dev" ? "dev" : "");
  try {
    const token = await ensureSession(initData);
    const res = await fetch(
      "/api/v1/mini-app/chart?symbol=" +
        encodeURIComponent(params.symbol) +
        "&period=" +
        encodeURIComponent(params.period),
      { headers: { Authorization: "Bearer " + token } }
    );
    if (res.status === 401) return renderUnauthorized();
    if (res.status === 404) {
      renderChartShell(params, "empty", null);
      return;
    }
    if (!res.ok) {
      renderChartShell(params, "error", null);
      return;
    }
    const data = await res.json();
    if (!data.candles || data.candles.length === 0) {
      renderChartShell(params, "empty", data);
      return;
    }
    params.symbol = data.symbol || params.symbol;
    renderChartShell(params, "ready", data);
  } catch (err) {
    if (err && err.message === "unauthorized") return renderUnauthorized();
    renderChartShell(params, "error", null);
  }
}

async function boot() {
  const preview = previewState();
  const chart = chartParams();
  if (preview === "chart" || chart) {
    return loadChartView(chart || { symbol: "AAPL", period: "d" });
  }
  if (preview === "unauthorized") return renderUnauthorized();
  if (preview === "error") return renderError();
  if (preview === "empty") return renderEmpty();
  if (preview === "loading") return renderLoading();
  if (preview === "loaded") return renderLoaded(PREVIEW_LOADED);

  renderLoading();
  const initData = (tg && tg.initData) || (preview === "dev" ? "dev" : "");
  try {
    const token = await ensureSession(initData);
    const portRes = await fetch("/api/v1/mini-app/portfolio", {
      headers: { Authorization: "Bearer " + token },
    });
    if (portRes.status === 401) return renderUnauthorized();
    if (!portRes.ok) return renderError();
    const data = await portRes.json();
    if (!data.positions || data.positions.length === 0) return renderEmpty();
    renderLoaded(data);
  } catch (err) {
    if (err && err.message === "unauthorized") return renderUnauthorized();
    renderError();
  }
}

boot();
