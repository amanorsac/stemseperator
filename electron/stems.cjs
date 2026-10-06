/**
 * Stem separation: splitting a finished song back into its instruments.
 *
 * The work is done by HT-Demucs, Meta's separation network, in the six-stem
 * form that pulls piano and guitar out as well as drums, bass, vocals and
 * everything else. It runs here, on this computer, through ONNX Runtime, and
 * nothing leaves the machine. Both the network and this export of it are MIT licensed.
 *
 * The network itself only ever sees 7.8 seconds of audio. A whole song is fed
 * through as overlapping pieces, and where two pieces overlap they are
 * cross-faded, because each piece is least reliable at its edges and a hard
 * join between two would click.
 *
 * Separation is slow — minutes, not seconds — so the result is kept. Stems are
 * written to disk under a fingerprint of the audio they came from, and a song
 * that has been separated once opens instantly ever after.
 */

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

/** The order the network returns its stems in. Fixed by the model. */
const STEMS = ['drums', 'bass', 'other', 'vocals', 'guitar', 'piano'];

const SAMPLE_RATE = 44100;
/** Samples in one piece: 7.8 seconds, the length the network was exported at. */
const SEGMENT = 343980;
// An eighth of a piece, half what Demucs itself defaults to: the joins are
// still cross-faded over a second of audio, and a song needs a seventh
// fewer pieces run through the network.
const OVERLAP = Math.floor(SEGMENT / 8);
const STRIDE = SEGMENT - OVERLAP;

const MODEL_FILE = 'htdemucs_6s_fp16weights.onnx';
const MODEL_URL = `https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/${MODEL_FILE}`;
/** Roughly what the download weighs, for telling the user before it starts. */
const MODEL_BYTES = 136 * 1024 * 1024;

/**
 * The second network: a "karaoke" model from Ultimate Vocal Remover, which
 * takes a lead vocal out of whatever it is given. Run on the vocals stem
 * alone, what it keeps is the backing vocals and what it removes is the lead.
 * MIT licensed, like the rest.
 */
const KARAOKE_FILE = 'UVR_MDXNET_KARA_2.onnx';
const KARAOKE_URL = `https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/${KARAOKE_FILE}`;
const KARAOKE_BYTES = 53 * 1024 * 1024;
/** How UVR runs this particular model; the numbers come from its own model registry. */
const KARAOKE_SPEC = { nFft: 5120, dimF: 2048, dimT: 8, compensate: 1.065 };

/**
 * The quick network: an MDX-Net instrumental model from Ultimate Vocal
 * Remover. It only knows two things, the vocals and everything else, but it
 * is a far smaller network than Demucs and gets through a song several
 * times faster. Same shape as the karaoke model, so the same code runs it.
 */
const QUICK_FILE = 'UVR-MDX-NET-Inst_Main.onnx';
const QUICK_URL = `https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/${QUICK_FILE}`;
const QUICK_BYTES = 53 * 1024 * 1024;
const QUICK_SPEC = { nFft: 5120, dimF: 2048, dimT: 8, compensate: 1.025 };
/** What a quick separation produces. */
const QUICK_STEMS = ['vocals', 'instrumental'];

/**
 * The HD network: BS-RoFormer SW, the band-split transformer at the top of
 * the open leaderboards, in its six-stem form. The same six instruments as
 * Demucs, markedly cleaner, at several times the cost. ONNX export of
 * jarredou/BS-ROFO-SW-Fixed; MIT like the rest.
 */
const HD_FILE = 'bs_roformer_sw_6stem_fp16.onnx';
const HD_URL = `https://huggingface.co/elicwhite/bs-roformer-sw-6stem-onnx/resolve/main/${HD_FILE}`;
const HD_BYTES = 353 * 1024 * 1024;
/** The order the RoFormer returns its stems in, to the names used here. */
const HD_ORDER = ['bass', 'drums', 'other', 'vocals', 'guitar', 'piano'];

