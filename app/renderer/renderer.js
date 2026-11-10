import { parseStl, makeMaterial, addLights, THREE } from './stl.js';
import { OrbitControls } from '../vendor/OrbitControls.js';

const $ = (s) => document.querySelector(s);
const api = window.api;

const state = {
  roots: [], entries: new Map(), thumbsDir: '',
  view: 'all', folder: null, tag: null, q: '', sort: 'name',
  selected: new Set(), lastClicked: null, shown: 0, list: [],
  dupFilter: null,
};
const PAGE = 300;
const sep = navigator.platform.toLowerCase().includes('win') ? '\\' : '/';

// ------------------------------------------------------------ utilidades
const fmtSize = (b) => (b > 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB');
const fmtNum = (n) => Number(n).toLocaleString('pt-BR');
const strip = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const thumbUrl = (e) => 'file:///' + (state.thumbsDir + '/' + e.id + '.jpg').replace(/\\/g, '/').replace(/^\/+/, '') + '?t=' + (e.thumbAt || 0);
const normP = (p) => (sep === '\\' ? p.toLowerCase() : p);
const maxDim = (e) => (e.meta && !e.meta.error ? Math.max(e.meta.dx, e.meta.dy, e.meta.dz) : 0);
const hasThumb = (e) => e.meta && !e.meta.error;

function setStatus(text, frac) {
  $('#statusText').textContent = text;
  $('#barFill').style.width = frac == null ? '0' : Math.round(frac * 100) + '%';
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

// ------------------------------------------------------------ diálogos
function dialog({ title, body, ok = 'OK', cancel = 'Cancelar', focus }) {
  return new Promise((resolve) => {
    $('#dlgTitle').textContent = title;
    const b = $('#dlgBody');
    b.innerHTML = '';
    if (typeof body === 'string') b.innerHTML = body; else b.appendChild(body);
    $('#dlgOk').textContent = ok;
    $('#dlgCancel').style.display = cancel ? '' : 'none';
    $('#dlgCancel').textContent = cancel || '';
    $('#dlg').hidden = false;
    const f = focus ? b.querySelector(focus) : null;
    if (f) { f.focus(); f.select && f.select(); }
    const done = (v) => {
      $('#dlg').hidden = true;
      $('#dlgOk').onclick = $('#dlgCancel').onclick = null;
      document.removeEventListener('keydown', key, true);
      resolve(v);
    };
    const key = (ev) => {
      if (ev.key === 'Escape') { ev.stopPropagation(); done(false); }
      if (ev.key === 'Enter' && ev.target.tagName !== 'TEXTAREA') { ev.stopPropagation(); ev.preventDefault(); done(true); }
    };
    document.addEventListener('keydown', key, true);
    $('#dlgOk').onclick = () => done(true);
    $('#dlgCancel').onclick = () => done(false);
  });
}

// versão que lê o valor antes de fechar
function promptText(title, placeholder = '', value = '', withTags = false, chips = null) {
  return new Promise((resolve) => {
    const wrap = document.createElement('div');
    const inp = document.createElement('input');
    inp.type = 'text'; inp.placeholder = placeholder; inp.value = value;
    if (withTags) inp.setAttribute('list', 'tagList');
    wrap.appendChild(inp);
    if (chips && chips.length) {
      const c = document.createElement('div'); c.className = 'chips';
      for (const t of chips) {
        const b = document.createElement('button'); b.textContent = t;
        b.onclick = () => { inp.value = inp.value ? inp.value.replace(/[,\s]+$/, '') + ', ' + t : t; inp.focus(); };
        c.appendChild(b);
      }
      wrap.appendChild(c);
    }
    dialog({ title, body: wrap, focus: 'input' }).then((ok) => resolve(ok ? inp.value.trim() : null));
  });
}

const parseTags = (s) => [...new Set(s.split(/[,;]+/).map((t) => t.trim()).filter(Boolean))];

// ------------------------------------------------------------ dados
async function load() {
  const c = await api.getCatalog();
  state.roots = c.roots;
  state.thumbsDir = c.thumbsDir;
  state.entries = new Map(c.entries.map((e) => [e.id, e]));
  refreshAll();
  if (c.pending) setStatus(`Gerando miniaturas… ${c.pending} restantes`, 0);
}

api.onPatch((p) => {
  if (p.upsert) for (const e of p.upsert) state.entries.set(e.id, e);
  if (p.remove) for (const id of p.remove) { state.entries.delete(id); state.selected.delete(id); }
  scheduleRefresh();
  if (viewerOpen) updateViewerInfo();
});
api.onRoots((r) => { state.roots = r; scheduleRefresh(); });
api.onScanProgress((p) => setStatus(`Procurando arquivos… ${fmtNum(p.found)} STL encontrados`, null));
api.onScanDone((r) => {
  const parts = [`${fmtNum(r.found)} arquivos`];
  if (r.added) parts.push(`${fmtNum(r.added)} novos`);
  if (r.missing) parts.push(`${fmtNum(r.missing)} ausentes`);
  setStatus('Varredura concluída: ' + parts.join(', '), 1);
});
api.onThumbProgress((p) => {
  if (p.left > 0) setStatus(`Gerando miniaturas… ${fmtNum(p.total - p.left)} de ${fmtNum(p.total)}`, (p.total - p.left) / p.total);
  else setStatus('Miniaturas prontas', 1);
});

const scheduleRefresh = debounce(() => refreshAll(true), 120);

// ------------------------------------------------------------ filtragem
function entriesArr() { return [...state.entries.values()]; }

function computeList() {
  const q = strip(state.q.trim());
  const words = q ? q.split(/\s+/) : [];
  const fr = state.folder ? normP(state.folder) : null;
  let arr = entriesArr().filter((e) => {
    if (state.dupFilter) return state.dupFilter.has(e.id);
    if (state.view === 'missing') { if (!e.missing) return false; }
    else if (e.missing) return false;
    if (state.view === 'fav' && !e.fav) return false;
    if (state.view === 'untagged' && e.tags.length) return false;
    if (state.view === 'nometa' && !(e.meta && e.meta.error)) return false;
    if (fr && !(normP(e.dir) === fr || normP(e.dir).startsWith(fr + sep))) return false;
    if (state.tag && !e.tags.includes(state.tag)) return false;
    if (words.length) {
      const hay = e._hay || (e._hay = strip(e.name + ' ' + e.dir + ' ' + e.tags.join(' ') + ' ' + e.note));
      for (const w of words) if (!hay.includes(w)) return false;
    }
    return true;
  });
  const cmp = {
    name: (a, b) => a.name.localeCompare(b.name, 'pt', { numeric: true, sensitivity: 'base' }),
    nameDesc: (a, b) => b.name.localeCompare(a.name, 'pt', { numeric: true, sensitivity: 'base' }),
    new: (a, b) => b.mtime - a.mtime,
    old: (a, b) => a.mtime - b.mtime,
    big: (a, b) => b.size - a.size,
    small: (a, b) => a.size - b.size,
    dim: (a, b) => maxDim(b) - maxDim(a),
    tris: (a, b) => ((b.meta && b.meta.tris) || 0) - ((a.meta && a.meta.tris) || 0),
  }[state.sort];
  arr.sort(cmp);
  return arr;
}

// ------------------------------------------------------------ renderização
function refreshAll(keepScroll) {
  for (const e of state.entries.values()) delete e._hay;
  renderSidebar();
  const sc = $('#content').scrollTop;
  state.list = computeList();
  state.shown = 0;
  $('#grid').innerHTML = '';
  appendPage();
  if (keepScroll) { $('#content').scrollTop = sc; while (state.shown < state.list.length && $('#content').scrollHeight < sc + $('#content').clientHeight + 200) appendPage(); }
  const none = state.entries.size === 0;
  $('#empty').hidden = !none;
  $('#crumb').textContent = crumbText();
  renderSelbar();
}

function crumbText() {
  const parts = [];
  if (state.dupFilter) parts.push('Duplicados');
  else parts.push({ all: 'Todos', fav: 'Favoritos', untagged: 'Sem tag', nometa: 'Com erro', missing: 'Ausentes' }[state.view]);
  if (state.folder) parts.push(state.folder);
  if (state.tag) parts.push('#' + state.tag);
  if (state.q) parts.push('“' + state.q + '”');
  return `${parts.join('  ›  ')}  —  ${fmtNum(state.list.length)} arquivo(s)`;
}

function cardHtml(e) {
  const m = e.meta && !e.meta.error ? e.meta : null;
  const dims = m ? `${Math.round(m.dx)}×${Math.round(m.dy)}×${Math.round(m.dz)} mm` : (e.meta && e.meta.error ? 'não foi possível abrir' : 'processando…');
  const img = hasThumb(e) ? `<img loading="lazy" src="${thumbUrl(e)}">` : (e.meta ? '⚠' : '…');
  return `<div class="th">${img}</div>
    <div class="nm" title="${esc(e.name)}">${esc(e.name)}</div>
    <div class="mt">${dims} · ${fmtSize(e.size)}</div>
    ${e.tags.length ? `<div class="tgs">${e.tags.map((t) => '#' + esc(t)).join(' ')}</div>` : ''}
    <span class="star ${e.fav ? '' : 'off'}" data-star="1">${e.fav ? '★' : '☆'}</span>`;
}

function appendPage() {
  const g = $('#grid');
  const end = Math.min(state.list.length, state.shown + PAGE);
  const frag = document.createDocumentFragment();
  for (let i = state.shown; i < end; i++) {
    const e = state.list[i];
    const d = document.createElement('div');
    d.className = 'card' + (state.selected.has(e.id) ? ' sel' : '') + (e.missing ? ' miss' : '');
    d.dataset.id = e.id;
    d.dataset.i = i;
    d.innerHTML = cardHtml(e);
    frag.appendChild(d);
  }
  g.appendChild(frag);
  state.shown = end;
}

new IntersectionObserver((en) => {
  if (en[0].isIntersecting && state.shown < state.list.length) appendPage();
}, { root: $('#content'), rootMargin: '600px' }).observe($('#sentinel'));

// árvore de pastas
function buildTree() {
  const rootsMap = new Map();
  for (const e of state.entries.values()) {
    if (e.missing) continue;
    const root = e.root || e.dir;
    let rn = rootsMap.get(root);
    if (!rn) { rn = { name: root, full: root, kids: new Map(), count: 0 }; rootsMap.set(root, rn); }
    rn.count++;
    let rel = e.dir.slice(root.length).replace(/^[\\/]+/, '');
    let node = rn;
    if (rel) {
      let cur = root;
      for (const part of rel.split(/[\\/]+/)) {
        cur = cur.replace(/[\\/]+$/, '') + sep + part;
        let k = node.kids.get(part);
        if (!k) { k = { name: part, full: cur, kids: new Map(), count: 0 }; node.kids.set(part, k); }
        k.count++;
        node = k;
      }
    }
  }
  return [...rootsMap.values()].sort((a, b) => a.name.localeCompare(b.name));
}

const expanded = new Set();
const seenRoots = new Set();
function renderNode(n, depth) {
  const wrap = document.createElement('div');
  wrap.className = 'tnode';
  const hasKids = n.kids.size > 0;
  const isOpen = expanded.has(n.full);
  const it = document.createElement('div');
  it.className = 'item' + (state.folder === n.full && !state.dupFilter ? ' active' : '');
  const label = depth === 0 ? n.name : n.name;
  it.innerHTML = `<span class="lbl" title="${esc(n.full)}"><span class="caret">${hasKids ? (isOpen ? '▾' : '▸') : ''}</span>${esc(label)}</span><span class="cnt">${fmtNum(n.count)}</span>`;
  it.onclick = (ev) => {
    if (ev.target.classList.contains('caret') && hasKids) { isOpen ? expanded.delete(n.full) : expanded.add(n.full); renderSidebar(); return; }
    state.folder = state.folder === n.full ? null : n.full;
    state.dupFilter = null;
    if (hasKids) expanded.add(n.full);
    state.selected.clear();
    refreshAll();
  };
  wrap.appendChild(it);
  if (hasKids && isOpen) {
    const k = document.createElement('div'); k.className = 'kids';
    for (const c of [...n.kids.values()].sort((a, b) => a.name.localeCompare(b.name, 'pt', { numeric: true }))) k.appendChild(renderNode(c, depth + 1));
    wrap.appendChild(k);
  }
  return wrap;
}

function allTags() {
  const m = new Map();
  for (const e of state.entries.values()) if (!e.missing) for (const t of e.tags) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt'));
}

function renderSidebar() {
  const arr = entriesArr();
  const live = arr.filter((e) => !e.missing);
  $('#cntAll').textContent = fmtNum(live.length);
  $('#cntFav').textContent = fmtNum(live.filter((e) => e.fav).length);
  $('#cntUntagged').textContent = fmtNum(live.filter((e) => !e.tags.length).length);
  const err = live.filter((e) => e.meta && e.meta.error).length;
  const mis = arr.length - live.length;
  $('#itemErr').hidden = !err; $('#cntErr').textContent = err;
  $('#itemMissing').hidden = !mis; $('#cntMissing').textContent = mis;
  document.querySelectorAll('#side .sec:first-child .item').forEach((i) => {
    i.classList.toggle('active', i.dataset.view === state.view && !state.folder && !state.tag && !state.dupFilter);
  });
  const tree = $('#tree');
  tree.innerHTML = '';
  const roots = buildTree();
  for (const r of roots) { if (!seenRoots.has(r.full)) { seenRoots.add(r.full); expanded.add(r.full); } tree.appendChild(renderNode(r, 0)); }
  const tg = $('#tags');
  tg.innerHTML = '';
  const tags = allTags();
  const dl = $('#tagList'); dl.innerHTML = tags.map(([t]) => `<option value="${esc(t)}">`).join('');
  if (!tags.length) tg.innerHTML = '<div class="muted" style="padding:4px 8px;font-size:12px">Nenhuma tag ainda. Selecione arquivos e clique em “＋ Tag”.</div>';
  for (const [t, c] of tags) {
    const it = document.createElement('div');
    it.className = 'item' + (state.tag === t ? ' active' : '');
    it.innerHTML = `<span class="lbl">#${esc(t)}</span><span class="cnt">${c}</span>`;
    it.onclick = () => { state.tag = state.tag === t ? null : t; state.dupFilter = null; state.selected.clear(); refreshAll(); };
    it.oncontextmenu = async (ev) => {
      ev.preventDefault();
      const n = await promptText(`Renomear a tag “${t}”`, 'novo nome', t);
      if (n && n !== t) { await api.renameTag(t, n); if (state.tag === t) state.tag = n; }
    };
    it.title = 'Clique para filtrar · botão direito para renomear';
    tg.appendChild(it);
  }
}

document.querySelectorAll('#side .sec:first-child .item').forEach((i) => {
  i.onclick = () => { state.view = i.dataset.view; state.folder = null; state.tag = null; state.dupFilter = null; state.selected.clear(); refreshAll(); };
});

// ------------------------------------------------------------ seleção
function renderSelbar() {
  const n = state.selected.size;
  $('#selbar').hidden = n === 0;
  $('#selCount').textContent = n + (n === 1 ? ' selecionado' : ' selecionados');
  document.querySelectorAll('.card').forEach((c) => c.classList.toggle('sel', state.selected.has(c.dataset.id)));
}

$('#grid').addEventListener('click', (ev) => {
  const card = ev.target.closest('.card');
  if (!card) return;
  const id = card.dataset.id;
  const e = state.entries.get(id);
  if (ev.target.dataset.star) { api.update(id, { fav: !e.fav }); return; }
  const i = +card.dataset.i;
  if (ev.shiftKey && state.lastClicked != null) {
    const [a, b] = [Math.min(state.lastClicked, i), Math.max(state.lastClicked, i)];
    for (let k = a; k <= b; k++) state.selected.add(state.list[k].id);
  } else if (ev.ctrlKey || ev.metaKey || state.selected.size > 0) {
    state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
    state.lastClicked = i;
  } else {
    openViewer(i);
    return;
  }
  state.lastClicked = i;
  renderSelbar();
});
$('#grid').addEventListener('dblclick', (ev) => {
  const card = ev.target.closest('.card');
  if (card && state.selected.size) { openViewer(+card.dataset.i); }
});
$('#grid').addEventListener('contextmenu', (ev) => {
  const card = ev.target.closest('.card');
  if (!card) return;
  ev.preventDefault();
  const id = card.dataset.id;
  state.selected.has(id) ? state.selected.delete(id) : state.selected.add(id);
  state.lastClicked = +card.dataset.i;
  renderSelbar();
});

$('#selbar').addEventListener('click', async (ev) => {
  const act = ev.target.dataset.act;
  if (!act) return;
  const ids = [...state.selected];
  if (act === 'clear') { state.selected.clear(); renderSelbar(); return; }
  if (act === 'tag') {
    const v = await promptText(`Adicionar tag a ${ids.length} arquivo(s)`, 'ex.: miniatura, suporte, dragão (separe por vírgula)', '', true, allTags().slice(0, 12).map((t) => t[0]));
    if (v) await api.bulk(ids, { addTags: parseTags(v) });
  } else if (act === 'untag') {
    const common = allTags().map((t) => t[0]).filter((t) => ids.some((id) => state.entries.get(id).tags.includes(t)));
    const v = await promptText('Remover qual tag?', 'nome da tag', '', true, common.slice(0, 14));
    if (v) await api.bulk(ids, { removeTags: parseTags(v) });
  } else if (act === 'fav') {
    const allFav = ids.every((id) => state.entries.get(id).fav);
    await api.bulk(ids, { fav: !allFav });
  } else if (act === 'move') {
    const dest = await api.pickDest();
    if (!dest) return;
    setStatus('Movendo arquivos…', null);
    const r = await api.move(ids, dest);
    setStatus(`${r.moved} arquivo(s) movido(s)` + (r.errors.length ? `, ${r.errors.length} erro(s)` : ''), 1);
    if (r.errors.length) await dialog({ title: 'Alguns arquivos não foram movidos', body: '<pre style="white-space:pre-wrap;max-width:560px">' + esc(r.errors.slice(0, 15).join('\n')) + '</pre>', cancel: null });
    state.selected.clear();
  } else if (act === 'trash') {
    const ok = await dialog({ title: 'Mandar para a lixeira?', body: `<p>${ids.length} arquivo(s) serão enviados para a <b>Lixeira</b> do Windows (dá para restaurar de lá).</p>`, ok: 'Mandar para a lixeira' });
    if (!ok) return;
    const r = await api.trash(ids);
    setStatus(`${r.removed} arquivo(s) na lixeira`, 1);
    state.selected.clear();
  }
  scheduleRefresh();
});

// ------------------------------------------------------------ barra superior
$('#btnAdd').onclick = $('#btnAdd2').onclick = async () => {
  const p = await api.addRoot();
  if (p) { setStatus('Procurando arquivos…', null); api.scan([p]); }
};
$('#btnRescan').onclick = () => { setStatus('Procurando arquivos…', null); api.scan(); };
$('#search').addEventListener('input', debounce((e) => { state.q = e.target.value; state.selected.clear(); refreshAll(); }, 160));
$('#sort').onchange = (e) => { state.sort = e.target.value; refreshAll(); };
$('#zoom').oninput = (e) => document.documentElement.style.setProperty('--card', e.target.value + 'px');

$('#btnMore').onclick = (ev) => { ev.stopPropagation(); $('#menuMore').hidden = !$('#menuMore').hidden; };
document.addEventListener('click', () => { $('#menuMore').hidden = true; });
$('#menuMore').addEventListener('click', async (ev) => {
  const m = ev.target.dataset.m;
  if (!m) return;
  if (m === 'csv') { const p = await api.exportCsv(); if (p) setStatus('Catálogo exportado: ' + p, 1); }
  if (m === 'regen') { api.thumbRegen(); setStatus('Tentando de novo…', 0); }
  if (m === 'clearMissing') { const n = await api.clearMissing(); setStatus(n + ' item(ns) ausente(s) removido(s) do catálogo', 1); }
  if (m === 'removeRoot') {
    if (!state.roots.length) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = '<p class="muted">Isso tira a pasta do catálogo (tags e notas dos arquivos dela serão perdidas). Os arquivos no disco NÃO são apagados.</p>';
    const sel = document.createElement('select'); sel.style.width = '100%';
    sel.innerHTML = state.roots.map((r) => `<option>${esc(r)}</option>`).join('');
    wrap.appendChild(sel);
    if (await dialog({ title: 'Remover pasta do catálogo', body: wrap, ok: 'Remover' })) { await api.removeRoot(sel.value); state.folder = null; }
  }
});

// ------------------------------------------------------------ duplicados
let dupGroups = [];
$('#btnDup').onclick = async () => {
  setStatus('Procurando duplicados…', 0);
  $('#btnDup').disabled = true;
  dupGroups = await api.findDuplicates();
  $('#btnDup').disabled = false;
  setStatus(dupGroups.length ? `${dupGroups.length} grupo(s) de duplicados` : 'Nenhum duplicado encontrado', 1);
  if (!dupGroups.length) { await dialog({ title: 'Sem duplicados', body: '<p>Não encontrei arquivos idênticos (mesmo conteúdo) no catálogo. 🎉</p>', cancel: null }); return; }
  renderDups();
  $('#dupPanel').hidden = false;
};
api.onDupProgress((p) => setStatus(`Comparando arquivos… ${p.done}/${p.total}`, p.total ? p.done / p.total : 0));
const dupMarked = new Set();
function renderDups() {
  dupMarked.clear();
  const body = $('#dupBody');
  body.innerHTML = '';
  let waste = 0;
  dupGroups.forEach((g, gi) => {
    const items = g.map((id) => state.entries.get(id)).filter(Boolean);
    if (items.length < 2) return;
    waste += items[0].size * (items.length - 1);
    const d = document.createElement('div'); d.className = 'dgroup';
    d.innerHTML = `<div class="gh">Grupo ${gi + 1} — ${items.length} cópias de ${fmtSize(items[0].size)}</div>` + items.map((e, i) => `
      <label class="drow"><input type="checkbox" data-id="${e.id}" data-first="${i === 0 ? 1 : 0}">
      ${hasThumb(e) ? `<img src="${thumbUrl(e)}">` : '<img>'}<span class="p"><b>${esc(e.name)}</b><br><span class="muted">${esc(e.dir)}</span></span></label>`).join('');
    body.appendChild(d);
  });
  $('#dupTitle').textContent = `Arquivos duplicados — dá para liberar ${fmtSize(waste)}`;
}
$('#dupAuto').onclick = () => document.querySelectorAll('#dupBody input').forEach((c) => { c.checked = c.dataset.first === '0'; });
$('#dupClose').onclick = () => { $('#dupPanel').hidden = true; };
$('#dupTrash').onclick = async () => {
  const ids = [...document.querySelectorAll('#dupBody input:checked')].map((c) => c.dataset.id);
  if (!ids.length) return;
  // proteção: nunca deixar um grupo sem nenhuma cópia
  for (const g of dupGroups) {
    if (g.length && g.every((id) => ids.includes(id))) {
      await dialog({ title: 'Opa', body: '<p>Em algum grupo todas as cópias estão marcadas. Desmarque pelo menos uma de cada grupo.</p>', cancel: null });
      return;
    }
  }
  if (!(await dialog({ title: 'Mandar para a lixeira?', body: `<p>${ids.length} cópia(s) vão para a Lixeira.</p>`, ok: 'Confirmar' }))) return;
  const r = await api.trash(ids);
  setStatus(`${r.removed} duplicado(s) na lixeira`, 1);
  $('#dupPanel').hidden = true;
};

// ------------------------------------------------------------ visualizador
let viewerOpen = false, vIndex = 0, vEntry = null;
let vr = null; // {renderer, scene, camera, controls, mesh, grid, axes, ro, raf}

function initViewer() {
  if (vr) return;
  const container = $('#vCanvas');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x14171e, 1);
  container.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1e6);
  camera.up.set(0, 0, 1);
  addLights(scene, camera);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  const material = makeMaterial();
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  });
  ro.observe(container);
  vr = { renderer, scene, camera, controls, material, mesh: null, grid: null, axes: null, ro, raf: 0, size: 100 };
  const loop = () => { vr.raf = requestAnimationFrame(loop); vr.controls.update(); vr.renderer.render(vr.scene, vr.camera); };
  loop();
}

