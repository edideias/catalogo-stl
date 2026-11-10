// Operações de geometria sobre malhas indexadas: { pos: Float32Array(xyz), idx: Uint32Array(3 por triângulo) }
import { ShapeUtils, Vector2 } from '../vendor/three.module.js';

// ---------------------------------------------------------------- básicos
export function bbox(m) {
  const p = m.pos;
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  return { min: [minx, miny, minz], max: [maxx, maxy, maxz], size: [maxx - minx, maxy - miny, maxz - minz] };
}

export function diagonal(m) {
  const b = bbox(m);
  return Math.hypot(b.size[0], b.size[1], b.size[2]) || 1;
}

export function volume(m) {
  const p = m.pos, I = m.idx;
  let v = 0;
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return v;
}

export function toSoup(m) {
  const out = new Float32Array(m.idx.length * 3);
  for (let i = 0; i < m.idx.length; i++) {
    const s = m.idx[i] * 3;
    out[i * 3] = m.pos[s]; out[i * 3 + 1] = m.pos[s + 1]; out[i * 3 + 2] = m.pos[s + 2];
  }
  return out;
}

// Solda vértices coincidentes e descarta triângulos degenerados.
export function weld(soup, tolRel = 1e-6) {
  const n = soup.length / 3;
  let minx = Infinity, miny = Infinity, minz = Infinity, maxx = -Infinity, maxy = -Infinity, maxz = -Infinity;
  for (let i = 0; i < soup.length; i += 3) {
    const x = soup[i], y = soup[i + 1], z = soup[i + 2];
    if (x < minx) minx = x; if (x > maxx) maxx = x;
    if (y < miny) miny = y; if (y > maxy) maxy = y;
    if (z < minz) minz = z; if (z > maxz) maxz = z;
  }
  const diag = Math.hypot(maxx - minx, maxy - miny, maxz - minz) || 1;
  const q = Math.max(diag * tolRel, 1e-12);
  let size = 1;
  while (size < n * 2) size <<= 1;
  const head = new Int32Array(size).fill(-1);
  const next = new Int32Array(n);
  const kx = new Int32Array(n), ky = new Int32Array(n), kz = new Int32Array(n);
  const upos = new Float32Array(n * 3);
  const map = new Uint32Array(n);
  let u = 0;
  for (let i = 0; i < n; i++) {
    const x = soup[i * 3], y = soup[i * 3 + 1], z = soup[i * 3 + 2];
    const ix = Math.round((x - minx) / q), iy = Math.round((y - miny) / q), iz = Math.round((z - minz) / q);
    const h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & (size - 1);
    let f = -1;
    for (let j = head[h]; j !== -1; j = next[j]) {
      if (kx[j] === ix && ky[j] === iy && kz[j] === iz) { f = j; break; }
    }
    if (f < 0) {
      f = u++;
      kx[f] = ix; ky[f] = iy; kz[f] = iz;
      upos[f * 3] = x; upos[f * 3 + 1] = y; upos[f * 3 + 2] = z;
      next[f] = head[h]; head[h] = f;
    }
    map[i] = f;
  }
  const idx = [];
  for (let t = 0; t < n; t += 3) {
    const a = map[t], b = map[t + 1], c = map[t + 2];
    if (a === b || b === c || a === c) continue;
    idx.push(a, b, c);
  }
  return { pos: upos.slice(0, u * 3), idx: Uint32Array.from(idx) };
}

export function compact(m) {
  const V = m.pos.length / 3;
  const remap = new Int32Array(V).fill(-1);
  let u = 0;
  for (let i = 0; i < m.idx.length; i++) if (remap[m.idx[i]] < 0) remap[m.idx[i]] = u++;
  const pos = new Float32Array(u * 3);
  for (let v = 0; v < V; v++) {
    const r = remap[v];
    if (r >= 0) { pos[r * 3] = m.pos[v * 3]; pos[r * 3 + 1] = m.pos[v * 3 + 1]; pos[r * 3 + 2] = m.pos[v * 3 + 2]; }
  }
  const idx = new Uint32Array(m.idx.length);
  for (let i = 0; i < idx.length; i++) idx[i] = remap[m.idx[i]];
  return { pos, idx };
}

