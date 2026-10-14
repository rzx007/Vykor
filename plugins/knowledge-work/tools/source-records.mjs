import { createHash, randomUUID } from "node:crypto";
import { appendFile, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { join, relative, isAbsolute } from "node:path";
/** @typedef {Record<string, any>} Row */
/** @typedef {import('@vykor/plugins/sdk').NativeToolInvocationContext} Context */
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;
/** @param {string} root @param {string} path */
const inside = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== ".." && !part.startsWith("../") && !part.startsWith("..\\"); };
/** @param {Context} context @param {string} category @param {boolean} write */
async function directory(context, category, write = false) {
  if (write && !context.permissions.filesystem?.includes("write")) throw new Error("Plugin data write permission is required");
  if (!write && !context.permissions.filesystem?.includes("read")) throw new Error("Plugin data read permission is required");
  const base = context.plugin.dataDir;
  if (write) await mkdir(base, { recursive: true });
  const root = await realpath(base);
  let target = root;
  for (const segment of ["research", category]) {
    const candidate = join(target, segment);
    if (write) await mkdir(candidate, { recursive: true });
    target = await realpath(candidate);
    if (!inside(root, target)) throw new Error("Unsafe plugin data directory");
  }
  return target;
}
/** Persist only source data produced by the plugin's actual retrieval/import paths.
 * Checksums detect damage; they do not authenticate against a user or another process.
 * @param {Context} context @param {Row} source */
