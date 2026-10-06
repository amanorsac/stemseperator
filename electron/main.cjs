/**
 * Easy Stems: split a song into its instruments, on this computer, nothing
 * uploaded anywhere.
 *
 * The window is a thin shell. All the real work — running HT-Demucs over the
 * audio — happens in stems.cjs, in a worker process of its own, so the window
 * stays responsive while a song is being split.
 */

const { app, BrowserWindow, ipcMain, dialog, shell, utilityProcess } = require('electron');
const fs = require('fs/promises');
const path = require('path');
const { StemSeparator, STEMS, QUICK_STEMS, ALL_STEMS, fingerprint } = require('./stems.cjs');
const { LicenseClient } = require('./license.cjs');

let mainWindow;
let stemWorker = null;

/**
 * Where the app keeps things, as the studio's File & Data Conventions fix it.
 * Two places and nothing anywhere else: what the person made, in their
 * Documents, and the machine's own state, out of their way.
 */
const COMPANY = 'Amanorsac Studio';
const PRODUCT = 'Easy Stems';
const contentFolder = () => path.join(app.getPath('documents'), COMPANY, PRODUCT);
const stateFolder = () => (process.platform === 'win32'
  ? path.join(process.env.LOCALAPPDATA || path.join(app.getPath('home'), 'AppData', 'Local'), COMPANY, PRODUCT)
  : path.join(app.getPath('appData'), COMPANY, PRODUCT));
// A test run names its own folder on the command line; leave that alone.
if (!app.commandLine.hasSwitch('user-data-dir')) app.setPath('userData', stateFolder());

/* ---------------------------------------------------------------- *
 * The library: songs already separated, kept as small facts rather than a
 * second copy of the audio — reopening one just sums its cached stems.
 * ---------------------------------------------------------------- */

function libraryPath() {
  return path.join(app.getPath('userData'), 'library.json');
}

async function readLibrary() {
  try {
    return JSON.parse(await fs.readFile(libraryPath(), 'utf8'));
  } catch {
    return [];
  }
}

async function writeLibrary(list) {
  await fs.mkdir(path.dirname(libraryPath()), { recursive: true });
  await fs.writeFile(libraryPath(), JSON.stringify(list, null, 2));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 900,
    minWidth: 1000,
    minHeight: 720,
    // The window's own icon, for the taskbar and task switcher; the installer
    // and the app bundle take theirs from the same artwork in build/.
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    frame: false,
    backgroundColor: '#07111b',
    title: 'Easy Stems',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => { mainWindow = undefined; });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  });
}

