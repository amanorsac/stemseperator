/**
 * A fixed-size FFT for the sizes spectral separation models actually use.
 *
 * Those sizes — 5120, 6144, 7680 — are not powers of two, so the textbook
 * radix-2 transform does not apply directly. Each is a small odd number
 * times a power of two, though, and that is enough: the transform is split
 * into an odd-sized DFT (done the slow, obvious way, it is tiny) feeding a
 * radix-2 FFT. The plan for a size is built once and reused for every frame.
 */

class FFTPlan {
  constructor(n) {
    this.n = n;
    let m = n;
    let p = 1;
    while (m % 2 === 0) m /= 2;
    p = m;               // the odd part
    m = n / p;           // the power-of-two part
    if (m & (m - 1)) throw new Error(`Unsupported FFT size ${n}`);
    this.p = p;
    this.m = m;

    // Bit-reversal permutation and twiddles for the radix-2 core.
    const bits = Math.log2(m);
    this.rev = new Uint32Array(m);
    for (let i = 0; i < m; i += 1) {
      let r = 0;
      for (let b = 0; b < bits; b += 1) r = (r << 1) | ((i >> b) & 1);
      this.rev[i] = r;
    }
    this.cos = new Float64Array(m / 2);
    this.sin = new Float64Array(m / 2);
    for (let i = 0; i < m / 2; i += 1) {
      this.cos[i] = Math.cos(-2 * Math.PI * i / m);
      this.sin[i] = Math.sin(-2 * Math.PI * i / m);
    }
    // Twiddles joining the two stages, and the odd-sized DFT's own.
    this.twRe = new Float64Array(n);
    this.twIm = new Float64Array(n);
    for (let i = 0; i < n; i += 1) {
      this.twRe[i] = Math.cos(-2 * Math.PI * i / n);
      this.twIm[i] = Math.sin(-2 * Math.PI * i / n);
    }
    this.pRe = new Float64Array(p * p);
    this.pIm = new Float64Array(p * p);
    for (let a = 0; a < p; a += 1) {
      for (let b = 0; b < p; b += 1) {
        this.pRe[a * p + b] = Math.cos(-2 * Math.PI * ((a * b) % p) / p);
        this.pIm[a * p + b] = Math.sin(-2 * Math.PI * ((a * b) % p) / p);
      }
    }
    this.bufRe = new Float64Array(n);
    this.bufIm = new Float64Array(n);
  }

  /** In-place radix-2 transform of one length-m sequence at an offset. */
  radix2(re, im, offset) {
    const { m, rev, cos, sin } = this;
    for (let i = 0; i < m; i += 1) {
      const r = rev[i];
      if (r > i) {
        const a = offset + i;
        const b = offset + r;
        let t = re[a]; re[a] = re[b]; re[b] = t;
        t = im[a]; im[a] = im[b]; im[b] = t;
      }
    }
    for (let size = 2; size <= m; size *= 2) {
      const half = size / 2;
      const step = m / size;
      for (let start = 0; start < m; start += size) {
        for (let k = 0; k < half; k += 1) {
          const wr = cos[k * step];
          const wi = sin[k * step];
          const a = offset + start + k;
          const b = a + half;
          const xr = re[b] * wr - im[b] * wi;
          const xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr;
          im[b] = im[a] - xi;
          re[a] += xr;
          im[a] += xi;
        }
      }
    }
  }

  /**
   * Forward transform, in place. `re`/`im` hold n values each.
   *
   * With n = p·m: x[n] is read as x[m·a + b], a < p, b < m. For each b the
   * p-point DFT over a is taken, twiddled by W_n^(b·k1), and the m-point
   * FFTs over b then give X[k1 + p·k2].
   */
  forward(re, im) {
    const { n, p, m, twRe, twIm, pRe, pIm, bufRe, bufIm } = this;
    if (p === 1) { this.radix2(re, im, 0); return; }
    // Stage 1: p-point DFTs for every b, results laid out as [k1][b].
    for (let b = 0; b < m; b += 1) {
      for (let k1 = 0; k1 < p; k1 += 1) {
        let sr = 0;
        let si = 0;
        for (let a = 0; a < p; a += 1) {
          const xr = re[m * a + b];
          const xi = im[m * a + b];
          const wr = pRe[a * p + k1];
          const wi = pIm[a * p + k1];
          sr += xr * wr - xi * wi;
          si += xr * wi + xi * wr;
        }
        // Twiddle W_n^(b·k1).
        const t = (b * k1) % n;
        const wr = twRe[t];
        const wi = twIm[t];
        bufRe[k1 * m + b] = sr * wr - si * wi;
        bufIm[k1 * m + b] = sr * wi + si * wr;
      }
    }
    // Stage 2: m-point FFTs over b for each k1, then interleave into X.
    for (let k1 = 0; k1 < p; k1 += 1) this.radix2(bufRe, bufIm, k1 * m);
    for (let k1 = 0; k1 < p; k1 += 1) {
      for (let k2 = 0; k2 < m; k2 += 1) {
        re[k1 + p * k2] = bufRe[k1 * m + k2];
        im[k1 + p * k2] = bufIm[k1 * m + k2];
      }
    }
  }

  /** Inverse transform, in place, scaled by 1/n. */
  inverse(re, im) {
    const n = this.n;
    for (let i = 0; i < n; i += 1) im[i] = -im[i];
    this.forward(re, im);
    for (let i = 0; i < n; i += 1) {
      re[i] /= n;
      im[i] = -im[i] / n;
    }
  }
}

module.exports = { FFTPlan };