/**
 * The HD vocal networks: Mel-Band RoFormer, exported to ONNX by this
 * project's tools/export_melband.py and published with the app's releases.
 * One finds the vocals (Kimberley Jensen's, MIT); the other is a karaoke
 * model (aufr33 & viperx, MIT) that keeps the backing vocals, like the MDX
 * karaoke model but far cleaner. Both take 4 s pieces at hop 441.
 */
const MODELS_RELEASE = 'https://github.com/amanorsac/stemseperator/releases/download/models-v1';
const HD_VOCALS_FILE = 'melband_vocals_kj.onnx';
const HD_VOCALS_URL = `${MODELS_RELEASE}/${HD_VOCALS_FILE}`;
const HD_VOCALS_BYTES = 900 * 1024 * 1024;
const HD_KARAOKE_FILE = 'melband_karaoke_aufr33_viperx.onnx';
const HD_KARAOKE_URL = `${MODELS_RELEASE}/${HD_KARAOKE_FILE}`;
const HD_KARAOKE_BYTES = 900 * 1024 * 1024;
const MELBAND_SPEC = { hop: 441, chunk: 176400, stems: 1 };

/** The two halves of the vocals stem, once split. */
const VOCAL_PARTS = ['lead_vocals', 'backing_vocals'];
const ALL_STEMS = [...STEMS, 'instrumental', ...VOCAL_PARTS];
/** Where a song's stems live: beside each other for Fast and Quick, under hd/ for HD. */
const TIERS = ['standard', 'hd'];

/**
 * The cross-fade applied to each piece: up over the first quarter, flat, down
 * over the last. Overlapping pieces then sum to a constant.
 */
function makeWindow() {
  const window = new Float32Array(SEGMENT).fill(1);
  for (let i = 0; i < OVERLAP; i += 1) {
    const fade = i / (OVERLAP - 1);
    window[i] = fade;
    window[SEGMENT - 1 - i] = fade;
  }
  return window;
}

/** How many pieces a recording of a given length is cut into. */
const chunkCount = total => Math.max(1, Math.ceil(total / STRIDE));

/** A 16-bit stereo WAV. Small enough to keep six of per song. */
function encodeWav(left, right) {
  const frames = left.length;
  const buffer = Buffer.alloc(44 + frames * 4);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + frames * 4, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(2, 22);
  buffer.writeUInt32LE(SAMPLE_RATE, 24);
  buffer.writeUInt32LE(SAMPLE_RATE * 4, 28);
  buffer.writeUInt16LE(4, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(frames * 4, 40);
  const clamp = value => Math.max(-32768, Math.min(32767, Math.round(value * 32767)));
  for (let i = 0; i < frames; i += 1) {
    buffer.writeInt16LE(clamp(left[i]), 44 + i * 4);
    buffer.writeInt16LE(clamp(right[i]), 46 + i * 4);
  }
  return buffer;
}

/** The reverse: one of our own WAVs back to floating-point channels. */
function decodeWav(buffer) {
  const frames = Math.floor((buffer.length - 44) / 4);
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) {
    left[i] = buffer.readInt16LE(44 + i * 4) / 32768;
    right[i] = buffer.readInt16LE(46 + i * 4) / 32768;
  }
  return { left, right };
}

/**
 * A fingerprint of a recording, for finding its stems again.
 *
 * Taken from the audio rather than the file name, so a renamed or moved file is
 * still recognised and two different songs called "track 1" are not confused.
 * A spread of samples is enough; hashing forty million floats would take longer
 * than it saves.
 */
function fingerprint(left, right) {
  const hash = crypto.createHash('sha1');
  hash.update(String(left.length));
  const step = Math.max(1, Math.floor(left.length / 20000));
  const picked = new Float32Array(Math.ceil(left.length / step) * 2);
  for (let i = 0, k = 0; i < left.length; i += step) {
    picked[k++] = left[i];
    picked[k++] = right[i];
  }
  hash.update(Buffer.from(picked.buffer));
  return hash.digest('hex').slice(0, 20);
}

class StemSeparator {
  constructor(dataFolder) {
    this.modelFolder = path.join(dataFolder, 'models');
    this.stemFolder = path.join(dataFolder, 'stems');
    this.session = null;
    this.provider = '';
    this.busy = false;
    this.cancelled = false;
  }

