/* global Telegram, LightweightCharts, COPY, fillCopy */
const tg = window.Telegram && window.Telegram.WebApp;
const reduceMotion =
  window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const C = COPY;
/* copy.js already exports global `fill`; use fillCopy to avoid a duplicate binding. */

if (tg) {
  try {
    tg.ready();
    if (typeof tg.expand === "function" && tg.isExpanded) {
      if (typeof tg.disableVerticalSwipes === "function") tg.disableVerticalSwipes();
    }
    if (typeof tg.onEvent === "function") {
      tg.onEvent("viewportChanged", () => {
        if (tg.isExpanded && typeof tg.disableVerticalSwipes === "function") {
          try {
            tg.disableVerticalSwipes();
          } catch (_) {
            /* ignore */
          }
        }
        const was = state.compact;
        state.compact = !tg.isExpanded;
        if (was !== state.compact && state.view === "main") paint();
      });
    }
  } catch (_) {
    /* WebView without a live Telegram host */
  }
}

const app = document.getElementById("app");
let sessionToken = "";
let chartHandle = null;
let candleSeries = null;
let pollTimer = null;
let ageTimer = null;
let toastTimer = null;
let suppressClickUntil = 0;

const state = {
  view: "main",
  tab: "ledger",
  sheet: null,
  detent: "half",
  openSwipe: "",
  search: "",
  searchOpen: false,
  products: [],
  productId: "",
  earlierOpen: false,
  compose: null,
  sent: null,
  blocked: null,
  toast: null,
  compact: true,
  riskOpen: false,
  flags: { primary_view: "ledger", jobline_negative: false, family: "blue" },
  portfolio: null,
  ledger: [],
  summary: { holding: 0, needs_you: 0, last_check_at: null },
  ledgerStatus: "loading",
  pending: {},
  optimistic: [],
};

function haptic(kind, arg) {
  const h = tg && tg.HapticFeedback;
  if (!h) return;
  try {
    if (kind === "impact") h.impactOccurred(arg || "light");
    else if (kind === "notify") h.notificationOccurred(arg);
    else if (kind === "select") h.selectionChanged();
  } catch (_) {
    /* no haptics */
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

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

function newId() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return "c-" + Date.now() + "-" + Math.random().toString(16).slice(2, 8);
}

function nowSecs() {
  return Math.floor(Date.now() / 1000);
}

function fmtDate(unix) {
  if (!unix) return "—";
  const d = new Date(Number(unix) * 1000);
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  return months[d.getUTCMonth()] + " " + d.getUTCDate();
}

function relCheck(at) {
  if (!at) return null;
  return Math.max(0, nowSecs() - Number(at));
}

function previewState() {
  if (location.hostname !== "127.0.0.1" && location.hostname !== "localhost") return null;
  return new URLSearchParams(location.search).get("preview");
}

function startParam() {
  return (
    (tg && tg.initDataUnsafe && tg.initDataUnsafe.start_param) ||
    new URLSearchParams(location.search).get("startapp") ||
    ""
  );
}

function parseChartStart(raw) {
  const m = String(raw || "").trim().match(/^(.+)_([dwm])$/i);
  if (!m) return null;
  return { symbol: m[1], period: m[2].toLowerCase() };
}

function instructionStart(raw) {
  const s = String(raw || "").trim();
  if (!s) return null;
  if (parseChartStart(s)) return null;
  if (s.startsWith("i_")) return s.slice(2);
  return s;
}

function heldCount() {
  return instructions().filter((row) =>
    ["with_aomi", "watching", "triggered", "awaiting_confirm", "executing", "paused"].includes(
      row.status,
    ),
  ).length;
}

function instructions() {
  const seen = new Set();
  const out = [];
  for (const row of state.optimistic.concat(state.ledger)) {
    if (seen.has(row.instruction_id)) continue;
    seen.add(row.instruction_id);
    out.push(row);
  }
  return out;
}

function zoneOf(row) {
  if (row.status === "awaiting_confirm" || row.status === "triggered" || row.status === "with_aomi") {
    return "needs";
  }
  if (row.status === "executing") return "motion";
  if (row.status === "watching" || row.status === "paused") return "watch";
  const today = new Date().toISOString().slice(0, 10);
  const changed = new Date((row.status_changed_at || row.updated_at || 0) * 1000)
    .toISOString()
    .slice(0, 10);
  if (row.status === "done" && changed === today) return "done";
  return "earlier";
}

function glyph(row) {
  if (row.status === "awaiting_confirm" || row.status === "triggered") return { g: "!", cls: "" };
  if (row.status === "with_aomi") return { g: "›", cls: "" };
  if (row.status === "executing") return { g: "", spin: true };
  if (row.status === "paused") return { g: "❚❚", cls: "faint" };
  if (row.status === "done") return { g: "✓", cls: "pos" };
  if (row.status === "expired") return { g: "·", cls: "faint" };
  if (row.fire_kind === "act") return { g: "⏱", cls: "" };
  return { g: "◎", cls: "" };
}

function chipClass(status) {
  if (status === "watching") return "pos";
  if (status === "paused") return "mute";
  if (status === "done" || status === "expired") return "faint";
  if (status === "blocked") return "neg";
  return "";
}

function cancellable(row) {
  if (!row || state.pending[row.instruction_id] === "cancel") return false;
  return (
    row.status === "watching" ||
    row.status === "paused" ||
    row.status === "with_aomi" ||
    row.status === "awaiting_confirm" ||
    row.status === "triggered"
  );
}

function taskIdOf(row) {
  return row.task_id || row.instruction_id;
}

async function cancelInPlace(row) {
  const id = taskIdOf(row);
  const message = fillCopy(C.drafts.cancel, { id });
  haptic("impact", "light");
  state.pending[row.instruction_id] = "cancel";
  state.ledger = state.ledger.filter((r) => r.instruction_id !== row.instruction_id);
  state.optimistic = state.optimistic.filter((r) => r.instruction_id !== row.instruction_id);
  if (state.insId === row.instruction_id) {
    state.sheet = null;
    state.insId = null;
  }
  showToast(C.toasts.cancelSent);
  const preview = previewState();
  if (preview && preview !== "dev") return;
  try {
    const initData = (tg && tg.initData) || (preview === "dev" ? "dev" : "");
    await ensureSession(initData);
    await api("/api/v1/mini-app/compose", {
      method: "POST",
      body: {
        kind: "cancel",
        instruction_id: row.instruction_id,
        message,
      },
    });
    refreshLedger();
  } catch (_) {
    showToast(C.toasts.cancelFailed);
  }
}

function subLine(row) {
  if (state.pending[row.instruction_id] === "pause") return C.sub.pendingPause;
  if (state.pending[row.instruction_id] === "resume") return C.sub.pendingResume;
  if (row.status === "with_aomi") return C.sub.withAomi;
  if (row.status === "paused") return C.sub.paused;
  if (row.status === "awaiting_confirm" || row.status === "triggered") {
    return row.trigger_value
      ? fillCopy(C.sub.needsYouAt, { value: row.trigger_value })
      : C.sub.needsYou;
  }
  if (row.status === "executing") {
    return fillCopy(C.sub.executing, {
      i: row.slice_i || "—",
      n: row.slice_n || "—",
      price: row.avg_price || "—",
    });
  }
  if (row.status === "done" && row.receipt) return row.receipt;
  if (row.status === "expired") return fillCopy(C.sub.expired, { date: fmtDate(row.expires_at) });
  if (row.status === "watching") {
    const n = relCheck(row.check_stats && row.check_stats.last_check_at);
    const stale = n != null && n > 120;
    if (stale) return fillCopy(C.sub.watchingStale, { n: Math.round(n / 60) });
    const dist =
      row.distance && row.distance.mark
        ? fillCopy(C.sub.watchingDist, { mark: usd(row.distance.mark).replace("$", "$"), pct: row.distance.pct })
        : "";
    const body =
      n != null && n >= 60
        ? fillCopy(C.sub.watchingSlow, { n: Math.round(n / 60), date: fmtDate(row.expires_at) })
        : fillCopy(C.sub.watching, { n: n == null ? "—" : n, date: fmtDate(row.expires_at) });
    return dist + body;
  }
  return "";
}

function heartbeatText() {
  if (state.ledgerStatus === "loading") return { text: C.heartbeat.loading, dot: "well" };
  if (state.ledgerStatus === "error") return { text: C.heartbeat.error, dot: "neg" };
  if (state.ledgerStatus === "stale") return { text: C.heartbeat.stale, dot: "warn" };
  const held = state.summary.holding || heldCount();
  const needs = state.summary.needs_you || 0;
  if (!held) return { text: C.heartbeat.empty, dot: "accent" };
  const n = relCheck(state.summary.last_check_at);
  if (needs === 1) return { text: fillCopy(C.heartbeat.holdingNeeds1, { held }), dot: "accent" };
  if (needs > 1) return { text: fillCopy(C.heartbeat.holdingNeedsN, { held, n: needs }), dot: "accent" };
  return {
    text: fillCopy(C.heartbeat.holdingOk, { held, n: n == null ? "—" : n }),
    dot: "accent",
  };
}

function headerHtml(mode) {
  const back = mode === "root" ? "⌄" : "‹";
  const search = mode === "root" ? searchBarHtml() : "";
  return `<header class="header">
    <button type="button" class="header-btn" id="backBtn" aria-label="Back">${back}</button>
    <div class="header-main">
      <h1 class="header-title">${escapeHtml(C.header.title)}</h1>
      <p class="header-sub">${escapeHtml(C.header.subtitle)}</p>
    </div>
    <button type="button" class="header-btn" id="moreBtn" aria-label="More">⋯</button>
    ${search}
  </header>`;
}

function productKindLabel(product) {
  if (product === "perp") return C.search.perp;
  if (product === "lend") return C.search.lending;
  return C.search.spot;
}

function filterProducts(q) {
  const all = state.products || [];
  const needle = String(q || "").trim().toLowerCase();
  if (!needle) return all.slice();
  return all.filter((row) => {
    const hay = (row.keywords || row.symbol || "").toLowerCase();
    return hay.split(/\s+/).some((tok) => tok.includes(needle));
  });
}

function searchBarHtml() {
  const q = state.search.trim();
  const filtered = filterProducts(q);
  const count = state.searchOpen
    ? q
      ? fillCopy(C.search.matches, { n: filtered.length })
      : fillCopy(C.search.products, { n: (state.products || []).length })
    : "";
  const clear = state.searchOpen
    ? `<button type="button" class="search-x" id="searchClear" aria-label="Close search">✕</button>`
    : "";
  return `<div class="search header-search">
    <span>⌕</span>
    <input id="search" placeholder="${escapeHtml(C.search.placeholder)}" value="${escapeHtml(state.search)}" autocomplete="off" />
    ${count ? `<span class="n">${escapeHtml(count)}</span>` : ""}
    ${clear}
  </div>`;
}

function searchMenuHtml() {
  if (!state.searchOpen) return "";
  const q = state.search.trim();
  const filtered = filterProducts(q);
  if (!state.products.length && !q) {
    return `<div class="search-menu"><p class="edge">${escapeHtml(C.search.loading)}</p></div>`;
  }
  if (q && !filtered.length) {
    return `<div class="search-menu"><p class="edge">${escapeHtml(fillCopy(C.search.noMatch, { q: state.search }))}</p></div>`;
  }
  const groups = [
    ["spot", C.search.spot],
    ["perp", C.search.perp],
    ["lend", C.search.lending],
  ];
  const body = groups
    .map(([key, label]) => {
      const rows = filtered.filter((row) => row.product === key);
      if (!rows.length) return "";
      return `<div class="sec-h">${escapeHtml(label)}</div>${rows.map(productRowHtml).join("")}`;
    })
    .join("");
  return `<div class="search-menu">${body}</div>`;
}

function productRowHtml(row) {
  const held = heldPosition(row);
  const sub = row.product === "lend"
    ? productKindLabel(row.product)
    : fillCopy(C.search.quote, { base: row.symbol, quote: row.quote_symbol || "USDT" });
  const mark = row.mark_price
    ? fillCopy(C.search.mark, { price: usd(row.mark_price) })
    : "";
  return `<button type="button" class="prod-row" data-product="${escapeHtml(row.id)}">
    <div class="glyph">${escapeHtml((row.symbol || "?").slice(0, 2))}</div>
    <div class="row-body">
      <div class="title-row"><div class="title">${escapeHtml(row.symbol)}</div><span class="pct-slot num">${escapeHtml(mark)}</span></div>
      <div class="sub">${escapeHtml(sub)}${held ? `<span class="prod-held">${escapeHtml(C.search.held)}</span>` : ""}</div>
    </div>
  </button>`;
}

function heldPosition(prod) {
  if (!prod) return null;
  const all = (state.portfolio && state.portfolio.positions) || [];
  const want = String(prod.symbol || "")
    .replace(/-PERP$/i, "")
    .toUpperCase();
  for (let idx = 0; idx < all.length; idx++) {
    const row = all[idx];
    const have = String(row.symbol || "")
      .replace(/-PERP$/i, "")
      .toUpperCase();
    const type = row.asset_type === "borrow" ? "lend" : row.asset_type;
    if (have === want && type === prod.product) return { row, idx };
  }
  return null;
}

function findProduct(id) {
  return (state.products || []).find((row) => row.id === id);
}

function bottomHtml() {
  const label = state.sheet || state.view !== "main" ? C.bottom.inner : C.bottom.launch;
  const mic =
    state.view === "main" && !state.sheet
      ? `<button type="button" class="voice-btn" id="voiceBtn" aria-label="${escapeHtml(C.voice.hold)}">🎙</button>`
      : "";
  return `<div class="bottom-row"><button type="button" class="bottom-bar" id="bottomBtn">${escapeHtml(label)}</button>${mic}</div>`;
}

function toastHtml() {
  if (!state.toast) return "";
  return `<div class="toast">${escapeHtml(state.toast)}</div>`;
}

function showToast(msg) {
  state.toast = msg;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    state.toast = null;
    paint();
  }, 3200);
  paint();
}

