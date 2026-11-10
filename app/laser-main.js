// Leitura de arquivos de laser/CNC no processo principal (Node).
const fs = require('fs');
const fsp = fs.promises;

const MAX_POINTS = 600000;

function newBounds() { return { minx: Infinity, miny: Infinity, maxx: -Infinity, maxy: -Infinity }; }
function grow(b, x, y) {
  if (x < b.minx) b.minx = x; if (x > b.maxx) b.maxx = x;
  if (y < b.miny) b.miny = y; if (y > b.maxy) b.maxy = y;
}

function finish(paths, b, extra = {}) {
  let total = 0;
  for (const p of paths) total += p.pts.length / 2;
  if (total > MAX_POINTS) {
    const k = Math.ceil(total / MAX_POINTS);
    for (const p of paths) {
      if (p.pts.length / 2 <= 3) continue;
      const out = [];
      for (let i = 0; i < p.pts.length; i += 2 * k) out.push(p.pts[i], p.pts[i + 1]);
      out.push(p.pts[p.pts.length - 2], p.pts[p.pts.length - 1]);
      p.pts = out;
    }
  }
  if (!isFinite(b.minx)) return { error: 'vazio' };
  return { paths, bounds: b, count: paths.length, ...extra };
}

// ---------------------------------------------------------------- DXF
function arcPoints(cx, cy, r, a0, a1, ccw = true) {
  let s = a0, e = a1;
  if (ccw) { while (e <= s) e += 2 * Math.PI; } else { while (e >= s) e -= 2 * Math.PI; }
  const n = Math.max(8, Math.min(180, Math.ceil(Math.abs(e - s) / (Math.PI / 36))));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = s + ((e - s) * i) / n;
    out.push(cx + r * Math.cos(a), cy + r * Math.sin(a));
  }
  return out;
}

function bulgeArc(p1, p2, bulge) {
  const dx = p2.x - p1.x, dy = p2.y - p1.y;
  const d = Math.hypot(dx, dy);
  if (d === 0) return [p2.x, p2.y];
  const theta = 4 * Math.atan(bulge);
  const r = d / (2 * Math.sin(theta / 2));
  const mx = (p1.x + p2.x) / 2, my = (p1.y + p2.y) / 2;
  const h = r * Math.cos(theta / 2);
  const cx = mx - (h * dy) / d, cy = my + (h * dx) / d;
  const a0 = Math.atan2(p1.y - cy, p1.x - cx);
  const out = [];
  const n = Math.max(4, Math.min(120, Math.ceil(Math.abs(theta) / (Math.PI / 36))));
  for (let i = 1; i <= n; i++) {
    const a = a0 + (theta * i) / n;
    out.push(cx + Math.abs(r) * Math.cos(a), cy + Math.abs(r) * Math.sin(a));
  }
  return out;
}

