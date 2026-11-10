// Cenas 2D para arquivos de laser/CNC: carrega, mede e desenha.
const api = window.api;

export class NoPreview extends Error {}

const VECTOR_EXT = ['dxf', 'plt', 'hpgl', 'gcode', 'nc', 'ngc', 'tap'];
const EMBED_EXT = ['cdr', 'lbrn', 'lbrn2', 'eps'];

export const LASER_LABEL = {
  svg: 'SVG', dxf: 'DXF', ai: 'AI', eps: 'EPS', pdf: 'PDF', cdr: 'CDR', plt: 'PLT', hpgl: 'HPGL',
  lbrn: 'LightBurn', lbrn2: 'LightBurn', gcode: 'G-code', nc: 'G-code', ngc: 'G-code', tap: 'G-code', dwg: 'DWG',
};

function unitToMM(str) {
  const m = /^\s*(-?[\d.]+)\s*(mm|cm|in|pt|pc|px|m)?\s*$/i.exec(str || '');
  if (!m) return null;
  const v = parseFloat(m[1]);
  const u = (m[2] || 'px').toLowerCase();
  return v * ({ mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, pc: 25.4 / 6, px: 25.4 / 96, m: 1000 }[u]);
}

async function sceneFromImageUrl(url, wMM, hMM, extra = {}) {
  const img = new Image();
  img.decoding = 'async';
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('imagem inválida')); img.src = url; });
  return { type: 'image', source: img, w: img.naturalWidth, h: img.naturalHeight, wMM, hMM, ...extra };
}

async function loadSvg(entry) {
  const u8 = await api.readFile(entry.path);
  const text = new TextDecoder('utf-8').decode(u8);
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.nodeName.toLowerCase() !== 'svg' || doc.querySelector('parsererror')) throw new Error('SVG inválido');
  let vb = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  const hasVb = vb.length === 4 && vb.every((n) => !isNaN(n)) && vb[2] > 0 && vb[3] > 0;
  let wMM = unitToMM(svg.getAttribute('width')), hMM = unitToMM(svg.getAttribute('height'));
  const wPct = /%/.test(svg.getAttribute('width') || ''), hPct = /%/.test(svg.getAttribute('height') || '');
  if ((wPct || wMM == null) && hasVb) wMM = vb[2] * 25.4 / 96;
  if ((hPct || hMM == null) && hasVb) hMM = vb[3] * 25.4 / 96;
  if (wMM == null || hMM == null) { wMM = 100; hMM = 100; }
  const pxW = Math.max(16, Math.round(wMM * 96 / 25.4)), pxH = Math.max(16, Math.round(hMM * 96 / 25.4));
  svg.setAttribute('width', pxW); svg.setAttribute('height', pxH);
  if (!hasVb) svg.setAttribute('viewBox', `0 0 ${pxW} ${pxH}`);
  const out = new XMLSerializer().serializeToString(svg);
  const url = URL.createObjectURL(new Blob([out], { type: 'image/svg+xml' }));
  try {
    const s = await sceneFromImageUrl(url, +wMM.toFixed(2), +hMM.toFixed(2), { vectorImage: true });
    return s;
  } finally { setTimeout(() => URL.revokeObjectURL(url), 10000); }
}

let pdfjsPromise = null;
async function getPdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = import('../vendor/pdf.min.mjs').then((m) => {
      m.GlobalWorkerOptions.workerSrc = new URL('../vendor/pdf.worker.min.mjs', import.meta.url).href;
      return m;
    });
  }
  return pdfjsPromise;
}