// Remove triângulos de área zero.
export function dropZeroArea(m, tolRel = 1e-12) {
  const p = m.pos, I = m.idx;
  const d = diagonal(m);
  const tol = d * d * tolRel;
  const out = [];
  for (let t = 0; t < I.length; t += 3) {
    const a = I[t] * 3, b = I[t + 1] * 3, c = I[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const cx = uy * vz - uz * vy, cy = uz * vx - ux * vz, cz = ux * vy - uy * vx;
    if (Math.hypot(cx, cy, cz) * 0.5 > tol) out.push(I[t], I[t + 1], I[t + 2]);
  }
  return compact({ pos: p, idx: Uint32Array.from(out) });
}

// ---------------------------------------------------------------- análise
const ekey = (a, b, V) => (a < b ? a * V + b : b * V + a);

export function analyze(m) {
  const V = m.pos.length / 3, T = m.idx.length / 3, I = m.idx;
  const e = new Map();
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const a = I[t * 3 + k], b = I[t * 3 + (k + 1) % 3];
      const key = ekey(a, b, V);
      const bit = a < b ? 1 : 2;
      const cur = e.get(key) || 0;
      e.set(key, (((cur >> 2) + 1) << 2) | ((cur & 3) | bit));
    }
  }
  let boundary = 0, nonManifold = 0, inconsistent = 0;
  for (const v of e.values()) {
    const c = v >> 2;
    if (c === 1) boundary++;
    else if (c > 2) nonManifold++;
    else if ((v & 3) !== 3) inconsistent++;
  }
  // cascas (componentes conexos por vértice)
  const parent = new Int32Array(V);
  for (let i = 0; i < V; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < T; t++) {
    const a = find(I[t * 3]), b = find(I[t * 3 + 1]), c = find(I[t * 3 + 2]);
    if (a !== b) parent[b] = a;
    const a2 = find(a);
    const c2 = find(c);
    if (a2 !== c2) parent[c2] = a2;
  }
  const roots = new Set();
  for (let t = 0; t < T; t++) roots.add(find(I[t * 3]));
  return {
    tris: T, verts: V, boundary, nonManifold, inconsistent, shells: roots.size,
    volume: volume(m), watertight: boundary === 0 && nonManifold === 0 && inconsistent === 0,
  };
}

// ---------------------------------------------------------------- normais coerentes
export function orientFix(m) {
  const V = m.pos.length / 3, I = m.idx.slice(), T = I.length / 3;
  const t1 = new Map(), t2 = new Map(), nm = new Set();
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) {
      const key = ekey(I[t * 3 + k], I[t * 3 + (k + 1) % 3], V);
      if (!t1.has(key)) t1.set(key, t);
      else if (!t2.has(key)) t2.set(key, t);
      else nm.add(key);
    }
  }
  const dirOf = (u, a, b) => {
    for (let k = 0; k < 3; k++) {
      const x = I[u * 3 + k], y = I[u * 3 + (k + 1) % 3];
      if (x === a && y === b) return 1;
      if (x === b && y === a) return -1;
    }
    return 0;
  };
  const seen = new Uint8Array(T);
  let flipped = 0;
  const p = m.pos;
  const triVol = (t) => {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    return (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  };
  const flip = (t) => { const x = I[t * 3 + 1]; I[t * 3 + 1] = I[t * 3 + 2]; I[t * 3 + 2] = x; flipped++; };
  for (let s = 0; s < T; s++) {
    if (seen[s]) continue;
    const comp = [s];
    seen[s] = 1;
    for (let qi = 0; qi < comp.length; qi++) {
      const t = comp[qi];
      for (let k = 0; k < 3; k++) {
        const a = I[t * 3 + k], b = I[t * 3 + (k + 1) % 3];
        const key = ekey(a, b, V);
        if (nm.has(key)) continue;
        const u = t1.get(key) === t ? t2.get(key) : t1.get(key);
        if (u === undefined || seen[u]) continue;
        if (dirOf(u, a, b) === 1) flip(u);
        seen[u] = 1;
        comp.push(u);
      }
    }
    let v = 0;
    for (const t of comp) v += triVol(t);
    if (v < 0) for (const t of comp) flip(t);
  }
  return { mesh: { pos: m.pos, idx: I }, flipped };
}