function splinePoints(e) {
  const pts = (e.fitPoints && e.fitPoints.length > 1 ? e.fitPoints : e.controlPoints) || [];
  if (pts.length < 2) return [];
  if (e.fitPoints && e.fitPoints.length > 1) {
    const out = [];
    for (const p of pts) out.push(p.x, p.y);
    return out;
  }
  // B-spline por de Boor
  const deg = e.degreeOfSplineCurve || 3;
  const knots = e.knotValues;
  const cp = e.controlPoints;
  if (!knots || knots.length < cp.length + deg + 1) {
    const out = [];
    for (const p of cp) out.push(p.x, p.y);
    return out;
  }
  const t0 = knots[deg], t1 = knots[cp.length];
  const N = Math.min(400, cp.length * 12);
  const out = [];
  for (let i = 0; i <= N; i++) {
    const t = t0 + ((t1 - t0) * i) / N - (i === N ? 1e-9 : 0);
    let k = deg;
    while (k < cp.length - 1 && t >= knots[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= deg; j++) d.push({ x: cp[j + k - deg].x, y: cp[j + k - deg].y });
    for (let r = 1; r <= deg; r++) {
      for (let j = deg; j >= r; j--) {
        const den = knots[j + 1 + k - r] - knots[j + k - deg];
        const a = den === 0 ? 0 : (t - knots[j + k - deg]) / den;
        d[j] = { x: (1 - a) * d[j - 1].x + a * d[j].x, y: (1 - a) * d[j - 1].y + a * d[j].y };
      }
    }
    out.push(d[deg].x, d[deg].y);
  }
  return out;
}

function parseDxf(text) {
  const mod = require('dxf-parser');
  const Parser = mod.default || mod;
  const dxf = new Parser().parseSync(text);
  if (!dxf) return { error: 'DXF inválido' };
  const unitsCode = dxf.header && dxf.header.$INSUNITS;
  const unitMM = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 3: 1609344, 8: 0.0000254, 9: 0.0254, 10: 914.4, 13: 0.001, 14: 100, 15: 10000 }[unitsCode] || 1;
  const paths = [];
  const b = newBounds();
  const blocks = dxf.blocks || {};

  const add = (pts, closed, T) => {
    if (pts.length < 4) return;
    const out = [];
    for (let i = 0; i < pts.length; i += 2) {
      let x = pts[i], y = pts[i + 1];
      if (T) { const p = T(x, y); x = p[0]; y = p[1]; }
      out.push(x, y);
      grow(b, x, y);
    }
    if (closed) out.push(out[0], out[1]);
    paths.push({ pts: out });
  };

  const handle = (e, T, depth) => {
    switch (e.type) {
      case 'LINE':
        if (e.vertices && e.vertices.length >= 2) add([e.vertices[0].x, e.vertices[0].y, e.vertices[1].x, e.vertices[1].y], false, T);
        break;
      case 'LWPOLYLINE':
      case 'POLYLINE': {
        const v = e.vertices || [];
        if (v.length < 2) break;
        const pts = [v[0].x, v[0].y];
        const closed = !!e.shape;
        const n = closed ? v.length : v.length - 1;
        for (let i = 0; i < n; i++) {
          const p1 = v[i], p2 = v[(i + 1) % v.length];
          if (p1.bulge) pts.push(...bulgeArc(p1, p2, p1.bulge));
          else pts.push(p2.x, p2.y);
        }
        add(pts, false, T);
        break;
      }
      case 'CIRCLE':
        add(arcPoints(e.center.x, e.center.y, e.radius, 0, 2 * Math.PI), false, T);
        break;
      case 'ARC':
        add(arcPoints(e.center.x, e.center.y, e.radius, e.startAngle, e.endAngle), false, T);
        break;
      case 'ELLIPSE': {
        const mx = e.majorAxisEndPoint.x, my = e.majorAxisEndPoint.y;
        const a = Math.hypot(mx, my), bb = a * e.axisRatio, rot = Math.atan2(my, mx);
        let s = e.startAngle || 0, en = e.endAngle == null ? 2 * Math.PI : e.endAngle;
        if (en <= s) en += 2 * Math.PI;
        const pts = [];
        for (let i = 0; i <= 72; i++) {
          const t = s + ((en - s) * i) / 72;
          const x = a * Math.cos(t), y = bb * Math.sin(t);
          pts.push(e.center.x + x * Math.cos(rot) - y * Math.sin(rot), e.center.y + x * Math.sin(rot) + y * Math.cos(rot));
        }
        add(pts, false, T);
        break;
      }
      case 'SPLINE':
        add(splinePoints(e), false, T);
        break;
      case 'SOLID':
      case '3DFACE':
        if (e.points && e.points.length >= 3) add(e.points.flatMap((p) => [p.x, p.y]), true, T);
        break;
      case 'INSERT': {
        if (depth > 4) break;
        const blk = blocks[e.name];
        if (!blk || !blk.entities) break;
        const sx = e.xScale == null ? 1 : e.xScale, sy = e.yScale == null ? 1 : e.yScale;
        const rot = ((e.rotation || 0) * Math.PI) / 180;
        const px = e.position ? e.position.x : 0, py = e.position ? e.position.y : 0;
        const bx = blk.position ? blk.position.x : 0, by = blk.position ? blk.position.y : 0;
        const T2 = (x, y) => {
          x = (x - bx) * sx; y = (y - by) * sy;
          let X = x * Math.cos(rot) - y * Math.sin(rot) + px;
          let Y = x * Math.sin(rot) + y * Math.cos(rot) + py;
          return T ? T(X, Y) : [X, Y];
        };
        for (const sub of blk.entities) handle(sub, T2, depth + 1);
        break;
      }
      default: break;
    }
  };
  for (const e of dxf.entities || []) handle(e, null, 0);
  return finish(paths, b, { unitMM });
}

