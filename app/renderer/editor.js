// Editor 3D do Catálogo STL
import * as THREE from '../vendor/three.module.js';
import { OrbitControls } from '../vendor/OrbitControls.js';
import { TransformControls } from '../vendor/TransformControls.js';
import { STLLoader } from '../vendor/STLLoader.js';
import * as M from './meshops.js';

let ctx = null;        // { api, dialog, promptText, setStatus, fmtNum, esc, onClosed }
let root = null;
const $ = (s) => root.querySelector(s);
const $$ = (s) => [...root.querySelectorAll(s)];

const E = {
  open: false, entry: null, mesh: null, history: [], future: [], dirty: false, changed: false,
  renderer: null, scene: null, camera: null, controls: null, tc: null, raf: 0, ro: null,
  meshObj: null, grid: null, plane: null, tool: null, tab: 'transform', pickFace: false, material: null,
};

const HTML = `
<div id="edTop">
  <b id="edTitle"></b><span id="edDirty" class="muted"></span>
  <button id="edUndo" title="Ctrl+Z">↶ Desfazer</button>
  <button id="edRedo" title="Ctrl+Y">↷ Refazer</button>
  <span class="sp"></span>
  <button id="edSaveNew" class="primary">Salvar como novo arquivo</button>
  <button id="edSaveOver">Sobrescrever original</button>
  <button id="edClose">Fechar</button>
</div>
<div id="edBody">
  <aside id="edPanel">
    <div id="edTabs">
      <button data-tab="transform" class="on">Transformar</button>
      <button data-tab="cut">Cortar</button>
      <button data-tab="repair">Reparar</button>
      <button data-tab="join">Juntar / Furar</button>
    </div>

    <div class="edPage" data-page="transform">
      <h4>Tamanho (mm)</h4>
      <div class="grid3">
        <label>X<input type="number" step="any" id="edDimX"></label>
        <label>Y<input type="number" step="any" id="edDimY"></label>
        <label>Z<input type="number" step="any" id="edDimZ"></label>
      </div>
      <label class="chk"><input type="checkbox" id="edLock" checked> Manter proporção</label>
      <div class="row"><button id="edApplyDim">Aplicar tamanho</button>
        <span class="muted">ou escala</span><input type="number" id="edPct" value="100" step="any" style="width:72px"> %<button id="edApplyPct">Aplicar</button></div>

      <h4>Girar</h4>
      <div class="row">
        <span class="lbl">X</span><button data-rot="x,-90">−90°</button><button data-rot="x,90">+90°</button>
        <span class="lbl">Y</span><button data-rot="y,-90">−90°</button><button data-rot="y,90">+90°</button>
        <span class="lbl">Z</span><button data-rot="z,-90">−90°</button><button data-rot="z,90">+90°</button>
      </div>
      <div class="row"><select id="edRotAxis"><option value="z">eixo Z</option><option value="x">eixo X</option><option value="y">eixo Y</option></select>
        <input type="number" id="edRotDeg" value="15" step="any" style="width:72px">°<button id="edRotApply">Girar</button></div>
      <label class="chk"><input type="checkbox" id="edAutoDrop" checked> Assentar na base depois de girar</label>

      <h4>Espelhar</h4>
      <div class="row"><button data-mir="x">Espelhar X</button><button data-mir="y">Espelhar Y</button><button data-mir="z">Espelhar Z</button></div>

      <h4>Posição</h4>
      <div class="row"><button id="edDrop">Assentar na base (Z=0)</button><button id="edCenter">Centralizar (X/Y)</button></div>
      <div class="row"><button id="edFace">Deitar numa face…</button></div>
      <p class="muted small" id="edFaceHint" hidden>Clique na face do modelo que deve ficar virada para baixo.</p>
    </div>

    <div class="edPage" data-page="cut" hidden>
      <h4>Plano de corte</h4>
      <div class="row"><select id="edCutAxis"><option value="2">Horizontal (altura, eixo Z)</option><option value="0">Vertical — eixo X</option><option value="1">Vertical — eixo Y</option></select></div>
      <input type="range" id="edCutRange" style="width:100%" step="any">
      <div class="row"><input type="number" id="edCutPos" step="any" style="width:100px"> mm <span class="muted" id="edCutHint"></span></div>

      <h4>Encaixe para colar depois</h4>
      <label class="chk"><input type="checkbox" id="edPins"> Adicionar pinos e furos de encaixe</label>
      <div class="grid3">
        <label>Pinos<select id="edPinN"><option>1</option><option selected>2</option><option>3</option><option>4</option></select></label>
        <label>Diâmetro<input type="number" id="edPinD" value="4" step="any"></label>
        <label>Altura<input type="number" id="edPinH" value="5" step="any"></label>
      </div>
      <label class="chk">Folga do furo (mm) <input type="number" id="edPinGap" value="0.25" step="0.05" style="width:70px"></label>

      <h4>Cortar</h4>
      <div class="col">
        <button id="edCutSplit" class="primary">Dividir em 2 arquivos novos</button>
        <button id="edCutKeepA">Ficar só com a parte de cima / maior valor</button>
        <button id="edCutKeepB">Ficar só com a parte de baixo / menor valor</button>
      </div>
    </div>

    <div class="edPage" data-page="repair" hidden>
      <h4>Diagnóstico</h4>
      <div class="row"><button id="edAnalyze">Analisar malha</button></div>
      <pre id="edReport" class="report">Clique em “Analisar malha”.</pre>

      <h4>Consertar</h4>
      <div class="col">
        <button id="edRepairAll" class="primary">Reparar tudo automaticamente</button>
        <button id="edClean">Limpar (soldar vértices, remover triângulos vazios)</button>
        <button id="edOrient">Corrigir normais invertidas</button>
        <button id="edFill">Fechar furos</button>
        <div class="row"><button id="edShells">Remover pedaços soltos menores que</button><input type="number" id="edShellPct" value="2" step="any" style="width:60px">%</div>
      </div>

      <h4>Simplificar (arquivo mais leve)</h4>
      <div class="row"><input type="range" id="edDecRange" min="5" max="95" value="50" style="flex:1"><b id="edDecVal">50%</b></div>
      <label class="chk"><input type="checkbox" id="edDecLock" checked> Preservar bordas</label>
      <div class="row"><button id="edDecimate">Simplificar</button><span class="muted small">mantém a % dos triângulos</span></div>
    </div>

    <div class="edPage" data-page="join" hidden>
      <h4>Objeto para unir ou subtrair</h4>
      <div class="row wrap">
        <button data-tool="box">Cubo</button><button data-tool="cyl">Cilindro</button><button data-tool="sph">Esfera</button><button data-tool="cone">Cone</button>
        <button data-tool="base">Base / placa</button><button data-tool="stl">Outro STL…</button>
      </div>
      <div class="row"><input type="text" id="edText" placeholder="Texto" style="flex:1"><button id="edTextMake">Criar texto</button></div>
      <div class="grid3">
        <label>Altura da letra<input type="number" id="edTextH" value="8" step="any"></label>
        <label>Espessura<input type="number" id="edTextT" value="1.2" step="any"></label>
        <label class="chk" style="margin-top:18px"><input type="checkbox" id="edTextBold" checked> Negrito</label>
      </div>

      <div id="edToolBox" hidden>
        <h4>Posição e tamanho do objeto (mm)</h4>
        <div class="grid3">
          <label>Pos X<input type="number" step="any" id="edTpx"></label>
          <label>Pos Y<input type="number" step="any" id="edTpy"></label>
          <label>Pos Z<input type="number" step="any" id="edTpz"></label>
          <label>Larg. X<input type="number" step="any" id="edTsx"></label>
          <label>Prof. Y<input type="number" step="any" id="edTsy"></label>
          <label>Alt. Z<input type="number" step="any" id="edTsz"></label>
        </div>
        <div class="row"><span class="muted">Arrastar:</span>
          <button data-tcmode="translate" class="on">Mover</button><button data-tcmode="rotate">Girar</button><button data-tcmode="scale">Escalar</button></div>
        <div class="col">
          <button id="edOpAdd" class="primary">Unir ao modelo</button>
          <button id="edOpSub">Subtrair do modelo (furar / gravar)</button>
          <button id="edOpInt">Manter só a interseção</button>
          <button id="edOpDrop">Descartar objeto</button>
        </div>
      </div>
      <p class="muted small">Dica: para furar, posicione o objeto atravessando a peça e use “Subtrair”. Se o resultado ficar estranho, rode “Reparar tudo” na aba Reparar antes.</p>
    </div>
  </aside>

  <div id="edStage">
    <div id="edCanvas"></div>
    <div id="edInfo"></div>
    <div id="edViews"><button data-v="iso">Iso</button><button data-v="front">Frente</button><button data-v="side">Lado</button><button data-v="top">Topo</button><button id="edWire">Malha</button></div>
    <div id="edBusy" hidden><div class="spin"></div><span id="edBusyTxt">Processando…</span></div>
  </div>
</div>`;

