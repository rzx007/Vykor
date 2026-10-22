import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { AnimationMixer, Box3, LoopOnce } from 'three';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = await readFile(resolve(root, 'index.html'), 'utf8');
const css = await readFile(resolve(root, 'src/style.css'), 'utf8');
const product = await readFile(resolve(root, 'src/product-demo.js'), 'utf8');
const productCss = await readFile(resolve(root, 'src/product-demo.css'), 'utf8');
const paths = [...new Set([
  ...[...html.matchAll(/(?:href|src)="(\/[^"#?]+)"/g)].map(match => match[1]),
  ...[...css.matchAll(/url\(['"]?(\/media\/[^)'"\s]+)['"]?\)/g)].map(match => match[1]),
])];
for (const path of paths) await access(resolve(root, path.startsWith('/media/') ? 'public' + path : '.' + path));
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]));
for (const [, id] of html.matchAll(/href="#([^"]+)"/g)) assert(ids.has(id), `Missing section ${id}`);
assert.equal([...html.matchAll(/<h1\b/g)].length, 1);
assert(!/vykor-(?:workspace|coding|research|document)\.webp/.test(html + product + productCss), 'The product story must be DOM, not screenshots.');
assert(html.includes('id="workbench"') && product.includes('mountProductDemo'), 'The coded workbench must exist.');
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
assert(first / last > 2, 'The retained model asset must remain valid.');
assert(Math.abs(reversed - first) < .001, 'Reverse scrolling must restore the starting model');

if (process.argv[2]) {
  const siteUrl = new URL(process.argv[2]);
  if (!siteUrl.pathname.endsWith('/')) siteUrl.pathname += '/';
  const page = await fetch(siteUrl);
  assert.equal(page.status, 200);
  const output = await page.text();
  assert(output.includes('你的 AI'));
  const builtUrls = new Set([...output.matchAll(/(?:href|src)="([^"#]+)"/g)]
    .map(match => new URL(match[1], siteUrl))
    .filter(url => url.origin === siteUrl.origin && /\/(?:assets|media)\//.test(url.pathname))
    .map(url => url.href));
  builtUrls.add(new URL('media/vykor-optical-mark.glb', siteUrl).href);
  builtUrls.add(new URL('media/paper-grain.png', siteUrl).href);
  assert(builtUrls.size >= 5, 'The built page must expose its scripts, styles and media.');
  for (const url of builtUrls) {
    assert(new URL(url).pathname.startsWith(siteUrl.pathname), `Resource escapes the deployment path: ${url}`);
    const response = await fetch(url);
    assert.equal(response.status, 200, url);
    assert(!response.headers.get('content-type')?.includes('text/html'), `Expected an asset, received HTML: ${url}`);
    assert((await response.arrayBuffer()).byteLength > 0, url);
  }
  console.log(`HTTP smoke: ${builtUrls.size} site resources returned 200 under ${siteUrl.pathname}.`);
}
console.log(`PASS: ${paths.length} source references, valid anchors, coded product story without screenshots, retained GLB, reverse sampling.`);