  get modelPath() {
    return path.join(this.modelFolder, MODEL_FILE);
  }

  get karaokePath() {
    return path.join(this.modelFolder, KARAOKE_FILE);
  }

  get quickPath() {
    return path.join(this.modelFolder, QUICK_FILE);
  }

  get hdPath() {
    return path.join(this.modelFolder, HD_FILE);
  }

  hdReady() {
    try { return fs.statSync(this.hdPath).size > 300 * 1024 * 1024; } catch { return false; }
  }

  get hdVocalsPath() { return path.join(this.modelFolder, HD_VOCALS_FILE); }
  get hdKaraokePath() { return path.join(this.modelFolder, HD_KARAOKE_FILE); }
  hdVocalsReady() { try { return fs.statSync(this.hdVocalsPath).size > 100 * 1024 * 1024; } catch { return false; } }
  hdKaraokeReady() { try { return fs.statSync(this.hdKaraokePath).size > 100 * 1024 * 1024; } catch { return false; } }

  quickReady() {
    try { return fs.statSync(this.quickPath).size > 40 * 1024 * 1024; } catch { return false; }
  }

  modelReady() {
    try { return fs.statSync(this.modelPath).size > 100 * 1024 * 1024; } catch { return false; }
  }

  karaokeReady() {
    try { return fs.statSync(this.karaokePath).size > 40 * 1024 * 1024; } catch { return false; }
  }

  status() {
    return {
      provider: this.provider || this.wantedProvider || 'cpu',
      gpuAvailable: process.platform === 'win32',
      modelReady: this.modelReady(),
      modelBytes: MODEL_BYTES,
      karaokeReady: this.karaokeReady(),
      karaokeBytes: KARAOKE_BYTES,
      quickReady: this.quickReady(),
      quickBytes: QUICK_BYTES,
      hdReady: this.hdReady(),
      hdBytes: HD_BYTES,
      hdVocalsReady: this.hdVocalsReady(),
      hdVocalsBytes: HD_VOCALS_BYTES,
      hdKaraokeReady: this.hdKaraokeReady(),
      hdKaraokeBytes: HD_KARAOKE_BYTES,
      busy: this.busy,
      stems: STEMS,
      quickStems: QUICK_STEMS,
      vocalParts: VOCAL_PARTS,
    };
  }

  /**
   * Fetch a network, once.
   *
   * They are far too large to put in the installer, so each is downloaded the
   * first time it is needed. Written to a temporary name and renamed at the
   * end, so a download that is cut off never leaves behind a file that looks
   * complete.
   */
  downloadModel(onProgress) {
    if (this.modelReady()) return Promise.resolve(this.modelPath);
    return this.fetchModel(MODEL_URL, this.modelPath, MODEL_BYTES, onProgress);
  }

  downloadKaraoke(onProgress) {
    if (this.karaokeReady()) return Promise.resolve(this.karaokePath);
    return this.fetchModel(KARAOKE_URL, this.karaokePath, KARAOKE_BYTES, onProgress);
  }

  downloadQuick(onProgress) {
    if (this.quickReady()) return Promise.resolve(this.quickPath);
    return this.fetchModel(QUICK_URL, this.quickPath, QUICK_BYTES, onProgress);
  }

  downloadHd(onProgress) {
    if (this.hdReady()) return Promise.resolve(this.hdPath);
    return this.fetchModel(HD_URL, this.hdPath, HD_BYTES, onProgress);
  }

  downloadHdVocals(onProgress) {
    if (this.hdVocalsReady()) return Promise.resolve(this.hdVocalsPath);
    return this.fetchModel(HD_VOCALS_URL, this.hdVocalsPath, HD_VOCALS_BYTES, onProgress);
  }

  downloadHdKaraoke(onProgress) {
    if (this.hdKaraokeReady()) return Promise.resolve(this.hdKaraokePath);
    return this.fetchModel(HD_KARAOKE_URL, this.hdKaraokePath, HD_KARAOKE_BYTES, onProgress);
  }

