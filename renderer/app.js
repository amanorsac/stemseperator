/**
 * Easy Stems' interface: one page, no build step, no framework.
 *
 * The heavy lifting — running the networks — happens in the main process,
 * reached through `window.easyStems` (see electron/preload.cjs). This file
 * decodes audio, keeps the app's state, and drives the DOM.
 */

const bridge = window.easyStems;
const el = id => document.getElementById(id);

/* ------------------------------------------------------------------ *
 * Stems
 * ------------------------------------------------------------------ */

const STEM_DEFS = {
  drums: { label: 'Drums', color: 'var(--drums)', icon: 'drum' },
  bass: { label: 'Bass', color: 'var(--bass)', icon: 'guitar' },
  guitar: { label: 'Guitar', color: 'var(--guitar)', icon: 'guitar' },
  piano: { label: 'Keys', color: 'var(--keys)', icon: 'piano' },
  vocals: { label: 'Vocals', color: 'var(--lead)', icon: 'mic' },
  lead_vocals: { label: 'Lead Vocals', color: 'var(--lead)', icon: 'mic-vocal' },
  backing_vocals: { label: 'Backing Vocals', color: 'var(--backing)', icon: 'users' },
  other: { label: 'Aux / Other', file: 'Aux', color: 'var(--aux)', icon: 'ellipsis' },
  instrumental: { label: 'Instrumental', color: 'var(--aux)', icon: 'music' },
};

/** The stems a song has, in the order they're shown, by how it was separated. */
function stemOrder(mode, split) {
  if (mode === 'quick') return split ? ['lead_vocals', 'backing_vocals', 'instrumental'] : ['vocals', 'instrumental'];
  return split
    ? ['drums', 'bass', 'guitar', 'piano', 'lead_vocals', 'backing_vocals', 'other']
    : ['drums', 'bass', 'guitar', 'piano', 'vocals', 'other'];
}
const WAVE_BUCKETS = 240;
const SONG_BUCKETS = 800;

/* ------------------------------------------------------------------ *
 * Settings, kept in the page's own storage
 * ------------------------------------------------------------------ */

const DEFAULT_SETTINGS = { sampleRate: 44100, bitDepth: 16, outputFolder: '', splitVocals: true, exportMode: 'stems', gpu: false, mode: 'full' };
const settings = { ...DEFAULT_SETTINGS };
try { Object.assign(settings, JSON.parse(localStorage.getItem('easy-stems.settings') || '{}')); } catch { /* defaults */ }
function saveSettings() {
  try { localStorage.setItem('easy-stems.settings', JSON.stringify(settings)); } catch { /* nothing to do */ }
}

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */

const state = {
  page: 'split',
  /** With a song open: looking at it ('song'), or back at the library ('home'). */
  view: 'song',
  /** The open song, or null. */
  song: null,
  /** [{ key, label, color, icon, on, gain (dB), buffer, peaks, songPeaks }] */
  stems: [],
  /** A stem heard alone without touching the switches, or null. */
  audition: null,
  /** { label, sub, progress, cancellable } while something long runs. */
  working: null,
  error: '',
  library: [],
  batch: [],
  batchRunning: false,
  models: { modelReady: false, karaokeReady: false },
  contentFolder: '',
};

const player = new Player();

/* ------------------------------------------------------------------ *
 * The page's worker: every loop over a whole song runs there, so the
 * window never freezes while stems load or files are written.
 * ------------------------------------------------------------------ */
const audioJobs = new Map();
let audioJobId = 0;
const audioWorker = new Worker('audio-worker.js');
audioWorker.onmessage = ({ data }) => {
  const job = audioJobs.get(data.id);
  if (!job) return;
  audioJobs.delete(data.id);
  if (data.error) job.reject(new Error(data.error)); else job.resolve(data.result);
};
function audioJob(type, payload, transfer = []) {
  audioJobId += 1;
  return new Promise((resolve, reject) => {
    audioJobs.set(audioJobId, { resolve, reject });
    audioWorker.postMessage({ id: audioJobId, type, ...payload }, transfer);
  });
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(node => {
    if (node.dataset.hydrated) return;
    node.innerHTML = icon(node.dataset.icon, 20);
    node.dataset.hydrated = '1';
  });
}

let toastTimer = 0;
function toast(message, isError = false) {
  const node = el('toast');
  node.textContent = message;
  node.classList.toggle('error', isError);
  node.hidden = false;
  window.clearTimeout(toastTimer);
  // The studio's contract says 1.5 to 3 seconds; an error gets the long end
  // twice, because it has to be read, not just noticed.
  toastTimer = window.setTimeout(() => { node.hidden = true; }, isError ? 6000 : 3000);
}

/* ------------------------------------------------------------------ *
 * Dropdown: the product's own, never the OS control. A button that opens
 * a list; arrow keys move, Enter picks, Escape closes.
 * ------------------------------------------------------------------ */
const dropdowns = {};
function initDropdown(id, onChange) {
  const host = el(id);
  const options = JSON.parse(host.dataset.options);
  const dd = { value: options[0][0], options, onChange, host };
  host.innerHTML = `<button type="button" class="dropdown-btn" aria-haspopup="listbox" aria-expanded="false"><em></em>${icon('chevron-down', 16)}</button>
    <ul class="dropdown-list" role="listbox" hidden></ul>`;
  const button = host.querySelector('.dropdown-btn');
  const list = host.querySelector('.dropdown-list');
  if (host.getAttribute('aria-labelledby')) button.setAttribute('aria-labelledby', host.getAttribute('aria-labelledby'));
  const label = () => (options.find(([value]) => value === dd.value) || options[0])[1];
  const paint = () => {
    button.querySelector('em').textContent = label();
    list.innerHTML = options.map(([value, text]) => `<li role="option" data-value="${value}" aria-selected="${value === dd.value}">${text}</li>`).join('');
    list.querySelectorAll('li').forEach(item => item.addEventListener('click', () => choose(item.dataset.value)));
  };
  const close = () => { list.hidden = true; host.classList.remove('open'); button.setAttribute('aria-expanded', 'false'); };
  const open = () => { paint(); list.hidden = false; host.classList.add('open'); button.setAttribute('aria-expanded', 'true'); };
  const choose = value => { const changed = value !== dd.value; dd.value = value; paint(); close(); button.focus(); if (changed) onChange?.(value); };
  button.addEventListener('click', event => { event.stopPropagation(); list.hidden ? open() : close(); });
  button.addEventListener('keydown', event => {
    const index = options.findIndex(([value]) => value === dd.value);
    if (event.key === 'ArrowDown') { event.preventDefault(); choose(options[Math.min(options.length - 1, index + 1)][0]); }
    if (event.key === 'ArrowUp') { event.preventDefault(); choose(options[Math.max(0, index - 1)][0]); }
    if (event.key === 'Escape') close();
  });
  document.addEventListener('click', close);
  Object.defineProperty(dd, 'set', { value: value => { dd.value = String(value); paint(); } });
  paint();
  dropdowns[id] = dd;
  return dd;
}