function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

function frame() {
  if (!vr || !vr.mesh) return;
  const geo = vr.mesh.geometry;
  const r = geo.boundingSphere.radius || 1, c = geo.boundingSphere.center;
  const dist = (r / Math.sin((vr.camera.fov * Math.PI) / 360)) * 1.1;
  const dir = new THREE.Vector3(1, -1.25, 0.85).normalize();
  vr.camera.position.copy(c).addScaledVector(dir, dist);
  vr.camera.near = dist / 200; vr.camera.far = dist * 50;
  vr.camera.updateProjectionMatrix();
  vr.controls.target.copy(c);
  vr.controls.update();
}

async function loadInViewer(e) {
  initViewer();
  $('#vDims').textContent = 'Carregando…';
  if (vr.mesh) { vr.scene.remove(vr.mesh); vr.mesh.geometry.dispose(); vr.mesh = null; }
  if (vr.grid) { vr.scene.remove(vr.grid); vr.grid = null; }
  if (vr.axes) { vr.scene.remove(vr.axes); vr.axes = null; }
  try {
    const u8 = await api.readFile(e.path);
    if (vEntry !== e) return;
    const { geo, meta } = parseStl(u8);
    const mesh = new THREE.Mesh(geo, vr.material);
    vr.scene.add(mesh); vr.mesh = mesh;
    vr.material.wireframe = $('#vWire').classList.contains('on');
    const maxd = Math.max(meta.dx, meta.dy, meta.dz, 1e-3);
    const step = niceStep(maxd / 8);
    const half = Math.ceil((Math.max(meta.dx, meta.dy) * 1.6) / step / 2) * step;
    const divs = Math.max(2, Math.round((half * 2) / step));
    const grid = new THREE.GridHelper(half * 2, divs, 0x5a6a8f, 0x2a3144);
    grid.rotation.x = Math.PI / 2;
    grid.visible = $('#vGrid').classList.contains('on');
    vr.scene.add(grid); vr.grid = grid;
    const axes = new THREE.AxesHelper(maxd * 0.6);
    axes.visible = $('#vAxes').classList.contains('on');
    vr.scene.add(axes); vr.axes = axes;
    frame();
    $('#vDims').innerHTML = `<b>${meta.dx} × ${meta.dy} × ${meta.dz} mm</b> &nbsp;·&nbsp; grade a cada ${step} mm`;
    if (!e.meta || e.meta.error) { e.meta = meta; }
    updateViewerInfo();
  } catch (err) {
    $('#vDims').textContent = 'Não foi possível abrir este arquivo: ' + (err.message || err);
  }
}

