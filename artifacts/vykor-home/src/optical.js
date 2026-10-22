import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { fitCameraToBox } from './framing.js';
import { chooseRenderQuality } from './render-quality.js';

const GROUND = 0xeeebe4;
const CAMERA_FOV = 35;
const REFINE_AFTER_MS = 160;
export const PAPER_SIZE = 400;
export const CAMERA_FAR = 200;

// The light cards are photographed into the reflection map, never drawn as page decoration.
function createStudio(renderer) {
  const studio = new THREE.Scene();
  studio.background = new THREE.Color(GROUND);
  const shell = new THREE.Mesh(
    new THREE.BoxGeometry(30, 24, 24),
    new THREE.MeshBasicMaterial({ color: 0x979386, side: THREE.BackSide }),
  );
  studio.add(shell);
  const cards = [
    { size: [7, 12], at: [-8, 2, 3], color: 0xfff5e2, strength: 2.5 },
    { size: [2, 14], at: [8, 1, 5], color: 0xfffdf5, strength: 4.5 },
    { size: [10, 8], at: [0, 9, -1], color: 0xf2eadb, strength: 2.6 },
    { size: [8, 3], at: [1, -4, -8], color: 0xa8ad98, strength: 1.1 },
  ];
  for (const card of cards) {
    const light = new THREE.Mesh(
      new THREE.PlaneGeometry(...card.size),
      new THREE.MeshBasicMaterial({
        color: new THREE.Color(card.color).multiplyScalar(card.strength),
        side: THREE.DoubleSide,
      }),
    );
    light.position.set(...card.at);
    light.lookAt(0, 0, 0);
    studio.add(light);
  }
  const pmrem = new THREE.PMREMGenerator(renderer);
  try {
    return pmrem.fromScene(studio, .035, .1, 60);
  } finally {
    studio.traverse(object => {
      object.geometry?.dispose();
      object.material?.dispose();
    });
    pmrem.dispose();
  }
}

function disposeMaterials(materials) {
  const textures = new Set();
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value?.isTexture) textures.add(value);
    }
    material.dispose();
  }
  for (const texture of textures) texture.dispose();
}