function goBack() {
  haptic("impact", "light");
  if (state.searchOpen) {
    closeSearch();
    return;
  }
  if (state.sheet === "picker") {
    state.sheet = state.productId ? "product" : "position";
    paint();
    return;
  }
  if (state.sheet) {
    state.sheet = null;
    state.productId = "";
    paint();
    return;
  }
  if (state.view === "chart") {
    destroyChart();
    state.view = "main";
    const url = new URL(location.href);
    url.pathname = "/";
    url.searchParams.delete("symbol");
    url.searchParams.delete("period");
    history.pushState({}, "", url);
    paint();
    return;
  }
  if (state.view !== "main") {
    state.view = "main";
    paint();
    return;
  }
  if (tg && typeof tg.close === "function") tg.close();
}

function closeSearch() {
  state.searchOpen = false;
  state.search = "";
  paint();
}

function bindSearch() {
  const search = document.getElementById("search");
  function open() {
    if (state.searchOpen) return;
    state.searchOpen = true;
    paint();
    const el = document.getElementById("search");
    if (el) el.focus();
  }
  if (search) {
    search.onfocus = open;
    search.onclick = open;
    search.oninput = () => {
      state.search = search.value;
      state.searchOpen = true;
      paint();
      const el = document.getElementById("search");
      if (el) {
        el.focus();
        el.setSelectionRange(state.search.length, state.search.length);
      }
    };
  }
  const clear = document.getElementById("searchClear");
  if (clear) {
    clear.onclick = (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      closeSearch();
    };
  }
  app.querySelectorAll("[data-product]").forEach((el) => {
    el.onclick = () => openProduct(el.getAttribute("data-product"));
  });
}

function openProduct(id) {
  const prod = findProduct(id);
  if (!prod) return;
  state.searchOpen = false;
  state.search = "";
  const held = heldPosition(prod);
  if (held) {
    state.productId = "";
    state.sheet = "position";
    state.posIdx = held.idx;
  } else {
    state.posIdx = -1;
    state.productId = id;
    state.sheet = "product";
  }
  state.detent = "half";
  paint();
}

function openProductChart(symbol) {
  haptic("select");
  state.searchOpen = false;
  state.sheet = null;
  state.view = "chart";
  const url = new URL(location.href);
  url.pathname = "/chart";
  url.searchParams.set("symbol", symbol);
  url.searchParams.set("period", "d");
  history.pushState({}, "", url);
  loadChartView({ symbol, period: "d" });
}

function bindChrome() {
  const back = document.getElementById("backBtn");
  if (back) back.onclick = goBack;
  const bottom = document.getElementById("bottomBtn");
  if (bottom) bottom.onclick = goBack;
  const more = document.getElementById("moreBtn");
  if (more) more.onclick = () => {};
  bindSearch();
  bindVoice();
  const header = document.querySelector(".header");
  if (header) {
    document.documentElement.style.setProperty("--header-h", header.offsetHeight + "px");
  }
  if (tg && tg.BackButton) {
    if (state.sheet || state.view !== "main" || state.searchOpen) {
      tg.BackButton.show();
      tg.BackButton.onClick(goBack);
    } else {
      tg.BackButton.hide();
    }
  }
}

function paint() {
  if (state.view === "chart") return;
  if (state.view === "compose") return renderCompose();
  if (state.view === "sent") return renderSent();
  if (state.view === "blocked") return renderBlocked();
  renderMain();
}

function renderMain() {
  document.body.className = state.sheet || state.searchOpen ? "locked" : "";
  const hb = heartbeatText();
  const held = heldCount();
  const tab = state.tab;
  const compact = state.compact && !state.sheet && tab === "ledger";
  app.innerHTML =
    headerHtml("root") +
    `<div class="seg">
      <button type="button" class="${tab === "ledger" ? "on" : ""}" data-tab="ledger">${escapeHtml(C.header.tabLedger)}<span class="held">${held}</span></button>
      <button type="button" class="${tab === "portfolio" ? "on" : ""}" data-tab="portfolio">${escapeHtml(C.header.tabPortfolio)}</button>
    </div>` +
    (tab === "ledger" ? ledgerHtml(hb, compact) : portfolioHtml(hb)) +
    searchMenuHtml() +
    (state.sheet ? sheetHtml() : "") +
    toastHtml() +
    bottomHtml();
  bindChrome();
  app.querySelectorAll("[data-tab]").forEach((btn) => {
    btn.onclick = () => {
      haptic("select");
      state.tab = btn.getAttribute("data-tab");
      state.openSwipe = "";
      paint();
    };
  });
  bindLedger();
  bindPortfolio();
  bindSheet();
}

function ledgerHtml(hb, compact) {
  const p = state.portfolio;
  const chg = p && p.total_change_24h_pct != null ? Number(p.total_change_24h_pct) : null;
  const chgCls = chg == null ? "" : chg < 0 ? "down" : "up";
  const chgTxt = chg == null ? "" : (chg < 0 ? "" : "+") + chg + "%";
  const risk = p && p.risk ? p.risk.liquidation_score : "—";
  const free = p && p.dollarpower ? usd(p.dollarpower.committed_usd) : "—";
  const strip = p
    ? `<div class="strip" id="strip"><span class="val num">${usd(p.total_usd_value)}</span><span class="chg num ${chgCls}">${escapeHtml(chgTxt)}</span><span class="meta">${escapeHtml(fillCopy(C.strip.riskFree, { risk, free }))}</span><span class="go">${escapeHtml(C.strip.trail)}</span></div>`
    : "";
  const rows = instructions();
  const needs = rows.filter((r) => zoneOf(r) === "needs");
  const motion = rows.filter((r) => zoneOf(r) === "motion");
  const watch = rows.filter((r) => zoneOf(r) === "watch");
  const done = rows.filter((r) => zoneOf(r) === "done");
  const earlier = rows.filter((r) => zoneOf(r) === "earlier");
  const paused = watch.filter((r) => r.status === "paused").length;
  const watchingN = watch.length - paused;

  if (compact) {
    return (
      `<div class="launch-label"><span>${escapeHtml(C.launch.label)}</span><span class="num">${new Date().toISOString().slice(11, 16)} UTC</span></div>` +
      reportLine("!", C.launch.needs, needs) +
      reportLine("⚙", C.launch.motion, motion) +
      `<div class="report"><span class="g">◎</span><span>${escapeHtml(
        fillCopy(C.launch.watching, {
          n: watchingN,
          p: paused,
          list: watch.map((r) => r.sentence).slice(0, 3).join(" · ") || "—",
        }),
      )}</span></div>` +
      reportLine("✓", C.launch.done, done, "pos") +
      `<div class="heartbeat"><span class="dot ${hb.dot}"></span>${escapeHtml(hb.text)}</div>` +
      strip +
      `<p class="teach">${escapeHtml(C.launch.hint)}</p>`
    );
  }

  if (state.ledgerStatus === "loading") {
    return strip + `<div class="heartbeat"><span class="dot well"></span>${escapeHtml(C.heartbeat.loading)}</div><div class="skel"></div><div class="skel" style="width:70%"></div>`;
  }
  if (state.ledgerStatus === "error" && !rows.length) {
    return strip + `<div class="heartbeat"><span class="dot neg"></span>${escapeHtml(C.heartbeat.error)}</div><p class="edge">${escapeHtml(C.errorRow)}</p>`;
  }
  if (!rows.length) {
    return strip + `<div class="heartbeat"><span class="dot ${hb.dot}"></span>${escapeHtml(hb.text)}</div><p class="teach">${escapeHtml(C.emptyTeach)}</p><p class="footer-line">${escapeHtml(C.ledgerFooter)}</p>`;
  }

  return (
    strip +
    `<div class="heartbeat"><span class="dot ${hb.dot}"></span>${escapeHtml(hb.text)}</div>` +
    zoneBlock("needs", C.zones.needsYou, "lab-accent", needs.length, needs) +
    zoneBlock("motion", C.zones.inMotion, "lab-accent", motion.length, motion) +
    zoneBlock(
      "watch",
      C.zones.watching,
      "lab-faint",
      fillCopy(C.zones.watchingCount, { w: watchingN, p: paused }),
      watch,
    ) +
    zoneBlock("done", C.zones.doneToday, "lab-pos", done.length, done) +
    (earlier.length
      ? `<div class="zone-h" id="earlierToggle"><span class="lab lab-faint">${escapeHtml(C.zones.earlier)} ${state.earlierOpen ? "▴" : "▾"}</span><span class="n">${escapeHtml(C.zones.earlierSub)}</span></div>` +
        (state.earlierOpen ? zoneRows(earlier) : "")
      : "") +
    `<p class="footer-line">${escapeHtml(C.ledgerFooter)}</p>`
  );
}