export function initEditor(c) {
  ctx = c;
  root = document.getElementById('editor');
  root.innerHTML = HTML;
  wire();
}

// ------------------------------------------------------------ utilitários
const fmt = (n, d = 2) => (Number.isFinite(n) ? Number(n).toLocaleString('pt-BR', { maximumFractionDigits: d }) : '—');
const dimsOf = () => M.bbox(E.mesh);

async function busy(text, fn) {
  $('#edBusyTxt').textContent = text;
  $('#edBusy').hidden = false;
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  try {
    return await fn();
  } catch (err) {
    console.error(err);
    await ctx.dialog({ title: 'Não deu certo', body: '<p>' + ctx.esc(err && err.message ? err.message : String(err)) + '</p>', cancel: null });
  } finally {
    $('#edBusy').hidden = true;
  }
}

function setMesh(mesh, opts = {}) {
  if (opts.push !== false && E.mesh) {
    E.history.push(E.mesh);
    if (E.history.length > 15) E.history.shift();
    E.future = [];
    E.dirty = true; E.changed = true;
  }
  E.mesh = mesh;
  rebuildDisplay();
  updateInfo();
  updateButtons();
}

function updateButtons() {
  $('#edUndo').disabled = !E.history.length;
  $('#edRedo').disabled = !E.future.length;
  $('#edDirty').textContent = E.dirty ? '  • alterado' : '';
}

function updateInfo() {
  const b = dimsOf();
  $('#edInfo').innerHTML = `<b>${fmt(b.size[0], 1)} × ${fmt(b.size[1], 1)} × ${fmt(b.size[2], 1)} mm</b> &nbsp;·&nbsp; ${ctx.fmtNum(E.mesh.idx.length / 3)} triângulos &nbsp;·&nbsp; ${fmt(Math.abs(M.volume(E.mesh)) / 1000, 2)} cm³`;
  $('#edDimX').value = +b.size[0].toFixed(3);
  $('#edDimY').value = +b.size[1].toFixed(3);
  $('#edDimZ').value = +b.size[2].toFixed(3);
  updateCutRange();
}