// ---------------------------------------------------------------- fechar furos
function triangulatePolygon3D(pts3, normalHint) {
  // pts3: array de [x,y,z]; retorna lista de triângulos [i,j,k] com orientação a favor de normalHint
  // base 2D a partir da normal de Newell
  let nx = 0, ny = 0, nz = 0;
  for (let i = 0; i < pts3.length; i++) {
    const a = pts3[i], b = pts3[(i + 1) % pts3.length];
    nx += (a[1] - b[1]) * (a[2] + b[2]);
    ny += (a[2] - b[2]) * (a[0] + b[0]);
    nz += (a[0] - b[0]) * (a[1] + b[1]);
  }
  let nl = Math.hypot(nx, ny, nz);
  if (nl < 1e-18) return [];
  nx /= nl; ny /= nl; nz /= nl;
  // eixos u,v ortogonais a n
  let ux, uy, uz;
  if (Math.abs(nx) < 0.9) { ux = 0; uy = nz; uz = -ny; } else { ux = -nz; uy = 0; uz = nx; }
  const ul = Math.hypot(ux, uy, uz); ux /= ul; uy /= ul; uz /= ul;
  const vx = ny * uz - nz * uy, vy = nz * ux - nx * uz, vz = nx * uy - ny * ux;
  const pts2 = pts3.map((p) => new Vector2(p[0] * ux + p[1] * uy + p[2] * uz, p[0] * vx + p[1] * vy + p[2] * vz));
  const faces = ShapeUtils.triangulateShape(pts2, []);
  const out = [];
  for (const f of faces) {
    const a = pts3[f[0]], b = pts3[f[1]], c = pts3[f[2]];
    const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
    const fx = c[0] - a[0], fy = c[1] - a[1], fz = c[2] - a[2];
    const cx = ey * fz - ez * fy, cy = ez * fx - ex * fz, cz = ex * fy - ey * fx;
    const dot = cx * normalHint[0] + cy * normalHint[1] + cz * normalHint[2];
    out.push(dot < 0 ? [f[0], f[2], f[1]] : [f[0], f[1], f[2]]);
  }
  return out;
}

export function fillHoles(m, maxLoop = 20000) {
  const V = m.pos.length / 3, I = m.idx, T = I.length / 3, p = m.pos;
  const cnt = new Map();
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const key = ekey(I[t * 3 + k], I[t * 3 + (k + 1) % 3], V);
    cnt.set(key, (cnt.get(key) || 0) + 1);
  }
  const startMap = new Map(); // vértice inicial -> lista de [a,b]
  let nb = 0;
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const a = I[t * 3 + k], b = I[t * 3 + (k + 1) % 3];
    if (cnt.get(ekey(a, b, V)) === 1) {
      if (!startMap.has(a)) startMap.set(a, []);
      startMap.get(a).push([a, b, false]);
      nb++;
    }
  }
  if (!nb) return { mesh: m, filled: 0, skipped: 0 };
  const add = [];
  let filled = 0, skipped = 0;
  for (const list of startMap.values()) {
    for (const e0 of list) {
      if (e0[2]) continue;
      const loop = [e0[0]];
      let cur = e0, ok = false;
      cur[2] = true;
      for (let guard = 0; guard < maxLoop + 2; guard++) {
        const b = cur[1];
        if (b === e0[0]) { ok = true; break; }
        loop.push(b);
        const cand = startMap.get(b);
        let nx = null;
        if (cand) for (const c of cand) if (!c[2]) { nx = c; break; }
        if (!nx) break;
        nx[2] = true; cur = nx;
      }
      if (!ok || loop.length < 3 || loop.length > maxLoop) { skipped++; continue; }
      // a tampa percorre a borda ao contrário
      const rev = loop.slice().reverse();
      const pts = rev.map((v) => [p[v * 3], p[v * 3 + 1], p[v * 3 + 2]]);
      // normal esperada: Newell do polígono invertido
      let nx = 0, ny = 0, nz = 0;
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        nx += (a[1] - b[1]) * (a[2] + b[2]); ny += (a[2] - b[2]) * (a[0] + b[0]); nz += (a[0] - b[0]) * (a[1] + b[1]);
      }
      const tris = triangulatePolygon3D(pts, [nx, ny, nz]);
      if (!tris.length) { skipped++; continue; }
      for (const f of tris) add.push(rev[f[0]], rev[f[1]], rev[f[2]]);
      filled++;
    }
  }
  const idx = new Uint32Array(I.length + add.length);
  idx.set(I); idx.set(add, I.length);
  return { mesh: { pos: m.pos, idx }, filled, skipped };
}

