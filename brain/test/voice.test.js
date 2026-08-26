import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aomi-voice-"));
process.env.WORLD_BRAIN_DIR = dir;

const {
  closeEpisode,
  exportEval,
  ingestUtterance,
  keyterms,
  recordCorrection,
  setConsent,
  upsertLexicon,
  voiceContext,
} = await import("../src/voice.js");

test("utterance persists transcript and opens an episode", () => {
  const out = ingestUtterance("17", {
    transcript: "buy a tenth of ether",
    words: [{ w: "buy", conf: 0.9 }],
    source: "mini_app",
  });
  assert.equal(out.ok, true);
  assert.equal(out.heard_echo, "buy a tenth of ether");
  assert.ok(out.episode.id);
  assert.equal(out.episode.state, "open");
  const ctx = voiceContext("17");
  assert.equal(ctx.last_utterance.text, "buy a tenth of ether");
  assert.equal(ctx.open_episode.id, out.episode.id);
});

test("second note within 90s joins the episode", () => {
  const first = ingestUtterance("18", { transcript: "what's ether doing" }, 1_700_000_000);
  const second = ingestUtterance("18", { transcript: "buy two tenths" }, 1_700_000_040);
  assert.equal(second.episode.id, first.episode.id);
  assert.equal(second.episode.exchanges.length, 2);
});

test("silence gap recaps and opens a new episode", () => {
  const first = ingestUtterance("19", { transcript: "positions" }, 1_700_000_000);
  const second = ingestUtterance("19", { transcript: "risk" }, 1_700_000_200);
  assert.notEqual(second.episode.id, first.episode.id);
});

test("foreign audio does not open an episode", () => {
  const out = ingestUtterance("20", {
    transcript: "hello from someone else",
    foreign: true,
  });
  assert.equal(out.episode, null);
  assert.equal(voiceContext("20").open_episode, null);
});

test("lexicon keyterms prefer instruments and feed STT", () => {
  upsertLexicon("21", [
    { surface_form: "the loop", normalized_target: "xETH", kind: "phrase" },
    { surface_form: "WETH", normalized_target: "WETH", kind: "instrument" },
  ]);
  const terms = keyterms("21", ["WBTC"]);
  assert.equal(terms[0], "WBTC");
  assert.ok(terms.includes("WETH"));
  assert.ok(terms.includes("the loop"));
});

test("correction pair is captured and eval export lists it", () => {
  setConsent("22", { kind: "training_use", status: "granted" });
  const corr = recordCorrection("22", {
    rejected_intent: { kind: "buy", symbol: "WBTC" },
    accepted_intent: { kind: "buy", symbol: "WETH" },
    rejected_readback: "buy wbtc",
    lexicon_rename: {
      surface_form: "ether",
      normalized_target: "WETH",
      kind: "instrument",
    },
  });
  assert.equal(corr.ok, true);
  const evalSet = exportEval("22");
  assert.equal(evalSet.training_use, true);
  assert.equal(evalSet.pairs.length, 1);
  assert.equal(evalSet.pairs[0].chosen.symbol, "WETH");
  assert.ok(keyterms("22").includes("ether"));
});

test("close episode recaps", () => {
  ingestUtterance("23", { transcript: "done for now" });
  const closed = closeEpisode("23", { reason: "done_for_now" });
  assert.equal(closed.episode.state, "recapped");
  assert.equal(voiceContext("23").open_episode, null);
});

test("audio blob is written under the brain dir", () => {
  const out = ingestUtterance("24", {
    transcript: "hello",
    audio_base64: Buffer.from("ogg-bytes").toString("base64"),
  });
  assert.ok(out.utterance.audio_ref);
  const abs = path.join(dir, out.utterance.audio_ref);
  assert.equal(fs.readFileSync(abs, "utf8"), "ogg-bytes");
});