// ------------------------------------------------------------ cena
function initScene() {
  const holder = $('#edCanvas');
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(0x14171e, 1);
  holder.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 1e6);
  camera.up.set(0, 0, 1);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 0.9));
  const dl = new THREE.DirectionalLight(0xffffff, 1.6);
  dl.position.set(1, 1.5, 2);
  camera.add(dl);
  scene.add(camera);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  const tc = new TransformControls(camera, renderer.domElement);
  tc.addEventListener('dragging-changed', (ev) => { controls.enabled = !ev.value; });
  tc.addEventListener('objectChange', syncToolFields);
  scene.add(tc.getHelper ? tc.getHelper() : tc);
  const ro = new ResizeObserver(() => {
    const w = holder.clientWidth, h = holder.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h; camera.updateProjectionMatrix();
  });
  ro.observe(holder);
  E.material = new THREE.MeshStandardMaterial({ color: 0xaab8d4, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 });
  Object.assign(E, { renderer, scene, camera, controls, tc, ro });
  const loop = () => { E.raf = requestAnimationFrame(loop); controls.update(); renderer.render(scene, camera); };
  loop();

  // clique para escolher face
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!E.pickFace || !down) return;
    if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
    const r = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObject(E.meshObj, false)[0];
    if (hit && hit.faceIndex != null) faceDown(hit.faceIndex);
  });
}

function disposeScene() {
  cancelAnimationFrame(E.raf);
  if (E.ro) E.ro.disconnect();
  if (E.tc) E.tc.dispose();
  if (E.controls) E.controls.dispose();
  if (E.meshObj) E.meshObj.geometry.dispose();
  clearTool(true);
  if (E.renderer) { E.renderer.dispose(); E.renderer.forceContextLoss(); E.renderer.domElement.remove(); }
  Object.assign(E, { renderer: null, scene: null, camera: null, controls: null, tc: null, meshObj: null, grid: null, plane: null, ro: null });
}

function rebuildDisplay() {
  const soup = M.toSoup(E.mesh);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(soup, 3));
  geo.computeVertexNormals();
  if (E.meshObj) { E.meshObj.geometry.dispose(); E.meshObj.geometry = geo; }
  else { E.meshObj = new THREE.Mesh(geo, E.material); E.scene.add(E.meshObj); }
  // grade na base (Z=0)
  if (E.grid) { E.scene.remove(E.grid); E.grid.geometry.dispose(); }
  const b = dimsOf();
  const maxd = Math.max(b.size[0], b.size[1], b.size[2], 1e-3);
  const step = niceStep(maxd / 8);
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
  const half = Math.ceil((Math.max(maxd, Math.abs(cx), Math.abs(cy)) * 1.8) / step) * step;
  const grid = new THREE.GridHelper(half * 2, Math.max(2, Math.round((half * 2) / step)), 0x5a6a8f, 0x2a3144);
  grid.rotation.x = Math.PI / 2;
  grid.position.set(Math.round(cx / step) * step, Math.round(cy / step) * step, 0);
  E.scene.add(grid); E.grid = grid;
  updatePlane();
}

function niceStep(x) {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const f = x / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

const VIEW_DIRS = { iso: [1, -1.25, 0.85], front: [0, -1, 0.0001], side: [1, 0, 0.0001], top: [0.0001, -0.0001, 1] };
function frame(name = 'iso') {
  if (!E.mesh) return;
  const b = dimsOf();
  const c = new THREE.Vector3((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2);
  const r = Math.hypot(b.size[0], b.size[1], b.size[2]) / 2 || 1;
  const dist = (r / Math.sin((E.camera.fov * Math.PI) / 360)) * 1.15;
  const dir = new THREE.Vector3(...VIEW_DIRS[name]).normalize();
  E.camera.position.copy(c).addScaledVector(dir, dist);
  E.camera.near = dist / 300; E.camera.far = dist * 60;
  E.camera.updateProjectionMatrix();
  E.controls.target.copy(c);
  E.controls.update();
}

// ------------------------------------------------------------ transformar
function mutate(fn) {
  const pos = E.mesh.pos.slice();
  fn(pos);
  setMesh({ pos, idx: E.mesh.idx });
}

function dropToBed(mesh) {
  const b = M.bbox(mesh);
  const pos = mesh.pos.slice();
  for (let i = 2; i < pos.length; i += 3) pos[i] -= b.min[2];
  return { pos, idx: mesh.idx };
}

function scaleTo(fx, fy, fz) {
  if (!(fx > 0 && fy > 0 && fz > 0)) return;
  const b = dimsOf();
  const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2, z0 = b.min[2];
  mutate((p) => {
    for (let i = 0; i < p.length; i += 3) {
      p[i] = cx + (p[i] - cx) * fx; p[i + 1] = cy + (p[i + 1] - cy) * fy; p[i + 2] = z0 + (p[i + 2] - z0) * fz;
    }
  });
}

function rotate(axis, deg, drop = true) {
  const b = dimsOf();
  const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const ax = new THREE.Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0);
  const e = new THREE.Matrix4().makeRotationAxis(ax, (deg * Math.PI) / 180).elements;
  const pos = E.mesh.pos.slice();
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i] - c[0], y = pos[i + 1] - c[1], z = pos[i + 2] - c[2];
    pos[i] = e[0] * x + e[4] * y + e[8] * z + c[0];
    pos[i + 1] = e[1] * x + e[5] * y + e[9] * z + c[1];
    pos[i + 2] = e[2] * x + e[6] * y + e[10] * z + c[2];
  }
  let m = { pos, idx: E.mesh.idx };
  if (drop) m = dropToBed(m);
  setMesh(m);
}

