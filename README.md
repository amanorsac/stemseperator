# Easy Stems

Split any song into its instruments — drums, bass, guitar, keys, vocals and
everything else (aux) — fast, and entirely on your own computer. Nothing is
uploaded anywhere.

Separation runs [HT-Demucs](https://github.com/facebookresearch/demucs), Meta's
model, through ONNX Runtime, on the CPU. The network is downloaded once
(about 136 MB) the first time you separate a song; after that, a song split
once opens instantly from the cache.

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
npx electron-builder --win nsis   # or: --mac dmg
```

## How it's built

- `electron/main.cjs` — the app's window and the IPC bridge to separation.
- `electron/stems.cjs` — the separation engine: chunks a song, runs it
  through the network with overlapping, cross-faded windows, and caches the
  result by an audio fingerprint.
- `electron/stemWorker.cjs` — runs the engine in its own process, so a song
  being split never freezes the window.
- `renderer/` — the whole interface: one HTML page, no framework, no build
  step.