app.whenReady().then(() => {
  if (!gotLock) return;
  createWindow();

  ipcMain.on('window:minimize', () => mainWindow?.minimize());
  ipcMain.on('window:maximize', () => (mainWindow?.isMaximized() ? mainWindow.unmaximize() : mainWindow?.maximize()));
  ipcMain.on('window:close', () => mainWindow?.close());

  /* ---------------------------------------------------------------- *
   * Stem separation
   * ---------------------------------------------------------------- */

  const stemFiles = new StemSeparator(app.getPath('userData'));

  /* ---------------------------------------------------------------- *
   * Licence and trial
   * ---------------------------------------------------------------- */

  const license = new LicenseClient(app.getPath('userData'));
  const licenseReady = license.start().catch(() => license.status());
  const tellLicense = () => mainWindow?.webContents.send('license:changed', license.status());
  ipcMain.handle('license:status', async () => { await licenseReady; return license.status(); });
  ipcMain.handle('license:activate', async (_event, key) => {
    await licenseReady;
    try {
      const status = await license.activate(String(key || ''));
      tellLicense();
      return status;
    } catch (error) {
      throw new Error(JSON.stringify({ code: error.code || 'failed', message: error.message, devices: error.devices || [] }));
    }
  });
  ipcMain.handle('license:deactivate', async () => {
    await licenseReady;
    try {
      const status = await license.deactivate();
      tellLicense();
      return status;
    } catch (error) {
      throw new Error(JSON.stringify({ code: error.code || 'failed', message: error.message }));
    }
  });

  let stemJob = 0;
  const stemJobs = new Map();

  const startStemWorker = () => {
    if (stemWorker) return stemWorker;
    const worker = utilityProcess.fork(path.join(__dirname, 'stemWorker.cjs'), [], { serviceName: 'Easy Stems separation' });
    worker.on('message', message => {
      if (message.type === 'progress') {
        mainWindow?.webContents.send('stems:progress', { stage: message.stage, fraction: message.fraction });
        return;
      }
      const waiting = stemJobs.get(message.job);
      if (!waiting) return;
      stemJobs.delete(message.job);
      if (message.type === 'done') waiting.resolve(message.result);
      else waiting.reject(new Error(message.message || 'Separation failed.'));
    });
    worker.on('exit', () => {
      if (stemWorker === worker) stemWorker = null;
      const hint = engineOptions.provider === 'dml'
        ? ' The graphics card is switched on in Settings; if this keeps happening, switch it off.'
        : '';
      stemJobs.forEach(({ reject }) => reject(new Error(`The separation engine stopped unexpectedly. Try again.${hint}`)));
      stemJobs.clear();
    });
    worker.postMessage({ type: 'init', dataFolder: app.getPath('userData') });
    worker.postMessage({ type: 'configure', options: engineOptions });
    stemWorker = worker;
    return worker;
  };

  /** How the renderer asked the engine to run; applied to every worker started. */
  let engineOptions = { provider: 'cpu' };
  ipcMain.handle('stems:configure', async (_event, options) => {
    engineOptions = { provider: options?.provider === 'dml' ? 'dml' : 'cpu' };
    stemFiles.configure(engineOptions);
    stemWorker?.postMessage({ type: 'configure', options: engineOptions });
    return engineOptions;
  });

  const askStemWorker = message => new Promise((resolve, reject) => {
    stemJob += 1;
    stemJobs.set(stemJob, { resolve, reject });
    startStemWorker().postMessage({ ...message, job: stemJob });
  });

  ipcMain.handle('stems:status', async () => ({ ...stemFiles.status(), busy: stemJobs.size > 0 }));
  ipcMain.handle('stems:download', async () => {
    await askStemWorker({ type: 'download' });
    return true;
  });
  ipcMain.handle('stems:separate', async (_event, left, right, mode) => {
    if (!(left instanceof ArrayBuffer) || !(right instanceof ArrayBuffer) || left.byteLength !== right.byteLength) {
      throw new Error('Separation needs two channels of the same length.');
    }
    if (stemJobs.size) throw new Error('A song is already being separated.');
    // The trial gate. A song already separated (or already one of the
    // trial's) is never charged; a new one needs room on the trial or a key.
    await licenseReady;
    const id = fingerprint(new Float32Array(left), new Float32Array(right));
    const cache = stemFiles.cacheFor(id, mode === 'hd' ? 'hd' : 'standard');
    const alreadyDone = mode === 'quick' ? (cache.quick || cache.complete) : cache.complete;
    if (!alreadyDone && !license.canSeparate(id)) throw new Error('TRIAL_OVER');
    const result = await askStemWorker({ type: 'separate', left, right, mode: ['quick', 'hd'].includes(mode) ? mode : 'full' });
    if (!result.cached) { license.recordSong(result.id); tellLicense(); }
    return { id: result.id, cached: result.cached, mode: result.mode, stems: result.mode === 'quick' ? QUICK_STEMS : STEMS };
  });
  ipcMain.handle('stems:download-hd', async () => {
    await askStemWorker({ type: 'download-hd' });
    return true;
  });
  ipcMain.handle('stems:download-quick', async () => {
    await askStemWorker({ type: 'download-quick' });
    return true;
  });
  ipcMain.handle('stems:cancel', async () => { stemWorker?.postMessage({ type: 'cancel' }); });
  ipcMain.handle('stems:download-karaoke', async () => {
    await askStemWorker({ type: 'download-karaoke' });
    return true;
  });
  ipcMain.handle('stems:split-vocals', async (_event, id, tier) => {
    if (!/^[0-9a-f]{20}$/.test(String(id))) throw new Error('No such song.');
    if (stemJobs.size) throw new Error('A song is already being separated.');
    const result = await askStemWorker({ type: 'split-vocals', id, tier: tier === 'hd' ? 'hd' : 'standard' });
    return { id: result.id, cached: result.cached };
  });
  // Which of a song's stems are on disk, so a reopened song knows whether
  // its vocals were ever split.
  ipcMain.handle('stems:cached', async (_event, id) => {
    if (!/^[0-9a-f]{20}$/.test(String(id))) throw new Error('No such song.');
    return stemFiles.cacheSummary(id);
  });
  ipcMain.handle('stems:clear-cache', async () => {
    if (stemJobs.size) throw new Error('Wait for the current separation to finish first.');
    await askStemWorker({ type: 'clear-cache' });
    await writeLibrary([]);
    return true;
  });
  ipcMain.handle('stems:cache-size', async () => stemFiles.cacheSize());
  // The renderer names a song by its fingerprint and a stem by name; the path
  // is built here, so it can never be pointed at anything else on the disk.
  ipcMain.handle('stems:read', async (_event, id, stem, tier) => {
    if (!/^[0-9a-f]{20}$/.test(String(id)) || !ALL_STEMS.includes(stem)) throw new Error('No such stem.');
    const bytes = await fs.readFile(stemFiles.cacheFor(id, tier === 'hd' ? 'hd' : 'standard').files[stem]);
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  });

  ipcMain.handle('file:save', async (_event, bytes, suggestedName) => {
    const chosen = await dialog.showSaveDialog(mainWindow, {
      title: 'Save stem',
      defaultPath: path.join(app.getPath('music'), suggestedName),
      filters: [{ name: 'WAV audio', extensions: ['wav'] }],
    });
    if (chosen.canceled || !chosen.filePath) return null;
    await fs.writeFile(chosen.filePath, Buffer.from(bytes));
    return chosen.filePath;
  });

  // Saving six files one Save-As dialog at a time is tedious; this asks for
  // the destination once and writes every stem straight into it.
  ipcMain.handle('file:save-all', async (_event, files) => {
    const chosen = await dialog.showOpenDialog(mainWindow, {
      title: 'Save all stems to…',
      defaultPath: contentFolder(),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (chosen.canceled || !chosen.filePaths[0]) return null;
    const folder = chosen.filePaths[0];
    for (const { name, bytes } of files) {
      await fs.writeFile(path.join(folder, name), Buffer.from(bytes));
    }
    shell.showItemInFolder(path.join(folder, files[0]?.name ?? ''));
    return folder;
  });

  ipcMain.handle('file:pick-folder', async (_event, title) => {
    const chosen = await dialog.showOpenDialog(mainWindow, {
      title: title || 'Choose a folder',
      defaultPath: contentFolder(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return chosen.canceled ? null : chosen.filePaths[0] || null;
  });

  /**
   * Write files into a folder the person already chose, without asking again
   * — what Export and batch runs do. A file name is only ever a name: anything
   * that looks like a path is reduced to its last part.
   */
  ipcMain.handle('file:write-all', async (_event, folder, files) => {
    const root = path.resolve(String(folder));
    await fs.mkdir(root, { recursive: true });
    const written = [];
    for (const { name, bytes } of files) {
      const safe = path.basename(String(name).replace(/[\\/:*?"<>|]/g, '_'));
      const target = path.join(root, safe);
      await fs.writeFile(target, Buffer.from(bytes));
      written.push(target);
    }
    return written;
  });

  ipcMain.handle('file:reveal', async (_event, target) => { shell.showItemInFolder(String(target)); });
  // The place exports go unless the person picks another: their own content
  // folder, per the studio's conventions.
  ipcMain.handle('app:content-folder', async () => {
    await fs.mkdir(contentFolder(), { recursive: true });
    return contentFolder();
  });
  ipcMain.handle('app:info', async () => ({
    product: PRODUCT,
    company: COMPANY,
    version: app.getVersion(),
    platform: process.platform,
    contentFolder: contentFolder(),
    stateFolder: app.getPath('userData'),
  }));
  ipcMain.handle('app:open-external', async (_event, url) => {
    if (!/^(https:\/\/|mailto:)/.test(String(url))) return;
    await shell.openExternal(String(url));
  });

  /* ---------------------------------------------------------------- *
   * Library
   * ---------------------------------------------------------------- */

  ipcMain.handle('library:list', async () => readLibrary());
  ipcMain.handle('library:save', async (_event, entry) => {
    if (!entry || !/^[0-9a-f]{20}$/.test(String(entry.id))) throw new Error('That song has no stems to remember.');
    const list = await readLibrary();
    const next = [{ ...entry, savedAt: new Date().toISOString() }, ...list.filter(item => item.id !== entry.id)];
    await writeLibrary(next);
    return next;
  });
  ipcMain.handle('library:delete', async (_event, id) => {
    const list = await readLibrary();
    const next = list.filter(item => item.id !== id);
    await writeLibrary(next);
    return next;
  });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => stemWorker?.kill());
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