// ---------------------------------------------------------------- G-code
function parseGcode(text) {
  const paths = [];
  const b = newBounds();
  let x = 0, y = 0, abs = true, mm = 1, mode = 0;
  let cur = null;
  const lines = text.split(/\r?\n/);
  const flush = () => { if (cur && cur.pts.length >= 4) paths.push(cur); cur = null; };
  for (let raw of lines) {
    raw = raw.replace(/\(.*?\)/g, '').replace(/;.*$/, '').toUpperCase();
    if (!raw.trim()) continue;
    const words = {};
    const re = /([A-Z])\s*(-?\d*\.?\d+)/g;
    let m;
    const gs = [];
    while ((m = re.exec(raw))) {
      if (m[1] === 'G') gs.push(parseFloat(m[2]));
      else words[m[1]] = parseFloat(m[2]);
    }
    for (const g of gs) {
      if (g === 90) abs = true; else if (g === 91) abs = false;
      else if (g === 20) mm = 25.4; else if (g === 21) mm = 1;
      else if ([0, 1, 2, 3].includes(g)) mode = g;
    }
    const hasXY = 'X' in words || 'Y' in words;
    if (!hasXY || (!gs.some((g) => [0, 1, 2, 3].includes(g)) && !('X' in words || 'Y' in words))) continue;
    const nx = 'X' in words ? (abs ? words.X * mm : x + words.X * mm) : x;
    const ny = 'Y' in words ? (abs ? words.Y * mm : y + words.Y * mm) : y;
    const rapid = mode === 0;
    if (!cur || cur.rapid !== rapid) { flush(); cur = { pts: [x, y], rapid }; grow(b, x, y); }
    if ((mode === 2 || mode === 3) && ('I' in words || 'J' in words)) {
      const cx = x + (words.I || 0) * mm, cy = y + (words.J || 0) * mm;
      const r = Math.hypot(x - cx, y - cy);
      const a = arcPoints(cx, cy, r, Math.atan2(y - cy, x - cx), Math.atan2(ny - cy, nx - cx), mode === 3);
      for (let i = 2; i < a.length; i += 2) { cur.pts.push(a[i], a[i + 1]); grow(b, a[i], a[i + 1]); }
    }
    cur.pts.push(nx, ny); grow(b, nx, ny);
    x = nx; y = ny;
  }
  flush();
  const cuts = paths.filter((p) => !p.rapid);
  if (!cuts.length) return { error: 'sem movimentos de corte' };
  const bb = newBounds();
  for (const p of cuts) for (let i = 0; i < p.pts.length; i += 2) grow(bb, p.pts[i], p.pts[i + 1]);
  return finish(paths, bb, { unitMM: 1 });
}

// ---------------------------------------------------------------- HPGL / PLT
function parseHpgl(text) {
  const paths = [];
  const b = newBounds();
  let down = false, x = 0, y = 0, cur = null;
  const cmds = text.split(/[;\n]/);
  const flush = () => { if (cur && cur.pts.length >= 4) paths.push(cur); cur = null; };
  const move = (nx, ny) => {
    if (down) {
      if (!cur) { cur = { pts: [x, y] }; grow(b, x, y); }
      cur.pts.push(nx, ny); grow(b, nx, ny);
    } else flush();
    x = nx; y = ny;
  };
  for (const c of cmds) {
    const m = /^\s*([A-Z]{2})([^]*)$/.exec(c.trim());
    if (!m) continue;
    const op = m[1];
    const nums = m[2].split(/[,\s]+/).filter(Boolean).map(Number).filter((n) => !isNaN(n));
    if (op === 'PU') { flush(); down = false; for (let i = 0; i + 1 < nums.length; i += 2) move(nums[i], nums[i + 1]); }
    else if (op === 'PD') { down = true; if (!cur) { cur = { pts: [x, y] }; grow(b, x, y); } for (let i = 0; i + 1 < nums.length; i += 2) move(nums[i], nums[i + 1]); }
    else if (op === 'PA') { for (let i = 0; i + 1 < nums.length; i += 2) move(nums[i], nums[i + 1]); }
    else if (op === 'PR') { for (let i = 0; i + 1 < nums.length; i += 2) move(x + nums[i], y + nums[i + 1]); }
  }
  flush();
  return finish(paths, b, { unitMM: 0.025 });
}