export async function saveResearchSource(context, source) {
  const url = new URL(source.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || typeof source.text !== "string") throw new Error("Invalid source");
  const id = randomUUID(), text = source.text.slice(0, 100_000);
  const record = { schema_version: 1, id, source: { ...source, text, accessed_at: source.accessed_at ?? new Date().toISOString(),
    text_truncated: Boolean(source.text_truncated || text.length < source.text.length) } };
  const json = JSON.stringify(record);
  if (Buffer.byteLength(json) > 1_000_000) throw new Error("Source record is too large");
  const target = await directory(context, "sources", true);
  await writeFile(join(target, id + ".json"), JSON.stringify({ ...record, checksum: createHash("sha256").update(json).digest("hex") }), { encoding: "utf8", flag: "wx" });
  return id;
}
/** @param {Context} context @param {Row[]} attempts */
export async function appendResearchAttempts(context, attempts) {
  const target = await directory(context, "requests", true);
  const session = createHash("sha256").update(context.sessionId ?? "").digest("hex");
  const path = join(target, session + ".jsonl");
  try { if (!inside(target, await realpath(path))) throw new Error("Unsafe ledger path"); }
  catch (error) { if (/** @type {Row} */ (error).code !== "ENOENT") throw error; }
  await appendFile(path, attempts.map(row => JSON.stringify({ ...row, session_id: context.sessionId ?? null, run_id: context.runId ?? null })).join("\n") + "\n", "utf8");
}
/** @param {Row} input @param {Context} context @param {boolean} verification */
export async function readResearchSources(input, context, verification = false) {
  if (!context.permissions.filesystem?.includes("read")) throw new Error("Plugin data read permission is required");
  const refs = input.source_refs ?? [];
  if (!Array.isArray(refs) || refs.length > 24 || refs.some(ref => typeof ref !== "string" || !uuid.test(ref))) throw new TypeError("Invalid source reference");
  const since = input.since === undefined ? 0 : Date.parse(input.since);
  if (!Number.isFinite(since)) throw new TypeError("Invalid since date");
  const maxChars = input.max_chars ?? 12_000;
  if (!Number.isInteger(maxChars) || maxChars < 0 || maxChars > 50_000) throw new TypeError("max_chars must be 0–50000");
  const offset = verification ? 0 : input.offset ?? 0;
  if (!Number.isInteger(offset) || offset < 0 || offset > 100_000) throw new TypeError("offset must be 0–100000");
  context.signal.throwIfAborted();
  /** @type {Row[]} */ const sources = [];
  /** @type {Row[]} */ const issues = [];
  /** @type {Row[]} */ let ledger = [];
  let remaining = verification ? 24 * 100_000 : maxChars, complete = true;
  const asOf = new Date().toISOString();
  for (const ref of new Set(refs)) {
    try {
      const target = await directory(context, "sources"), path = await realpath(join(target, ref + ".json"));
      if (!inside(target, path) || (await stat(path)).size > 1_000_000) throw new Error("Invalid source path or size");
      const { checksum, ...record } = JSON.parse(await readFile(path, "utf8"));
      if (record.schema_version !== 1 || record.id !== ref || !record.source || typeof record.source.text !== "string" ||
          checksum !== createHash("sha256").update(JSON.stringify(record)).digest("hex")) throw new Error("Damaged source record");
      const start = Math.min(offset, record.source.text.length);
      const text = record.source.text.slice(start, start + remaining); remaining -= text.length;
      sources.push({ ...record.source, id: record.source.id ?? ref, source_ref: ref, text, plugin_recorded: true,
        stored_chars: record.source.text.length, returned_chars: text.length, returned_offset: start,
        source_text_truncated: typeof record.source.text_truncated === "boolean" ? record.source.text_truncated : null,
        read_truncated: start > 0 || text.length < record.source.text.length,
        next_offset: start + text.length < record.source.text.length ? start + text.length : null,
        text_truncated: Boolean(record.source.text_truncated || start > 0 || text.length < record.source.text.length) });
    } catch (error) {
      context.signal.throwIfAborted();
      issues.push({ source_ref: ref, code: /** @type {Row} */ (error).code === "ENOENT" ? "source_record_missing" : "source_record_invalid" });
    }
  }
  if (!verification) try {
    const target = await directory(context, "requests"), session = createHash("sha256").update(context.sessionId ?? "").digest("hex");
    const path = await realpath(join(target, session + ".jsonl"));
    if (!inside(target, path) || (await stat(path)).size > 2_000_000) throw new Error("Ledger exceeds read limit");
    const rows = (await readFile(path, "utf8")).split("\n").filter(Boolean);
    if (rows.length > 2000) complete = false;
    const seen = new Set();
    ledger = rows.slice(0, 2000).map(line => JSON.parse(line)).filter(row => {
      if (row.session_id !== (context.sessionId ?? null) || !Number.isFinite(Date.parse(row.recorded_at)) || Date.parse(row.recorded_at) < since) return false;
      const key = row.request_id ?? (row.tool_call_id ? `${row.run_id}:${row.tool_call_id}` : undefined);
      if (key && seen.has(key)) return false;
      if (key) seen.add(key);
      return true;
    });
  } catch (error) { if (/** @type {Row} */ (error).code !== "ENOENT") complete = false; }
  return { sources, fetch_ledger: ledger, issues, ledger_complete: complete, as_of: asOf };
}
/** @type {import('@vykor/plugins/sdk').NativeToolDefinition} */
export const researchSourcesTool = {
  name: "KnowledgeResearchSources", safeToRetry: false, toolResultInput: "tool_result_id",
  description: "读取插件来源与本会话请求账本；返回保存长度、读取长度、来源截断与读取截断。offset可分段回查保存原文。op=import按本轮Tool-Result-Id导入WebFetch实际结果，不接收模型转抄正文；不提供宿主认证。",
  inputSchema: { type: "object", additionalProperties: false, properties: {
    op: { type: "string", enum: ["read", "import"] }, tool_result_id: { type: "string", minLength: 1, maxLength: 200 },
    source_refs: { type: "array", maxItems: 24, items: { type: "string", minLength: 36, maxLength: 36 } },
    since: { type: "string", maxLength: 40 }, max_chars: { type: "integer" }, offset: { type: "integer", minimum: 0, maximum: 100000 },
  } },
  async invoke(input, context) {
    if (input.op === "import") {
      const result = context.toolResult;
      if (!result || result.toolName !== "WebFetch") throw new Error("Import requires an actual WebFetch result from this Run");
      const text = result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
      const header = /^URL: ([^\n]+)\nStatus: (\d+)\nContent-Type: [^\n]*\n\n/u.exec(text);
      await appendResearchAttempts(context, [{ kind: "fetch", status: result.isError ? "failed" : "ok",
        tool: result.toolName, tool_call_id: result.toolUseId, url: header?.[1], recorded_at: new Date().toISOString() }]);
      if (result.isError || !header) return { content: [{ type: "text", text: JSON.stringify({ imported: false, reason: "source_request_failed_or_unusable" }) }] };
      const body = text.slice(header[0].length);
      const source_ref = await saveResearchSource(context, { url: header[1], text: body, source_type: "web", origin: "tool_result",
        text_truncated: /\n\.\.\.\[truncated\]\s*$/u.test(body) });
      return { content: [{ type: "text", text: JSON.stringify({ imported: true, source_ref }) }] };
    }
    if (input.tool_result_id !== undefined) throw new Error("tool_result_id is only used by op=import");
    const result = await readResearchSources(input, context);
    const sources = result.sources.map(({ plugin_recorded: _marker, origin: _origin, ...source }) => source);
    return { content: [{ type: "text", text: JSON.stringify({ ...result, sources }) }] };
  },
};

/** @type {import('@vykor/plugins/sdk').NativeToolRegister} */
export const registerTools = () => [researchSourcesTool];
