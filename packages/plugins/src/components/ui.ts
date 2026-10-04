import { createHash } from "node:crypto";
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { PLUGIN_UI_LIMITS, stringifyPluginUiJson, type PluginUiInventory } from "@vykor/protocol";
import { resolveNativePluginPath } from "../paths.js";
import type { NativeUiComponentMetadata, PluginComponentResult, ValidatedNativePlugin } from "../types.js";
import { PluginUiManifestV1Schema } from "./ui-schema.js";

class UiReadError extends Error {
  constructor(readonly code: "plugin_ui_invalid_definition" | "plugin_ui_payload_too_large") {
    super(code);
  }
}

/** Read only a previously validated component; verify the exact bytes again at delivery. */
export async function readNativeUiDocument(root: string, component: NativeUiComponentMetadata): Promise<{ html: string; sha256: string }> {
  const { bytes } = await readUiBytes(root, component.declaredEntry, PLUGIN_UI_LIMITS.htmlBytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const digest = createHash("sha256").update(stringifyPluginUiJson(component.definition)).update(Buffer.from([0])).update(bytes).digest("hex");
  if (sha256 !== component.htmlSha256 || digest !== component.componentDigest) throw new UiReadError("plugin_ui_invalid_definition");
  return { html: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes), sha256 };
}

/** Read a bounded ordinary file without accepting in-root symlinks or junctions. */
async function readUiBytes(root: string, declaredPath: string, limit: number): Promise<{ path: string; bytes: Buffer }> {
  const realRoot = await realpath(root);
  const path = await resolveNativePluginPath(realRoot, declaredPath);
  const lexicalPath = resolve(realRoot, declaredPath);
  let parent = realRoot;
  for (const segment of relative(realRoot, lexicalPath).split(sep)) {
    parent = join(parent, segment);
    if ((await lstat(parent)).isSymbolicLink()) throw new UiReadError("plugin_ui_invalid_definition");
  }
  const target = await lstat(path);
  if (!target.isFile()) throw new UiReadError("plugin_ui_invalid_definition");
  if (target.size > limit) throw new UiReadError("plugin_ui_payload_too_large");
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile() || before.dev !== target.dev || before.ino !== target.ino) {
      throw new UiReadError("plugin_ui_invalid_definition");
    }
    if (before.size > limit) throw new UiReadError("plugin_ui_payload_too_large");
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > limit) throw new UiReadError("plugin_ui_payload_too_large");
    const after = await file.stat();
    const current = await lstat(path);
    if (size !== after.size || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || !current.isFile() || current.dev !== after.dev || current.ino !== after.ino
      || await realpath(lexicalPath) !== path) {
      throw new UiReadError("plugin_ui_invalid_definition");
    }
    const bytes = buffer.subarray(0, size);
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { path, bytes };
  } finally {
    await file.close();
  }
}

/** Static metadata only: never import a Tool module or execute plugin frontend code. */
export async function loadNativeUiMetadata(
  plugin: ValidatedNativePlugin,
): Promise<PluginComponentResult<NativeUiComponentMetadata[]>> {
  const value: NativeUiComponentMetadata[] = [];
  const seen = new Set<string>();
  let currentManifest: string | undefined;
  try {
    const declarations = plugin.manifest.components.ui ?? [];
    if (declarations.length > PLUGIN_UI_LIMITS.manifestCount) throw new UiReadError("plugin_ui_invalid_definition");
    for (const declaredManifest of declarations) {
      currentManifest = declaredManifest;
      const source = await readUiBytes(plugin.root, declaredManifest, PLUGIN_UI_LIMITS.manifestBytes);
      const manifest = PluginUiManifestV1Schema.parse(JSON.parse(
        new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source.bytes),
      ));
      for (const definition of manifest.components) {
        if (seen.has(definition.id) || value.length >= PLUGIN_UI_LIMITS.componentCount) {
          throw new UiReadError("plugin_ui_invalid_definition");
        }
        seen.add(definition.id);
        const html = await readUiBytes(plugin.root, definition.entry, PLUGIN_UI_LIMITS.htmlBytes);
        value.push({
          definition,
          declaredManifest,
          declaredEntry: definition.entry,
          entryPath: html.path,
          htmlSha256: createHash("sha256").update(html.bytes).digest("hex"),
          componentDigest: createHash("sha256")
            .update(stringifyPluginUiJson(definition)).update(Buffer.from([0])).update(html.bytes).digest("hex"),
        });
      }
    }
    return { status: "loaded", value, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", diagnostics: [{
      severity: "error", phase: "load", component: "ui", pluginId: plugin.manifest.id,
      code: error instanceof UiReadError ? error.code : "plugin_ui_invalid_definition",
      message: "插件 UI 定义或入口无效，请检查插件包后重新导入。",
      ...(currentManifest ? { path: currentManifest } : {}),
    }] };
  }
}

export function summarizeNativeUi(
  manifestCount: number,
  loaded: PluginComponentResult<NativeUiComponentMetadata[]> | undefined,
): PluginUiInventory | undefined {
  if (manifestCount === 0) return undefined;
  const count = loaded?.status === "loaded" ? loaded.value?.length : undefined;
  return { manifestCount, componentCount: count ?? null, validatedComponentCount: count ?? 0 };
}