const cleanError = error => (error && error.message ? error.message : String(error))
  .replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const baseName = name => name.replace(/\.[^.]+$/, '');

/** Elapsed and progress for the stage under way, for a time estimate. */
const pace = { label: '', startedAt: 0, startProgress: 0 };
function setWorking(next) {
  if (next && next.label !== pace.label) {
    pace.label = next.label;
    pace.startedAt = Date.now();
    pace.startProgress = next.progress || 0;
  }
  if (!next) pace.label = '';
  state.working = next;
  renderWork();
}

/** "about 4 min left", once enough of a stage has run to judge its speed. */
function timeLeft(working) {
  const done = working.progress - pace.startProgress;
  const elapsed = (Date.now() - pace.startedAt) / 1000;
  if (done < 0.04 || elapsed < 8) return '';
  const remaining = elapsed / done * (1 - working.progress);
  if (remaining < 45) return 'under a minute left';
  return `about ${Math.round(remaining / 60)} min left`;
}

/* ------------------------------------------------------------------ *
 * Pages
 * ------------------------------------------------------------------ */

function showPage(name) {
  if (name === 'export') {
    // Export lives on the song's page; the nav item just takes you to it.
    showPage('split');
    if (state.song && state.stems.length) {
      if (state.view === 'home') backToSong();
      el('export-panel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      toast('Open and separate a song first, then Export is at the bottom of its page.');
    }
    return;
  }
  state.page = name;
  document.querySelectorAll('.page').forEach(page => { page.hidden = page.id !== `page-${name}`; });
  document.querySelectorAll('#nav button').forEach(button => button.classList.toggle('active', button.dataset.page === name));
  if (name === 'settings') void renderSettings();
}

/* ------------------------------------------------------------------ *
 * Opening a song
 * ------------------------------------------------------------------ */

async function openFile(file) {
  if (state.working) { toast('Wait for the current song to finish first.'); return; }
  closeSong(false);
  state.view = 'song';
  state.error = '';
  const name = baseName(file.name);
  try {
    const bytes = await file.arrayBuffer();
    // Decoding takes the buffer away, so the tag is read from a copy first.
    const cover = coverFromId3(bytes.slice(0, Math.min(bytes.byteLength, 8 * 1024 * 1024)));
    const decoded = await decodeFile(bytes);
    state.song = {
      name,
      path: bridge?.pathOf ? bridge.pathOf(file) : '',
      duration: decoded.duration,
      coverUrl: cover ? URL.createObjectURL(cover) : '',
      peaks: peaksOfStereo(decoded.getChannelData(0), decoded.getChannelData(1 % decoded.numberOfChannels), SONG_BUCKETS),
      songId: '',
      split: false,
      mode: settings.mode,
      buffer: decoded,
    };
    player.load(decoded);
    renderSong();
    await separateCurrent();
  } catch (error) {
    state.error = cleanError(error) || 'That file could not be read. Try an MP3, WAV, M4A or FLAC.';
    if (!state.song) el('intro-error').textContent = state.error;
    el('intro-error').hidden = Boolean(state.song) || !state.error;
    renderError();
  }
}

function closeSong(refresh = true) {
  player.unload();
  if (state.song?.coverUrl) URL.revokeObjectURL(state.song.coverUrl);
  state.song = null;
  state.stems = [];
  state.audition = null;
  state.error = '';
  renderSong();
  renderStems();
  if (refresh) void refreshLibrary();
}

/** The network was trained on 44.1 kHz stereo and hears nothing else well. */
async function prepare44k(buffer) {
  const rendered = await resample(buffer, RATE);
  return [rendered.getChannelData(0).slice(), rendered.getChannelData(1).slice()];
}

/* ------------------------------------------------------------------ *
 * Separation
 * ------------------------------------------------------------------ */

/** Live progress from the engine, routed to whatever's showing it. */
let progressSink = null;
bridge?.onStemProgress?.(({ stage, fraction }) => {
  const labels = {
    download: ['Downloading the separation model…', 'About 136 MB, once only.'],
    'download-karaoke': ['Downloading the vocal model…', 'About 53 MB, once only.'],
    'download-quick': ['Downloading the quick model…', 'About 53 MB, once only.'],
    separate: ['Separating the instruments…', 'Drums, bass, guitar, keys, vocals and the rest.'],
    quick: ['Separating the vocals…', 'Quick mode: vocals and instrumental.'],
    split: ['Splitting the vocals…', 'Lifting the lead singer off the backing vocals.'],
  };
  const [label, sub] = labels[stage] || ['Working…', ''];
  progressSink?.({ stage, fraction, label, sub });
});

/** Fetch whichever networks a step needs and doesn't have yet. */
async function ensureModels({ demucs = false, karaoke = false, quick = false }) {
  if (!bridge?.stemStatus) throw new Error('Separating instruments needs the installed desktop app.');
  const status = await bridge.stemStatus();
  state.models = status;
  if (demucs && !status.modelReady) await bridge.stemDownload();
  if (quick && !status.quickReady) await bridge.stemDownloadQuick();
  if (karaoke && !status.karaokeReady) await bridge.stemDownloadKaraoke();
  state.models = await bridge.stemStatus();
}

/**
 * Separate a decoded song — quickly into vocals and instrumental, or fully
 * into six instruments — splitting its vocals when asked to. Resolves with
 * the song's fingerprint, how it was separated and whether the split happened.
 */
async function separateBuffer(buffer, onProgress, mode = settings.mode) {
  progressSink = onProgress;
  try {
    const quick = mode === 'quick';
    onProgress({ stage: 'prepare', fraction: 0, label: 'Getting ready…', sub: 'Checking the models are here.' });
    await ensureModels({ demucs: !quick, quick, karaoke: settings.splitVocals });
    const [left, right] = await prepare44k(buffer);
    if (quick) onProgress({ stage: 'quick', fraction: 0, label: 'Separating the vocals…', sub: 'Quick mode: vocals and instrumental.' });
    else onProgress({ stage: 'separate', fraction: 0, label: 'Separating the instruments…', sub: 'The first piece takes half a minute to warm up.' });
    const result = await bridge.stemSeparate(left.buffer, right.buffer, mode);
    // A song already separated the full way is opened that way, whatever was asked.
    mode = result.mode === 'quick' ? 'quick' : 'full';
    let split = false;
    if (settings.splitVocals) {
      try {
        onProgress({ stage: 'split', fraction: 0, label: 'Splitting the vocals…', sub: 'Lifting the lead singer off the backing vocals.' });
        await bridge.stemSplitVocals(result.id);
        split = true;
      } catch (error) {
        if (/cancel/i.test(cleanError(error))) throw error;
        toast(`The vocals couldn't be split (${cleanError(error)}). Showing them as one stem.`, true);
      }
    }
    return { id: result.id, split, mode };
  } finally {
    progressSink = null;
  }
}

async function separateCurrent() {
  const song = state.song;
  if (!song || !song.buffer) return;
  if (!bridge?.stemSeparate) {
    state.error = 'Separating instruments needs the installed desktop app.';
    renderError();
    return;
  }
  setWorking({ label: 'Getting ready…', sub: '', progress: 0, cancellable: true });
  try {
    const { id, split, mode } = await separateBuffer(song.buffer, ({ stage, fraction, label, sub }) => {
      if (state.song !== song) return;
      setWorking({ label, sub, progress: fraction, cancellable: ['separate', 'quick', 'split'].includes(stage) });
    }, song.mode);
    if (state.song !== song) return;
    song.songId = id;
    song.split = split;
    song.mode = mode;
    setWorking({ label: 'Opening the stems…', sub: '', progress: 1, cancellable: false });
    await loadStems(id, split, mode);
    if (state.song !== song) return;
    setWorking(null);
    void bridge.librarySave?.({ id, name: song.name, duration: song.duration, split, mode }).then(() => refreshLibrary());
  } catch (error) {
    if (state.song !== song) return;
    setWorking(null);
    state.error = cleanError(error) || 'Separation failed.';
    renderError();
  }
}

/** Read a song's stems back from the cache and put them in the mixer. */
async function loadStems(id, split, mode) {
  const order = stemOrder(mode, split);
  // Each stem is read from disk and unpacked in the worker; the main
  // thread's only share is copying the channels into an AudioBuffer.
  const stems = await Promise.all(order.map(async key => {
    const bytes = await bridge.stemRead(id, key);
    const { left, right, peaks, songPeaks } = await audioJob('decode', { bytes, waveBuckets: WAVE_BUCKETS, songBuckets: SONG_BUCKETS }, [bytes]);
    return { key, ...STEM_DEFS[key], on: true, gain: 0, buffer: toAudioBuffer([left, right]), peaks, songPeaks };
  }));
  state.stems = stems;
  state.audition = null;
  // The original song has done its job; the stems are what plays now.
  if (state.song) state.song.buffer = null;
  buildStems();
  remix(true);
}

/* ------------------------------------------------------------------ *
 * The mixer
 * ------------------------------------------------------------------ */

/** What's audible right now: an auditioned stem alone, else every stem that's on. */
function audibleStems() {
  if (state.audition) return state.stems.filter(stem => stem.key === state.audition);
  return state.stems.filter(stem => stem.on);
}

/** Mix stems at their levels, in the worker. Resolves with [left, right]. */
async function mixOf(stems) {
  const parts = stems.map(stem => {
    const [left, right] = channelsOf(stem.buffer);
    return { left, right, gain: dbToGain(stem.gain) };
  });
  const { left, right } = await audioJob('mix', { parts }, parts.flatMap(part => [part.left.buffer, part.right.buffer]));
  return [left, right];
}

/** What a stem contributes right now: its level, or nothing if it's out. */
function liveGain(stem) {
  const heard = state.audition ? stem.key === state.audition : stem.on;
  return heard ? dbToGain(stem.gain) : 0;
}

/**
 * Apply the switches and levels to the player. Every stem is always playing;
 * what changes is how loud each one is, so nothing ever stops or restarts.
 * `fresh` is for the stems having just arrived: they replace whatever was
 * playing (the original song, usually) without losing the place.
 */
function remix(fresh = false) {
  if (!state.stems.length) return;
  if (fresh) {
    player.setTracks(state.stems.map(stem => ({ id: stem.key, buffer: stem.buffer, gain: liveGain(stem) })));
  } else {
    player.setGains(Object.fromEntries(state.stems.map(stem => [stem.key, liveGain(stem)])));
  }
  if (state.song) {
    // The song's waveform follows the mix: each stem's peaks at its level.
    const peaks = new Float32Array(SONG_BUCKETS);
    state.stems.forEach(stem => {
      const gain = liveGain(stem);
      if (!gain) return;
      for (let i = 0; i < SONG_BUCKETS; i += 1) peaks[i] += stem.songPeaks[i] * gain;
    });
    state.song.peaks = peaks;
    drawSongWave();
  }
}

function toggleStem(key) {
  const stem = state.stems.find(item => item.key === key);
  stem.on = !stem.on;
  updateStems();
  remix();
}

function soloStem(key) {
  const alone = state.stems.every(stem => stem.on === (stem.key === key));
  state.stems.forEach(stem => { stem.on = alone ? true : stem.key === key; });
  updateStems();
  remix();
}

function auditionStem(key) {
  state.audition = state.audition === key ? null : key;
  updateStems();
  remix();
}

function setGain(key, db, commit) {
  const stem = state.stems.find(item => item.key === key);
  stem.gain = db;
  const row = el('stems').querySelector(`[data-stem="${key}"]`);
  if (row) row.querySelector('.gain-label').textContent = `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
  // Heard as the slider moves; the waveform only redrawn when it's let go.
  player.setTrackGain(key, liveGain(stem));
  if (commit) remix();
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

/** A name for a mix, the way someone asking for it would say it. */
function mixLabel(stems) {
  const on = stems.filter(stem => stem.on);
  const off = stems.filter(stem => !stem.on);
  if (!off.length) return 'Full mix';
  if (on.length === 1) return `${on[0].label} only`;
  if (off.length === 1) return `No ${off[0].label}`;
  return on.map(stem => stem.label).join(' + ');
}

/**
 * Where a song's exports go: a folder of its own under the person's Easy
 * Stems content folder (Documents/Amanorsac Studio/Easy Stems), unless they
 * chose somewhere else in Settings.
 */
async function resolveOutputFolder(songName) {
  const root = settings.outputFolder || await bridge.contentFolder();
  return `${root}/${songName}`;
}

/** Encode float stereo at the chosen rate and depth, in the worker. */
async function encodeAt(channels) {
  let [left, right] = channels;
  if (settings.sampleRate !== RATE) {
    [left, right] = channelsOf(await resample(toAudioBuffer(channels), settings.sampleRate));
  }
  return audioJob('encode', { left, right, rate: settings.sampleRate, bits: settings.bitDepth }, [left.buffer, right.buffer]);
}

async function exportNow(overrideMode, only) {
  if (!state.song || !state.stems.length) return;
  const mode = overrideMode || settings.exportMode;
  const name = state.song.name;
  const files = [];
  setWorking({ label: 'Exporting…', sub: 'Writing the files.', progress: 0, cancellable: false });
  try {
    const folder = await resolveOutputFolder(name);
    if (mode === 'stems') {
      const chosen = only ? state.stems.filter(stem => stem.key === only) : state.stems.filter(stem => stem.on);
      if (!chosen.length) throw new Error('Switch on at least one stem to export.');
      for (let i = 0; i < chosen.length; i += 1) {
        const stem = chosen[i];
        files.push({ name: `${name} - ${stem.file || stem.label}.wav`, bytes: await encodeAt(await mixOf([stem])) });
        setWorking({ label: 'Exporting…', sub: stem.label, progress: (i + 1) / chosen.length, cancellable: false });
      }
    } else {
      const stems = only ? state.stems.map(stem => ({ ...stem, on: stem.key !== only })) : state.stems;
      const on = stems.filter(stem => stem.on);
      if (!on.length) throw new Error('Switch on at least one stem to export a mix.');
      files.push({ name: `${name} - ${mixLabel(stems)}.wav`, bytes: await encodeAt(await mixOf(on)) });
    }
    const written = await bridge.writeFiles(folder, files);
    setWorking(null);
    toast(`Saved ${written.length} file${written.length === 1 ? '' : 's'} to ${folder}`);
    void bridge.reveal(written[0]);
  } catch (error) {
    setWorking(null);
    toast(cleanError(error) || 'Export failed.', true);
  }
}

/** Save one stem alone, wherever the person chooses. */
async function downloadStem(key) {
  const stem = state.stems.find(item => item.key === key);
  if (!stem || !state.song) return;
  try {
    const bytes = await encodeAt(await mixOf([stem]));
    await bridge.saveStem(bytes, `${state.song.name} - ${stem.file || stem.label}.wav`);
  } catch (error) {
    toast(cleanError(error) || 'That stem could not be saved.', true);
  }
}

/* ------------------------------------------------------------------ *
 * Batch
 * ------------------------------------------------------------------ */

function addBatchFiles(files) {
  for (const file of files) {
    if (!(file.type.startsWith('audio/') || file.type.startsWith('video/') || /\.(mp3|wav|m4a|flac|ogg|aac|mp4|mov)$/i.test(file.name))) continue;
    state.batch.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      file, name: baseName(file.name), path: bridge?.pathOf ? bridge.pathOf(file) : '',
      status: 'queued', progress: 0, note: '',
    });
  }
  renderBatch();
}

async function runBatch() {
  if (state.batchRunning || state.working) return;
  if (!bridge?.stemSeparate) { toast('Batch processing needs the installed desktop app.', true); return; }
  state.batchRunning = true;
  renderBatch();
  for (const item of state.batch) {
    if (item.status !== 'queued') continue;
    item.status = 'working';
    item.note = 'Reading the file';
    renderBatch();
    try {
      const bytes = await item.file.arrayBuffer();
      const decoded = await decodeFile(bytes);
      const { id, split, mode } = await separateBuffer(decoded, ({ fraction, label }) => {
        item.progress = fraction;
        item.note = label;
        renderBatch();
      });
      item.note = 'Saving the stems';
      renderBatch();
      const folder = await resolveOutputFolder(item.name);
      const order = stemOrder(mode, split);
      const files = [];
      for (const key of order) {
        const raw = await bridge.stemRead(id, key);
        const { left, right } = await audioJob('decode', { bytes: raw, waveBuckets: 1, songBuckets: 1 }, [raw]);
        files.push({ name: `${item.name} - ${STEM_DEFS[key].file || STEM_DEFS[key].label}.wav`, bytes: await encodeAt([left, right]) });
      }
      await bridge.writeFiles(folder, files);
      void bridge.librarySave?.({ id, name: item.name, duration: decoded.duration, split, mode });
      item.status = 'done';
      item.progress = 1;
      item.note = folder;
    } catch (error) {
      item.status = 'failed';
      item.note = cleanError(error) || 'Failed';
    }
    renderBatch();
  }
  state.batchRunning = false;
  renderBatch();
  void refreshLibrary();
  toast('Batch finished.');
}

/* ------------------------------------------------------------------ *
 * Library
 * ------------------------------------------------------------------ */

async function refreshLibrary() {
  if (!bridge?.libraryList) return;
  try {
    state.library = await bridge.libraryList();
    renderLibrary();
  } catch { /* whatever was already shown stays shown */ }
}

async function openFromLibrary(entry) {
  if (state.working) { toast('Wait for the current song to finish first.'); return; }
  closeSong(false);
  state.view = 'song';
  try {
    const cached = await bridge.stemCached(entry.id);
    if (!cached.complete && !cached.quick) throw new Error("That song's stems are no longer on disk. Open the file again to separate it.");
    const mode = cached.complete ? 'full' : 'quick';
    let split = cached.vocalsSplit;
    state.song = {
      name: entry.name, path: '', duration: entry.duration, coverUrl: '', peaks: new Float32Array(SONG_BUCKETS),
      songId: entry.id, split, mode, buffer: null,
    };
    renderSong();
    setWorking({ label: 'Opening the stems…', sub: '', progress: 0.5, cancellable: false });
    // A song separated before the vocal split existed can have it now.
    if (!split && settings.splitVocals && bridge.stemSplitVocals) {
      try {
        progressSink = ({ fraction, label, sub }) => setWorking({ label, sub, progress: fraction, cancellable: true });
        await ensureModels({ karaoke: true });
        await bridge.stemSplitVocals(entry.id);
        split = true;
        state.song.split = true;
        void bridge.librarySave?.({ ...entry, split: true });
      } catch (error) {
        toast(`The vocals couldn't be split (${cleanError(error)}). Showing them as one stem.`, true);
      } finally {
        progressSink = null;
      }
    }
    await loadStems(entry.id, split, mode);
    setWorking(null);
  } catch (error) {
    setWorking(null);
    closeSong(false);
    el('intro-error').textContent = cleanError(error);
    el('intro-error').hidden = false;
  }
}

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderError() {
  const node = el('song-error');
  node.textContent = state.error;
  node.hidden = !state.error || !state.song;
}

