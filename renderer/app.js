/**
 * Easy Stems' whole interface: one page, no build step, no framework.
 *
 * The heavy lifting — running the network — happens in the main process,
 * reached through `window.easyStems` (see electron/preload.cjs). This file
 * only ever decodes audio, mixes stems back together for playback, and
 * drives the DOM.
 */

const STEM_ORDER = ['drums', 'bass', 'guitar', 'piano', 'vocals', 'other'];
const STEM_LABELS = { drums: 'Drums', bass: 'Bass', guitar: 'Guitar', piano: 'Keys', vocals: 'Vocals', other: 'Aux' };
const RATE = 44100;

const bridge = window.easyStems;

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
    this.listeners = new Set();
  }

  ensure() {
    this.ctx ??= new (window.AudioContext || window.webkitAudioContext)();
    if (!this.gain) {
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 0.8;
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

  /** Load a fresh buffer, replacing whatever was playing. */
  load(buffer) {
    this.stopNode();
    this.buffer = buffer;
    this.duration = buffer.duration;
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
    const node = this.ctx.createBufferSource();
    node.buffer = this.buffer;
    node.connect(this.gain);
    const offset = Math.min(this.startOffset, this.duration);
    node.onended = () => {
      if (this.source !== node) return;
      this.playing = false;
      this.startOffset = this.duration;
      this.notify();
    };
    node.start(0, offset);
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
    this.ensure();
    this.gain.gain.value = Math.max(0, Math.min(1, value));
  }

  stopNode() {
    if (!this.source) return;
    try { this.source.onended = null; this.source.stop(); } catch { /* already stopped */ }
    try { this.source.disconnect(); } catch { /* already gone */ }
    this.source = null;
  }
}

const player = new Player();

/* ------------------------------------------------------------------ *
 * Mixing separated stems back into something playable
 * ------------------------------------------------------------------ */

/** Sum 16-bit interleaved-stereo stems into floating stereo channels. */
function mixStems(stems) {
  const frames = stems.length ? Math.floor(stems[0].length / 2) : 0;
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  stems.forEach(samples => {
    for (let i = 0; i < frames; i += 1) {
      left[i] += samples[i * 2] / 32768;
      right[i] += samples[i * 2 + 1] / 32768;
    }
  });
  return [left, right];
}

function toAudioBuffer(channels) {
  const ctx = player.ensure();
  const buffer = ctx.createBuffer(2, Math.max(1, channels[0].length), RATE);
  channels.forEach((data, index) => buffer.copyToChannel(data, index));
  return buffer;
}

/* ------------------------------------------------------------------ *
 * App state
 * ------------------------------------------------------------------ */

const state = {
  fileName: '',
  songId: '',
  phase: 'none', // none | downloading | separating | loading | ready
  progress: 0,
  error: '',
  audible: Object.fromEntries(STEM_ORDER.map(stem => [stem, true])),
};
/** stem name -> Int16Array of interleaved stereo samples */
const stemData = new Map();

/* ------------------------------------------------------------------ *
 * DOM
 * ------------------------------------------------------------------ */

const el = id => document.getElementById(id);
const fileInput = el('file-input');
const dropZone = el('drop-zone');
const chooseFileBtn = el('choose-file');
const introError = el('intro-error');
const songPanel = el('song-panel');
const songName = el('song-name');
const songDuration = el('song-duration');
const playPauseBtn = el('play-pause');
const stopBtn = el('stop');
const timeEl = el('time');
const seekEl = el('seek');
const volumeEl = el('volume');
const separateRow = el('separate-row');
const separateBtn = el('separate');
const progressEl = el('progress');
const progressLabel = el('progress-label');
const progressBar = el('progress-bar');
const cancelBtn = el('cancel');
const songError = el('song-error');
const mixerEl = el('mixer');
const mixerActions = el('mixer-actions');
const everyoneBtn = el('everyone');
const downloadAllBtn = el('download-all');
const importAnotherBtn = el('import-another');
const closeSongBtn = el('close-song');
const libraryEl = el('library');
const libraryListEl = el('library-list');

const formatTime = seconds => {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const whole = Math.floor(seconds);
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
};

function showError(target, message) {
  target.textContent = message;
  target.hidden = !message;
}

/* ------------------------------------------------------------------ *
 * Opening a file
 * ------------------------------------------------------------------ */

async function openFile(file) {
  showError(introError, '');
  showError(songError, '');
  stemData.clear();
  state.songId = '';
  state.phase = 'none';
  state.progress = 0;
  state.audible = Object.fromEntries(STEM_ORDER.map(stem => [stem, true]));

  try {
    const bytes = await file.arrayBuffer();
    const ctx = player.ensure();
    const decoded = await ctx.decodeAudioData(bytes);
    state.fileName = file.name.replace(/\.[^.]+$/, '');
    player.load(decoded);
    songName.textContent = state.fileName;
    songDuration.textContent = formatTime(decoded.duration);
    dropZone.hidden = true;
    songPanel.hidden = false;
    renderStemsPanel();
  } catch {
    showError(introError, 'That file could not be read. Try an MP3, WAV or M4A.');
  }
}

/* ------------------------------------------------------------------ *
 * Separation
 * ------------------------------------------------------------------ */

async function separate() {
  if (!bridge?.stemSeparate) {
    state.error = 'Separating instruments needs the installed desktop app.';
    renderStemsPanel();
    return;
  }
  if (state.phase !== 'none' || !player.buffer) return;

  state.error = '';
  state.phase = 'separating';
  state.progress = 0;
  renderStemsPanel();

  try {
    const status = await bridge.stemStatus();
    if (!status.modelReady) {
      state.phase = 'downloading';
      renderStemsPanel();
      await bridge.stemDownload();
    }
    state.phase = 'separating';
    state.progress = 0;
    renderStemsPanel();

    // The network was trained on 44.1 kHz stereo and hears nothing else well.
    const source = player.buffer;
    const length = Math.ceil(source.duration * RATE);
    const offline = new OfflineAudioContext(2, length, RATE);
    const node = offline.createBufferSource();
    node.buffer = source;
    node.connect(offline.destination);
    node.start();
    const prepared = await offline.startRendering();
    const left = prepared.getChannelData(0).slice();
    const right = prepared.getChannelData(1).slice();

    const result = await bridge.stemSeparate(left.buffer, right.buffer);
    state.songId = result.id;

    state.phase = 'loading';
    state.progress = 0;
    renderStemsPanel();
    for (let i = 0; i < STEM_ORDER.length; i += 1) {
      const stemBytes = await bridge.stemRead(result.id, STEM_ORDER[i]);
      // Past the 44-byte header, a WAV of this kind is nothing but samples.
      stemData.set(STEM_ORDER[i], new Int16Array(stemBytes, 44, Math.floor((stemBytes.byteLength - 44) / 2)));
      state.progress = (i + 1) / STEM_ORDER.length;
      renderStemsPanel();
    }
    state.phase = 'ready';
    applyAudible(state.audible);
    renderStemsPanel();
    void bridge.librarySave?.({ id: state.songId, name: state.fileName, duration: player.duration })
      .then(() => refreshLibrary());
  } catch (error) {
    stemData.clear();
    state.phase = 'none';
    state.progress = 0;
    state.error = (error && error.message) || 'Separation failed.';
    renderStemsPanel();
  }
}

bridge?.onStemProgress?.(({ stage, fraction }) => {
  state.phase = stage === 'download' ? 'downloading' : 'separating';
  state.progress = fraction;
  renderStemsPanel();
});

/* ------------------------------------------------------------------ *
 * The mixer: mute, solo, download
 * ------------------------------------------------------------------ */

function applyAudible(audible) {
  state.audible = audible;
  const on = STEM_ORDER.filter(stem => audible[stem]);
  const parts = on.map(stem => stemData.get(stem)).filter(Boolean);
  if (!parts.length) return;
  player.loadKeepingPlace(toAudioBuffer(mixStems(parts)));
}

function toggleStem(stem) {
  applyAudible({ ...state.audible, [stem]: !state.audible[stem] });
  renderMixer();
}

function soloStem(stem) {
  const audible = state.audible;
  const alone = STEM_ORDER.every(name => audible[name] === (name === stem));
  const next = Object.fromEntries(STEM_ORDER.map(name => [name, alone || name === stem]));
  applyAudible(next);
  renderMixer();
}

function everyone() {
  applyAudible(Object.fromEntries(STEM_ORDER.map(stem => [stem, true])));
  renderMixer();
}

async function downloadStem(stem) {
  if (!bridge?.stemRead || !state.songId) return;
  try {
    const bytes = await bridge.stemRead(state.songId, stem);
    const suggested = `${state.fileName} - ${STEM_LABELS[stem]}.wav`;
    if (bridge.saveStem) {
      await bridge.saveStem(bytes, suggested);
    } else {
      const blob = new Blob([bytes], { type: 'audio/wav' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = suggested;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }
  } catch {
    state.error = 'That stem could not be saved.';
    renderStemsPanel();
  }
}

/** Save every stem in one pass — one folder picked once, not six dialogs. */
async function downloadAll() {
  if (!bridge?.stemRead || !state.songId) return;
  try {
    if (bridge.saveAllStems) {
      const files = await Promise.all(STEM_ORDER.map(async stem => ({
        name: `${state.fileName} - ${STEM_LABELS[stem]}.wav`,
        bytes: await bridge.stemRead(state.songId, stem),
      })));
      await bridge.saveAllStems(files);
    } else {
      for (const stem of STEM_ORDER) await downloadStem(stem);
    }
  } catch {
    state.error = 'The stems could not be saved.';
    renderStemsPanel();
  }
}

/* ------------------------------------------------------------------ *
 * The library: songs already separated, reopened without splitting again.
 * A song only ever gets an entry once separation succeeds, because that is
 * what makes it reopenable — its stems, not the original file, are what's
 * saved on disk.
 * ------------------------------------------------------------------ */

async function refreshLibrary() {
  if (!bridge?.libraryList) return;
  try {
    renderLibrary(await bridge.libraryList());
  } catch { /* whatever was already shown stays shown */ }
}

function renderLibrary(entries) {
  libraryEl.hidden = !entries.length;
  libraryListEl.innerHTML = entries.map(entry => `
    <div class="library-item" data-id="${entry.id}">
      <button class="library-open" data-action="open">
        <b>${entry.name}</b>
        <small>${formatTime(entry.duration)}</small>
      </button>
      <button class="download-btn" data-action="forget" aria-label="Forget ${entry.name}" title="Forget">&#10005;</button>
    </div>`).join('');

  libraryListEl.querySelectorAll('.library-item').forEach(row => {
    const id = row.dataset.id;
    const entry = entries.find(item => item.id === id);
    row.querySelector('[data-action="open"]').addEventListener('click', () => void openFromLibrary(entry));
    row.querySelector('[data-action="forget"]').addEventListener('click', async () => {
      if (!bridge?.libraryDelete) return;
      renderLibrary(await bridge.libraryDelete(id));
    });
  });
}

/** Reopen a saved song: its stems are read back and summed into a mix — the
 * original file is never needed again. */
async function openFromLibrary(entry) {
  if (!bridge?.stemRead || !entry) return;
  showError(introError, '');
  stemData.clear();

  try {
    for (const stem of STEM_ORDER) {
      const bytes = await bridge.stemRead(entry.id, stem);
      stemData.set(stem, new Int16Array(bytes, 44, Math.floor((bytes.byteLength - 44) / 2)));
    }
    state.fileName = entry.name;
    state.songId = entry.id;
    state.phase = 'ready';
    state.error = '';
    state.audible = Object.fromEntries(STEM_ORDER.map(stem => [stem, true]));

    player.load(toAudioBuffer(mixStems([...stemData.values()])));
    songName.textContent = state.fileName;
    songDuration.textContent = formatTime(player.duration);
    dropZone.hidden = true;
    songPanel.hidden = false;
    renderStemsPanel();
  } catch {
    showError(introError, "That song's stems could not be found.");
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderMixer() {
  const ready = state.phase === 'ready';
  mixerEl.hidden = !ready;
  mixerActions.hidden = !ready;
  if (!ready) { mixerEl.innerHTML = ''; return; }

  const allOn = STEM_ORDER.every(stem => state.audible[stem]);
  everyoneBtn.disabled = allOn;

  // Soloed, for the button's own highlight, when exactly one stem is audible.
  const soloed = STEM_ORDER.filter(stem => state.audible[stem]).length === 1
    ? STEM_ORDER.find(stem => state.audible[stem])
    : null;

  mixerEl.innerHTML = STEM_ORDER.map(stem => {
    const muted = !state.audible[stem];
    return `
      <div class="stem-row ${muted ? 'muted' : ''}" data-stem="${stem}">
        <button class="mute-btn" data-action="toggle" aria-pressed="${muted}"
          aria-label="${muted ? 'Unmute' : 'Mute'} ${STEM_LABELS[stem]}">${muted ? '&#128263;' : '&#128266;'}</button>
        <span class="stem-name">${STEM_LABELS[stem]}</span>
        <button class="solo-btn ${stem === soloed ? 'active' : ''}" data-action="solo"
          aria-pressed="${stem === soloed}">Solo</button>
        <button class="download-btn" data-action="download" aria-label="Download ${STEM_LABELS[stem]}" title="Download">&#8681;</button>
      </div>`;
  }).join('');

  mixerEl.querySelectorAll('.stem-row').forEach(row => {
    const stem = row.dataset.stem;
    row.querySelector('[data-action="toggle"]').addEventListener('click', () => toggleStem(stem));
    row.querySelector('[data-action="solo"]').addEventListener('click', () => soloStem(stem));
    row.querySelector('[data-action="download"]').addEventListener('click', () => void downloadStem(stem));
  });
}

function renderStemsPanel() {
  const busy = state.phase === 'downloading' || state.phase === 'separating' || state.phase === 'loading';
  separateRow.hidden = state.phase !== 'none';
  progressEl.hidden = !busy;
  cancelBtn.hidden = state.phase !== 'separating';

  if (busy) {
    progressLabel.textContent =
      state.phase === 'downloading' ? `Downloading the model… ${Math.round(state.progress * 100)}%`
      : state.phase === 'loading' ? 'Opening the instruments…'
      : state.progress > 0 ? `Separating… ${Math.round(state.progress * 100)}%`
      : 'Getting ready. This first step takes half a minute…';
    progressBar.style.width = `${Math.round(state.progress * 100)}%`;
  }

  showError(songError, state.error);
  renderMixer();
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

function renderTransport() {
  playPauseBtn.textContent = player.playing ? '⏸' : '▶';
  playPauseBtn.setAttribute('aria-label', player.playing ? 'Pause' : 'Play');
  playPauseBtn.classList.toggle('play', !player.playing);
  seekEl.max = String(player.duration || 1);
  if (document.activeElement !== seekEl) seekEl.value = String(Math.min(player.position, player.duration));
  timeEl.textContent = `${formatTime(player.position)} / ${formatTime(player.duration)}`;
}
player.subscribe(renderTransport);
setInterval(renderTransport, 150);

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

const onFiles = files => {
  const file = [...files].find(item => item.type.startsWith('audio/') || item.type.startsWith('video/')) || files[0];
  if (file) void openFile(file);
};

chooseFileBtn.addEventListener('click', () => fileInput.click());
importAnotherBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { onFiles(fileInput.files); fileInput.value = ''; });

dropZone.addEventListener('dragover', event => { event.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', event => {
  event.preventDefault();
  dropZone.classList.remove('drag-over');
  onFiles(event.dataTransfer.files);
});

playPauseBtn.addEventListener('click', () => (player.playing ? player.pause() : player.play()));
stopBtn.addEventListener('click', () => player.stop());
seekEl.addEventListener('input', () => player.seek(Number(seekEl.value)));
volumeEl.addEventListener('input', () => player.setVolume(Number(volumeEl.value)));
player.setVolume(Number(volumeEl.value));

separateBtn.addEventListener('click', () => void separate());
cancelBtn.addEventListener('click', () => bridge?.stemCancel?.());
everyoneBtn.addEventListener('click', everyone);
downloadAllBtn.addEventListener('click', () => void downloadAll());

closeSongBtn.addEventListener('click', () => {
  player.stop();
  player.buffer = null;
  player.duration = 0;
  stemData.clear();
  Object.assign(state, {
    fileName: '', songId: '', phase: 'none', progress: 0, error: '',
    audible: Object.fromEntries(STEM_ORDER.map(stem => [stem, true])),
  });
  songPanel.hidden = true;
  dropZone.hidden = false;
  renderStemsPanel();
  void refreshLibrary();
});

void refreshLibrary();

/* ------------------------------------------------------------------ *
 * Window chrome, only present under Electron
 * ------------------------------------------------------------------ */

if (bridge?.isDesktop) {
  el('window-controls').hidden = false;
  el('win-min').addEventListener('click', () => bridge.minimize());
  el('win-max').addEventListener('click', () => bridge.maximize());
  el('win-close').addEventListener('click', () => bridge.close());
}
