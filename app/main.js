const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');

if (process.env.CAT_TEST) {
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('ignore-gpu-blocklist');
}

let win = null;
let worker = null;
let workerIdle = false;

const userData = () => app.getPath('userData');
const thumbsDir = () => path.join(userData(), 'thumbs');
const catalogFile = () => path.join(userData(), 'catalogo.json');

// ---------------------------------------------------------------- catalogo
let db = { version: 1, roots: [], entries: {} };
let byPath = new Map(); // chave normalizada do caminho -> id
let saveTimer = null;

const norm = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);
const newId = () => crypto.randomBytes(8).toString('hex');

function loadDb() {
  try {
    const raw = fs.readFileSync(catalogFile(), 'utf8');
    const j = JSON.parse(raw);
    if (j && j.entries) db = j;
  } catch (e) {
    try {
      const raw = fs.readFileSync(catalogFile() + '.bak', 'utf8');
      const j = JSON.parse(raw);
      if (j && j.entries) db = j;
    } catch (_) {}
  }
  rebuildIndex();
}

function rebuildIndex() {
  byPath = new Map();
  for (const e of Object.values(db.entries)) byPath.set(norm(e.path), e.id);
}

function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 1200);
}

function saveNow() {
  try {
    fs.mkdirSync(userData(), { recursive: true });
    const tmp = catalogFile() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    if (fs.existsSync(catalogFile())) {
      try { fs.copyFileSync(catalogFile(), catalogFile() + '.bak'); } catch (_) {}
    }
    fs.renameSync(tmp, catalogFile());
  } catch (e) {
    console.error('Falha ao salvar catálogo', e);
  }
}

function rootOf(p) {
  const n = norm(p);
  let best = null;
  for (const r of db.roots) {
    const rn = norm(r);
    if (n === rn || n.startsWith(rn + path.sep) || n.startsWith(rn.endsWith(path.sep) ? rn : rn + path.sep)) {
      if (!best || r.length > best.length) best = r;
    }
  }
  return best;
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

let pendingPatch = new Map();
let patchTimer = null;
function pushPatch(entry) {
  pendingPatch.set(entry.id, entry);
  if (!patchTimer) {
    patchTimer = setTimeout(() => {
      patchTimer = null;
      const list = [...pendingPatch.values()];
      pendingPatch = new Map();
      send('catalog:patch', { upsert: list });
    }, 250);
  }
  scheduleSave();
}

function wakeWorker() {
  if (worker && !worker.isDestroyed() && workerIdle) {
    workerIdle = false;
    worker.webContents.send('thumb:wake');
  }
}

function pendingCount() {
  let n = 0;
  for (const e of Object.values(db.entries)) if (!e.missing && !e.meta) n++;
  return n;
}
let totalForProgress = 0;

// ---------------------------------------------------------------- escaneamento
async function* walk(dir, signal) {
  let handle;
  try {
    handle = await fsp.opendir(dir);
  } catch (_) {
    return;
  }
  for await (const d of handle) {
    if (signal.cancel) return;
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name.startsWith('.') || d.name === '$RECYCLE.BIN' || d.name === 'System Volume Information' || d.name === 'node_modules') continue;
      yield* walk(full, signal);
    } else if (d.isFile() && d.name.toLowerCase().endsWith('.stl')) {
      yield full;
    }
  }
}