function mirror(axis) {
  const k = { x: 0, y: 1, z: 2 }[axis];
  const b = dimsOf();
  const c = (b.min[k] + b.max[k]) / 2;
  const pos = E.mesh.pos.slice();
  for (let i = k; i < pos.length; i += 3) pos[i] = 2 * c - pos[i];
  const idx = E.mesh.idx.slice();
  for (let t = 0; t < idx.length; t += 3) { const x = idx[t + 1]; idx[t + 1] = idx[t + 2]; idx[t + 2] = x; }
  setMesh({ pos, idx });
}

function faceDown(tri) {
  const I = E.mesh.idx, p = E.mesh.pos;
  const a = I[tri * 3] * 3, b = I[tri * 3 + 1] * 3, c = I[tri * 3 + 2] * 3;
  const u = new THREE.Vector3(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
  const v = new THREE.Vector3(p[c] - p[a], p[c + 1] - p[a + 1], p[c + 2] - p[a + 2]);
  const n = u.cross(v).normalize();
  if (!Number.isFinite(n.x)) return;
  const q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 0, -1));
  const bb = dimsOf();
  const cc = [(bb.min[0] + bb.max[0]) / 2, (bb.min[1] + bb.max[1]) / 2, (bb.min[2] + bb.max[2]) / 2];
  const e = new THREE.Matrix4().makeRotationFromQuaternion(q).elements;
  const pos = p.slice();
  for (let i = 0; i < pos.length; i += 3) {
    const x = pos[i] - cc[0], y = pos[i + 1] - cc[1], z = pos[i + 2] - cc[2];
    pos[i] = e[0] * x + e[4] * y + e[8] * z + cc[0];
    pos[i + 1] = e[1] * x + e[5] * y + e[9] * z + cc[1];
    pos[i + 2] = e[2] * x + e[6] * y + e[10] * z + cc[2];
  }
  setMesh(dropToBed({ pos, idx: E.mesh.idx }));
  setPickFace(false);
}

function setPickFace(on) {
  E.pickFace = on;
  $('#edFace').classList.toggle('on', on);
  $('#edFaceHint').hidden = !on;
  if (E.renderer) E.renderer.domElement.style.cursor = on ? 'crosshair' : '';
}

// ------------------------------------------------------------ cortar
function cutAxis() { return +$('#edCutAxis').value; }
function updateCutRange() {
  if (!E.mesh) return;
  const b = dimsOf(), k = cutAxis();
  const r = $('#edCutRange');
  const lo = b.min[k], hi = b.max[k];
  const prev = parseFloat($('#edCutPos').value);
  r.min = lo; r.max = hi; r.step = Math.max((hi - lo) / 1000, 1e-4);
  const v = Number.isFinite(prev) && prev > lo && prev < hi ? prev : (lo + hi) / 2;
  r.value = v; $('#edCutPos').value = +v.toFixed(3);
  $('#edCutHint').textContent = `(de ${fmt(lo, 1)} a ${fmt(hi, 1)})`;
  updatePlane();
}

function updatePlane() {
  if (!E.scene) return;
  if (E.plane) { E.scene.remove(E.plane); E.plane.geometry.dispose(); E.plane = null; }
  if (E.tab !== 'cut' || !E.mesh) return;
  const b = dimsOf(), k = cutAxis(), d = parseFloat($('#edCutPos').value);
  if (!Number.isFinite(d)) return;
  const sz = Math.max(...b.size) * 1.3;
  const g = new THREE.PlaneGeometry(sz, sz);
  const mat = new THREE.MeshBasicMaterial({ color: 0x39c5ff, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthWrite: false });
  const m = new THREE.Mesh(g, mat);
  const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  if (k === 0) m.rotation.y = Math.PI / 2;
  if (k === 1) m.rotation.x = Math.PI / 2;
  m.position.set(c[0], c[1], c[2]);
  m.position.setComponent(k, d);
  E.scene.add(m); E.plane = m;
}

function cylGeo(r, len, axis, center) {
  const g = new THREE.CylinderGeometry(r, r, len, 40);
  if (axis === 2) g.rotateX(Math.PI / 2);
  else if (axis === 0) g.rotateZ(Math.PI / 2);
  g.translate(center[0], center[1], center[2]);
  return g;
}

async function loadCsg() {
  if (!E.csg) E.csg = await import('../vendor/csg.js');
  return E.csg;
}

function geoFromMesh(m) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(m.pos.slice(), 3));
  g.setIndex(new THREE.BufferAttribute(m.idx.slice(), 1));
  g.computeVertexNormals();
  return g;
}

function soupOfGeometry(g) {
  const ng = g.index ? g.toNonIndexed() : g;
  return Float32Array.from(ng.attributes.position.array);
}

async function booleanOp(meshA, geoB, op) {
  const { Brush, Evaluator } = await loadCsg();
  let a = M.orientFix(meshA).mesh;
  let b = M.healAfterBoolean(soupOfGeometry(geoB));
  const A = new Brush(geoFromMesh(a)), B = new Brush(geoFromMesh(b));
  A.updateMatrixWorld(); B.updateMatrixWorld();
  const ev = new Evaluator();
  ev.attributes = ['position', 'normal'];
  ev.useGroups = false;
  const res = ev.evaluate(A, B, op);
  let out = M.healAfterBoolean(soupOfGeometry(res.geometry));
  // limpeza extra: funde vértices quase coincidentes (evita arestas minúsculas/não-manifold da operação booleana)
  out = M.dropZeroArea(M.weld(M.toSoup(out), 3e-4));
  out = M.orientFix(M.stitchTJunctions(out).mesh).mesh;
  return out;
}

