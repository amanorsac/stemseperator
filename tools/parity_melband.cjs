// The exported Mel-Band model through our engine vs the PyTorch reference, plus CPU speed.
const fs = require('fs'); const zlib = require('zlib');
const { RoformerModel } = require('../electron/roformer.cjs');
function readNpz(file) { const buf = fs.readFileSync(file); const out = {}; let p = 0;
  while (p + 30 <= buf.length && buf.readUInt32LE(p) === 0x04034b50) { const method = buf.readUInt16LE(p + 8), csize = buf.readUInt32LE(p + 18), nlen = buf.readUInt16LE(p + 26), xlen = buf.readUInt16LE(p + 28); const name = buf.toString('utf8', p + 30, p + 30 + nlen); let data = buf.subarray(p + 30 + nlen + xlen, p + 30 + nlen + xlen + csize); if (method === 8) data = zlib.inflateRawSync(data); const hlen = data.readUInt16LE(8); const header = data.toString('latin1', 10, 10 + hlen); const shape = header.match(/'shape': \(([^)]*)\)/)[1].split(',').map(s => s.trim()).filter(Boolean).map(Number); const body = data.subarray(10 + hlen); out[name.replace('.npy', '')] = { shape, data: new Float32Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.length)) }; p += 30 + nlen + xlen + csize; } return out; }
(async () => {
  const onnx = process.argv[2]; const meta = JSON.parse(fs.readFileSync(onnx + '.json')); const ref = { input_audio: { data: new Float32Array(fs.readFileSync(onnx + '.input_audio.f32').buffer.slice(0)) }, ref_audio: { data: new Float32Array(fs.readFileSync(onnx + '.ref_audio.f32').buffer.slice(0)) } };
  const model = new RoformerModel({ modelPath: onnx, hop: meta.hop, chunk: meta.samples, stems: meta.stems, sessionOptions: { executionProviders: ['cpu'], graphOptimizationLevel: 'all', intraOpNumThreads: 4, interOpNumThreads: 1, enableCpuMemArena: false, enableMemPattern: false } });
  const C = meta.samples; const L = ref.input_audio.data.subarray(0, C), R = ref.input_audio.data.subarray(C, 2 * C);
  const t = Date.now(); const stems = await model.runPiece(L, R); const secs = (Date.now() - t) / 1000;
  for (let s = 0; s < meta.stems; s++) { let m = 0, e = 0; const r = ref.ref_audio.data.subarray((s * 2) * C, (s * 2 + 1) * C); for (let i = 0; i < C; i++) { m = Math.max(m, Math.abs(stems[s][0][i] - r[i])); e += r[i] * r[i]; } console.log(`stem ${s}: max abs diff ${m.toExponential(2)} ref rms ${Math.sqrt(e / C).toFixed(4)}`); }
  console.log(`one ${C / 44100} s piece in ${secs.toFixed(1)} s (${(C / 44100 / secs).toFixed(2)}x realtime, 4 threads)`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
