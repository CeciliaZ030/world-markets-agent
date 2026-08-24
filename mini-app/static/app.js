/* global Telegram */
const tg = window.Telegram && window.Telegram.WebApp;
if (tg) {
  tg.ready();
  tg.expand();
}

const app = document.getElementById("app");

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

function backRow(extra) {
  const retry = extra
    ? `<button type="button" id="retry">Retry</button>`
    : "";
  return `<div class="actions">${retry}<button type="button" class="${extra ? "secondary" : ""}" id="back">⟵ Back to chat</button></div>`;
}

function bindChrome() {
  const back = document.getElementById("back");
  if (back) back.addEventListener("click", closeChat);
  const retry = document.getElementById("retry");
  if (retry) retry.addEventListener("click", () => boot());
}

function renderLoading() {
  app.innerHTML = `
    <h1>Portfolio</h1>
    <p class="muted">Loading...</p>
    <div class="skel"></div>
    <div class="skel" style="width:72%"></div>
    <div class="skel" style="width:88%"></div>
    ${backRow(false)}
  `;
  bindChrome();
}

function renderError() {
  haptic("notify", "error");
  app.innerHTML = `
    <h1 class="error">Portfolio</h1>
    <div class="center">
      <p>Could not load portfolio</p>
      <p class="sub">Try again or check back later.</p>
    </div>
    ${backRow(true)}
  `;
  bindChrome();
}

function renderUnauthorized() {
  app.innerHTML = `
    <h1>Portfolio</h1>
    <div class="center">
      <p>Session expired. Open from the bot again.</p>
    </div>
    ${backRow(false)}
  `;
  bindChrome();
}

function renderEmpty() {
  haptic("impact", "light");
  app.innerHTML = `
    <h1>Portfolio</h1>
    <div class="center">
      <p>No open positions.</p>
      <p class="sub">Your portfolio is empty.</p>
    </div>
    ${backRow(false)}
  `;
  bindChrome();
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
    <h1>Portfolio</h1>
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
    ${backRow(false)}
  `;
  bindChrome();
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

function previewState() {
  if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") {
    return null;
  }
  return new URLSearchParams(location.search).get("preview");
}

async function boot() {
  const preview = previewState();
  if (preview === "unauthorized") return renderUnauthorized();
  if (preview === "error") return renderError();
  if (preview === "empty") return renderEmpty();
  if (preview === "loading") return renderLoading();
  if (preview === "loaded") return renderLoaded(PREVIEW_LOADED);

  renderLoading();
  const initData = (tg && tg.initData) || (preview === "dev" ? "dev" : "");
  try {
    const authRes = await fetch("/api/v1/mini-app/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ init_data: initData }),
    });
    if (authRes.status === 401) return renderUnauthorized();
    if (!authRes.ok) return renderError();
    const auth = await authRes.json();
    const portRes = await fetch("/api/v1/mini-app/portfolio", {
      headers: { Authorization: "Bearer " + auth.token },
    });
    if (portRes.status === 401) return renderUnauthorized();
    if (!portRes.ok) return renderError();
    const data = await portRes.json();
    if (!data.positions || data.positions.length === 0) return renderEmpty();
    renderLoaded(data);
  } catch (_) {
    renderError();
  }
}

boot();
