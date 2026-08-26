#!/usr/bin/env node
/**
 * Unsigned brain sidecar. News, history, watches, preferences, outbound queue.
 * Never holds WORLD_PRIVATE_KEY. Never places an order.
 */

import { createServer } from "node:http";
import { dirname, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gatherNews } from "./news/index.js";
import {
  markAtOrBefore,
  movePct,
  recordAccount,
  recordFunding,
  recordMark,
} from "./history.js";
import { sampleWatched } from "./venue.js";
import { portfolioImpact } from "./impact.js";
import {
  cancelPreference,
  listPreferences,
  seedBrief,
  upsertPreference,
} from "./preferences.js";
import {
  allActiveWatches,
  cancelWatch,
  evaluateAll,
  listWatches,
  pauseWatch,
  resumeWatch,
  setWatch,
  watchedAccounts,
} from "./watches.js";
import {
  composeDraft,
  getInstruction,
  laborStats,
  listInstructions,
  summary as ledgerSummary,
  watchCountsByInstrument,
} from "./instructions.js";
import { drain, peek } from "./outbound.js";
import { resolvePredicate } from "./resolve.js";
import { dataDir } from "./store.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
loadDotEnv(resolve(ROOT, ".env"));

const PORT = Number(process.env.WORLD_BRAIN_PORT || 8788);
const HOST = process.env.WORLD_BRAIN_HOST || "127.0.0.1";
const TICK_MS = Number(process.env.WORLD_BRAIN_TICK_MS || 60_000);

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    if (!res.headersSent) {
      send(res, 500, { ok: false, error: publicError(error) });
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`[brain] ${HOST}:${PORT} dir=${dataDir()} (unsigned)`);
  startTicker();
});

function startTicker() {
  const tick = async () => {
    try {
      const watches = allActiveWatches();
      const accounts = watchedAccounts();
      await sampleWatched({ watches, accounts });
      evaluateAll();
    } catch (error) {
      console.error("[brain] tick failed:", publicError(error));
    }
  };
  tick();
  setInterval(tick, TICK_MS);
}

async function handle(req, res) {
  const url = new URL(req.url || "/", `http://${HOST}`);
  if (req.method === "GET" && url.pathname === "/health") {
    send(res, 200, {
      ok: true,
      unsigned: true,
      data_dir: dataDir(),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/research") {
    const symbol = url.searchParams.get("symbol") || "";
    const windowSecs = Number(url.searchParams.get("window_secs") || 86400);
    const now = Math.floor(Date.now() / 1000);
    const news = await gatherNews({ symbol, windowSecs, now });
    const move = movePct(symbol, windowSecs, now);
    send(res, 200, { ok: true, ...news, move, window_secs: windowSecs });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/history/move") {
    const symbol = url.searchParams.get("symbol") || "";
    const windowSecs = Number(url.searchParams.get("window_secs") || 86400);
    const now = Math.floor(Date.now() / 1000);
    send(res, 200, {
      ok: true,
      move: movePct(symbol, windowSecs, now),
      mark_then: markAtOrBefore(symbol, now - windowSecs),
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/tasks") {
    const accountId = url.searchParams.get("account_id");
    if (!accountId) {
      send(res, 400, { ok: false, error: "account_id is required" });
      return;
    }
    send(res, 200, {
      ok: true,
      watches: listWatches(accountId),
      preferences: listPreferences(accountId),
      ledger: {
        ...ledgerSummary(accountId),
        labor: laborStats(accountId),
      },
    });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/outbound/peek") {
    send(res, 200, { ok: true, items: peek() });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/ledger/summary") {
    const accountId = url.searchParams.get("account_id");
    if (!accountId) {
      send(res, 400, { ok: false, error: "account_id is required" });
      return;
    }
    send(res, 200, { ok: true, ...ledgerSummary(accountId) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/v1/ledger") {
    const accountId = url.searchParams.get("account_id");
    if (!accountId) {
      send(res, 400, { ok: false, error: "account_id is required" });
      return;
    }
    send(res, 200, {
      ok: true,
      instructions: listInstructions(accountId),
      watch_counts: watchCountsByInstrument(accountId),
      labor: laborStats(accountId),
    });
    return;
  }
  if (req.method === "GET" && url.pathname.startsWith("/v1/ledger/")) {
    const accountId = url.searchParams.get("account_id");
    const id = decodeURIComponent(url.pathname.slice("/v1/ledger/".length));
    if (!accountId || !id || id === "summary") {
      send(res, 400, { ok: false, error: "account_id and id are required" });
      return;
    }
    const instruction = getInstruction(accountId, id);
    if (!instruction) {
      send(res, 404, { ok: false, error: "not_found" });
      return;
    }
    send(res, 200, { ok: true, instruction });
    return;
  }
  if (req.method !== "POST") {
    send(res, 404, { ok: false, error: "not found" });
    return;
  }
  const body = await readJson(req);
  switch (url.pathname) {
    case "/v1/history/ingest":
      ingest(body);
      send(res, 200, { ok: true });
      return;
    case "/v1/portfolio-impact":
      send(res, 200, { ok: true, impact: await portfolioImpact(body) });
      return;
    case "/v1/watches/resolve":
      send(res, 200, { ok: true, ...resolvePredicate(body) });
      return;
    case "/v1/watches":
      send(res, 200, setWatch(accountIdOf(body), body));
      return;
    case "/v1/watches/cancel":
      send(res, 200, cancelWatch(accountIdOf(body), body.id));
      return;
    case "/v1/watches/pause":
      send(res, 200, pauseWatch(accountIdOf(body), body.id, body.instruction_id));
      return;
    case "/v1/watches/resume":
      send(res, 200, resumeWatch(accountIdOf(body), body.id, body.instruction_id));
      return;
    case "/v1/compose":
      send(res, 200, composeDraft(accountIdOf(body), body));
      return;
    case "/v1/preferences":
      send(res, 200, upsertPreference(accountIdOf(body), body));
      return;
    case "/v1/preferences/cancel":
      send(res, 200, cancelPreference(accountIdOf(body), body.id));
      return;
    case "/v1/preferences/seed":
      seedBrief(accountIdOf(body), body.brief);
      send(res, 200, { ok: true, preferences: listPreferences(accountIdOf(body)) });
      return;
    case "/v1/evaluate":
      evaluateAll();
      send(res, 200, { ok: true });
      return;
    case "/v1/outbound/drain":
      send(res, 200, { ok: true, items: drain(Number(body.limit) || 50) });
      return;
    default:
      send(res, 404, { ok: false, error: "not found" });
  }
}

function ingest(body) {
  const ts = Number(body.ts) || Math.floor(Date.now() / 1000);
  if (Array.isArray(body.marks)) {
    for (const row of body.marks) {
      recordMark({ ...row, ts: row.ts || ts });
    }
  }
  if (body.mark && body.symbol) {
    recordMark({
      symbol: body.symbol,
      token_id: body.token_id,
      mark: body.mark,
      ts,
    });
  }
  if (Array.isArray(body.funding)) {
    for (const row of body.funding) {
      recordFunding({ ...row, ts: row.ts || ts });
    }
  }
  if (body.account_id != null) {
    recordAccount({ ...body, ts });
  }
}

function accountIdOf(body) {
  const id = body.account_id;
  if (id == null || id === "") throw new Error("account_id is required");
  return String(id);
}

function send(res, status, body) {
  const raw = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(raw),
  });
  res.end(raw);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function publicError(error) {
  return error?.message || String(error);
}

function loadDotEnv(path) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] == null) process.env[key] = value;
  }
}
