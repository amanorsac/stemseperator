/**
 * Running an MDX-Net separation model — the kind Ultimate Vocal Remover
 * ships — through ONNX Runtime.
 *
 * Unlike Demucs, these networks never see audio. They see a spectrogram:
 * the short-time Fourier transform of a stretch of the song, as four planes
 * (real and imaginary parts of the left and right channels) over a fixed
 * number of frequency bins and frames. The network returns a spectrogram of
 * the same shape, holding only the part it was trained to keep, and that is
 * turned back into audio.
 *
 * The transforms here match PyTorch's stft/istft as UVR calls them — centred
 * frames, reflected padding, a periodic Hann window — because the model
 * learned on exactly that and nothing else will do. A song is fed through as
 * overlapping pieces cross-faded with a Hann window, the way UVR does it.
 */

const { FFTPlan } = require('./fft.cjs');

const HOP = 1024;
const OVERLAP = 0.25;

/** Symmetric Hann, numpy's `hanning`, used to cross-fade the pieces. */
function hanning(length) {
  const w = new Float32Array(length);
  if (length === 1) { w[0] = 1; return w; }
  for (let i = 0; i < length; i += 1) w[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (length - 1));
  return w;
}

class MdxModel {
  /**
   * @param {object} spec
   * @param {string} spec.modelPath
   * @param {number} spec.nFft        FFT size, e.g. 5120
   * @param {number} spec.dimF        frequency bins the model takes, e.g. 2048
   * @param {number} spec.dimT        log2 of frames per piece, e.g. 8 → 256
   * @param {number} spec.compensate  gain UVR applies to the model's output
   */
  constructor(spec) {
    this.spec = spec;
    this.frames = 2 ** spec.dimT;
    this.chunk = HOP * (this.frames - 1);
    this.bins = spec.nFft / 2 + 1;
    this.fft = new FFTPlan(spec.nFft);
    // Periodic Hann, torch.hann_window's default.
    this.window = new Float64Array(spec.nFft);
    for (let i = 0; i < spec.nFft; i += 1) this.window[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / spec.nFft);
    this.session = null;
  }

  async open() {
    if (this.session) return this.session;
    const ort = require('onnxruntime-node');
    const base = this.spec.sessionOptions || {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
      intraOpNumThreads: Math.max(1, require('os').cpus().length - 1),
      interOpNumThreads: 1,
    };
    const options = {
      ...base,
      // This network is memory-hungry: with its arena on, the runtime grows a
      // single gigabyte-scale block on the second piece, which the allocator
      // inside Electron's worker processes refuses, taking the process with it.
      // Without the arena it allocates per tensor, stays under 300 MB, and is
      // no slower.
      enableCpuMemArena: false,
      enableMemPattern: false,
    };
    try {
      this.session = await ort.InferenceSession.create(this.spec.modelPath, options);
    } catch (error) {
      if (!options.executionProviders.includes('dml')) throw error;
      this.session = await ort.InferenceSession.create(this.spec.modelPath, { ...options, executionProviders: ['cpu'] });
    }
    return this.session;
  }

  /**
   * STFT of a stereo piece of exactly `chunk` samples, as the model's input:
   * [1, 4, dimF, frames], planes ordered L-real, L-imag, R-real, R-imag.
   *
   * Both channels go through one complex FFT — left as the real part, right
   * as the imaginary — and are pulled apart afterwards by symmetry, which
   * halves the transforms.
   */
  stft(left, right) {
    const { nFft, dimF } = this.spec;
    const { frames, fft, window } = this;
    const pad = nFft / 2;
    const length = left.length;
    const out = new Float32Array(4 * dimF * frames);
    const re = new Float64Array(nFft);
    const im = new Float64Array(nFft);

    // A sample of the reflect-padded signal, without building it.
    const at = (x, i) => {
      let j = i - pad;
      if (j < 0) j = -j;
      else if (j >= length) j = 2 * length - 2 - j;
      return x[j];
    };

    for (let t = 0; t < frames; t += 1) {
      const start = t * HOP;
      for (let i = 0; i < nFft; i += 1) {
        re[i] = at(left, start + i) * window[i];
        im[i] = at(right, start + i) * window[i];
      }
      fft.forward(re, im);
      for (let f = 0; f < dimF; f += 1) {
        const k2 = f === 0 ? 0 : nFft - f;
        const lr = (re[f] + re[k2]) / 2;
        const li = (im[f] - im[k2]) / 2;
        const rr = (im[f] + im[k2]) / 2;
        const ri = (re[k2] - re[f]) / 2;
        out[(0 * dimF + f) * frames + t] = lr;
        out[(1 * dimF + f) * frames + t] = li;
        out[(2 * dimF + f) * frames + t] = rr;
        out[(3 * dimF + f) * frames + t] = ri;
      }
    }
    return out;
  }