  fetchModel(startUrl, target, expectedBytes, onProgress) {
    fs.mkdirSync(this.modelFolder, { recursive: true });
    const partial = `${target}.part`;

    const fetchTo = (url, redirects) => new Promise((resolve, reject) => {
      if (redirects > 6) { reject(new Error('Too many redirects while downloading the model.')); return; }
      https.get(url, response => {
        const { statusCode, headers } = response;
        if (statusCode >= 300 && statusCode < 400 && headers.location) {
          response.resume();
          const next = new URL(headers.location, url).href;
          if (!next.startsWith('https://')) { reject(new Error('The model download was redirected somewhere insecure.')); return; }
          fetchTo(next, redirects + 1).then(resolve, reject);
          return;
        }
        if (statusCode !== 200) {
          response.resume();
          reject(new Error(`The model download failed (${statusCode}).`));
          return;
        }
        const total = Number(headers['content-length']) || expectedBytes;
        let received = 0;
        const file = fs.createWriteStream(partial);
        response.on('data', chunk => {
          received += chunk.length;
          onProgress?.(Math.min(1, received / total));
        });
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', reject);
        response.on('error', reject);
      }).on('error', reject);
    });

    return fetchTo(startUrl, 0).then(async () => {
      await fsp.rename(partial, target);
      return target;
    }).catch(async error => {
      await fsp.unlink(partial).catch(() => {});
      throw error;
    });
  }

  /**
   * Open the network.
   *
   * On the processor, deliberately. The graphics path (DirectML) opens this
   * model and then crashes inside the driver on the first piece — a native
   * fault, which no try/catch can stop. A slower answer beats no app.
   */
  /**
   * How to run the networks: on the processor, or on the graphics card
   * through DirectML on Windows. A change closes any open session so the
   * next job reopens it the new way.
   */
  configure({ provider = 'cpu' } = {}) {
    const wanted = provider === 'dml' && process.platform === 'win32' ? 'dml' : 'cpu';
    if (wanted !== this.wantedProvider) {
      this.session = null;
      this.karaoke = null;
      this.quick = null;
      this.hd = null;
      this.hdVocals = null;
      this.hdKaraoke = null;
    }
    this.wantedProvider = wanted;
  }

  /** Session options shared by both networks. */
  sessionOptions() {
    const cores = require('os').cpus().length;
    return {
      // The graphics card first, with the processor to fall back on if the
      // runtime cannot open it that way.
      executionProviders: this.wantedProvider === 'dml' ? ['dml', 'cpu'] : ['cpu'],
      graphOptimizationLevel: 'all',
      // Two cores are kept back: one for the window, one for the sound card's
      // thread, which glitches the song being played when it is starved.
      intraOpNumThreads: Math.max(1, cores - 2),
      interOpNumThreads: 1,
      // The runtime's threads spin-wait between operations by default, which
      // burns every core it was given even while it has nothing to do — and
      // that is what makes playback stutter alongside it.
      extra: { session: { 'intra_op.allow_spinning': '0' } },
    };
  }

  async open() {
    if (this.session) return this.session;
    const ort = require('onnxruntime-node');
    const options = this.sessionOptions();
    try {
      this.session = await ort.InferenceSession.create(this.modelPath, options);
      this.provider = this.wantedProvider || 'cpu';
    } catch (error) {
      if (this.wantedProvider !== 'dml') throw error;
      // The card could not be opened; the processor always can.
      this.session = await ort.InferenceSession.create(this.modelPath, { ...options, executionProviders: ['cpu'] });
      this.provider = 'cpu';
    }
    return this.session;
  }