function updateViewerInfo() {
  const e = vEntry && state.entries.get(vEntry.id);
  if (!e) return;
  vEntry = e;
  $('#vName').textContent = e.name;
  $('#vPath').textContent = e.dir;
  const m = e.meta && !e.meta.error ? e.meta : null;
  const rows = [
    ['Tamanho do arquivo', fmtSize(e.size)],
    m && ['Dimensões (mm)', `${m.dx} × ${m.dy} × ${m.dz}`],
    m && ['Triângulos', fmtNum(m.tris)],
    m && ['Volume', (m.vol / 1000).toFixed(2) + ' cm³'],
    ['Modificado', new Date(e.mtime).toLocaleDateString('pt-BR')],
  ].filter(Boolean);
  $('#vTable').innerHTML = rows.map(([a, b]) => `<tr><td class="muted">${a}</td><td>${b}</td></tr>`).join('');
  $('#vFav').textContent = e.fav ? '★ Favorito' : '☆ Favorito';
  $('#vTags').innerHTML = e.tags.map((t) => `<span class="tag-pill">#${esc(t)} <b data-rm="${esc(t)}">✕</b></span>`).join('') || '<span class="muted">sem tags</span>';
  const note = $('#vNote');
  if (document.activeElement !== note) note.value = e.note || '';
}

