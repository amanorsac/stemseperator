/**
 * Running a BS-RoFormer separation model — the band-split transformer that
 * leads the open leaderboards — through ONNX Runtime.
 *
 * Like the MDX networks, it works on a spectrogram: the real and imaginary
 * parts of a short-time Fourier transform (2048-point, hop 512, centred,
 * Hann) of a four-second piece, for both channels. It returns a masked
 * spectrogram per stem, which is turned back into audio here. The transform
 * and its inverse match torch.stft / torch.istft as the model was trained
 * and exported with; the ONNX graph takes and gives spectrograms only.
 *
 * A song goes through as overlapping four-second pieces cross-faded with a
 * raised-cosine window, so each piece's less reliable edges are blended.
 */

const { FFTPlan } = require('./fft.cjs');

const N_FFT = 2048;
const BINS = N_FFT / 2 + 1;
const OVERLAP = 0.25;
/** The six stems of the SW model, in the order the network returns them. */
const STEMS = ['bass', 'drums', 'other', 'vocals', 'guitar', 'piano'];

/**
 * @param {object} spec
 * @param {string} spec.modelPath
 * @param {number} spec.hop        STFT hop: 512 for the BS models, 441 for the Mel-Band ones
 * @param {number} spec.chunk      samples per piece, as the graph was traced (4 s = 176400)
 * @param {number} spec.stems      how many stems the graph returns
 */
