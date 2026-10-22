import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fitCameraToBox } from '../src/framing.js';
import { CAMERA_FAR, PAPER_SIZE } from '../src/optical.js';

const bytes = await readFile(new URL('../public/media/vykor-optical-mark.glb', import.meta.url));
const source = await new GLTFLoader().parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), '');
const clip = THREE.AnimationClip.findByName(source.animations, 'scrollani');
const viewports = [
  { width: 1425, height: 900 },
  { width: 2560, height: 1440 },
  { width: 3840, height: 2160 },
];
const stages = [
  { name: 'start', progress: 0, handoff: 0 },
  { name: 'quarter', progress: .25, handoff: 0 },
  { name: 'middle', progress: .5, handoff: 0 },
  { name: 'three quarters', progress: .75, handoff: 0 },
  { name: 'end', progress: 1, handoff: 0 },
  { name: 'handoff middle', progress: 1, handoff: .5 },
  { name: 'handoff end', progress: 1, handoff: 1 },
];

function frame({ width, height }, { progress, handoff }, far = CAMERA_FAR) {
  const model = source.scene.clone(true);
  const group = new THREE.Group();
  group.add(model);
  const mixer = new THREE.AnimationMixer(model);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();
  mixer.setTime(clip.duration - .00001);
  group.updateMatrixWorld(true);
  const endBounds = new THREE.Box3().setFromObject(group);
  const endCenter = endBounds.getCenter(new THREE.Vector3());
  const endSize = endBounds.getSize(new THREE.Vector3());

  mixer.setTime(progress * (clip.duration - .00001));
  const travel = THREE.MathUtils.smoothstep(progress, 0, 1);
  group.rotation.set(-.025 * (1 - travel), -.08 * (1 - travel), -.025 * (1 - travel));
  group.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(group);
  const direction = new THREE.Vector3(.38 - .415 * travel, .13 - .118 * travel, 1);

  // Desktop poster layout: centered 1180px composition inside a full-viewport canvas.
  const heroWidth = Math.min(1180, width - 48);
  const heroEdge = (width - heroWidth) / 2;
  const region = { left: heroEdge + heroWidth * .48, top: height * .12, width: heroWidth * .52, height: height * .78 };
  const scale = THREE.MathUtils.lerp(1, .23, handoff);
  const centerX = region.left + region.width / 2;
  const centerY = region.top + region.height / 2 + height * .12 * handoff;
  const camera = new THREE.PerspectiveCamera(35, 1, .05, far);
  fitCameraToBox(camera, bounds, direction, {
    width, height,
    region: { left: centerX - region.width * scale / 2, top: centerY - region.height * scale / 2, width: region.width * scale, height: region.height * scale },
    padding: .08,
  });
  return {
    camera,
    wallZ: THREE.MathUtils.lerp(-2.1, endCenter.z - endSize.z * .5 - .08, travel),
  };
}

function assertWallCoverage({ camera, wallZ }, paperSize = PAPER_SIZE) {
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -wallZ);
  const caster = new THREE.Raycaster();
  for (const x of [-1, 1]) {
    for (const y of [-1, 1]) {
      caster.setFromCamera(new THREE.Vector2(x, y), camera);
      const point = caster.ray.intersectPlane(plane, new THREE.Vector3());
      assert(point, `Viewport corner (${x}, ${y}) never reaches the paper.`);
      assert(Math.abs(point.x) <= paperSize / 2 && Math.abs(point.y) <= paperSize / 2,
        `Paper edges exposed at viewport corner (${x}, ${y}): wall hit (${point.x.toFixed(3)}, ${point.y.toFixed(3)}), half-size ${paperSize / 2}.`);
      const depth = -point.clone().applyMatrix4(camera.matrixWorldInverse).z;
      assert(depth > camera.near, `Paper crosses the near plane at corner (${x}, ${y}).`);
      assert(depth < camera.far,
        `Paper crosses the far plane at corner (${x}, ${y}): depth ${depth.toFixed(3)}, far ${camera.far}.`);
    }
  }
}

// Looking only at the model region misses the background seam at the viewport edge.
for (const viewport of viewports) {
  for (const stage of stages) {
    test(`${viewport.width}x${viewport.height}: paper covers every viewport corner at ${stage.name}`, () => {
      assertWallCoverage(frame(viewport, stage));
    });
  }
}

// These fixtures reproduce both original failures without modifying production settings.
test('the former 70-unit wall exposes a viewport corner even on the ordinary desktop', () => {
  assert.throws(() => assertWallCoverage(frame(viewports[0], stages[0]), 70), /Paper edges exposed/);
});

test('the former 80-unit far plane clips the 4K paper even after increasing its size', () => {
  assert.throws(() => assertWallCoverage(frame(viewports[2], stages[0], 80)), /Paper crosses the far plane/);
});
