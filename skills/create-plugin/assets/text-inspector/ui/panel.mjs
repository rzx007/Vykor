const { createPluginUiClient } = VykorPluginUi;

const list = document.querySelector("#findings");
const preview = document.querySelector("#preview");
const button = document.querySelector("#preview-button");
const status = document.querySelector("#status");
const sidebar = document.querySelector("#sidebar");
const dismiss = document.querySelector("#dismiss");
const selectionCount = document.querySelector("#selection-count");
const selected = new Set();
let snapshot;
let pending = false;
let revision;
const errors = {
  plugin_ui_user_cancelled: "已取消，没有执行修复。",
  plugin_ui_revision_conflict: "结果已更新，请重新选择问题。",
  plugin_ui_session_busy: "会话正在执行其他操作，请稍后再试。",
  plugin_ui_read_only: "当前结果只能查看，不能执行操作。",
  plugin_ui_mount_closed: "交互已关闭，可从结果卡重新打开。",
  plugin_ui_request_timeout: "请求超时，请先查看最新结果，再决定是否重试。",
};
function report(error) {
  status.textContent = errors[error?.code] || "操作未完成，请查看会话中的错误信息。";
}
function controls() {
  const locked = pending || snapshot?.readOnly || !!snapshot?.activeAction;
  button.disabled = locked || selected.size === 0;
  selectionCount.textContent = selected.size ? "已选 " + selected.size + " 项" : "请选择要修复的问题";
  for (const input of list.querySelectorAll("input")) input.disabled = !!locked;
  sidebar.disabled = pending;
  dismiss.disabled = pending || snapshot?.status !== "open" || !!snapshot?.activeAction;
}
function render(value) {
  const changed = value.revision !== revision;
  snapshot = value;
  sidebar.hidden = value.surface !== "tool-result";
  document.documentElement.dataset.theme = value.theme;
  if (changed) {
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
    status.textContent = value.readOnly ? "当前结果只能查看。" :
      value.data.findings.length ? "发现 " + value.data.findings.length + " 个问题" +
        (value.data.truncated ? "（仅列出前 100 个）。" : "。") : "没有发现格式问题。";
  } else if (value.readOnly) status.textContent = "当前结果只能查看。";
  if (value.status !== "open") status.textContent = "交互已结束，仅供查看。";
  else if (value.activeAction) status.textContent = "正在生成修复预览…";
  else if (value.readOnly) status.textContent = "当前结果只能查看。";
  else if (value.lastAction?.executionState === "unknown") status.textContent = "无法确认上次操作结果，请查看会话记录；不会自动重试。";
  else if (value.lastAction?.receipt.status === "completed") status.textContent = "修复预览已生成，没有修改文件。";
  else if (value.lastAction) status.textContent = "上次操作未完成，请查看会话记录。";
  controls();
}
async function initialize() {
try {
  const client = await createPluginUiClient();
  client.onSnapshot(render);
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
  sidebar.addEventListener("click", () => { client.openSidebar().catch(report); });
  dismiss.addEventListener("click", () => { client.dismiss().catch(report); });
  if (snapshot.surface === "tool-result") client.resize(520).catch(report);
  window.addEventListener("pagehide", () => client.dispose(), { once: true });
} catch (error) {
  sidebar.disabled = true; dismiss.disabled = true; report(error);
}
}
initialize();
