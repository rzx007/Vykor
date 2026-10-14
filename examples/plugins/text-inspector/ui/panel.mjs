const { createPluginUiClient, applyPluginUiAppearance } = VykorPluginUi;

const list = document.querySelector("#findings");
const preview = document.querySelector("#preview");
const button = document.querySelector("#preview-button");
const status = document.querySelector("#status");
const dismiss = document.querySelector("#dismiss");
const selectionCount = document.querySelector("#selection-count");
const note = document.querySelector("#conversation-text");
const draft = document.querySelector("#draft");
const submit = document.querySelector("#submit");
const selected = new Set();
let snapshot;
let pending = false;
let revision;
const errors = {
  plugin_ui_user_cancelled: "已取消，没有执行操作。",
  plugin_ui_revision_conflict: "结果已更新，请重新选择问题。",
  plugin_ui_session_busy: "会话正在执行其他操作，请稍后再试。",
  plugin_ui_read_only: "当前结果只能查看，不能执行操作。",
  plugin_ui_mount_closed: "交互已关闭，可从结果卡重新打开。",
  plugin_ui_request_timeout: "请求超时，请先查看会话回执，再决定是否重试。",
  plugin_ui_payload_too_large: "所选内容超过 32 KiB，请减少选择；没有发送或裁剪内容。",
};
function report(error) {
  status.textContent = errors[error?.code] || error?.message || "操作未完成，请查看会话中的错误信息。";
}
function controls() {
  const locked = pending || snapshot?.readOnly || !!snapshot?.activeAction || snapshot?.status !== "open";
  button.disabled = locked || selected.size === 0;
  selectionCount.textContent = selected.size ? "已选 " + selected.size + " 项" : "请选择要修复的问题";
  for (const input of list.querySelectorAll("input"))
    input.disabled = pending || (locked && !snapshot?.capabilities.draft && !snapshot?.capabilities.submit);
  draft.hidden = !snapshot?.capabilities.draft;
  submit.hidden = !snapshot?.capabilities.submit;
  draft.disabled = pending || !snapshot?.capabilities.draft || !selected.size || !note.value.trim();
  submit.disabled = pending || !snapshot?.capabilities.submit || !selected.size || !note.value.trim();
  dismiss.disabled = pending || snapshot?.status !== "open" || !!snapshot?.activeAction;
}
function render(value) {
  // Presentation/capability notifications can keep the business revision unchanged.
  applyPluginUiAppearance(value.appearance);
  document.documentElement.dataset.theme = value.appearance.theme;
  snapshot = value;
  if (value.revision !== revision) {
    revision = value.revision;
    selected.clear();
    list.replaceChildren();
    for (const finding of value.data.findings) {
      const item = document.createElement("li");
      const label = document.createElement("label");
      const input = document.createElement("input");
      input.type = "checkbox";
      input.value = finding.line + ":" + finding.code;
      input.addEventListener("change", () => {
        if (input.checked) selected.add(input.value); else selected.delete(input.value);
        controls();
      });
      label.append(input, document.createTextNode("第 " + finding.line + " 行 · " +
        (finding.code === "tab-indentation" ? "行首制表符 → 每个替换为 2 个空格" : "删除行尾空白")));
      item.append(label); list.append(item);
    }
    preview.value = value.data.text;
    status.textContent = value.data.findings.length ? "发现 " + value.data.findings.length + " 个问题" +
      (value.data.truncated ? "（仅列出前 100 个）。" : "。") : "没有发现格式问题。";
  }
  if (value.status !== "open") status.textContent = value.capabilities.draft ? "交互已结束，仍可加入输入框。" : "交互已结束，仅供查看。";
  else if (value.activeAction) status.textContent = "正在生成修复预览…";
  else if (value.readOnly) status.textContent = "当前结果只能查看。";
  else if (value.lastAction?.executionState === "unknown") status.textContent = "无法确认上次操作结果，请查看会话记录；不会自动重试。";
  else if (value.lastAction?.receipt.status === "completed") status.textContent = "修复预览已生成，没有修改文件。";
  else if (value.lastAction) status.textContent = "上次操作未完成，请查看会话记录。";
  controls();
}
function conversationPayload(mode) {
  const text = note.value.trim();
  if (!text || [...text].length > 4096) throw new Error("说明需要 1–4096 个字符；没有发送内容。");
  const lines = snapshot.data.text.split("\n");
  const data = { findings: snapshot.data.findings.filter(item => selected.has(item.line + ":" + item.code))
    .map(item => ({ line: item.line, code: item.code, text: lines[item.line - 1] })) };
  if (new TextEncoder().encode(JSON.stringify(data)).byteLength > 32 * 1024)
    throw Object.assign(new Error("Selected data exceeds the conversation limit"), { code: "plugin_ui_payload_too_large" });
  return { mode, expectedRevision: snapshot.revision, text, data };
}
async function initialize() {
  try {
    const client = await createPluginUiClient();
    render(await client.getSnapshot());
    client.onSnapshot(render);
    note.addEventListener("input", controls);
    button.addEventListener("click", async () => {
      if (button.disabled) return;
      pending = true; controls(); status.textContent = "等待你在主界面确认…";
      try {
        const receipt = await client.requestAction("preview", { text: snapshot.data.text, selected: [...selected] });
        if (snapshot.lastAction?.receipt.requestId === receipt.requestId) render(snapshot);
        else status.textContent = "操作已受理，正在等待结果更新…";
      } catch (error) { report(error); }
      finally { pending = false; controls(); }
    });
    for (const [element, mode] of [[draft, "draft"], [submit, "submit"]]) {
      element.addEventListener("click", async () => {
        if (element.disabled) return;
        try {
          const payload = conversationPayload(mode);
          pending = true; controls();
          status.textContent = mode === "submit" ? "等待你在主界面确认交给助手…" : "正在加入输入框…";
          const receipt = await client.requestConversation(payload);
          status.textContent = receipt.mode === "draft" ? "已加入输入框，尚未发送。" : "已交给助手，请查看会话回执。";
        } catch (error) { report(error); }
        finally { pending = false; controls(); }
      });
    }
    dismiss.addEventListener("click", () => { client.dismiss().catch(report); });
    window.addEventListener("pagehide", () => client.dispose(), { once: true });
  } catch (error) {
    draft.disabled = true; submit.disabled = true; dismiss.disabled = true; report(error);
  }
}
initialize();
