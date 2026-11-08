const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { runInNewContext, Script } = require('node:vm');
const { test } = require('node:test');
const assert = require('node:assert/strict');

const html = readFileSync(join(__dirname, '../index.html'), 'utf8');
const sandbox = {};
runInNewContext(html.match(/<script id="pixel-street-geometry">([\s\S]*?)<\/script>/)[1], sandbox);
const g = sandbox.PixelStreetGeometry;
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);

// Catches skipped corners and cars leaving the actual ring road.
test('car follows all four sides of the ring road', () => {
  assert.equal(typeof g.routeAt, 'function', 'the driving route is implemented');
  const turn = Math.PI * 1.5 / 2;
  for (const [distance, x, y, dx, dy] of [
    [0, 4.35, 2.85, 1, 0],
    [4.3 + turn, 10.15, 4.35, 0, 1],
    [8.6 + turn * 2, 8.65, 10.15, -1, 0],
    [12.9 + turn * 3, 2.85, 8.65, 0, -1],
  ]) {
    const p = g.routeAt(distance);
    close(p.x, x); close(p.y, y); close(p.dx, dx); close(p.dy, dy);
  }
});

// Catches a teleport at the loop seam or speed spikes on corners.
test('car loops continuously at the same speed', () => {
  assert.equal(typeof g.routeAt, 'function');
  close(g.routeAt(0).x, g.routeAt(g.routeLength).x);
  close(g.routeAt(-0.01).y, g.routeAt(g.routeLength - 0.01).y);
  for (let d = 0; d < g.routeLength; d += 0.037) {
    const a = g.routeAt(d), b = g.routeAt(d + 0.01);
    assert.ok(Math.abs(Math.hypot(b.x - a.x, b.y - a.y) - 0.01) < 0.00003);
    assert.ok(a.x >= 2.85 - 1e-8 && a.x <= 10.15 + 1e-8);
    assert.ok(a.y >= 2.85 - 1e-8 && a.y <= 10.15 + 1e-8);
  }
});

// Catches zooming around the canvas center instead of the user's pointer.
test('zoom keeps the map point beneath the pointer stationary', () => {
  assert.equal(typeof g.zoomAt, 'function');
  const view = { scale: 1.25, x: 45, y: -18 };
  const changed = g.zoomAt(view, 200, 90, 2);
  close((200 - changed.x) / changed.scale, 124);
  close((90 - changed.y) / changed.scale, 86.4);
  close(changed.scale, 2);
  const moved = g.zoomAt({ ...view, x: view.x + 70, y: view.y - 20 }, 200, 90, 2);
  close((200 - moved.x) / moved.scale, 68);
});

test('zoom clamps safely without shifting the anchor at its limits', () => {
  assert.equal(typeof g.zoomAt, 'function');
  const small = g.zoomAt({ scale: 1, x: 0, y: 0 }, 20, 30, 0.001);
  const large = g.zoomAt(small, 20, 30, 999);
  close(small.scale, 0.6); close(large.scale, 3.5);
  close((20 - large.x) / large.scale, 20);
  close((30 - large.y) / large.scale, 30);
});

// Uses the same opaque leaf mask that is painted, rather than a proximity flag.
test('one part of the drive is hidden by the canopy and the car emerges again', () => {
  assert.equal(typeof g.treeCoverage, 'function');
  let hidden = 0, visible = 0;
  for (let d = 0; d < g.routeLength; d += 0.05) {
    const coverage = g.treeCoverage(g.routeAt(d));
    if (coverage > 0.65) hidden++;
    if (coverage < 0.01) visible++;
  }
  assert.ok(hidden > 5, 'the actual leaf mask must cover a meaningful stretch of road');
  assert.ok(visible > 300, 'the car remains visible through most of its circuit');
});

test('each browser script parses without loading external code', () => {
  for (const script of html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) new Script(script[1]);
});
