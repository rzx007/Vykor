import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { randomUUID } from "node:crypto";

const tick = () => new Promise(resolve => setImmediate(resolve));
async function panel({ context = true } = {}) {
  const elements = new Map(), reads = [], writes = [], references = [];
  let notify, app, save, rejectSave;
  const element = id => {
    if (!elements.has(id)) elements.set(id, { value: "", textContent: "", hidden: true, selectionStart: 0, selectionEnd: 0,
      addEventListener(type, callback) { this[type] = callback; } });
    return elements.get(id);
  };
  class App {
    constructor() { app = this; }
    connect() { return Promise.resolve(); }
    getHostContext() { return {}; }
    getHostCapabilities() { return context ? { updateModelContext: {} } : {}; }
    setNotificationHandler(_schema, callback) { notify = callback; }
    request() { return new Promise(resolve => reads.push(resolve)); }
    callServerTool(request) { writes.push(request); return new Promise((resolve, reject) => { save = resolve; rejectSave = reject; }); }
    updateModelContext(value) { references.push(value); return Promise.resolve(); }
  }
  runInNewContext(readFileSync(new URL("../ui/panel.mjs", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, ""), {
    App, document: { getElementById: element, documentElement: { dataset: {} } },
    ResourceListChangedNotificationSchema: {}, ReadResourceResultSchema: {}, crypto: { randomUUID },
  });
  const resource = (revision, text) => ({ contents: [{ text: JSON.stringify({ id: "welcome", revision, text }) }] });
  await tick(); reads.shift()(resource(0, "original")); await tick();
  return { element, app, reads, writes, references, notify, resource,
    input(text) { element("draft").value = text; element("draft").input(); },
    async remote(revision, text) { notify(); await tick(); reads.shift()(resource(revision, text)); await tick(); },
    receipt(value) { save(value); }, failSave() { rejectSave(new Error("Connection closed")); } };
}

test("local edits immediately show unsaved state and remote refresh cannot replace them", async () => {
  const p = await panel();
  assert.match(p.element("save-state").textContent, /已保存/);
  p.input("my local draft");
  assert.match(p.element("save-state").textContent, /未保存/);
  assert.match(p.element("status").textContent, /尚未保存/);
  await p.remote(3, "remote revision three");
  assert.equal(p.element("draft").value, "my local draft");
  assert.match(p.element("save-state").textContent, /远端.*更新/);
  assert.equal(p.element("save").disabled, true);
  assert.equal(p.writes.length, 0);
  p.input("merged local and remote"); p.element("merge").onclick();
  assert.equal(p.element("draft").value, "merged local and remote");
  const saving = p.element("save").onclick();
  assert.equal(p.writes[0].arguments.expectedRevision, 3);
  assert.equal(p.writes[0].arguments.text, "merged local and remote");
  p.receipt({ structuredContent: { ...p.writes[0].arguments, revision: 4, saved: true } }); await saving;
  assert.match(p.element("save-state").textContent, /已保存/);
});

test("adopting remote content needs a separate explicit confirmation and never saves automatically", async () => {
  const p = await panel(); p.input("local draft"); await p.remote(1, "remote text");
  p.element("adopt").onclick();
  assert.equal(p.element("draft").value, "local draft");
  assert.equal(p.element("adopt-confirmation").hidden, false);
  p.element("cancel-adopt").onclick();
  assert.equal(p.element("adopt-confirmation").hidden, true);
  assert.equal(p.element("draft").value, "local draft");
  p.element("adopt").onclick(); p.element("confirm-adopt").onclick();
  assert.equal(p.element("draft").value, "remote text");
  assert.equal(p.element("conflict").hidden, true);
  assert.match(p.element("revision").textContent, /1/);
  assert.equal(p.element("save").disabled, true);
  assert.equal(p.writes.length, 0);
});

test("a newer remote update cancels stale adoption confirmation", async () => {
  const p = await panel(); p.input("local draft"); await p.remote(1, "one");
  p.element("adopt").onclick(); await p.remote(2, "two");
  assert.equal(p.element("adopt-confirmation").hidden, true);
  p.element("confirm-adopt").onclick();
  assert.equal(p.element("draft").value, "local draft");
  assert.equal(p.element("remote").textContent, "two");
});

test("uncertain save receipts preserve the draft without retrying or reporting saved", async () => {
  const p = await panel(); p.input("keep this");
  const saved = p.element("save").onclick();
  p.receipt({ structuredContent: { operationId: "different-id", revision: 1, text: "keep this", saved: true } }); await saved;
  assert.equal(p.element("draft").value, "keep this");
  assert.match(p.element("status").textContent, /待核实/);
  assert.equal(p.element("save-state").textContent, "保存结果待核实");
  assert.equal(p.writes.length, 1);
  p.input("keep editing after the uncertain receipt");
  assert.equal(p.element("save-state").textContent, "保存结果待核实");
  assert.match(p.element("status").textContent, /待核实/);
  await p.remote(0, "original");
  assert.equal(p.element("save-state").textContent, "保存结果待核实");
  assert.equal(p.writes.length, 1);
});

test("a failed save request stays unconfirmed until an explicit matching save receipt", async () => {
  const p = await panel(); p.input("keep this");
  const first = p.element("save").onclick(); p.failSave(); await first;
  assert.equal(p.element("save-state").textContent, "保存结果待核实");
  assert.match(p.element("status").textContent, /待核实/);
  assert.equal(p.element("draft").value, "keep this");
  assert.equal(p.writes.length, 1);
  const second = p.element("save").onclick();
  assert.notEqual(p.writes[1].arguments.operationId, p.writes[0].arguments.operationId);
  p.receipt({ structuredContent: { ...p.writes[1].arguments, revision: 1, saved: true } }); await second;
  assert.equal(p.element("save-state").textContent, "已保存");
  assert.equal(p.writes.length, 2);
});

test("only a saved, conflict-free selection is referenced with its exact document revision", async () => {
  const p = await panel();
  p.element("draft").selectionStart = 0; p.element("draft").selectionEnd = 4;
  await p.element("selection").onclick();
  assert.equal(p.references.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(p.references[0].structuredContent)), { noteId: "welcome", revision: 0, start: 0, end: 4, selectedText: "orig" });
  p.input("unsaved draft"); await p.element("selection").onclick();
  assert.equal(p.references.length, 1);
  await p.remote(1, "latest"); await p.element("selection").onclick();
  assert.equal(p.references.length, 1);
});