// ---------------------------------------------------------------- junções em T (saída de booleanas)
export function stitchTJunctions(m, tolRel = 1e-5) {
  const V = m.pos.length / 3, I = m.idx, T = I.length / 3, p = m.pos;
  const diag = diagonal(m);
  const tol = diag * tolRel;
  const cnt = new Map();
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const key = ekey(I[t * 3 + k], I[t * 3 + (k + 1) % 3], V);
    cnt.set(key, (cnt.get(key) || 0) + 1);
  }
  const bedges = [];
  const bvset = new Set();
  for (let t = 0; t < T; t++) for (let k = 0; k < 3; k++) {
    const a = I[t * 3 + k], b = I[t * 3 + (k + 1) % 3];
    if (cnt.get(ekey(a, b, V)) === 1) { bedges.push([a, b, t]); bvset.add(a); bvset.add(b); }
  }
  if (!bedges.length) return { mesh: m, split: 0 };
  let sumLen = 0;
  for (const [a, b] of bedges) sumLen += Math.hypot(p[a * 3] - p[b * 3], p[a * 3 + 1] - p[b * 3 + 1], p[a * 3 + 2] - p[b * 3 + 2]);
  const cell = Math.max(tol * 4, sumLen / bedges.length);
  const gk = (x, y, z) => Math.floor(x / cell) + ',' + Math.floor(y / cell) + ',' + Math.floor(z / cell);
  const grid = new Map();
  for (const v of bvset) {
    const k = gk(p[v * 3], p[v * 3 + 1], p[v * 3 + 2]);
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k).push(v);
  }
  const splits = new Map(); // tri -> [{u,v,pts:[{id,t}]}]
  let nsplit = 0;
  for (const [a, b, t] of bedges) {
    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2];
    const dx = p[b * 3] - ax, dy = p[b * 3 + 1] - ay, dz = p[b * 3 + 2] - az;
    const l2 = dx * dx + dy * dy + dz * dz;
    if (l2 < tol * tol) continue;
    const minx = Math.min(ax, ax + dx) - tol, maxx = Math.max(ax, ax + dx) + tol;
    const miny = Math.min(ay, ay + dy) - tol, maxy = Math.max(ay, ay + dy) + tol;
    const minz = Math.min(az, az + dz) - tol, maxz = Math.max(az, az + dz) + tol;
    const pts = [];
    for (let ix = Math.floor(minx / cell); ix <= Math.floor(maxx / cell); ix++)
      for (let iy = Math.floor(miny / cell); iy <= Math.floor(maxy / cell); iy++)
        for (let iz = Math.floor(minz / cell); iz <= Math.floor(maxz / cell); iz++) {
          const list = grid.get(ix + ',' + iy + ',' + iz);
          if (!list) continue;
          for (const v of list) {
            if (v === a || v === b) continue;
            const vx = p[v * 3] - ax, vy = p[v * 3 + 1] - ay, vz = p[v * 3 + 2] - az;
            const tt = (vx * dx + vy * dy + vz * dz) / l2;
            if (tt <= 0 || tt >= 1) continue;
            const ex = vx - tt * dx, ey = vy - tt * dy, ez = vz - tt * dz;
            if (ex * ex + ey * ey + ez * ez > tol * tol) continue;
            pts.push({ id: v, t: tt });
          }
        }
    if (!pts.length) continue;
    pts.sort((x, y) => x.t - y.t);
    if (!splits.has(t)) splits.set(t, []);
    splits.get(t).push({ u: a, v: b, pts });
    nsplit++;
  }
  if (!nsplit) return { mesh: m, split: 0 };
  const out = [];
  for (let t = 0; t < T; t++) {
    const sp = splits.get(t);
    if (!sp) { out.push(I[t * 3], I[t * 3 + 1], I[t * 3 + 2]); continue; }
    let cur = [[I[t * 3], I[t * 3 + 1], I[t * 3 + 2]]];
    for (const { u, v, pts } of sp) {
      for (let j = 0; j < cur.length; j++) {
        const tr = cur[j];
        let apex = -1;
        for (let r = 0; r < 3; r++) if (tr[r] === u && tr[(r + 1) % 3] === v) apex = tr[(r + 2) % 3];
        if (apex < 0) continue;
        const chain = [u, ...pts.map((q) => q.id), v];
        const repl = [];
        for (let i = 0; i < chain.length - 1; i++) repl.push([chain[i], chain[i + 1], apex]);
        cur.splice(j, 1, ...repl);
        break;
      }
    }
    for (const tr of cur) out.push(tr[0], tr[1], tr[2]);
  }
  return { mesh: { pos: m.pos, idx: Uint32Array.from(out) }, split: nsplit };
}

