/** The only door between the page and the operating system. */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('easyStems', {
  isDesktop: true,
  minimize: () => ipcRenderer.send('window:minimize'),
  maximize: () => ipcRenderer.send('window:maximize'),
  close: () => ipcRenderer.send('window:close'),

  stemStatus: () => ipcRenderer.invoke('stems:status'),
  stemDownload: () => ipcRenderer.invoke('stems:download'),
  stemSeparate: (left, right) => ipcRenderer.invoke('stems:separate', left, right),
  stemCancel: () => ipcRenderer.invoke('stems:cancel'),
  stemRead: (id, stem) => ipcRenderer.invoke('stems:read', id, stem),
  onStemProgress: handler => {
    const listener = (_event, progress) => handler(progress);
    ipcRenderer.on('stems:progress', listener);
    return () => ipcRenderer.removeListener('stems:progress', listener);
  },

  /** Save a stem's WAV bytes to disk, asking the person where. */
  saveStem: (bytes, suggestedName) => ipcRenderer.invoke('file:save', bytes, suggestedName),
  /** Save every stem at once into one folder, asked for only once. */
  saveAllStems: files => ipcRenderer.invoke('file:save-all', files),

  /** Songs already separated, kept as facts rather than a second copy of the audio. */
  libraryList: () => ipcRenderer.invoke('library:list'),
  librarySave: entry => ipcRenderer.invoke('library:save', entry),
  libraryDelete: id => ipcRenderer.invoke('library:delete', id),
});