function reportLine(g, tmpl, rows, cls) {
  const what = rows[0] ? rows[0].sentence : "—";
  const pct = rows[0] && rows[0].progress_pct != null ? rows[0].progress_pct : "—";
  return `<div class="report"><span class="g ${cls || ""}">${g}</span><span>${escapeHtml(
    fillCopy(tmpl, { n: rows.length, what, pct, receipts: rows.map((r) => r.receipt || r.sentence).join(", ") }),
  )}</span></div>`;
}

function zoneBlock(id, label, labCls, count, rows) {
  if (!rows.length) return "";
  return `<div class="zone-h"><span class="lab ${labCls}">${escapeHtml(label)}</span><span class="n">${escapeHtml(String(count))}</span></div>${zoneRows(rows)}`;
}

function zoneRows(rows) {
  return rows
    .map((row, i) => {
      const g = glyph(row);
      const swipable =
        (row.status === "watching" || row.status === "paused") &&
        !state.pending[row.instruction_id];
      const meter =
        row.status === "executing" && row.progress_pct != null
          ? `<div class="meter"><span style="width:${Number(row.progress_pct)}%"></span></div>`
          : row.status === "watching" && row.distance && state.ledgerStatus !== "stale"
            ? `<div class="meter ${row.distance.near ? "warn" : ""}"><span style="width:${row.distance.pct}%"></span></div>`
            : "";
      const value =
        row.status === "executing" && row.progress_pct != null
          ? `<span class="pct-slot num">${escapeHtml(String(row.progress_pct))}%</span>`
          : row.display_status
            ? `<span class="chip ${chipClass(row.status)}">${escapeHtml(row.display_status)}</span>`
            : "";
      const open = state.openSwipe === row.instruction_id;
      const canCancel = cancellable(row);
      const chips = swipable
        ? `<div class="swipe-under"><button type="button" class="swipe-chip primary" data-act="${row.status === "paused" ? "resume" : "pause"}" data-id="${escapeHtml(row.instruction_id)}">${row.status === "paused" ? "Resume" : "Pause"}</button><button type="button" class="swipe-chip ask" data-act="ask" data-id="${escapeHtml(row.instruction_id)}">Ask</button></div>`
        : "";
      return `<div class="row ${i === rows.length - 1 ? "last" : ""}" data-row="${escapeHtml(row.instruction_id)}" data-swipe="${swipable ? "1" : "0"}">
        ${chips}
        <div class="row-front" style="${open ? "transform:translateX(-140px)" : ""}">
          <div class="glyph ${g.cls}">${g.spin ? '<div class="spin"></div>' : escapeHtml(g.g)}</div>
          <div class="row-body">
            <div class="title-row"><div class="title">${escapeHtml(row.sentence)}</div>${value}${canCancel ? `<button type="button" class="row-x" data-cancel="${escapeHtml(row.instruction_id)}" aria-label="${escapeHtml(C.instruction.cancel)}">×</button>` : ""}</div>
            <div class="sub">${escapeHtml(subLine(row))}</div>
            ${meter}
          </div>
          ${swipable ? '<div class="grip"><i></i></div>' : ""}
        </div>
      </div>`;
    })
    .join("");
}

function bindLedger() {
  const strip = document.getElementById("strip");
  if (strip) {
    strip.onclick = () => {
      state.tab = "portfolio";
      paint();
    };
  }
  const earlier = document.getElementById("earlierToggle");
  if (earlier) {
    earlier.onclick = () => {
      state.earlierOpen = !state.earlierOpen;
      paint();
    };
  }
  const hint = app.querySelector(".teach");
  if (hint && state.compact) {
    hint.onclick = () => {
      state.compact = false;
      paint();
    };
  }
  app.querySelectorAll(".row[data-row]").forEach((el) => bindRowSwipe(el, false));
  app.querySelectorAll("[data-cancel]").forEach((btn) => {
    btn.addEventListener("pointerdown", (ev) => ev.stopPropagation());
    btn.onclick = (ev) => {
      ev.stopPropagation();
      const row = instructions().find((r) => r.instruction_id === btn.getAttribute("data-cancel"));
      if (row) cancelInPlace(row);
    };
  });
}

function bindRowSwipe(el, isPosition) {
  const id = el.getAttribute("data-row");
  const swipable = el.getAttribute("data-swipe") === "1";
  const front = el.querySelector(".row-front");
  const reveal = isPosition && el.getAttribute("data-ask-only") === "1" ? 70 : 140;
  let x0 = 0;
  let y0 = 0;
  let dx = 0;
  let t0 = 0;
  let tracking = false;
  let aborted = false;
  const limit = isPosition ? 230 : reveal + 20;

  function rubber(v) {
    const cap = isPosition ? 260 : reveal;
    if (v > 0) return 0;
    const mag = -v;
    if (mag <= cap) return v;
    return -(cap + (mag - cap) * 0.22);
  }

  el.querySelectorAll("[data-act]").forEach((btn) => {
    btn.onclick = (ev) => {
      ev.stopPropagation();
      onRowAct(id, btn.getAttribute("data-act"), isPosition);
    };
  });

  front.addEventListener("click", () => {
    if (Date.now() < suppressClickUntil) return;
    if (state.openSwipe && state.openSwipe !== id) {
      state.openSwipe = "";
      paint();
      return;
    }
    if (state.openSwipe === id) {
      state.openSwipe = "";
      paint();
      return;
    }
    if (isPosition) {
      state.sheet = "position";
      state.posIdx = Number(id);
      state.detent = "half";
      paint();
      return;
    }
    openInstruction(id);
  });

  if (!swipable) return;

  front.addEventListener("pointerdown", (ev) => {
    x0 = ev.clientX;
    y0 = ev.clientY;
    dx = 0;
    t0 = performance.now();
    tracking = true;
    aborted = false;
    front.setPointerCapture(ev.pointerId);
    front.style.transition = "none";
  });
  front.addEventListener("pointermove", (ev) => {
    if (!tracking) return;
    const mx = ev.clientX - x0;
    const my = ev.clientY - y0;
    if (!aborted && Math.abs(my) > 12 && Math.abs(my) > Math.abs(mx)) {
      aborted = true;
      front.style.transform = "";
      return;
    }
    if (Math.abs(mx) > 6 && Math.abs(mx) > Math.abs(my) * 1.2) {
      dx = rubber(mx);
      if (dx < -8) haptic("impact", "light");
      front.style.transform = `translateX(${dx}px)`;
    }
  });
  function end() {
    if (!tracking) return;
    tracking = false;
    const dt = Math.max(1, performance.now() - t0);
    const vel = dx / dt;
    front.style.transition = "transform 220ms cubic-bezier(.2,.8,.3,1)";
    suppressClickUntil = Date.now() + 120;
    if (isPosition && (dx < -230 || vel < -0.9)) {
      haptic("impact", "medium");
      onRowAct(id, "primary", true);
      return;
    }
    if (dx < -(reveal * 0.5) || vel < -0.9) {
      state.openSwipe = id;
      if (!isPosition && dx < -(reveal + 20)) {
        /* instruction rows rubber-band; still only open */
      }
    } else {
      state.openSwipe = "";
    }
    paint();
  }
  front.addEventListener("pointerup", end);
  front.addEventListener("pointercancel", end);
}

function onRowAct(id, act, isPosition) {
  if (isPosition) {
    const p = (state.portfolio.positions || [])[Number(id)];
    if (!p) return;
    const acts = positionActs(p);
    if (act === "ask") return openCompose({ kind: "question", message: acts.ask, slide: false });
    if (act === "primary" && acts.primary) {
      return openCompose({
        kind: "imperative",
        message: acts.primary.msg,
        note: fillCopy(C.compose.noteImperative, { delta: acts.primary.delta || "moves portfolio risk" }),
        slide: true,
        button: acts.primary.label,
      });
    }
    return;
  }
  const row = instructions().find((r) => r.instruction_id === id);
  if (!row) return;
  if (act === "ask") {
    return openCompose({
      kind: "question",
      message: fillCopy(C.drafts.askPrefix, { sentence: row.sentence }),
      slide: false,
      instruction_id: id,
    });
  }
  if (act === "pause" || act === "resume") {
    return openCompose({
      kind: act,
      message: fillCopy(act === "pause" ? C.drafts.pause : C.drafts.resume, { sentence: row.sentence }),
      note: act === "pause" ? C.compose.notePause : C.compose.noteResume,
      slide: true,
      instruction_id: id,
      button: act === "pause" ? C.compose.sendPause : C.compose.sendResume,
    });
  }
}

