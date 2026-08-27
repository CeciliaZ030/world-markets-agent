import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);
const {
  shouldPaintInterim,
  foldStreamTranscript,
  preferHeardTranscript,
  snapshotPcm,
  encodeWavFromPcm,
  floatToInt16,
  declaredStreamRate,
  resampleForStream,
  enqueueStreamPcm,
  pointInVoiceHit,
  MAX_STREAM_QUEUE,
  SLIDE_CANCEL_PAD_PX,
  PCM_FLUSH_FRAMES,
  PCM_FLUSH_MS,
} = require("../static/voice_live.js");

test("does not paint empty or tiny interims", () => {
  assert.equal(shouldPaintInterim("", "", false), false);
  assert.equal(shouldPaintInterim("  ", "", false), false);
  assert.equal(shouldPaintInterim("hi", "", false), false);
  assert.equal(shouldPaintInterim("51", "", false), false);
  assert.equal(shouldPaintInterim("buy", "", false), true);
  assert.equal(shouldPaintInterim("buy ether", "", false), true);
});

test("final captions paint even when short", () => {
  assert.equal(shouldPaintInterim("hi", "", true), true);
  assert.equal(shouldPaintInterim("", "buy ether", true), false);
});

test("a placeholder or shorter final does not replace the caption already on screen", () => {
  assert.equal(shouldPaintInterim("you", "buy 5 ETH", true), false);
  assert.equal(shouldPaintInterim("thank you", "buy five eth", true), false);
  assert.equal(shouldPaintInterim("buy 5 ETH", "buy 5 ETH", true), true);
  const wiped = foldStreamTranscript("", "you", true, "buy 5 ETH");
  assert.equal(wiped.display, "buy 5 ETH");
  assert.equal(preferHeardTranscript("you", "buy 5 ETH"), "buy 5 ETH");
});

test("shorter interim does not replace a longer caption", () => {
  assert.equal(shouldPaintInterim("buy", "buy fifty dollars of ether", false), false);
  assert.equal(shouldPaintInterim("buy fifty dollars of ether", "buy", false), true);
});

test("foldStreamTranscript concatenates finals so a later span cannot drop the start", () => {
  let committed = "";
  let display = "";
  let step = foldStreamTranscript(committed, "what do you think about", false, display);
  assert.equal(step.display, "what do you think about");
  assert.equal(step.committed, "");
  committed = step.committed;
  display = step.display;
  step = foldStreamTranscript(committed, "what do you think about", true, display);
  assert.equal(step.committed, "what do you think about");
  committed = step.committed;
  display = step.display;
  step = foldStreamTranscript(committed, "compute futures", false, display);
  assert.equal(step.display, "what do you think about compute futures");
  assert.equal(step.committed, "what do you think about");
  committed = step.committed;
  display = step.display;
  step = foldStreamTranscript(committed, "compute futures", true, display);
  assert.equal(step.display, "what do you think about compute futures");
  assert.equal(step.committed, "what do you think about compute futures");
});

test("foldStreamTranscript keeps already-shown words when the first final is only a prefix", () => {
  const step = foldStreamTranscript(
    "",
    "what do you think about",
    true,
    "what do you think about compute futures",
  );
  assert.equal(step.committed, "what do you think about");
  assert.equal(step.display, "what do you think about compute futures");
});

test("foldStreamTranscript keeps a cumulative final that already includes the prefix", () => {
  const step = foldStreamTranscript(
    "what do you think about",
    "what do you think about compute futures",
    true,
  );
  assert.equal(step.display, "what do you think about compute futures");
});