// Limpeza padrão depois de uma booleana ou importação: solda, tira degenerados, costura junções em T, orienta.
export function healAfterBoolean(soup) {
  let m = weld(soup, 1e-5);
  m = dropZeroArea(m);
  m = stitchTJunctions(m).mesh;
  m = orientFix(m).mesh;
  return m;
}

// ---------------------------------------------------------------- pedaços soltos
export function removeSmallShells(m, minFrac = 0.02) {
  const V = m.pos.length / 3, I = m.idx, T = I.length / 3;
  const parent = new Int32Array(V);
  for (let i = 0; i < V; i++) parent[i] = i;
  const find = (x) => { while (parent[x] !== x) { parent[x] = parent[parent[x]]; x = parent[x]; } return x; };
  for (let t = 0; t < T; t++) {
    const a = find(I[t * 3]), b = find(I[t * 3 + 1]);
    if (a !== b) parent[b] = a;
    const c = find(I[t * 3 + 2]), a2 = find(a);
    if (c !== a2) parent[c] = a2;
  }
  const count = new Map();
  for (let t = 0; t < T; t++) { const r = find(I[t * 3]); count.set(r, (count.get(r) || 0) + 1); }
  let max = 0;
  for (const c of count.values()) if (c > max) max = c;
  const keepIdx = [];
  let removed = 0;
  for (let t = 0; t < T; t++) {
    if (count.get(find(I[t * 3])) >= max * minFrac) keepIdx.push(I[t * 3], I[t * 3 + 1], I[t * 3 + 2]);
  }
  const roots = [...count.values()].filter((c) => c < max * minFrac).length;
  removed = roots;
  return { mesh: compact({ pos: m.pos, idx: Uint32Array.from(keepIdx) }), removed };
}

// ---------------------------------------------------------------- simplificar
export async function decimate(m, keepRatio, lockBorder, Simplifier) {
  await Simplifier.ready;
  const target = Math.max(12, Math.floor((m.idx.length * keepRatio) / 3) * 3);
  const flags = lockBorder ? ['LockBorder'] : [];
  const [newIdx, err] = Simplifier.simplify(m.idx, m.pos, 3, target, 1.0, flags);
  return { mesh: compact({ pos: m.pos, idx: newIdx }), error: err };
}

// ---------------------------------------------------------------- corte
function cmp3(a, b) { return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]; }
function interp(p, q, sp, sq, axis, d) {
  let a = p, b = q, sa = sp, sb = sq;
  if (cmp3(a, b) > 0) { a = q; b = p; sa = sq; sb = sp; }
  const t = sa / (sa - sb);
  const r = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  r[axis] = d;
  return r;
}

function clip(P, S, keepFront, soup, segs, axis, d) {
  const poly = [];
  for (let k = 0; k < 3; k++) {
    const b = (k + 1) % 3;
    const sa = S[k], sb = S[b];
    const ain = keepFront ? sa >= 0 : sa <= 0;
    if (ain) poly.push({ p: P[k], z: sa === 0 });
    if (sa * sb < 0) poly.push({ p: interp(P[k], P[b], sa, sb, axis, d), z: true });
  }
  if (poly.length < 3) return;
  if (poly.every((v) => v.z)) return;
  for (let i = 1; i < poly.length - 1; i++) soup.push(...poly[0].p, ...poly[i].p, ...poly[i + 1].p);
  for (let k = 0; k < poly.length; k++) {
    const a = poly[k], b = poly[(k + 1) % poly.length];
    if (a.z && b.z && cmp3(a.p, b.p) !== 0) segs.push(b.p, a.p); // aresta de tampa: sentido invertido
  }
}

