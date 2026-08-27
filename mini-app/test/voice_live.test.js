import assert from "node:assert/strict";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  shouldPaintInterim,
  preferHeardTranscript,
  snapshotPcm,
  encodeWavFromPcm,
  floatToInt16,
  enqueueStreamPcm,
  MAX_STREAM_QUEUE,
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

test("shorter interim does not replace a longer caption", () => {
  assert.equal(shouldPaintInterim("buy", "buy fifty dollars of ether", false), false);
  assert.equal(shouldPaintInterim("buy fifty dollars of ether", "buy", false), true);
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

test("encodeWavFromPcm writes a wav blob from the snapshot", () => {
  const wav = encodeWavFromPcm([new Float32Array(2048)], 48000);
  assert.ok(wav);
  assert.equal(wav.type, "audio/wav");
  assert.ok(wav.size > 44);
  assert.equal(encodeWavFromPcm([], 48000), null);
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
