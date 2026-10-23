import { App, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { ResourceListChangedNotificationSchema, ReadResourceResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { createPluginAppClient } from './app-client.mjs';
import { noteTools } from '../src/app-tools.mjs';
const app = new App({ name: "Notes", version: "1.0.1" }, { availableDisplayModes: ["inline", "fullscreen"] });
const tools = createPluginAppClient(app);
const el = id => document.getElementById(id);
let note, latest, adoptionRevision, dirty = false, saving = false, unconfirmed = false, connected = false;
const report = message => { el("status").textContent = message; };
const markUnconfirmed = () => { unconfirmed = true; report("保存结果待核实，草稿已保留。不会自动重试。"); };
const hasConflict = () => !!(note && latest && latest.revision > note.revision);
const controls = () => {
  const conflict = hasConflict();
  el("save").disabled = !note || !dirty || saving || conflict;
  el("save").textContent = saving ? "保存中…" : "保存草稿";
  el("draft").disabled = !note;
  el("revision").textContent = note ? `版本 ${note.revision}` : "";
  el("save-state").textContent = saving ? "正在保存…" : unconfirmed ? "保存结果待核实" : conflict ? "远端有更新 · 草稿已保留" : !note ? "正在读取…" : dirty ? "未保存" : "已保存";
  el("merge").disabled = saving;
  el("adopt").disabled = saving;
  el("confirm-adopt").disabled = saving;
  el("selection").hidden = !connected || !app.getHostCapabilities()?.updateModelContext;
  el("selection").disabled = !note || dirty || saving || conflict;
};
function showConflict() {
  el("conflict").hidden = false;
  el("remote").textContent = latest.text;
  el("remote-version").textContent = `查看远端版本 ${latest.revision}`;
}
function cancelAdoption() {
  adoptionRevision = undefined;
  el("adopt-confirmation").hidden = true;
}
function render(value, saved = false) {
  if (!value || !Number.isSafeInteger(value.revision) || typeof value.text !== "string") throw new Error("无效笔记");
  if (note && value.revision < note.revision) return;
  if (latest && value.revision < latest.revision) {
    if (saved) {
      note = value; dirty = true; showConflict();
      report("保存已确认，但笔记已有更新。草稿已保留，请手工合并。"); controls();
    }
    return;
  }
  if (latest?.revision !== value.revision) cancelAdoption();
  latest = value;
  if (dirty && !saved) {
    if (value.revision !== note.revision) { showConflict(); report("远端笔记已有更新。请查看新版本，手工合并或明确采用新版。"); }
  } else { note = value; el("draft").value = value.text; dirty = false; el("conflict").hidden = true; report(saved ? `服务器确认已保存，版本 ${value.revision}。` : "已读取最新笔记。"); }
  controls();
}
async function refresh() {
  const response = await app.request({ method: "resources/read", params: { uri: "notes://welcome" } }, ReadResourceResultSchema);
  render(JSON.parse(response.contents[0].text));
}
app.setNotificationHandler(ResourceListChangedNotificationSchema, () => { void refresh().catch(error => report(error.message)); });
app.ontoolresult = result => { try { if (!result.isError && result.structuredContent?.text !== undefined) render(result.structuredContent); } catch (error) { report(error.message); } };
function appearance(context) {
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.theme) document.documentElement.dataset.theme = context.theme;
}
app.onhostcontextchanged = appearance;
el("draft").addEventListener("input", () => {
  dirty = !note || el("draft").value !== note.text; cancelAdoption();
  report(unconfirmed ? "此前保存结果仍待核实，当前草稿已保留。不会自动重试。" : hasConflict() ? "远端有更新，当前草稿已保留。请对照新版本手工合并。" : dirty ? "草稿尚未保存。" : "正文与当前已保存版本一致。");
  controls();
});
el("refresh").onclick = () => { void refresh().catch(error => report(error.message)); };
el("merge").onclick = () => {
  if (!hasConflict() || saving) return;
  note = latest; dirty = el("draft").value !== note.text; cancelAdoption();
  el("conflict").hidden = true; report("已保留你手工合并的正文，请检查后保存草稿。"); controls();
};
el("adopt").onclick = () => {
  if (!hasConflict() || saving) return;
  adoptionRevision = latest.revision;
  el("adopt-confirmation").hidden = false;
};
el("cancel-adopt").onclick = cancelAdoption;
el("confirm-adopt").onclick = () => {
  if (!hasConflict() || saving || adoptionRevision !== latest.revision) return;
  cancelAdoption(); dirty = false; render(latest);
  report("已采用远端新版，原本地草稿已替换。");
};
el("save").onclick = async () => {
  if (!note || saving || !dirty || hasConflict()) return;
  saving = true; controls(); el("draft").readOnly = true;
  const input = { expectedRevision: note.revision, operationId: crypto.randomUUID(), text: el("draft").value };
  try {
    const result = await tools.call(noteTools.save, input);
    if (result.isError) { report(result.content?.map(item => item.text ?? "").join("\n") || "保存失败，草稿已保留。"); await refresh(); }
    else if (result.structuredContent?.operationId === input.operationId && result.structuredContent.saved === true) { unconfirmed = false; render(result.structuredContent, true); }
    else markUnconfirmed();
  } catch { markUnconfirmed(); }
  finally { saving = false; el("draft").readOnly = false; controls(); }
};
el("selection").onclick = async () => {
  const draft = el("draft"), start = draft.selectionStart, end = draft.selectionEnd;
  if (!note || dirty || saving || hasConflict() || start === end) { report("请先合并并保存草稿，再选择要引用到聊天的文字。"); return; }
  try { await app.updateModelContext({ content: [{ type: "text", text: `笔记选区：${draft.value.slice(start, end)}` }], structuredContent: { noteId: note.id, revision: note.revision, start, end, selectedText: draft.value.slice(start, end) } }); report("选区已引用到聊天，请在聊天中填写要求并发送。"); }
  catch { report("无法添加选区，文字仍保留。"); }
};
async function main() {
  controls();
  await app.connect();
  connected = true; appearance(app.getHostContext() || {}); controls();
  await refresh();
}
void main().catch(error => report(error.message));