function portfolioHtml(hb) {
  const p = state.portfolio;
  if (!p) {
    return `<div class="heartbeat"><span class="dot well"></span>${escapeHtml(C.heartbeat.loading)}</div><div class="skel"></div>`;
  }
  const all = p.positions || [];
  if (!all.length) {
    const hbEmpty = heartbeatText();
    return (
      `<div class="hero"><div class="hero-val num">${usd(p.total_usd_value)}</div></div>` +
      `<div class="heartbeat tap" id="hbTap"><span class="dot ${hbEmpty.dot}"></span>${escapeHtml(hbEmpty.text)}</div>` +
      `<div class="center"><p>${escapeHtml(C.portfolioEmpty)}</p><p class="sub">${escapeHtml(C.portfolioEmptySub)}</p></div>` +
      `<p class="footer-line">${escapeHtml(C.portfolio.footer)}</p>`
    );
  }
  const chg = p.total_change_24h_pct != null ? Number(p.total_change_24h_pct) : null;
  const groups = [
    ["holdings", C.portfolio.holdings],
    ["positions", C.portfolio.openPositions],
    ["lending", C.portfolio.lending],
  ];
  const risk = p.risk || {};
  const floor = p.floor || "—";
  return (
    `<div class="hero"><div class="hero-val num">${usd(p.total_usd_value)}</div><div class="hero-sub num ${chg != null && chg < 0 ? "down" : "up"}">${chg == null ? "—" : (chg < 0 ? "" : "+") + chg + "%"}</div></div>` +
    `<div class="margin"><div class="lab">Available margin</div><div class="val num">${usd(p.dollarpower && p.dollarpower.committed_usd)}</div><div class="stack"><span style="width:${escapeHtml((p.dollarpower && p.dollarpower.fill_pct) || "0")}%"></span></div></div>` +
    `<div class="risk-line" id="riskLine">${escapeHtml(
      fillCopy(C.portfolio.riskLine, {
        n: risk.liquidation_score,
        band: risk.band || "",
        d: risk.distance_from_floor_pct != null ? risk.distance_from_floor_pct + "%" : "—",
        floor,
      }),
    )}</div>` +
    (state.riskOpen
      ? `<div class="facts"><div>${escapeHtml(fillCopy(C.portfolio.riskFloor, { floor }))}</div><div class="ask" id="riskAsk">${escapeHtml(C.portfolio.riskAsk)}</div></div>`
      : "") +
    `<div class="heartbeat tap" id="hbTap"><span class="dot ${hb.dot}"></span>${escapeHtml(hb.text)}</div>` +
    groups
      .map(([key, label]) => {
        const rows = all
          .map((row, idx) => ({ row, idx }))
          .filter(({ row }) => (row.group || groupFallback(row)) === key);
        if (!rows.length) return "";
        return `<div class="sec-h">${escapeHtml(label)}</div>${rows
          .map(({ row, idx }) => positionRowHtml(row, idx, idx === rows[rows.length - 1].idx))
          .join("")}`;
      })
      .join("") +
    `<p class="footer-line">${escapeHtml(C.portfolio.footer)}</p>`
  );
}

function groupFallback(row) {
  if (row.asset_type === "perp") return "positions";
  if (row.asset_type === "lend" || row.asset_type === "borrow") return "lending";
  return "holdings";
}

function jobline(row) {
  const extra = row.extra || "";
  if (row.watch_count > 0) return fillCopy(C.portfolio.jobline, { n: row.watch_count, extra });
  if (state.flags.jobline_negative && extra) return fillCopy(C.portfolio.joblineNeg, { extra });
  return extra;
}

function positionRowHtml(row, idx) {
  const askOnly = row.can_exit === false ? "1" : "0";
  const swipable = "1";
  const open = state.openSwipe === String(idx);
  const primary = positionActs(row).primary;
  const under = `<div class="swipe-under">${
    row.can_exit !== false && primary
      ? `<button type="button" class="swipe-chip primary" data-act="primary" data-id="${idx}">${escapeHtml(primary.label)}</button>`
      : ""
  }<button type="button" class="swipe-chip ask" data-act="ask" data-id="${idx}">Ask</button></div>`;
  return `<div class="row pos" data-row="${idx}" data-swipe="${swipable}" data-ask-only="${askOnly}">
    ${under}
    <div class="row-front" style="${open ? `transform:translateX(-${row.can_exit === false ? 70 : 140}px)` : ""}">
      <div class="glyph">${escapeHtml((row.symbol || "?").slice(0, 2))}</div>
      <div class="row-body">
        <div class="title-row"><div class="title">${escapeHtml(row.symbol)}</div><span class="pct-slot num">${usd(row.usd_value)}</span></div>
        <div class="sub">${escapeHtml(row.quantity + " · " + (jobline(row) || row.asset_type))}</div>
      </div>
      <div class="grip"><i></i></div>
    </div>
  </div>`;
}

function bindPortfolio() {
  const risk = document.getElementById("riskLine");
  if (risk) {
    risk.onclick = () => {
      state.riskOpen = !state.riskOpen;
      paint();
    };
  }
  const ask = document.getElementById("riskAsk");
  if (ask) {
    ask.onclick = () =>
      openCompose({ kind: "question", message: "Walk me through my risk.", slide: false });
  }
  const hb = document.getElementById("hbTap");
  if (hb) {
    hb.onclick = () => {
      state.tab = "ledger";
      paint();
    };
  }
  app.querySelectorAll(".row.pos").forEach((el) => bindRowSwipe(el, true));
}

function positionActs(p) {
  const qty = p.quantity;
  const sym = p.symbol;
  const type = p.asset_type;
  if (type === "lend") {
    return {
      primary: null,
      ask: `What happens when my ${sym} lend matures?`,
      watch: true,
    };
  }
  if (type === "perp") {
    return {
      primary: {
        label: "Close at market",
        msg: `Close my ${sym} ${p.side || "long"} (${qty}) at market.`,
        delta: "moves portfolio risk",
      },
      extra: [
        {
          label: "Reduce by half",
          msg: `Reduce my ${sym} ${p.side || "long"} by half.`,
          delta: "moves portfolio risk",
        },
        { label: "Increase to 5×", gated: true },
      ],
      ask: `Walk me through my ${sym} position.`,
      watch: true,
    };
  }
  return {
    primary: {
      label: "Sell at market",
      msg: `Sell my ${qty} ${sym} at market.`,
      delta: "moves portfolio risk",
    },
    extra: [
      {
        label: "Sell half",
        msg: `Sell ${qty} ${sym} at market — half.`,
        delta: "moves portfolio risk",
      },
    ],
    ask: `Walk me through my ${sym} spot position.`,
    watch: true,
  };
}

function watchDrafts(p) {
  const sym = p.symbol;
  const floor = state.portfolio && state.portfolio.floor;
  const out = [];
  if (p.asset_type === "perp" && floor) {
    const level = (Number(floor) * 1.1).toFixed(0);
    out.push({ tag: "TELL", text: `If ${sym} drops to $${level} (floor +10%), tell me`, fire: "tell" });
    out.push({ tag: "ACT", text: `If ${sym} drops to $${level}, close half`, fire: "act" });
    out.push({ tag: "TELL", text: "If funding turns positive, tell me", fire: "tell" });
  } else if (p.asset_type === "lend") {
    out.push({
      tag: "TELL",
      text: `The day before maturity, remind me to choose a roll`,
      fire: "tell",
    });
  } else {
    out.push({ tag: "ACT", text: `If ${sym} touches a third below, sell a third of the spot`, fire: "act" });
    out.push({ tag: "TELL", text: `If ${sym} drops 5% in a day, tell me`, fire: "tell" });
  }
  return out;
}

function sheetHtml() {
  const half = state.sheet === "position" || state.sheet === "product" ? 280 : state.sheet === "instruction" ? 260 : 0;
  const y = state.sheet === "pick" || state.sheet === "picker" ? 0 : state.detent === "full" ? 0 : half;
  if (state.sheet === "position" || (state.sheet === "picker" && !state.productId)) return positionSheet(y);
  if (state.sheet === "product" || (state.sheet === "picker" && state.productId)) return productSheet(y);
  if (state.sheet === "instruction") return instructionSheet(y);
  return "";
}

function positionSheet(y) {
  const p = (state.portfolio.positions || [])[state.posIdx];
  if (!p) return "";
  const acts = positionActs(p);
  const picker = state.sheet === "picker";
  if (picker) {
    const drafts = watchDrafts(p);
    return `<div class="scrim" id="scrim"></div>
      <div class="sheet pick" id="sheet" style="transform:translateY(${y}px)">
        <div class="handle" id="handle"></div>
        <div class="sheet-h"><h2>${escapeHtml(fillCopy(C.picker.title, { position: p.symbol }))}</h2><button type="button" class="x" id="sheetX">✕</button></div>
        <div class="sheet-body">
          <p class="note">${escapeHtml(C.picker.sub)}</p>
          ${drafts
            .map(
              (d, i) =>
                `<div class="draft" data-draft="${i}"><span class="tag-pill">${escapeHtml(d.tag)}</span><span>${escapeHtml(d.text)}</span></div>`,
            )
            .join("")}
          <p class="hint">${escapeHtml(C.picker.footer)}</p>
        </div>
      </div>`;
  }
  const extras = (acts.extra || [])
    .map((a) => {
      if (a.gated) {
        return `<button type="button" class="act" data-gated="1"><span>${escapeHtml(a.label)}</span><span class="tag">${escapeHtml(C.position.gated)}</span></button>`;
      }
      return `<button type="button" class="act extra-act" data-msg="${escapeHtml(a.msg)}" data-label="${escapeHtml(a.label)}"><span>${escapeHtml(a.label)}</span><span class="tag">${escapeHtml(C.instruction.tagSlides)}</span></button>`;
    })
    .join("");
  return `<div class="scrim" id="scrim"></div>
    <div class="sheet pos" id="sheet" style="transform:translateY(${y}px)">
      <div class="handle" id="handle"></div>
      <div class="sheet-h"><div><h2>${escapeHtml(p.symbol)}</h2><div class="sub">${usd(p.usd_value)} · ${escapeHtml(p.quantity)}</div></div><button type="button" class="x" id="sheetX">✕</button></div>
      <div class="sheet-body">
        <div class="fact-card">${escapeHtml(jobline(p) || p.asset_type)}${p.watch_count ? `<div class="k">${escapeHtml(fillCopy(C.position.watched, { n: p.watch_count }))}</div>` : ""}</div>
        <div class="act-lab">${escapeHtml(C.position.actsLabel)}</div>
        ${
          acts.primary
            ? `<button type="button" class="act" id="primaryAct"><span>${escapeHtml(acts.primary.label)}</span><span class="tag">${escapeHtml(C.instruction.tagSlides)}</span></button>`
            : ""
        }
        ${extras}
        <button type="button" class="act" id="watchAct"><span>${escapeHtml(C.position.watchThis)}</span><span class="tag">›</span></button>
        <button type="button" class="act" id="askAct"><span>${escapeHtml(C.instruction.ask)}</span><span class="tag">${escapeHtml(C.instruction.tagTap)}</span></button>
        <p class="hint">${escapeHtml(C.position.footer)}</p>
        <p class="hint">${escapeHtml(state.detent === "full" ? C.instruction.detentFull : C.instruction.detentHalf)}</p>
      </div>
    </div>`;
}

