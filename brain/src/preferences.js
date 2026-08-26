import { filePath, readJson, writeJson } from "./store.js";

function prefsPath(accountId) {
  return filePath("preferences", `${accountId}.json`);
}

export function listPreferences(accountId) {
  const data = readJson(prefsPath(accountId), { items: [] });
  return (data.items || []).map((item) => ({
    ...item,
    on_chain: false,
  }));
}

export function upsertPreference(accountId, item) {
  const data = readJson(prefsPath(accountId), { items: [] });
  const now = Math.floor(Date.now() / 1000);
  const id = item.id || `p-${accountId}-${now}`;
  const next = {
    id,
    text: String(item.text || "").trim(),
    created_at: item.created_at || now,
    on_chain: false,
  };
  if (!next.text) {
    return { ok: false, error: "empty_preference" };
  }
  data.items = data.items.filter((row) => row.id !== id);
  data.items.push(next);
  writeJson(prefsPath(accountId), data);
  return { ok: true, item: next };
}

export function cancelPreference(accountId, id) {
  const data = readJson(prefsPath(accountId), { items: [] });
  const before = data.items.length;
  const removed = data.items.find((row) => row.id === id);
  data.items = data.items.filter((row) => row.id !== id);
  if (data.items.length === before) {
    return { ok: false, error: "not_found" };
  }
  writeJson(prefsPath(accountId), data);
  return { ok: true, item: removed, remaining: data.items.length };
}

export function seedBrief(accountId, brief) {
  if (!brief) return;
  const text =
    typeof brief === "string"
      ? brief
      : brief.objective
        ? String(brief.objective)
        : JSON.stringify(brief);
  if (!text.trim()) return;
  const existing = listPreferences(accountId);
  if (existing.some((item) => item.text === text)) return;
  upsertPreference(accountId, { text });
}
