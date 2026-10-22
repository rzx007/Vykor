import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fitCameraToBox } from '../src/framing.js';

const modelBytes = await readFile(new URL('../public/media/vykor-optical-mark.glb', import.meta.url));
const modelBuffer = modelBytes.buffer.slice(modelBytes.byteOffset, modelBytes.byteOffset + modelBytes.byteLength);
const views = [
  { name: 'desktop', width: 1600, height: 900, region: { left: 720, top: 70, width: 800, height: 780 } },
  { name: 'tablet', width: 820, height: 1180, region: { left: 380, top: 280, width: 420, height: 800 } },
  { name: 'phone', width: 390, height: 844, region: { left: 0, top: 350, width: 390, height: 440 } },
];

function corners(box) {
  const points = [];
  for (const x of [box.min.x, box.max.x]) {
    for (const y of [box.min.y, box.max.y]) {
      for (const z of [box.min.z, box.max.z]) points.push(new THREE.Vector3(x, y, z));
    }
  }
  return points;
}

function assertVisible(camera, box, view, padding = .1) {
  const region = view.region ?? { left: 0, top: 0, width: view.width, height: view.height };
  const left = region.left + region.width * padding;
  const right = region.left + region.width * (1 - padding);
  const top = region.top + region.height * padding;
  const bottom = region.top + region.height * (1 - padding);
  for (const point of corners(box)) {
    const projected = point.clone().project(camera);
    const x = (projected.x + 1) * view.width / 2;
    const y = (1 - projected.y) * view.height / 2;
    assert(x >= left - 1e-6 && x <= right + 1e-6, `x=${x} outside padded region [${left}, ${right}]`);
    assert(y >= top - 1e-6 && y <= bottom + 1e-6, `y=${y} outside padded region [${top}, ${bottom}]`);
    assert(projected.z > -1 && projected.z < 1, `depth=${projected.z} outside clipping planes`);
  }
  const center = box.getCenter(new THREE.Vector3()).project(camera);
  assert(Math.abs((center.x + 1) * view.width / 2 - (region.left + region.width / 2)) < 1e-6);
  assert(Math.abs((1 - center.y) * view.height / 2 - (region.top + region.height / 2)) < 1e-6);
}

async function animatedModel() {
  const gltf = await new GLTFLoader().parseAsync(modelBuffer.slice(0), '');
  const group = new THREE.Group();
  group.add(gltf.scene);
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const clip = THREE.AnimationClip.findByName(gltf.animations, 'scrollani');
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  return progress => {
    mixer.setTime(progress * (clip.duration - .00001));
    const travel = THREE.MathUtils.smoothstep(progress, 0, 1);
    group.rotation.set(-.025 * (1 - travel), -.08 * (1 - travel), -.025 * (1 - travel));
    group.updateMatrixWorld(true);
    return {
      box: new THREE.Box3().setFromObject(group),
      direction: new THREE.Vector3(.58 - .615 * travel, .16 - .148 * travel, 1.3 - .3 * travel),
    };
  };
}

// Returning an unchanged camera or using only the final animation bounds must fail here.
test('fits a complete box in the viewport with a stable chosen direction', () => {
  const camera = new THREE.PerspectiveCamera(35, 1, .05, 80);
  const box = new THREE.Box3(new THREE.Vector3(-3, -2, -1), new THREE.Vector3(5, 4, 2));
  const direction = new THREE.Vector3(.58, .16, 1.3);
  const view = { width: 1600, height: 900 };
  fitCameraToBox(camera, box, direction, view);
  assertVisible(camera, box, view);
  const fromCenter = camera.position.clone().sub(box.getCenter(new THREE.Vector3())).normalize();
  assert(fromCenter.dot(direction.clone().normalize()) > .999999);
});

for (const view of views) {
  for (const progress of [0, .25, .5, .75, 1]) {
    // This catches clipping at the expanded first frame and during the pull-back.
    test(`${view.name}: actual GLB at scroll ${progress} fits its padded content region`, async () => {
      const sample = await animatedModel();
      const { box, direction } = sample(progress);
      const camera = new THREE.PerspectiveCamera(35, 1, .05, 80);
      fitCameraToBox(camera, box, direction, view);
      assertVisible(camera, box, view);
    });
  }
  // Fitting must not depend on the previous frame or accumulated camera state.
  test(`${view.name}: reversing the animation restores exactly the same framing`, async () => {
    const sample = await animatedModel();
    const camera = new THREE.PerspectiveCamera(35, 1, .05, 80);
    const first = sample(0);
    fitCameraToBox(camera, first.box, first.direction, view);
    const initial = [...camera.position.toArray(), ...camera.quaternion.toArray(), ...camera.projectionMatrix.elements];
    for (const progress of [1, .75, .5, .25, 0]) {
      const { box, direction } = sample(progress);
      fitCameraToBox(camera, box, direction, view);
      assertVisible(camera, box, view);
    }
    const reversed = [...camera.position.toArray(), ...camera.quaternion.toArray(), ...camera.projectionMatrix.elements];
    assert.deepEqual(reversed, initial);
  });
}

// Ignoring zoom or retaining an old region offset must not silently crop a later layout.
test('handles camera zoom and resets a previous subregion when returning to a full viewport', () => {
  const camera = new THREE.PerspectiveCamera(50, 1, .05, 80);
  camera.zoom = 1.6;
  const box = new THREE.Box3(new THREE.Vector3(-2, -3, -1), new THREE.Vector3(2, 3, 1));
  const direction = new THREE.Vector3(-.2, .1, 1);
  fitCameraToBox(camera, box, direction, { ...views[0], padding: .15 });
  assertVisible(camera, box, views[0], .15);
  const full = { width: 390, height: 844 };
  fitCameraToBox(camera, box, direction, { ...full, padding: .05 });
  assertVisible(camera, box, full, .05);
});

test('rejects a zero direction and unusable viewport sizes before changing the camera', () => {
  const camera = new THREE.PerspectiveCamera(35, 1, .05, 80);
  const box = new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1));
  assert.throws(() => fitCameraToBox(camera, box, new THREE.Vector3(), { width: 390, height: 844 }), RangeError);
  assert.throws(() => fitCameraToBox(camera, box, new THREE.Vector3(0, 0, 1), { width: 0, height: 844 }), RangeError);
  assert.throws(() => fitCameraToBox(camera, box, new THREE.Vector3(0, 0, 1), { width: 390, height: 844, padding: .5 }), RangeError);
  assert.deepEqual(camera.position.toArray(), [0, 0, 0]);
});