export async function createOptical(container) {
  const fallback = { seek() {}, setAim() {}, setHandoff() {}, dispose() {} };
  const canvas = container?.querySelector('#optical-canvas');
  if (!canvas) return fallback;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
  const showPoster = () => {
    container.classList.remove('is-ready');
    container.dataset.renderer = 'poster';
    container.querySelector('.vgpu-light-canvas')?.setAttribute('hidden', '');
  };
  showPoster();
  // An existing poster is the complete reduced-motion and unsupported-device experience.
  if (reduced.matches) return fallback;

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'low-power',
      preserveDrawingBuffer: false,
    });
  } catch {
    return fallback;
  }

  const scene = new THREE.Scene();
  // Transmission needs a real scene behind the glass; CSS outside the canvas cannot be refracted.
  scene.background = new THREE.Color(GROUND);
  const camera = new THREE.PerspectiveCamera(CAMERA_FOV, 1, .05, CAMERA_FAR);
  const group = new THREE.Group();
  scene.add(group);
  const key = new THREE.DirectionalLight(0xfff4df, 1.6);
  key.position.set(-6, 8, 9);
  key.castShadow = true;
  key.shadow.mapSize.set(1024, 1024);
  key.shadow.camera.left = -8; key.shadow.camera.right = 8;
  key.shadow.camera.top = 8; key.shadow.camera.bottom = -8;
  key.shadow.camera.near = .5; key.shadow.camera.far = 35;
  key.shadow.bias = -.0003;
  key.shadow.normalBias = .025;
  key.shadow.radius = 4;
  const fill = new THREE.DirectionalLight(0xf1f0e6, .95);
  fill.position.set(6, 1, 4);
  const ambient = new THREE.AmbientLight(0xf8f1e4, 1.2);
  // A capped model region exposes much more of the wall on wide screens.
  const shadowGeometry = new THREE.PlaneGeometry(PAPER_SIZE, PAPER_SIZE);
  const shadowMaterial = new THREE.MeshStandardMaterial({ color: GROUND, roughness: 1, metalness: 0, envMapIntensity: .3 });
  const shadowReceiver = new THREE.Mesh(shadowGeometry, shadowMaterial);
  shadowReceiver.receiveShadow = true;
  shadowReceiver.position.z = -2.1;
  scene.add(key, fill, ambient, shadowReceiver);

  let gltf;
  let mixer;
  let clip;
  let environment;
  let resize;
  let visibility;
  let progress = 0;
  let handoff = 0;
  let frame = 0;
  let refinementTimer = 0;
  let settled = false;
  let nativeSamples = 0;
  let active = true;
  let contextLost = false;
  let disposed = false;
  let failed = false;
  let lastWidth = 0;
  let lastHeight = 0;
  let lastDpr = 0;
  let lightEffect;
  let lightCanvas;
  const aim = new THREE.Vector2();
  const endSize = new THREE.Vector3();
  const endCenter = new THREE.Vector3();
  const direction = new THREE.Vector3();
  const currentBounds = new THREE.Box3();
  const textures = new Set();
  const materials = new Set();
  const geometries = new Set();
  materials.add(shadowMaterial);
  geometries.add(shadowGeometry);

  function configureRenderer() {
    renderer.setClearColor(GROUND, 0);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setPixelRatio(1);
    renderer.setRenderTarget(null);
    const context = renderer.getContext();
    nativeSamples = context.getParameter(context.SAMPLES) || 0;
    container.dataset.antialiasSamples = String(nativeSamples);
    lastWidth = lastHeight = lastDpr = 0;
  }

  function updateEnvironment() {
    const nextEnvironment = createStudio(renderer);
    const previousEnvironment = environment;
    environment = nextEnvironment;
    scene.environment = environment.texture;
    previousEnvironment?.dispose();
  }

  async function loadLightEffect() {
    container.dataset.lightRenderer = 'loading';
    try {
      const { createVgpuLight } = await import('./vgpu-light.js');
      if (disposed || reduced.matches) return;
      lightCanvas = document.createElement('canvas');
      lightCanvas.className = 'vgpu-light-canvas';
      lightCanvas.setAttribute('aria-hidden', 'true');
      lightCanvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;pointer-events:none;';
      container.append(lightCanvas);
      const hideLight = status => {
        if (disposed) return;
        container.dataset.lightRenderer = status;
        lightCanvas?.setAttribute('hidden', '');
      };
      const instance = await createVgpuLight({
        canvas: lightCanvas,
        onError: () => hideLight('error'),
        onLost: () => hideLight('device-lost'),
      });
      if (disposed || reduced.matches) {
        instance?.dispose();
        lightCanvas?.remove();
        return;
      }
      if (!instance) {
        hideLight('unsupported');
        lightCanvas.remove();
        return;
      }
      lightEffect = instance;
      container.dataset.lightRenderer = 'vgpu';
      requestDraw();
    } catch (error) {
      lightCanvas?.remove();
      if (!disposed) {
        container.dataset.lightRenderer = 'unavailable';
        console.warn('Vykor: keeping the model without the WebGPU light layer.', error);
      }
    }
  }

  function canDraw() {
    return !disposed && !failed && !contextLost && !!gltf && !!mixer && !!clip && !!environment
      && active && !document.hidden && !reduced.matches;
  }

  function requestDraw() {
    settled = false;
    clearTimeout(refinementTimer);
    refinementTimer = 0;
    if (!canDraw()) return;
    if (!frame) frame = requestAnimationFrame(draw);
    // One sharper frame after input stops; no permanent render loop or temporal history.
    refinementTimer = window.setTimeout(() => {
      refinementTimer = 0;
      if (!canDraw()) return;
      settled = true;
      if (!frame) frame = requestAnimationFrame(draw);
    }, REFINE_AFTER_MS);
  }

  function stopFrame() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
    clearTimeout(refinementTimer);
    refinementTimer = 0;
  }

  function draw() {
    frame = 0;
    if (!canDraw()) return;
    // Layout dimensions stay stable while ScrollTrigger transforms the surrounding stage.
    const width = container.clientWidth;
    const height = container.clientHeight;
    if (!width || !height) return;
    const mobile = window.innerWidth < 800;
    const quality = chooseRenderQuality({
      width, height, devicePixelRatio: window.devicePixelRatio || 1,
      mobile, settled, samples: nativeSamples,
      maxTextureSize: renderer.capabilities.maxTextureSize,
    });
    const dpr = quality.pixelRatio;
    try {
      if (width !== lastWidth || height !== lastHeight || dpr !== lastDpr) {
        renderer.setPixelRatio(dpr);
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        camera.updateProjectionMatrix();
        lastWidth = width;
        lastHeight = height;
        lastDpr = dpr;
      }
      renderer.transmissionResolutionScale = quality.transmissionResolutionScale;

      // One scroll position always produces one still frame, including when scrubbing backwards.
      mixer.setTime(progress * Math.max(0, clip.duration - .00001));
      const travel = THREE.MathUtils.smoothstep(progress, 0, 1);
      shadowReceiver.position.z = THREE.MathUtils.lerp(-2.1, endCenter.z - endSize.z * .5 - .08, travel);
      group.rotation.set(
        THREE.MathUtils.lerp(-.025, 0, travel),
        THREE.MathUtils.lerp(-.08, 0, travel),
        THREE.MathUtils.lerp(-.025, 0, travel),
      );
      group.updateMatrixWorld(true);
      currentBounds.setFromObject(group);
      direction.set(
        THREE.MathUtils.lerp(.38, -.035, travel) + aim.x * .025,
        THREE.MathUtils.lerp(.13, .012, travel) - aim.y * .02,
        1,
      );
      const narrow = window.innerWidth < 560;
      const firstScene = container.closest('.first-scene');
      const copy = firstScene.querySelector('.hero-copy');
      const foot = firstScene.querySelector('.hero-foot');
      const poster = container.querySelector('.optical-poster');
      const narrowTop = copy.offsetTop + copy.offsetHeight + 20;
      const region = narrow
        ? { left: 22, top: narrowTop, width: width - 44, height: Math.max(120, foot.offsetTop - narrowTop - 18) }
        // The poster and canvas share an absolute-positioned parent. Read layout
        // coordinates so CSS width caps also frame WebGL, even while the poster is hidden.
        : { left: poster.offsetLeft, top: poster.offsetTop, width: poster.offsetWidth, height: poster.offsetHeight };
      const scale = THREE.MathUtils.lerp(1, .23, handoff);
      const centerX = region.left + region.width / 2;
      const centerY = region.top + region.height / 2 + height * .12 * handoff;
      const modelRegion = { left: centerX - region.width * scale / 2, top: centerY - region.height * scale / 2, width: region.width * scale, height: region.height * scale };
      fitCameraToBox(camera, currentBounds, direction, {
        width, height,
        region: modelRegion,
        padding: .08,
      });
      renderer.render(scene, camera);
      if (lightEffect && container.dataset.lightRenderer === 'vgpu') {
        try {
          lightCanvas.removeAttribute('hidden');
          lightEffect.draw({ width, height, progress, handoff, region: modelRegion, aim: [aim.x, aim.y], dpr: Math.min(dpr, 1.5) });
        } catch (error) {
          container.dataset.lightRenderer = 'error';
          lightCanvas.setAttribute('hidden', '');
          lightEffect.dispose();
          lightEffect = null;
          console.warn('Vykor: keeping the model without the WebGPU light layer.', error);
        }
      }
      container.classList.add('is-ready');
      container.dataset.renderer = 'webgl';
      container.dataset.renderQuality = settled ? 'settled' : 'interactive';
      container.dataset.renderScale = dpr.toFixed(3);
    } catch {
      failed = true;
      stopFrame();
      showPoster();
    }
  }

  function onVisibilityChange() {
    if (document.hidden) stopFrame();
    else requestDraw();
  }

  function onReducedChange() {
    if (reduced.matches) {
      stopFrame();
      showPoster();
    } else requestDraw();
  }

  function onContextLost(event) {
    event.preventDefault();
    contextLost = true;
    stopFrame();
    showPoster();
  }

  function onContextRestored() {
    if (disposed) return;
    contextLost = false;
    failed = false;
    try {
      configureRenderer();
      updateEnvironment();
      requestDraw();
    } catch {
      failed = true;
      showPoster();
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    stopFrame();
    resize?.disconnect();
    visibility?.disconnect();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    reduced.removeEventListener('change', onReducedChange);
    canvas.removeEventListener('webglcontextlost', onContextLost);
    canvas.removeEventListener('webglcontextrestored', onContextRestored);
    mixer?.stopAllAction();
    lightEffect?.dispose();
    lightEffect = null;
    lightCanvas?.remove();
    if (gltf) mixer?.uncacheRoot(gltf.scene);
    for (const geometry of geometries) geometry.dispose();
    disposeMaterials(materials);
    for (const texture of textures) texture.dispose();
    textures.clear();
    materials.clear();
    geometries.clear();
    scene.environment = null;
    environment?.dispose();
    key.shadow.dispose();
    scene.clear();
    renderer.dispose();
    showPoster();
  }

  canvas.addEventListener('webglcontextlost', onContextLost);
  canvas.addEventListener('webglcontextrestored', onContextRestored);

  try {
    configureRenderer();
    updateEnvironment();
    gltf = await new GLTFLoader().loadAsync(import.meta.env.BASE_URL + 'media/vykor-optical-mark.glb');
    group.add(gltf.scene);
    // Composite the same local paper image into a real wall so glass can refract its texture.
    const grain = await new THREE.TextureLoader().loadAsync(import.meta.env.BASE_URL + 'media/paper-grain.png');
    const paperCanvas = document.createElement('canvas');
    paperCanvas.width = paperCanvas.height = 480;
    const paperContext = paperCanvas.getContext('2d');
    if (!paperContext) { grain.dispose(); throw new Error('Paper material canvas is unavailable.'); }
    paperContext.fillStyle = '#eeebe4';
    paperContext.fillRect(0, 0, 480, 480);
    paperContext.drawImage(grain.image, 0, 0, 480, 480);
    grain.dispose();
    const paper = new THREE.CanvasTexture(paperCanvas);
    paper.colorSpace = THREE.SRGBColorSpace;
    paper.wrapS = paper.wrapT = THREE.RepeatWrapping;
    const paperRepeats = 18 * PAPER_SIZE / 70;
    paper.repeat.set(paperRepeats, paperRepeats);
    paper.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
    textures.add(paper);
    shadowMaterial.color.set(0xffffff);
    shadowMaterial.map = paper;
    shadowMaterial.bumpMap = paper;
    shadowMaterial.bumpScale = .012;
    shadowMaterial.needsUpdate = true;
    const glass = new THREE.MeshPhysicalMaterial({
      name: 'Vykor warm clear glass',
      color: 0xfffcf3,
      roughness: .09,
      metalness: 0,
      transmission: 1,
      side: THREE.DoubleSide,
      thickness: .48,
      ior: 1.52,
      dispersion: 0,
      attenuationColor: new THREE.Color(0xe7e3d3),
      attenuationDistance: 8,
      clearcoat: 1,
      clearcoatRoughness: .045,
      envMapIntensity: 1.1,
    });
    const silver = new THREE.MeshPhysicalMaterial({
      name: 'Vykor brushed warm silver',
      color: 0xcac7bc,
      metalness: 1,
      roughness: .25,
      clearcoat: .7,
      clearcoatRoughness: .12,
      envMapIntensity: 1.05,
    });
    const robot = new THREE.MeshPhysicalMaterial({
      name: 'Vykor warm porcelain',
      color: 0xf5f0df,
      metalness: .04,
      roughness: .28,
      transmission: 0,
      thickness: .34,
      ior: 1.38,
      attenuationColor: new THREE.Color(0xe4dfcc),
      attenuationDistance: 2.8,
      clearcoat: 1,
      clearcoatRoughness: .08,
      envMapIntensity: 1.2,
    });
    const robotDetail = new THREE.MeshPhysicalMaterial({
      name: 'Vykor robot inset',
      color: 0x575d4b,
      metalness: .25,
      roughness: .35,
      envMapIntensity: 1.4,
    });
    for (const material of [glass, silver, robot, robotDetail]) materials.add(material);

    gltf.scene.traverse(object => {
      if (object.name.startsWith('Lime_Inlay')) object.visible = false;
      if (!object.isMesh) return;
      object.castShadow = true;
      geometries.add(object.geometry);
      let node = object;
      let isRobot = false;
      while (node && node !== gltf.scene) {
        if (node.name.startsWith('Robot_Face')) isRobot = true;
        node = node.parent;
      }
      const replace = original => {
        materials.add(original);
        if (original.name.includes('Optical_Glass')) return glass;
        if (isRobot) return original.name.includes('Lime_Core') ? robot : robotDetail;
        return silver;
      };
      object.material = Array.isArray(object.material)
        ? object.material.map(replace)
        : replace(object.material);
    });

    // The source face has two open holes. A recessed backing keeps both eyes readable in daylight.
    const face = gltf.scene.getObjectByName('Robot_Face');
    if (face) {
      const eyeGeometry = new THREE.PlaneGeometry(.94, .82);
      const eyeMaterial = new THREE.MeshBasicMaterial({ color: 0x3d4434, side: THREE.DoubleSide });
      const eyeBacking = new THREE.Mesh(eyeGeometry, eyeMaterial);
      eyeBacking.name = 'Robot_Recessed_Eye_Backing';
      eyeBacking.rotation.x = -Math.PI / 2;
      eyeBacking.position.y = .14;
      face.add(eyeBacking);
      geometries.add(eyeGeometry);
      materials.add(eyeMaterial);
    }

    clip = THREE.AnimationClip.findByName(gltf.animations, 'scrollani');
    if (!clip) throw new Error('The brand model is missing its scrollani animation.');
    mixer = new THREE.AnimationMixer(gltf.scene);
    const action = mixer.clipAction(clip);
    action.setLoop(THREE.LoopOnce, 1);
    action.clampWhenFinished = true;
    action.play();
    // Fit the complete final mark, rather than guessing a distance for each screen ratio.
    mixer.setTime(Math.max(0, clip.duration - .00001));
    gltf.scene.updateMatrixWorld(true);
    const bounds = new THREE.Box3().setFromObject(gltf.scene);
    bounds.getSize(endSize);
    bounds.getCenter(endCenter);
    mixer.setTime(0);

    resize = new ResizeObserver(requestDraw);
    resize.observe(container);
    visibility = new IntersectionObserver(entries => {
      active = entries[0]?.isIntersecting ?? false;
      if (active) requestDraw();
      else stopFrame();
    });
    visibility.observe(container);
    document.addEventListener('visibilitychange', onVisibilityChange);
    reduced.addEventListener('change', onReducedChange);
    requestDraw();
    void loadLightEffect();
  } catch {
    dispose();
    return fallback;
  }

  return {
    seek(value) {
      if (!Number.isFinite(value)) return;
      const next = THREE.MathUtils.clamp(value, 0, 1);
      if (next === progress) return;
      progress = next;
      requestDraw();
    },
    setAim(x, y) {
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const nextX = THREE.MathUtils.clamp(x, -1, 1);
      const nextY = THREE.MathUtils.clamp(y, -1, 1);
      if (nextX === aim.x && nextY === aim.y) return;
      aim.set(nextX, nextY);
      requestDraw();
    },
    setHandoff(value) {
      if (!Number.isFinite(value)) return;
      const next = THREE.MathUtils.clamp(value, 0, 1);
      if (next === handoff) return;
      handoff = next;
      requestDraw();
    },
    dispose,
  };
}
