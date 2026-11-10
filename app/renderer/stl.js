import * as THREE from '../vendor/three.module.js';
import { STLLoader } from '../vendor/STLLoader.js';

const loader = new STLLoader();

export function parseStl(u8) {
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const geo = loader.parse(ab);
  geo.computeBoundingBox();
  const bb = geo.boundingBox;
  const cx = (bb.min.x + bb.max.x) / 2;
  const cy = (bb.min.y + bb.max.y) / 2;
  geo.translate(-cx, -cy, -bb.min.z); // centraliza em XY, base em Z=0
  geo.computeBoundingBox();
  geo.computeBoundingSphere();
  const p = geo.attributes.position.array;
  let vol = 0;
  for (let i = 0; i < p.length; i += 9) {
    const ax = p[i], ay = p[i + 1], az = p[i + 2];
    const bx = p[i + 3], by = p[i + 4], bz = p[i + 5];
    const cx2 = p[i + 6], cy2 = p[i + 7], cz = p[i + 8];
    vol += (ax * (by * cz - bz * cy2) - ay * (bx * cz - bz * cx2) + az * (bx * cy2 - by * cx2)) / 6;
  }
  const s = new THREE.Vector3();
  geo.boundingBox.getSize(s);
  const meta = {
    tris: p.length / 9,
    dx: +s.x.toFixed(2), dy: +s.y.toFixed(2), dz: +s.z.toFixed(2),
    vol: +Math.abs(vol).toFixed(1),
  };
  return { geo, meta };
}

export function makeMaterial() {
  return new THREE.MeshStandardMaterial({ color: 0xaab8d4, metalness: 0.15, roughness: 0.55, side: THREE.DoubleSide });
}

export function addLights(scene, camera) {
  scene.add(new THREE.HemisphereLight(0xffffff, 0x445066, 0.9));
  const d = new THREE.DirectionalLight(0xffffff, 1.6);
  d.position.set(1, 1.5, 2);
  camera.add(d);
  scene.add(camera);
}

export { THREE };