function openViewer(i) {
  const e = state.list[i];
  if (!e) return;
  vIndex = i; vEntry = e; viewerOpen = true;
  $('#viewer').hidden = false;
  updateViewerInfo();
  loadInViewer(e);
}
function closeViewer() {
  viewerOpen = false; vEntry = null;
  $('#viewer').hidden = true;
  if (vr) {
    cancelAnimationFrame(vr.raf);
    vr.ro.disconnect();
    if (vr.mesh) { vr.scene.remove(vr.mesh); vr.mesh.geometry.dispose(); }
    vr.renderer.dispose(); vr.renderer.forceContextLoss();
    vr.renderer.domElement.remove();
    vr = null;
  }
}
function stepViewer(d) {
  let i = vIndex + d;
  if (i < 0 || i >= state.list.length) return;
  openViewer(i);
  if (i >= state.shown - 5) appendPage();
}

$('#vClose').onclick = closeViewer;
$('#vPrev').onclick = () => stepViewer(-1);
$('#vNext').onclick = () => stepViewer(1);
$('#vReset').onclick = frame;
$('#vWire').onclick = (e) => { e.target.classList.toggle('on'); if (vr) vr.material.wireframe = e.target.classList.contains('on'); };
$('#vGrid').onclick = (e) => { e.target.classList.toggle('on'); if (vr && vr.grid) vr.grid.visible = e.target.classList.contains('on'); };
$('#vAxes').onclick = (e) => { e.target.classList.toggle('on'); if (vr && vr.axes) vr.axes.visible = e.target.classList.contains('on'); };
$('#vFav').onclick = () => vEntry && api.update(vEntry.id, { fav: !vEntry.fav });
$('#vShow').onclick = () => vEntry && api.showInFolder(vEntry.path);
$('#vRename').onclick = async () => {
  if (!vEntry) return;
  const base = vEntry.name.replace(/\.stl$/i, '');
  const n = await promptText('Renomear arquivo', 'novo nome', base);
  if (!n || n === base) return;
  const r = await api.rename(vEntry.id, n);
  if (r.error) await dialog({ title: 'Não deu', body: '<p>' + esc(r.error) + '</p>', cancel: null });
};
$('#vTagIn').addEventListener('keydown', async (ev) => {
  if (ev.key !== 'Enter' || !vEntry) return;
  const t = parseTags(ev.target.value);
  ev.target.value = '';
  if (t.length) await api.update(vEntry.id, { tags: [...new Set([...vEntry.tags, ...t])] });
});
$('#vTags').addEventListener('click', (ev) => {
  const t = ev.target.dataset.rm;
  if (t && vEntry) api.update(vEntry.id, { tags: vEntry.tags.filter((x) => x !== t) });
});
$('#vNote').addEventListener('input', debounce((ev) => { if (vEntry) api.update(vEntry.id, { note: ev.target.value }); }, 600));

