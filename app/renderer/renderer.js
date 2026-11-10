import { parseStl, makeMaterial, addLights, THREE } from './stl.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { loadScene, fitView, renderScene, NoPreview, LASER_LABEL } from './laser.js';

const $ = (s) => document.querySelector(s);
const api = window.api;

const state = {
  mode: (() => { try { return localStorage.getItem('mode') || 'stl'; } catch (_) { return 'stl'; } })(),
  roots: { stl: [], laser: [] }, entries: new Map(), thumbsDir: '',
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
const maxDim = (e) => (e.meta && !e.meta.error ? Math.max(e.meta.dx || 0, e.meta.dy || 0, e.meta.dz || 0) : 0);
const hasThumb = (e) => !!(e.meta && !e.meta.error && e.meta.thumb !== false);
const inMode = (e) => e.kind === state.mode;
const modeEntries = () => [...state.entries.values()].filter(inMode);

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
  let arr = modeEntries().filter((e) => {
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
  const none = modeEntries().length === 0;
  $('#empty').hidden = !none;
  const hasRoots = state.roots[state.mode].length > 0;
  $('#emptyTitle').textContent = hasRoots ? 'Nenhum arquivo encontrado nas pastas adicionadas' : (state.mode === 'laser' ? 'Vamos organizar seus arquivos de laser/CNC' : 'Vamos organizar essa pasta gigante');
  $('#emptyText').innerHTML = state.mode === 'laser'
    ? 'Clique em <b>＋ Adicionar pasta</b> e escolha onde estão seus arquivos de corte/gravação.<br>Lê SVG, DXF, AI, PDF, CDR (Corel), EPS, PLT, LightBurn (.lbrn), G-code e DWG.'
    : 'Clique em <b>＋ Adicionar pasta</b> e escolha a pasta onde estão seus arquivos STL.<br>O programa varre tudo (inclusive subpastas), gera miniaturas e deixa você buscar, marcar e mover.';
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
  const lbl = LASER_LABEL[e.ext] || (e.ext || '').toUpperCase();
  let dims;
  if (m && e.kind === 'laser') dims = m.dx != null ? `${Math.round(m.dx * 10) / 10}×${Math.round(m.dy * 10) / 10} mm` : lbl;
  else if (m) dims = `${Math.round(m.dx)}×${Math.round(m.dy)}×${Math.round(m.dz)} mm`;
  else dims = e.meta && e.meta.error ? 'não foi possível abrir' : 'processando…';
  const img = hasThumb(e) ? `<img loading="lazy" src="${thumbUrl(e)}">` : (e.meta && e.meta.error ? '⚠' : (e.meta ? `<b class="bigext">${esc(lbl)}</b>` : '…'));
  const badge = e.kind === 'laser' ? `<span class="badge">${esc(lbl)}</span>` : '';
  return `<div class="th">${img}</div>
    ${badge}<div class="nm" title="${esc(e.name)}">${esc(e.name)}</div>
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
  for (const e of modeEntries()) {
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
  for (const e of modeEntries()) if (!e.missing) for (const t of e.tags) m.set(t, (m.get(t) || 0) + 1);
  return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0], 'pt'));
}

function renderSidebar() {
  const arr = modeEntries();
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
  const p = await api.addRoot(state.mode);
  if (p) { setStatus('Procurando arquivos…', null); api.scan(state.mode, [p]); }
};
$('#btnRescan').onclick = () => { setStatus('Procurando arquivos…', null); api.scan(state.mode); };
$('#search').addEventListener('input', debounce((e) => { state.q = e.target.value; state.selected.clear(); refreshAll(); }, 160));
$('#sort').onchange = (e) => { state.sort = e.target.value; refreshAll(); };
$('#zoom').oninput = (e) => document.documentElement.style.setProperty('--card', e.target.value + 'px');

$('#btnMore').onclick = (ev) => { ev.stopPropagation(); $('#menuMore').hidden = !$('#menuMore').hidden; };
document.addEventListener('click', () => { $('#menuMore').hidden = true; });
$('#menuMore').addEventListener('click', async (ev) => {
  const m = ev.target.dataset.m;
  if (!m) return;
  if (m === 'csv') { const p = await api.exportCsv(state.mode); if (p) setStatus('Catálogo exportado: ' + p, 1); }
  if (m === 'regen') { api.thumbRegen(); setStatus('Tentando de novo…', 0); }
  if (m === 'clearMissing') { const n = await api.clearMissing(state.mode); setStatus(n + ' item(ns) ausente(s) removido(s) do catálogo', 1); }
  if (m === 'removeRoot') {
    const rl = state.roots[state.mode];
    if (!rl.length) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = '<p class="muted">Isso tira a pasta do catálogo (tags e notas dos arquivos dela serão perdidas). Os arquivos no disco NÃO são apagados.</p>';
    const sel = document.createElement('select'); sel.style.width = '100%';
    sel.innerHTML = rl.map((r) => `<option>${esc(r)}</option>`).join('');
    wrap.appendChild(sel);
    if (await dialog({ title: 'Remover pasta do catálogo', body: wrap, ok: 'Remover' })) { await api.removeRoot(state.mode, sel.value); state.folder = null; }
  }
});

// ------------------------------------------------------------ duplicados
let dupGroups = [];
$('#btnDup').onclick = async () => {
  setStatus('Procurando duplicados…', 0);
  $('#btnDup').disabled = true;
  dupGroups = await api.findDuplicates(state.mode);
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
let vr = null;  // visualizador 3D
let lv = null;  // visualizador 2D (laser)
let idleTimer = 0;

const VIEW_DIRS = {
  iso: [1, -1.25, 0.85],
  front: [0, -1, 0.0001],
  side: [1, 0, 0.0001],
  top: [0.0001, -0.0001, 1],
};

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
  controls.autoRotate = $('#vSpin').classList.contains('on');
  controls.autoRotateSpeed = 3;
  controls.addEventListener('start', () => { clearTimeout(idleTimer); controls.autoRotate = false; });
  controls.addEventListener('end', () => {
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => { if (vr && $('#vSpin').classList.contains('on')) vr.controls.autoRotate = true; }, 2500);
  });
  renderer.domElement.addEventListener('dblclick', () => frame());
  const material = makeMaterial();
  const ro = new ResizeObserver(() => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  });
  ro.observe(container);
  vr = { renderer, scene, camera, controls, material, mesh: null, grid: null, axes: null, ro, raf: 0 };
  const loop = () => { vr.raf = requestAnimationFrame(loop); vr.controls.update(); vr.renderer.render(vr.scene, vr.camera); };
  loop();
}

function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

function frame(dirName = 'iso') {
  if (!vr || !vr.mesh) return;
  const geo = vr.mesh.geometry;
  const r = geo.boundingSphere.radius || 1, c = geo.boundingSphere.center;
  const dist = (r / Math.sin((vr.camera.fov * Math.PI) / 360)) * 1.1;
  const dir = new THREE.Vector3(...VIEW_DIRS[dirName]).normalize();
  vr.camera.position.copy(c).addScaledVector(dir, dist);
  vr.camera.near = dist / 200; vr.camera.far = dist * 50;
  vr.camera.updateProjectionMatrix();
  vr.controls.target.copy(c);
  vr.controls.update();
}

function setMsg(text) {
  let m = $('#vMsg');
  if (!text) { if (m) m.remove(); return; }
  if (!m) { m = document.createElement('div'); m.id = 'vMsg'; $('#vStage').appendChild(m); }
  m.textContent = text;
}

function disposeStlViewer() {
  if (!vr) return;
  cancelAnimationFrame(vr.raf);
  clearTimeout(idleTimer);
  vr.ro.disconnect();
  if (vr.mesh) { vr.scene.remove(vr.mesh); vr.mesh.geometry.dispose(); }
  vr.renderer.dispose(); vr.renderer.forceContextLoss();
  vr.renderer.domElement.remove();
  vr = null;
}
function disposeLaserViewer() {
  if (!lv) return;
  lv.ro.disconnect();
  lv.canvas.remove();
  $('#vCanvas').classList.remove('laser');
  lv = null;
}

async function loadInViewer(e) {
  disposeLaserViewer();
  setMsg(null);
  initViewer();
  $('#vDims').textContent = 'Carregando…';
  if (vr.mesh) { vr.scene.remove(vr.mesh); vr.mesh.geometry.dispose(); vr.mesh = null; }
  if (vr.grid) { vr.scene.remove(vr.grid); vr.grid = null; }
  if (vr.axes) { vr.scene.remove(vr.axes); vr.axes = null; }
  try {
    const u8 = await api.readFile(e.path);
    if (vEntry !== e || !vr) return;
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

// ---- visualizador 2D (laser/CNC)
function initLaserViewer() {
  if (lv) return;
  const container = $('#vCanvas');
  container.classList.add('laser');
  const canvas = document.createElement('canvas');
  canvas.style.width = '100%'; canvas.style.height = '100%'; canvas.style.display = 'block';
  container.appendChild(canvas);
  lv = { canvas, ctx: canvas.getContext('2d'), scene: null, view: null, W: 0, H: 0, dark: false, raf: 0, drag: null };
  const draw = () => {
    lv.raf = 0;
    if (!lv.scene || !lv.view) return;
    const dpr = window.devicePixelRatio || 1;
    lv.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    renderScene(lv.ctx, lv.scene, lv.W, lv.H, lv.view, lv.dark ? { bg: '#14171e', line: '#8fb4ff', lw: 1.2 } : { bg: '#f1f3f7', lw: 1.3 });
    const { w } = lv.scene.type === 'image' ? { w: lv.scene.w } : { w: lv.scene.bounds.maxx - lv.scene.bounds.minx };
    const fit = fitView(lv.scene, lv.W, lv.H);
    $('#vHint').textContent = `Zoom ${Math.round((lv.view.scale / fit.scale) * 100)}% · arraste para mover · roda para zoom · duplo clique para ajustar`;
  };
  lv.draw = () => { if (!lv.raf) lv.raf = requestAnimationFrame(draw); };
  lv.fit = () => { if (lv.scene) { lv.view = fitView(lv.scene, lv.W, lv.H, 24); lv.draw(); } };
  lv.ro = new ResizeObserver(() => {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    lv.W = w; lv.H = h;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    if (lv.scene && !lv.view) lv.fit(); else lv.draw();
  });
  lv.ro.observe(container);
  canvas.addEventListener('wheel', (ev) => {
    if (!lv.scene || !lv.view) return;
    ev.preventDefault();
    const r = canvas.getBoundingClientRect();
    const px = ev.clientX - r.left, py = ev.clientY - r.top;
    const flip = lv.scene.type === 'paths' ? -1 : 1;
    const v = lv.view;
    const sx = v.cx + (px - lv.W / 2) / v.scale, sy = v.cy + flip * (py - lv.H / 2) / v.scale;
    const k = Math.exp(-ev.deltaY * 0.0015);
    v.scale = Math.min(Math.max(v.scale * k, 1e-6), 1e7);
    v.cx = sx - (px - lv.W / 2) / v.scale;
    v.cy = sy - flip * (py - lv.H / 2) / v.scale;
    lv.draw();
  }, { passive: false });
  canvas.addEventListener('pointerdown', (ev) => { canvas.setPointerCapture(ev.pointerId); lv.drag = { x: ev.clientX, y: ev.clientY }; });
  canvas.addEventListener('pointermove', (ev) => {
    if (!lv.drag || !lv.view) return;
    const dx = ev.clientX - lv.drag.x, dy = ev.clientY - lv.drag.y;
    lv.drag = { x: ev.clientX, y: ev.clientY };
    lv.view.cx -= dx / lv.view.scale;
    lv.view.cy += (lv.scene.type === 'paths' ? 1 : -1) * dy / lv.view.scale;
    lv.draw();
  });
  canvas.addEventListener('pointerup', () => { lv.drag = null; });
  canvas.addEventListener('dblclick', () => lv.fit());
}

async function loadInLaserViewer(e) {
  disposeStlViewer();
  setMsg(null);
  initLaserViewer();
  lv.scene = null; lv.view = null;
  $('#vDims').textContent = 'Carregando…';
  $('#vHint').textContent = '';
  lv.ctx.setTransform(1, 0, 0, 1, 0, 0); lv.ctx.clearRect(0, 0, lv.canvas.width, lv.canvas.height);
  try {
    const scene = await loadScene(e, { maxSide: 2600 });
    if (vEntry !== e || !lv) return;
    lv.scene = scene;
    lv.fit();
    const d = scene.wMM != null ? `<b>${(+scene.wMM).toFixed(1)} × ${(+scene.hMM).toFixed(1)} mm</b>` : '<b>tamanho desconhecido</b>';
    $('#vDims').innerHTML = d + (scene.pages > 1 ? ` &nbsp;·&nbsp; página 1 de ${scene.pages}` : '') + (scene.count ? ` &nbsp;·&nbsp; ${fmtNum(scene.count)} trajetos` : '');
    if (scene.wMM != null && (!e.meta || e.meta.dx == null)) { e.meta = { ...(e.meta || {}), laser: true, ext: e.ext, dx: scene.wMM, dy: scene.hMM }; }
    updateViewerInfo();
  } catch (err) {
    $('#vDims').textContent = '';
    const lbl = LASER_LABEL[e.ext] || e.ext;
    setMsg(err instanceof NoPreview
      ? `Este formato (${lbl}) não tem pré-visualização aqui.\nUse “Abrir no programa” para ver no CorelDRAW, LightBurn, AutoCAD…`
      : 'Não foi possível abrir este arquivo: ' + (err.message || err));
  }
}

function updateViewerInfo() {
  const e = vEntry && state.entries.get(vEntry.id);
  if (!e) return;
  vEntry = e;
  $('#vName').textContent = e.name;
  $('#vPath').textContent = e.dir;
  const m = e.meta && !e.meta.error ? e.meta : null;
  const laser = e.kind === 'laser';
  const rows = laser ? [
    ['Tipo', LASER_LABEL[e.ext] || (e.ext || '').toUpperCase()],
    ['Tamanho do arquivo', fmtSize(e.size)],
    m && m.dx != null && ['Dimensões (mm)', `${(+m.dx).toFixed(1)} × ${(+m.dy).toFixed(1)}`],
    ['Modificado', new Date(e.mtime).toLocaleDateString('pt-BR')],
  ] : [
    ['Tamanho do arquivo', fmtSize(e.size)],
    m && ['Dimensões (mm)', `${m.dx} × ${m.dy} × ${m.dz}`],
    m && ['Triângulos', fmtNum(m.tris)],
    m && ['Volume', (m.vol / 1000).toFixed(2) + ' cm³'],
    ['Modificado', new Date(e.mtime).toLocaleDateString('pt-BR')],
  ];
  $('#vTable').innerHTML = rows.filter(Boolean).map(([a, b]) => `<tr><td class="muted">${a}</td><td>${b}</td></tr>`).join('');
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
  const laser = e.kind === 'laser';
  $('#vTools').hidden = laser;
  $('#lTools').hidden = !laser;
  $('#vHint').textContent = laser ? '' : 'Arraste: girar · Roda: zoom · Botão direito: mover · Duplo clique: recentrar';
  updateViewerInfo();
  if (laser) loadInLaserViewer(e); else loadInViewer(e);
}
function closeViewer() {
  viewerOpen = false; vEntry = null;
  $('#viewer').hidden = true;
  disposeStlViewer();
  disposeLaserViewer();
  setMsg(null);
}
function stepViewer(d) {
  let i = vIndex + d;
  if (i < 0 || i >= state.list.length) return;
  if (i >= state.shown - 5) appendPage();
  openViewer(i);
}

$('#vClose').onclick = closeViewer;
$('#vPrev').onclick = () => stepViewer(-1);
$('#vNext').onclick = () => stepViewer(1);
$('#vReset').onclick = () => frame();
$('#lFit').onclick = () => lv && lv.fit();
$('#lBg').onclick = (e) => { if (!lv) return; lv.dark = !lv.dark; e.target.textContent = lv.dark ? 'Fundo claro' : 'Fundo escuro'; lv.draw(); };
$('#vSpin').onclick = (e) => {
  e.target.classList.toggle('on');
  if (vr) vr.controls.autoRotate = e.target.classList.contains('on');
};
document.querySelectorAll('#vTools [data-view]').forEach((b) => { b.onclick = () => frame(b.dataset.view); });
$('#vWire').onclick = (e) => { e.target.classList.toggle('on'); if (vr) vr.material.wireframe = e.target.classList.contains('on'); };
$('#vGrid').onclick = (e) => { e.target.classList.toggle('on'); if (vr && vr.grid) vr.grid.visible = e.target.classList.contains('on'); };
$('#vAxes').onclick = (e) => { e.target.classList.toggle('on'); if (vr && vr.axes) vr.axes.visible = e.target.classList.contains('on'); };
$('#vFav').onclick = () => vEntry && api.update(vEntry.id, { fav: !vEntry.fav });
$('#vShow').onclick = () => vEntry && api.showInFolder(vEntry.path);
$('#vOpen').onclick = () => vEntry && api.openFile(vEntry.path);
$('#vRename').onclick = async () => {
  if (!vEntry) return;
  const dot = vEntry.name.lastIndexOf('.');
  const base = dot > 0 ? vEntry.name.slice(0, dot) : vEntry.name;
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
    else if (!typing && vr && ev.key === ' ') { ev.preventDefault(); $('#vSpin').click(); }
    else if (!typing && vr && ['1', '2', '3', '4'].includes(ev.key)) frame(['iso', 'front', 'side', 'top'][+ev.key - 1]);
    else if (!typing && vr && ev.key.toLowerCase() === 'w') $('#vWire').click();
    return;
  }
  if (ev.key === 'Escape' && state.selected.size) { state.selected.clear(); renderSelbar(); }
  if (ev.ctrlKey && ev.key.toLowerCase() === 'a' && !typing) { ev.preventDefault(); state.list.forEach((e) => state.selected.add(e.id)); renderSelbar(); }
  if (ev.ctrlKey && ev.key.toLowerCase() === 'f') { ev.preventDefault(); $('#search').focus(); }
});

// ------------------------------------------------------------ giro ao passar o mouse (3D)
const hover = { timer: 0, card: null, r: null, cache: new Map(), raf: 0, token: 0 };

function stopHover() {
  clearTimeout(hover.timer);
  hover.token++;
  cancelAnimationFrame(hover.raf);
  if (hover.r) hover.r.renderer.domElement.remove();
  hover.card = null;
}

async function startHover(card) {
  const e = state.entries.get(card.dataset.id);
  if (!e || e.kind !== 'stl' || e.missing || e.size > 80 * 1048576 || !hasThumb(e)) return;
  const th = card.querySelector('.th');
  if (!th) return;
  const token = ++hover.token;
  hover.card = card;
  let geo = hover.cache.get(e.id);
  if (!geo) {
    try {
      const u8 = await api.readFile(e.path);
      if (token !== hover.token) return;
      geo = parseStl(u8).geo;
    } catch (_) { return; }
    hover.cache.set(e.id, geo);
    if (hover.cache.size > 6) { const k = hover.cache.keys().next().value; hover.cache.get(k).dispose(); hover.cache.delete(k); }
  }
  if (token !== hover.token) return;
  if (!hover.r) {
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setClearColor(0x1d212b, 1);
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 1e6);
    camera.up.set(0, 0, 1);
    addLights(scene, camera);
    hover.r = { renderer, scene, camera, material: makeMaterial(), mesh: null };
  }
  const R = hover.r;
  if (R.mesh) R.scene.remove(R.mesh);
  R.mesh = new THREE.Mesh(geo, R.material);
  R.scene.add(R.mesh);
  const sz = Math.max(120, Math.round(th.clientWidth));
  R.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  R.renderer.setSize(sz, sz, false);
  R.renderer.domElement.className = 'spin';
  th.appendChild(R.renderer.domElement);
  const rad = geo.boundingSphere.radius || 1, c = geo.boundingSphere.center;
  const dist = rad / Math.sin((R.camera.fov * Math.PI) / 360) * 1.05;
  const t0 = performance.now();
  const loop = () => {
    if (token !== hover.token) return;
    const a = -0.9 + ((performance.now() - t0) / 1000) * 1.1;
    const el = 0.62;
    R.camera.position.set(c.x + dist * Math.cos(el) * Math.sin(a), c.y - dist * Math.cos(el) * Math.cos(a), c.z + dist * Math.sin(el));
    R.camera.near = dist / 100; R.camera.far = dist * 10;
    R.camera.updateProjectionMatrix();
    R.camera.lookAt(c);
    R.renderer.render(R.scene, R.camera);
    hover.raf = requestAnimationFrame(loop);
  };
  loop();
}

$('#grid').addEventListener('mouseover', (ev) => {
  const card = ev.target.closest('.card');
  if (!card || card === hover.card || state.mode !== 'stl') return;
  stopHover();
  hover.card = card;
  hover.timer = setTimeout(() => startHover(card), 450);
});
$('#grid').addEventListener('mouseleave', stopHover);
$('#grid').addEventListener('mouseout', (ev) => {
  const card = ev.target.closest('.card');
  if (card && !card.contains(ev.relatedTarget)) stopHover();
});
$('#content').addEventListener('scroll', stopHover, { passive: true });

// ------------------------------------------------------------ abas
function setMode(m, silent) {
  if (viewerOpen) closeViewer();
  stopHover();
  state.mode = m;
  try { localStorage.setItem('mode', m); } catch (_) {}
  state.view = 'all'; state.folder = null; state.tag = null; state.dupFilter = null; state.q = ''; state.selected.clear();
  $('#search').value = '';
  document.querySelectorAll('#tabs .tab').forEach((t) => t.classList.toggle('on', t.dataset.mode === m));
  document.title = m === 'laser' ? 'Catálogo — Laser / CNC' : 'Catálogo — 3D (STL)';
  if (!silent) refreshAll();
}
document.querySelectorAll('#tabs .tab').forEach((t) => { t.onclick = () => setMode(t.dataset.mode); });

// gancho para teste automatizado
window.__test = {
  setMode,
  openFirst: () => openViewer(0),
  openIndex: (i) => openViewer(i),
  closeViewer,
  hoverFirst: () => { const c = document.querySelector('.card'); if (c) { stopHover(); startHover(c); } },
  report: () => JSON.stringify({ spinCanvas: document.querySelectorAll('canvas.spin').length, mode: state.mode, entries: state.entries.size, list: state.list.length, withThumb: modeEntries().filter(hasThumb).length, errors: modeEntries().filter((e) => e.meta && e.meta.error).length, items: state.list.map((e) => ({ n: e.name, m: e.meta })) }),
};

setMode(state.mode, true);
load();