function buildLoops(segs, q) {
  const key = (p) => Math.round(p[0] / q) + ',' + Math.round(p[1] / q) + ',' + Math.round(p[2] / q);
  const starts = new Map();
  const n = segs.length / 2;
  for (let i = 0; i < n; i++) {
    const k = key(segs[i * 2]);
    if (!starts.has(k)) starts.set(k, []);
    starts.get(k).push(i);
  }
  const used = new Uint8Array(n);
  const loops = [];
  let open = 0;
  for (let i = 0; i < n; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const pts = [segs[i * 2]];
    const k0 = key(segs[i * 2]);
    let cur = i, ok = false;
    for (;;) {
      const end = segs[cur * 2 + 1];
      const ke = key(end);
      if (ke === k0) { ok = true; break; }
      pts.push(end);
      const cand = starts.get(ke);
      let nx = -1;
      if (cand) for (const j of cand) if (!used[j]) { nx = j; break; }
      if (nx < 0) break;
      used[nx] = 1; cur = nx;
    }
    if (ok && pts.length >= 3) loops.push(pts); else open++;
  }
  return { loops, open };
}

function pip(pt, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if ((yi > pt[1]) !== (yj > pt[1]) && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function area2(poly) {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1]);
  return a / 2;
}

// Triangula as tampas e devolve também a descrição 2D da seção.
function capTriangles(loops, axis, sign) {
  const u = sign > 0 ? (axis + 1) % 3 : (axis + 2) % 3;
  const v = sign > 0 ? (axis + 2) % 3 : (axis + 1) % 3;
  const info = loops.map((pts) => { const p2 = pts.map((p) => [p[u], p[v]]); return { pts, p2, a: area2(p2) }; });
  if (!info.length) return { soup: [], outers: [], holes: [] };
  let big = info[0];
  for (const l of info) if (Math.abs(l.a) > Math.abs(big.a)) big = l;
  const sg = Math.sign(big.a) || 1;
  const outers = info.filter((l) => Math.sign(l.a) === sg);
  const holes = info.filter((l) => Math.sign(l.a) !== sg);
  const soup = [];
  const nrm = [0, 0, 0];
  nrm[axis] = sign;
  const groups = new Map(outers.map((o) => [o, []]));
  for (const h of holes) {
    let best = null;
    for (const o of outers) if (pip(h.p2[0], o.p2) && (!best || Math.abs(o.a) < Math.abs(best.a))) best = o;
    if (best) groups.get(best).push(h);
  }
  for (const [o, hs] of groups) {
    const contour = o.p2.map((q) => new Vector2(q[0], q[1]));
    const holeV = hs.map((h) => h.p2.map((q) => new Vector2(q[0], q[1])));
    const all3 = o.pts.concat(...hs.map((h) => h.pts));
    const faces = ShapeUtils.triangulateShape(contour, holeV);
    for (const f of faces) {
      const a = all3[f[0]], b = all3[f[1]], c = all3[f[2]];
      const ex = b[0] - a[0], ey = b[1] - a[1], ez = b[2] - a[2];
      const fx = c[0] - a[0], fy = c[1] - a[1], fz = c[2] - a[2];
      const n = [ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx];
      const flip = n[0] * nrm[0] + n[1] * nrm[1] + n[2] * nrm[2] < 0;
      soup.push(...a, ...(flip ? c : b), ...(flip ? b : c));
    }
  }
  return { soup, outers: outers.map((o) => o.p2), holes: holes.map((o) => o.p2), u, v };
}