function productActs(prod) {
  const sym = prod.symbol;
  if (prod.product === "lend") {
    return {
      primary: {
        label: C.search.lend,
        msg: fillCopy(C.search.lendMsg, { symbol: sym }),
        delta: "moves portfolio risk",
      },
      ask: fillCopy(C.search.askLend, { symbol: sym }),
      watch: true,
    };
  }
  if (prod.product === "perp") {
    return {
      primary: {
        label: C.search.openLong,
        msg: fillCopy(C.search.longMsg, { symbol: sym }),
        delta: "moves portfolio risk",
      },
      extra: [
        {
          label: C.search.openShort,
          msg: fillCopy(C.search.shortMsg, { symbol: sym }),
          delta: "moves portfolio risk",
        },
      ],
      ask: fillCopy(C.search.askPerp, { symbol: sym }),
      watch: true,
    };
  }
  return {
    primary: {
      label: C.search.buy,
      msg: fillCopy(C.search.buyMsg, { symbol: sym }),
      delta: "moves portfolio risk",
    },
    extra: [
      {
        label: C.search.sell,
        msg: fillCopy(C.search.sellMsg, { symbol: sym }),
        delta: "moves portfolio risk",
      },
    ],
    ask: fillCopy(C.search.askSpot, { symbol: sym }),
    watch: true,
  };
}

function productWatchDrafts(prod) {
  const held = heldPosition(prod);
  if (held) return watchDrafts(held.row);
  const sym = prod.symbol;
  if (prod.product === "perp") {
    return [
      { tag: "TELL", text: `If ${sym} drops 5% in a day, tell me`, fire: "tell" },
      { tag: "ACT", text: `If ${sym} drops 8%, close the perp`, fire: "act" },
    ];
  }
  if (prod.product === "lend") {
    return [
      {
        tag: "TELL",
        text: `The day before ${sym} maturity, remind me to choose a roll`,
        fire: "tell",
      },
    ];
  }
  return [
    { tag: "ACT", text: `If ${sym} touches a third below, sell a third of the spot`, fire: "act" },
    { tag: "TELL", text: `If ${sym} drops 5% in a day, tell me`, fire: "tell" },
  ];
}

function productSheet(y) {
  const p = findProduct(state.productId);
  if (!p) return "";
  const acts = productActs(p);
  const picker = state.sheet === "picker";
  if (picker) {
    const drafts = productWatchDrafts(p);
    return `<div class="scrim" id="scrim"></div>
      <div class="sheet pick" id="sheet" style="transform:translateY(${y}px)">
        <div class="handle" id="handle"></div>
        <div class="sheet-h"><h2>${escapeHtml(fillCopy(C.picker.title, { position: p.symbol }))}</h2><button type="button" class="x" id="sheetX">✕</button></div>
        <div class="sheet-body">
          <p class="note">${escapeHtml(C.picker.sub)}</p>
          ${drafts
            .map(
              (d, i) =>
                `<div class="draft" data-draft="${i}"><span class="tag-pill">${escapeHtml(d.tag)}</span><span>${escapeHtml(d.text)}</span></div>`,
            )
            .join("")}
          <p class="hint">${escapeHtml(C.picker.footer)}</p>
        </div>
      </div>`;
  }
  const extras = (acts.extra || [])
    .map(
      (a) =>
        `<button type="button" class="act extra-act" data-msg="${escapeHtml(a.msg)}" data-label="${escapeHtml(a.label)}"><span>${escapeHtml(a.label)}</span><span class="tag">${escapeHtml(C.instruction.tagSlides)}</span></button>`,
    )
    .join("");
  const kind = productKindLabel(p.product);
  const mark = p.mark_price ? fillCopy(C.search.mark, { price: usd(p.mark_price) }) : "";
  return `<div class="scrim" id="scrim"></div>
    <div class="sheet prod" id="sheet" style="transform:translateY(${y}px)">
      <div class="handle" id="handle"></div>
      <div class="sheet-h"><div><h2>${escapeHtml(p.symbol)}</h2><div class="sub">${escapeHtml(kind)}${mark ? " · " + escapeHtml(mark) : ""}</div></div><button type="button" class="x" id="sheetX">✕</button></div>
      <div class="sheet-body">
        <div class="act-lab">${escapeHtml(C.position.actsLabel)}</div>
        ${
          acts.primary
            ? `<button type="button" class="act" id="primaryAct"><span>${escapeHtml(acts.primary.label)}</span><span class="tag">${escapeHtml(C.instruction.tagSlides)}</span></button>`
            : ""
        }
        ${extras}
        <button type="button" class="act" id="watchAct"><span>${escapeHtml(C.position.watchThis)}</span><span class="tag">›</span></button>
        <button type="button" class="act" id="askAct"><span>${escapeHtml(C.instruction.ask)}</span><span class="tag">${escapeHtml(C.instruction.tagTap)}</span></button>
        <button type="button" class="act" id="chartAct"><span>${escapeHtml(C.search.chart)}</span><span class="tag">↗</span></button>
        <p class="hint">${escapeHtml(C.position.footer)}</p>
        <p class="hint">${escapeHtml(state.detent === "full" ? C.instruction.detentFull : C.instruction.detentHalf)}</p>
      </div>
    </div>`;
}

function instructionSheet(y) {
  const row = instructions().find((r) => r.instruction_id === state.insId);
  if (!row) return "";
  const needs = row.status === "awaiting_confirm" || row.status === "triggered";
  const executing = row.status === "executing";
  const g = glyph(row);
  const facts = [
    row.params && row.params.resolved ? ["condition", row.params.resolved] : null,
    row.check_stats && row.check_stats.checks_7d
      ? ["checks", String(row.check_stats.checks_7d)]
      : null,
    ["id", taskIdOf(row)],
    ["expires", fmtDate(row.expires_at)],
  ].filter(Boolean);
  const trail = row.trail || [];
  const acts = needs
    ? `<div class="act-lab">${escapeHtml(C.instruction.awaitingLabel)}</div><p class="note">${escapeHtml(C.instruction.awaitingNote)}</p><button type="button" class="act accent" id="openThread"><span>${escapeHtml(C.instruction.openThread)}</span></button>` +
      (cancellable(row)
        ? `<button type="button" class="act" id="cancelAct"><span>${escapeHtml(C.instruction.cancel)}</span><span class="tag">×</span></button>`
        : "")
    : `<div class="act-lab">${escapeHtml(C.instruction.actsLabel)}</div>` +
      (row.status === "watching"
        ? `<button type="button" class="act" id="pauseAct"><span>${escapeHtml(C.instruction.pause)}</span><span class="tag">${escapeHtml(C.instruction.tagSlides)}</span></button>`
        : "") +
      (row.status === "paused"
        ? `<button type="button" class="act" id="resumeAct"><span>${escapeHtml(C.instruction.resume)}</span><span class="tag">${escapeHtml(C.instruction.tagSlides)}</span></button>`
        : "") +
      (cancellable(row)
        ? `<button type="button" class="act" id="cancelAct"><span>${escapeHtml(C.instruction.cancel)}</span><span class="tag">×</span></button>`
        : "") +
      (!executing
        ? `<button type="button" class="act" id="askIns"><span>${escapeHtml(C.instruction.ask)}</span><span class="tag">${escapeHtml(C.instruction.tagTap)}</span></button>`
        : `<button type="button" class="act" id="askIns"><span>${escapeHtml(C.instruction.askRun)}</span><span class="tag">${escapeHtml(C.instruction.tagTap)}</span></button>`) +
      `<button type="button" class="act accent" id="openThread"><span>${escapeHtml(C.instruction.openThread)}</span><span class="tag">${executing ? escapeHtml(C.instruction.tagHalt) : ""}</span></button>`;
  return `<div class="scrim" id="scrim"></div>
    <div class="sheet ins" id="sheet" style="transform:translateY(${y}px)">
      <div class="handle" id="handle"></div>
      <div class="sheet-h"><div><h2>${escapeHtml(row.sentence)}</h2><div class="chip ${chipClass(row.status)}">${escapeHtml(row.display_status || (row.progress_pct != null ? row.progress_pct + "%" : ""))}</div></div><button type="button" class="x" id="sheetX">✕</button></div>
      <div class="sheet-body">
        <div class="fact-card">${facts.map(([k, v]) => `<div class="k">${escapeHtml(k)}</div><div>${escapeHtml(v)}</div>`).join("")}</div>
        ${acts}
        ${
          state.detent === "full"
            ? `<div class="act-lab">${escapeHtml(C.instruction.trailLabel)}</div>${trail
                .map(
                  (t) =>
                    `<div class="trail-row"><div class="trail-meta">${escapeHtml(fmtDate(t.at))} · ${escapeHtml(t.actor)}</div><div class="trail-line">${escapeHtml(t.line)}${t.signed ? `<span class="signed">signed</span>` : ""}</div></div>`,
                )
                .join("")}<p class="hint">${escapeHtml(C.instruction.sheetFooter)}</p>`
            : `<p class="hint">${escapeHtml(C.instruction.detentHalf)}</p>`
        }
      </div>
    </div>`;
}