  /**
   * Where a recording's stems live, and which are there: `complete` once the
   * six instruments are, `quick` once the vocals and instrumental are, and
   * `vocalsSplit` once the lead and backing are too.
   */
  cacheFor(id, tier = 'standard') {
    const folder = tier === 'hd' ? path.join(this.stemFolder, id, 'hd') : path.join(this.stemFolder, id);
    const files = Object.fromEntries(ALL_STEMS.map(stem => [stem, path.join(folder, `${stem}.wav`)]));
    const present = stem => { try { return fs.statSync(files[stem]).size > 44; } catch { return false; } };
    return {
      folder, files, tier,
      complete: STEMS.every(present),
      quick: QUICK_STEMS.every(present),
      vocalsSplit: VOCAL_PARTS.every(present),
    };
  }

  /** Everything known about a song's cache, both tiers. */
  cacheSummary(id) {
    const standard = this.cacheFor(id, 'standard');
    const hd = this.cacheFor(id, 'hd');
    return {
      complete: standard.complete, quick: standard.quick, vocalsSplit: standard.vocalsSplit,
      hd: hd.complete, hdQuick: hd.quick, hdVocalsSplit: hd.vocalsSplit,
    };
  }

  /** The options the MDX networks are opened with. */
  mdxOptions() {
    // The runtime's memory arena and pattern planner fault on the second
    // piece inside a utility process; without them these small networks
    // run just as fast.
    return { ...this.sessionOptions(), enableCpuMemArena: false, enableMemPattern: false };
  }

  /**
   * The RoFormer networks would run a fifth faster with the arena on, but
   * they fault inside the utility process just as the MDX ones do.
   */
  roformerOptions() {
    return this.mdxOptions();
  }

  cancel() {
    this.cancelled = true;
  }

  /**
   * Split an already-separated song's vocals into lead and backing.
   *
   * The karaoke network keeps everything but the lead singer. Given the vocals
   * stem alone, that is the backing vocals; the lead is what is left when they
   * are taken away, so the two always add back up to the vocals exactly.
   */
  async splitVocals(id, onProgress, tier = 'standard', { hd = false } = {}) {
    if (this.busy) throw new Error('A song is already being separated.');
    const cache = this.cacheFor(id, tier);
    if (!cache.complete && !cache.quick) throw new Error('Separate the song before splitting its vocals.');
    if (cache.vocalsSplit) {
      onProgress?.(1);
      return { id, files: cache.files, cached: true };
    }
    this.busy = true;
    this.cancelled = false;
    try {
      const { left, right } = decodeWav(await fsp.readFile(cache.files.vocals));
      let backingL, backingR;
      if (hd && this.hdKaraokeReady()) {
        // The HD karaoke network returns what it keeps: the backing vocals.
        const { RoformerModel } = require('./roformer.cjs');
        this.hdKaraoke ??= new RoformerModel({ ...MELBAND_SPEC, modelPath: this.hdKaraokePath, sessionOptions: this.roformerOptions() });
        [[backingL, backingR]] = await this.hdKaraoke.separate(left, right, (fraction, info) => onProgress?.(fraction * 0.97, info), () => this.cancelled);
      } else {
        const { MdxModel } = require('./mdx.cjs');
        this.karaoke ??= new MdxModel({ ...KARAOKE_SPEC, modelPath: this.karaokePath, sessionOptions: this.mdxOptions() });
        [backingL, backingR] = await this.karaoke.separate(
          left, right, fraction => onProgress?.(fraction * 0.97), () => this.cancelled,
        );
      }
      const leadL = new Float32Array(left.length);
      const leadR = new Float32Array(right.length);
      for (let i = 0; i < left.length; i += 1) {
        leadL[i] = left[i] - backingL[i];
        leadR[i] = right[i] - backingR[i];
      }
      await fsp.writeFile(cache.files.lead_vocals, encodeWav(leadL, leadR));
      await fsp.writeFile(cache.files.backing_vocals, encodeWav(backingL, backingR));
      onProgress?.(1);
      return { id, files: cache.files, cached: false };
    } finally {
      this.busy = false;
    }
  }

  /** Forget every separated song on disk. The models stay. */
  async clearCache() {
    await fsp.rm(this.stemFolder, { recursive: true, force: true });
  }

