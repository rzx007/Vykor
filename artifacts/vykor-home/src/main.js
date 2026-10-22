import gsap from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import Lenis from 'lenis';

gsap.registerPlugin(ScrollTrigger);

const menu = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');
function closeMenu() {
  menu.setAttribute('aria-expanded', 'false');
  navigation.classList.remove('is-open');
}
menu.addEventListener('click', () => {
  const open = menu.getAttribute('aria-expanded') !== 'true';
  menu.setAttribute('aria-expanded', String(open));
  navigation.classList.toggle('is-open', open);
});
navigation.addEventListener('click', event => { if (event.target.closest('a')) closeMenu(); });
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') { closeMenu(); menu.focus(); }
});
document.addEventListener('pointerdown', event => { if (!event.target.closest('.site-header')) closeMenu(); });
document.querySelector('.sources').addEventListener('toggle', () => ScrollTrigger.refresh());

let optical = null;
let requestedProgress = 0;
const prefersReduced = matchMedia('(prefers-reduced-motion: reduce)');
const stage = document.querySelector('.optical-stage');
const sampleModel = progress => {
  requestedProgress = progress;
  optical?.seek(progress);
};

// Load the expensive renderer separately; all copy, links and posters work before it.
if (!prefersReduced.matches) {
  import('./optical.js').then(async ({ createOptical }) => {
    optical = await createOptical(stage);
    optical?.seek(requestedProgress);
  }).catch(error => {
    console.warn('Vykor: static brand image remains available.', error);
    stage.dataset.renderer = 'poster';
  });
}

const media = gsap.matchMedia();
media.add({ desktop: '(min-width: 800px)', mobile: '(max-width: 799px)', reduce: '(prefers-reduced-motion: reduce)' }, context => {
  if (context.conditions.reduce) {
    sampleModel(1);
    stage.classList.remove('is-ready');
    return;
  }
  document.documentElement.classList.add('has-motion');
  const mobile = context.conditions.mobile;
  const lenis = new Lenis({ lerp: 0.16, smoothWheel: true, syncTouch: false, anchors: { offset: -28 } });
  lenis.on('scroll', ScrollTrigger.update);
  const tick = seconds => lenis.raf(seconds * 1000);
  gsap.ticker.add(tick);
  const workspaceLink = document.querySelector('a[href="#workspace"]');
  const endOfHero = () => document.querySelector('.hero-story').offsetTop + document.querySelector('.hero-story').offsetHeight - document.querySelector('.hero-stage').clientHeight;
  const enterWorkspace = event => {
    event.preventDefault();
    event.stopPropagation();
    lenis.scrollTo(endOfHero());
    history.replaceState(null, '', '#workspace');
  };
  workspaceLink.addEventListener('click', enterWorkspace);

  const model = { progress: 0 };
  gsap.set('.workspace-scene', { autoAlpha: 0, y: mobile ? 50 : 70 });
  gsap.set('.workspace-figure', { scale: 0.89, transformOrigin: '50% 100%' });

  const story = gsap.timeline({
    defaults: { ease: 'none' },
    scrollTrigger: {
      trigger: '.hero-story', start: 'top top', end: 'bottom bottom', scrub: true,
      invalidateOnRefresh: true,
    },
  });
  story.to(model, { progress: 1, duration: .65, onUpdate: () => sampleModel(model.progress) }, 0)
    .to('.hero-copy', { y: mobile ? -24 : -42, autoAlpha: 0, duration: .22 }, .06)
    .to('.hero-foot', { autoAlpha: 0, duration: .12 }, 0)
    .to('.optical-stage', { xPercent: mobile ? -31 : -93, yPercent: mobile ? -33 : -20, scale: mobile ? .12 : .09, duration: .47 }, .38)
    .to('.optical-stage', { autoAlpha: 0, duration: .14 }, .72)
    .to('.workspace-scene', { autoAlpha: 1, y: 0, duration: .28 }, .54)
    .to('.workspace-figure', { scale: 1, duration: .42 }, .58);

  document.querySelectorAll('main > section:not(.hero-story)').forEach(section => {
    const parts = section.querySelectorAll('.reveal');
    gsap.from(parts, {
      y: section.id === 'coding' ? 28 : 20, opacity: 0, duration: .85,
      stagger: .085, ease: 'power3.out',
      scrollTrigger: { trigger: section, start: 'top 88%', once: true },
    });
  });
  const hash = location.hash;
  if (hash && hash !== '#top') requestAnimationFrame(() => lenis.scrollTo(hash === '#workspace' ? endOfHero() : hash, { immediate: true }));
  ScrollTrigger.refresh();
  return () => {
    gsap.ticker.remove(tick);
    workspaceLink.removeEventListener('click', enterWorkspace);
    lenis.destroy();
    story.kill();
    document.documentElement.classList.remove('has-motion');
  };
});

document.querySelectorAll('img').forEach(img => {
  if (!img.complete) img.addEventListener('load', () => ScrollTrigger.refresh(), { once: true });
});
window.addEventListener('pagehide', event => { if (!event.persisted) { optical?.dispose(); media.revert(); } });