// ---------------------------------------------------------------- previews embutidos
function bmpFromDib(dib) {
  if (dib.length < 40) return null;
  const hdr = dib.readUInt32LE(0);
  if (hdr !== 40 && hdr !== 108 && hdr !== 124) return null;
  const bpp = dib.readUInt16LE(14);
  const clrUsed = dib.readUInt32LE(32);
  const pal = bpp <= 8 ? (clrUsed || 1 << bpp) * 4 : 0;
  const off = 14 + hdr + pal;
  const h = Buffer.alloc(14);
  h.write('BM', 0); h.writeUInt32LE(14 + dib.length, 2); h.writeUInt32LE(off, 10);
  return Buffer.concat([h, dib]);
}

function extractCdrPreview(buf) {
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const AdmZip = require('adm-zip');
    const zip = new AdmZip(buf);
    let best = null;
    for (const e of zip.getEntries()) {
      if (/\.(png|jpe?g|bmp)$/i.test(e.entryName) && /(thumb|preview)/i.test(e.entryName)) {
        if (!best || e.header.size > best.header.size) best = e;
      }
    }
    if (!best) for (const e of zip.getEntries()) if (/\.(png|jpe?g|bmp)$/i.test(e.entryName)) { best = e; break; }
    if (!best) return null;
    const ext = best.entryName.split('.').pop().toLowerCase();
    const mime = ext === 'png' ? 'image/png' : ext === 'bmp' ? 'image/bmp' : 'image/jpeg';
    return `data:${mime};base64,${best.getData().toString('base64')}`;
  }
  if (buf.slice(0, 4).toString('latin1') === 'RIFF') {
    const i = buf.indexOf('DISP', 12, 'latin1');
    if (i < 0) return null;
    const size = buf.readUInt32LE(i + 4);
    let data = buf.slice(i + 8, i + 8 + size);
    for (let skip = 0; skip <= 8; skip += 4) {
      const bmp = bmpFromDib(data.slice(skip));
      if (bmp) return 'data:image/bmp;base64,' + bmp.toString('base64');
    }
  }
  return null;
}

function extractLbrnThumb(text) {
  const m = /<Thumbnail[^>]*Source="([^"]+)"/i.exec(text);
  if (!m) return null;
  const b64 = m[1];
  const head = Buffer.from(b64.slice(0, 16), 'base64');
  const mime = head[0] === 0x89 ? 'image/png' : head[0] === 0xff ? 'image/jpeg' : 'image/png';
  return `data:${mime};base64,${b64}`;
}

function extractEpsPreview(buf) {
  // EPS "DOS binary": cabeçalho C5D0D3C6 com TIFF/WMF embutido
  if (buf.readUInt32LE(0) === 0xc6d3d0c5) {
    const tiffOff = buf.readUInt32LE(20), tiffLen = buf.readUInt32LE(24);
    if (tiffLen > 0) {
      // TIFF não é exibido pelo Chromium; sem preview
      return null;
    }
  }
  return null;
}

async function parseVector(file, ext) {
  const text = await fsp.readFile(file, 'utf8');
  if (ext === 'dxf') return parseDxf(text);
  if (ext === 'plt' || ext === 'hpgl') return parseHpgl(text);
  if (ext === 'gcode' || ext === 'nc' || ext === 'ngc' || ext === 'tap') return parseGcode(text);
  return { error: 'formato sem leitor vetorial' };
}

async function extractPreview(file, ext) {
  const buf = await fsp.readFile(file);
  if (ext === 'cdr') return extractCdrPreview(buf);
  if (ext === 'lbrn' || ext === 'lbrn2') return extractLbrnThumb(buf.toString('utf8'));
  if (ext === 'eps') return extractEpsPreview(buf);
  return null;
}

module.exports = { parseVector, extractPreview, _t: { parseDxf, parseGcode, parseHpgl, extractCdrPreview, extractLbrnThumb } };