async function doCut(mode) {
  const axis = cutAxis(), d = parseFloat($('#edCutPos').value);
  const b = dimsOf();
  if (!(d > b.min[axis] && d < b.max[axis])) return ctx.dialog({ title: 'Posição inválida', body: '<p>O plano precisa cruzar o modelo.</p>', cancel: null });
  await busy('Cortando…', async () => {
    const base = M.orientFix(E.mesh).mesh;
    const r = M.slice(base, axis, d);
    let A = r.front, B = r.back;
    if (!A.idx.length || !B.idx.length) throw new Error('O corte não separou o modelo em duas partes.');
    if ($('#edPins').checked) {
      const { ADDITION, SUBTRACTION } = await loadCsg();
      const pr = parseFloat($('#edPinD').value) / 2, ph = parseFloat($('#edPinH').value), gap = parseFloat($('#edPinGap').value) || 0;
      const pins = M.pinPositions(r.section, +$('#edPinN').value, pr + gap);
      if (!pins.length) throw new Error('Não encontrei espaço na seção do corte para os pinos. Diminua o diâmetro ou desligue os pinos.');
      for (const p of pins) {
        const ca = [...p], cb = [...p];
        ca[axis] = d - ph / 2 + 0.25;           // pino: sai da face de cima para a parte de baixo
        const pinG = cylGeo(pr, ph + 0.5, axis, ca);
        A = await booleanOp(A, pinG, ADDITION);
        cb[axis] = d - (ph + gap) / 2 + 0.25;   // furo na parte de baixo
        const holeG = cylGeo(pr + gap, ph + gap + 0.5, axis, cb);
        B = await booleanOp(B, holeG, SUBTRACTION);
      }
    }
    if (mode === 'split') {
      const base0 = E.entry.name.replace(/\.stl$/i, '');
      const lab = axis === 2 ? ['_cima', '_baixo'] : ['_A', '_B'];
      const r1 = await ctx.api.editSave(E.entry.id, 'new', M.writeStl(A), base0 + lab[0]);
      const r2 = await ctx.api.editSave(E.entry.id, 'new', M.writeStl(B), base0 + lab[1]);
      ctx.setStatus(`Corte salvo: ${r1.name} e ${r2.name}`, 1);
      await ctx.dialog({ title: 'Corte concluído', body: `<p>Criei <b>${ctx.esc(r1.name)}</b> e <b>${ctx.esc(r2.name)}</b> na mesma pasta do original e já entraram no catálogo.${r.warnings ? '<br><br><span class="muted">' + ctx.esc(r.warnings) + '</span>' : ''}</p>`, cancel: null });
    } else {
      setMesh(mode === 'keepA' ? A : B);
      if (r.warnings) ctx.setStatus(r.warnings, null);
    }
  });
}

// ------------------------------------------------------------ reparar
async function doAnalyze() {
  await busy('Analisando…', () => {
    const a = M.analyze(E.mesh);
    const lines = [
      `Triângulos: ${ctx.fmtNum(a.tris)}`,
      `Vértices: ${ctx.fmtNum(a.verts)}`,
      `Pedaços separados: ${a.shells}`,
      `Furos / arestas abertas: ${a.boundary}`,
      `Arestas problemáticas (3+ faces): ${a.nonManifold}`,
      `Normais invertidas: ${a.inconsistent}`,
      `Volume: ${fmt(a.volume / 1000, 2)} cm³`,
      '',
      a.watertight ? '✔ Malha fechada — pronta para fatiar.' : (a.volume < 0 ? '⚠ Normais todas invertidas (use “Corrigir normais”).' : '⚠ A malha tem problemas. Tente “Reparar tudo automaticamente”.'),
    ];
    $('#edReport').textContent = lines.join('\n');
  });
}

async function doRepairAll() {
  await busy('Reparando…', () => {
    let m = M.dropZeroArea(M.weld(M.toSoup(E.mesh), 1e-5));
    m = M.stitchTJunctions(m).mesh;
    m = M.orientFix(m).mesh;
    const f = M.fillHoles(m);
    m = M.orientFix(f.mesh).mesh;
    const a = M.analyze(m);
    setMesh(m);
    $('#edReport').textContent = `Reparo feito.\nFuros fechados: ${f.filled}${f.skipped ? ` (${f.skipped} não deu para fechar)` : ''}\nTriângulos: ${ctx.fmtNum(a.tris)}\nFuros restantes: ${a.boundary}\nArestas problemáticas: ${a.nonManifold}\n\n${a.watertight ? '✔ Malha fechada.' : '⚠ Ainda restam problemas.'}`;
  });
}

// ------------------------------------------------------------ juntar / furar
function clearTool(silent) {
  if (!E.tool) return;
  if (E.tc) E.tc.detach();
  if (E.scene) E.scene.remove(E.tool.obj);
  E.tool.obj.geometry.dispose();
  E.tool = null;
  if (!silent) $('#edToolBox').hidden = true;
}

function setTool(geo, kind, size, pos) {
  clearTool(true);
  const mat = new THREE.MeshStandardMaterial({ color: 0xff9a3c, transparent: true, opacity: 0.7, side: THREE.DoubleSide, depthWrite: false });
  const obj = new THREE.Mesh(geo, mat);
  if (size) obj.scale.set(...size);
  obj.position.set(...pos);
  E.scene.add(obj);
  E.tool = { obj, kind };
  E.tc.attach(obj);
  E.tc.setMode('translate');
  $$('[data-tcmode]').forEach((b) => b.classList.toggle('on', b.dataset.tcmode === 'translate'));
  $('#edToolBox').hidden = false;
  syncToolFields();
}