function renderWork() {
  const working = state.working;
  el('work-card').hidden = !working || !state.song;
  if (!working) return;
  el('work-label').textContent = working.label;
  const left = timeLeft(working);
  el('work-sub').textContent = [working.sub, left].filter(Boolean).join(' · ');
  el('work-pct').textContent = `${Math.round(working.progress * 100)}%`;
  el('work-bar').style.width = `${Math.round(working.progress * 100)}%`;
  el('cancel').hidden = !working.cancellable;
}

/** Home: the drop card and library, with the open song a click away. */
function goHome() {
  if (!state.song) return;
  state.view = 'home';
  renderSong();
  renderStemsVisibility();
  void refreshLibrary();
  el('page-split').parentElement.scrollTo({ top: 0 });
}

function backToSong() {
  state.view = 'song';
  renderSong();
  renderStemsVisibility();
}

function renderStemsVisibility() {
  const show = state.stems.length > 0 && state.view === 'song';
  el('stems-section').hidden = !show;
  el('export-panel').hidden = !show;
}

function renderSong() {
  const song = state.song;
  const showSong = Boolean(song) && state.view === 'song';
  el('drop-card').hidden = showSong;
  el('song-card').hidden = !showSong;
  el('now-open').hidden = !(song && state.view === 'home');
  el('now-open-name').textContent = song?.name || '';
  el('intro-error').hidden = true;
  renderError();
  renderWork();
  miniBar();
  if (!song) return;
  el('song-name').textContent = song.name;
  el('song-name').title = song.name;
  const cover = el('cover');
  cover.innerHTML = song.coverUrl ? `<img src="${song.coverUrl}" alt="">` : icon('music', 44);
  drawSongWave();
}