test("hold-to-talk posts the full press-to-release recording, not the live caption", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../static/app.js"), "utf8");
  assert.match(src, /waitPcmFlushFrames/);
  assert.match(src, /snapshotLivePcm/);
  assert.match(src, /discardVoiceStream/);
  assert.match(src, /PCM_FLUSH_FRAMES/);
  assert.doesNotMatch(src, /releaseHeard/);
  assert.doesNotMatch(src, /finalized:\s*usedStream/);
  assert.doesNotMatch(src, /live_text:/);
  assert.doesNotMatch(src, /msg\.is_final && voiceStreamOnFinal/);
  assert.doesNotMatch(src, /done\(String\(msg\.text/);
});

test("slide-off requires leaving the button, not a lift inside it", () => {
  assert.equal(pointInVoiceHit(150, 150, 75, 75, 0, 0, 0), true);
  assert.equal(pointInVoiceHit(150, 150, 160, 75, 0, 0, 0), false);
  assert.equal(pointInVoiceHit(150, 150, 160, 75, 0, 0, SLIDE_CANCEL_PAD_PX), true);
  assert.equal(pointInVoiceHit(150, 150, 230, 75, 0, 0, SLIDE_CANCEL_PAD_PX), false);
});

test("release drains a couple of already-filled PCM frames, not seconds of padding", () => {
  assert.equal(PCM_FLUSH_FRAMES, 2);
  assert.ok(PCM_FLUSH_MS <= 200);
});

test("preferHeardTranscript keeps a longer finalized live sentence", () => {
  assert.equal(
    preferHeardTranscript("buy 51", "buy fifty dollars of ether"),
    "buy fifty dollars of ether",
  );
  assert.equal(preferHeardTranscript("Hi", "sell all sol"), "sell all sol");
  assert.equal(
    preferHeardTranscript("buy fifty dollars of ETH", "by 15 of it"),
    "buy fifty dollars of ETH",
  );
  assert.equal(preferHeardTranscript("sell all sol", ""), "sell all sol");
});

test("snapshotPcm copies buffers so teardown cannot wipe the utterance", () => {
  const src = [new Float32Array([0.5, -0.25])];
  const snap = snapshotPcm(src, 2, 48000);
  src[0][0] = 0;
  assert.equal(snap.chunks[0][0], 0.5);
  assert.equal(snap.samples, 2);
  assert.equal(snap.rate, 48000);
});

test("encodeWavFromPcm writes pcm16 mono matching the capture rate", async () => {
  const wav = encodeWavFromPcm([new Float32Array(8)], 44100);
  assert.ok(wav);
  assert.equal(wav.type, "audio/wav");
  const buf = Buffer.from(await wav.arrayBuffer());
  assert.equal(buf.toString("ascii", 0, 4), "RIFF");
  assert.equal(buf.toString("ascii", 8, 12), "WAVE");
  assert.equal(buf.readUInt16LE(20), 1, "WAVE_FORMAT_PCM, not mu-law");
  assert.equal(buf.readUInt16LE(22), 1, "mono");
  assert.equal(buf.readUInt32LE(24), 44100);
  assert.equal(buf.readUInt32LE(28), 44100 * 2);
  assert.equal(buf.readUInt16LE(32), 2);
  assert.equal(buf.readUInt16LE(34), 16);
  assert.equal(encodeWavFromPcm([], 48000), null);
});

test("declaredStreamRate keeps 44.1k and 16k; resamples only outside 8–48k", () => {
  assert.equal(declaredStreamRate(44100), 44100);
  assert.equal(declaredStreamRate(48000), 48000);
  assert.equal(declaredStreamRate(16000), 16000);
  assert.equal(declaredStreamRate(8000), 8000);
  assert.equal(declaredStreamRate(96000), 48000);
  assert.equal(declaredStreamRate(4000), 8000);
});

test("resampleForStream is a no-op when rates already match", () => {
  const src = new Float32Array([0.1, 0.2, 0.3]);
  const out = resampleForStream(src, 44100, 44100);
  assert.equal(out.length, 3);
  assert.equal(out[1], src[1]);
  const down = resampleForStream(new Float32Array(16), 96000, 48000);
  assert.equal(down.length, 8);
});

test("hold-to-talk stream URL uses the declared capture rate", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, "../static/app.js"), "utf8");
  assert.match(src, /declaredStreamRate/);
  assert.match(src, /liveStreamRate/);
  assert.match(src, /resampleForStream/);
  assert.match(src, /sampleRate:\s*48000/);
  assert.match(src, /createScriptProcessor\(2048,\s*1,\s*1\)/);
});

test("floatToInt16 is little-endian pcm for the stream", () => {
  const samples = floatToInt16(new Float32Array([0, 1, -1]));
  assert.equal(samples.length, 3);
  assert.equal(samples[0], 0);
  assert.equal(samples[1], 0x7fff);
  assert.equal(samples[2], -0x8000);
});

test("stream queue keeps the start of the hold and does not grow without bound", () => {
  const queue = [];
  for (let i = 0; i < MAX_STREAM_QUEUE + 5; i++) {
    enqueueStreamPcm(queue, i);
  }
  assert.equal(queue.length, MAX_STREAM_QUEUE);
  assert.equal(queue[0], 0);
  assert.equal(queue[MAX_STREAM_QUEUE - 1], MAX_STREAM_QUEUE - 1);
});
