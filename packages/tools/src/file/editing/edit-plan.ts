import {
  EditMatchError, convertToLineEnding, detectLineEnding, normalizeLineEndings, replace,
} from "./edit-replacers.js";

type TextEdit = { old_string: string; new_string: string; replace_all?: boolean };

export class EditPlanError extends Error {
  constructor(message: string, readonly editIndex?: number, readonly edit?: TextEdit, readonly match?: EditMatchError) {
    super(message);
    this.name = "EditPlanError";
  }
}

/** Validate forms without reading a file; identical-string checks follow sandbox checks. */
export function parseTextEdits(input: Record<string, unknown>): TextEdit[] {
  let items: unknown[];
  if (Object.hasOwn(input, "edits")) {
    if (["old_string", "new_string", "replace_all"].some(key => Object.hasOwn(input, key))) {
      throw new EditPlanError("Provide either edits or a single old_string/new_string replacement, not both.");
    }
    if (!Array.isArray(input.edits) || input.edits.length === 0) throw new EditPlanError("edits must be a non-empty array.");
    items = input.edits;
  } else items = [input];
  return items.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new EditPlanError("Each edit must be an object.", index + 1);
    const edit = item as Record<string, unknown>;
    if (typeof edit.old_string !== "string" || edit.old_string.length === 0) throw new EditPlanError("old_string must not be empty.", index + 1);
    if (typeof edit.new_string !== "string") throw new EditPlanError("new_string must be a string.", index + 1);
    if (edit.replace_all !== undefined && typeof edit.replace_all !== "boolean") throw new EditPlanError("replace_all must be boolean.", index + 1);
    return { old_string: edit.old_string, new_string: edit.new_string, replace_all: edit.replace_all as boolean | undefined };
  });
}

/** One text computation for actual writes and the existing host preview API. */
export function planTextEdits(content: string, input: Record<string, unknown>): { content: string; editCount: number } {
  const edits = parseTextEdits(input);
  const hasBom = content.startsWith("\uFEFF");
  let body = hasBom ? content.slice(1) : content;
  const ending = detectLineEnding(body);
  for (const [index, edit] of edits.entries()) {
    const old = edit.old_string.replace(/^\uFEFF/, "");
    const next = edit.new_string.replace(/^\uFEFF/, "");
    if (old.length === 0) throw new EditPlanError("old_string must not be empty.", index + 1);
    try {
      body = replace(body, convertToLineEnding(normalizeLineEndings(old), ending),
        convertToLineEnding(normalizeLineEndings(next), ending), edit.replace_all);
    } catch (error) {
      if (error instanceof EditMatchError) throw new EditPlanError(error.message, index + 1, edit, error);
      throw error;
    }
  }
  return { content: (hasBom ? "\uFEFF" : "") + body, editCount: edits.length };
}
