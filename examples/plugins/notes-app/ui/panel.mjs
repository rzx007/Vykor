import { App, applyHostStyleVariables } from "@modelcontextprotocol/ext-apps";
import { ResourceListChangedNotificationSchema, ReadResourceResultSchema } from "@modelcontextprotocol/sdk/types.js";
const app = new App({ name: "Notes", version: "1.0.0" }, { availableDisplayModes: ["inline", "fullscreen"] });
const el = id => document.getElementById(id);
let note, latest, dirty = false, saving = false;
const report = message => { el("status").textContent = message; };
const controls = () => { el("save").disabled = !note || !dirty || saving; el("revision").textContent = note ? `文档版本 ${note.revision}` : ""; };
function render(value, saved = false) {
  if (!value || !Number.isSafeInteger(value.revision) || typeof value.text !== "string") throw new Error("无效笔记");
  if (note && value.revision < note.revision) return;
  if (latest && value.revision < latest.revision) {
    if (saved) {
      note = value; dirty = true; el("conflict").hidden = false; el("remote").textContent = latest.text;
      report("保存已确认，但笔记已有更新。草稿已保留，请手工合并。"); controls();
    }
    return;
  }
  latest = value;
  if (dirty && !saved) {
    if (value.revision !== note.revision) { el("conflict").hidden = false; el("remote").textContent = value.text; report("笔记已有更新。草稿已保留，请手工合并。"); }
  } else { note = value; el("draft").value = value.text; dirty = false; el("conflict").hidden = true; report(saved ? `服务器确认已保存，版本 ${value.revision}。` : "已读取最新笔记。"); }
  controls();
}
async function refresh() {
  const response = await app.request({ method: "resources/read", params: { uri: "notes://welcome" } }, ReadResourceResultSchema);
  render(JSON.parse(response.contents[0].text));
}
app.setNotificationHandler(ResourceListChangedNotificationSchema, () => { void refresh().catch(error => report(error.message)); });
app.ontoolresult = result => { if (!result.isError && result.structuredContent?.text !== undefined) render(result.structuredContent); };
app.onhostcontextchanged = context => { if (context.styles?.variables) applyHostStyleVariables(context.styles.variables); };
el("draft").addEventListener("input", () => { dirty = !note || el("draft").value !== note.text; controls(); });
el("refresh").onclick = () => { void refresh().catch(error => report(error.message)); };
el("merge").onclick = () => { if (latest) { note = latest; dirty = el("draft").value !== note.text; el("conflict").hidden = true; report("已采用最新版本，请检查草稿后手工保存。"); controls(); } };
el("save").onclick = async () => {
  if (!note || saving || !dirty) return;
  saving = true; controls(); el("draft").readOnly = true;
  const input = { expectedRevision: note.revision, operationId: crypto.randomUUID(), text: el("draft").value };
  try {
    const result = await app.callServerTool({ name: "save_note_draft", arguments: input });
    if (result.isError) { report(result.content?.map(item => item.text ?? "").join("\n") || "保存失败，草稿已保留。"); await refresh(); }
    else if (result.structuredContent?.operationId === input.operationId && result.structuredContent.saved === true) { render(result.structuredContent, true); }
    else report("保存结果待核实，草稿已保留。不会自动重试。");
  } catch { report("保存结果待核实，草稿已保留。不会自动重试。"); }
  finally { saving = false; el("draft").readOnly = false; controls(); }
};
el("selection").onclick = async () => {
  const draft = el("draft"), start = draft.selectionStart, end = draft.selectionEnd;
  if (!note || dirty || start === end) { report("请先手工保存，再选择要交给助手的文字。"); return; }
  try { await app.updateModelContext({ content: [{ type: "text", text: `请修改笔记中的选区：${draft.value.slice(start, end)}` }], structuredContent: { noteId: note.id, revision: note.revision, start, end, selectedText: draft.value.slice(start, end) } }); report("选区已放入会话草稿，请填写要求并发送。"); }
  catch { report("无法添加选区，文字仍保留。"); }
};
let fullscreen = false;
el("fullscreen").onclick = async () => { try { const result = await app.requestDisplayMode({ mode: fullscreen ? "inline" : "fullscreen" }); fullscreen = result.mode === "fullscreen"; el("fullscreen").textContent = fullscreen ? "收起" : "展开"; } catch { report("当前宿主不支持展开。"); } };
async function main() {
  await app.connect();
  const context = app.getHostContext(); if (context?.styles?.variables) applyHostStyleVariables(context.styles.variables);
  await refresh();
}
void main().catch(error => report(error.message));