function drawSongWave() {
  const canvas = el('song-wave');
  if (!state.song || !canvas.clientWidth) return;
  drawWave(canvas, state.song.peaks, 'rgba(148,163,184,.75)', { gap: 1 });
}

/**
 * The stem rows are built once, when a song's stems arrive, and then
 * updated in place: a switch flipping is a class change on one row, not a
 * rebuild of seven rows and their waveforms.
 */
function renderStems() {
  if (state.stems.length) buildStems(); else clearStems();
}

function clearStems() {
  renderStemsVisibility();
  el('stems').innerHTML = '';
}

function buildStems() {
  if (!state.stems.length) { clearStems(); return; }
  renderStemsVisibility();

  const holder = el('stems');
  holder.innerHTML = state.stems.map(stem => {
    const soloed = state.stems.every(item => item.on === (item.key === stem.key));
    return `
      <div class="stem-row ${stem.on ? '' : 'off'}" data-stem="${stem.key}" style="--c:${stem.color}">
        <div class="stem-icon" data-icon="${stem.icon}"></div>
        <button class="stem-chevron" data-action="more" aria-label="More for ${stem.label}" data-icon="chevron-right"></button>
        <button class="switch ${stem.on ? 'on' : ''}" data-action="toggle" role="switch" aria-checked="${stem.on}" aria-label="${stem.label} in the mix"></button>
        <span class="stem-name">${stem.label}</span>
        <div class="stem-wave"><canvas></canvas></div>
        <span class="stem-divider"></span>
        <input class="gain" type="range" min="-24" max="12" step="0.5" value="${stem.gain}" aria-label="${stem.label} level" style="--fill:${((stem.gain + 24) / 36 * 100).toFixed(1)}%">
        <span class="gain-label">${stem.gain > 0 ? '+' : ''}${stem.gain.toFixed(1)} dB</span>
        <button class="solo ${soloed ? 'active' : ''}" data-action="solo" aria-pressed="${soloed}">Solo</button>
        <button class="sq ${state.audition === stem.key ? 'active' : ''}" data-action="audition" aria-label="Listen to ${stem.label} alone" title="Listen alone" data-icon="headphones"></button>
        <button class="sq" data-action="menu" aria-label="More options for ${stem.label}" data-icon="ellipsis"></button>
        <div class="stem-extra" hidden>
          <button class="ghost small" data-action="download"><span data-icon="download"></span>Save this stem</button>
          <button class="ghost small" data-action="export-only"><span data-icon="upload"></span>Export only this</button>
          <button class="ghost small" data-action="export-without"><span data-icon="scissors"></span>Export everything but this</button>
        </div>
      </div>`;
  }).join('');
  hydrateIcons(holder);
  drawStemWaves();

  holder.querySelectorAll('.stem-row').forEach(row => {
    const key = row.dataset.stem;
    row.querySelector('[data-action="toggle"]').addEventListener('click', () => toggleStem(key));
    row.querySelector('[data-action="solo"]').addEventListener('click', () => soloStem(key));
    row.querySelector('[data-action="audition"]').addEventListener('click', () => auditionStem(key));
    row.querySelector('[data-action="more"]').addEventListener('click', () => {
      const extra = row.querySelector('.stem-extra');
      extra.hidden = !extra.hidden;
      row.classList.toggle('open', !extra.hidden);
    });
    row.querySelector('[data-action="menu"]').addEventListener('click', event => openMenu(event.currentTarget, key));
    row.querySelector('[data-action="download"]').addEventListener('click', () => void downloadStem(key));
    row.querySelector('[data-action="export-only"]').addEventListener('click', () => void exportNow('stems', key));
    row.querySelector('[data-action="export-without"]').addEventListener('click', () => void exportNow('mix', key));
    const gain = row.querySelector('.gain');
    gain.addEventListener('input', () => {
      gain.style.setProperty('--fill', `${((Number(gain.value) + 24) / 36 * 100).toFixed(1)}%`);
      setGain(key, Number(gain.value), false);
    });
    gain.addEventListener('change', () => setGain(key, Number(gain.value), true));
  });

  renderExport();
}

