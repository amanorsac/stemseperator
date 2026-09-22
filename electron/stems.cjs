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
const OVERLAP = Math.floor(SEGMENT / 4);
const STRIDE = SEGMENT - OVERLAP;

const MODEL_FILE = 'htdemucs_6s_fp16weights.onnx';
const MODEL_URL = `https://huggingface.co/StemSplitio/htdemucs-6s-onnx/resolve/main/${MODEL_FILE}`;
/** Roughly what the download weighs, for telling the user before it starts. */
const MODEL_BYTES = 136 * 1024 * 1024;

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

  modelReady() {
    try { return fs.statSync(this.modelPath).size > 100 * 1024 * 1024; } catch { return false; }
  }

  status() {
    return {
      modelReady: this.modelReady(),
      modelBytes: MODEL_BYTES,
      busy: this.busy,
      provider: this.provider,
      stems: STEMS,
    };
  }

  /**
   * Fetch the network, once.
   *
   * It is far too large to put in the installer for a feature not everyone
   * will use, so it is downloaded the first time stems are asked for. Written
   * to a temporary name and renamed at the end, so a download that is cut off
   * never leaves behind a file that looks complete.
   */
  downloadModel(onProgress) {
    if (this.modelReady()) return Promise.resolve(this.modelPath);
    fs.mkdirSync(this.modelFolder, { recursive: true });
    const partial = `${this.modelPath}.part`;

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
        const total = Number(headers['content-length']) || MODEL_BYTES;
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

    return fetchTo(MODEL_URL, 0).then(async () => {
      await fsp.rename(partial, this.modelPath);
      return this.modelPath;
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
  async open() {
    if (this.session) return this.session;
    const ort = require('onnxruntime-node');
    this.session = await ort.InferenceSession.create(this.modelPath, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      // Left to itself the runtime takes every core, and the app's window then
      // has nothing left to draw with: it stutters and looks frozen for minutes.
      // Half the cores is nearly as fast and leaves the lesson usable.
      intraOpNumThreads: Math.max(1, Math.floor(require('os').cpus().length / 2)),
      interOpNumThreads: 1,
    });
    this.provider = 'cpu';
    return this.session;
  }

  /** Where a recording's stems live, and whether they are all there. */
  cacheFor(id) {
    const folder = path.join(this.stemFolder, id);
    const files = Object.fromEntries(STEMS.map(stem => [stem, path.join(folder, `${stem}.wav`)]));
    const complete = STEMS.every(stem => {
      try { return fs.statSync(files[stem]).size > 44; } catch { return false; }
    });
    return { folder, files, complete };
  }

  cancel() {
    this.cancelled = true;
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
      return { id, files: cache.files, cached: true, provider: this.provider };
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
      return { id, files: cache.files, cached: false, provider: this.provider };
    } finally {
      this.busy = false;
    }
  }
}

module.exports = {
  StemSeparator, STEMS, SAMPLE_RATE, SEGMENT, OVERLAP, STRIDE,
  makeWindow, chunkCount, encodeWav, fingerprint,
};
