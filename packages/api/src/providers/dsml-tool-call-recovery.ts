export interface RecoveredToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface DsmlScanResult {
  visible: string;
  toolCalls: RecoveredToolCall[];
}

export interface DsmlRecoveryScanner {
  push(chunk: string): DsmlScanResult;
  flush(): DsmlScanResult;
}

const TOOL_CALLS_KEYWORDS = ["tool_calls", "toolcalls", "tool-calls"] as const;

// Safety valve: never hold more than this many characters waiting for a block
// to close. Beyond it the held text is released as plain content.
const MAX_HELD_CHARS = 4_000_000;

const INVOKE_CLOSE_RE = /<\/[^<>]*invoke[^<>]*>/i;
const TRAILING_WRAPPER_CLOSE_RE = /<\/[^<>]*tool[_\-]?calls[^<>]*>/i;
const PARAM_TAG_RE = /<(?![\/])[^<>]*?parameter[^<>]*>/i;
const PARAM_CLOSE_RE = /<\/[^<>]*?parameter[^<>]*>/i;
const PARAM_BARE_CLOSE_RE = /<\/[|｜▁\s]*DSML[|｜▁\s]*>/i;

function isFillerChar(ch: string): boolean {
  return ch === "|" || ch === "｜" || ch === "▁" || /\s/.test(ch);
}

function isWhitespaceChar(ch: string): boolean {
  return /\s/.test(ch);
}

function skipFiller(s: string, i: number): number {
  let pos = i;
  while (pos < s.length && isFillerChar(s[pos]!)) pos++;
  return pos;
}

function matchKeyword(s: string, i: number, keyword: string): number | "prefix" | "no" {
  for (let k = 0; k < keyword.length; k++) {
    const index = i + k;
    if (index >= s.length) return "prefix";
    if (s[index]!.toLowerCase() !== keyword[k]) return "no";
  }
  return i + keyword.length;
}

function matchFirstKeyword(
  s: string,
  i: number,
  keywords: readonly string[],
): { end: number; keyword: string } | "prefix" | "no" {
  let sawPrefix = false;
  for (const keyword of keywords) {
    const result = matchKeyword(s, i, keyword);
    if (result === "prefix") {
      sawPrefix = true;
      continue;
    }
    if (result !== "no") return { end: result, keyword };
  }
  return sawPrefix ? "prefix" : "no";
}

type InvokeOpenRead =
  | { kind: "no" }
  | { kind: "prefix" }
  | { kind: "open"; end: number; name: string };

/**
 * Read a DSML invoke open tag starting at `start`.
 *
 * Tolerates the degraded shapes DeepSeek V4 emits at long context: fullwidth
 * or ASCII bar fillers, a missing `<｜DSML｜tool_calls>` wrapper, misspelled
 * wrapper names, and compact markup without newlines.
 */
function readInvokeOpen(s: string, start: number): InvokeOpenRead {
  let i = start + 1;
  i = skipFiller(s, i);

  const direct = matchFirstKeyword(s, i, ["invoke"]);
  if (direct === "prefix") return { kind: "prefix" };
  if (direct !== "no") return finishInvokeOpen(s, direct.end);

  const dsml = matchKeyword(s, i, "dsml");
  if (dsml === "prefix") return { kind: "prefix" };
  if (dsml === "no") return { kind: "no" };

  i = skipFiller(s, dsml);
  const afterDsml = matchFirstKeyword(s, i, ["invoke", ...TOOL_CALLS_KEYWORDS]);
  if (afterDsml === "prefix") return { kind: "prefix" };
  if (afterDsml === "no") return { kind: "no" };
  if (afterDsml.keyword === "invoke") return finishInvokeOpen(s, afterDsml.end);

  i = skipFiller(s, afterDsml.end);
  if (i >= s.length) return { kind: "prefix" };
  if (s[i] !== ">") return { kind: "no" };
  i = skipFiller(s, i + 1);
  if (i >= s.length) return { kind: "prefix" };
  if (s[i] !== "<") return { kind: "no" };
  i = skipFiller(s, i + 1);

  const innerDsml = matchKeyword(s, i, "dsml");
  if (innerDsml === "prefix") return { kind: "prefix" };
  if (innerDsml !== "no") i = skipFiller(s, innerDsml);

  const inner = matchKeyword(s, i, "invoke");
  if (inner === "prefix") return { kind: "prefix" };
  if (inner === "no") return { kind: "no" };
  return finishInvokeOpen(s, inner);
}

