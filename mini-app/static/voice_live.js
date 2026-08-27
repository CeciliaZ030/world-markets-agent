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
  const rate = Math.round(Number(sampleRate) || 48000);
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
  view.setUint16(20, 1, true); // PCM (1), not mu-law (7)
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  writeStr(36, "data");
  view.setUint32(40, bytes, true);
  new Uint8Array(buf, 44).set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
  return new Blob([buf], { type: "audio/wav" });
}

/** Deepgram live raw PCM: signed little-endian 16-bit, mono. */
const STREAM_RATE_MIN = 8000;
const STREAM_RATE_MAX = 48000;
const STREAM_RATE_PREFERRED = 48000;

function declaredStreamRate(captureRate) {
  const rate = Math.round(Number(captureRate) || STREAM_RATE_PREFERRED);
  if (rate > STREAM_RATE_MAX) return STREAM_RATE_MAX;
  if (rate < STREAM_RATE_MIN) return STREAM_RATE_MIN;
  return rate;
}

function resampleForStream(input, fromRate, toRate) {
  const src = input || [];
  const from = Math.round(Number(fromRate) || 0);
  const to = Math.round(Number(toRate) || 0);
  if (!src.length || !from || !to || from === to) {
    return src instanceof Float32Array ? src : new Float32Array(src);
  }
  const ratio = from / to;
  const outLen = Math.max(1, Math.round(src.length / ratio));
  const out = new Float32Array(outLen);
  const last = src.length - 1;
  for (let i = 0; i < outLen; i++) {
    const x = i * ratio;
    const i0 = Math.min(last, Math.floor(x));
    const i1 = Math.min(last, i0 + 1);
    const frac = x - i0;
    out[i] = src[i0] * (1 - frac) + src[i1] * frac;
  }
  return out;
}

function snapshotPcm(chunks, samples, sampleRate) {
  return {
    chunks: (chunks || []).map((row) => new Float32Array(row)),
    samples: samples || 0,
    rate: Math.round(Number(sampleRate) || 48000),
  };
}

/** ~400ms at ScriptProcessor 2048 / 48kHz. Keep the start of the hold, drop new. */
const MAX_STREAM_QUEUE = 10;
/** ScriptProcessor 2048 @ 48kHz ≈ 43ms. Drain buffers already filled during the hold. */
const PCM_FLUSH_FRAMES = 2;
const PCM_FLUSH_MS = 150;
/** Slide-off must leave the button by this many CSS pixels — a lift is not a send. */
const SLIDE_CANCEL_PAD_PX = 48;

function enqueueStreamPcm(queue, bytes, maxChunks) {
  const q = Array.isArray(queue) ? queue : [];
  const max = Number(maxChunks) > 0 ? Number(maxChunks) : MAX_STREAM_QUEUE;
  if (q.length < max) q.push(bytes);
  return q;
}

function shouldPaintInterim(text, prev, isFinal) {
  const next = String(text || "").trim();
  if (!next) return false;
  const prior = String(prev || "").trim();
  if (isFinal) {
    if (isPlaceholderTranscript(next) && prior && !isPlaceholderTranscript(prior)) return false;
    if (prior && next.length + 2 < prior.length && !prior.startsWith(next) && !next.startsWith(prior)) {
      return false;
    }
    return true;
  }
  if (next.length < 3) return false;
  if (prior && next.length + 2 < prior.length) return false;
  return true;
}

function joinTranscriptParts(left, right) {
  const a = String(left || "").trim();
  const b = String(right || "").trim();
  if (!a) return b;
  if (!b) return a;
  if (b.startsWith(a)) return b;
  if (a.endsWith(b)) return a;
  return `${a} ${b}`;
}

/** Deepgram live `is_final` is one audio span, not the whole hold. Concatenate spans. */
function foldStreamTranscript(committed, text, isFinal, prevDisplay) {
  const next = String(text || "").trim();
  const prefix = String(committed || "").trim();
  const prior = String(prevDisplay || "").trim();
  if (!next) {
    return { committed: prefix, display: prior || prefix };
  }
  if (isFinal) {
    const joined = joinTranscriptParts(prefix, next);
    if (isPlaceholderTranscript(joined) && prior && !isPlaceholderTranscript(prior)) {
      return { committed: prefix, display: prior };
    }
    if (prior.startsWith(joined)) {
      return { committed: joined, display: prior };
    }
    if (
      prior &&
      joined.length + 2 < prior.length &&
      !joined.startsWith(prior) &&
      !prior.startsWith(joined)
    ) {
      return { committed: prefix, display: prior };
    }
    return { committed: joined, display: joined };
  }
  return {
    committed: prefix,
    display: joinTranscriptParts(prefix, next),
  };
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

function pointInVoiceHit(width, height, clientX, clientY, left, top, extra) {
  const w = Number(width) || 0;
  const h = Number(height) || 0;
  const cx = (Number(left) || 0) + w / 2;
  const cy = (Number(top) || 0) + h / 2;
  const rad = Math.min(w, h) / 2 + Math.max(0, Number(extra) || 0);
  const dx = (Number(clientX) || 0) - cx;
  const dy = (Number(clientY) || 0) - cy;
  return dx * dx + dy * dy <= rad * rad;
}

function silencePcmChunks(sampleRate, ms, frame) {
  const rate = Math.round(Number(sampleRate) || 48000);
  const total = Math.max(0, Math.round((rate * (Number(ms) || 0)) / 1000));
  const size = Math.max(1, Math.round(Number(frame) || 2048));
  const chunks = [];
  let left = total;
  while (left > 0) {
    const n = Math.min(size, left);
    chunks.push(new Float32Array(n));
    left -= n;
  }
  return chunks;
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
  window.declaredStreamRate = declaredStreamRate;
  window.resampleForStream = resampleForStream;
  window.shouldPaintInterim = shouldPaintInterim;
  window.joinTranscriptParts = joinTranscriptParts;
  window.foldStreamTranscript = foldStreamTranscript;
  window.preferHeardTranscript = preferHeardTranscript;
  window.enqueueStreamPcm = enqueueStreamPcm;
  window.pointInVoiceHit = pointInVoiceHit;
  window.silencePcmChunks = silencePcmChunks;
  window.isPlaceholderTranscript = isPlaceholderTranscript;
  window.MAX_STREAM_QUEUE = MAX_STREAM_QUEUE;
  window.PCM_FLUSH_FRAMES = PCM_FLUSH_FRAMES;
  window.PCM_FLUSH_MS = PCM_FLUSH_MS;
  window.SLIDE_CANCEL_PAD_PX = SLIDE_CANCEL_PAD_PX;
}
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    floatToInt16,
    int16Bytes,
    encodeWavFromPcm,
    snapshotPcm,
    declaredStreamRate,
    resampleForStream,
    STREAM_RATE_MAX,
    STREAM_RATE_PREFERRED,
    shouldPaintInterim,
    joinTranscriptParts,
    foldStreamTranscript,
    preferHeardTranscript,
    isPlaceholderTranscript,
    enqueueStreamPcm,
    pointInVoiceHit,
    silencePcmChunks,
    MAX_STREAM_QUEUE,
    PCM_FLUSH_FRAMES,
    PCM_FLUSH_MS,
    SLIDE_CANCEL_PAD_PX,
  };
}
