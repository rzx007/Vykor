import type { PluginDiagnostic } from "../diagnostics.js";
import { resolveNativePluginPath } from "../paths.js";
import type {
  NativeToolComponent,
  NativeToolMetadata,
  VykorPluginPermissions,
  PluginComponentResult,
  ValidatedNativePlugin,
} from "../types.js";

const PERMISSION_CATEGORIES = ["filesystem", "network", "process", "secrets"] as const;
type PermissionCategory = (typeof PERMISSION_CATEGORIES)[number];

function parseToolPermission(value: string): { category: PermissionCategory; value: string } | undefined {
  for (const category of PERMISSION_CATEGORIES) {
    for (const separator of [":", "."]) {
      const prefix = `${category}${separator}`;
      if (value.startsWith(prefix) && value.length > prefix.length) {
        return { category, value: value.slice(prefix.length) };
      }
    }
  }
  return undefined;
}

export function resolveEffectiveToolPermissions(
  pluginPermissions: VykorPluginPermissions | undefined,
  requestedPermissions: readonly string[],
): { permissions: VykorPluginPermissions; denied: string[] } {
  const permissions: VykorPluginPermissions = {};
  const denied: string[] = [];
  for (const request of requestedPermissions) {
    const parsed = parseToolPermission(request);
    if (!parsed || !pluginPermissions?.[parsed.category]?.includes(parsed.value)) {
      denied.push(request);
      continue;
    }
    (permissions[parsed.category] ??= []).push(parsed.value);
  }
  return { permissions, denied };
}

function normalizeDeclaration(declaration: string | NativeToolComponent): Required<NativeToolComponent> {
  return typeof declaration === "string"
    ? { entry: declaration, runtime: "node", permissions: [] }
    : {
        entry: declaration.entry,
        runtime: declaration.runtime ?? "node",
        permissions: declaration.permissions ?? [],
      };
}

/** Resolve Native Tool metadata without importing or executing third-party code. */
export async function loadNativeToolMetadata(
  plugin: ValidatedNativePlugin,
): Promise<PluginComponentResult<NativeToolMetadata[]>> {
  const tools: NativeToolMetadata[] = [];
  const diagnostics: PluginDiagnostic[] = [];
  for (const raw of plugin.manifest.components.tools ?? []) {
    const declaration = normalizeDeclaration(raw);
    if (declaration.runtime === "wasm") {
      diagnostics.push({
        severity: "warning",
        phase: "load",
        code: "native_tool_runtime_unsupported",
        message: `Native Tool runtime wasm is recognized but not supported: ${declaration.entry}`,
        pluginId: plugin.manifest.id,
        component: "tools",
        path: declaration.entry,
      });
      continue;
    }
    const effective = resolveEffectiveToolPermissions(
      plugin.manifest.permissions,
      declaration.permissions,
    );
    if (effective.denied.length > 0) {
      diagnostics.push({
        severity: "error",
        phase: "load",
        code: "native_tool_permission_not_declared",
        message: `Tool requests permissions not declared by the plugin: ${effective.denied.join(", ")}`,
        pluginId: plugin.manifest.id,
        component: "tools",
        path: declaration.entry,
        details: { denied: effective.denied },
      });
      continue;
    }
    tools.push({
      declaredEntry: declaration.entry,
      entryPath: await resolveNativePluginPath(plugin.root, declaration.entry),
      runtime: declaration.runtime,
      requestedPermissions: [...declaration.permissions],
      effectivePermissions: effective.permissions,
    });
  }
  return {
    status: tools.length > 0 ? "loaded" : diagnostics.some((item) => item.severity === "error") ? "blocked" : "unsupported",
    ...(tools.length > 0 ? { value: tools } : {}),
    diagnostics,
  };
}
