"""
Export a Mel-Band RoFormer checkpoint (ZFTurbo's training-repo class) to ONNX
with the STFT and iSTFT outside the graph, the way the BS-RoFormer SW export
is done: inputs spec_real/spec_imag [1, 2, 1025, T], outputs the masked
spectrogram per stem [1, N, 2, 1025, T]. Complex arithmetic is unrolled.
"""
import os, sys, json, time, argparse
from pathlib import Path
import torch, yaml, numpy as np
from torch import nn
from einops import rearrange, pack, unpack, repeat

MSST = Path(os.environ.get('MSST_ROOT', Path(__file__).resolve().parent.parent / 'msst'))
sys.path.insert(0, str(MSST))
from models.bs_roformer.mel_band_roformer import MelBandRoformer

class Wrapper(nn.Module):
    def __init__(self, m):
        super().__init__(); self.m = m
    def forward(self, spec_real, spec_imag):
        m = self.m
        B, S, F, T = spec_real.shape
        stft_repr = torch.stack([spec_real, spec_imag], dim=-1)          # b s f t c
        stft_repr = rearrange(stft_repr, 'b s f t c -> b (f s) t c')
        x = stft_repr[:, m.freq_indices]                                  # b f' t c
        x = rearrange(x, 'b f t c -> b t (f c)')
        x = m.band_split(x)
        for block in m.layers:
            if len(block) == 3:
                lin, tt, ft = block
                x, ps = pack([x], 'b * d'); x = lin(x); (x,) = unpack(x, ps, 'b * d')
            else:
                tt, ft = block
            x = rearrange(x, 'b t f d -> b f t d'); x, ps = pack([x], '* t d'); x = tt(x); (x,) = unpack(x, ps, '* t d')
            x = rearrange(x, 'b f t d -> b t f d'); x, ps = pack([x], '* f d'); x = ft(x); (x,) = unpack(x, ps, '* f d')
        masks = torch.stack([fn(x) for fn in m.mask_estimators], dim=1)  # b n t (f c)
        masks = rearrange(masks, 'b n t (f c) -> b n f t c', c=2)
        N = masks.shape[1]
        # Average the per-band masks where bands overlap, with a scatter-add
        # over the (frequency, channel) axis, as the model does.
        idx = repeat(m.freq_indices, 'f -> b n f t c', b=B, n=N, t=T, c=2)
        summed = torch.zeros(B, N, F * S, T, 2, dtype=masks.dtype).scatter_add(2, idx, masks)
        denom = repeat(m.num_bands_per_freq, 'f -> (f r) 1 1', r=S).to(masks.dtype).clamp(min=1e-8)
        mk = summed / denom                                               # b n (f s) t c
        sr = stft_repr[:, None, ..., 0]; si = stft_repr[:, None, ..., 1]
        mr = mk[..., 0]; mi = mk[..., 1]
        out_r = sr * mr - si * mi
        out_i = sr * mi + si * mr
        out_r = rearrange(out_r, 'b n (f s) t -> b n s f t', s=S)
        out_i = rearrange(out_i, 'b n (f s) t -> b n s f t', s=S)
        if m.zero_dc:
            dc = torch.ones(F, dtype=out_r.dtype); dc[0] = 0.0
            out_r = out_r * dc.view(1, 1, 1, F, 1); out_i = out_i * dc.view(1, 1, 1, F, 1)
        return out_r, out_i

def main():
    p = argparse.ArgumentParser(); p.add_argument('--ckpt', required=True); p.add_argument('--yaml', required=True); p.add_argument('--out', required=True); p.add_argument('--samples', type=int, default=176400)
    a = p.parse_args()
    cfg = yaml.unsafe_load(open(a.yaml))
    mc = dict(cfg['model']); mc['flash_attn'] = False
    for k in ('multi_stft_resolutions_window_sizes',):
        if isinstance(mc.get(k), list): mc[k] = tuple(mc[k])
    model = MelBandRoformer(**mc)
    state = torch.load(a.ckpt, map_location='cpu', weights_only=False)
    if isinstance(state, dict) and 'state_dict' in state: state = state['state_dict']
    missing, unexpected = model.load_state_dict(state, strict=False)
    print('missing', len(missing), missing[:3], 'unexpected', len(unexpected), unexpected[:3])
    model.eval(); w = Wrapper(model).eval()
    hop = mc['stft_hop_length']; n_fft = mc['stft_n_fft']
    torch.manual_seed(0)
    t = torch.arange(a.samples) / 44100.0
    audio = torch.stack([0.3 * torch.sin(2 * 3.14159 * 220 * t) + 0.2 * torch.sin(2 * 3.14159 * 1760 * t * (1 + 0.01 * torch.sin(5 * t))), 0.25 * torch.sin(2 * 3.14159 * 220 * t)])[None]
    win = torch.hann_window(n_fft)
    spec = torch.stft(audio.reshape(2, -1), n_fft=n_fft, hop_length=hop, win_length=n_fft, window=win, center=True, normalized=False, return_complex=True)
    sr, si = spec.real[None].contiguous(), spec.imag[None].contiguous()
    print('spec shape', tuple(sr.shape))
    with torch.no_grad():
        small = audio[..., :44100]
        ssr, ssi = [t[None].contiguous() for t in (lambda sp: (sp.real, sp.imag))(torch.stft(small.reshape(2, -1), n_fft=n_fft, hop_length=hop, win_length=n_fft, window=win, center=True, normalized=False, return_complex=True))]
        ref_full = model(small)
        wr_s, wi_s = w(ssr, ssi)
        flat_s = torch.complex(wr_s, wi_s).reshape(-1, ssr.shape[2], ssr.shape[3])
        rec_s = torch.istft(flat_s, n_fft=n_fft, hop_length=hop, win_length=n_fft, window=win, center=True, normalized=False, length=44100).reshape(1, -1, 2, 44100)
        ref_s = ref_full if ref_full.ndim == 4 else ref_full[:, None]
        print('wrapper vs original forward (1 s), max abs diff:', float((rec_s - ref_s).abs().max()), 'ref rms', float(ref_s.pow(2).mean().sqrt()))
        del ref_full, wr_s, wi_s, flat_s, rec_s
        wr, wi = w(sr, si)
        flat = torch.complex(wr, wi).reshape(-1, sr.shape[2], sr.shape[3])
        rec = torch.istft(flat, n_fft=n_fft, hop_length=hop, win_length=n_fft, window=win, center=True, normalized=False, length=a.samples).reshape(1, -1, 2, a.samples)
    t0 = time.time()
    torch.onnx.export(w, (sr, si), a.out, input_names=['spec_real', 'spec_imag'], output_names=['out_spec_real', 'out_spec_imag'], opset_version=18, dynamo=True, external_data=False)
    print('exported in %.0f s' % (time.time() - t0), Path(a.out).stat().st_size // 1048576, 'MB')
    # Raw floats for the Node parity check (tools/parity_melband.cjs).
    audio.numpy().astype('float32').tofile(a.out + '.input_audio.f32')
    rec.numpy().astype('float32').tofile(a.out + '.ref_audio.f32')
    meta = dict(n_fft=n_fft, hop=hop, samples=a.samples, stems=int(wr.shape[1]), frames=int(sr.shape[3]))
    json.dump(meta, open(a.out + '.json', 'w')); print(meta)

if __name__ == '__main__': main()