export function slice(m, axis, d) {
  const p = m.pos, I = m.idx;
  const diag = diagonal(m);
  const eps = diag * 1e-7;
  const front = [], back = [], segF = [], segB = [];
  const P = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], S = [0, 0, 0];
  for (let t = 0; t < I.length; t += 3) {
    let allPos = true, allNeg = true;
    for (let k = 0; k < 3; k++) {
      const i = I[t + k] * 3;
      P[k] = [p[i], p[i + 1], p[i + 2]];
      let s = P[k][axis] - d;
      if (Math.abs(s) <= eps) s = 0;
      S[k] = s;
      if (s <= eps) allPos = false;
      if (s >= -eps) allNeg = false;
    }
    if (allPos) { front.push(...P[0], ...P[1], ...P[2]); continue; }
    if (allNeg) { back.push(...P[0], ...P[1], ...P[2]); continue; }
    clip(P, S, true, front, segF, axis, d);
    clip(P, S, false, back, segB, axis, d);
  }
  const q = Math.max(diag * 1e-6, 1e-9);
  const lf = buildLoops(segF, q);
  const lb = buildLoops(segB, q);
  const cf = capTriangles(lf.loops, axis, -1); // parte de cima: tampa olha para baixo
  const cb = capTriangles(lb.loops, axis, +1);
  const fm = weld(Float32Array.from(front.concat(cf.soup)));
  const bm = weld(Float32Array.from(back.concat(cb.soup)));
  return {
    front: fm, back: bm,
    warnings: (lf.open || lb.open) ? 'A malha tem furos na região do corte; a tampa pode ficar incompleta. Use “Reparar” antes.' : '',
    section: { outers: cf.outers, holes: cf.holes, u: cf.u, v: cf.v, axis, d },
  };
}

// Pontos (3D) para pinos de encaixe dentro da seção do corte.
export function pinPositions(section, count, radius) {
  const { outers, holes, u, v, axis, d } = section;
  if (!outers || !outers.length) return [];
  let big = outers[0];
  for (const o of outers) if (Math.abs(area2(o)) > Math.abs(area2(big))) big = o;
  let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity;
  for (const q of big) { minx = Math.min(minx, q[0]); maxx = Math.max(maxx, q[0]); miny = Math.min(miny, q[1]); maxy = Math.max(maxy, q[1]); }
  const lists = {
    1: [[.5, .5]],
    2: [[.3, .5], [.7, .5], [.5, .3], [.5, .7], [.5, .5]],
    3: [[.5, .5], [.25, .5], [.75, .5], [.5, .25], [.5, .75]],
    4: [[.3, .3], [.7, .7], [.3, .7], [.7, .3], [.5, .5], [.5, .3], [.5, .7]],
  };
  const clearance = radius + 0.8;
  const distEdge = (pt, poly) => {
    let best = Infinity;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const ax = poly[j][0], ay = poly[j][1], bx = poly[i][0], by = poly[i][1];
      const dx = bx - ax, dy = by - ay;
      const l2 = dx * dx + dy * dy || 1e-12;
      let t = ((pt[0] - ax) * dx + (pt[1] - ay) * dy) / l2;
      t = Math.max(0, Math.min(1, t));
      best = Math.min(best, Math.hypot(pt[0] - (ax + t * dx), pt[1] - (ay + t * dy)));
    }
    return best;
  };
  const out = [];
  for (const [fx, fy] of lists[Math.min(4, Math.max(1, count))]) {
    const pt = [minx + (maxx - minx) * fx, miny + (maxy - miny) * fy];
    if (!pip(pt, big)) continue;
    if (holes.some((h) => pip(pt, h))) continue;
    if (distEdge(pt, big) < clearance) continue;
    if (holes.some((h) => distEdge(pt, h) < clearance)) continue;
    const p3 = [0, 0, 0];
    p3[u] = pt[0]; p3[v] = pt[1]; p3[axis] = d;
    out.push(p3);
    if (out.length >= count) break;
  }
  return out;
}

// ---------------------------------------------------------------- STL binário
export function writeStl(m) {
  const T = m.idx.length / 3;
  const buf = new ArrayBuffer(84 + T * 50);
  const dv = new DataView(buf);
  const head = 'Catalogo STL';
  for (let i = 0; i < head.length; i++) dv.setUint8(i, head.charCodeAt(i));
  dv.setUint32(80, T, true);
  const p = m.pos, I = m.idx;
  let o = 84;
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    dv.setFloat32(o, nx, true); dv.setFloat32(o + 4, ny, true); dv.setFloat32(o + 8, nz, true);
    for (let k = 0; k < 3; k++) {
      const s = k === 0 ? a : k === 1 ? b : c;
      dv.setFloat32(o + 12 + k * 12, p[s], true);
      dv.setFloat32(o + 16 + k * 12, p[s + 1], true);
      dv.setFloat32(o + 20 + k * 12, p[s + 2], true);
    }
    o += 50;
  }
  return new Uint8Array(buf);
}
