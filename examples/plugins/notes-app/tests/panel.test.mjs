import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";
const tick = () => new Promise(resolve => setImmediate(resolve));
for (const resourceFirst of [true, false]) test(`newer resource revision survives an older save receipt (resource first: ${resourceFirst})`, async () => {
  const elements = new Map(), reads = []; let notify, save, sent;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", hidden: true, addEventListener(type, callback) { this[type] = callback; } });
    return elements.get(id);
  };
  class App {
    connect() { return Promise.resolve(); }
    getHostContext() { return {}; }
    setNotificationHandler(_schema, callback) { notify = callback; }
    request() { return new Promise(resolve => reads.push(resolve)); }
    callServerTool(request) { sent = request.arguments; return new Promise(resolve => { save = resolve; }); }
  }
  runInNewContext(readFileSync(new URL("../ui/panel.mjs", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, ""), {
    App, document: { getElementById: element }, ResourceListChangedNotificationSchema: {}, ReadResourceResultSchema: {}, crypto: { randomUUID },
  });
  const result = (revision, text) => ({ contents: [{ text: JSON.stringify({ id: "welcome", revision, text }) }] });
  await tick(); reads.shift()(result(0, "original")); await tick();
  element("draft").value = "my draft"; element("draft").input();
  const saved = element("save").onclick(); notify(); await tick();
  if (resourceFirst) { reads.shift()(result(2, "model revision two")); await tick(); }
  save({ structuredContent: { ...sent, revision: 1, text: "my draft", saved: true } }); await saved;
  if (!resourceFirst) { reads.shift()(result(2, "model revision two")); await tick(); }
  if (resourceFirst) {
    assert.equal(element("draft").value, "my draft"); assert.equal(element("conflict").hidden, false);
    assert.equal(element("remote").textContent, "model revision two");
    element("merge").onclick(); assert.match(element("revision").textContent, /2/);
  } else { assert.equal(element("draft").value, "model revision two"); assert.match(element("revision").textContent, /2/); }
});
