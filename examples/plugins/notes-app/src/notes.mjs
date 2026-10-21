import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createHash } from "node:crypto";
/** A single stdio service serializes writes. Revision + operation receipt are one atomic file. */
export class Notes {
  constructor(file) {
    this.file = file;
    this.state = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : { revision: 0, text: "欢迎一起编辑这篇笔记。", operations: {} };
  }
  read() { return { id: "welcome", uri: "notes://welcome", revision: this.state.revision, text: this.state.text }; }
  write(input, kind) {
    const { operationId, expectedRevision } = input;
    if (typeof operationId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(operationId) || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error("invalid_operation");
    const payload = kind === "save" ? { text: input.text } : { start: input.start, end: input.end, text: input.text };
    if (typeof input.text !== "string" || Buffer.byteLength(input.text) > 48_000) throw new Error("invalid_text");
    const fingerprint = createHash("sha256").update(JSON.stringify({ kind, expectedRevision, ...payload })).digest("hex");
    const previous = Object.hasOwn(this.state.operations, operationId) ? this.state.operations[operationId] : undefined;
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw new Error("operation_id_conflict");
      return { ...previous.result, duplicate: true };
    }
    if (expectedRevision !== this.state.revision) throw new Error("revision_conflict: 草稿已保留，请先读取最新笔记，再手工合并。");
    if (kind === "replace" && (!Number.isSafeInteger(input.start) || !Number.isSafeInteger(input.end) || input.start < 0 || input.end < input.start || input.end > this.state.text.length)) throw new Error("invalid_selection");
    const text = kind === "save" ? input.text : this.state.text.slice(0, input.start) + input.text + this.state.text.slice(input.end);
    if (Buffer.byteLength(text) > 48_000) throw new Error("note_too_large");
    if (Object.keys(this.state.operations).length >= 10_000) throw new Error("operation_receipt_limit");
    const result = { id: "welcome", uri: "notes://welcome", revision: this.state.revision + 1, text, operationId, saved: true };
    const next = { revision: result.revision, text, operations: { ...this.state.operations, [operationId]: { fingerprint, result } } };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file + ".pending", JSON.stringify(next)); renameSync(this.file + ".pending", this.file);
    this.state = next; return result;
  }
}
