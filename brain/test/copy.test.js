import assert from "node:assert/strict";
import test from "node:test";
import {
  attachSetCopy,
  bundleMessage,
  expiredMessage,
  firedMessage,
  setMessage,
} from "../src/copy.js";

const watch = {
  mark_at_set: "2180",
  expires_at: 1_700_000_000 + 10 * 86400,
  predicate: {
    kind: "pct_move",
    symbol: "ETH",
    op: "gte",
    pct: "5",
    resolved: "ETH ≥ +5% / 1d",
  },
};

test("set copy is tool-filled and never a trade", () => {
  const text = setMessage(watch, 1_700_000_000);
  assert.match(text, /`ETH`/);
  assert.match(text, /`2180`/);
  assert.match(text, /I won't buy or sell anything/);
});

test("clarify and fold return paste-ready messages", () => {
  const clarify = attachSetCopy({
    ok: true,
    stored: false,
    needs_clarification: true,
    symbol: "ETH",
    options: [{ label: "Up 5% in a day" }, { label: "Pick a price" }],
  });
  assert.match(clarify.message, /`ETH`/);
  assert.deepEqual(clarify.controls, ["Up 5% in a day", "Pick a price"]);
  const folded = attachSetCopy({
    ok: true,
    stored: false,
    execution_folded: true,
    symbol: "ETH",
  });
  assert.match(folded.message, /signed on World/);
});

test("fire, expire, and bundle copy use record fields only", () => {
  const fire = {
    created_at: 1_700_000_000,
    live: "2290",
    spent: true,
    predicate: { symbol: "ETH", resolved: "ETH ≥ +5% / 1d" },
    original_phrase: "up 5% in a day",
  };
  assert.match(firedMessage(fire), /`ETH`/);
  assert.match(firedMessage(fire), /`2290`/);
  assert.match(expiredMessage(fire), /expired without firing/);
  assert.match(bundleMessage([fire]), /`1` more/);
});
