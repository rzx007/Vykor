// 匹配策略移植自 opencode 的 edit 工具（MIT），其实现又源自 cline（Apache-2.0）
// 与 gemini-cli（Apache-2.0）的 diff-apply / editCorrector。

export type EditMatchErrorKind =
  | "identical"
  | "not_found"
  | "ambiguous"
  | "disproportionate";

const EDIT_MATCH_MESSAGES: Record<EditMatchErrorKind, string> = {
  identical: "No changes to apply: oldString and newString are identical.",
  not_found: "old_string not found in file.",
  ambiguous:
    "Found multiple matches for oldString. Provide more surrounding context to make the match unique.",
  disproportionate:
    "Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.",
};

export function editMatchMessage(kind: EditMatchErrorKind): string {
  return EDIT_MATCH_MESSAGES[kind];
}

export class EditMatchError extends Error {
  readonly kind: EditMatchErrorKind;

  constructor(kind: EditMatchErrorKind) {
    super(EDIT_MATCH_MESSAGES[kind]);
    this.name = "EditMatchError";
    this.kind = kind;
  }
}

export function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

export function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text;
  return text.replaceAll("\n", "\r\n");
}

export function isDisproportionateMatch(search: string, oldString: string): boolean {
  const oldLines = oldString.split("\n").length;
  const searchLines = search.split("\n").length;
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  return (
    search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4)
  );
}

export type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

export const SimpleReplacer: Replacer = function* (content, find) {
  if (find.length > 0 && content.includes(find)) yield find;
};

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop();
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      const originalLine = originalLines[i + j];
      const searchLine = searchLines[j];
      if (originalLine === undefined || searchLine === undefined || originalLine.trim() !== searchLine.trim()) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    let matchStartIndex = 0;
    for (let k = 0; k < i; k++) {
      matchStartIndex += originalLines[k]!.length + 1;
    }

    let matchEndIndex = matchStartIndex;
    for (let k = 0; k < searchLines.length; k++) {
      matchEndIndex += originalLines[i + k]!.length;
      if (k < searchLines.length - 1) {
        matchEndIndex += 1;
      }
    }

    const candidate = content.substring(matchStartIndex, matchEndIndex);
    if (candidate.length > 0) yield candidate;
  }
};

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();
  const normalizedFind = normalizeWhitespace(find);
  if (normalizedFind.length === 0) return;

  const lines = content.split("\n");
  for (const line of lines) {
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line;
      continue;
    }
    if (!normalizeWhitespace(line).includes(normalizedFind)) continue;

    const words = find.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const pattern = words
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    for (const match of line.matchAll(new RegExp(`(?=(${pattern}))`, "g"))) {
      const candidate = match[1];
      if (candidate) yield candidate;
    }
  }

  const findLines = find.split("\n");
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length);
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
        yield block.join("\n");
      }
    }
  }
};

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n");
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) return text;
    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/);
        return match?.[1]?.length ?? 0;
      }),
    );
    return lines
      .map((line) => (line.trim().length === 0 ? line : line.slice(minIndent)))
      .join("\n");
  };

  const normalizedFind = removeIndentation(find);
  if (normalizedFind.length === 0) return;
  const contentLines = content.split("\n");
  const findLines = find.split("\n");

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n");
    if (removeIndentation(block) === normalizedFind) {
      yield block;
    }
  }
};

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string =>
    str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar: string) => {
      switch (capturedChar) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "r":
          return "\r";
        case "'":
          return "'";
        case '"':
          return '"';
        case "`":
          return "`";
        case "\\":
          return "\\";
        case "\n":
          return "\n";
        case "$":
          return "$";
        default:
          return match;
      }
    });

  const unescapedFind = unescapeString(find);
  if (unescapedFind.length === 0) return;
  if (content.includes(unescapedFind)) {
    yield unescapedFind;
  }

  const lines = content.split("\n");
  const findLines = unescapedFind.split("\n");
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (unescapeString(block) === unescapedFind) {
      yield block;
    }
  }
};

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim();
  if (trimmedFind.length === 0 || trimmedFind === find) return;

  if (content.includes(trimmedFind)) {
    yield trimmedFind;
  }

  const lines = content.split("\n");
  const findLines = find.split("\n");
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (block.trim() === trimmedFind) {
      yield block;
    }
  }
};

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  if (find.length === 0) return;
  let startIndex = 0;
  while (true) {
    const index = content.indexOf(find, startIndex);
    if (index === -1) break;
    yield find;
    startIndex = index + find.length;
  }
};

const BLOCK_SIMILARITY_THRESHOLD = 0.65;

function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") return Math.max(a.length, b.length);

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

