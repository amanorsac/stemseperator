# Easy Stems

Split any song into its instruments — drums, bass, guitar, keys, lead
vocals, backing vocals and everything else (aux) — fast, and entirely on
your own computer. Nothing is uploaded anywhere.

Three networks do the work, all through ONNX Runtime (CPU, or DirectML on
Windows when the graphics card is switched on in Settings):

- **Full mode:** [HT-Demucs](https://github.com/facebookresearch/demucs)
  (Meta, MIT) pulls out drums, bass, guitar, keys, vocals and the rest.
- **Quick mode:** the UVR MDX-Net Inst Main model (MIT) finds the vocals and
  leaves everything else as one instrumental — a far smaller network,
  several times faster than Full.
- The UVR MDX-Net Karaoke model from
  [Ultimate Vocal Remover](https://github.com/Anjok07/ultimatevocalremovergui)
  (MIT) is then run over the vocals stem alone: what it keeps is the backing
  vocals, and what it removes is the lead. The two always add back up to the
  vocals exactly.

The models are downloaded once (136 MB, 53 MB and 53 MB) the first time
each is needed. A song split once opens instantly from the library after
that.

## What it does

- Mute, solo or audition any stem; set each one's level. Every stem plays
  as its own synced track, so switches and levels are instant and seeking
  never stops the music. The original song plays while it's being separated.
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

## Where it stands against the studio standards

Done, per the Master Standard and File & Data Conventions:

- Data paths: exports under `Documents/Amanorsac Studio/Easy Stems/<song>/`;
  models, the separated-song cache, the library and settings under
  `%LOCALAPPDATA%\Amanorsac Studio\Easy Stems` (macOS: `~/Library/Application
  Support/Amanorsac Studio/Easy Stems`). Nothing written anywhere else.
- About screen (Help & Support): product and version, the studio lockup,
  legal and privacy links, the support address, licence status, third-party
  notices. The lockup is the wordmark set in type; swap in the official
  artwork from `_shared/brand` when it's supplied.
- Inter for the interface, JetBrains Mono for numbers, both shipped in
  `renderer/fonts/`. No font is fetched at runtime.
- Dropdowns are the product's own control, not the OS's. Every control has
  a visible focus state and an accessible name; `prefers-reduced-motion`
  is honoured. Toasts run 3 seconds.
- No analytics, no crash reporting, no updater, no "Aquarii Audio".

Open, for the studio to decide before release:

- **App id and key prefix** — assigned by the studio (§2 of the conventions).
  `easystems` is used as a placeholder in `package.json`. The key prefix is
  not hard-coded: any `XXXX-XXXX-XXXX-XXXX` key is sent to the server as typed.
- **Licensing** — integrated per the License Integration Standard v1.1
  (`electron/license.cjs`): the studio server, the studio public key and no
  other, proof verified (ECDSA P-256, raw 64-byte signature) before anything
  is trusted, device and key checked, random device id, key and proof stored
  through the OS key store (Electron `safeStorage`: DPAPI / Keychain), hourly
  heartbeat, 30-day grace offline, "Deactivate this device". In front of it,
  a **free trial of 5 songs**, counted by audio fingerprint so a song is never
  charged twice; after that, separating needs a key, while everything already
  separated still plays and exports. The §9 acceptance test needs a real key
  from the studio's My Apps; the client has passed the same steps against a
  local stand-in server with a test key pair (see "Testing" below).
- **Model downloads vs. the privacy policy** — Master Standard §7 says an
  unlicensed product makes no network requests. This build downloads its two
  models (about 190 MB) from Hugging Face and GitHub the first time they're
  needed. The compliant fix is to bundle them in the installer (it grows to
  roughly 320 MB); the alternative is a documented exception. Either is a
  studio call.
- **Signing and notarisation** — the installers here are unsigned test
  builds, not release candidates.

## Testing the licence path

The shipped build only ever talks to `https://amanorsac.studio` and only
trusts the studio's key. For a test run, two environment variables point it
at a stand-in: `EASY_STEMS_LICENSE_SERVER` (the base URL) and, only when
that is set, `EASY_STEMS_LICENSE_DEV_PUBKEY` (the stand-in's public key as
hex). Neither has any effect on the server address or the key in a release
build, which is what the standard's A11 and A12 checks look for.

The trial state lives in `trial.dat` beside the licence files, sealed the
same way. Deleting the app's state folder resets both the trial and the
device id, which the standard treats as a wiped machine.

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
