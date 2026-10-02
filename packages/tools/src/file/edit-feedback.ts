import type { ToolResult } from "@vykor/core";
import { EditPlanError } from "./edit-plan.js";

/** Line-shaped location hints, not a parser of block comments/templates or replacement values. */
function declarationKey(line: string): string | undefined {
  const variable = line.match(/^\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=(?!=|>)/);
  if (variable) return `variable:${variable[1]}`;
  const quoted = line.match(/^\s*(["'])([A-Za-z_$][\w$.-]*)\1\s*:/);
  if (quoted) return `key:${quoted[2]}`;
  const property = line.match(/^\s*(--[A-Za-z_][\w-]*|[A-Za-z_][\w-]*)\s*:/);
  return property ? `property:${property[1]}` : undefined;
}

/** Diagnose only the original snapshot: earlier batch steps have never reached disk. */
export function editFailureResult(error: EditPlanError, original: string): ToolResult {
  const body = original.replace(/^\uFEFF/, "");
  const normalizedBody = body.replace(/\r\n/g, "\n");
  const lines = normalizedBody === "" ? [] : (normalizedBody.endsWith("\n") ? normalizedBody.slice(0, -1) : normalizedBody).split("\n");
  const locations: number[] = [];
  const diagnosable = error.match && error.match.kind !== "identical";
  const actualMatches = diagnosable && error.editIndex === 1 && error.match?.locations.length;
  if (actualMatches) {
    for (const span of error.match!.locations) locations.push(body.slice(0, span.start).split("\n").length);
  } else if (diagnosable && error.edit) {
    const anchors = [...new Set(error.edit.old_string.split(/\r?\n/).map(line => line.trim()))]
      .filter(line => line.length >= 4).sort((a, b) => b.length - a.length).slice(0, 2);
    for (const [index, line] of lines.entries()) {
      if (anchors.some(anchor => line.includes(anchor))) locations.push(index + 1);
      if (locations.length >= 3) break;
    }
    if (!locations.length) {
      const keys = [...new Set(error.edit.old_string.split(/\r?\n/).map(declarationKey).filter((key): key is string => key !== undefined))].slice(0, 2);
      for (const [index, line] of lines.entries()) {
        const key = declarationKey(line);
        if (key && keys.includes(key)) locations.push(index + 1);
        if (locations.length >= 3) break;
      }
    }
  }
  const windows = [...new Map([...new Set(locations)].slice(0, 3).map(line => ({
    startLine: Math.max(1, line - 2), endLine: Math.min(lines.length, Math.max(1, line - 2) + 6),
  })).map(window => [window.startLine, window] as const)).values()];
  const blocks = [error.message];
  if (error.editIndex !== undefined) blocks.push(`Edit ${error.editIndex} failed; no edits were written.`);
  if (windows.length) {
    blocks.push(actualMatches ? "Original file context at candidate matches:" : "Original file context near anchors (location hints, not replacement matches):");
    for (const window of windows) {
      blocks.push(`Lines ${window.startLine}-${window.endLine}:`, ...lines.slice(window.startLine - 1, window.endLine).map((line, index) =>
        `${window.startLine + index}: ${line.length > 400 ? line.slice(0, 400) + " … [line truncated]" : line}`));
    }
    blocks.push("Do not copy line-number prefixes or truncation markers into old_string.");
  } else if (diagnosable) blocks.push(`No useful original-file anchor found (${lines.length} lines). Use Read or Grep to locate current content.`);
  let text = blocks.join("\n");
  if (text.length > 4096) text = text.slice(0, 4040) + "\n… [diagnostic truncated; use Read for complete lines]";
  return {
    content: [{ type: "text", text }], isError: true, failureKind: "invalid_input", executionState: "not_started",
    recoveryHint: error.match?.kind === "identical" ? "old_string 与 new_string 相同，没有修改；无需此编辑时直接继续，否则修正替换参数。" :
      error.match ? `根据原文修正 old_string；可 Read offset=${windows[0]?.startLine ?? 1} limit=7 或 Grep 定位，不复制行号或截断标记。` : "修正编辑参数；本次未写入文件。",
    metadata: { editFailure: { kind: error.match?.kind ?? "invalid_input", editIndex: error.editIndex,
      source: "original_file", totalLines: lines.length, windows,
      ...(error.match && error.editIndex === 1 ? { matchCount: error.match.matchCount } : {}),
      ...(actualMatches ? { matchLines: locations } : {}),
    } },
  };
}