document.addEventListener('keydown', (ev) => {
  if (!$('#dlg').hidden || !$('#dupPanel').hidden) return;
  const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
  if (viewerOpen) {
    if (ev.key === 'Escape') closeViewer();
    else if (!typing && ev.key === 'ArrowLeft') stepViewer(-1);
    else if (!typing && ev.key === 'ArrowRight') stepViewer(1);
    else if (!typing && ev.key.toLowerCase() === 'f') $('#vFav').click();
    return;
  }
  if (ev.key === 'Escape' && state.selected.size) { state.selected.clear(); renderSelbar(); }
  if (ev.ctrlKey && ev.key.toLowerCase() === 'a' && !typing) { ev.preventDefault(); state.list.forEach((e) => state.selected.add(e.id)); renderSelbar(); }
  if (ev.ctrlKey && ev.key.toLowerCase() === 'f') { ev.preventDefault(); $('#search').focus(); }
});

// gancho para teste automatizado
window.__test = {
  openFirst: () => openViewer(0),
  closeViewer,
  report: () => JSON.stringify({ entries: state.entries.size, list: state.list.length, withThumb: [...state.entries.values()].filter(hasThumb).length, errors: [...state.entries.values()].filter((e) => e.meta && e.meta.error).length, sample: state.list.slice(0, 3).map((e) => ({ n: e.name, m: e.meta })) }),
};

load();
