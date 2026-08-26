import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordFunding, recordMark } from "../src/history.js";
import { drain, peek } from "../src/outbound.js";
import { evaluateAccount, listWatches, setWatch } from "../src/watches.js";

function isolatedDir() {
  const dir = mkdtempSync(join(tmpdir(), "aomi-brain-"));
  process.env.WORLD_BRAIN_DIR = dir;
  return dir;
}

test("once watch fires with copy and is spent", () => {
  isolatedDir();
  process.env.WORLD_WATCH_FIRE_CEILING = "5";
  const now = 1_700_000_000;
  recordMark({ symbol: "ETH", mark: "110", ts: now });
  const set = setWatch("17", {
    phrase: "above 100",
    symbol: "ETH",
    mark_at_set: "90",
    expires_at: now + 86400,
  });
  assert.equal(set.stored, true);
  assert.match(set.message, /Watching/);
  evaluateAccount("17", now);
  const items = listWatches("17");
  assert.equal(items[0].status, "spent");
  const out = peek();
  assert.equal(out.length, 1);
  assert.equal(out[0].kind, "watch_fired");
  assert.match(out[0].message, /`ETH`/);
  drain(50);
});

test("N+1 fire is held then flushed as a bundle with copy", () => {
  isolatedDir();
  process.env.WORLD_WATCH_FIRE_CEILING = "1";
  const now = 1_710_000_000;
  recordMark({ symbol: "ETH", mark: "110", ts: now });
  setWatch("18", {
    id: "w-a",
    phrase: "above 100",
    symbol: "ETH",
    mark_at_set: "90",
    expires_at: now + 10 * 86400,
  });
  setWatch("18", {
    id: "w-b",
    phrase: "above 101",
    symbol: "ETH",
    mark_at_set: "90",
    expires_at: now + 10 * 86400,
  });
  evaluateAccount("18", now);
  const first = peek();
  assert.equal(first.length, 1);
  assert.equal(first[0].kind, "watch_fired");
  assert.equal(first[0].watch_id, "w-a");
  evaluateAccount("18", now + 86_401);
  const queued = peek();
  const bundle = queued.find((item) => item.kind === "watch_bundle");
  assert.ok(bundle, "held fire must flush as a bundle the next UTC day");
  assert.match(bundle.message, /more of your watches fired/);
  drain(50);
});

test("expired watch enqueues the expiry message", () => {
  isolatedDir();
  process.env.WORLD_WATCH_FIRE_CEILING = "5";
  const now = 1_720_000_000;
  recordMark({ symbol: "ETH", mark: "90", ts: now });
  setWatch("19", {
    phrase: "above 100",
    symbol: "ETH",
    mark_at_set: "90",
    expires_at: now + 10,
  });
  evaluateAccount("19", now + 11);
  const items = listWatches("19");
  assert.equal(items[0].status, "expired");
  const out = peek();
  assert.equal(out[0].kind, "watch_expired");
  assert.match(out[0].message, /expired without firing/);
  drain(50);
});

test("funding watch compares ingested 8h rate as percent", () => {
  isolatedDir();
  process.env.WORLD_WATCH_FIRE_CEILING = "5";
  const now = 1_730_000_000;
  recordFunding({ symbol: "ETH", rate: "0.02", ts: now });
  setWatch("20", {
    phrase: "funding above 0.01%",
    symbol: "ETH",
    expires_at: now + 86400,
  });
  evaluateAccount("20", now);
  const items = listWatches("20");
  assert.equal(items[0].status, "spent");
  drain(50);
});
