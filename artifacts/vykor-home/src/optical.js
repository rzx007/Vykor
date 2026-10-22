import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export async function createOptical(container) {
  const canvas = container.querySelector('canvas');
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'low-power' });
  } catch {
    container.dataset.renderer = 'poster';
    return null;
  }
  const reduced = matchMedia('(prefers-reduced-motion: reduce)');
  const camera = new THREE.PerspectiveCamera(35, 1, .1, 80);
  const scene = new THREE.Scene();
  const group = new THREE.Group();
  scene.add(group);
  renderer.setPixelRatio(Math.min(devicePixelRatio, innerWidth < 800 ? 1.15 : 1.5));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, .04);
  scene.environment = environment.texture;
  room.dispose();
  pmrem.dispose();

  let gltf;
  try { gltf = await new GLTFLoader().loadAsync('/media/vykor-optical-mark.glb'); }
  catch (error) { environment.dispose(); renderer.dispose(); throw error; }
  group.add(gltf.scene);
  gltf.scene.traverse(object => {
    if (object.name.startsWith('Lime_Inlay')) object.visible = false;
    if (!object.isMesh) return;
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      material.envMapIntensity = 1.5;
      if (material.transmission > .5) {
        material.roughness = .065;
        material.thickness = .26;
        material.ior = 1.48;
        material.dispersion = .35;
      }
    }
  });
  const clip = THREE.AnimationClip.findByName(gltf.animations, 'scrollani');
  if (!clip) {
    environment.dispose(); renderer.dispose();
    throw new Error('The brand model is missing its scrollani animation.');
  }
  const mixer = new THREE.AnimationMixer(gltf.scene);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopOnce, 1);
  action.clampWhenFinished = true;
  action.play();

  let progress = 0;
  let frame = 0;
  let active = true;
  let disposed = false;
  function draw() {
    frame = 0;
    if (disposed || !active || document.hidden || reduced.matches) return;
    const { width, height } = container.getBoundingClientRect();
    // CSS transforms affect the rectangle; use layout dimensions for a stable render resolution.
    const w = container.clientWidth || width, h = container.clientHeight || height;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * renderer.getPixelRatio()) || canvas.height !== Math.round(h * renderer.getPixelRatio())) renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.position.set(0, 0, THREE.MathUtils.lerp(innerWidth < 800 ? 15.5 : 16, 8.8, progress));
    camera.updateProjectionMatrix();
    mixer.setTime(progress * (clip.duration - .00001));
    group.rotation.set(THREE.MathUtils.lerp(-.08, .02, progress), THREE.MathUtils.lerp(.32, -.12, progress), -.025);
    renderer.render(scene, camera);
    container.classList.add('is-ready');
    container.dataset.renderer = 'webgl';
  }
  function requestDraw() { if (!frame && !disposed) frame = requestAnimationFrame(draw); }
  const resize = new ResizeObserver(requestDraw);
  resize.observe(container);
  const visibility = new IntersectionObserver(entries => { active = entries[0].isIntersecting; if (active) requestDraw(); });
  visibility.observe(container);
  document.addEventListener('visibilitychange', requestDraw);
  reduced.addEventListener('change', requestDraw);
  canvas.addEventListener('webglcontextlost', event => {
    event.preventDefault(); container.classList.remove('is-ready'); container.dataset.renderer = 'poster';
  });
  canvas.addEventListener('webglcontextrestored', requestDraw);
  requestDraw();
  return {
    seek(value) { progress = THREE.MathUtils.clamp(value, 0, 1); requestDraw(); },
    dispose() {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect(); visibility.disconnect();
      document.removeEventListener('visibilitychange', requestDraw);
      reduced.removeEventListener('change', requestDraw);
      mixer.stopAllAction(); mixer.uncacheRoot(gltf.scene);
      gltf.scene.traverse(object => {
        if (object.isMesh) {
          object.geometry.dispose();
          for (const material of Array.isArray(object.material) ? object.material : [object.material]) material.dispose();
        }
      });
      environment.dispose(); renderer.dispose();
    },
  };
}
