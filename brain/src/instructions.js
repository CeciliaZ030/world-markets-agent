import { filePath, readJson, writeJson } from "./store.js";
import { latestMark } from "./history.js";

export const VISIBILITY_SECS = 90 * 24 * 60 * 60;
const NEAR_MISS_BAND = 0.02;

const STATUSES = new Set([
  "with_aomi",
  "watching",
  "triggered",
  "awaiting_confirm",
  "executing",
  "done",
  "declined",
  "paused",
  "expired",
  "revoked",
]);

const ALLOWED = {
  with_aomi: ["watching", "declined", "expired", "revoked"],
  watching: [
    "triggered",
    "awaiting_confirm",
    "paused",
    "expired",
    "revoked",
    "done",
    "executing",
  ],
  triggered: ["awaiting_confirm", "executing", "done", "watching"],
  awaiting_confirm: ["executing", "declined", "watching", "done", "revoked"],
  executing: ["done"],
  paused: ["watching", "revoked", "expired"],
  done: [],
  declined: [],
  expired: [],
  revoked: [],
};

const EVENT_TYPES = new Set([
  "heard",
  "parsed",
  "sent_to_thread",
  "confirmed",
  "declined",
  "check",
  "near_miss",
  "triggered",
  "confirm_requested",
  "executed",
  "blocked",
  "reported",
  "paused",
  "resumed",
  "expired",
  "revoked",
  "edited",
]);

function itemsPath(accountId) {
  return filePath("instructions", `${accountId}.json`);
}

function eventsPath(accountId) {
  return filePath("instruction_events", `${accountId}.json`);
}

function loadItems(accountId) {
  return readJson(itemsPath(accountId), { items: [] });
}

function saveItems(accountId, data) {
  writeJson(itemsPath(accountId), data);
}

function loadEvents(accountId) {
  return readJson(eventsPath(accountId), { items: [] });
}

function saveEvents(accountId, data) {
  writeJson(eventsPath(accountId), data);
}

