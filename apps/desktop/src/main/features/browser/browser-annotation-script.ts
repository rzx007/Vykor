import type { PageAnnotationCommand } from "../../../shared/browser-annotation"
import selectorRuntime from "virtual:browser-annotation-selector"

export const BROWSER_ANNOTATION_WORLD_ID = 1004

// Keep the page program self-contained: compiling Main must not introduce captured helpers into it.
const PAGE_PROGRAM = String.raw`function(command) {
  const key = '__vykorAnnotations';
  const s = window[key] || (window[key] = {
    version: 0, mode: 'off', seq: 0, next: 0, root: null, shadow: null, frame: null, label: null,
    hover: null, selected: null, focused: null, handles: new Map(), bindings: new Map(),
    markers: [], markerViews: [], shields: [], listeners: [], raf: 0
  });
  const rect = el => {
    if (!el || !el.isConnected) return null;
    const r = el.getBoundingClientRect();
    const css = getComputedStyle(el);
    if (!r.width || !r.height || css.visibility === 'hidden' || css.display === 'none') return null;
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };
  const visible = r => r && r.x + r.width > 0 && r.y + r.height > 0 && r.x < innerWidth && r.y < innerHeight;
  const name = el => {
    const editable = el.matches('input,textarea,select,[contenteditable],[role=textbox]');
    const labels = Array.from(el.labels || []).slice(0, 4).map(label => {
      const copy = label.cloneNode(true);
      copy.querySelectorAll('input,textarea,select,[contenteditable]').forEach(child => child.remove());
      return copy.textContent || '';
    }).join(' ');
    return (el.getAttribute('aria-label') || el.getAttribute('title') || labels || (editable ? el.getAttribute('placeholder') : el.innerText || el.textContent) || '').trim().replace(/\s+/g, ' ').slice(0, 180);
  };
  const role = el => el.getAttribute('role') || ({ BUTTON: 'button', A: 'link', INPUT: 'textbox', TEXTAREA: 'textbox', SELECT: 'combobox' }[el.tagName] || el.tagName.toLowerCase());
  const describe = el => {
    if (!rect(el) || el === document.documentElement || el === document.body || el === s.root) return null;
    const tagName = el.tagName.toLowerCase();
    const n = name(el), r = role(el);
    return { target: (r + (n ? ': ' + n : '')).slice(0, 200), tagName, role: r, name: n };
  };
  const matches = (el, target) => el && el.isConnected && el.tagName.toLowerCase() === target.tagName && role(el) === target.role && (!target.name || name(el) === target.name);
  const resolve = marker => {
    let el = s.bindings.get(marker.id) || (marker.handleId && s.handles.get(marker.handleId));
    if (el && el.isConnected) return el;
    if (marker.locatorKind !== 'unique-id' && marker.locatorKind !== 'semantic') return null;
    try {
      const candidates = document.querySelectorAll(marker.selector);
      el = candidates.length === 1 ? candidates[0] : null;
      if (matches(el, marker)) { s.bindings.set(marker.id, el); return el; }
    } catch {}
    return null;
  };
  const locate = marker => {
    const r = rect(resolve(marker));
    return { id: marker.id, status: !r ? 'missing' : visible(r) ? 'visible' : 'offscreen', rect: r };
  };
  const paintRect = (node, r) => {
    node.style.display = visible(r) ? 'block' : 'none';
    if (r) Object.assign(node.style, { left: r.x + 'px', top: r.y + 'px', width: r.width + 'px', height: r.height + 'px' });
  };
  const draw = () => {
    if (!s.root || s.mode === 'off') return;
    const focusedMarker = s.focused && s.markers.find(marker => marker.id === s.focused);
    const chosen = s.selected ? s.handles.get(s.selected.handleId) : focusedMarker ? resolve(focusedMarker) : s.mode === 'pick' ? s.hover : null;
    const r = rect(chosen);
    paintRect(s.frame, r);
    s.label.style.display = visible(r) ? 'block' : 'none';
    if (r) {
      s.label.textContent = (s.selected ? '已选中 · ' : '') + (describe(chosen)?.target || '页面元素');
      s.label.style.left = Math.max(4, Math.min(r.x, innerWidth - 180)) + 'px';
      s.label.style.top = Math.max(4, r.y >= 28 ? r.y - 26 : r.y + 4) + 'px';
    }
    s.markerViews.forEach(({ marker, node }, index) => {
      const item = locate(marker), r = item.rect;
      node.style.display = item.status === 'visible' ? 'block' : 'none';
      node.textContent = String(index + 1);
      if (r) Object.assign(node.style, { left: Math.max(0, Math.min(r.x + r.width - 10, innerWidth - 24)) + 'px', top: Math.max(0, Math.min(r.y - 10, innerHeight - 24)) + 'px' });
    });
    s.shields.forEach(({ el, node }) => paintRect(node, s.mode === 'pick' ? rect(el) : null));
  };
  const schedule = () => { if (!s.raf) s.raf = requestAnimationFrame(() => { s.raf = 0; draw(); }); };
  const cleanup = () => {
    s.listeners.forEach(([type, listener]) => window.removeEventListener(type, listener, true));
    s.listeners = []; cancelAnimationFrame(s.raf); s.raf = 0;
    s.root?.remove(); s.root = null; s.shadow = null; s.markerViews = []; s.shields = [];
    s.mode = 'off'; s.selected = null; s.hover = null; s.focused = null;
    const retained = new Set(s.bindings.values());
    for (const [id, el] of s.handles) if (!retained.has(el)) s.handles.delete(id);
  };
  const snapshot = () => {
    draw();
    const el = s.selected && s.handles.get(s.selected.handleId), r = rect(el);
    return { mode: s.mode, interactionVersion: s.version, eventSequence: s.seq,
      selected: r && matches(el, s.selected) ? { ...s.selected, rect: r } : null,
      focusedAnnotationId: s.focused, viewport: { width: innerWidth, height: innerHeight }, markers: s.markers.map(locate) };
  };
  if (command.interactionVersion < s.version) return snapshot();
  if (command.action === 'stop') { cleanup(); s.version = command.interactionVersion; return snapshot(); }
  if (command.action === 'install') {
    cleanup(); s.version = command.interactionVersion; s.seq = 0; s.mode = command.mode;
    const root = document.createElement('div'); root.setAttribute('data-vykor-annotations', '');
    root.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;z-index:2147483647!important;pointer-events:none!important;';
    s.root = root; s.shadow = root.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = ':host{--accent:#7651ba}*{box-sizing:border-box}.frame{position:fixed;border:2px solid var(--accent);background:rgb(118 81 186 / .06);pointer-events:none}.label{position:fixed;background:#25212c;color:#fff;border-radius:4px;padding:4px 7px;font:12px/16px system-ui;max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none}.pin{position:fixed;width:24px;height:24px;border:2px solid white;border-radius:50%;background:var(--accent);color:white;font:600 12px system-ui;pointer-events:auto;cursor:pointer}.shield{position:fixed;pointer-events:auto;background:transparent;cursor:crosshair}';
    s.shadow.append(style);
    const node = cls => { const el = document.createElement('div'); el.className = cls; s.shadow.append(el); return el; };
    s.frame = node('frame'); s.label = node('label');
    for (const el of Array.from(document.querySelectorAll('iframe,object,embed')).slice(0, 80)) s.shields.push({ el, node: node('shield') });
    const targetAt = event => {
      const path = event.composedPath();
      const shield = s.shields.find(item => path.includes(item.node));
      if (shield) return shield.el;
      const pin = s.markerViews.find(item => path.includes(item.node));
      if (pin) return resolve(pin.marker);
      const element = document.elementFromPoint(event.clientX, event.clientY);
      return element === s.root ? null : element;
    };
    const lock = el => {
      const target = el && describe(el);
      if (!target || s.selected) return;
      const anchor = VykorAnnotationSelector.annotationSelector(el);
      if (!anchor) return;
      const handleId = 'h' + s.version + '-' + (++s.next);
      s.handles.set(handleId, el); s.selected = { ...target, ...anchor, handleId }; s.focused = null; s.seq++; draw();
    };
    const gesture = event => {
      const pin = s.markerViews.find(item => event.composedPath().includes(item.node));
      if (!pin && s.mode !== 'pick') return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (event.type !== 'click') return;
      if (pin) { s.selected = null; s.focused = pin.marker.id; s.seq++; draw(); }
      else lock(targetAt(event));
    };
    const move = event => { if (s.mode === 'pick' && !s.selected) { s.hover = targetAt(event); schedule(); } };
    const focus = event => { if (s.mode === 'pick' && !s.selected && event.target !== root) { s.hover = event.target; schedule(); } };
    const keys = event => {
      if (event.key === 'Escape' && (s.mode === 'pick' || s.selected || s.focused)) {
        event.preventDefault(); event.stopImmediatePropagation();
        if (s.selected || s.focused) { s.selected = null; s.focused = null; }
        else s.mode = 'review';
        s.seq++; draw();
      } else if (event.key === 'Enter' && s.mode === 'pick') {
        event.preventDefault(); event.stopImmediatePropagation(); lock(document.activeElement);
      }
    };
    const listen = (type, fn) => { window.addEventListener(type, fn, true); s.listeners.push([type, fn]); };
    ['pointerdown','mousedown','pointerup','mouseup','click','dblclick','contextmenu'].forEach(type => listen(type, gesture));
    listen('pointermove', move); listen('focusin', focus); listen('keydown', keys); listen('scroll', schedule); listen('resize', schedule);
    document.documentElement.append(root);
  } else if (command.interactionVersion !== s.version) return snapshot();
  if (command.action === 'syncMarkers') {
    s.markers = command.markers.slice(0, 20);
    const ids = new Set(s.markers.map(m => m.id));
    for (const id of s.bindings.keys()) if (!ids.has(id)) s.bindings.delete(id);
    s.markerViews.forEach(item => item.node.remove()); s.markerViews = [];
    for (const marker of s.markers) {
      const el = marker.handleId && s.handles.get(marker.handleId);
      if (el && el.isConnected) s.bindings.set(marker.id, el);
      if (s.shadow) {
        const node = document.createElement('button'); node.className = 'pin'; node.type = 'button';
        node.setAttribute('aria-label', '查看批注'); s.shadow.append(node); s.markerViews.push({ marker, node });
      }
    }
    s.selected = null; s.focused = null;
  } else if (command.action === 'validateSelection') {
    if (s.selected?.handleId !== command.handleId || !matches(s.handles.get(command.handleId), s.selected)) s.selected = null;
  } else if (command.action === 'focusAnnotation') {
    const marker = s.markers.find(item => item.id === command.annotationId);
    const el = marker && resolve(marker);
    if (el) el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    s.selected = null; s.focused = command.annotationId; s.seq++;
  }
  return snapshot();
}`

export function buildAnnotationScript(command: PageAnnotationCommand): string {
  return `${command.action === "install" ? selectorRuntime + "\n" : ""}(${PAGE_PROGRAM})(${JSON.stringify(command)})`
}