function bindSheet() {
  const scrim = document.getElementById("scrim");
  const sheet = document.getElementById("sheet");
  const handle = document.getElementById("handle");
  const x = document.getElementById("sheetX");
  if (scrim) scrim.onclick = () => { state.sheet = null; state.productId = ""; paint(); };
  if (x) x.onclick = () => {
    if (state.sheet === "picker") state.sheet = state.productId ? "product" : "position";
    else {
      state.sheet = null;
      state.productId = "";
    }
    paint();
  };
  const primary = document.getElementById("primaryAct");
  if (primary) {
    primary.onclick = () => {
      if (state.productId) {
        const p = findProduct(state.productId);
        const acts = productActs(p);
        return openCompose({
          kind: "imperative",
          message: acts.primary.msg,
          note: fillCopy(C.compose.noteImperative, { delta: acts.primary.delta }),
          slide: true,
          button: acts.primary.label,
        });
      }
      const p = (state.portfolio.positions || [])[state.posIdx];
      const acts = positionActs(p);
      openCompose({
        kind: "imperative",
        message: acts.primary.msg,
        note: fillCopy(C.compose.noteImperative, { delta: acts.primary.delta }),
        slide: true,
        button: acts.primary.label,
      });
    };
  }
  app.querySelectorAll(".extra-act").forEach((btn) => {
    btn.onclick = () =>
      openCompose({
        kind: "imperative",
        message: btn.getAttribute("data-msg"),
        note: fillCopy(C.compose.noteImperative, { delta: "moves portfolio risk" }),
        slide: true,
        button: btn.getAttribute("data-label"),
      });
  });
  app.querySelectorAll("[data-gated]").forEach((btn) => {
    btn.onclick = () => {
      state.blocked = { act: "Increase to 5×", n: "—", floor: (state.portfolio && state.portfolio.floor) || "—" };
      state.view = "blocked";
      state.sheet = null;
      paint();
    };
  });
  const watchAct = document.getElementById("watchAct");
  if (watchAct) {
    watchAct.onclick = () => {
      haptic("select");
      state.sheet = "picker";
      paint();
    };
  }
  const askAct = document.getElementById("askAct");
  if (askAct) {
    askAct.onclick = () => {
      if (state.productId) {
        const p = findProduct(state.productId);
        return openCompose({ kind: "question", message: productActs(p).ask, slide: false });
      }
      const p = (state.portfolio.positions || [])[state.posIdx];
      openCompose({ kind: "question", message: positionActs(p).ask, slide: false });
    };
  }
  const chartAct = document.getElementById("chartAct");
  if (chartAct) {
    chartAct.onclick = () => {
      const p = findProduct(state.productId);
      if (p) openProductChart(p.symbol);
    };
  }
  app.querySelectorAll("[data-draft]").forEach((el) => {
    el.onclick = () => {
      haptic("select");
      if (state.productId) {
        const p = findProduct(state.productId);
        const d = productWatchDrafts(p)[Number(el.getAttribute("data-draft"))];
        return openCompose({
          kind: "conditional",
          message: d.text,
          fire_kind: d.fire,
          note: d.fire === "act" ? C.compose.noteWatchAct : C.compose.noteWatchTell,
          slide: true,
          button: C.compose.sendWatch,
          instrument: p.symbol,
        });
      }
      const p = (state.portfolio.positions || [])[state.posIdx];
      const d = watchDrafts(p)[Number(el.getAttribute("data-draft"))];
      openCompose({
        kind: "conditional",
        message: d.text,
        fire_kind: d.fire,
        note: d.fire === "act" ? C.compose.noteWatchAct : C.compose.noteWatchTell,
        slide: true,
        button: C.compose.sendWatch,
        instrument: p.symbol,
      });
    };
  });
  const pauseAct = document.getElementById("pauseAct");
  if (pauseAct) pauseAct.onclick = () => onRowAct(state.insId, "pause", false);
  const resumeAct = document.getElementById("resumeAct");
  if (resumeAct) resumeAct.onclick = () => onRowAct(state.insId, "resume", false);
  const cancelAct = document.getElementById("cancelAct");
  if (cancelAct) {
    cancelAct.onclick = () => {
      const row = instructions().find((r) => r.instruction_id === state.insId);
      if (row) cancelInPlace(row);
    };
  }
  const askIns = document.getElementById("askIns");
  if (askIns) askIns.onclick = () => onRowAct(state.insId, "ask", false);
  const openThread = document.getElementById("openThread");
  if (openThread) openThread.onclick = () => openThreadLink();
  if (sheet) bindSheetDrag(sheet, handle);
}

function bindSheetDrag(sheet, handle) {
  const kind = state.sheet;
  const half = kind === "position" || kind === "product" ? 280 : kind === "instruction" ? 260 : 0;
  const container = kind === "position" ? 620 : kind === "instruction" ? 640 : 400;
  if (kind === "picker") {
    if (handle) handle.onclick = () => {};
    return;
  }
  let y0 = 0;
  let start = state.detent === "full" ? 0 : half;
  let y = start;
  let t0 = 0;
  let tracking = false;
  function setY(v) {
    y = v < 0 ? v * 0.18 : v;
    sheet.style.transition = "none";
    sheet.style.transform = `translateY(${y}px)`;
  }
  function onDown(ev) {
    y0 = ev.clientY;
    start = state.detent === "full" ? 0 : half;
    t0 = performance.now();
    tracking = true;
    sheet.setPointerCapture(ev.pointerId);
  }
  function onMove(ev) {
    if (!tracking) return;
    const dy = ev.clientY - y0;
    if (Math.abs(dy) > 8) setY(start + dy);
  }
  function onUp() {
    if (!tracking) return;
    tracking = false;
    const dt = Math.max(1, performance.now() - t0);
    const vel = (y - start) / dt;
    sheet.style.transition = "transform 240ms cubic-bezier(.2,.8,.3,1)";
    if (vel > 0.8 || y > half + 130) {
      state.sheet = null;
      state.productId = "";
      paint();
      return;
    }
    if (y < half * 0.55 || vel < -0.6) {
      haptic("select");
      state.detent = "full";
    } else {
      haptic("select");
      state.detent = "half";
    }
    paint();
  }
  sheet.addEventListener("pointerdown", onDown);
  sheet.addEventListener("pointermove", onMove);
  sheet.addEventListener("pointerup", onUp);
  sheet.addEventListener("pointercancel", onUp);
  if (handle) {
    handle.onclick = () => {
      state.detent = state.detent === "full" ? "half" : "full";
      haptic("select");
      paint();
    };
  }
}

async function openInstruction(id) {
  state.insId = id;
  state.sheet = "instruction";
  state.detent = "half";
  paint();
  try {
    const one = await api("/api/v1/mini-app/ledger/" + encodeURIComponent(id));
    const ins = one.instruction || one;
    if (ins && ins.instruction_id) {
      const idx = state.ledger.findIndex((r) => r.instruction_id === ins.instruction_id);
      if (idx >= 0) state.ledger[idx] = { ...state.ledger[idx], ...ins };
      else state.ledger.push(ins);
      if (state.sheet === "instruction" && state.insId === id) paint();
    }
  } catch (_) {
    /* keep the list card */
  }
}

function openCompose(payload) {
  state.compose = payload;
  state.view = "compose";
  state.sheet = null;
  state.searchOpen = false;
  paint();
}

function renderCompose() {
  const c = state.compose;
  document.body.className = "";
  const slide = c.slide && !reduceMotion;
  app.innerHTML =
    headerHtml("inner") +
    `<div class="screen">
      <div class="kicker">${escapeHtml(C.compose.label)}</div>
      <p class="msg">${escapeHtml(c.message)}</p>
      <p class="note">${escapeHtml(C.compose.disclaimer)}</p>
      ${c.note ? `<p class="note">${escapeHtml(c.note)}</p>` : ""}
      ${
        slide
          ? `<div class="rail" id="rail"><div class="rail-fill" id="railFill"></div><div class="rail-lab" id="railLab">${escapeHtml(fillCopy(C.compose.slideLabel, { button: c.button || C.compose.sendWatch }))}</div><div class="thumb" id="thumb">⟶</div></div><p class="hint">${escapeHtml(C.compose.slideHint)}</p>`
          : `<button type="button" class="primary-btn" id="sendTap">${escapeHtml(c.button || C.compose.ask)}</button><p class="hint">${escapeHtml(C.compose.tapHint)}</p>`
      }
    </div>` +
    bottomHtml();
  bindChrome();
  const tap = document.getElementById("sendTap");
  if (tap) tap.onclick = () => doSend();
  const thumb = document.getElementById("thumb");
  if (thumb) bindSlide(thumb);
}

function bindSlide(thumb) {
  const rail = document.getElementById("rail");
  const fillEl = document.getElementById("railFill");
  const lab = document.getElementById("railLab");
  const max = () => rail.clientWidth - 64 - 8;
  let x0 = 0;
  let x = 0;
  let tracking = false;
  thumb.addEventListener("pointerdown", (ev) => {
    x0 = ev.clientX;
    tracking = true;
    thumb.setPointerCapture(ev.pointerId);
    thumb.style.transition = "none";
  });
  thumb.addEventListener("pointermove", (ev) => {
    if (!tracking) return;
    x = Math.max(0, Math.min(max(), ev.clientX - x0));
    const pct = x / max();
    thumb.style.transform = `translateX(${x}px)`;
    fillEl.style.transform = `translateX(${-100 + pct * 100}%)`;
    lab.style.opacity = String(1 - Math.min(1, pct / 0.6));
  });
  function end() {
    if (!tracking) return;
    tracking = false;
    if (x / max() >= 0.9) {
      haptic("notify", "success");
      doSend();
      return;
    }
    thumb.style.transition = "transform 250ms cubic-bezier(.2,.8,.3,1)";
    fillEl.style.transition = "transform 250ms cubic-bezier(.2,.8,.3,1)";
    thumb.style.transform = "translateX(0)";
    fillEl.style.transform = "translateX(-100%)";
    lab.style.opacity = "1";
  }
  thumb.addEventListener("pointerup", end);
  thumb.addEventListener("pointercancel", end);
}

