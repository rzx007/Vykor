import test from 'node:test';
import assert from 'node:assert/strict';
import { STORY_STEPS, sampleStoryProgress } from '../state.js';

const PART_NAMES = ['shell', 'chrome', 'sidebar', 'conversation', 'composer', 'tools'];
const FINAL_PART = {
  x: 0,
  y: 0,
  z: 0,
  scale: 1,
  rotationX: 0,
  rotationY: 0,
  opacity: 1,
};

function animatedNumbers(state) {
  return [
    state.progress,
    state.introOpacity,
    state.sceneOpacity,
    state.brandProgress,
    state.partRadius,
    state.modelOpacity,
    state.introLift,
    state.copyEntrance,
    state.composerHandoff,
    state.utilityOpacity,
    state.closingOpacity,
    ...Object.values(state.camera),
    ...PART_NAMES.flatMap((name) => Object.values(state.parts[name])),
    ...state.copyOpacities,
  ];
}

test('five story beats have usable copy and a unique identity', () => {
  assert.equal(STORY_STEPS.length, 5);
  assert.equal(new Set(STORY_STEPS.map((step) => step.id)).size, 5);
  for (const step of STORY_STEPS) {
    assert.ok(step.id.trim());
    assert.ok(step.title.trim());
    assert.ok(step.description.trim());
  }
});

test('the assembled workspace reaches an exact resting pose and holds it', () => {
  for (const progress of [0.92, 0.96, 1, 2]) {
    const state = sampleStoryProgress(progress);
    assert.equal(state.assembled, true);
    assert.equal(state.sceneOpacity, 1);
    assert.equal(state.introOpacity, 0);
    for (const name of PART_NAMES) assert.deepEqual(state.parts[name], FINAL_PART);
    assert.deepEqual(state.camera, { x: 0, y: 0, scale: 1, rotationX: 0, rotationY: 0 });
    assert.deepEqual(state.copyOpacities, [0, 0, 0, 0, 1]);
  }
});

test('scrolling backward samples the same pose without retaining previous state', () => {
  const progressValues = Array.from({ length: 101 }, (_, i) => i / 100);
  const forward = progressValues.map(sampleStoryProgress);
  for (let index = progressValues.length - 1; index >= 0; index -= 1) {
    assert.deepEqual(sampleStoryProgress(progressValues[index]), forward[index]);
  }
  const changed = sampleStoryProgress(0.5);
  changed.parts.sidebar.x = 100;
  changed.copyOpacities[0] = 100;
  assert.deepEqual(sampleStoryProgress(0.5), forward[50]);
});

test('the input composer arrives first and returns toward its slot as context arrives', () => {
  const prompt = sampleStoryProgress(0.26);
  assert.equal(prompt.parts.composer.opacity, 1);
  assert.ok(prompt.parts.composer.y < -0.2);
  for (const name of PART_NAMES.filter((part) => part !== 'composer')) {
    assert.equal(prompt.parts[name].opacity, 0);
  }
  const context = sampleStoryProgress(0.44);
  assert.equal(context.parts.conversation.opacity, 1);
  assert.ok(Math.abs(context.parts.composer.y) < 0.05);
  assert.equal(context.parts.sidebar.opacity, 0);
});

test('brand movement and camera movement remain restrained across the whole story', () => {
  assert.equal(sampleStoryProgress(0).brandProgress, 0);
  for (let index = 0; index <= 1000; index += 1) {
    const state = sampleStoryProgress(index / 1000);
    assert.ok(state.brandProgress >= 0 && state.brandProgress <= 0.055);
    assert.ok(state.camera.rotationX >= 0 && state.camera.rotationX <= 10);
    assert.ok(state.camera.rotationY >= -12 && state.camera.rotationY <= 0);
    assert.ok(state.camera.scale >= 0.88 && state.camera.scale <= 1);
    assert.ok(Math.abs(state.camera.x) <= 0.04);
    assert.ok(Math.abs(state.camera.y) <= 0.04);
  }
});

