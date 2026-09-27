/** The only door between the page and the operating system. */

const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('easyStems', {
  isDesktop: true,
  platform: process.platform,
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  /* Separation. */
  stemStatus: () => ipcRenderer.invoke('stems:status'),
  stemDownload: () => ipcRenderer.invoke('stems:download'),
  stemDownloadKaraoke: () => ipcRenderer.invoke('stems:download-karaoke'),
  stemSeparate: (left, right) => ipcRenderer.invoke('stems:separate', left, right),
  stemSplitVocals: id => ipcRenderer.invoke('stems:split-vocals', id),
  stemCached: id => ipcRenderer.invoke('stems:cached', id),
  stemCancel: () => ipcRenderer.invoke('stems:cancel'),
  stemRead: (id, stem) => ipcRenderer.invoke('stems:read', id, stem),
  stemClearCache: () => ipcRenderer.invoke('stems:clear-cache'),
  stemCacheSize: () => ipcRenderer.invoke('stems:cache-size'),
  onStemProgress: handler => {
    const listener = (_event, progress) => handler(progress);
    ipcRenderer.on('stems:progress', listener);
    return () => ipcRenderer.removeListener('stems:progress', listener);
  },

  /* Files. */
  /** The on-disk path of a File the page was handed, for "same folder as the song". */
  pathOf: file => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  saveStem: (bytes, suggestedName) => ipcRenderer.invoke('file:save', bytes, suggestedName),
  saveAllStems: files => ipcRenderer.invoke('file:save-all', files),
  pickFolder: title => ipcRenderer.invoke('file:pick-folder', title),
  writeFiles: (folder, files) => ipcRenderer.invoke('file:write-all', folder, files),
  reveal: target => ipcRenderer.invoke('file:reveal', target),
  contentFolder: () => ipcRenderer.invoke('app:content-folder'),
  appInfo: () => ipcRenderer.invoke('app:info'),
  openExternal: url => ipcRenderer.invoke('app:open-external', url),

  /* Library. */
  libraryList: () => ipcRenderer.invoke('library:list'),
  librarySave: entry => ipcRenderer.invoke('library:save', entry),
  libraryDelete: id => ipcRenderer.invoke('library:delete', id),
});