async function doSend() {
  const c = state.compose;
  const correlation_id = newId();
  const payload = {
    correlation_id,
    kind: c.kind,
    message: c.message,
    instruction_id: c.instruction_id || undefined,
    fire_kind: c.fire_kind,
    instrument: c.instrument,
  };
  const inTelegram = tg && tg.initData && typeof tg.sendData === "function";
  if (inTelegram) {
    try {
      tg.sendData(JSON.stringify(payload));
    } catch (_) {
      /* host may still ingest via webhook */
    }
  }
  let recorded = null;
  if (!inTelegram || previewState()) {
    try {
      recorded = await api("/api/v1/mini-app/compose", {
        method: "POST",
        body: payload,
      });
    } catch (_) {
      recorded = null;
    }
  }
  if (c.kind === "pause" || c.kind === "resume") {
    if (c.instruction_id) state.pending[c.instruction_id] = c.kind;
  }
  if (c.kind !== "question") {
    const id =
      (recorded && recorded.instruction && recorded.instruction.instruction_id) ||
      c.instruction_id ||
      correlation_id;
    const row = {
      instruction_id: id,
      sentence: c.message,
      status: "with_aomi",
      display_status: "with aomi",
      kind: c.kind,
      correlation_id,
      created_at: nowSecs(),
      updated_at: nowSecs(),
    };
    state.optimistic = state.optimistic.filter((r) => r.instruction_id !== id).concat([row]);
    state.sent = { id, kind: c.kind, message: c.message, question: false };
  } else {
    state.sent = { id: null, kind: c.kind, message: c.message, question: true };
  }
  state.view = "sent";
  paint();
  refreshLedger();
}

function renderSent() {
  const s = state.sent;
  const row = s.id ? instructions().find((r) => r.instruction_id === s.id) : null;
  app.innerHTML =
    headerHtml("inner") +
    `<div class="screen">
      <div class="kicker">${escapeHtml(C.sent.label)}</div>
      <h2>${escapeHtml(C.sent.headline)}</h2>
      <p class="msg">${escapeHtml(s.message)}</p>
      ${
        s.question
          ? `<p class="note">${escapeHtml(C.sent.askNote)}</p>`
          : `<div class="mini-card" id="sentCard"><div class="title">${escapeHtml((row && row.sentence) || s.message)}</div><div class="chip">${escapeHtml((row && row.display_status) || "with aomi")}</div><p class="sub">${escapeHtml(C.sub.withAomi)}</p></div><p class="note">${escapeHtml(C.sent.cardNote)}</p>`
      }
      <button type="button" class="ghost-btn" id="openThread">${escapeHtml(C.sent.openThread)}</button>
    </div>` +
    bottomHtml();
  bindChrome();
  const card = document.getElementById("sentCard");
  if (card) {
    card.onclick = () => {
      state.view = "main";
      state.tab = "ledger";
      state.sheet = "instruction";
      state.insId = s.id;
      state.detent = "half";
      paint();
    };
  }
  const t = document.getElementById("openThread");
  if (t) t.onclick = () => openThreadLink();
}

function renderBlocked() {
  const b = state.blocked || {};
  app.innerHTML =
    headerHtml("inner") +
    `<div class="screen">
      <div class="kicker">${escapeHtml(C.gate.label)}</div>
      <h2>${escapeHtml(C.gate.headline)}</h2>
      <p class="msg">${escapeHtml(fillCopy(C.gate.line, { act: b.act || "This", n: b.n || "—", floor: b.floor || "—" }))}</p>
      <p class="note">${escapeHtml(C.gate.note)}</p>
      <button type="button" class="ghost-btn" id="gateAsk">${escapeHtml(C.gate.act)}</button>
      <p class="hint">${escapeHtml(C.gate.footer)}</p>
    </div>` +
    bottomHtml();
  bindChrome();
  const ask = document.getElementById("gateAsk");
  if (ask) {
    ask.onclick = () =>
      openCompose({ kind: "question", message: "Walk me through this policy gate.", slide: false });
  }
}

function openThreadLink() {
  if (tg && typeof tg.close === "function") tg.close();
}

let voiceRecorder = null;
let voiceChunks = [];
let voiceStream = null;
let voiceWanted = false;

function bindVoice() {
  const btn = document.getElementById("voiceBtn");
  if (!btn) return;
  btn.addEventListener("contextmenu", (ev) => ev.preventDefault());
  btn.addEventListener("pointerdown", (ev) => {
    if (ev.button != null && ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    try {
      btn.setPointerCapture(ev.pointerId);
    } catch (_) {
      /* capture optional */
    }
    startVoice(btn);
  });
  const end = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    finishVoice(btn);
  };
  btn.addEventListener("pointerup", end);
  btn.addEventListener("pointercancel", (ev) => {
    ev.preventDefault();
    abortVoice(btn);
  });
}

async function startVoice(btn) {
  if (voiceWanted) return;
  voiceWanted = true;
  voiceChunks = [];
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    voiceWanted = false;
    showToast(C.toasts.voiceDenied);
    return;
  }
  try {
    voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (_) {
    voiceWanted = false;
    showToast(C.toasts.voiceDenied);
    return;
  }
  if (!voiceWanted) {
    abortVoice(btn);
    return;
  }
  const mime = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
    ? "audio/webm;codecs=opus"
    : MediaRecorder.isTypeSupported("audio/webm")
      ? "audio/webm"
      : "";
  try {
    voiceRecorder = mime ? new MediaRecorder(voiceStream, { mimeType: mime }) : new MediaRecorder(voiceStream);
  } catch (_) {
    abortVoice(btn);
    showToast(C.toasts.voiceDenied);
    return;
  }
  voiceRecorder.ondataavailable = (ev) => {
    if (ev.data && ev.data.size) voiceChunks.push(ev.data);
  };
  voiceRecorder.start();
  btn.classList.add("hot");
  btn.setAttribute("aria-label", C.voice.recording);
  haptic("impact", "medium");
}

function abortVoice(btn) {
  voiceWanted = false;
  try {
    if (voiceRecorder && voiceRecorder.state !== "inactive") voiceRecorder.stop();
  } catch (_) {
    /* ignore */
  }
  voiceRecorder = null;
  voiceChunks = [];
  if (voiceStream) {
    voiceStream.getTracks().forEach((t) => t.stop());
    voiceStream = null;
  }
  if (btn) {
    btn.classList.remove("hot");
    btn.setAttribute("aria-label", C.voice.hold);
  }
}