function drawStemWaves() {
  el('stems').querySelectorAll('.stem-row').forEach(row => {
    const stem = state.stems.find(item => item.key === row.dataset.stem);
    if (stem) drawWave(row.querySelector('canvas'), stem.peaks, getComputedStyle(row).getPropertyValue('--c').trim() || '#fff');
  });
}

/** Switches, solo and audition states, levels: the rows brought up to date. */
function updateStems() {
  el('stems').querySelectorAll('.stem-row').forEach(row => {
    const stem = state.stems.find(item => item.key === row.dataset.stem);
    if (!stem) return;
    const soloed = state.stems.every(item => item.on === (item.key === stem.key));
    row.classList.toggle('off', !stem.on);
    const toggle = row.querySelector('[data-action="toggle"]');
    toggle.classList.toggle('on', stem.on);
    toggle.setAttribute('aria-checked', String(stem.on));
    const solo = row.querySelector('[data-action="solo"]');
    solo.classList.toggle('active', soloed);
    solo.setAttribute('aria-pressed', String(soloed));
    row.querySelector('[data-action="audition"]').classList.toggle('active', state.audition === stem.key);
    const gain = row.querySelector('.gain');
    if (Number(gain.value) !== stem.gain) {
      gain.value = String(stem.gain);
      gain.style.setProperty('--fill', `${((stem.gain + 24) / 36 * 100).toFixed(1)}%`);
    }
    row.querySelector('.gain-label').textContent = `${stem.gain > 0 ? '+' : ''}${stem.gain.toFixed(1)} dB`;
  });
  renderExport();
}