function toolGeoBounds() {
  const g = E.tool.obj.geometry;
  if (!g.boundingBox) g.computeBoundingBox();
  const s = new THREE.Vector3();
  g.boundingBox.getSize(s);
  return s;
}

function syncToolFields() {
  if (!E.tool) return;
  const o = E.tool.obj, s = toolGeoBounds();
  $('#edTpx').value = +o.position.x.toFixed(3); $('#edTpy').value = +o.position.y.toFixed(3); $('#edTpz').value = +o.position.z.toFixed(3);
  $('#edTsx').value = +(s.x * o.scale.x).toFixed(3); $('#edTsy').value = +(s.y * o.scale.y).toFixed(3); $('#edTsz').value = +(s.z * o.scale.z).toFixed(3);
}

function readToolFields() {
  if (!E.tool) return;
  const o = E.tool.obj, s = toolGeoBounds();
  const n = (id) => parseFloat($(id).value);
  const px = n('#edTpx'), py = n('#edTpy'), pz = n('#edTpz');
  if ([px, py, pz].every(Number.isFinite)) o.position.set(px, py, pz);
  const sx = n('#edTsx'), sy = n('#edTsy'), sz = n('#edTsz');
  if (sx > 0 && s.x) o.scale.x = sx / s.x;
  if (sy > 0 && s.y) o.scale.y = sy / s.y;
  if (sz > 0 && s.z) o.scale.z = sz / s.z;
}

function makePrimitive(kind) {
  const b = dimsOf();
  const c = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  const u = Math.max(Math.max(...b.size) * 0.3, 1);
  let g, size = [u, u, u], pos = c;
  if (kind === 'box') g = new THREE.BoxGeometry(1, 1, 1);
  else if (kind === 'cyl') { g = new THREE.CylinderGeometry(0.5, 0.5, 1, 48); g.rotateX(Math.PI / 2); size = [u * 0.4, u * 0.4, Math.max(b.size[2] * 1.4, u)]; }
  else if (kind === 'sph') g = new THREE.SphereGeometry(0.5, 48, 32);
  else if (kind === 'cone') { g = new THREE.ConeGeometry(0.5, 1, 48); g.rotateX(Math.PI / 2); }
  else if (kind === 'base') {
    g = new THREE.BoxGeometry(1, 1, 1);
    const m = Math.max(b.size[0], b.size[1]) * 0.1;
    const h = Math.max(b.size[2] * 0.08, 2);
    size = [b.size[0] + m * 2, b.size[1] + m * 2, h];
    pos = [c[0], c[1], b.min[2] - h / 2 + Math.min(0.3, h / 4)];
  }
  g.computeBoundingBox();
  setTool(g, kind, size, pos);
}

async function makeText() {
  const text = $('#edText').value.trim();
  if (!text) return ctx.dialog({ title: 'Texto', body: '<p>Digite o texto primeiro.</p>', cancel: null });
  await busy('Criando texto…', async () => {
    const bold = $('#edTextBold').checked;
    const buf = await ctx.api.getFont(bold);
    if (!buf) throw new Error('Não encontrei uma fonte no computador para o texto.');
    const ot = await import('../vendor/opentype.mjs');
    const copy = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    // desativa tabelas de substituição/posicionamento (GSUB/GPOS/GDEF): não são necessárias e algumas fontes quebram o leitor
    const dv = new DataView(copy);
    const nt = dv.getUint16(4);
    for (let i = 0; i < nt; i++) {
      const o = 12 + i * 16;
      const tag = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
      if (tag === 'GSUB' || tag === 'GPOS' || tag === 'GDEF') dv.setUint8(o, 0x58);
    }
    const font = ot.parse(copy);
    const height = parseFloat($('#edTextH').value) || 8;
    const depth = parseFloat($('#edTextT').value) || 1;
    const path = font.getPath(text, 0, 0, height);
    const sp = new THREE.ShapePath();
    for (const c of path.commands) {
      if (c.type === 'M') sp.moveTo(c.x, -c.y);
      else if (c.type === 'L') sp.lineTo(c.x, -c.y);
      else if (c.type === 'Q') sp.quadraticCurveTo(c.x1, -c.y1, c.x, -c.y);
      else if (c.type === 'C') sp.bezierCurveTo(c.x1, -c.y1, c.x2, -c.y2, c.x, -c.y);
    }
    const shapes = sp.toShapes();
    if (!shapes.length) throw new Error('Esse texto não gerou formas (a fonte não tem esses caracteres?).');
    const g = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false, curveSegments: 8 });
    g.computeBoundingBox();
    const bb = g.boundingBox;
    g.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, 0);
    g.computeBoundingBox();
    const b = dimsOf();
    setTool(g, 'text', [1, 1, 1], [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2] - 0.3]);
  });
}

async function makeStlTool() {
  const p = await ctx.api.pickStl();
  if (!p) return;
  await busy('Carregando arquivo…', async () => {
    const u8 = await ctx.api.readFile(p);
    const g = new STLLoader().parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
    g.computeBoundingBox();
    const bb = g.boundingBox;
    g.translate(-(bb.min.x + bb.max.x) / 2, -(bb.min.y + bb.max.y) / 2, -bb.min.z);
    g.computeBoundingBox();
    const b = dimsOf();
    setTool(g, 'stl', [1, 1, 1], [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, b.max[2]]);
  });
}

