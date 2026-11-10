import { parseStl, makeMaterial, addLights, THREE } from './stl.js';
import { loadScene, fitView, renderScene, sceneInfo, NoPreview } from './laser.js';

const canvas = document.getElementById('c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
renderer.setSize(320, 320, false);
renderer.setClearColor(0x1d212b, 1);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100000);
camera.up.set(0, 0, 1);
addLights(scene, camera);
const material = makeMaterial();

const MAX_BYTES = 350 * 1024 * 1024;

const c2 = document.createElement('canvas');
c2.width = 320; c2.height = 320;
async function processLaser(job) {
  try {
    const scene = await loadScene(job, { maxSide: 900 });
    const ctx = c2.getContext('2d');
    renderScene(ctx, scene, 320, 320, fitView(scene, 320, 320, 14), { bg: '#f1f3f7' });
    const info = sceneInfo(scene);
    return { thumb: c2.toDataURL('image/jpeg', 0.85), meta: { laser: true, ext: job.ext, ...info } };
  } catch (e) {
    if (e instanceof NoPreview) return { thumb: null, meta: { laser: true, ext: job.ext, thumb: false } };
    throw e;
  }
}

async function process(job) {
  if (job.kind === 'laser') return processLaser(job);
  const u8 = await window.api.readFile(job.path);
  if (u8.byteLength > MAX_BYTES) return { thumb: null, meta: { error: 'grande' } };
  const { geo, meta } = parseStl(u8);
  const mesh = new THREE.Mesh(geo, material);
  scene.add(mesh);
  const r = geo.boundingSphere.radius || 1;
  const c = geo.boundingSphere.center;
  const dist = r / Math.sin((camera.fov * Math.PI) / 360) * 1.05;
  const dir = new THREE.Vector3(1, -1.25, 0.85).normalize();
  camera.position.copy(c).addScaledVector(dir, dist);
  camera.near = dist / 100; camera.far = dist * 10;
  camera.updateProjectionMatrix();
  camera.lookAt(c);
  renderer.render(scene, camera);
  const thumb = canvas.toDataURL('image/jpeg', 0.82);
  scene.remove(mesh);
  geo.dispose();
  return { thumb, meta };
}

async function loop() {
  for (;;) {
    const job = await window.api.thumbNext();
    if (!job) return; // fica ocioso até receber "wake"
    let res;
    try {
      res = await process(job);
    } catch (e) {
      res = { thumb: null, meta: { error: String(e && e.message || e) } };
    }
    await window.api.thumbDone(job.id, res.thumb, res.meta);
  }
}

window.api.onWake(() => { loop(); });
loop();
