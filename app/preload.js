const { contextBridge, ipcRenderer } = require('electron');

const inv = (ch) => (...a) => ipcRenderer.invoke(ch, ...a);
const on = (ch) => (cb) => {
  const h = (_e, p) => cb(p);
  ipcRenderer.on(ch, h);
  return () => ipcRenderer.removeListener(ch, h);
};

contextBridge.exposeInMainWorld('api', {
  getCatalog: inv('catalog:get'),
  addRoot: inv('roots:add'),
  removeRoot: inv('roots:remove'),
  scan: inv('scan:run'),
  update: inv('entry:update'),
  bulk: inv('entry:bulk'),
  renameTag: inv('tags:rename'),
  readFile: inv('file:read'),
  laserPaths: inv('laser:paths'),
  laserPreview: inv('laser:preview'),
  showInFolder: inv('file:show'),
  openFile: inv('file:open'),
  trash: inv('file:trash'),
  pickDest: inv('file:pickDest'),
  move: inv('file:move'),
  rename: inv('file:rename'),
  clearMissing: inv('missing:clear'),
  findDuplicates: inv('dup:find'),
  exportCsv: inv('export:csv'),
  thumbNext: inv('thumb:next'),
  thumbDone: inv('thumb:done'),
  thumbRegen: inv('thumb:regen'),
  onPatch: on('catalog:patch'),
  onRoots: on('catalog:roots'),
  onScanProgress: on('scan:progress'),
  onScanDone: on('scan:done'),
  onThumbProgress: on('thumb:progress'),
  onDupProgress: on('dup:progress'),
  onWake: on('thumb:wake'),
});