function openMenu(anchor, key) {
  const menu = el('menu');
  const stem = state.stems.find(item => item.key === key);
  menu.innerHTML = `
    <button data-do="download">${icon('download', 16)}Save this stem…</button>
    <button data-do="only">${icon('upload', 16)}Export only ${stem.label}</button>
    <button data-do="without">${icon('scissors', 16)}Export everything but ${stem.label}</button>
    <button data-do="reset">${icon('refresh-cw', 16)}Reset level to 0 dB</button>`;
  const rect = anchor.getBoundingClientRect();
  menu.hidden = false;
  menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, rect.bottom + 6)}px`;
  menu.style.left = `${Math.max(8, rect.right - menu.offsetWidth)}px`;
  menu.querySelector('[data-do="download"]').onclick = () => { closeMenu(); void downloadStem(key); };
  menu.querySelector('[data-do="only"]').onclick = () => { closeMenu(); void exportNow('stems', key); };
  menu.querySelector('[data-do="without"]').onclick = () => { closeMenu(); void exportNow('mix', key); };
  menu.querySelector('[data-do="reset"]').onclick = () => { closeMenu(); setGain(key, 0, true); updateStems(); };
  window.setTimeout(() => document.addEventListener('click', closeMenu, { once: true }), 0);
}
function closeMenu() { el('menu').hidden = true; }

function renderExport() {
  dropdowns['export-rate']?.set(settings.sampleRate);
  dropdowns['export-bits']?.set(settings.bitDepth);
  el('export-folder-label').textContent = settings.outputFolder || state.contentFolder || 'Documents / Amanorsac Studio / Easy Stems';
  el('export-mode').querySelectorAll('button').forEach(button => button.classList.toggle('active', button.dataset.mode === settings.exportMode));
  const on = state.stems.filter(stem => stem.on).length;
  el('export-now-label').textContent = settings.exportMode === 'stems'
    ? `Export ${on} Stem${on === 1 ? '' : 's'}`
    : `Export: ${mixLabel(state.stems)}`;
  el('export-now').disabled = on === 0;
  const what = settings.exportMode === 'stems' ? `${on} file${on === 1 ? '' : 's'}` : 'one file';
  el('export-summary').textContent = state.stems.length
    ? `${what} · WAV ${settings.sampleRate === 48000 ? '48' : '44.1'} kHz, ${settings.bitDepth}-bit · ${settings.outputFolder || state.contentFolder || 'Documents / Amanorsac Studio / Easy Stems'}`
    : '';
  el('batch-folder-label').textContent = settings.outputFolder || state.contentFolder || 'Documents / Amanorsac Studio / Easy Stems';
}

function renderLibrary() {
  const entries = state.library;
  el('library').hidden = !entries.length;
  el('library-list').innerHTML = entries.map(entry => `
    <div class="library-item" data-id="${entry.id}">
      <span class="tile">${icon('music', 20)}</span>
      <button class="open"><b>${entry.name}</b><small>${formatTime(entry.duration)}</small></button>
      <span class="tag quick" ${entry.mode === 'quick' ? '' : 'hidden'}>Quick</span>
      <span class="tag" ${entry.split ? '' : 'hidden'}>Lead + backing</span>
      <button class="forget" aria-label="Forget ${entry.name}" title="Forget">${icon('x', 16)}</button>
    </div>`).join('');
  el('library-list').querySelectorAll('.library-item').forEach(row => {
    const entry = entries.find(item => item.id === row.dataset.id);
    row.querySelector('.open').addEventListener('click', () => void openFromLibrary(entry));
    row.querySelector('.forget').addEventListener('click', async () => {
      state.library = await bridge.libraryDelete(entry.id);
      renderLibrary();
    });
  });
}

function renderBatch() {
  const list = el('batch-list');
  el('batch-empty').hidden = state.batch.length > 0;
  el('batch-start').disabled = state.batchRunning || !state.batch.some(item => item.status === 'queued');
  el('batch-start').innerHTML = state.batchRunning ? `${icon('refresh-cw', 16)}Running…` : `${icon('play', 16)}Start batch`;
  list.innerHTML = state.batch.map(item => `
    <div class="batch-item ${item.status}" data-id="${item.id}">
      <span class="tile">${icon('file-audio', 20)}</span>
      <div><b>${item.name}</b><small>${item.note || (item.status === 'queued' ? 'Waiting' : '')}</small></div>
      <div class="bar" ${item.status === 'working' ? '' : 'hidden'}><i style="width:${Math.round(item.progress * 100)}%"></i></div>
      <span class="state">${{ queued: 'Queued', working: `${Math.round(item.progress * 100)}%`, done: 'Done', failed: 'Failed' }[item.status]}</span>
      <button class="remove" aria-label="Remove" ${item.status === 'working' ? 'disabled' : ''}>${icon('x', 16)}</button>
    </div>`).join('');
  list.querySelectorAll('.batch-item').forEach(row => {
    row.querySelector('.remove').addEventListener('click', () => {
      state.batch = state.batch.filter(item => item.id !== row.dataset.id);
      renderBatch();
    });
  });
}

async function renderSettings() {
  el('settings-folder-label').textContent = settings.outputFolder || state.contentFolder || 'Documents / Amanorsac Studio / Easy Stems';
  dropdowns['settings-rate']?.set(settings.sampleRate);
  dropdowns['settings-bits']?.set(settings.bitDepth);
  el('settings-split').classList.toggle('on', settings.splitVocals);
  dropdowns['settings-mode']?.set(settings.mode);
  el('settings-gpu').classList.toggle('on', settings.gpu);
  el('settings-gpu').setAttribute('aria-checked', String(settings.gpu));
  el('settings-split').setAttribute('aria-checked', String(settings.splitVocals));
  if (!bridge?.stemStatus) return;
  try {
    const status = await bridge.stemStatus();
    state.models = status;
    const show = (id, ready) => {
      const node = el(id);
      node.textContent = ready ? 'Ready' : 'Not downloaded';
      node.classList.toggle('ok', ready);
    };
    el('setting-gpu').hidden = !status.gpuAvailable;
    show('model-demucs-status', status.modelReady);
    show('model-kara-status', status.karaokeReady);
    show('model-quick-status', status.quickReady);
    el('model-demucs-get').hidden = status.modelReady;
    el('model-kara-get').hidden = status.karaokeReady;
    el('model-quick-get').hidden = status.quickReady;
    const size = await bridge.stemCacheSize();
    el('cache-size').textContent = size > 0
      ? `${(size / 1024 / 1024).toFixed(0)} MB of separated songs, kept so they open instantly.`
      : 'Nothing kept yet. Every song you split is kept so it opens instantly.';
  } catch { /* the page still works without the numbers */ }
}

/* ------------------------------------------------------------------ *
 * Transport
 * ------------------------------------------------------------------ */

/**
 * The play buttons' icons are only touched when the state actually changes.
 * Rebuilding them on every tick swapped the element under the pointer
 * between press and release, and a click whose press and release land on
 * different elements is no click at all — the button felt like it was
 * ignoring every other press.
 */
let shownPlaying = null;
function renderPlayButtons() {
  if (shownPlaying === player.playing) return;
  shownPlaying = player.playing;
  const label = player.playing ? 'Pause' : 'Play';
  const playBtn = el('play-pause');
  playBtn.innerHTML = icon(player.playing ? 'pause' : 'play', 26);
  playBtn.setAttribute('aria-label', label);
  el('mini-play').innerHTML = icon(player.playing ? 'pause' : 'play', 20);
  el('mini-play').setAttribute('aria-label', label);
}

/** Everything that changes on a state change: buttons, length, name. */
function renderTransport() {
  renderPlayButtons();
  el('seek').max = String(player.duration || 1);
  el('mini-seek').max = String(player.duration || 1);
  el('mini-name').textContent = state.song?.name || '';
  renderPlayhead();
}

/** Only what moves while the song plays. */
let shownSecond = -1;
function renderPlayhead() {
  const position = Math.min(player.position, player.duration);
  const fraction = player.duration ? position / player.duration : 0;
  const seek = el('seek');
  if (document.activeElement !== seek) seek.value = String(position);
  seek.style.setProperty('--fill', `${fraction * 100}%`);
  el('playhead').style.left = `${fraction * 100}%`;
  const miniSeek = el('mini-seek');
  if (document.activeElement !== miniSeek) miniSeek.value = String(position);
  miniSeek.style.setProperty('--fill', `${fraction * 100}%`);
  // The clock text only changes once a second; the DOM is left alone between.
  const second = Math.floor(position) * 100000 + Math.floor(player.duration);
  if (second !== shownSecond) {
    shownSecond = second;
    const text = `${formatTime(position)} / ${formatTime(player.duration)}`;
    el('time').textContent = text;
    el('song-time-top').textContent = text;
    el('mini-time').textContent = text;
  }
}
player.subscribe(renderTransport);
// The playhead moves on the display's own clock while the song plays, and
// not at all while it doesn't.
(function tick() {
  if (state.song && player.playing) renderPlayhead();
  requestAnimationFrame(tick);
})();

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */

hydrateIcons();

document.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', () => {
  // "Split Song" while already looking at a song takes you back to the start.
  if (button.dataset.page === 'split' && state.page === 'split' && state.song && state.view === 'song') { goHome(); return; }
  showPage(button.dataset.page);
}));
el('go-home').addEventListener('click', goHome);
el('back-to-song').addEventListener('click', backToSong);
el('now-open').querySelector('.tile').addEventListener('click', backToSong);
el('head-settings').addEventListener('click', () => showPage('settings'));

const fileInput = el('file-input');
const onFiles = files => {
  const list = [...files];
  const file = list.find(item => item.type.startsWith('audio/') || item.type.startsWith('video/')) || list[0];
  if (file) void openFile(file);
};
el('choose-file').addEventListener('click', () => fileInput.click());
el('open-song').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => { onFiles(fileInput.files); fileInput.value = ''; });

const dropZone = el('drop-zone');
dropZone.addEventListener('dragover', event => { event.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
dropZone.addEventListener('drop', event => { event.preventDefault(); dropZone.classList.remove('drag-over'); onFiles(event.dataTransfer.files); });
// Dropping anywhere on the song page while a song is open replaces it.
el('page-split').addEventListener('dragover', event => event.preventDefault());
el('page-split').addEventListener('drop', event => { event.preventDefault(); if (state.song) onFiles(event.dataTransfer.files); });

el('play-pause').addEventListener('click', () => (player.playing ? player.pause() : player.play()));
el('stop').addEventListener('click', () => player.stop());
el('skip-back').addEventListener('click', () => player.seek(player.position - 10));
el('skip-fwd').addEventListener('click', () => player.seek(player.position + 10));
el('seek').addEventListener('input', () => player.seek(Number(el('seek').value)));
el('mini-play').addEventListener('click', () => (player.playing ? player.pause() : player.play()));
el('mini-back').addEventListener('click', () => player.seek(player.position - 10));
el('mini-fwd').addEventListener('click', () => player.seek(player.position + 10));
el('mini-seek').addEventListener('input', () => player.seek(Number(el('mini-seek').value)));
// The bar appears only once the song card itself has scrolled out of view.
let songCardVisible = true;
function miniBar() { el('mini-transport').hidden = songCardVisible || !state.song || state.view !== 'song'; }
new IntersectionObserver(entries => { songCardVisible = entries[0].isIntersecting; miniBar(); }, { root: el('page-split').parentElement, threshold: 0 })
  .observe(el('song-card'));
player.subscribe(miniBar);
el('song-wave-wrap').addEventListener('click', event => {
  const rect = event.currentTarget.getBoundingClientRect();
  player.seek((event.clientX - rect.left) / rect.width * player.duration);
});
const volume = el('volume');
const applyVolume = () => {
  player.setVolume(Number(volume.value));
  volume.style.setProperty('--fill', `${Number(volume.value) * 100}%`);
  el('vol-label').textContent = `${Math.round(Number(volume.value) * 100)}%`;
};
volume.addEventListener('input', applyVolume);
applyVolume();
el('cancel').addEventListener('click', () => bridge?.stemCancel?.());
window.addEventListener('resize', () => { drawSongWave(); drawStemWaves(); });

document.addEventListener('keydown', event => {
  const typing = ['INPUT', 'SELECT', 'TEXTAREA'].includes(event.target.tagName);
  if (event.code === 'Space' && !typing && state.song) {
    event.preventDefault();
    if (player.playing) player.pause(); else player.play();
  }
});

el('select-all').addEventListener('click', () => {
  state.stems.forEach(stem => { stem.on = true; });
  state.audition = null;
  updateStems();
  remix();
});

el('export-mode').querySelectorAll('button').forEach(button => button.addEventListener('click', () => {
  settings.exportMode = button.dataset.mode;
  saveSettings();
  renderExport();
}));
initDropdown('export-format');
initDropdown('export-rate', value => { settings.sampleRate = Number(value); saveSettings(); });
initDropdown('export-bits', value => { settings.bitDepth = Number(value); saveSettings(); });
el('export-folder').addEventListener('click', async () => {
  const chosen = await bridge?.pickFolder?.('Where should exports go?');
  if (chosen) { settings.outputFolder = chosen; saveSettings(); renderExport(); }
});
el('export-now').addEventListener('click', () => void exportNow());

// Batch.
const batchInput = el('batch-input');
el('batch-add').addEventListener('click', () => batchInput.click());
batchInput.addEventListener('change', () => { addBatchFiles(batchInput.files); batchInput.value = ''; });
el('batch-start').addEventListener('click', () => void runBatch());
el('batch-clear').addEventListener('click', () => { state.batch = state.batch.filter(item => item.status === 'queued' || item.status === 'working'); renderBatch(); });
const batchDrop = el('batch-drop');
batchDrop.addEventListener('dragover', event => { event.preventDefault(); batchDrop.classList.add('drag-over'); });
batchDrop.addEventListener('dragleave', () => batchDrop.classList.remove('drag-over'));
batchDrop.addEventListener('drop', event => { event.preventDefault(); batchDrop.classList.remove('drag-over'); addBatchFiles(event.dataTransfer.files); });

// Settings.
el('settings-folder').addEventListener('click', async () => {
  const chosen = await bridge?.pickFolder?.('Where should exports go?');
  if (chosen) { settings.outputFolder = chosen; saveSettings(); void renderSettings(); renderExport(); }
});
el('settings-folder-reset').addEventListener('click', () => { settings.outputFolder = ''; saveSettings(); void renderSettings(); renderExport(); });
initDropdown('settings-rate', value => { settings.sampleRate = Number(value); saveSettings(); renderExport(); });
initDropdown('settings-bits', value => { settings.bitDepth = Number(value); saveSettings(); renderExport(); });
el('settings-split').addEventListener('click', () => { settings.splitVocals = !settings.splitVocals; saveSettings(); void renderSettings(); });
initDropdown('settings-mode', value => { settings.mode = value; saveSettings(); renderModePicker(); });

/** Quick or Full, chosen right where the song is dropped. */
function renderModePicker() {
  document.querySelectorAll('#mode-picker button').forEach(button => {
    const chosen = button.dataset.mode === settings.mode;
    button.classList.toggle('active', chosen);
    button.setAttribute('aria-checked', String(chosen));
  });
}
document.querySelectorAll('#mode-picker button').forEach(button => button.addEventListener('click', () => {
  settings.mode = button.dataset.mode;
  saveSettings();
  renderModePicker();
  dropdowns['settings-mode']?.set(settings.mode);
}));
renderModePicker();
el('settings-gpu').addEventListener('click', async () => {
  settings.gpu = !settings.gpu;
  saveSettings();
  await bridge?.stemConfigure?.({ provider: settings.gpu ? 'dml' : 'cpu' });
  void renderSettings();
  if (state.working) toast('Takes effect on the next song.');
});
void bridge?.stemConfigure?.({ provider: settings.gpu ? 'dml' : 'cpu' });
const downloadModel = async (which) => {
  if (!bridge) return;
  el('model-bar-wrap').hidden = false;
  progressSink = ({ fraction }) => { el('model-bar').style.width = `${Math.round(fraction * 100)}%`; };
  try {
    await ({ demucs: bridge.stemDownload, karaoke: bridge.stemDownloadKaraoke, quick: bridge.stemDownloadQuick }[which])();
    toast('Model downloaded.');
  } catch (error) {
    toast(cleanError(error) || 'The download failed.', true);
  } finally {
    progressSink = null;
    el('model-bar-wrap').hidden = true;
    void renderSettings();
  }
};
el('model-demucs-get').addEventListener('click', () => void downloadModel('demucs'));
el('model-kara-get').addEventListener('click', () => void downloadModel('karaoke'));
el('model-quick-get').addEventListener('click', () => void downloadModel('quick'));
el('cache-clear').addEventListener('click', async () => {
  if (!bridge?.stemClearCache) return;
  try {
    await bridge.stemClearCache();
    state.library = [];
    renderLibrary();
    void renderSettings();
    toast('Separated songs cleared.');
  } catch (error) {
    toast(cleanError(error), true);
  }
});

// Window chrome, only under Electron.
if (bridge?.isDesktop) {
  // Each platform's own caption buttons, where that platform puts them.
  const mac = bridge.platform === 'darwin';
  el('window-controls').hidden = !mac;
  el('window-controls-win').hidden = mac;
  const wire = (id, action) => el(id).addEventListener('click', () => bridge[action]());
  wire('win-min', 'minimize'); wire('win-max', 'maximize'); wire('win-close', 'close');
  wire('winx-min', 'minimize'); wire('winx-max', 'maximize'); wire('winx-close', 'close');
}

// The About screen's facts, and where exports go, from the main process.
void (async () => {
  if (!bridge?.appInfo) return;
  try {
    const info = await bridge.appInfo();
    state.contentFolder = info.contentFolder;
    el('about-version').textContent = `Version ${info.version} · ${info.platform === 'win32' ? 'Windows' : info.platform === 'darwin' ? 'macOS' : 'Linux'}`;
    el('about-content').textContent = info.contentFolder;
    renderExport();
  } catch { /* the defaults stand */ }
})();
document.querySelectorAll('[data-external]').forEach(link => link.addEventListener('click', event => {
  event.preventDefault();
  void bridge?.openExternal?.(link.dataset.external);
}));

renderExport();
renderBatch();
void refreshLibrary();