function finishVoice(btn) {
  if (!voiceWanted || !voiceRecorder) {
    abortVoice(btn);
    return;
  }
  const recorder = voiceRecorder;
  const mime = recorder.mimeType || "audio/webm";
  recorder.onstop = async () => {
    const blob = new Blob(voiceChunks, { type: mime });
    abortVoice(btn);
    if (!blob.size) {
      showToast(C.toasts.voiceEmpty);
      return;
    }
    btn.classList.add("sending");
    showToast(C.voice.sending);
    try {
      const audio_base64 = await blobToBase64(blob);
      const out = await api("/api/v1/mini-app/voice", {
        method: "POST",
        body: { audio_base64, mime: blob.type || mime },
      });
      const heard = (out && out.transcript) || "";
      if (heard) showToast(fillCopy(C.toasts.voiceHeard, { text: heard }));
      else showToast((out && out.speech) || C.toasts.voiceEmpty);
    } catch (_) {
      showToast(C.toasts.voiceFailed);
    } finally {
      btn.classList.remove("sending");
    }
  };
  try {
    recorder.stop();
  } catch (_) {
    abortVoice(btn);
    showToast(C.toasts.voiceFailed);
  }
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const data = String(reader.result || "");
      const comma = data.indexOf(",");
      resolve(comma >= 0 ? data.slice(comma + 1) : data);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

async function api(path, opts) {
  const headers = { Authorization: "Bearer " + sessionToken };
  const init = { headers };
  if (opts && opts.method) {
    init.method = opts.method;
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.body || {});
  }
  const res = await fetch(path, init);
  if (res.status === 401) throw new Error("unauthorized");
  if (res.status === 404) throw new Error("not_found");
  if (!res.ok) throw new Error("http");
  return res.json();
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

async function refreshLedger() {
  try {
    const [sum, led] = await Promise.all([
      api("/api/v1/mini-app/ledger/summary"),
      api("/api/v1/mini-app/ledger"),
    ]);
    const prev = Object.fromEntries(instructions().map((r) => [r.instruction_id, r.status]));
    state.summary = {
      holding: sum.holding,
      needs_you: sum.needs_you,
      last_check_at: sum.last_check_at,
    };
    state.ledger = led.instructions || [];
    state.ledgerStatus = "ok";
    const ids = new Set(state.ledger.map((r) => r.instruction_id));
    state.optimistic = state.optimistic.filter((r) => !ids.has(r.instruction_id));
    for (const row of state.ledger) {
      if (state.pending[row.instruction_id] && row.status !== prev[row.instruction_id]) {
        delete state.pending[row.instruction_id];
        if (row.status === "paused") showToast(C.toasts.paused);
        if (row.status === "watching") showToast(fillCopy(C.toasts.watching, { date: fmtDate(row.expires_at) }));
      } else if (prev[row.instruction_id] && prev[row.instruction_id] !== row.status) {
        if (row.status === "awaiting_confirm") showToast(fillCopy(C.toasts.trigger, { detail: row.sentence }));
        if (row.status === "done") showToast(C.toasts.executed);
      }
    }
    if (state.view === "main" || state.view === "sent") paint();
  } catch (err) {
    if (err.message === "unauthorized") return renderUnauthorized();
    if (!state.ledger.length) state.ledgerStatus = "error";
    else state.ledgerStatus = "stale";
    if (state.view === "main") paint();
  }
}

function startPoll() {
  clearInterval(pollTimer);
  clearInterval(ageTimer);
  pollTimer = setInterval(refreshLedger, 2000);
  ageTimer = setInterval(() => {
    if (state.view === "main" && !state.searchOpen) paint();
  }, 1000);
}

function renderUnauthorized() {
  app.innerHTML =
    headerHtml("root") +
    `<div class="center"><p>${escapeHtml(C.unauthorized)}</p></div>` +
    bottomHtml();
  bindChrome();
}

function renderError(retry) {
  haptic("notify", "error");
  app.innerHTML =
    headerHtml("root") +
    `<div class="center"><p>${escapeHtml(C.loadError)}</p></div>
     <div class="pad"><button type="button" class="primary-btn" id="retry">${escapeHtml(C.retry)}</button></div>` +
    bottomHtml();
  bindChrome();
  const r = document.getElementById("retry");
  if (r) r.onclick = retry;
}

const PREVIEW_PORTFOLIO = {
  positions: [
    { symbol: "ETH", quantity: "2.35", usd_value: "8432.50", asset_type: "spot", group: "holdings", extra: "free collateral", can_exit: true, watch_count: 1, keywords: "ETH spot" },
    { symbol: "ETH-PERP", quantity: "1.20", usd_value: "4310.00", asset_type: "perp", group: "positions", extra: "floor $2410.00", can_exit: true, watch_count: 2, keywords: "ETH perp", side: "long" },
    { symbol: "USDC", quantity: "2000", usd_value: "2000.00", asset_type: "lend", group: "lending", extra: "fixed term", can_exit: false, watch_count: 1, keywords: "USDC lend" },
  ],
  dollarpower: { ratio: "6.8", equivalent_usd: "43100.00", committed_usd: "6338.00", fill_pct: "15", is_estimate: false },
  risk: { liquidation_score: 7.8, band: "safe", distance_from_floor_pct: "47", is_estimate: false },
  total_usd_value: "24761.18",
  total_change_24h_pct: "1.30",
  floor: "2410.00",
  flags: { primary_view: "ledger", jobline_negative: false, family: "blue" },
};

const PREVIEW_PRODUCTS = [
  { id: "spot:ETH", symbol: "ETH", name: "Ether", product: "spot", quote_symbol: "USDT", mark_price: "3588.12", keywords: "ETH ether spot usdt" },
  { id: "perp:ETH", symbol: "ETH", name: "Ether", product: "perp", quote_symbol: "USDT", mark_price: "3588.12", keywords: "ETH ether perp perpetual usdt" },
  { id: "lend:ETH", symbol: "ETH", name: "Ether", product: "lend", mark_price: "3588.12", keywords: "ETH ether lend lending" },
  { id: "spot:WBTC", symbol: "WBTC", name: "Wrapped Bitcoin", product: "spot", quote_symbol: "USDT", mark_price: "97500.00", keywords: "WBTC wrapped bitcoin btc spot usdt" },
  { id: "perp:WBTC", symbol: "WBTC", name: "Wrapped Bitcoin", product: "perp", quote_symbol: "USDT", mark_price: "97500.00", keywords: "WBTC wrapped bitcoin btc perp perpetual usdt" },
  { id: "lend:WBTC", symbol: "WBTC", name: "Wrapped Bitcoin", product: "lend", mark_price: "97500.00", keywords: "WBTC wrapped bitcoin btc lend lending" },
  { id: "spot:SOL", symbol: "SOL", name: "Solana", product: "spot", quote_symbol: "USDT", mark_price: "178.40", keywords: "SOL solana spot usdt" },
  { id: "perp:SOL", symbol: "SOL", name: "Solana", product: "perp", quote_symbol: "USDT", mark_price: "178.40", keywords: "SOL solana perp perpetual usdt" },
  { id: "lend:SOL", symbol: "SOL", name: "Solana", product: "lend", mark_price: "178.40", keywords: "SOL solana lend lending" },
  { id: "lend:USDC", symbol: "USDC", name: "USD Coin", product: "lend", mark_price: "1", keywords: "USDC usd coin lend lending" },
  { id: "lend:USDT", symbol: "USDT", name: "Tether", product: "lend", mark_price: "1", keywords: "USDT tether lend lending" },
];

function previewBoot() {
  const pv = previewState();
  state.portfolio = PREVIEW_PORTFOLIO;
  state.products = PREVIEW_PRODUCTS;
  state.flags = PREVIEW_PORTFOLIO.flags;
  if (pv === "empty") {
    state.ledger = [];
    state.summary = { holding: 0, needs_you: 0, last_check_at: null };
    state.ledgerStatus = "ok";
    state.compact = false;
    return paint();
  }
  if (pv === "error") {
    state.ledgerStatus = "error";
    state.compact = false;
    return paint();
  }
  if (pv === "unauthorized") return renderUnauthorized();
  state.ledger = [
    {
      instruction_id: "roll",
      task_id: "roll",
      status: "awaiting_confirm",
      display_status: "needs you",
      sentence: "At maturity, roll the lend into the 30-day if the rate holds at 9% or better",
      kind: "conditional",
      fire_kind: "act",
      expires_at: nowSecs() + 86400 * 5,
    },
    {
      instruction_id: "perp",
      task_id: "perp",
      status: "watching",
      display_status: "watching",
      sentence: "If ETH touches $3,400, close half the perp",
      kind: "conditional",
      fire_kind: "act",
      check_stats: { last_check_at: nowSecs() - 4, checks_7d: 12 },
      expires_at: nowSecs() + 86400 * 18,
      distance: { mark: "3588", pct: 72, near: true },
    },
    {
      instruction_id: "floor",
      task_id: "floor",
      status: "watching",
      display_status: "watching",
      sentence: "If ETH drops to $2,650 (floor +10%), tell me",
      kind: "watch",
      fire_kind: "tell",
      check_stats: { last_check_at: nowSecs() - 4, checks_7d: 8 },
      expires_at: nowSecs() + 86400 * 26,
      distance: { mark: "3588", pct: 26, near: false },
    },
  ];
  state.summary = { holding: 3, needs_you: 1, last_check_at: nowSecs() - 4 };
  state.ledgerStatus = "ok";
  state.compact = pv !== "loaded";
  paint();
}

function chartParams() {
  const q = new URLSearchParams(location.search);
  let symbol = q.get("symbol");
  let period = (q.get("period") || "").toLowerCase();
  const start = startParam();
  if (!symbol) {
    const parsed = parseChartStart(start);
    if (parsed) {
      symbol = parsed.symbol;
      period = period || parsed.period;
    }
  }
  const onChart =
    location.pathname === "/chart" || location.pathname.endsWith("/chart") || !!symbol;
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
  return "$" + v.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
}

function mountCandles(el, bars) {
  destroyChart();
  const LC = window.LightweightCharts;
  if (!LC || !el) return false;
  chartHandle = LC.createChart(el, {
    layout: {
      background: { color: "#0e1116" },
      textColor: "rgba(232,237,243,0.55)",
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    },
    grid: {
      vertLines: { color: "rgba(151,168,190,0.08)" },
      horzLines: { color: "rgba(151,168,190,0.08)" },
    },
    rightPriceScale: { borderColor: "rgba(151,168,190,0.13)" },
    timeScale: { borderColor: "rgba(151,168,190,0.13)", timeVisible: true, secondsVisible: false },
    crosshair: { mode: LC.CrosshairMode.Normal },
    handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true },
    handleScale: { axisPressedMouseMove: true, pinch: true, mouseWheel: true },
  });
  candleSeries = chartHandle.addCandlestickSeries({
    upColor: "#46c08a",
    downColor: "#f07878",
    wickUpColor: "#46c08a",
    wickDownColor: "#f07878",
    borderVisible: false,
  });
  candleSeries.setData(
    bars
      .filter((b) => Number.isFinite(b.t) && Number.isFinite(b.o))
      .map((b) => ({ time: b.t, open: b.o, high: b.h, low: b.l, close: b.c })),
  );
  chartHandle.timeScale().fitContent();
  const ro = new ResizeObserver(() => {
    if (!chartHandle) return;
    chartHandle.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  });
  ro.observe(el);
  chartHandle.applyOptions({ width: el.clientWidth, height: el.clientHeight });
  return true;
}

function renderChartShell(params, status, data) {
  document.body.className = "page-chart";
  document.title = params.symbol + " · World Markets";
  const last = data && data.candles && data.candles.length ? data.candles[data.candles.length - 1] : null;
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
  if (status === "loading") body = `<p class="chart-sub">Loading…</p><div class="skel"></div>`;
  else if (status === "error") body = `<div class="center"><p>Could not load chart</p></div>`;
  else if (status === "empty") body = `<div class="center"><p>No bars for ${escapeHtml(params.symbol)}.</p></div>`;
  else body = `<div id="plot"></div>`;
  app.innerHTML = `${headerHtml("inner")}
    <div class="chart-page">
      <div class="chart-meta">
        <span class="chart-sym">${escapeHtml(params.symbol)}</span>
        <span class="chart-px num ${up ? "up" : "down"}">${px}</span>
      </div>
      <div class="chart-sub">${sub}</div>
      <div class="periods">${periods}</div>
      ${body}
    </div>`;
  bindChrome();
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
  if (status === "ready") {
    const plot = document.getElementById("plot");
    if (!mountCandles(plot, data.candles)) {
      plot.innerHTML = `<div class="center"><p>Chart library failed to load.</p></div>`;
    }
  }
}

async function loadChartView(params) {
  state.view = "chart";
  renderChartShell(params, "loading", null);
  const initData = (tg && tg.initData) || (previewState() === "dev" ? "dev" : "");
  try {
    const token = await ensureSession(initData);
    sessionToken = token;
    const res = await fetch(
      "/api/v1/mini-app/chart?symbol=" +
        encodeURIComponent(params.symbol) +
        "&period=" +
        encodeURIComponent(params.period),
      { headers: { Authorization: "Bearer " + token } },
    );
    if (res.status === 401) return renderUnauthorized();
    if (res.status === 404) return renderChartShell(params, "empty", null);
    if (!res.ok) return renderChartShell(params, "error", null);
    const data = await res.json();
    if (!data.candles || data.candles.length === 0) return renderChartShell(params, "empty", data);
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
  if (chart) return loadChartView(chart);
  if (preview && preview !== "dev") return previewBoot();

  state.ledgerStatus = "loading";
  paint();
  const initData = (tg && tg.initData) || (preview === "dev" ? "dev" : "");
  try {
    await ensureSession(initData);
    const [port, catalog] = await Promise.all([
      api("/api/v1/mini-app/portfolio"),
      api("/api/v1/mini-app/products").catch(() => ({ products: [] })),
    ]);
    state.portfolio = port;
    state.products = catalog.products || [];
    if (port.flags) state.flags = port.flags;
    if (state.flags.primary_view === "portfolio") state.tab = "portfolio";
    await refreshLedger();
    state.compact = Boolean(tg && !tg.isExpanded);
    const deep = instructionStart(startParam());
    if (deep) {
      try {
        const one = await api("/api/v1/mini-app/ledger/" + encodeURIComponent(deep));
        const ins = one.instruction || one;
        if (ins && ins.instruction_id) {
          const idx = state.ledger.findIndex((r) => r.instruction_id === ins.instruction_id);
          if (idx >= 0) state.ledger[idx] = { ...state.ledger[idx], ...ins };
          else state.ledger.push(ins);
          state.compact = false;
          state.sheet = "instruction";
          state.insId = ins.instruction_id;
          state.detent = "half";
        }
      } catch (_) {
        /* stale/foreign id — default view */
      }
    }
    paint();
    startPoll();
  } catch (err) {
    if (err && err.message === "unauthorized") return renderUnauthorized();
    renderError(() => boot());
  }
}

boot();
