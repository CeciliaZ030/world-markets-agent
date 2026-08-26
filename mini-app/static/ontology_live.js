/* global SPEECH_ONTOLOGY */
/** Client-side ontology alias rewrite for live hold-to-talk words. */

const PROTECTED_KINDS = new Set(["act", "size", "unit", "size_frame", "product", "order_type"]);
const PROTECTED_TOKENS = new Set(["of", "a", "an", "the", "and", "then", "to", "for", "me", "my"]);

const FALLBACK_ENTRIES = [
  { surface_form: "ether", normalized_target: "ETH", kind: "instrument" },
  { surface_form: "ethereum", normalized_target: "ETH", kind: "instrument" },
  { surface_form: "wrapped ether", normalized_target: "WETH", kind: "instrument" },
  { surface_form: "wrapped eth", normalized_target: "WETH", kind: "instrument" },
  { surface_form: "bitcoin", normalized_target: "WBTC", kind: "instrument" },
  { surface_form: "BTC", normalized_target: "WBTC", kind: "instrument" },
  { surface_form: "wrapped bitcoin", normalized_target: "WBTC", kind: "instrument" },
  { surface_form: "solana", normalized_target: "SOL", kind: "instrument" },
  { surface_form: "USD coin", normalized_target: "USDC", kind: "instrument" },
  { surface_form: "tether", normalized_target: "USDT", kind: "instrument" },
];

let aliasBySurface = new Map();
let phraseAliases = [];
let protectedSurfaces = new Set(PROTECTED_TOKENS);

function normalizeKey(surface) {
  return String(surface || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function loadEntries(entries) {
  const rows = Array.isArray(entries) && entries.length ? entries : FALLBACK_ENTRIES;
  aliasBySurface = new Map();
  phraseAliases = [];
  protectedSurfaces = new Set(PROTECTED_TOKENS);
  for (const row of rows) {
    const key = normalizeKey(row.surface_form);
    const target = String(row.normalized_target || "").trim();
    const kind = row.kind || "";
    if (!key) continue;
    if (PROTECTED_KINDS.has(kind)) {
      protectedSurfaces.add(key);
      continue;
    }
    if (kind === "confusable") continue;
    if (kind !== "instrument") continue;
    if (!target || key === normalizeKey(target)) continue;
    aliasBySurface.set(key, target);
    if (key.includes(" ")) phraseAliases.push([key.split(" "), target]);
  }
  phraseAliases.sort((a, b) => b[0].length - a[0].length);
}

loadEntries(typeof SPEECH_ONTOLOGY !== "undefined" ? SPEECH_ONTOLOGY.entries : null);

function setOntologyEntries(entries) {
  loadEntries(entries);
}

function tokenize(raw) {
  return String(raw || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function correctLiveTranscript(raw) {
  const original = String(raw || "");
  const tokens = tokenize(original);
  if (!tokens.length) return original.trim();
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    let hit = null;
    let consumed = 1;
    for (const [parts, target] of phraseAliases) {
      if (i + parts.length > tokens.length) continue;
      let ok = true;
      for (let k = 0; k < parts.length; k++) {
        if (normalizeKey(tokens[i + k]) !== parts[k]) {
          ok = false;
          break;
        }
      }
      if (ok) {
        hit = target;
        consumed = parts.length;
        break;
      }
    }
    if (!hit) {
      const key = normalizeKey(tokens[i]);
      if (!protectedSurfaces.has(key) && aliasBySurface.has(key)) {
        hit = aliasBySurface.get(key);
      }
    }
    out.push(hit || tokens[i]);
    i += consumed;
  }
  return out.join(" ");
}

if (typeof window !== "undefined") {
  window.correctLiveTranscript = correctLiveTranscript;
  window.setOntologyEntries = setOntologyEntries;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = { correctLiveTranscript, setOntologyEntries, loadEntries };
}