let scanning = false;
async function scanRoots(roots) {
  if (scanning) return { busy: true };
  scanning = true;
  const signal = { cancel: false };
  let found = 0, added = 0, changed = 0;
  const seen = new Set();
  const completed = [];
  try {
    for (const root of roots) {
      send('scan:progress', { root, found, phase: 'scan' });
      let ok = true;
      try { await fsp.access(root); } catch (_) { ok = false; }
      if (!ok) continue;
      for await (const full of walk(root, signal)) {
        let st;
        try { st = await fsp.stat(full); } catch (_) { continue; }
        found++;
        const key = norm(full);
        seen.add(key);
        let id = byPath.get(key);
        let e = id && db.entries[id];
        if (!e) {
          id = newId();
          e = {
            id, path: full, name: path.basename(full), dir: path.dirname(full), root: rootOf(full) || root,
            size: st.size, mtime: Math.round(st.mtimeMs), tags: [], fav: false, note: '', meta: null, missing: false,
          };
          db.entries[id] = e;
          byPath.set(key, id);
          added++;
          pushPatch(e);
        } else {
          let dirty = false;
          if (e.missing) { e.missing = false; dirty = true; }
          if (e.size !== st.size || e.mtime !== Math.round(st.mtimeMs)) {
            e.size = st.size; e.mtime = Math.round(st.mtimeMs); e.meta = null; dirty = true; changed++;
          }
          const r = rootOf(full) || root;
          if (e.root !== r) { e.root = r; dirty = true; }
          if (dirty) pushPatch(e);
        }
        if (found % 250 === 0) {
          send('scan:progress', { root, found, phase: 'scan' });
          await new Promise((r) => setImmediate(r));
        }
      }
      completed.push(root);
    }
    // marca como ausentes o que sumiu das pastas varridas com sucesso
    let missingNow = 0;
    for (const e of Object.values(db.entries)) {
      if (!e.missing && completed.some((r) => rootOf(e.path) === r) && !seen.has(norm(e.path))) {
        e.missing = true; missingNow++; pushPatch(e);
      }
    }
    scheduleSave();
    totalForProgress = pendingCount();
    wakeWorker();
    send('scan:done', { found, added, changed, missing: missingNow });
    return { found, added, changed, missing: missingNow };
  } finally {
    scanning = false;
  }
}

