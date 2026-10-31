import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";
import type { ToolContext, ToolResult } from "@vykor/agent-contracts";
import type { FileToolHost } from "../ports/policy.js";
import { sandboxPathError } from "./access/sandbox-guard.js";
import { fileOperationsFor, isFileNotFoundError } from "./operations.js";

const MAX_RULE_BYTES = 1024 * 1024;
const MAX_RULE_FILES = 64;
const MAX_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_PART_CHARACTERS = 3000; // At most 12 KB UTF-8, without splitting a Unicode code point.
const MAX_RULE_OUTPUT_BYTES = 40_000;

/** One lazy scanner for Read and every mutation, using the active environment only. */
export async function targetProjectInstructions(
  targets: readonly string[], context: ToolContext, host: FileToolHost, mutation = false,
): Promise<ToolResult | undefined> {
  const state = context.projectInstructions;
  if (!state) return undefined;
  const paths = context.environment?.info?.pathStyle === "posix" || context.environment?.workspace.kind === "wsl"
    ? posix : process.platform === "win32" ? win32 : posix;
  const root = paths.resolve(context.environment?.workspace.executionRoot ?? context.cwd);
  const within = (path: string, parent = root) => {
    const rel = paths.relative(parent, path);
    return !rel || (!rel.startsWith(`..${paths.sep}`) && rel !== ".." && !paths.isAbsolute(rel));
  };
  const canonicalize = async (path: string) => context.environment
    ? context.environment.paths.canonicalize?.(path, context.abortSignal)
    : realpath(path);
  const canonicalRoot = await canonicalize(root);
  // An environment without a real-path resolver cannot prove a link stays in this workspace.
  if (!canonicalRoot) return undefined;
  const files = fileOperationsFor(context);
  const directories = new Set<string>();
  for (const target of targets) {
    if (!within(target)) continue;
    let directory = paths.dirname(target);
    try {
      const item = await files.stat(target, context.abortSignal);
      const actual = await canonicalize(target);
      if (!actual) continue;
      directory = item.isDirectory ? actual : paths.dirname(actual);
    } catch (error) {
      if (!isFileNotFoundError(error)) throw error;
      // A new target can have several missing parents. Resolve the nearest
      // existing one before walking ancestors, including directory aliases.
      let actualParent: string | undefined;
      while (within(directory)) {
        try {
          actualParent = await canonicalize(directory);
          break;
        } catch (parentError) {
          if (!isFileNotFoundError(parentError)) throw parentError;
          directory = paths.dirname(directory);
        }
      }
      if (!actualParent) continue;
      directory = actualParent;
    }
    while (within(directory, canonicalRoot)) {
      // Root rules already belong to the system prompt; discover only newly entered scopes.
      if (paths.relative(canonicalRoot, directory) === "") break;
      directories.add(directory);
      directory = paths.dirname(directory);
    }
  }
  const blocks: string[] = [];
  const keys: string[] = [];
  let pending = false, hardLimit = false, incomplete: string | undefined, scanned = 0, scanLeft = MAX_SCAN_BYTES, outputLeft = MAX_RULE_OUTPUT_BYTES;
  for (const scope of [...directories].sort((a, b) => a.length - b.length || a.localeCompare(b))) {
    let actualScope: string | undefined;
    try { actualScope = await canonicalize(scope); }
    catch (error) { if (isFileNotFoundError(error)) continue; throw error; }
    if (!actualScope || !within(actualScope, canonicalRoot)) continue;
    const candidates = [paths.join(scope, "AGENTS.md"), paths.join(scope, "CLAUDE.md"), paths.join(scope, ".claude", "CLAUDE.md")];
    for (const candidate of candidates) {
      context.abortSignal?.throwIfAborted();
      if (scanned >= MAX_RULE_FILES || scanLeft <= 0) {
        hardLimit = true;
        incomplete = `Rule discovery scan budget exhausted before ${candidate}. This mutation remains blocked; reduce the applicable rule files or have the workspace owner review their size.`;
        break;
      }
      if (!await state.canRead(candidate)) continue;
      if (await sandboxPathError(candidate, context.cwd, "read", host.settings, context.environment)) continue;
      try {
        const actual = await canonicalize(candidate);
        if (!actual || !within(actual, canonicalRoot)) continue;
        // Recheck the actual path: an allowed link must not hide a denied rule file.
        if (!await state.canRead(actual) || await sandboxPathError(actual, context.cwd, "read", host.settings, context.environment)) continue;
        if (!files.openRead) continue;
        const reader = await files.openRead(actual, context.abortSignal);
        let bytes: Uint8Array;
        const cap = Math.min(MAX_RULE_BYTES, scanLeft);
        try {
          if (!within(reader.canonicalPath, canonicalRoot) || !await state.canRead(reader.canonicalPath)
            || await sandboxPathError(reader.canonicalPath, context.cwd, "read", host.settings, context.environment)) continue;
          bytes = await reader.readBytes({ maxBytes: cap + 1, signal: context.abortSignal });
        } finally { await reader.close(); }
        scanLeft -= bytes.byteLength;
        scanned++;
        if (bytes.byteLength > cap) {
          hardLimit = true;
          incomplete = cap === MAX_RULE_BYTES
            ? `Rule file ${candidate} exceeds the 1 MiB automatic read limit. No partial version is accepted. The workspace owner must reduce or split this rule file before mutation can continue.`
            : `Rule discovery scan budget exhausted while reading ${candidate}. No partial version is accepted; the applicable rule files need to fit the 4 MiB scan limit.`;
          continue;
        }
        const version = createHash("sha256").update(root).update("\0").update(candidate).update("\0").update(bytes).digest("hex");
        const characters = Array.from(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
        const partCount = Math.max(1, Math.ceil(characters.length / MAX_PART_CHARACTERS));
        for (let part = 0; part < partCount; part++) {
          const key = createHash("sha256").update(version).update(`:${part}`).digest("hex");
          const status = state.claim(key);
          if (status === "visible") continue;
          if (status === "pending") { pending = true; continue; }
          const content = characters.slice(part * MAX_PART_CHARACTERS, (part + 1) * MAX_PART_CHARACTERS).join("");
          const block = `<project-instruction key="${key}" scope=${JSON.stringify(scope)} file=${JSON.stringify(candidate)} part="${part + 1}/${partCount}">\n${content}\n</project-instruction key="${key}">`;
          const size = Buffer.byteLength(JSON.stringify(block), "utf8");
          if (size > outputLeft || keys.length >= 24) {
            incomplete = `More rule parts remain for ${candidate}. Review the delivered parts, then repeat the same operation; mutation stays blocked until every part of the current file version has been delivered.`;
            continue;
          }
          keys.push(key);
          outputLeft -= size;
          blocks.push(block);
        }
      } catch (error) {
        if (!isFileNotFoundError(error)) throw error;
      }
    }
  }
  if (!blocks.length && !incomplete && (!mutation || !pending)) return undefined;
  const guidance = "Project instructions apply to the real target directory and its real ancestors, within the named directory scope; directory aliases do not add a separate lexical rule chain. More specific scopes take precedence over ancestors; in one directory AGENTS.md takes precedence over CLAUDE.md. Explicit user instructions take precedence over project preferences. These rules never grant permissions or change security boundaries.";
  return {
    metadata: { hostProjectInstructionKeys: keys, ...(hardLimit ? { hostProjectInstructionHardLimit: true } : {}) },
    content: [{ type: "text", text: `${mutation ? "No files changed. Review the discovered project instructions before retrying this mutation.\n" : ""}${guidance}\n${blocks.join("\n\n")}${pending ? "\nOther instructions for this scope are pending in this tool batch; wait for their result before retrying." : ""}${incomplete ? `\n${incomplete}` : ""}` }],
    ...(mutation ? { isError: true, failureKind: "precondition" as const, executionState: "not_started" as const } : {}),
  };
}