class RoformerModel {
  constructor({ modelPath, sessionOptions, hop = 512, chunk = 176400, stems = STEMS.length }) {
    this.modelPath = modelPath;
    this.sessionOptions = sessionOptions;
    this.hop = hop;
    this.chunk = chunk;
    this.stems = stems;
    this.frames = 1 + Math.floor(chunk / hop);
    this.fft = new FFTPlan(N_FFT);
    // Periodic Hann, torch.hann_window's default.
    this.window = new Float64Array(N_FFT);
    for (let i = 0; i < N_FFT; i += 1) this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N_FFT);
    this.session = null;
  }

  async open() {
    if (this.session) return this.session;
    const ort = require('onnxruntime-node');
    const options = this.sessionOptions || { executionProviders: ['cpu'], graphOptimizationLevel: 'all' };
    try {
      this.session = await ort.InferenceSession.create(this.modelPath, options);
    } catch (error) {
      if (!options.executionProviders || options.executionProviders[0] === 'cpu') throw error;
      this.session = await ort.InferenceSession.create(this.modelPath, { ...options, executionProviders: ['cpu'] });
    }
    return this.session;
  }

  /**
   * torch.stft(x, 2048, 512, 2048, hann, center=True, pad_mode='reflect').
   * Writes bin-major [BINS][FRAMES] into `re` and `im` at `offset`.
   */
  stft(x, re, im, offset) {
    const pad = N_FFT / 2;
    const padded = new Float64Array(x.length + 2 * pad);
    padded.set(x, pad);
    for (let i = 0; i < pad; i += 1) {
      padded[pad - 1 - i] = x[i + 1];
      padded[pad + x.length + i] = x[x.length - 2 - i];
    }
    const fr = new Float64Array(N_FFT);
    const fi = new Float64Array(N_FFT);
    const FRAMES = this.frames;
    for (let t = 0; t < FRAMES; t += 1) {
      const start = t * this.hop;
      for (let i = 0; i < N_FFT; i += 1) { fr[i] = padded[start + i] * this.window[i]; fi[i] = 0; }
      this.fft.forward(fr, fi);
      for (let k = 0; k < BINS; k += 1) {
        re[offset + k * FRAMES + t] = fr[k];
        im[offset + k * FRAMES + t] = fi[k];
      }
    }
  }

  /** torch.istft of one channel's spectrogram at `offset`, back to CHUNK samples. */
  istft(re, im, offset) {
    const pad = N_FFT / 2;
    const CHUNK = this.chunk;
    const FRAMES = this.frames;
    const total = CHUNK + 2 * pad;
    const out = new Float64Array(total);
    const norm = new Float64Array(total);
    const fr = new Float64Array(N_FFT);
    const fi = new Float64Array(N_FFT);
    for (let t = 0; t < FRAMES; t += 1) {
      for (let k = 0; k < BINS; k += 1) { fr[k] = re[offset + k * FRAMES + t]; fi[k] = im[offset + k * FRAMES + t]; }
      // The upper half of a real signal's spectrum is the conjugate mirror.
      for (let k = BINS; k < N_FFT; k += 1) { fr[k] = fr[N_FFT - k]; fi[k] = -fi[N_FFT - k]; }
      this.fft.inverse(fr, fi);
      const start = t * this.hop;
      for (let i = 0; i < N_FFT; i += 1) {
        out[start + i] += fr[i] * this.window[i];
        norm[start + i] += this.window[i] * this.window[i];
      }
    }
    const audio = new Float32Array(CHUNK);
    for (let i = 0; i < CHUNK; i += 1) {
      const n = norm[pad + i];
      audio[i] = n > 1e-8 ? out[pad + i] / n : 0;
    }
    return audio;
  }

  /** One four-second piece through the network. Resolves with STEMS.length × [left, right]. */
  async runPiece(left, right) {
    const ort = require('onnxruntime-node');
    const session = await this.open();
    const FRAMES = this.frames;
    const plane = BINS * FRAMES;
    const re = new Float32Array(2 * plane);
    const im = new Float32Array(2 * plane);
    this.stft(left, re, im, 0);
    this.stft(right, re, im, plane);
    const result = await session.run({
      spec_real: new ort.Tensor('float32', re, [1, 2, BINS, FRAMES]),
      spec_imag: new ort.Tensor('float32', im, [1, 2, BINS, FRAMES]),
    });
    const outRe = result.out_spec_real.data;
    const outIm = result.out_spec_imag.data;
    return Array.from({ length: this.stems }, (_, stem) => [
      this.istft(outRe, outIm, (stem * 2) * plane),
      this.istft(outRe, outIm, (stem * 2 + 1) * plane),
    ]);
  }

  /**
   * Separate a whole stereo recording at 44.1 kHz. Resolves with
   * STEMS.length × [left, right] Float32Arrays the length of the input.
   */
  async separate(left, right, onProgress, isCancelled) {
    const CHUNK = this.chunk;
    const total = left.length;
    const step = Math.floor(CHUNK * (1 - OVERLAP));
    const count = Math.max(1, Math.ceil(Math.max(0, total - CHUNK) / step) + 1);
    const out = Array.from({ length: this.stems }, () => [new Float32Array(total), new Float32Array(total)]);
    const weight = new Float32Array(total);
    // Raised-cosine cross-fade over the overlapping quarter at each end.
    const fade = Math.floor(CHUNK * OVERLAP);
    const window = new Float32Array(CHUNK).fill(1);
    for (let i = 0; i < fade; i += 1) {
      const w = 0.5 - 0.5 * Math.cos(Math.PI * (i + 1) / (fade + 1));
      window[i] = w;
      window[CHUNK - 1 - i] = w;
    }
    const pieceL = new Float32Array(CHUNK);
    const pieceR = new Float32Array(CHUNK);
    for (let c = 0; c < count; c += 1) {
      if (isCancelled?.()) throw new Error('Separation was cancelled.');
      const start = Math.min(c * step, Math.max(0, total - CHUNK));
      const length = Math.min(CHUNK, total - start);
      pieceL.fill(0); pieceR.fill(0);
      pieceL.set(left.subarray(start, start + length));
      pieceR.set(right.subarray(start, start + length));
      const stems = await this.runPiece(pieceL, pieceR);
      for (let s = 0; s < this.stems; s += 1) {
        for (let i = 0; i < length; i += 1) {
          out[s][0][start + i] += stems[s][0][i] * window[i];
          out[s][1][start + i] += stems[s][1][i] * window[i];
        }
      }
      for (let i = 0; i < length; i += 1) weight[start + i] += window[i];
      onProgress?.((c + 1) / count);
      if (total <= CHUNK) break;
    }
    for (let s = 0; s < this.stems; s += 1) {
      for (let i = 0; i < total; i += 1) {
        const w = Math.max(weight[i], 1e-3);
        out[s][0][i] /= w;
        out[s][1][i] /= w;
      }
    }
    return out;
  }
}

module.exports = { RoformerModel, STEMS, N_FFT };