function finishInvokeOpen(s: string, i: number): InvokeOpenRead {
  if (i >= s.length) return { kind: "prefix" };
  if (!isWhitespaceChar(s[i]!)) return { kind: "no" };
  i = skipFiller(s, i + 1);

  const nameKeyword = matchKeyword(s, i, "name");
  if (nameKeyword === "prefix") return { kind: "prefix" };
  if (nameKeyword === "no") return { kind: "no" };
  i = skipFiller(s, nameKeyword);
  if (i >= s.length) return { kind: "prefix" };
  if (s[i] !== "=") return { kind: "no" };
  i = skipFiller(s, i + 1);
  if (i >= s.length) return { kind: "prefix" };
  if (s[i] !== '"') return { kind: "no" };

  const nameStart = i + 1;
  let cursor = nameStart;
  while (cursor < s.length && s[cursor] !== '"' && s[cursor] !== "<" && s[cursor] !== ">") {
    cursor++;
  }
  if (cursor >= s.length) return { kind: "prefix" };
  if (s[cursor] !== '"') return { kind: "no" };
  const name = s.slice(nameStart, cursor).trim();

  cursor++;
  while (cursor < s.length && s[cursor] !== ">" && s[cursor] !== "<") cursor++;
  if (cursor >= s.length) return { kind: "prefix" };
  if (s[cursor] !== ">") return { kind: "no" };
  return { kind: "open", end: cursor + 1, name };
}

function readTrailingWrapperClose(s: string, start: number): InvokeOpenRead {
  let i = start;
  if (i >= s.length) return { kind: "prefix" };
  if (s[i] !== "<") return { kind: "no" };
  i++;
  if (i >= s.length) return { kind: "prefix" };
  if (s[i] !== "/") return { kind: "no" };
  i = skipFiller(s, i + 1);

  const dsml = matchKeyword(s, i, "dsml");
  if (dsml === "prefix") return { kind: "prefix" };
  if (dsml === "no") return { kind: "no" };
  i = skipFiller(s, dsml);

  const wrapper = matchFirstKeyword(s, i, TOOL_CALLS_KEYWORDS);
  if (wrapper === "prefix") return { kind: "prefix" };
  if (wrapper === "no") return { kind: "no" };
  i = skipFiller(s, wrapper.end);
  if (i >= s.length) return { kind: "prefix" };
  if (s[i] !== ">") return { kind: "no" };
  return { kind: "open", end: i + 1, name: "tool_calls" };
}

function extractAttribute(tag: string, attribute: string): string | undefined {
  const pattern = new RegExp(`\\b${attribute}\\s*=\\s*"([^"]*)"`, "i");
  return pattern.exec(tag)?.[1];
}

function matchIndex(pattern: RegExp, text: string): number {
  return pattern.exec(text)?.index ?? -1;
}