async function loadPdf(entry, maxSide) {
  const pdfjs = await getPdfjs();
  const u8 = await api.readFile(entry.path);
  const doc = await pdfjs.getDocument({ data: u8, isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  try {
    const page = await doc.getPage(1);
    const v1 = page.getViewport({ scale: 1 });
    const k = Math.min(maxSide / Math.max(v1.width, v1.height), 8);
    const vp = page.getViewport({ scale: k });
    const c = document.createElement('canvas');
    c.width = Math.ceil(vp.width); c.height = Math.ceil(vp.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
    await page.render({ canvasContext: ctx, viewport: vp }).promise;
    return { type: 'image', source: c, w: c.width, h: c.height, wMM: +(v1.width * 25.4 / 72).toFixed(2), hMM: +(v1.height * 25.4 / 72).toFixed(2), pages: doc.numPages };
  } finally { doc.destroy(); }
}

export async function loadScene(entry, opts = {}) {
  const ext = (entry.ext || entry.name.split('.').pop()).toLowerCase();
  const maxSide = opts.maxSide || 900;
  if (ext === 'svg') return loadSvg(entry);
  if (ext === 'pdf' || ext === 'ai') {
    try { return await loadPdf(entry, maxSide); } catch (e) { throw new NoPreview('sem pré-visualização'); }
  }
  if (VECTOR_EXT.includes(ext)) {
    const r = await api.laserPaths(entry.path, ext);
    if (r.error) throw new Error(r.error);
    const b = r.bounds;
    const wMM = (b.maxx - b.minx) * r.unitMM, hMM = (b.maxy - b.miny) * r.unitMM;
    return { type: 'paths', paths: r.paths, bounds: b, wMM: +wMM.toFixed(2), hMM: +hMM.toFixed(2), count: r.count };
  }
  if (EMBED_EXT.includes(ext)) {
    const url = await api.laserPreview(entry.path, ext);
    if (!url) throw new NoPreview('sem pré-visualização embutida');
    return await sceneFromImageUrl(url, null, null, { embedded: true });
  }
  throw new NoPreview('formato sem pré-visualização');
}

export function sceneSize(scene) {
  if (scene.type === 'paths') return { w: scene.bounds.maxx - scene.bounds.minx || 1, h: scene.bounds.maxy - scene.bounds.miny || 1 };
  return { w: scene.w, h: scene.h };
}

export function fitView(scene, W, H, pad = 16) {
  const { w, h } = sceneSize(scene);
  const scale = Math.max(1e-9, Math.min((W - pad * 2) / w, (H - pad * 2) / h));
  return { scale, cx: scene.type === 'paths' ? (scene.bounds.minx + scene.bounds.maxx) / 2 : w / 2, cy: scene.type === 'paths' ? (scene.bounds.miny + scene.bounds.maxy) / 2 : h / 2 };
}

// view: {scale, cx, cy} — (cx,cy) é o ponto da cena no centro do canvas
export function renderScene(ctx, scene, W, H, view, style = {}) {
  ctx.save();
  ctx.fillStyle = style.bg || '#f1f3f7';
  ctx.fillRect(0, 0, W, H);
  const { scale, cx, cy } = view;
  if (scene.type === 'image') {
    const dw = scene.w * scale, dh = scene.h * scale;
    const x = W / 2 - cx * scale, y = H / 2 - cy * scale;
    if (scene.vectorImage && style.bg === '#14171e') { ctx.fillStyle = '#f1f3f7'; ctx.fillRect(x, y, dw, dh); }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(scene.source, x, y, dw, dh);
  } else {
    const tx = (x) => W / 2 + (x - cx) * scale;
    const ty = (y) => H / 2 - (y - cy) * scale;
    const stroke = (rapid) => {
      ctx.beginPath();
      let any = false;
      for (const p of scene.paths) {
        if (!!p.rapid !== rapid) continue;
        const a = p.pts;
        ctx.moveTo(tx(a[0]), ty(a[1]));
        for (let i = 2; i < a.length; i += 2) ctx.lineTo(tx(a[i]), ty(a[i + 1]));
        any = true;
      }
      if (any) ctx.stroke();
    };
    ctx.lineJoin = 'round'; ctx.lineCap = 'round';
    if (scene.paths.some((p) => p.rapid)) {
      ctx.strokeStyle = style.rapid || 'rgba(217,164,65,.55)'; ctx.lineWidth = (style.lw || 1.2) * 0.6;
      stroke(true);
    }
    ctx.strokeStyle = style.line || '#1f2a44'; ctx.lineWidth = style.lw || 1.3;
    stroke(false);
  }
  ctx.restore();
}

export function sceneInfo(scene) {
  return { dx: scene.wMM != null ? +scene.wMM : null, dy: scene.hMM != null ? +scene.hMM : null, n: scene.count || scene.pages || null };
}
