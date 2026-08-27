/** Hold-to-talk PCM helpers and caption/final transcript rules. */

function floatToInt16(input) {
  const src = input || [];
  const out = new Int16Array(src.length);
  for (let i = 0; i < src.length; i++) {
    const s = Math.max(-1, Math.min(1, src[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

function int16Bytes(samples) {
  const view = samples instanceof Int16Array ? samples : new Int16Array(samples || []);
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
}

function encodeWavFromPcm(chunks, sampleRate) {
  const rows = Array.isArray(chunks) ? chunks : [];
  let count = 0;
  for (let i = 0; i < rows.length; i++) count += rows[i].length;
  if (!count) return null;
  const rate = Number(sampleRate) || 48000;
  const pcm = new Int16Array(count);
  let o = 0;
  for (let c = 0; c < rows.length; c++) {
    const src = rows[c];
    for (let i = 0; i < src.length; i++) {
      const s = Math.max(-1, Math.min(1, src[i]));
      pcm[o++] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
  }
  const bytes = pcm.byteLength;
  const buf = new ArrayBuffer(44 + bytes);
  const view = new DataView(buf);
  const writeStr = (off, str) => {
    for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  };
  writeStr(0, "RIFF");
  view.setUint32(4, 36 + bytes, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, bytes, true);
  new Uint8Array(buf, 44).set(new Uint8Array(pcm.buffer));
  return new Blob([buf], { type: "audio/wav" });
}

function snapshotPcm(chunks, samples, sampleRate) {
  return {
    chunks: (chunks || []).map((row) => new Float32Array(row)),
    samples: samples || 0,
    rate: Number(sampleRate) || 48000,
  };
}

/** ~400ms at ScriptProcessor 2048 / 48kHz. Keep the start of the hold, drop new. */
const MAX_STREAM_QUEUE = 10;

function enqueueStreamPcm(queue, bytes, maxChunks) {
  const q = Array.isArray(queue) ? queue : [];
  const max = Number(maxChunks) > 0 ? Number(maxChunks) : MAX_STREAM_QUEUE;
  if (q.length < max) q.push(bytes);
  return q;
}

function shouldPaintInterim(text, prev, isFinal) {
  const next = String(text || "").trim();
  if (!next) return false;
  if (isFinal) return true;
  if (next.length < 3) return false;
  const prior = String(prev || "").trim();
  if (prior && next.length + 2 < prior.length) return false;
  return true;
}

function isPlaceholderTranscript(text) {
  const normalized = String(text || "")
    .trim()
    .replace(/[.!?]+$/, "")
    .toLowerCase();
  return (
    normalized === "hi" ||
    normalized === "hello" ||
    normalized === "hey" ||
    normalized === "thanks" ||
    normalized === "thank you" ||
    normalized === "thanks for watching" ||
    normalized === "you" ||
    normalized === "hmm" ||
    normalized === "um" ||
    normalized === "uh" ||
    normalized === "yes" ||
    normalized === "yeah" ||
    normalized === "ok" ||
    normalized === "okay" ||
    normalized === "the" ||
    normalized === "a"
  );
}

function preferHeardTranscript(stt, live) {
  const heard = String(stt || "").trim();
  const liveText = String(live || "").trim();
  if (!liveText) return heard;
  if (!heard || isPlaceholderTranscript(heard)) return liveText;
  const sttWords = heard.split(/\s+/).filter(Boolean).length;
  const liveWords = liveText.split(/\s+/).filter(Boolean).length;
  if (liveWords > sttWords) return liveText;
  if (liveWords === sttWords && liveText.length > heard.length) return liveText;
  return heard;
}

if (typeof window !== "undefined") {
  window.floatToInt16 = floatToInt16;
  window.int16Bytes = int16Bytes;
  window.encodeWavFromPcm = encodeWavFromPcm;
  window.snapshotPcm = snapshotPcm;
  window.shouldPaintInterim = shouldPaintInterim;
  window.preferHeardTranscript = preferHeardTranscript;
  window.enqueueStreamPcm = enqueueStreamPcm;
  window.MAX_STREAM_QUEUE = MAX_STREAM_QUEUE;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    floatToInt16,
    int16Bytes,
    encodeWavFromPcm,
    snapshotPcm,
    shouldPaintInterim,
    preferHeardTranscript,
    isPlaceholderTranscript,
    enqueueStreamPcm,
    MAX_STREAM_QUEUE,
  };
}