  /** How much the separated songs on disk add up to. */
  async cacheSize() {
    let total = 0;
    const walk = async folder => {
      let entries = [];
      try { entries = await fsp.readdir(folder, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        const full = path.join(folder, entry.name);
        if (entry.isDirectory()) await walk(full);
        else total += (await fsp.stat(full)).size;
      }
    };
    await walk(this.stemFolder);
    return total;
  }

  /**
   * The HD way: the six instruments through BS-RoFormer. Slow on a processor,
   * quick on a graphics card, and the cleanest split the app can make.
   */
  async separateHd(left, right, onProgress) {
    if (this.busy) throw new Error('A song is already being separated.');
    const id = fingerprint(left, right);
    const cache = this.cacheFor(id, 'hd');
    if (cache.complete) {
      onProgress?.(1);
      return { id, files: cache.files, cached: true, mode: 'hd', provider: this.provider };
    }
    this.busy = true;
    this.cancelled = false;
    try {
      const { RoformerModel } = require('./roformer.cjs');
      this.hd ??= new RoformerModel({ modelPath: this.hdPath, sessionOptions: this.roformerOptions() });
      const stems = await this.hd.separate(left, right, (fraction, info) => onProgress?.(fraction * 0.98, info), () => this.cancelled);
      await fsp.mkdir(cache.folder, { recursive: true });
      for (let i = 0; i < HD_ORDER.length; i += 1) {
        await fsp.writeFile(cache.files[HD_ORDER[i]], encodeWav(stems[i][0], stems[i][1]));
      }
      onProgress?.(1);
      return { id, files: cache.files, cached: false, mode: 'hd', provider: this.provider };
    } finally {
      this.busy = false;
    }
  }

  /**
   * Quick, in HD: the Mel-Band RoFormer vocal network. It returns the vocals;
   * the instrumental is what is left, so the two add back up exactly. Kept
   * under the HD tier beside the six-stem HD split.
   */
  async separateQuickHd(left, right, onProgress) {
    if (this.busy) throw new Error('A song is already being separated.');
    const id = fingerprint(left, right);
    const cache = this.cacheFor(id, 'hd');
    if (cache.quick || cache.complete) {
      onProgress?.(1);
      return { id, files: cache.files, cached: true, mode: cache.complete ? 'hd' : 'quickhd', provider: this.provider };
    }
    this.busy = true;
    this.cancelled = false;
    try {
      const { RoformerModel } = require('./roformer.cjs');
      this.hdVocals ??= new RoformerModel({ ...MELBAND_SPEC, modelPath: this.hdVocalsPath, sessionOptions: this.roformerOptions() });
      const [[vocL, vocR]] = await this.hdVocals.separate(left, right, (fraction, info) => onProgress?.(fraction * 0.97, info), () => this.cancelled);
      const instL = new Float32Array(left.length);
      const instR = new Float32Array(right.length);
      for (let i = 0; i < left.length; i += 1) {
        instL[i] = left[i] - vocL[i];
        instR[i] = right[i] - vocR[i];
      }
      await fsp.mkdir(cache.folder, { recursive: true });
      await fsp.writeFile(cache.files.vocals, encodeWav(vocL, vocR));
      await fsp.writeFile(cache.files.instrumental, encodeWav(instL, instR));
      onProgress?.(1);
      return { id, files: cache.files, cached: false, mode: 'quickhd', provider: this.provider };
    } finally {
      this.busy = false;
    }
  }

  /**
   * The quick way: vocals and instrumental only, in a fraction of the time.
   *
   * The network returns the instrumental; the vocals are what is left when
   * it is taken away from the song, so the two always add back up exactly.
   */
  async separateQuick(left, right, onProgress) {
    if (this.busy) throw new Error('A song is already being separated.');
    const id = fingerprint(left, right);
    const cache = this.cacheFor(id);
    if (cache.quick || cache.complete) {
      onProgress?.(1);
      return { id, files: cache.files, cached: true, mode: cache.quick ? 'quick' : 'full', provider: this.provider };
    }
    this.busy = true;
    this.cancelled = false;
    try {
      const { MdxModel } = require('./mdx.cjs');
      this.quick ??= new MdxModel({ ...QUICK_SPEC, modelPath: this.quickPath, sessionOptions: this.mdxOptions() });
      const [instL, instR] = await this.quick.separate(
        left, right, fraction => onProgress?.(fraction * 0.97), () => this.cancelled,
      );
      const vocL = new Float32Array(left.length);
      const vocR = new Float32Array(right.length);
      for (let i = 0; i < left.length; i += 1) {
        vocL[i] = left[i] - instL[i];
        vocR[i] = right[i] - instR[i];
      }
      await fsp.mkdir(cache.folder, { recursive: true });
      await fsp.writeFile(cache.files.instrumental, encodeWav(instL, instR));
      await fsp.writeFile(cache.files.vocals, encodeWav(vocL, vocR));
      onProgress?.(1);
      return { id, files: cache.files, cached: false, mode: 'quick', provider: this.provider };
    } finally {
      this.busy = false;
    }
  }

  /**
   * Separate a stereo recording at 44.1 kHz into its six stems.
   *
   * Resolves with the path of each stem's file. Progress runs 0 to 1.
   */
  async separate(left, right, onProgress) {
    if (this.busy) throw new Error('A song is already being separated.');
    const id = fingerprint(left, right);
    const cache = this.cacheFor(id);
    if (cache.complete) {
      onProgress?.(1);
      return { id, files: cache.files, cached: true, mode: 'full', provider: this.provider };
    }

    this.busy = true;
    this.cancelled = false;
    try {
      const ort = require('onnxruntime-node');
      const session = await this.open();
      const total = left.length;
      const window = makeWindow();
      const chunks = chunkCount(total);

      const out = STEMS.map(() => [new Float32Array(total), new Float32Array(total)]);
      const weight = new Float32Array(total);
      const input = new Float32Array(2 * SEGMENT);

      for (let chunk = 0; chunk < chunks; chunk += 1) {
        if (this.cancelled) throw new Error('Separation was cancelled.');
        const start = chunk * STRIDE;
        const length = Math.min(SEGMENT, total - start);

        // The last piece is short; the network wants its full length, so the
        // remainder is silence.
        input.fill(0);
        input.set(left.subarray(start, start + length), 0);
        input.set(right.subarray(start, start + length), SEGMENT);

        const result = await session.run({ mix: new ort.Tensor('float32', input, [1, 2, SEGMENT]) });
        const stems = result.stems.data; // [1, 6, 2, SEGMENT], flat

        for (let stem = 0; stem < STEMS.length; stem += 1) {
          for (let channel = 0; channel < 2; channel += 1) {
            const from = (stem * 2 + channel) * SEGMENT;
            const target = out[stem][channel];
            for (let i = 0; i < length; i += 1) {
              target[start + i] += stems[from + i] * window[i];
            }
          }
        }
        for (let i = 0; i < length; i += 1) weight[start + i] += window[i];
        onProgress?.((chunk + 1) / chunks * 0.97);
      }

      // Undo the cross-fade weighting. The very first and last samples carry
      // almost no weight, so they are floored rather than divided by nothing.
      for (let stem = 0; stem < STEMS.length; stem += 1) {
        for (let channel = 0; channel < 2; channel += 1) {
          const target = out[stem][channel];
          for (let i = 0; i < total; i += 1) target[i] /= Math.max(weight[i], 1e-3);
        }
      }

      await fsp.mkdir(cache.folder, { recursive: true });
      for (let stem = 0; stem < STEMS.length; stem += 1) {
        await fsp.writeFile(cache.files[STEMS[stem]], encodeWav(out[stem][0], out[stem][1]));
      }
      onProgress?.(1);
      return { id, files: cache.files, cached: false, mode: 'full', provider: this.provider };
    } finally {
      this.busy = false;
    }
  }
}

module.exports = {
  StemSeparator, STEMS, QUICK_STEMS, VOCAL_PARTS, ALL_STEMS, TIERS, SAMPLE_RATE, SEGMENT, OVERLAP, STRIDE,
  makeWindow, chunkCount, encodeWav, decodeWav, fingerprint,
};
