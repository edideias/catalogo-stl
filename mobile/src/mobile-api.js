// Camada Android do Catálogo STL: implementa o mesmo `window.api` do Electron,
// usando o plugin nativo "Saf" (acesso a pastas do celular) e o armazenamento do app.
(function () {
  const Cap = window.Capacitor;
  const Saf = Cap.registerPlugin('Saf');
  document.documentElement.classList.add('mobile');

  // ---------- util
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, '0')).join('');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const bytesToB64 = (u8) => {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    return btoa(s);
  };
  const extOf = (n) => { const i = n.lastIndexOf('.'); return i > 0 ? n.slice(i + 1).toLowerCase() : ''; };
  const subs = { patch: [], roots: [], scanProgress: [], scanDone: [], thumbProgress: [], dupProgress: [], wake: [] };
  const emit = (k, p) => subs[k].forEach((f) => { try { f(p); } catch (e) { console.error(e); } });
  const on = (k) => (cb) => { subs[k].push(cb); return () => { subs[k] = subs[k].filter((x) => x !== cb); }; };

  // ---------- banco
  let db = { version: 3, roots: [], rootsLaser: [], rootUris: {}, entries: {} };
  let byPath = new Map();
  let appDirPath = '';
  let ready = null;
  let saveTimer = null;
  let totalForProgress = 0;
  let workerIdle = false;

  const rebuildIndex = () => { byPath = new Map(); for (const e of Object.values(db.entries)) byPath.set(e.path, e.id); };
  const saveNow = async () => {
    try { await Saf.writeApp({ name: 'catalogo.json', text: JSON.stringify(db) }); } catch (e) { console.error('save', e); }
  };
  const scheduleSave = () => { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 1500); };

  let pending = new Map();
  let patchTimer = null;
  function pushPatch(e) {
    pending.set(e.id, e);
    if (!patchTimer) {
      patchTimer = setTimeout(() => {
        patchTimer = null;
        const list = [...pending.values()];
        pending = new Map();
        emit('patch', { upsert: list });
      }, 250);
    }
    scheduleSave();
  }
  const pendingCount = () => { let n = 0; for (const e of Object.values(db.entries)) if (!e.missing && !e.meta) n++; return n; };
  const wake = () => { if (workerIdle) { workerIdle = false; emit('wake'); } };

  async function init() {
    const d = await Saf.appDir();
    appDirPath = d.path;
    try {
      const r = await Saf.readApp({ name: 'catalogo.json' });
      if (r && r.text) { const j = JSON.parse(r.text); if (j && j.entries) db = Object.assign(db, j); }
    } catch (e) { console.error('load', e); }
    db.rootsLaser = [];
    db.rootUris = db.rootUris || {};
    for (const e of Object.values(db.entries)) if (!e.kind) e.kind = 'stl';
    rebuildIndex();
    // worker oculto de miniaturas
    const f = document.createElement('iframe');
    f.src = 'worker.html';
    f.id = 'thumbWorker';
    f.setAttribute('aria-hidden', 'true');
    document.body.appendChild(f);
  }
  ready = null;
  const whenReady = () => (ready || (ready = init()));

  // ---------- leitura de arquivos
  const picked = new Map();
  async function readUri(uri) {
    const r = await Saf.copyToCache({ uri });
    try {
      const resp = await fetch(Cap.convertFileSrc('file://' + r.path));
      if (!resp.ok) throw new Error('Falha ao ler arquivo (' + resp.status + ')');
      return new Uint8Array(await resp.arrayBuffer());
    } finally {
      Saf.deleteCache({ path: r.path }).catch(() => {});
    }
  }
  async function readByPath(p) {
    await whenReady();
    if (picked.has(p)) return new Uint8Array(await picked.get(p).arrayBuffer());
    const id = byPath.get(p);
    const e = id && db.entries[id];
    if (!e) throw new Error('Arquivo não encontrado no catálogo');
    return readUri(e.uri);
  }

  // ---------- varredura
  let scanning = false;
  async function scan(kind, roots) {
    await whenReady();
    if (kind === 'laser') return { found: 0, added: 0, changed: 0, missing: 0 };
    if (scanning) return { busy: true };
    scanning = true;
    let found = 0, added = 0, changed = 0;
    const seen = new Set();
    const done = [];
    const handle = await Saf.addListener('scanProgress', (ev) => emit('scanProgress', { found: found + ev.found, kind }));
    try {
      for (const root of (roots && roots.length ? roots : db.roots)) {
        const treeUri = db.rootUris[root];
        if (!treeUri) continue;
        let res;
        try { res = await Saf.listTree({ uri: treeUri, exts: ['.stl'] }); } catch (e) { console.error(e); continue; }
        for (const it of res.items) {
          const p = root + '/' + it.rel;
          const dir = p.slice(0, p.lastIndexOf('/'));
          found++;
          seen.add(p);
          let id = byPath.get(p);
          let e = id && db.entries[id];
          if (!e) {
            id = newId();
            e = { id, kind: 'stl', ext: 'stl', path: p, name: it.name, dir, root, uri: it.uri, parent: it.parent, size: it.size, mtime: it.mtime, tags: [], fav: false, note: '', meta: null, missing: false };
            db.entries[id] = e; byPath.set(p, id); added++; pushPatch(e);
          } else {
            let dirty = false;
            if (e.missing) { e.missing = false; dirty = true; }
            if (e.uri !== it.uri) { e.uri = it.uri; dirty = true; }
            if (e.parent !== it.parent) { e.parent = it.parent; dirty = true; }
            if (e.size !== it.size || e.mtime !== it.mtime) { e.size = it.size; e.mtime = it.mtime; e.meta = null; dirty = true; changed++; }
            if (dirty) pushPatch(e);
          }
        }
        done.push(root);
        emit('scanProgress', { found, kind });
      }
      let missingNow = 0;
      for (const e of Object.values(db.entries)) {
        if (e.kind === 'stl' && !e.missing && done.includes(e.root) && !seen.has(e.path)) { e.missing = true; missingNow++; pushPatch(e); }
      }
      scheduleSave();
      totalForProgress = pendingCount();
      wake();
      emit('scanDone', { found, added, changed, missing: missingNow, kind });
      return { found, added, changed, missing: missingNow };
    } finally {
      handle.remove();
      scanning = false;
    }
  }

  // ---------- thumbnails
  const thumbName = (id) => 'thumbs/' + id + '.jpg';

  // ---------- API
  const api = {
    async getCatalog() {
      await whenReady();
      return { roots: { stl: db.roots, laser: [] }, entries: Object.values(db.entries), thumbsDir: appDirPath + '/thumbs', pending: pendingCount() };
    },
    thumbUrl(e) { return Cap.convertFileSrc('file://' + appDirPath + '/thumbs/' + e.id + '.jpg') + '?t=' + (e.thumbAt || 0); },
    async addRoot(kind) {
      await whenReady();
      if (kind === 'laser') return null;
      const r = await Saf.pickTree();
      if (!r || !r.uri) return null;
      // mesma pasta já adicionada?
      for (const [name, u] of Object.entries(db.rootUris)) if (u === r.uri && db.roots.includes(name)) return name;
      let name = '/' + r.name.replace(/[\\/]+/g, '_');
      let n = 2;
      while (db.roots.includes(name)) name = '/' + r.name + ' (' + n++ + ')';
      db.roots.push(name);
      db.rootUris[name] = r.uri;
      scheduleSave();
      emit('roots', { stl: db.roots, laser: [] });
      return name;
    },
    async removeRoot(kind, root) {
      await whenReady();
      db.roots = db.roots.filter((r) => r !== root);
      delete db.rootUris[root];
      const removed = [];
      for (const e of Object.values(db.entries)) if (e.root === root) { removed.push(e.id); delete db.entries[e.id]; }
      rebuildIndex(); scheduleSave();
      emit('roots', { stl: db.roots, laser: [] });
      emit('patch', { remove: removed });
      return removed.length;
    },
    scan: (kind, roots) => scan(kind, roots),
    async laserPaths() { return { error: 'Arquivos de laser/CNC ainda não estão disponíveis no celular' }; },
    async laserPreview() { return null; },
    async update(id, patch) {
      const e = db.entries[id];
      if (!e) return null;
      for (const k of ['tags', 'fav', 'note']) if (k in patch) e[k] = patch[k];
      pushPatch(e);
      return e;
    },
    async bulk(ids, op) {
      let n = 0;
      for (const id of ids) {
        const e = db.entries[id];
        if (!e) continue;
        if (op.addTags) for (const t of op.addTags) if (!e.tags.includes(t)) e.tags.push(t);
        if (op.removeTags) e.tags = e.tags.filter((t) => !op.removeTags.includes(t));
        if ('fav' in op) e.fav = op.fav;
        pushPatch(e); n++;
      }
      return n;
    },
    async renameTag(from, to) {
      let n = 0;
      for (const e of Object.values(db.entries)) {
        if (e.tags.includes(from)) { e.tags = [...new Set(e.tags.map((t) => (t === from ? to : t)))]; pushPatch(e); n++; }
      }
      return n;
    },
    readFile: (p) => readByPath(p),
    async showInFolder(p) { const e = db.entries[byPath.get(p)]; if (e) await Saf.shareUri({ uri: e.uri }); },
    async openFile(p) { const e = db.entries[byPath.get(p)]; if (e) await Saf.shareUri({ uri: e.uri }); },
    async trash(ids) {
      const removed = [];
      const errors = [];
      for (const id of ids) {
        const e = db.entries[id];
        if (!e) continue;
        try {
          if (!e.missing) await Saf.deleteDoc({ uri: e.uri });
          delete db.entries[id]; byPath.delete(e.path);
          Saf.deleteApp({ name: thumbName(id) }).catch(() => {});
          removed.push(id);
        } catch (err) { errors.push(e.name + ': ' + (err.message || err)); }
      }
      scheduleSave();
      emit('patch', { remove: removed });
      return { removed: removed.length, errors };
    },
    async pickDest() { return null; },
    async move() { return { moved: 0, errors: ['Mover arquivos ainda não está disponível no celular'] }; },
    async rename(id, newName) {
      const e = db.entries[id];
      if (!e) return { error: 'Arquivo não encontrado' };
      let n = newName.replace(/[\\/:*?"<>|]/g, '_').trim();
      if (!n) return { error: 'Nome vazio' };
      if (!n.toLowerCase().endsWith('.stl')) n += '.stl';
      try {
        const r = await Saf.renameDoc({ uri: e.uri, name: n });
        byPath.delete(e.path);
        e.uri = r.uri; e.name = n; e.path = e.dir + '/' + n;
        byPath.set(e.path, id);
        pushPatch(e);
        return { ok: true };
      } catch (err) { return { error: String(err.message || err) }; }
    },
    async clearMissing(kind) {
      const removed = [];
      for (const e of Object.values(db.entries)) if (e.missing && e.kind === kind) { removed.push(e.id); delete db.entries[e.id]; }
      rebuildIndex(); scheduleSave();
      emit('patch', { remove: removed });
      return removed.length;
    },
    async findDuplicates(kind) {
      const bySize = new Map();
      for (const e of Object.values(db.entries)) {
        if (e.missing || e.kind !== kind) continue;
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
              const buf = await readUri(e.uri);
              const h = await crypto.subtle.digest('SHA-1', buf);
              e.hash = Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join('');
              scheduleSave();
            }
            if (!byHash.has(e.hash)) byHash.set(e.hash, []);
            byHash.get(e.hash).push(e.id);
          } catch (_) {}
          done++;
          if (done % 5 === 0) emit('dupProgress', { done, total });
        }
        for (const ids of byHash.values()) if (ids.length > 1) groups.push(ids);
      }
      emit('dupProgress', { done: total, total });
      return groups;
    },
    async exportCsv(kind) {
      const q = (v) => '"' + String(v ?? '').replace(/"/g, '""') + '"';
      const lines = ['Nome;Pasta;Tamanho (bytes);X (mm);Y (mm);Z (mm);Triangulos;Volume (cm3);Tags;Favorito;Nota;Modificado'];
      for (const e of Object.values(db.entries)) {
        if (e.kind !== kind) continue;
        const m = e.meta || {};
        lines.push([q(e.name), q(e.dir), e.size, m.dx ?? '', m.dy ?? '', m.dz ?? '', m.tris ?? '', m.vol != null ? (m.vol / 1000).toFixed(2) : '', q(e.tags.join(', ')), e.fav ? 'sim' : '', q(e.note), e.mtime ? new Date(e.mtime).toISOString() : ''].join(';'));
      }
      await Saf.shareText({ name: 'catalogo-stl.csv', text: '﻿' + lines.join('\r\n') });
      return 'enviado pelo menu de compartilhar';
    },
    // fila de miniaturas
    async thumbNext() {
      await whenReady();
      for (const e of Object.values(db.entries)) {
        if (!e.missing && !e.meta) return { id: e.id, path: e.path, kind: e.kind, ext: 'stl' };
      }
      workerIdle = true;
      return null;
    },
    async thumbDone(id, dataUrl, meta) {
      const e = db.entries[id];
      if (!e) return;
      try {
        if (dataUrl) await Saf.writeApp({ name: thumbName(id), b64: dataUrl.replace(/^data:image\/\w+;base64,/, '') });
      } catch (err) { console.error(err); }
      e.meta = meta || { error: true };
      e.thumbAt = Date.now();
      pushPatch(e);
      const left = pendingCount();
      emit('thumbProgress', { left, total: Math.max(totalForProgress, left) });
    },
    async thumbRegen() {
      for (const e of Object.values(db.entries)) if (!e.missing && e.meta && e.meta.error) { e.meta = null; pushPatch(e); }
      totalForProgress = pendingCount();
      wake();
    },
    // editor
    async editSave(id, mode, data, name) {
      const e = db.entries[id];
      if (!e) return { error: 'Arquivo não encontrado' };
      const b64 = bytesToB64(data);
      try {
        if (mode === 'overwrite') {
          const bk = 'backups/' + e.id + '_' + Date.now() + '.stl';
          await Saf.copyUriToApp({ uri: e.uri, name: bk });
          e.backups = [...(e.backups || []), bk];
          while (e.backups.length > 5) Saf.deleteApp({ name: e.backups.shift() }).catch(() => {});
          await Saf.writeUri({ uri: e.uri, b64 });
          e.size = data.length; e.mtime = Date.now(); e.meta = null; delete e.hash;
          pushPatch(e); totalForProgress = pendingCount(); wake();
          return { ok: true, name: e.name };
        }
        const clean = String(name || e.name.replace(/\.stl$/i, '') + '_editado').replace(/[\\/:*?"<>|]/g, '_').trim() || 'modelo_editado';
        let fname = clean + '.stl';
        let n = 2;
        while (byPath.has(e.dir + '/' + fname)) fname = clean + ' (' + n++ + ').stl';
        const r = await Saf.createFile({ parent: e.parent, name: fname, b64 });
        const nid = newId();
        const real = r.name || fname;
        const ne = { id: nid, kind: 'stl', ext: 'stl', path: e.dir + '/' + real, name: real, dir: e.dir, root: e.root, uri: r.uri, parent: e.parent, size: data.length, mtime: Date.now(), tags: [...(e.tags || [])], fav: false, note: '', meta: null, missing: false };
        db.entries[nid] = ne; byPath.set(ne.path, nid);
        pushPatch(ne); totalForProgress = pendingCount(); wake();
        return { ok: true, id: nid, name: real, path: ne.path };
      } catch (err) {
        return { error: String(err.message || err) };
      }
    },
    async editRestore(id) {
      const e = db.entries[id];
      if (!e || !e.backups || !e.backups.length) return { error: 'Não há versão anterior' };
      const bk = e.backups[e.backups.length - 1];
      try {
        await Saf.copyAppToUri({ uri: e.uri, name: bk });
        e.backups = e.backups.slice(0, -1);
        Saf.deleteApp({ name: bk }).catch(() => {});
        e.meta = null; delete e.hash; e.mtime = Date.now();
        pushPatch(e); totalForProgress = pendingCount(); wake();
        return { ok: true };
      } catch (err) { return { error: String(err.message || err) }; }
    },
    pickStl() {
      return new Promise((resolve) => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = '.stl,model/stl,application/octet-stream';
        inp.style.display = 'none';
        document.body.appendChild(inp);
        inp.onchange = () => {
          const f = inp.files && inp.files[0];
          inp.remove();
          if (!f) return resolve(null);
          const tok = '__picked__/' + newId();
          picked.set(tok, f);
          resolve(tok);
        };
        inp.addEventListener('cancel', () => { inp.remove(); resolve(null); });
        inp.click();
      });
    },
    async getFont(bold) {
      const r = await fetch('../fonts/' + (bold ? 'DejaVuSans-Bold.ttf' : 'DejaVuSans.ttf'));
      return new Uint8Array(await r.arrayBuffer());
    },
    onPatch: on('patch'), onRoots: on('roots'), onScanProgress: on('scanProgress'), onScanDone: on('scanDone'),
    onThumbProgress: on('thumbProgress'), onDupProgress: on('dupProgress'), onWake: on('wake'),
  };
  window.api = api;
  window.addEventListener('pause', saveNow);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
})();
