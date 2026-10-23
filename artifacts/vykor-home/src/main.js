import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';
import { mountProductDemo } from './product-demo.js';
import { STORY_STEPS, sampleStoryProgress } from './story/state.js';
import './product-demo.css';

gsap.registerPlugin(ScrollTrigger);
document.documentElement.classList.add('has-script');

const header = document.querySelector('.site-header');
const stage = document.querySelector('.optical-stage');
const hero = document.querySelector('.hero-story');
const workspace = document.querySelector('.workspace-scene');
const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)');
const eventLifetime = new AbortController();
const listen = (target, event, callback, options = {}) => target.addEventListener(event, callback, { ...options, signal: eventLifetime.signal });
const headerGithub = header.querySelector('.github-link');
const headerDownload = header.querySelector('.header-download');
const downloadOptions = header.querySelector('.header-download-options');
const downloadToggle = downloadOptions.querySelector('summary');

const closeDownloadOptions = (restoreFocus = false) => {
  downloadOptions.open = false;
  downloadToggle.setAttribute('aria-expanded', 'false');
  if (restoreFocus) downloadToggle.focus({ preventScroll: true });
};
listen(downloadOptions, 'toggle', () => {
  downloadToggle.setAttribute('aria-expanded', String(downloadOptions.open));
});
listen(document, 'pointerdown', event => {
  if (downloadOptions.open && !downloadOptions.contains(event.target)) closeDownloadOptions();
});
listen(document, 'keydown', event => {
  if (event.key !== 'Escape' || !downloadOptions.open) return;
  event.preventDefault();
  closeDownloadOptions(true);
});
listen(downloadOptions, 'focusout', event => {
  if (event.relatedTarget && !downloadOptions.contains(event.relatedTarget)) closeDownloadOptions();
});
listen(downloadOptions, 'click', event => {
  if (event.target.closest('a')) closeDownloadOptions();
});

// Hysteresis avoids a flashing surface when the wheel rests near the threshold.
let headerScrolled = false;
const updateHeader = () => {
  const next = scrollY > (headerScrolled ? 24 : 56);
  if (next === headerScrolled) return;
  headerScrolled = next;
  header.classList.toggle('is-scrolled', next);
  if (!next) {
    closeDownloadOptions();
    if (headerDownload.contains(document.activeElement)) headerGithub.focus({ preventScroll: true });
  }
  headerDownload.hidden = !next;
};
listen(window, 'scroll', updateHeader, { passive: true });
updateHeader();

const firstScene = document.querySelector('.first-scene');
const heroCopy = document.querySelector('.hero-copy');
const heroTitle = document.querySelector('#hero-title');
const heroFoot = document.querySelector('.hero-foot');
const poster = document.querySelector('.optical-poster');
const perspective = document.querySelector('.assembly-perspective');
const demoRoot = document.querySelector('#workbench');
const demo = mountProductDemo(demoRoot);
const fallbackCopy = document.querySelector('.story-fallback');
const copyRoot = document.querySelector('.story-copies');
copyRoot.innerHTML = STORY_STEPS.map(step => '<div class="story-step" data-step="' + step.id + '"><h2 id="step-' + step.id + '">' + step.title + '</h2><p>' + step.description + '</p></div>').join('');
const copies = [...copyRoot.children];
const caption = document.querySelector('#workspace-caption');
const skipStory = document.querySelector('.story-skip');
const storyFooter = document.querySelector('.story-footer');
const closing = document.querySelector('.story-closing');
const siteFooter = document.querySelector('.site-footer');

let optical = null;
let opticalRequest = 0;
let opticalLoading = null;
let requestedProgress = 0;
let destroyed = false;
const sampleModel = progress => {
  requestedProgress = progress;
  optical?.seek(progress);
};
async function loadOptical() {
  if (opticalLoading || optical || destroyed || prefersReduced.matches) return;
  const request = ++opticalRequest;
  opticalLoading = (async () => {
    try {
      const { createOptical } = await import('./optical.js');
      if (destroyed || request !== opticalRequest || prefersReduced.matches) return;
      const instance = await createOptical(stage);
      if (destroyed || request !== opticalRequest || prefersReduced.matches) {
        instance?.dispose();
        return;
      }
      optical = instance;
      optical?.seek(requestedProgress);
      optical?.setHandoff(0);
    } catch (error) {
      if (request === opticalRequest) {
        stage.classList.remove('is-ready');
        stage.dataset.renderer = 'poster';
        console.warn('Vykor: using the static brand image.', error);
      }
    }
  })();
  await opticalLoading;
  opticalLoading = null;
  if (!destroyed && !prefersReduced.matches && request !== opticalRequest) loadOptical();
}

