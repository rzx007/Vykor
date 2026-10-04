/** @typedef {{line:number, code:'tab-indentation'|'trailing-whitespace'}} Finding */
/** @param {string} text */
function check(text) {
  /** @type {Finding[]} */
  const findings = [];
  let truncated = false;
  let lineNumber = 0;
  for (const rawLine of text.split("\n")) {
    lineNumber++;
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    /** @type {Finding['code'][]} */
    const codes = [];
    if (line.startsWith("\t")) codes.push("tab-indentation");
    if (/[ \t]$/.test(line)) codes.push("trailing-whitespace");
    for (const code of codes) {
      if (findings.length === 100) { truncated = true; break; }
      findings.push({ line: lineNumber, code });
    }
    if (truncated) break;
  }
  return { findings, truncated };
}
/** @param {string} text */
function proposal(text) {
  // Reserve room for up to100 selection IDs and the bridge/request wrapper.
  if (new TextEncoder().encode(JSON.stringify(text)).length > 48000) return undefined;
  return { ui: { schemaVersion: 1, componentId: "text-inspector", data: { text, ...check(text) } } };
}
const textSchema = { type: "string", maxLength: 100000 };
/** @type {import('@vykor/plugins/sdk').NativeToolRegister} */
export const registerTools = () => [{
  name: "TextInspectorCheck",
  description: "检查传入文本的行首制表符和行尾空白，返回行号与问题代码；较短文本也提供交互预览。",
  inputSchema: { type: "object", required: ["text"], properties: { text: textSchema }, additionalProperties: false },
  safeToRetry: true,
  invoke(input) {
    if (typeof input.text !== "string") throw new TypeError("text must be a string");
    const metadata = proposal(input.text);
    return { content: [{ type: "text", text: JSON.stringify(check(input.text)) }], ...(metadata ? { metadata } : {}) };
  },
}, {
  name: "TextInspectorPreview",
  description: "仅修复选中的文本格式问题并返回预览；不读取或写入文件。",
  inputSchema: {
    type: "object", required: ["text", "selected"], additionalProperties: false,
    properties: {
      text: textSchema,
      selected: { type: "array", minItems: 1, maxItems: 100, uniqueItems: true,
        items: { type: "string", maxLength: 40, pattern: "^[1-9][0-9]*:(tab-indentation|trailing-whitespace)$" } },
    },
  },
  safeToRetry: true,
  invoke(input) {
    if (typeof input.text !== "string" || !Array.isArray(input.selected)
      || !input.selected.every(value => typeof value === "string")) throw new TypeError("Invalid preview input");
    const selected = new Set(input.selected);
    const existing = new Set(check(input.text).findings.map(item => item.line + ":" + item.code));
    if (!selected.size || selected.size !== input.selected.length || [...selected].some(id => !existing.has(id)))
      throw new TypeError("Selection is stale, duplicated or absent");
    const text = input.text.split("\n").map((raw, index) => {
      const cr = raw.endsWith("\r") ? "\r" : "";
      let line = cr ? raw.slice(0, -1) : raw;
      if (selected.has((index + 1) + ":tab-indentation")) line = line.replace(/^\t+/, tabs => "  ".repeat(tabs.length));
      if (selected.has((index + 1) + ":trailing-whitespace")) line = line.replace(/[ \t]+$/, "");
      return line + cr;
    }).join("\n");
    const metadata = proposal(text);
    return { content: [{ type: "text", text: JSON.stringify({ text, ...check(text) }) }], ...(metadata ? { metadata } : {}) };
  },
}];
