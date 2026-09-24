import { lstat, readFile, realpath } from "node:fs/promises";
import { join } from "node:path";
import type { PluginDiagnostic } from "../diagnostics.js";
import { NativePluginPathError, resolveNativePluginPath } from "../paths.js";
import {
  NATIVE_PLUGIN_COMPONENT_KINDS,
  type NativePluginComponentKind,
  type NativePluginValidationResult,
  type NativeToolComponent,
  type VykorPluginManifestV1,
  type ValidatedNativePlugin,
} from "../types.js";
import { VykorPluginManifestV1Schema } from "./schema-v1.js";

export type { NativePluginValidationResult } from "../types.js";

const MANIFEST_RELATIVE_PATH = join(".vykor-plugin", "plugin.json");

interface ComponentSource {
  kind: NativePluginComponentKind;
  declaredPath: string;
}

function getComponentSources(manifest: VykorPluginManifestV1): ComponentSource[] {
  const sources: ComponentSource[] = [];
  for (const kind of NATIVE_PLUGIN_COMPONENT_KINDS) {
    const declarations = manifest.components[kind] as
      | Array<string | NativeToolComponent>
      | undefined;
    if (declarations === undefined) continue;
    for (const declaration of declarations) {
      sources.push({
        kind,
        declaredPath: typeof declaration === "string" ? declaration : declaration.entry,
      });
    }
  }
  return sources;
}

function invalid(diagnostics: PluginDiagnostic[]): NativePluginValidationResult {
  return { status: "invalid", diagnostics };
}

/** 只接受 `.vykor-plugin/plugin.json`，并验证所有声明组件的真实路径边界。 */
export async function validateNativePlugin(root: string): Promise<NativePluginValidationResult> {
  const manifestPath = join(root, MANIFEST_RELATIVE_PATH);
  let source: string;
  try {
    source = await readFile(manifestPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return invalid([
      {
        severity: "error",
        phase: "parse",
        code: code === "ENOENT" ? "native_manifest_missing" : "native_manifest_unreadable",
        message:
          code === "ENOENT"
            ? `Native manifest not found at ${MANIFEST_RELATIVE_PATH}`
            : `Native manifest cannot be read: ${String(error)}`,
        path: manifestPath,
      },
    ]);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch (error) {
    return invalid([
      {
        severity: "error",
        phase: "parse",
        code: "native_manifest_invalid_json",
        message: `Native manifest is not valid JSON: ${String(error)}`,
        path: manifestPath,
      },
    ]);
  }

  const parsed = VykorPluginManifestV1Schema.safeParse(raw);
  if (!parsed.success) {
    return invalid(
      parsed.error.issues.map((issue) => ({
        severity: "error",
        phase: "validate",
        code: "native_manifest_schema_invalid",
        message: issue.message,
        path: manifestPath,
        component: issue.path.join("."),
        details: { code: issue.code, path: issue.path },
      })),
    );
  }

  const diagnostics: PluginDiagnostic[] = [];
  const seenSources = new Map<string, ComponentSource>();
  for (const sourceDeclaration of getComponentSources(parsed.data)) {
    let resolvedPath: string;
    try {
      resolvedPath = await resolveNativePluginPath(root, sourceDeclaration.declaredPath);
    } catch (error) {
      const pathError = error instanceof NativePluginPathError ? error : undefined;
      diagnostics.push({
        severity: "error",
        phase: "validate",
        code:
          pathError?.code === "path_outside_root"
            ? "component_path_outside_root"
            : "component_path_invalid",
        message: pathError?.message ?? `Cannot resolve component path: ${String(error)}`,
        pluginId: parsed.data.id,
        component: sourceDeclaration.kind,
        path: sourceDeclaration.declaredPath,
      });
      continue;
    }

    const canonicalPath = await realpath(resolvedPath).catch(() => resolvedPath);
    const canonicalKey = process.platform === "win32" ? canonicalPath.toLowerCase() : canonicalPath;
    const duplicate = seenSources.get(canonicalKey);
    if (duplicate !== undefined) {
      diagnostics.push({
        severity: "error",
        phase: "validate",
        code: "component_source_duplicate",
        message: `Component source duplicates ${duplicate.kind}:${duplicate.declaredPath}`,
        pluginId: parsed.data.id,
        component: sourceDeclaration.kind,
        path: sourceDeclaration.declaredPath,
      });
    } else {
      seenSources.set(canonicalKey, sourceDeclaration);
    }

    try {
      await lstat(resolvedPath);
    } catch (error) {
      diagnostics.push({
        severity: "error",
        phase: "validate",
        code: "component_path_missing",
        message: `Declared component source does not exist: ${sourceDeclaration.declaredPath}`,
        pluginId: parsed.data.id,
        component: sourceDeclaration.kind,
        path: sourceDeclaration.declaredPath,
        details: String(error),
      });
    }
  }

  if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) return invalid(diagnostics);

  const plugin: ValidatedNativePlugin = {
    root: await realpath(root),
    manifestPath: await realpath(manifestPath),
    manifest: parsed.data,
  };
  return { status: "valid", plugin, diagnostics };
}