const motion = gsap.matchMedia();
let initialHashApplied = false;
motion.add({
  mobile: '(max-width: 899px)',
  reduce: '(prefers-reduced-motion: reduce)',
  compact: '(max-height: 699px), (max-width: 559px) and (max-height: 799px)',
  fine: '(hover: hover) and (pointer: fine)',
}, context => {
  const { reduce, compact, fine } = context.conditions;
  const isStory = !reduce && !compact;
  const scopedEvents = new AbortController();
  const on = (target, event, callback, options = {}) => target.addEventListener(event, callback, { ...options, signal: scopedEvents.signal });
  let lenis;
  let tick;
  let story;
  let resizeFrame;
  let loadFrame;
  let width = 1;
  let height = 1;
  let lastProgress = 0;
  let phase = -1;
  let assembled;
  let bridgeX = 0;
  let bridgeY = 0;
  let copyBridgeY = 0;
  document.documentElement.classList.toggle('has-motion', isStory);
  copyRoot.hidden = !isStory;
  fallbackCopy.hidden = isStory;
  skipStory.hidden = !isStory;

  function render(progress) {
    lastProgress = progress;
    const state = sampleStoryProgress(progress);
    // The brand is a quiet introduction, not the camera that carries the story.
    sampleModel(isStory ? state.brandProgress : 0);
    if (isStory) {
      // The input is already present before the model leaves the same paper stage.
      gsap.set(heroCopy, { autoAlpha: state.introOpacity, y: -36 * state.introLift });
      gsap.set(heroFoot, { autoAlpha: state.introOpacity });
      gsap.set(stage, { autoAlpha: state.modelOpacity });
      firstScene.style.visibility = Math.max(state.introOpacity, state.modelOpacity) > .001 ? 'visible' : 'hidden';
      if (state.introOpacity < .01 && firstScene.contains(document.activeElement)) headerGithub.focus({ preventScroll: true });
      firstScene.inert = state.introOpacity < .01;
      firstScene.setAttribute('aria-hidden', String(firstScene.inert));
      workspace.style.opacity = '1';
      workspace.style.visibility = state.sceneOpacity > .001 ? 'visible' : 'hidden';
      workspace.style.pointerEvents = 'none';
      workspace.setAttribute('aria-hidden', String(state.sceneOpacity < .01));
    }
    const camera = state.camera;
    gsap.set(demo.machine, { x: camera.x * width, y: camera.y * height, scale: camera.scale, rotationX: camera.rotationX, rotationY: camera.rotationY });
    demo.machine.style.setProperty('--part-radius', state.partRadius + 'px');
    for (const [name, pose] of Object.entries(state.parts)) {
      const handoff = name === 'composer' ? 1 - state.composerHandoff : 0;
      gsap.set(demo.parts[name], { x: (pose.x + handoff * (bridgeX - .08)) * width, y: (pose.y + handoff * (bridgeY + .3)) * height, z: pose.z * width, scale: pose.scale, rotationX: pose.rotationX, rotationY: pose.rotationY, autoAlpha: pose.opacity });
    }
    if (isStory) copies.forEach((copy, index) => {
      const opacity = state.copyOpacities[index] * state.copyEntrance * (1 - state.closingOpacity);
      gsap.set(copy, { autoAlpha: opacity, y: (1 - state.copyEntrance) * copyBridgeY + (1 - state.copyOpacities[index]) * 10 });
      copy.setAttribute('aria-hidden', String(index !== state.phaseIndex || state.copyEntrance < .05 || state.closingOpacity > .5));
    });
    const activeElement = document.activeElement;
    const closeInactive = isStory && state.closingOpacity < .5;
    const utilityInactive = isStory && (state.closingOpacity > .5 || state.utilityOpacity < .01);
    // Enable destinations before handing focus away from a departing scene.
    if (!closeInactive) {
      closing.inert = false;
      siteFooter.inert = false;
    }
    if (!utilityInactive) storyFooter.inert = false;
    gsap.set(storyFooter, { autoAlpha: isStory ? state.utilityOpacity * (1 - state.closingOpacity) : 1 });
    gsap.set(closing, { autoAlpha: isStory ? state.closingOpacity : 1, y: isStory ? (1 - state.closingOpacity) * 12 : 0 });
    gsap.set(siteFooter, { autoAlpha: isStory ? state.closingOpacity : 1 });
    if (utilityInactive && storyFooter.contains(activeElement)) {
      (closeInactive ? headerGithub : closing.querySelector('a')).focus({ preventScroll: true });
    }
    if (closeInactive && (closing.contains(activeElement) || siteFooter.contains(activeElement))) {
      (utilityInactive ? headerGithub : skipStory).focus({ preventScroll: true });
    }
    storyFooter.inert = utilityInactive;
    closing.inert = closeInactive;
    siteFooter.inert = closeInactive;
    closing.setAttribute('aria-hidden', String(closeInactive));
    closing.style.pointerEvents = closeInactive ? 'none' : 'auto';
    if (isStory) workspace.setAttribute('aria-labelledby', state.closingOpacity > .5 ? 'download-title' : 'step-' + STORY_STEPS[state.phaseIndex].id);
    if (phase !== state.phaseIndex) {
      phase = state.phaseIndex;
      workspace.dataset.phase = STORY_STEPS[phase].id;
    }
    if (assembled !== state.assembled) {
      assembled = state.assembled;
      if (!assembled && demo.machine.contains(document.activeElement)) (utilityInactive ? headerGithub : skipStory).focus({ preventScroll: true });
      demo.setAssembled(assembled);
      demoRoot.style.pointerEvents = assembled ? 'auto' : 'none';
      caption.textContent = assembled ? '可操作的界面演示 · 内容为示例' : '代码构建的产品演示 · 内容为示例';
    }
    hero.dataset.storyProgress = progress.toFixed(4);
    hero.dataset.brandProgress = (isStory ? state.brandProgress : 0).toFixed(4);
  }

  function measure() {
    const narrow = innerWidth < 560;
    const aspect = narrow ? 4 / 5 : 16 / 10;
    width = Math.max(200, Math.min(1120, perspective.clientWidth * (isStory ? (narrow ? .98 : .9) : 1), perspective.clientHeight * aspect * (isStory ? .92 : 1)));
    height = width / aspect;
    demo.machine.style.width = width + 'px';
    demo.machine.style.height = height + 'px';
    // Read only on resize. The bridge starts at the model's actual screen region.
    const sceneRect = stage.getBoundingClientRect();
    const planeRect = perspective.getBoundingClientRect();
    const modelX = sceneRect.left + (narrow ? stage.clientWidth / 2 : poster.offsetLeft + poster.offsetWidth / 2);
    const modelY = sceneRect.top + (narrow ? (heroCopy.offsetTop + heroCopy.offsetHeight + 20 + heroFoot.offsetTop - 18) / 2 : poster.offsetTop + poster.offsetHeight / 2);
    bridgeX = (modelX - (planeRect.left + (perspective.clientWidth - width) / 2 + width * .42)) / width;
    bridgeY = (modelY - (planeRect.top + (perspective.clientHeight - height) / 2 + height * .865)) / height;
    const copySlot = document.querySelector('.story-copy-slot');
    copyBridgeY = Math.max(0, Math.min(160, heroCopy.offsetTop + heroTitle.offsetTop - copySlot.offsetTop - copies[0].querySelector('h2').offsetTop));
    render(isStory ? lastProgress : 1);
  }
  if (reduce) {
    opticalRequest++;
    optical?.dispose();
    optical = null;
    stage.classList.remove('is-ready');
    stage.dataset.renderer = 'poster';
  } else {
    if (!optical) loadOptical();
    if (fine) {
      // Let app panels scroll natively, then pass the wheel back to the page at their boundary.
      lenis = new Lenis({ lerp: .13, smoothWheel: true, syncTouch: false, allowNestedScroll: true });
      lenis.on('scroll', ScrollTrigger.update);
      tick = seconds => lenis.raf(seconds * 1000);
      gsap.ticker.add(tick);
    }
  }
  measure();
  if (isStory) {
    story = ScrollTrigger.create({
      trigger: hero, start: 'top top', end: 'bottom bottom',
      onUpdate: self => render(self.progress),
      onRefresh: self => { lastProgress = self.progress; measure(); },
    });
  } else {
    workspace.setAttribute('aria-labelledby', 'workspace-title');
    workspace.removeAttribute('aria-hidden');
  }
  const sizeObserver = new ResizeObserver(measure);
  sizeObserver.observe(perspective);
  const storyDistance = () => hero.offsetHeight - document.querySelector('.hero-stage').clientHeight;
  function goTo(target, { immediate = false, focus = false } = {}) {
    const inStory = isStory && (target === workspace || target === demoRoot || target === closing);
    const destination = inStory ? hero.offsetTop + storyDistance() * (target === closing ? .995 : target === demoRoot ? .925 : .27) : target;
    const readingInset = header.offsetTop + header.offsetHeight + 24;
    const finish = () => {
      if (!focus) return;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    };
    if (lenis) lenis.scrollTo(destination, { offset: typeof destination === 'number' ? 0 : -readingInset, immediate, onComplete: finish });
    else {
      const top = typeof destination === 'number' ? destination : target.getBoundingClientRect().top + scrollY - readingInset;
      window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
      finish();
    }
  }
  on(document, 'click', event => {
    const link = event.target.closest('a[href^="#"]');
    if (!link || event.button > 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = document.getElementById(link.hash.slice(1));
    if (!target) return;
    event.preventDefault();
    history.pushState(null, '', link.hash);
    goTo(target, { focus: true });
  });
  const restoreHashPosition = () => {
    const target = document.getElementById(location.hash.slice(1) || 'top');
    if (target) goTo(target, { immediate: true });
  };
  on(window, 'popstate', restoreHashPosition);
  on(window, 'hashchange', restoreHashPosition);
  if (document.readyState !== 'complete') on(window, 'load', () => {
    loadFrame = requestAnimationFrame(() => { ScrollTrigger.refresh(); lenis?.resize(); restoreHashPosition(); });
  }, { once: true });
  if (!reduce && fine) {
    on(firstScene, 'pointermove', event => {
      if (isStory && lastProgress > .20) return;
      const rect = stage.getBoundingClientRect();
      optical?.setAim?.((event.clientX - rect.left) / rect.width * 2 - 1, (event.clientY - rect.top) / rect.height * 2 - 1);
    }, { passive: true });
    on(firstScene, 'pointerleave', () => optical?.setAim?.(0, 0));
  }
  resizeFrame = requestAnimationFrame(() => {
    ScrollTrigger.refresh();
    if (!initialHashApplied) { initialHashApplied = true; restoreHashPosition(); }
  });
  return () => {
    cancelAnimationFrame(resizeFrame);
    cancelAnimationFrame(loadFrame);
    scopedEvents.abort();
    sizeObserver.disconnect();
    if (tick) gsap.ticker.remove(tick);
    lenis?.destroy();
    story?.kill();
    firstScene.style.cssText = '';
    firstScene.inert = false;
    firstScene.removeAttribute('aria-hidden');
    gsap.set([heroCopy, heroFoot, stage], { clearProps: 'opacity,visibility,transform' });
    workspace.style.cssText = '';
    workspace.removeAttribute('aria-hidden');
    document.documentElement.classList.remove('has-motion');
  };
});

listen(window, 'pagehide', event => {
  if (event.persisted) return;
  destroyed = true;
  opticalRequest++;
  optical?.dispose();
  motion.revert();
  demo.destroy();
  eventLifetime.abort();
});