async function applyTool(opName) {
  if (!E.tool) return;
  await busy('Calculando…', async () => {
    const { ADDITION, SUBTRACTION, INTERSECTION } = await loadCsg();
    const op = { add: ADDITION, sub: SUBTRACTION, int: INTERSECTION }[opName];
    const o = E.tool.obj;
    o.updateMatrixWorld(true);
    const g = o.geometry.clone();
    g.applyMatrix4(o.matrixWorld);
    const res = await booleanOp(E.mesh, g, op);
    if (!res.idx.length) throw new Error('O resultado ficou vazio. Confira se o objeto realmente toca o modelo.');
    setMesh(res);
    clearTool();
  });
}

// ------------------------------------------------------------ salvar / abrir / fechar
async function save(mode) {
  const e = E.entry;
  if (mode === 'overwrite') {
    const ok = await ctx.dialog({
      title: 'Sobrescrever o arquivo original?',
      body: `<p>O arquivo <b>${ctx.esc(e.name)}</b> será substituído pela versão editada.</p><p class="muted">Guardo uma cópia de segurança da versão anterior; depois dá para voltar pelo botão “Restaurar versão anterior”.</p>`,
      ok: 'Sobrescrever',
    });
    if (!ok) return;
    await busy('Salvando…', async () => {
      await ctx.api.editSave(e.id, 'overwrite', M.writeStl(E.mesh));
      E.dirty = false; E.changed = true;
      updateButtons();
      ctx.setStatus('Arquivo original atualizado (cópia de segurança guardada)', 1);
    });
  } else {
    const base = e.name.replace(/\.stl$/i, '');
    const name = await ctx.promptText('Salvar como novo arquivo', 'nome do arquivo', base + '_editado');
    if (!name) return;
    await busy('Salvando…', async () => {
      const r = await ctx.api.editSave(e.id, 'new', M.writeStl(E.mesh), name.replace(/\.stl$/i, ''));
      E.dirty = false; E.changed = true;
      updateButtons();
      ctx.setStatus('Salvo: ' + r.name, 1);
    });
  }
}

export async function openEditor(entry) {
  if (E.open) return;
  E.open = true; E.entry = entry; E.history = []; E.future = []; E.dirty = false; E.changed = false; E.tab = 'transform';
  root.hidden = false;
  $('#edTitle').textContent = 'Editando: ' + entry.name;
  switchTab('transform');
  initScene();
  await busy('Abrindo arquivo…', async () => {
    const u8 = await ctx.api.readFile(entry.path);
    const geo = new STLLoader().parse(u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength));
    const mesh = M.weld(Float32Array.from(geo.attributes.position.array));
    geo.dispose();
    if (!mesh.idx.length) throw new Error('Arquivo vazio ou inválido.');
    E.mesh = null;
    setMesh(mesh, { push: false });
    frame('iso');
  });
  updateButtons();
}

async function closeEditor(force) {
  if (!E.open) return;
  if (E.dirty && !force) {
    const ok = await ctx.dialog({ title: 'Descartar alterações?', body: '<p>Você tem alterações que não foram salvas.</p>', ok: 'Descartar e fechar' });
    if (!ok) return;
  }
  const changed = E.changed;
  disposeScene();
  E.open = false; E.mesh = null; E.history = []; E.future = []; E.csg = E.csg;
  setPickFace(false);
  root.hidden = true;
  ctx.onClosed && ctx.onClosed(changed);
}