function coerceParameterValue(raw: string, tag: string): unknown {
  const value = raw.trim();
  const stringFlag = extractAttribute(tag, "string");
  if (stringFlag?.toLowerCase() === "true") return value;
  if (!value) return "";
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseParameters(body: string): Record<string, unknown> {
  const input: Record<string, unknown> = {};
  let cursor = 0;

  while (cursor < body.length) {
    const open = PARAM_TAG_RE.exec(body.slice(cursor));
    if (!open) break;
    const tag = open[0];
    const tagEnd = cursor + open.index + tag.length;
    const rest = body.slice(tagEnd);

    const boundaries = [
      matchIndex(PARAM_CLOSE_RE, rest),
      matchIndex(PARAM_BARE_CLOSE_RE, rest),
      matchIndex(PARAM_TAG_RE, rest),
    ].filter((index) => index !== -1);
    const valueEnd = tagEnd + (boundaries.length ? Math.min(...boundaries) : rest.length);

    const name = extractAttribute(tag, "name");
    if (name) input[name] = coerceParameterValue(body.slice(tagEnd, valueEnd), tag);

    cursor = Math.max(valueEnd, tagEnd);
  }

  return input;
}

type Candidate =
  | { kind: "none" }
  | { kind: "hold"; index: number }
  | { kind: "release"; index: number; end: number }
  | { kind: "call"; index: number; name: string; input: Record<string, unknown>; end: number };

function findCandidate(s: string, declared: ReadonlySet<string>): Candidate {
  let searchFrom = 0;

  for (;;) {
    const start = s.indexOf("<", searchFrom);
    if (start === -1) return { kind: "none" };

    const open = readInvokeOpen(s, start);
    if (open.kind === "no") {
      searchFrom = start + 1;
      continue;
    }
    if (open.kind === "prefix") return { kind: "hold", index: start };
    if (!declared.has(open.name)) return { kind: "release", index: start, end: open.end };

    const close = INVOKE_CLOSE_RE.exec(s.slice(open.end));
    if (!close) return { kind: "hold", index: start };

    const body = s.slice(open.end, open.end + close.index);
    let end = open.end + close.index + close[0].length;
    const trailing = /^\s*/.exec(s.slice(end))!;
    const wrapperClose = TRAILING_WRAPPER_CLOSE_RE.exec(s.slice(end + trailing[0].length));
    if (wrapperClose) end += trailing[0].length + wrapperClose[0].length;

    return { kind: "call", index: start, name: open.name, input: parseParameters(body), end };
  }
}

export function createDsmlRecoveryScanner(options: {
  declaredToolNames: ReadonlySet<string>;
}): DsmlRecoveryScanner {
  const declared = options.declaredToolNames;
  let buffer = "";
  let nextCallIndex = 0;
  let afterCall = false;

  function drain(): DsmlScanResult {
    let visible = "";
    const toolCalls: RecoveredToolCall[] = [];

    for (;;) {
      if (afterCall) {
        let i = 0;
        while (i < buffer.length && isWhitespaceChar(buffer[i]!)) i++;
        if (i === buffer.length) break;
        const trailingClose = readTrailingWrapperClose(buffer, i);
        if (trailingClose.kind === "prefix") break;
        if (trailingClose.kind === "open") {
          buffer = buffer.slice(trailingClose.end);
          afterCall = false;
          continue;
        }
        afterCall = false;
      }

      const candidate = findCandidate(buffer, declared);
      if (candidate.kind === "none") {
        visible += buffer;
        buffer = "";
        break;
      }
      if (candidate.index > 0) {
        visible += buffer.slice(0, candidate.index);
        buffer = buffer.slice(candidate.index);
        continue;
      }
      if (candidate.kind === "hold") break;
      if (candidate.kind === "release") {
        visible += buffer.slice(0, candidate.end);
        buffer = buffer.slice(candidate.end);
        continue;
      }

      toolCalls.push({
        id: `dsml_${nextCallIndex++}`,
        name: candidate.name,
        input: candidate.input,
      });
      buffer = buffer.slice(candidate.end);
      afterCall = true;
    }

    return { visible, toolCalls };
  }

  return {
    push(chunk: string): DsmlScanResult {
      buffer += chunk;
      if (buffer.length > MAX_HELD_CHARS) {
        const released = buffer;
        buffer = "";
        afterCall = false;
        return { visible: released, toolCalls: [] };
      }
      return drain();
    },

    flush(): DsmlScanResult {
      const held = buffer;
      buffer = "";
      afterCall = false;
      return { visible: held, toolCalls: [] };
    },
  };
}
