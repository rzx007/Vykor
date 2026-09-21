export interface ThinkExtraction {
  visible: string;
  reasoning: string;
  leftover: string;
}

const THINK_TAG = "<think>";
const THINK_PAIR_RE = /<think>([\s\S]*?)<\/think>/g;

/**
 * 把正文里的 `<think>…</think>` 拆成三段：可见正文、思考内容、需要等下一个
 * chunk 的残留。`final: true` 表示流已结束：未闭合的块整体算思考内容，只有
 * "可能是标签前缀"的尾巴按正文放出。
 */
export function extractThinkBlocks(
  buffer: string,
  options: { final?: boolean } = {},
): ThinkExtraction {
  let visible = "";
  let reasoning = "";
  let rest = buffer;

  for (;;) {
    THINK_PAIR_RE.lastIndex = 0;
    const match = THINK_PAIR_RE.exec(rest);
    if (!match) break;
    visible += rest.slice(0, match.index);
    reasoning += match[1] ?? "";
    rest = rest.slice(match.index + match[0].length);
  }

  const openIndex = rest.indexOf(THINK_TAG);
  if (openIndex !== -1) {
    visible += rest.slice(0, openIndex);
    const tail = rest.slice(openIndex);
    if (options.final) {
      return { visible, reasoning: reasoning + tail.slice(THINK_TAG.length), leftover: "" };
    }
    return { visible, reasoning, leftover: tail };
  }

  if (options.final) {
    return { visible: visible + rest, reasoning, leftover: "" };
  }

  const maxPrefix = Math.min(rest.length, THINK_TAG.length - 1);
  for (let prefixLen = maxPrefix; prefixLen > 0; prefixLen--) {
    if (THINK_TAG.startsWith(rest.slice(rest.length - prefixLen))) {
      return {
        visible: visible + rest.slice(0, rest.length - prefixLen),
        reasoning,
        leftover: rest.slice(rest.length - prefixLen),
      };
    }
  }

  return { visible: visible + rest, reasoning, leftover: "" };
}
