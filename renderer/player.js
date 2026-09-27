/**
 * Everything to do with sound in the page: playing a buffer, mixing stems
 * back together, encoding a WAV, drawing a waveform, and finding a song's
 * cover art. No DOM in here; app.js owns that.
 */

const RATE = 44100;

/* ------------------------------------------------------------------ *
 * A small player: one AudioBuffer at a time, played, paused and sought
 * without ever losing track of where it was.
 * ------------------------------------------------------------------ */
class Player {
  constructor() {
    this.ctx = null;
    this.gain = null;
    this.source = null;
    this.buffer = null;
    this.duration = 0;
    this.playing = false;
    this.startedAtCtxTime = 0;
    this.startOffset = 0;
    this.volume = 0.8;
    this.listeners = new Set();
  }

  ensure() {
    this.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (!this.gain) {
      this.gain = this.ctx.createGain();
      this.gain.gain.value = this.volume;
      this.gain.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  notify() { this.listeners.forEach(fn => fn()); }

  get position() {
    if (!this.playing || !this.ctx) return this.startOffset;
    return Math.min(this.duration, this.startOffset + (this.ctx.currentTime - this.startedAtCtxTime));
  }

  load(buffer) {
    this.stopNode();
    this.buffer = buffer;
    this.duration = buffer ? buffer.duration : 0;
    this.playing = false;
    this.startOffset = 0;
    this.notify();
  }

  /** Swap in a new mix of the same song, keeping the playhead and play state. */
  loadKeepingPlace(buffer) {
    const at = this.position;
    const wasPlaying = this.playing;
    this.stopNode();
    this.buffer = buffer;
    this.duration = buffer.duration;
    this.startOffset = Math.min(at, this.duration);
    this.playing = false;
    if (wasPlaying) this.play();
    else this.notify();
  }

  play() {
    if (!this.buffer || this.playing) return;
    this.ensure();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    if (this.startOffset >= this.duration - 0.01) this.startOffset = 0;
    const node = this.ctx.createBufferSource();
    node.buffer = this.buffer;
    node.connect(this.gain);
    node.onended = () => {
      if (this.source !== node) return;
      this.playing = false;
      this.startOffset = this.duration;
      this.notify();
    };
    node.start(0, this.startOffset);
    this.source = node;
    this.startedAtCtxTime = this.ctx.currentTime;
    this.playing = true;
    this.notify();
  }

  pause() {
    if (!this.playing) return;
    this.startOffset = this.position;
    this.stopNode();
    this.playing = false;
    this.notify();
  }

  stop() {
    this.stopNode();
    this.playing = false;
    this.startOffset = 0;
    this.notify();
  }

  seek(seconds) {
    const clamped = Math.max(0, Math.min(this.duration, seconds));
    const wasPlaying = this.playing;
    this.stopNode();
    this.startOffset = clamped;
    if (wasPlaying) this.play();
    else this.notify();
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.gain) this.gain.gain.value = this.volume;
  }

  stopNode() {
    if (!this.source) return;
    try { this.source.onended = null; this.source.stop(); } catch { /* already stopped */ }
    try { this.source.disconnect(); } catch { /* already gone */ }
    this.source = null;
  }
}

/* ------------------------------------------------------------------ *
 * Mixing and encoding
 * ------------------------------------------------------------------ */

const dbToGain = db => 10 ** (db / 20);

/**
 * Sum 16-bit interleaved-stereo stems into floating stereo channels, each
 * at its own gain.
 * @param {Array<{samples: Int16Array, gain: number}>} parts  gain is linear
 */
function mixStems(parts) {
  const frames = parts.length ? Math.floor(parts[0].samples.length / 2) : 0;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  parts.forEach(({ samples, gain }) => {
    const g = gain / 32768;
    for (let i = 0; i < frames; i += 1) {
      left[i] += samples[i * 2] * g;
      right[i] += samples[i * 2 + 1] * g;
    }
  });
  return [left, right];
}

function toAudioBuffer(ctx, channels, rate = RATE) {
  const buffer = ctx.createBuffer(2, Math.max(1, channels[0].length), rate);
  channels.forEach((data, index) => buffer.copyToChannel(data, index));
  return buffer;
}

/** Render a buffer at another sample rate, the way a DAW would. */
async function resample(buffer, rate) {
  if (buffer.sampleRate === rate) return buffer;
  const length = Math.ceil(buffer.duration * rate);
  const offline = new OfflineAudioContext(2, length, rate);
  const node = offline.createBufferSource();
  node.buffer = buffer;
  node.connect(offline.destination);
  node.start();
  return offline.startRendering();
}

/** Encode an AudioBuffer as a PCM WAV, 16 or 24 bits per sample. */
function encodeWav(buffer, bits = 16) {
  const channels = 2;
  const left = buffer.getChannelData(0);
  const right = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : left;
  const frames = left.length;
  const bytesPer = bits / 8;
  const blockAlign = channels * bytesPer;
  const dataBytes = frames * blockAlign;
  const out = new ArrayBuffer(44 + dataBytes);
  const view = new DataView(out);
  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i));
  };
  writeString(0, 'RIFF'); view.setUint32(4, 36 + dataBytes, true); writeString(8, 'WAVE');
  writeString(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, channels, true);
  view.setUint32(24, buffer.sampleRate, true); view.setUint32(28, buffer.sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true); view.setUint16(34, bits, true);
  writeString(36, 'data'); view.setUint32(40, dataBytes, true);

  let offset = 44;
  if (bits === 24) {
    const max = 8388607;
    const put = value => {
      const v = Math.max(-8388608, Math.min(max, Math.round(value * max)));
      view.setUint8(offset, v & 0xff);
      view.setUint8(offset + 1, (v >> 8) & 0xff);
      view.setUint8(offset + 2, (v >> 16) & 0xff);
      offset += 3;
    };
    for (let i = 0; i < frames; i += 1) { put(left[i]); put(right[i]); }
  } else {
    const clamp = value => Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
    for (let i = 0; i < frames; i += 1) {
      view.setInt16(offset, clamp(left[i]), true);
      view.setInt16(offset + 2, clamp(right[i]), true);
      offset += 4;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * Waveforms
 * ------------------------------------------------------------------ */

/** Peak level per bucket, 0..1, from interleaved 16-bit stereo. */
function peaksOfStem(samples, buckets) {
  const frames = Math.floor(samples.length / 2);
  const out = new Float32Array(buckets);
  const per = Math.max(1, frames / buckets);
  for (let b = 0; b < buckets; b += 1) {
    const start = Math.floor(b * per);
    const end = Math.min(frames, Math.floor((b + 1) * per));
    let peak = 0;
    for (let i = start; i < end; i += 1) {
      const l = Math.abs(samples[i * 2]);
      const r = Math.abs(samples[i * 2 + 1]);
      if (l > peak) peak = l;
      if (r > peak) peak = r;
    }
    out[b] = peak / 32768;
  }
  return out;
}

/** The same from a floating-point channel. */
function peaksOfChannel(data, buckets) {
  const out = new Float32Array(buckets);
  const per = Math.max(1, data.length / buckets);
  for (let b = 0; b < buckets; b += 1) {
    const start = Math.floor(b * per);
    const end = Math.min(data.length, Math.floor((b + 1) * per));
    let peak = 0;
    for (let i = start; i < end; i += 1) { const v = Math.abs(data[i]); if (v > peak) peak = v; }
    out[b] = peak;
  }
  return out;
}

/** Draw peaks as mirrored bars, filling the canvas at device resolution. */
function drawWave(canvas, peaks, color, options = {}) {
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth || 300;
  const height = canvas.clientHeight || 44;
  canvas.width = Math.round(width * ratio);
  canvas.height = Math.round(height * ratio);
  const ctx = canvas.getContext('2d');
  ctx.scale(ratio, ratio);
  ctx.clearRect(0, 0, width, height);
  const gap = options.gap ?? 1;
  const barW = Math.max(1, width / peaks.length - gap);
  const mid = height / 2;
  let max = 0;
  for (let i = 0; i < peaks.length; i += 1) if (peaks[i] > max) max = peaks[i];
  const scale = max > 0 ? 1 / max : 1;
  ctx.fillStyle = color;
  for (let i = 0; i < peaks.length; i += 1) {
    const h = Math.max(1, peaks[i] * scale * (height - 2));
    ctx.fillRect(i * (barW + gap), mid - h / 2, barW, h);
  }
}

/* ------------------------------------------------------------------ *
 * Cover art: the picture tucked into an MP3's ID3 tag, when there is one.
 * ------------------------------------------------------------------ */
function coverFromId3(bytes) {
  const view = new DataView(bytes);
  const u8 = new Uint8Array(bytes);
  if (u8.length < 10 || u8[0] !== 0x49 || u8[1] !== 0x44 || u8[2] !== 0x33) return null;
  const version = u8[3];
  const syncsafe = at => ((u8[at] & 0x7f) << 21) | ((u8[at + 1] & 0x7f) << 14) | ((u8[at + 2] & 0x7f) << 7) | (u8[at + 3] & 0x7f);
  const tagSize = syncsafe(6);
  let offset = 10;
  if (u8[5] & 0x40) offset += version === 4 ? syncsafe(10) : view.getUint32(10) + 4; // extended header
  const end = Math.min(u8.length, 10 + tagSize);
  while (offset + 10 <= end) {
    const id = String.fromCharCode(u8[offset], u8[offset + 1], u8[offset + 2], u8[offset + 3]);
    if (!/^[A-Z0-9]{4}$/.test(id)) break;
    const size = version === 4 ? syncsafe(offset + 4) : view.getUint32(offset + 4);
    const body = offset + 10;
    if (id === 'APIC' && size > 0) {
      let p = body;
      const encoding = u8[p]; p += 1;
      let mime = '';
      while (p < body + size && u8[p] !== 0) { mime += String.fromCharCode(u8[p]); p += 1; }
      p += 1; // mime terminator
      p += 1; // picture type
      // Description: null-terminated, two bytes wide for UTF-16 encodings.
      if (encoding === 1 || encoding === 2) {
        while (p + 1 < body + size && !(u8[p] === 0 && u8[p + 1] === 0)) p += 2;
        p += 2;
      } else {
        while (p < body + size && u8[p] !== 0) p += 1;
        p += 1;
      }
      if (p < body + size) {
        return new Blob([u8.subarray(p, body + size)], { type: mime || 'image/jpeg' });
      }
    }
    offset = body + size;
  }
  return null;
}

const formatTime = seconds => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};