// ---------------------------------------------------------------- IPC
function registerIpc() {
  ipcMain.handle('catalog:get', () => ({
    roots: db.roots,
    entries: Object.values(db.entries),
    thumbsDir: thumbsDir(),
    pending: pendingCount(),
  }));

  ipcMain.handle('roots:add', async () => {
    const r = await dialog.showOpenDialog(win, { title: 'Escolha a pasta com seus STL', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const p = r.filePaths[0];
    if (!db.roots.some((x) => norm(x) === norm(p))) db.roots.push(p);
    scheduleSave();
    send('catalog:roots', db.roots);
    return p;
  });

  ipcMain.handle('roots:remove', (_e, root) => {
    db.roots = db.roots.filter((r) => norm(r) !== norm(root));
    const removed = [];
    for (const e of Object.values(db.entries)) {
      if (norm(e.root || '') === norm(root)) { removed.push(e.id); delete db.entries[e.id]; }
    }
    rebuildIndex();
    scheduleSave();
    send('catalog:roots', db.roots);
    send('catalog:patch', { remove: removed });
    return removed.length;
  });

  ipcMain.handle('scan:run', (_e, roots) => scanRoots(roots && roots.length ? roots : db.roots));

  ipcMain.handle('entry:update', (_e, id, patch) => {
    const e = db.entries[id];
    if (!e) return null;
    for (const k of ['tags', 'fav', 'note']) if (k in patch) e[k] = patch[k];
    pushPatch(e);
    return e;
  });

  ipcMain.handle('entry:bulk', (_e, ids, op) => {
    const out = [];
    for (const id of ids) {
      const e = db.entries[id];
      if (!e) continue;
      if (op.addTags) for (const t of op.addTags) if (!e.tags.includes(t)) e.tags.push(t);
      if (op.removeTags) e.tags = e.tags.filter((t) => !op.removeTags.includes(t));
      if ('fav' in op) e.fav = op.fav;
      pushPatch(e);
      out.push(id);
    }
    return out.length;
  });

  ipcMain.handle('tags:rename', (_e, from, to) => {
    let n = 0;
    for (const e of Object.values(db.entries)) {
      if (e.tags.includes(from)) {
        e.tags = [...new Set(e.tags.map((t) => (t === from ? to : t)))];
        pushPatch(e); n++;
      }
    }
    return n;
  });

  ipcMain.handle('file:read', async (_e, p) => {
    const buf = await fsp.readFile(p);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });

  ipcMain.handle('file:show', (_e, p) => { shell.showItemInFolder(p); });
  ipcMain.handle('file:open', (_e, p) => shell.openPath(p));

  ipcMain.handle('file:trash', async (_e, ids) => {
    const removed = [];
    const errors = [];
    for (const id of ids) {
      const e = db.entries[id];
      if (!e) continue;
      try {
        if (!e.missing) await shell.trashItem(e.path);
        delete db.entries[id];
        byPath.delete(norm(e.path));
        try { fs.unlinkSync(path.join(thumbsDir(), id + '.jpg')); } catch (_) {}
        removed.push(id);
      } catch (err) {
        errors.push(e.name + ': ' + err.message);
      }
    }
    scheduleSave();
    send('catalog:patch', { remove: removed });
    return { removed: removed.length, errors };
  });

  ipcMain.handle('file:pickDest', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Mover para qual pasta?',
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('file:move', async (_e, ids, destDir) => {
    let moved = 0;
    const errors = [];
    if (!db.roots.some((r) => norm(r) === norm(destDir)) && !rootOf(destDir)) {
      db.roots.push(destDir);
      send('catalog:roots', db.roots);
    }
    for (const id of ids) {
      const e = db.entries[id];
      if (!e || e.missing) continue;
      try {
        const target = await uniquePath(destDir, e.name);
        if (norm(target) === norm(e.path)) continue;
        await moveFile(e.path, target);
        byPath.delete(norm(e.path));
        e.path = target;
        e.name = path.basename(target);
        e.dir = path.dirname(target);
        e.root = rootOf(target) || destDir;
        byPath.set(norm(target), id);
        pushPatch(e);
        moved++;
      } catch (err) {
        errors.push(e.name + ': ' + err.message);
      }
    }
    return { moved, errors };
  });

  ipcMain.handle('file:rename', async (_e, id, newName) => {
    const e = db.entries[id];
    if (!e) return { error: 'Arquivo não encontrado' };
    let n = newName.replace(/[\\/:*?"<>|]/g, '_').trim();
    if (!n) return { error: 'Nome vazio' };
    if (!n.toLowerCase().endsWith('.stl')) n += '.stl';
    const target = path.join(e.dir, n);
    if (norm(target) !== norm(e.path) && fs.existsSync(target)) return { error: 'Já existe um arquivo com esse nome' };
    try {
      await fsp.rename(e.path, target);
      byPath.delete(norm(e.path));
      e.path = target; e.name = n;
      byPath.set(norm(target), id);
      pushPatch(e);
      return { ok: true };
    } catch (err) {
      return { error: err.message };
    }
  });

  ipcMain.handle('missing:clear', () => {
    const removed = [];
    for (const e of Object.values(db.entries)) {
      if (e.missing) { removed.push(e.id); delete db.entries[e.id]; }
    }
    rebuildIndex();
    scheduleSave();
    send('catalog:patch', { remove: removed });
    return removed.length;
  });

  ipcMain.handle('dup:find', async () => {
    const bySize = new Map();
    for (const e of Object.values(db.entries)) {
      if (e.missing) continue;
      if (!bySize.has(e.size)) bySize.set(e.size, []);
      bySize.get(e.size).push(e);
    }
    const cand = [...bySize.values()].filter((g) => g.length > 1);
    const total = cand.reduce((a, g) => a + g.length, 0);
    let done = 0;
    const groups = [];
    for (const g of cand) {
      const byHash = new Map();
      for (const e of g) {
        try {
          if (!e.hash) {
            e.hash = await hashFile(e.path);
            scheduleSave();
          }
          if (!byHash.has(e.hash)) byHash.set(e.hash, []);
          byHash.get(e.hash).push(e.id);
        } catch (_) {}
        done++;
        if (done % 5 === 0) send('dup:progress', { done, total });
      }
      for (const ids of byHash.values()) if (ids.length > 1) groups.push(ids);
    }
    send('dup:progress', { done: total, total });
    return groups;
  });

  ipcMain.handle('export:csv', async () => {
    const r = await dialog.showSaveDialog(win, {
      title: 'Exportar catálogo', defaultPath: 'catalogo-stl.csv',
      filters: [{ name: 'CSV', extensions: ['csv'] }],
    });
    if (r.canceled) return null;
    const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
    const lines = ['Nome;Pasta;Tamanho (bytes);X (mm);Y (mm);Z (mm);Triangulos;Volume (cm3);Tags;Favorito;Nota;Modificado'];
    for (const e of Object.values(db.entries)) {
      const m = e.meta || {};
      lines.push([
        q(e.name), q(e.dir), e.size, m.dx ?? '', m.dy ?? '', m.dz ?? '', m.tris ?? '', m.vol != null ? (m.vol / 1000).toFixed(2) : '',
        q(e.tags.join(', ')), e.fav ? 'sim' : '', q(e.note), new Date(e.mtime).toISOString(),
      ].join(';'));
    }
    fs.writeFileSync(r.filePath, '﻿' + lines.join('\r\n'));
    return r.filePath;
  });

  // --- fila de miniaturas (worker oculto puxa os trabalhos)
  ipcMain.handle('thumb:next', () => {
    for (const e of Object.values(db.entries)) {
      if (!e.missing && !e.meta) {
        return { id: e.id, path: e.path };
      }
    }
    workerIdle = true;
    return null;
  });

  ipcMain.handle('thumb:done', async (_e, id, dataUrl, meta) => {
    const e = db.entries[id];
    if (!e) return;
    try {
      if (dataUrl) {
        fs.mkdirSync(thumbsDir(), { recursive: true });
        const b64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
        await fsp.writeFile(path.join(thumbsDir(), id + '.jpg'), Buffer.from(b64, 'base64'));
      }
    } catch (err) { console.error(err); }
    e.meta = meta || { error: true };
    e.thumbAt = Date.now();
    pushPatch(e);
    const left = pendingCount();
    send('thumb:progress', { left, total: Math.max(totalForProgress, left) });
  });

  ipcMain.handle('thumb:regen', () => {
    for (const e of Object.values(db.entries)) {
      if (!e.missing && e.meta && e.meta.error) { e.meta = null; pushPatch(e); }
    }
    totalForProgress = pendingCount();
    wakeWorker();
  });
}

async function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let target = path.join(dir, name);
  let i = 2;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${base} (${i})${ext}`);
    i++;
  }
  return target;
}

async function moveFile(src, dst) {
  try {
    await fsp.rename(src, dst);
  } catch (err) {
    if (err.code === 'EXDEV') {
      await fsp.copyFile(src, dst);
      await fsp.unlink(src);
    } else throw err;
  }
}

function hashFile(p) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('md5');
    const s = fs.createReadStream(p);
    s.on('data', (d) => h.update(d));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

// ---------------------------------------------------------------- janelas
function createWindows() {
  win = new BrowserWindow({
    width: 1400, height: 880, minWidth: 900, minHeight: 600,
    backgroundColor: '#14161b',
    title: 'Catálogo STL',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { win = null; });

  worker = new BrowserWindow({
    show: false, width: 400, height: 400,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });
  worker.loadFile(path.join(__dirname, 'renderer', 'worker.html'));
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  loadDb();
  registerIpc();
  createWindows();

  // varredura automática ao abrir
  win.webContents.once('did-finish-load', () => {
    if (process.env.CAT_TEST) return;
    if (db.roots.length) setTimeout(() => scanRoots(db.roots).catch(console.error), 800);
  });
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });

  if (process.env.CAT_TEST) runTest();
});

async function runTest() {
  const dir = process.env.CAT_TEST;
  const shots = process.env.CAT_SHOTS || '/tmp/shots';
  fs.mkdirSync(shots, { recursive: true });
  await new Promise((r) => win.webContents.once('did-finish-load', r));
  if (!db.roots.includes(dir)) db.roots.push(dir);
  await scanRoots(db.roots);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const snap = async (name) => {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(path.join(shots, name + '.png'), img.toPNG());
  };
  for (let i = 0; i < 60 && pendingCount() > 0; i++) await sleep(500);
  await sleep(1500);
  await snap('1-grid');
  await win.webContents.executeJavaScript(`window.__test && window.__test.openFirst()`);
  await sleep(2500);
  await snap('2-viewer');
  await win.webContents.executeJavaScript(`window.__test && window.__test.closeViewer()`);
  await sleep(300);
  const log = await win.webContents.executeJavaScript(`window.__test ? window.__test.report() : 'sem __test'`);
  fs.writeFileSync(path.join(shots, 'report.txt'), String(log));
  saveNow();
  app.quit();
}

app.on('window-all-closed', () => { saveNow(); app.quit(); });
app.on('before-quit', saveNow);