function blockRangeToSubstring(
  lines: string[],
  startLine: number,
  endLine: number,
): string {
  return lines.slice(startLine, endLine + 1).join("\n");
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");

  if (searchLines[searchLines.length - 1] === "") searchLines.pop();
  if (searchLines.length < 3) return;

  const firstLineSearch = searchLines[0]!.trim();
  const lastLineSearch = searchLines[searchLines.length - 1]!.trim();
  const searchBlockSize = searchLines.length;
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25));

  const candidates: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i]!.trim() !== firstLineSearch) continue;
    const expectedEndLine = i + searchBlockSize - 1;
    const minEndLine = Math.max(i + 2, expectedEndLine - maxLineDelta);
    const maxEndLine = Math.min(originalLines.length - 1, expectedEndLine + maxLineDelta);
    for (let j = minEndLine; j <= maxEndLine; j++) {
      if (originalLines[j]!.trim() !== lastLineSearch) continue;
      candidates.push({ startLine: i, endLine: j });
    }
  }

  if (candidates.length === 0) return;

  const similarityFor = (startLine: number, endLine: number): number => {
    const actualBlockSize = endLine - startLine + 1;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
    if (linesToCheck <= 0) return 1;
    let similarity = 0;
    for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
      const originalLine = originalLines[startLine + j]!.trim();
      const searchLine = searchLines[j]!.trim();
      const maxLen = Math.max(originalLine.length, searchLine.length);
      if (maxLen === 0) continue;
      similarity += 1 - levenshtein(originalLine, searchLine) / maxLen;
    }
    return similarity / linesToCheck;
  };

  for (const candidate of candidates) {
    const similarity = similarityFor(candidate.startLine, candidate.endLine);
    if (similarity >= BLOCK_SIMILARITY_THRESHOLD) {
      yield blockRangeToSubstring(originalLines, candidate.startLine, candidate.endLine);
    }
  }
};

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n");
  if (findLines[findLines.length - 1] === "") findLines.pop();
  if (findLines.length < 3) return;

  const contentLines = content.split("\n");
  const firstLine = findLines[0]!.trim();
  const lastLine = findLines[findLines.length - 1]!.trim();

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i]!.trim() !== firstLine) continue;
    const endLine = i + findLines.length - 1;
    if (endLine >= contentLines.length || contentLines[endLine]!.trim() !== lastLine) continue;

    const blockLines = contentLines.slice(i, endLine + 1);
    let matchingLines = 0;
    let totalNonEmptyLines = 0;
    for (let k = 1; k < blockLines.length - 1; k++) {
      const blockLine = blockLines[k]!.trim();
      const findLine = findLines[k]!.trim();
      if (blockLine.length > 0 || findLine.length > 0) {
        totalNonEmptyLines++;
        if (blockLine === findLine) matchingLines++;
      }
    }
    if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
      yield blockLines.join("\n");
    }
  }
};

export const REPLACERS: Replacer[] = [
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  EscapeNormalizedReplacer,
  TrimmedBoundaryReplacer,
  ContextAwareReplacer,
  MultiOccurrenceReplacer,
];

interface MatchSpan {
  start: number;
  end: number;
  search: string;
}

function collectMatchSpans(content: string, searches: string[]): MatchSpan[] {
  const spans = new Map<string, MatchSpan>();
  for (const search of searches) {
    let start = content.indexOf(search);
    while (start !== -1) {
      const span = { start, end: start + search.length, search };
      spans.set(`${span.start}:${span.end}`, span);
      start = content.indexOf(search, start + 1);
    }
  }
  return [...spans.values()].sort((left, right) => left.start - right.start || left.end - right.end);
}

export function replace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
  replacers: Replacer[] = REPLACERS,
): string {
  if (oldString === newString) throw new EditMatchError("identical");

  for (const replacer of replacers) {
    const searches = [...new Set(replacer(content, oldString))].filter(
      (search) => search.length > 0,
    );
    const spans = collectMatchSpans(content, searches);
    if (spans.length === 0) continue;

    if (!replaceAll) {
      if (spans.length > 1) throw new EditMatchError("ambiguous");
      const span = spans[0]!;
      if (isDisproportionateMatch(span.search, oldString)) {
        throw new EditMatchError("disproportionate");
      }
      return content.slice(0, span.start) + newString + content.slice(span.end);
    }

    if (spans.some((span) => isDisproportionateMatch(span.search, oldString))) {
      throw new EditMatchError("disproportionate");
    }
    for (let index = 1; index < spans.length; index++) {
      if (spans[index]!.start < spans[index - 1]!.end) {
        throw new EditMatchError("ambiguous");
      }
    }

    let updated = content;
    for (const span of [...spans].reverse()) {
      updated = updated.slice(0, span.start) + newString + updated.slice(span.end);
    }
    return updated;
  }

  throw new EditMatchError("not_found");
}
