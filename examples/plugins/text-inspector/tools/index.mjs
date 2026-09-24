/** @type {import('@vykor/plugins/sdk').NativeToolRegister} */
export const registerTools = () => [{
  name: "TextInspectorCheck",
  description: "检查传入文本的行首制表符和行尾空白，返回行号与问题代码。",
  inputSchema: {
    type: "object",
    required: ["text"],
    properties: { text: { type: "string", maxLength: 100000 } },
    additionalProperties: false,
  },
  safeToRetry: true,
  invoke(input) {
    // The host validates the schema; narrowing also keeps this real JS file type-checked.
    if (typeof input.text !== "string") throw new TypeError("text must be a string");
    /** @type {Array<{line: number, code: 'tab-indentation' | 'trailing-whitespace'}>} */
    const findings = [];
    let truncated = false;
    let lineNumber = 0;
    for (const rawLine of input.text.split("\n")) {
      lineNumber += 1;
      const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      /** @type {Array<'tab-indentation' | 'trailing-whitespace'>} */
      const codes = [];
      if (line.startsWith("\t")) codes.push("tab-indentation");
      if (/[ \t]$/.test(line)) codes.push("trailing-whitespace");
      for (const code of codes) {
        if (findings.length === 100) {
          truncated = true;
          break;
        }
        findings.push({ line: lineNumber, code });
      }
      if (truncated) break;
    }
    return { content: [{ type: "text", text: JSON.stringify({ findings, truncated }) }] };
  },
}];
