import assert from 'node:assert/strict';
import { readFile, access, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AnimationMixer, Box3, LoopOnce } from 'three';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(resolve(root, 'index.html'), 'utf8');
const paths = [...new Set([...html.matchAll(/(?:href|src)="(\/[^"#?]+)"/g)].map(match => match[1]))];
for (const path of paths) await access(resolve(root, path.startsWith('/media/') ? 'public' + path : '.' + path));
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) assert(ids.has(id), `Missing section ${id}`);
assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
for (const scene of ['workspace', 'coding', 'research', 'document']) {
  const file = resolve(root, `public/media/vykor-${scene}.webp`);
  assert((await stat(file)).size > 10000, `Missing product scene ${scene}`);
}
assert(html.includes('界面演示使用示例数据。'));

const bytes = await readFile(resolve(root, 'public/media/vykor-optical-mark.glb'));
const gltf = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
const clip = gltf.animations.find(clip => clip.name === 'scrollani');
assert(clip && Math.abs(clip.duration - 4) < .001);
const mixer = new AnimationMixer(gltf.scene);
const action = mixer.clipAction(clip);
action.setLoop(LoopOnce, 1); action.clampWhenFinished = true; action.play();
function widthAt(time) {
  mixer.setTime(time); gltf.scene.updateMatrixWorld(true);
  const box = new Box3().setFromObject(gltf.scene);
  assert(Number.isFinite(box.min.x) && Number.isFinite(box.max.x));
  return box.max.x - box.min.x;
}
const first = widthAt(0), last = widthAt(3.9999), reversed = widthAt(0);
assert(first / last > 2, 'Model must pull back from close-up');
assert(Math.abs(reversed - first) < .001, 'Reverse scrolling must restore the starting model');

if (process.argv[2]) {
  const origin = process.argv[2];
  const page = await fetch(origin);
  assert.equal(page.status, 200);
  const output = await page.text();
  assert(output.includes('你的 AI'));
  const builtPaths = [...new Set([...output.matchAll(/(?:href|src)="(\/(?:assets|media)\/[^"#?]+)"/g)].map(match => match[1]))];
  builtPaths.push('/media/vykor-optical-mark.glb');
  for (const path of builtPaths) {
    const response = await fetch(new URL(path, origin));
    assert.equal(response.status, 200, path);
    assert((await response.arrayBuffer()).byteLength > 0, path);
  }
  console.log(`HTTP smoke: ${builtPaths.length} local resources returned 200.`);
}
console.log(`PASS: ${paths.length} source references, valid anchors, four product scenes, 4s GLB animation, reverse scroll sampling.`);