test('copy crossfades keep a readable beat visible, including every transition', () => {
  for (let index = 0; index <= 1000; index += 1) {
    const state = sampleStoryProgress(index / 1000);
    const sum = state.copyOpacities.reduce((total, opacity) => total + opacity, 0);
    assert.ok(Math.abs(sum - 1) < 1e-10);
    assert.ok(state.copyOpacities.every((opacity) => opacity >= 0 && opacity <= 1));
    assert.ok(Math.max(...state.copyOpacities) >= 0.5);
    assert.ok(state.introOpacity + state.sceneOpacity > 0.25);
    assert.ok(state.phaseIndex >= 0 && state.phaseIndex < 5);
  }
  for (const [phaseIndex, progress] of [0.26, 0.44, 0.6, 0.76, 0.94].entries()) {
    const state = sampleStoryProgress(progress);
    assert.equal(state.phaseIndex, phaseIndex);
    assert.equal(state.copyOpacities[phaseIndex], 1);
  }
});

test('clamped and invalid progress cannot produce non-finite animation values', () => {
  assert.deepEqual(sampleStoryProgress(-1), sampleStoryProgress(0));
  assert.deepEqual(sampleStoryProgress(2), sampleStoryProgress(1));
  assert.deepEqual(sampleStoryProgress(NaN), sampleStoryProgress(0));
  for (const raw of [-Infinity, Infinity, undefined, null, 'bad', {}, Symbol('bad')]) {
    assert.ok(animatedNumbers(sampleStoryProgress(raw)).every(Number.isFinite));
  }
});

test('poses remain continuous at story boundaries and at the ends of the scroll range', () => {
  const boundaries = [0, 0.06, 0.12, 0.13, 0.14, 0.15, 0.16, 0.20, 0.22, 0.25, 0.27, 0.29, 0.3, 0.42, 0.46, 0.58, 0.62, 0.74, 0.76, 0.8, 0.86, 0.9, 0.92, 0.93, 0.985, 1];
  for (const progress of boundaries) {
    const before = animatedNumbers(sampleStoryProgress(progress - 1e-6));
    const after = animatedNumbers(sampleStoryProgress(progress + 1e-6));
    for (let index = 0; index < before.length; index += 1) {
      assert.ok(Math.abs(before[index] - after[index]) < 0.002, `jump at ${progress}, value ${index}`);
    }
  }
});

test('the input takes over before the brand leaves, without a low-information gap', () => {
  for (let index = 0; index <= 270; index++) {
    const state = sampleStoryProgress(index / 1000);
    assert.ok(Math.max(state.modelOpacity, state.parts.composer.opacity) >= 0.7);
    if (state.modelOpacity < 0.5) assert.ok(state.parts.composer.opacity > 0.9);
  }
  assert.equal(sampleStoryProgress(0.06).composerHandoff, 0);
  assert.equal(sampleStoryProgress(0.27).composerHandoff, 1);
});

test('the download close changes copy while keeping the assembled product exactly at rest', () => {
  const resting = sampleStoryProgress(0.92);
  assert.equal(resting.closingOpacity, 0);
  assert.equal(sampleStoryProgress(1).closingOpacity, 1);
  for (let index = 920; index <= 1000; index++) {
    const state = sampleStoryProgress(index / 1000);
    assert.deepEqual(state.parts, resting.parts);
    assert.deepEqual(state.camera, resting.camera);
    assert.equal(state.assembled, true);
  }
});

test('the new headline never ghosts over the outgoing brand copy', () => {
  for (let index = 0; index <= 1000; index++) {
    const state = sampleStoryProgress(index / 1000);
    assert.equal(Math.min(state.introOpacity, state.copyEntrance), 0);
  }
  assert.ok(sampleStoryProgress(0.16).copyEntrance >= 0.49, 'the arriving headline must remain readable during the handoff');
  assert.equal(sampleStoryProgress(0.20).copyEntrance, 1);
});
