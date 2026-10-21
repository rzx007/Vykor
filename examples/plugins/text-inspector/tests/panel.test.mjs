import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const tick = () => new Promise(resolve => setImmediate(resolve));
async function panel() {
  const elements = new Map(), calls = [], references = [], messages = []; let app;
  const createElement = tag => ({ tagName: tag, value: "", textContent: "", hidden: true, children: [], checked: false,
    addEventListener(type, handler) { this[type] = handler; },
    append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
    querySelectorAll(selector) { return this.children.flatMap(child => [
      ...(selector === child.tagName ? [child] : []), ...(child.querySelectorAll?.(selector) || [])]); },
  });
  const el = id => { if (!elements.has(id)) elements.set(id, createElement(id === "#preview" ? "textarea" : id)); return elements.get(id); };
  class App {
    constructor() { app = this; }
    getHostCapabilities() { return { updateModelContext: {}, message: {} }; }
    getHostContext() { return {}; }
    connect() { return Promise.resolve(); }
    callServerTool(request) { calls.push(request); return Promise.resolve({ structuredContent: request.name === "TextInspectorCheck"
      ? { text: request.arguments.text, findings: [{ line: 1, code: "trailing-whitespace" }], truncated: false }
      : { text: "ok", findings: [], truncated: false } }); }
    updateModelContext(value) { references.push(value); return Promise.resolve(); }
    sendMessage(value) { messages.push(value); return Promise.resolve(); }
  }
  runInNewContext(readFileSync(new URL("../ui/panel.mjs", import.meta.url), "utf8").replace(/^import .*;\r?\n/gm, ""), {
    App, TextEncoder, document: { querySelector: el, createElement, createTextNode: text => ({ textContent: text }), documentElement: { dataset: {} } },
  });
  await tick(); el("#conversation-text").value = "解释选中问题";
  return { el, app, calls, references, messages, select() { const input = el("#findings").querySelectorAll("input")[0]; input.checked = true; input.change(); } };
}

test("editing checked text invalidates both repair and collaboration selections", async () => {
  const p = await panel(); p.app.ontoolresult({ structuredContent: { text: "ok  ", findings: [{ line: 1, code: "trailing-whitespace" }], truncated: false } });
  p.select(); assert.equal(p.el("#draft").disabled, false);
  p.el("#preview").value = "a different line"; p.el("#preview").input();
  assert.equal(p.el("#preview-button").disabled, true);
  assert.equal(p.el("#draft").disabled, true);
  assert.equal(p.el("#submit").disabled, true);
  assert.match(p.el("#status").textContent, /重新检查/);
  p.el("#draft").click(); await tick(); assert.equal(p.references.length, 0);
});

test("explicit check and selected repair update the editor once and show a no-issues state", async () => {
  const p = await panel(); p.el("#preview").value = "ok  "; p.el("#preview").input();
  p.el("#check-button").click(); await tick(); p.select();
  p.el("#preview-button").click(); await tick();
  assert.equal(p.calls.length, 2);
  assert.equal(p.calls[0].name, "TextInspectorCheck");
  assert.equal(p.calls[1].name, "TextInspectorPreview");
  assert.deepEqual(JSON.parse(JSON.stringify(p.calls[1].arguments)), { text: "ok  ", selected: ["1:trailing-whitespace"] });
  assert.equal(p.el("#preview").value, "ok");
  assert.equal(p.el("#empty-state").hidden, false);
  assert.match(p.el("#text-state").textContent, /修复预览/);
  assert.equal(p.el("#preview-button").disabled, true);
});

test("referencing a finding keeps chat sending as a separate explicit action", async () => {
  const p = await panel(); p.app.ontoolresult({ structuredContent: { text: "ok  ", findings: [{ line: 1, code: "trailing-whitespace" }], truncated: false } });
  p.select(); p.el("#draft").click(); await tick();
  assert.equal(p.references.length, 1);
  assert.equal(p.references[0].structuredContent.findings[0].text, "ok  ");
  assert.equal(p.messages.length, 0);
  assert.equal(p.calls.length, 0);
});

test("a pushed tool result preserves local edits until the user explicitly replaces them", async () => {
  const p = await panel();
  p.app.ontoolresult({ structuredContent: { text: "original", findings: [], truncated: false } });
  p.el("#preview").value = "keep my editing"; p.el("#preview").input();
  p.app.ontoolresult({ structuredContent: { text: "new result", findings: [], truncated: false } });
  assert.equal(p.el("#preview").value, "keep my editing");
  assert.equal(p.el("#incoming-result").hidden, false);
  assert.equal(p.calls.length, 0);
  p.app.ontoolresult({ content: [{ type: "text", text: "检查结果超过交互预览大小" }] });
  assert.equal(p.el("#preview").value, "keep my editing");
  assert.equal(p.el("#incoming-result").hidden, false);
  p.el("#apply-result").click();
  assert.equal(p.el("#preview").value, "new result");
  assert.equal(p.el("#incoming-result").hidden, true);
});
