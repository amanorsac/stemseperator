/**
 * Pure audio arithmetic, shared by the page and its worker: no DOM, no
 * Web Audio, nothing but typed arrays in and out. The heavy loops over
 * whole songs live here so the worker can run them off the main thread.
 */

const RATE = 44100;

const dbToGain = db => 10 ** (db / 20);

/** Interleaved 16-bit stereo (as the stems are stored) to two float channels. */
function int16ToChannels(samples) {
  const frames = Math.floor(samples.length / 2);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    left[i] = samples[i * 2] / 32768;
    right[i] = samples[i * 2 + 1] / 32768;
  }
  return [left, right];
}

/** Sum float stereo parts, each at its own linear gain. */
function mixChannels(parts) {
  const frames = parts.length ? parts[0].left.length : 0;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  parts.forEach(({ left: l, right: r, gain }) => {
    for (let i = 0; i < frames; i += 1) {
      left[i] += l[i] * gain;
      right[i] += r[i] * gain;
    }
  });
  return [left, right];
}

/** Peak level per bucket, 0..1, from a float channel. */
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

/** The louder of two channels, per bucket. */
function peaksOfStereo(left, right, buckets) {
  const a = peaksOfChannel(left, buckets);
  const b = peaksOfChannel(right, buckets);
  for (let i = 0; i < buckets; i += 1) if (b[i] > a[i]) a[i] = b[i];
  return a;
}

/** Encode float stereo as a PCM WAV, 16 or 24 bits per sample. */
function encodeWav(left, right, rate = RATE, bits = 16) {
  const channels = 2;
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
  view.setUint32(24, rate, true); view.setUint32(28, rate * blockAlign, true);
  view.setUint16(32, blockAlign, true); view.setUint16(34, bits, true);
  writeString(36, 'data'); view.setUint32(40, dataBytes, true);

  if (bits === 24) {
    const bytes = new Uint8Array(out, 44);
    const max = 8388607;
    let p = 0;
    const put = value => {
      const v = Math.max(-8388608, Math.min(max, Math.round(value * max)));
      bytes[p++] = v & 0xff;
      bytes[p++] = (v >> 8) & 0xff;
      bytes[p++] = (v >> 16) & 0xff;
    };
    for (let i = 0; i < frames; i += 1) { put(left[i]); put(right[i]); }
  } else {
    const pcm = new Int16Array(out, 44, frames * 2);
    for (let i = 0; i < frames; i += 1) {
      pcm[i * 2] = Math.max(-32768, Math.min(32767, Math.round(left[i] * 32767)));
      pcm[i * 2 + 1] = Math.max(-32768, Math.min(32767, Math.round(right[i] * 32767)));
    }
  }
  return out;
}

if (typeof module !== 'undefined') module.exports = { RATE, dbToGain, int16ToChannels, mixChannels, peaksOfChannel, peaksOfStereo, encodeWav };
