# Easy Stems

Split any song into its instruments — drums, bass, guitar, keys, lead
vocals, backing vocals and everything else (aux) — fast, and entirely on
your own computer. Nothing is uploaded anywhere.

Two networks do the work, both through ONNX Runtime on the CPU:

- [HT-Demucs](https://github.com/facebookresearch/demucs) (Meta, MIT) pulls
  out drums, bass, guitar, keys, vocals and the rest.
- The UVR MDX-Net Karaoke model from
  [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui)
  (MIT) is then run over the vocals stem alone: what it keeps is the backing
  vocals, and what it removes is the lead. The two always add back up to the
  vocals exactly.

The models are downloaded once (about 190 MB in total) the first time
they're needed. A song split once opens instantly from the library after
that.

## What it does

- Mute, solo or audition any stem; set each one's level.
- Export the selected stems as separate files, or everything that's audible
  as one mix — an instrumental with no lead vocal, a bass-only track,
  whatever the switches say. WAV, 44.1 or 48 kHz, 16 or 24 bit.
- Batch: queue a folder of songs; each is separated and its stems saved to
  the output folder.

## Running it

```
npm install
npm start
```

If `npm install` fails inside `onnxruntime-node`'s install script (it tries to
fetch a GPU runtime it doesn't need and can 404/403 depending on your network),
install with scripts skipped and let Electron download its own binary
separately — both steps are quick and don't need the failing script:

```
npm install --ignore-scripts
node node_modules/electron/install.js
```

## Building an installer

```
npm install
npx electron-builder --win nsis   # Windows installer
npx electron-builder --mac dmg    # macOS; must be run on a Mac
```

A macOS `.dmg` can only be built on macOS. From Linux or Windows,
`npx electron-builder --mac -c.mac.target=zip` produces the app as a zip.

## How it's built

- `electron/main.cjs` — the app's window, the library, and the IPC bridge.
- `electron/stems.cjs` — the Demucs engine: chunks a song, runs it through
  the network with overlapping, cross-faded windows, and caches the result
  by an audio fingerprint. Also the vocal split, which it hands to:
- `electron/mdx.cjs` — an MDX-Net runner: the STFT the model expects,
  overlapping pieces, and the inverse; on top of `electron/fft.cjs`, an FFT
  for the odd sizes these models use.
- `electron/stemWorker.cjs` — runs the engines in their own process, so a
  song being split never freezes the window.
- `renderer/` — the whole interface: one HTML page, no framework, no build
  step. Icons are from [Lucide](https://lucide.dev) (ISC).