export function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `i-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

function nowSecs(now) {
  return Number.isFinite(now) ? now : Math.floor(Date.now() / 1000);
}

function findItem(data, instructionId) {
  return (data.items || []).find((row) => row.instruction_id === instructionId);
}

export function transition(item, next, now) {
  if (!STATUSES.has(next)) {
    throw new Error(`illegal_status:${next}`);
  }
  const allowed = ALLOWED[item.status] || [];
  if (item.status === next) return item;
  if (!allowed.includes(next)) {
    throw new Error(`illegal_transition:${item.status}->${next}`);
  }
  item.status = next;
  item.status_changed_at = now;
  item.updated_at = now;
  return item;
}

export function appendEvent(accountId, instructionId, eventType, detail, now, extra = {}) {
  if (!EVENT_TYPES.has(eventType)) {
    throw new Error(`illegal_event:${eventType}`);
  }
  const data = loadEvents(accountId);
  data.items = data.items || [];
  const prior = data.items.filter((row) => row.instruction_id === instructionId);
  const seq = prior.length + 1;
  const event = {
    instruction_id: instructionId,
    seq,
    event_type: eventType,
    at: nowSecs(now),
    ref: extra.ref || null,
    actor: extra.actor || actorFor(eventType),
    detail: detail || "",
    signed: Boolean(extra.signed),
  };
  data.items.push(event);
  saveEvents(accountId, data);
  return event;
}

function actorFor(eventType) {
  if (eventType === "heard" || eventType === "confirmed" || eventType === "declined") {
    return "you";
  }
  if (eventType === "check" || eventType === "near_miss") return "watcher";
  if (
    eventType === "executed" ||
    eventType === "triggered" ||
    eventType === "blocked" ||
    eventType === "reported"
  ) {
    return "engine";
  }
  return "aomi";
}

export function composeDraft(accountId, body, now = nowSecs()) {
  const kind = body.kind || "conditional";
  if (kind === "question") {
    return { ok: true, recorded: false, kind };
  }
  const instructionId = body.instruction_id || newId();
  const data = loadItems(accountId);
  data.items = data.items || [];
  let item = findItem(data, instructionId);
  const sentence = String(body.message || body.sentence || "").trim().slice(0, 160);
  if (!sentence) {
    return { ok: false, error: "sentence_required" };
  }

  if (kind === "pause" || kind === "resume") {
    if (!item) return { ok: false, error: "not_found" };
    item.pending = kind;
    item.updated_at = now;
    saveItems(accountId, data);
    appendEvent(
      accountId,
      instructionId,
      "sent_to_thread",
      kind === "pause" ? "pause sent to thread" : "resume sent to thread",
      now,
      { ref: body.correlation_id || null },
    );
    return { ok: true, recorded: true, instruction: cardOf(item, accountId) };
  }

  if (item) {
    return { ok: true, recorded: true, instruction: cardOf(item, accountId), duplicate: true };
  }

  item = {
    instruction_id: instructionId,
    account_id: Number(accountId) || accountId,
    kind: kind === "watch" ? "watch" : kind,
    sentence,
    params: body.params || {},
    status: "with_aomi",
    policy_scope: body.policy_scope || null,
    source_ref: body.correlation_id || body.source_ref || instructionId,
    confirm_ref: null,
    result_ref: null,
    watch_id: null,
    correlation_id: body.correlation_id || instructionId,
    expires_at: body.expires_at || null,
    check_stats: { last_check_at: null, checks_7d: 0 },
    pending: null,
    fire_kind: body.fire_kind || (kind === "watch" ? "tell" : "act"),
    instrument: body.instrument || body.params?.instrument || null,
    created_at: now,
    updated_at: now,
    status_changed_at: now,
  };
  data.items.push(item);
  saveItems(accountId, data);
  appendEvent(accountId, instructionId, "sent_to_thread", sentence, now, {
    ref: item.source_ref,
    actor: "you",
  });
  return { ok: true, recorded: true, instruction: cardOf(item, accountId) };
}

export function confirmInstruction(accountId, body, now = nowSecs()) {
  const data = loadItems(accountId);
  data.items = data.items || [];
  let item = body.instruction_id ? findItem(data, body.instruction_id) : null;
  if (!item && body.correlation_id) {
    item = data.items.find((row) => row.correlation_id === body.correlation_id);
  }
  if (!item) {
    item = {
      instruction_id: body.instruction_id || newId(),
      account_id: Number(accountId) || accountId,
      kind: body.kind || "watch",
      sentence: String(body.sentence || body.phrase || "").slice(0, 160),
      params: body.params || {},
      status: "with_aomi",
      policy_scope: body.policy_scope || null,
      source_ref: body.source_ref || body.watch_id || body.instruction_id,
      confirm_ref: null,
      result_ref: null,
      watch_id: body.watch_id || null,
      correlation_id: body.correlation_id || null,
      expires_at: body.expires_at || null,
      check_stats: { last_check_at: null, checks_7d: 0 },
      pending: null,
      fire_kind: body.fire_kind || "tell",
      instrument: body.instrument || body.params?.instrument || body.symbol || null,
      created_at: now,
      updated_at: now,
      status_changed_at: now,
    };
    if (!item.sentence || !item.source_ref) {
      return { ok: false, error: "untraceable" };
    }
    data.items.push(item);
  }
  if (item.status === "with_aomi") {
    transition(item, "watching", now);
  }
  item.confirm_ref = body.confirm_ref || body.watch_id || item.confirm_ref;
  item.watch_id = body.watch_id || item.watch_id;
  item.expires_at = body.expires_at || item.expires_at;
  item.params = body.params || item.params;
  item.pending = null;
  item.updated_at = now;
  saveItems(accountId, data);
  appendEvent(accountId, item.instruction_id, "confirmed", "Confirmed.", now, {
    signed: true,
    ref: item.confirm_ref,
    actor: "you",
  });
  return { ok: true, instruction: cardOf(item, accountId) };
}

export function attachWatch(accountId, watch, now = nowSecs()) {
  return confirmInstruction(accountId, {
    instruction_id: watch.instruction_id,
    correlation_id: watch.correlation_id,
    sentence: watch.original_phrase || watch.predicate?.resolved,
    phrase: watch.original_phrase,
    params: watch.predicate,
    watch_id: watch.id,
    source_ref: watch.id,
    expires_at: watch.expires_at,
    kind: "watch",
    fire_kind: "tell",
    instrument: watch.predicate?.symbol || watch.symbol,
    symbol: watch.predicate?.symbol,
  }, now);
}

export function pauseInstruction(accountId, instructionId, now = nowSecs()) {
  const data = loadItems(accountId);
  const item = findItem(data, instructionId);
  if (!item) return { ok: false, error: "not_found" };
  transition(item, "paused", now);
  item.pending = null;
  saveItems(accountId, data);
  appendEvent(accountId, instructionId, "paused", "Paused.", now, {
    signed: true,
    actor: "you",
  });
  return { ok: true, instruction: cardOf(item, accountId), watch_id: item.watch_id };
}

export function resumeInstruction(accountId, instructionId, now = nowSecs()) {
  const data = loadItems(accountId);
  const item = findItem(data, instructionId);
  if (!item) return { ok: false, error: "not_found" };
  transition(item, "watching", now);
  item.pending = null;
  saveItems(accountId, data);
  appendEvent(accountId, instructionId, "resumed", "Resumed.", now, {
    signed: true,
    actor: "you",
  });
  return { ok: true, instruction: cardOf(item, accountId), watch_id: item.watch_id };
}

export function revokeInstruction(accountId, instructionId, now = nowSecs()) {
  const data = loadItems(accountId);
  const item = findItem(data, instructionId);
  if (!item) return { ok: false, error: "not_found" };
  if (item.status !== "revoked") transition(item, "revoked", now);
  item.pending = null;
  saveItems(accountId, data);
  appendEvent(accountId, instructionId, "revoked", "Revoked.", now, { actor: "you" });
  return { ok: true, instruction: cardOf(item, accountId), watch_id: item.watch_id };
}

export function recordCheck(accountId, watch, result, now = nowSecs()) {
  if (!result?.ready) return;
  const data = loadItems(accountId);
  const item = (data.items || []).find((row) => row.watch_id === watch.id);
  if (!item || item.status !== "watching") return;
  item.check_stats = item.check_stats || { last_check_at: null, checks_7d: 0 };
  item.check_stats.last_check_at = now;
  item.check_stats.checks_7d = (item.check_stats.checks_7d || 0) + 1;
  item.updated_at = now;
  if (result.live != null) item.last_mark = String(result.live);
  saveItems(accountId, data);
  appendEvent(accountId, item.instruction_id, "check", "", now, { actor: "watcher" });
  maybeNearMiss(accountId, item, result, now);
}

function maybeNearMiss(accountId, item, result, now) {
  const level = Number(item.params?.level);
  const live = Number(result.live);
  if (!Number.isFinite(level) || !Number.isFinite(live) || level === 0) return;
  const band = Math.abs(live - level) / Math.abs(level);
  if (band > NEAR_MISS_BAND || result.true) return;
  const events = loadEvents(accountId).items || [];
  const recent = events
    .filter((row) => row.instruction_id === item.instruction_id && row.event_type === "near_miss")
    .pop();
  if (recent && now - recent.at < 3600) return;
  appendEvent(
    accountId,
    item.instruction_id,
    "near_miss",
    `Near miss — ${result.live} low, condition not held.`,
    now,
  );
}

export function onWatchFired(accountId, watch, result, now = nowSecs()) {
  const data = loadItems(accountId);
  const item = (data.items || []).find((row) => row.watch_id === watch.id);
  if (!item) return;
  const fireKind = item.fire_kind || "tell";
  if (fireKind === "act") {
    if (item.status === "watching") transition(item, "awaiting_confirm", now);
    appendEvent(
      accountId,
      item.instruction_id,
      "triggered",
      `Condition met — ${result.live ?? ""}. Confirm sent to thread.`,
      now,
    );
    appendEvent(accountId, item.instruction_id, "confirm_requested", "", now);
  } else {
    appendEvent(
      accountId,
      item.instruction_id,
      "triggered",
      `Condition met — ${result.live ?? ""}.`,
      now,
    );
    appendEvent(accountId, item.instruction_id, "reported", "told in the thread", now);
    if (watch.fire_mode === "once" && item.status === "watching") {
      transition(item, "done", now);
      item.result_ref = watch.id;
    }
  }
  item.updated_at = now;
  saveItems(accountId, data);
}

export function onWatchExpired(accountId, watch, now = nowSecs()) {
  const data = loadItems(accountId);
  const item = (data.items || []).find((row) => row.watch_id === watch.id);
  if (!item) return;
  if (item.status === "watching" || item.status === "paused" || item.status === "with_aomi") {
    transition(item, "expired", now);
  }
  saveItems(accountId, data);
  appendEvent(accountId, item.instruction_id, "expired", "expired — never met", now);
}

function displayStatus(status) {
  if (status === "with_aomi") return "with aomi";
  if (status === "triggered" || status === "awaiting_confirm") return "needs you";
  if (status === "executing") return null;
  if (status === "declined" || status === "revoked") return status === "declined" ? "done" : null;
  return status;
}

function distanceFor(item) {
  const level = Number(item.params?.level);
  const live = Number(item.last_mark);
  if (!Number.isFinite(level) || !Number.isFinite(live) || level === 0) {
    const mark = item.params?.symbol ? latestMark(item.params.symbol) : null;
    const liveMark = mark ? Number(mark.mark) : NaN;
    if (!Number.isFinite(liveMark) || !Number.isFinite(level) || level === 0) return null;
    return {
      mark: String(mark.mark),
      pct: Math.max(0, Math.min(100, Math.round((1 - Math.abs(liveMark - level) / Math.abs(level)) * 100))),
      near: Math.abs(liveMark - level) / Math.abs(level) <= 0.08,
    };
  }
  const pct = Math.max(
    0,
    Math.min(100, Math.round((1 - Math.abs(live - level) / Math.abs(level)) * 100)),
  );
  return { mark: item.last_mark, pct, near: Math.abs(live - level) / Math.abs(level) <= 0.08 };
}

function cardOf(item, accountId) {
  const events = loadEvents(accountId).items || [];
  const mine = events.filter((row) => row.instruction_id === item.instruction_id);
  const last = mine[mine.length - 1];
  return {
    instruction_id: item.instruction_id,
    kind: item.kind,
    sentence: item.sentence,
    status: item.status,
    display_status: displayStatus(item.status),
    progress_pct: item.progress_pct ?? null,
    slice_i: item.slice_i ?? null,
    slice_n: item.slice_n ?? null,
    avg_price: item.avg_price ?? null,
    instrument: item.instrument,
    params: item.params || {},
    expires_at: item.expires_at,
    check_stats: item.check_stats || { last_check_at: null, checks_7d: 0 },
    source_ref: item.source_ref,
    confirm_ref: item.confirm_ref,
    result_ref: item.result_ref,
    pending: item.pending || null,
    fire_kind: item.fire_kind || "tell",
    receipt: item.receipt || null,
    trigger_value: item.trigger_value || null,
    last_event_at: last?.at || item.updated_at,
    created_at: item.created_at,
    updated_at: item.updated_at,
    status_changed_at: item.status_changed_at,
    watch_id: item.watch_id,
    correlation_id: item.correlation_id,
    distance: item.status === "watching" ? distanceFor(item) : null,
    last_mark: item.last_mark || null,
  };
}

function trailOf(accountId, instructionId) {
  const events = (loadEvents(accountId).items || []).filter(
    (row) => row.instruction_id === instructionId,
  );
  const checks = events.filter((row) => row.event_type === "check");
  const rest = events.filter((row) => row.event_type !== "check");
  const lines = [];
  for (const event of rest) {
    if (event.event_type === "near_miss" && checks.length && !lines.some((l) => l.event_type === "check_aggregate")) {
      lines.push({
        event_type: "check_aggregate",
        at: event.at,
        actor: "watcher",
        line: `+${checks.length} checks — none met the condition.`,
        signed: false,
        ref: null,
      });
    }
    lines.push({
      event_type: event.event_type,
      at: event.at,
      actor: event.actor,
      line: event.detail || labelFor(event),
      signed: Boolean(event.signed) && Boolean(event.ref || event.event_type === "confirmed" || event.event_type === "paused" || event.event_type === "resumed"),
      ref: event.ref,
    });
  }
  if (checks.length && !lines.some((l) => l.event_type === "check_aggregate")) {
    const lastCheck = checks[checks.length - 1];
    lines.splice(
      Math.max(0, lines.findIndex((l) => l.event_type === "confirmed") + 1),
      0,
      {
        event_type: "check_aggregate",
        at: lastCheck.at,
        actor: "watcher",
        line: `+${checks.length} checks — none met the condition.`,
        signed: false,
        ref: null,
      },
    );
  }
  return lines.filter((row) => row.line);
}

function labelFor(event) {
  if (event.event_type === "confirmed") return "Confirmed.";
  if (event.event_type === "paused") return "Paused.";
  if (event.event_type === "resumed") return "Resumed.";
  if (event.event_type === "sent_to_thread") return event.detail || "";
  return event.detail || "";
}

function isActiveStatus(status) {
  return (
    status === "with_aomi" ||
    status === "watching" ||
    status === "triggered" ||
    status === "awaiting_confirm" ||
    status === "executing" ||
    status === "paused"
  );
}

function stillVisible(item, now) {
  if (item.status === "revoked") return false;
  if (isActiveStatus(item.status)) return true;
  const changed = item.status_changed_at || item.updated_at || item.created_at || 0;
  return now - changed < VISIBILITY_SECS;
}

function sortCards(a, b) {
  const rank = (status) => {
    if (status === "awaiting_confirm" || status === "triggered" || status === "with_aomi") return 0;
    if (status === "executing") return 1;
    if (status === "watching") return 2;
    if (status === "paused") return 3;
    if (status === "done") return 4;
    return 5;
  };
  const d = rank(a.status) - rank(b.status);
  if (d !== 0) return d;
  return (b.last_event_at || 0) - (a.last_event_at || 0);
}

export function listInstructions(accountId, now = nowSecs()) {
  const data = loadItems(accountId);
  const cards = (data.items || [])
    .filter((item) => stillVisible(item, now))
    .map((item) => cardOf(item, accountId))
    .sort(sortCards);
  return cards;
}

export function getInstruction(accountId, instructionId, now = nowSecs()) {
  const data = loadItems(accountId);
  const item = findItem(data, instructionId);
  if (!item || !stillVisible(item, now)) return null;
  return {
    ...cardOf(item, accountId),
    trail: trailOf(accountId, instructionId),
  };
}

export function summary(accountId, now = nowSecs()) {
  const cards = listInstructions(accountId, now);
  const holding = cards.filter((row) =>
    ["with_aomi", "watching", "triggered", "awaiting_confirm", "executing", "paused"].includes(
      row.status,
    ),
  ).length;
  const needsYou = cards.filter((row) =>
    ["triggered", "awaiting_confirm", "with_aomi"].includes(row.status),
  ).length;
  let lastCheck = null;
  for (const card of cards) {
    const at = card.check_stats?.last_check_at;
    if (at && (lastCheck == null || at > lastCheck)) lastCheck = at;
  }
  return {
    holding,
    needs_you: needsYou,
    last_check_at: lastCheck,
  };
}

export function watchCountsByInstrument(accountId, now = nowSecs()) {
  const counts = {};
  for (const card of listInstructions(accountId, now)) {
    if (card.status !== "watching") continue;
    const key = String(card.instrument || card.params?.symbol || "").toUpperCase();
    if (!key) continue;
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

export function laborStats(accountId, windowSecs = 7 * 86400, now = nowSecs()) {
  const events = loadEvents(accountId).items || [];
  const since = now - windowSecs;
  const checks = events.filter((row) => row.event_type === "check" && row.at >= since);
  const fires = events.filter((row) => row.event_type === "triggered" && row.at >= since);
  const near = events.filter((row) => row.event_type === "near_miss" && row.at >= since);
  const executed = events.filter((row) => row.event_type === "executed" && row.at >= since);
  return {
    holding: summary(accountId, now).holding,
    checks_window: checks.length,
    fired: fires.length,
    near_miss: near.length,
    executed: executed.length,
  };
}