function switchTab(t) {
  E.tab = t;
  $$('#edTabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  $$('.edPage').forEach((p) => { p.hidden = p.dataset.page !== t; });
  if (t !== 'transform') setPickFace(false);
  updatePlane();
}

function undo() {
  if (!E.history.length) return;
  E.future.push(E.mesh);
  E.mesh = E.history.pop();
  E.dirty = true;
  rebuildDisplay(); updateInfo(); updateButtons();
}
function redo() {
  if (!E.future.length) return;
  E.history.push(E.mesh);
  E.mesh = E.future.pop();
  rebuildDisplay(); updateInfo(); updateButtons();
}

// ------------------------------------------------------------ eventos
function wire() {
  $('#edClose').onclick = () => closeEditor();
  $('#edUndo').onclick = undo;
  $('#edRedo').onclick = redo;
  $('#edSaveNew').onclick = () => save('new');
  $('#edSaveOver').onclick = () => save('overwrite');
  $$('#edTabs button').forEach((b) => { b.onclick = () => switchTab(b.dataset.tab); });
  $$('#edViews [data-v]').forEach((b) => { b.onclick = () => frame(b.dataset.v); });
  $('#edWire').onclick = (e) => { e.target.classList.toggle('on'); if (E.material) E.material.wireframe = e.target.classList.contains('on'); };

  // transformar
  const dimIds = ['#edDimX', '#edDimY', '#edDimZ'];
  dimIds.forEach((id, i) => {
    $(id).addEventListener('input', () => {
      if (!$('#edLock').checked || !E.mesh) return;
      const b = dimsOf().size, v = parseFloat($(id).value);
      if (!(v > 0) || !(b[i] > 0)) return;
      const f = v / b[i];
      dimIds.forEach((o, j) => { if (j !== i) $(o).value = +(b[j] * f).toFixed(3); });
    });
  });
  $('#edApplyDim').onclick = () => {
    const b = dimsOf().size;
    const v = dimIds.map((id) => parseFloat($(id).value));
    if (!v.every((x) => x > 0)) return;
    scaleTo(v[0] / b[0] || 1, v[1] / b[1] || 1, v[2] / b[2] || 1);
  };
  $('#edApplyPct').onclick = () => { const f = parseFloat($('#edPct').value) / 100; if (f > 0) { scaleTo(f, f, f); $('#edPct').value = 100; } };
  $$('[data-rot]').forEach((b) => { b.onclick = () => { const [a, d] = b.dataset.rot.split(','); rotate(a, +d, $('#edAutoDrop').checked); }; });
  $('#edRotApply').onclick = () => { const d = parseFloat($('#edRotDeg').value); if (Number.isFinite(d)) rotate($('#edRotAxis').value, d, $('#edAutoDrop').checked); };
  $$('[data-mir]').forEach((b) => { b.onclick = () => mirror(b.dataset.mir); });
  $('#edDrop').onclick = () => setMesh(dropToBed(E.mesh));
  $('#edCenter').onclick = () => {
    const b = dimsOf();
    const cx = (b.min[0] + b.max[0]) / 2, cy = (b.min[1] + b.max[1]) / 2;
    mutate((p) => { for (let i = 0; i < p.length; i += 3) { p[i] -= cx; p[i + 1] -= cy; } });
  };
  $('#edFace').onclick = () => setPickFace(!E.pickFace);

  // cortar
  $('#edCutAxis').onchange = () => { $('#edCutPos').value = ''; updateCutRange(); };
  $('#edCutRange').addEventListener('input', () => { $('#edCutPos').value = +parseFloat($('#edCutRange').value).toFixed(3); updatePlane(); });
  $('#edCutPos').addEventListener('input', () => { $('#edCutRange').value = $('#edCutPos').value; updatePlane(); });
  $('#edCutSplit').onclick = () => doCut('split');
  $('#edCutKeepA').onclick = () => doCut('keepA');
  $('#edCutKeepB').onclick = () => doCut('keepB');

  // reparar
  $('#edAnalyze').onclick = doAnalyze;
  $('#edRepairAll').onclick = doRepairAll;
  $('#edClean').onclick = () => busy('Limpando…', () => { const m = M.dropZeroArea(M.weld(M.toSoup(E.mesh), 1e-5)); setMesh(m); });
  $('#edOrient').onclick = () => busy('Corrigindo normais…', () => { const r = M.orientFix(E.mesh); setMesh(r.mesh); $('#edReport').textContent = `Triângulos invertidos corrigidos: ${r.flipped}`; });
  $('#edFill').onclick = () => busy('Fechando furos…', () => {
    const r = M.fillHoles(E.mesh);
    setMesh(M.orientFix(r.mesh).mesh);
    $('#edReport').textContent = `Furos fechados: ${r.filled}${r.skipped ? `\nNão consegui fechar: ${r.skipped}` : ''}`;
  });
  $('#edShells').onclick = () => busy('Removendo pedaços…', () => {
    const r = M.removeSmallShells(E.mesh, (parseFloat($('#edShellPct').value) || 2) / 100);
    setMesh(r.mesh);
    $('#edReport').textContent = `Pedaços soltos removidos: ${r.removed}`;
  });
  $('#edDecRange').addEventListener('input', () => { $('#edDecVal').textContent = $('#edDecRange').value + '%'; });
  $('#edDecimate').onclick = () => busy('Simplificando…', async () => {
    const { MeshoptSimplifier } = await import('../vendor/meshopt_simplifier.js');
    const before = E.mesh.idx.length / 3;
    const base = M.dropZeroArea(M.weld(M.toSoup(E.mesh), 1e-5));
    const r = await M.decimate(base, +$('#edDecRange').value / 100, $('#edDecLock').checked, MeshoptSimplifier);
    setMesh(r.mesh);
    $('#edReport').textContent = `Triângulos: ${ctx.fmtNum(before)} → ${ctx.fmtNum(r.mesh.idx.length / 3)}`;
  });

  // juntar / furar
  $$('[data-tool]').forEach((b) => { b.onclick = () => (b.dataset.tool === 'stl' ? makeStlTool() : makePrimitive(b.dataset.tool)); });
  $('#edTextMake').onclick = makeText;
  ['#edTpx', '#edTpy', '#edTpz', '#edTsx', '#edTsy', '#edTsz'].forEach((id) => $(id).addEventListener('change', readToolFields));
  $$('[data-tcmode]').forEach((b) => { b.onclick = () => { if (!E.tc) return; E.tc.setMode(b.dataset.tcmode); $$('[data-tcmode]').forEach((x) => x.classList.toggle('on', x === b)); }; });
  $('#edOpAdd').onclick = () => applyTool('add');
  $('#edOpSub').onclick = () => applyTool('sub');
  $('#edOpInt').onclick = () => applyTool('int');
  $('#edOpDrop').onclick = () => clearTool();

  document.addEventListener('keydown', (ev) => {
    if (!E.open || root.hidden) return;
    if (!document.getElementById('dlg').hidden) return;
    const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement && document.activeElement.tagName);
    if (ev.ctrlKey && ev.key.toLowerCase() === 'z' && !typing) { ev.preventDefault(); ev.shiftKey ? redo() : undo(); }
    else if (ev.ctrlKey && ev.key.toLowerCase() === 'y' && !typing) { ev.preventDefault(); redo(); }
    else if (ev.key === 'Escape') { if (E.pickFace) setPickFace(false); else closeEditor(); }
    else if (!typing && E.tool && E.tc && ev.key.toLowerCase() === 'w') $('[data-tcmode=translate]').click();
    else if (!typing && E.tool && E.tc && ev.key.toLowerCase() === 'e') $('[data-tcmode=rotate]').click();
    else if (!typing && E.tool && E.tc && ev.key.toLowerCase() === 'r') $('[data-tcmode=scale]').click();
  }, true);
}

// ganchos de teste
export const _test = {
  state: E,
  doCut: (mode) => doCut(mode),
  setMesh,
  makePrimitive,
  applyTool,
  setTab: switchTab,
};
