import { App, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";

const app = new App({ name: "Text Inspector", version: "1.2.0" }, { availableDisplayModes: ["inline", "fullscreen"] });
const list = document.querySelector("#findings");
const preview = document.querySelector("#preview");
const button = document.querySelector("#preview-button");
const checkButton = document.querySelector("#check-button");
const status = document.querySelector("#status");
const selectionCount = document.querySelector("#selection-count");
const note = document.querySelector("#conversation-text");
const draft = document.querySelector("#draft");
const submit = document.querySelector("#submit");
const selected = new Set();
let data;
let pending = false;
let connected = false;

function report(error) { status.textContent = error?.message || "操作未完成，请查看会话回执；不会自动重试。"; }
function controls() {
  const capabilities = app.getHostCapabilities();
  button.disabled = !connected || pending || !selected.size || preview.value !== data?.text;
  checkButton.disabled = !connected || pending || !preview.value;
  selectionCount.textContent = selected.size ? `已选 ${selected.size} 项` : "请选择要修复的问题";
  for (const input of list.querySelectorAll("input")) input.disabled = pending;
  draft.hidden = !capabilities?.updateModelContext;
  submit.hidden = !capabilities?.message;
  draft.disabled = pending || !selected.size || !note.value.trim();
  submit.disabled = draft.disabled;
}
// Both initial/model notifications and explicit tool responses use exactly this renderer.
// Rendering never calls a tool, sends a message, or saves a document.
function renderResult(result) {
  if (result.isError) throw new Error(result.content?.filter(item => item.type === "text").map(item => item.text).join("\n") || "工具执行失败。");
  const value = result.structuredContent;
  if (!value) {
    status.textContent = "文本超过交互预览大小，请查看会话中的文字结果，或减少文本后重新检查。";
    data = undefined; selected.clear(); list.replaceChildren(); controls(); return;
  }
  if (typeof value.text !== "string" || typeof value.truncated !== "boolean" || !Array.isArray(value.findings)
    || value.findings.length > 100 || value.findings.some(item => !Number.isSafeInteger(item.line) || item.line < 1
      || !["tab-indentation", "trailing-whitespace"].includes(item.code)))
    throw new Error("工具返回的检查结果无效。");
  data = value; selected.clear(); list.replaceChildren();
  for (const finding of value.findings) {
    const item = document.createElement("li"), label = document.createElement("label"), input = document.createElement("input");
    input.type = "checkbox"; input.value = `${finding.line}:${finding.code}`;
    input.addEventListener("change", () => { if (input.checked) selected.add(input.value); else selected.delete(input.value); controls(); });
    label.append(input, document.createTextNode(`第 ${finding.line} 行 · ${finding.code === "tab-indentation" ? "行首制表符 → 每个替换为 2 个空格" : "删除行尾空白"}`));
    item.append(label); list.append(item);
  }
  preview.value = value.text;
  status.textContent = value.findings.length ? `发现 ${value.findings.length} 个问题${value.truncated ? "（仅列出前 100 个）" : ""}。` : "没有发现格式问题。";
  controls();
}
function appearance(context) {
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.theme) document.documentElement.dataset.theme = context.theme;
}
function conversationPayload() {
  const text = note.value.trim();
  if (!text || [...text].length > 4096) throw new Error("说明需要 1–4096 个字符。");
  const lines = data.text.split("\n");
  const selection = { findings: data.findings.filter(item => selected.has(`${item.line}:${item.code}`))
    .map(item => ({ ...item, text: lines[item.line - 1] })) };
  if (new TextEncoder().encode(JSON.stringify(selection)).byteLength > 32 * 1024)
    throw new Error("所选内容超过 32 KiB，请减少选择；没有发送或裁剪内容。");
  return { text, selection };
}
async function action(work) {
  pending = true; controls();
  try { await work(); } catch (error) { report(error); }
  finally { pending = false; controls(); }
}
// Register notifications BEFORE connect: initialization can deliver a result immediately.
app.ontoolresult = result => { try { renderResult(result); } catch (error) { report(error); } };
app.onhostcontextchanged = appearance;
preview.addEventListener("input", controls);
note.addEventListener("input", controls);
checkButton.addEventListener("click", () => {
  if (!checkButton.disabled) void action(async () => {
    const result = await app.callServerTool({ name: "TextInspectorCheck", arguments: { text: preview.value } });
    renderResult(result);
  });
});
button.addEventListener("click", () => {
  if (!button.disabled) void action(async () => {
    const result = await app.callServerTool({ name: "TextInspectorPreview", arguments: { text: data.text, selected: [...selected] } });
    renderResult(result);
  });
});
draft.addEventListener("click", () => {
  if (!draft.disabled) void action(async () => {
    const { text, selection } = conversationPayload();
    await app.updateModelContext({ content: [{ type: "text", text }], structuredContent: selection });
    status.textContent = "已加入可见上下文，尚未发送。";
  });
});
submit.addEventListener("click", () => {
  if (!submit.disabled) void action(async () => {
    const { text, selection } = conversationPayload();
    const message = text + "\n\n" + JSON.stringify(selection);
    if ([...message].length > 4096) throw new Error("说明及所选内容超过消息的 4096 字符限制，请减少选择。");
    await app.sendMessage({ role: "user", content: [{ type: "text", text: message }] });
    status.textContent = "已交给助手，应用保持打开。";
  });
});
app.connect().then(() => { connected = true; appearance(app.getHostContext() || {}); controls(); }).catch(report);
