/** Display only. Never use a summary as tool input or to authorize execution. */
export function safeFilePath(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 &&
    !/[\u0000-\u001f\u007f-\u009f]/.test(value) ? value : undefined;
}

export function isFileTool(name: string | undefined): boolean {
  return name === "Write" || name === "Edit" || name === "Read";
}

/** Incremental JSON string/structure scan: retain short keys and one bounded path, never bodies. */
export function createToolPathSummary() {
  type Frame = { object: boolean; eligible: boolean; members: number; empty: boolean; afterComma: boolean;
    wrapper?: boolean; state: "key" | "colon" | "value" | "comma"; key?: string };
  const stack: Frame[] = [];
  let inString = false, escaped = false, capture: "key" | "path" | undefined;
  let token = "", primitive = "", started = false, invalid = false, unicodeRemaining = 0;
  let filePath: string | undefined;
  let pathFrames: Frame[] = [];
  function endValue() { const frame = stack.at(-1); if (frame) frame.state = "comma"; }
  return {
    push(chunk: string): string | null | undefined {
      let withdrawn = false;
      function withdrawPath() {
        if (filePath !== undefined) withdrawn = true;
        filePath = undefined;
        pathFrames = [];
      }
      for (const ch of chunk) {
        if (invalid) break;
        const frame = stack.at(-1);
        if (inString) {
          if (capture) {
            token += ch;
            // Worst case: every path character is a six-character Unicode escape.
            if (token.length > (capture === "key" ? 128 : 4096 * 6 + 2)) { capture = undefined; token = ""; }
          }
          if (unicodeRemaining) {
            if (!/[0-9a-f]/i.test(ch)) { invalid = true; break; }
            unicodeRemaining--; continue;
          }
          if (escaped) {
            escaped = false;
            if (ch === "u") unicodeRemaining = 4;
            else if (!/["\\/bfnrt]/.test(ch)) { invalid = true; break; }
            continue;
          }
          if (ch === "\\") { escaped = true; continue; }
          if (ch.charCodeAt(0) < 32) { invalid = true; break; }
          if (ch !== '"') continue;
          inString = false;
          if (capture) {
            try {
              const value: unknown = JSON.parse(token);
              if (capture === "key" && frame) {
                frame.key = typeof value === "string" ? value : undefined;
                frame.members++;
                if (frame.wrapper && frame.members > 1) {
                  frame.eligible = false;
                  if (pathFrames.includes(frame)) withdrawPath();
                }
              } else {
                const path = safeFilePath(value);
                if (path === undefined) withdrawPath();
                else { filePath = path; pathFrames = [...stack]; }
              }
            } catch { invalid = true; }
          }
          if (frame) frame.state = capture === "key" ? "colon" : "comma";
          capture = undefined; token = "";
          continue;
        }
        if (primitive) {
          if (!/[\s,}\]]/.test(ch)) {
            if (primitive.length >= 128) { invalid = true; break; }
            primitive += ch; continue;
          }
          if (!/^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)$/.test(primitive)) { invalid = true; break; }
          primitive = ""; endValue();
        }
        if (/\s/.test(ch)) continue;
        if (ch === "{" || ch === "[") {
          if (frame && frame.state !== "value") { invalid = true; break; }
          const eligible = ch === "{" && (!started || Boolean(frame?.eligible &&
            frame.members === 1 && ["arguments", "args", "parameters"].includes(frame.key ?? "") && stack.length <= 8));
          if (frame) { frame.empty = false; if (eligible) frame.wrapper = true; }
          if (stack.length >= 64) { invalid = true; break; }
          stack.push({ object: ch === "{", eligible, members: 0, empty: true, afterComma: false,
            state: ch === "{" ? "key" : "value" });
          started = true;
        } else if (ch === "}" || ch === "]") {
          if (!frame || frame.object !== (ch === "}") ||
            !(frame.state === "comma" || frame.empty && !frame.afterComma && frame.state === (frame.object ? "key" : "value"))) {
            invalid = true; break;
          }
          stack.pop(); endValue();
        } else if (ch === '"') {
          if (!frame || !["key", "value"].includes(frame.state)) { invalid = true; break; }
          frame.empty = false;
          inString = true;
          capture = frame.state === "key" ? "key" : frame.eligible && frame.key === "file_path" ? "path" : undefined;
          token = capture ? '"' : "";
        } else if (ch === ":" && frame?.state === "colon") frame.state = "value";
        else if (ch === "," && frame?.state === "comma") { frame.state = frame.object ? "key" : "value"; frame.key = undefined; frame.afterComma = true; }
        else if (frame?.state === "value" && /[-0-9tfn]/.test(ch)) { primitive = ch; frame.empty = false; }
        else { invalid = true; break; }
      }
      if (invalid) withdrawPath();
      return withdrawn ? null : filePath;
    },
  };
}
