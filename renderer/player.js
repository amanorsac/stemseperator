/**
 * Everything to do with sound in the page: playing a buffer, mixing stems
 * back together, encoding a WAV, drawing a waveform, and finding a song's
 * cover art. No DOM in here; app.js owns that.
 */

/* ------------------------------------------------------------------ *
 * The player: any number of tracks of the same length, played in lock-step.
 *
 * Every stem is its own source feeding its own gain node, so switching a
 * stem off, soloing one, or riding its level is a gain change on a running
 * graph — instant, click-free, and never a restart. Only seeking restarts
 * the sources, and it starts them all at the same clock tick so they can
 * never drift apart.
 * ------------------------------------------------------------------ */
class Player {
  constructor() {
    this.ctx = null;
    this.master = null;
    /** [{ id, buffer, gain (linear), node (GainNode|null), source (AudioBufferSourceNode|null) }] */
    this.tracks = [];
    this.duration = 0;
    this.playing = false;
    this.startedAtCtxTime = 0;
    this.startOffset = 0;
    this.volume = 0.8;
    this.generation = 0;
    this.listeners = new Set();
  }

  ensure() {
    // A player, not an instrument: a bigger buffer costs a few milliseconds
    // of latency nobody notices and rides out a busy processor without
    // dropping out.
    this.ctx ??= new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'playback' });
    if (!this.master) {
      this.master = this.ctx.createGain();
      this.master.gain.value = this.volume;
      this.master.connect(this.ctx.destination);
    }
    return this.ctx;
  }

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  notify() { this.listeners.forEach(fn => fn()); }

  get loaded() { return this.tracks.length > 0; }

  get position() {
    if (!this.playing || !this.ctx) return this.startOffset;
    return Math.max(0, Math.min(this.duration, this.startOffset + (this.ctx.currentTime - this.startedAtCtxTime)));
  }

  /** One buffer, from the top: a song just opened. */
  load(buffer) {
    this.stopSources();
    this.tracks = buffer ? [{ id: 'song', buffer, gain: 1, node: null, source: null }] : [];
    this.duration = buffer ? buffer.duration : 0;
    this.playing = false;
    this.startOffset = 0;
    this.notify();
  }

  /** Nothing loaded at all. */
  unload() { this.load(null); }

  /**
   * Swap in a new set of tracks for the same song — the stems arriving while
   * the original was playing, say — keeping the playhead and play state.
   * @param {Array<{id: string, buffer: AudioBuffer, gain?: number}>} tracks
   */
  setTracks(tracks) {
    const at = this.position;
    const wasPlaying = this.playing;
    this.stopSources();
    this.tracks = tracks.map(track => ({ id: track.id, buffer: track.buffer, gain: track.gain ?? 1, node: null, source: null }));
    this.duration = this.tracks.reduce((max, track) => Math.max(max, track.buffer.duration), 0);
    this.startOffset = Math.min(at, this.duration);
    this.playing = false;
    if (wasPlaying) this.startSources();
    else this.notify();
  }

  /** A track's level, taking effect over a few milliseconds so it never clicks. */
  setTrackGain(id, gain) {
    const track = this.tracks.find(item => item.id === id);
    if (!track) return;
    track.gain = Math.max(0, gain);
    if (track.node && this.ctx) {
      const now = this.ctx.currentTime;
      track.node.gain.cancelScheduledValues(now);
      track.node.gain.setValueAtTime(track.node.gain.value, now);
      track.node.gain.linearRampToValueAtTime(track.gain, now + 0.02);
    }
  }

  /** Several at once; ids not named are left as they are. */
  setGains(gains) {
    Object.entries(gains).forEach(([id, gain]) => this.setTrackGain(id, gain));
  }

  async play() {
    if (!this.loaded || this.playing) return;
    // The context is only ever made here, on a click, so the browser never
    // holds it suspended; and if it was, it is woken before anything starts.
    this.ensure();
    if (this.ctx.state === 'suspended') {
      const generation = this.generation;
      try { await this.ctx.resume(); } catch { /* the start below will tell */ }
      // Something else (a seek, a stop) happened while the context woke.
      if (generation !== this.generation || this.playing) return;
    }
    if (this.startOffset >= this.duration - 0.01) this.startOffset = 0;
    this.startSources();
  }

  pause() {
    if (!this.playing) return;
    this.startOffset = this.position;
    this.stopSources();
    this.playing = false;
    this.notify();
  }

  stop() {
    this.stopSources();
    this.playing = false;
    this.startOffset = 0;
    this.notify();
  }

  seek(seconds) {
    const clamped = Math.max(0, Math.min(this.duration, seconds));
    const wasPlaying = this.playing;
    this.stopSources();
    this.playing = false;
    this.startOffset = clamped;
    if (wasPlaying && clamped < this.duration - 0.01) this.startSources();
    else this.notify();
  }

  setVolume(value) {
    this.volume = Math.max(0, Math.min(1, value));
    if (this.master && this.ctx) {
      const now = this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setValueAtTime(this.master.gain.value, now);
      this.master.gain.linearRampToValueAtTime(this.volume, now + 0.02);
    }
  }

  /** Start every track at the current offset, all on the same clock tick. */
  startSources() {
    this.ensure();
    this.generation += 1;
    const generation = this.generation;
    // A hair in the future, so every source is scheduled before any begins.
    const when = this.ctx.currentTime + 0.03;
    const offset = this.startOffset;
    let longest = null;
    this.tracks.forEach(track => {
      const node = this.ctx.createGain();
      node.gain.value = track.gain;
      node.connect(this.master);
      const source = this.ctx.createBufferSource();
      source.buffer = track.buffer;
      source.connect(node);
      if (offset < track.buffer.duration) source.start(when, offset);
      track.node = node;
      track.source = source;
      if (!longest || track.buffer.duration > longest.buffer.duration) longest = track;
    });
    if (longest?.source) {
      longest.source.onended = () => {
        if (generation !== this.generation || !this.playing) return;
        this.stopSources();
        this.playing = false;
        this.startOffset = this.duration;
        this.notify();
      };
    }
    this.startedAtCtxTime = when;
    this.playing = true;
    this.notify();
  }

  stopSources() {
    this.generation += 1;
    this.tracks.forEach(track => {
      if (track.source) {
        try { track.source.onended = null; track.source.stop(); } catch { /* never started or already stopped */ }
        try { track.source.disconnect(); } catch { /* already gone */ }
      }
      if (track.node) { try { track.node.disconnect(); } catch { /* already gone */ } }
      track.source = null;
      track.node = null;
    });
  }
}

/* ------------------------------------------------------------------ *
 * Buffers
 * ------------------------------------------------------------------ */

/** Needs no AudioContext, so a buffer can be built before the first click. */
function toAudioBuffer(channels, rate = RATE) {
  const buffer = new AudioBuffer({ numberOfChannels: 2, length: Math.max(1, channels[0].length), sampleRate: rate });
  channels.forEach((data, index) => buffer.copyToChannel(data, index));
  return buffer;
}

/** A buffer's channels as fresh float arrays, safe to hand to a worker. */
function channelsOf(buffer) {
  const left = new Float32Array(buffer.length);
  const right = new Float32Array(buffer.length);
  buffer.copyFromChannel(left, 0);
  buffer.copyFromChannel(right, buffer.numberOfChannels > 1 ? 1 : 0);
  return [left, right];
}

/** Decode a file without opening the live audio engine. */
async function decodeFile(bytes) {
  const scratch = new OfflineAudioContext(2, 1, RATE);
  return scratch.decodeAudioData(bytes);
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

/* ------------------------------------------------------------------ *
 * Waveforms
 * ------------------------------------------------------------------ */

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