  /** The inverse: the model's output back to `chunk` samples per channel. */
  istft(spec) {
    const { nFft, dimF } = this.spec;
    const { frames, fft, window, bins } = this;
    const pad = nFft / 2;
    const total = nFft + HOP * (frames - 1);
    const accL = new Float64Array(total);
    const accR = new Float64Array(total);
    const envelope = new Float64Array(total);
    const re = new Float64Array(nFft);
    const im = new Float64Array(nFft);

    for (let t = 0; t < frames; t += 1) {
      // Rebuild one complex spectrum holding both channels: Z = L + i·R.
      re.fill(0);
      im.fill(0);
      for (let f = 0; f < bins; f += 1) {
        let lr = 0; let li = 0; let rr = 0; let ri = 0;
        if (f < dimF) {
          lr = spec[(0 * dimF + f) * frames + t];
          li = spec[(1 * dimF + f) * frames + t];
          rr = spec[(2 * dimF + f) * frames + t];
          ri = spec[(3 * dimF + f) * frames + t];
        }
        // Z[f] = L[f] + i R[f]; Z[n-f] = conj(L[f]) + i conj(R[f]).
        re[f] = lr - ri;
        im[f] = li + rr;
        if (f > 0 && f < nFft - f) {
          re[nFft - f] = lr + ri;
          im[nFft - f] = rr - li;
        }
      }
      fft.inverse(re, im);
      const start = t * HOP;
      for (let i = 0; i < nFft; i += 1) {
        accL[start + i] += re[i] * window[i];
        accR[start + i] += im[i] * window[i];
        envelope[start + i] += window[i] * window[i];
      }
    }

    const length = HOP * (frames - 1);
    const left = new Float32Array(length);
    const right = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      const e = envelope[pad + i];
      const g = e > 1e-8 ? 1 / e : 0;
      left[i] = accL[pad + i] * g;
      right[i] = accR[pad + i] * g;
    }
    return [left, right];
  }

  /** One piece through the network. */
  async runPiece(left, right) {
    const ort = require('onnxruntime-node');
    const { dimF } = this.spec;
    const { frames } = this;
    const spec = this.stft(left, right);
    // UVR silences the three lowest bins before the network sees them.
    for (let c = 0; c < 4; c += 1) {
      for (let f = 0; f < 3; f += 1) spec.fill(0, (c * dimF + f) * frames, (c * dimF + f + 1) * frames);
    }
    const session = await this.open();
    const result = await session.run({
      [session.inputNames[0]]: new ort.Tensor('float32', spec, [1, 4, dimF, frames]),
    });
    return this.istft(result[session.outputNames[0]].data);
  }

  /**
   * Separate a 44.1 kHz stereo recording. Resolves with the model's own
   * stem — for a karaoke model, everything but the lead vocal — already
   * scaled by its compensation gain. What the model removed is simply the
   * input minus this.
   */
  async separate(left, right, onProgress, isCancelled) {
    const { nFft, compensate } = this.spec;
    const { chunk } = this;
    const trim = nFft / 2;
    const gen = chunk - 2 * trim;
    const length = left.length;
    const pad = gen + trim - (length % gen);
    const total = trim + length + pad;

    const mixL = new Float32Array(total);
    const mixR = new Float32Array(total);
    mixL.set(left, trim);
    mixR.set(right, trim);

    const step = Math.floor((1 - OVERLAP) * chunk);
    const outL = new Float64Array(total);
    const outR = new Float64Array(total);
    const divider = new Float64Array(total);
    const fullWindow = hanning(chunk);
    const pieces = Math.ceil(total / step);
    const pieceL = new Float32Array(chunk);
    const pieceR = new Float32Array(chunk);

    let done = 0;
    for (let start = 0; start < total; start += step) {
      if (isCancelled?.()) throw new Error('Separation was cancelled.');
      const end = Math.min(start + chunk, total);
      const actual = end - start;
      pieceL.fill(0);
      pieceR.fill(0);
      pieceL.set(mixL.subarray(start, end));
      pieceR.set(mixR.subarray(start, end));
      const [yL, yR] = await this.runPiece(pieceL, pieceR);
      const window = actual === chunk ? fullWindow : hanning(actual);
      for (let i = 0; i < actual; i += 1) {
        outL[start + i] += yL[i] * window[i];
        outR[start + i] += yR[i] * window[i];
        divider[start + i] += window[i];
      }
      done += 1;
      onProgress?.(done / pieces);
    }

    const primaryL = new Float32Array(length);
    const primaryR = new Float32Array(length);
    for (let i = 0; i < length; i += 1) {
      const d = divider[trim + i];
      const g = d > 1e-8 ? compensate / d : 0;
      primaryL[i] = outL[trim + i] * g;
      primaryR[i] = outR[trim + i] * g;
    }
    return [primaryL, primaryR];
  }
}

module.exports = { MdxModel, HOP };
