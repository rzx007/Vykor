import { readFile } from "node:fs/promises";
import { HOOK_EVENTS, type HookDefinition, type HookEvent } from "@vykor/core";
import { resolveNativePluginPath } from "../paths.js";
import type { PluginComponentResult, ValidatedNativePlugin } from "../types.js";

const eventSet = new Set<string>(HOOK_EVENTS);
const typeSet = new Set(["command", "http", "prompt", "agent"]);

function parseHook(raw: unknown, event: HookEvent, id: string): HookDefinition {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("hook must be an object");
  const row = raw as Record<string, unknown>;
  const type = row.type;
  if (typeof type !== "string" || !typeSet.has(type)) throw new Error("hook type is invalid");
  const base = {
    id, event, enabled: true,
    ...(typeof row.timeout === "number" ? { timeout: row.timeout } : {}),
    ...(typeof row.matcher === "string" ? { matcher: row.matcher } : {}),
    ...(typeof row.priority === "number" ? { priority: row.priority } : {}),
    ...(typeof row.blockOnFailure === "boolean" ? { blockOnFailure: row.blockOnFailure } : {}),
  };
  if (type === "command" && typeof row.command === "string" && row.command) return { ...base, type, command: row.command };
  if (type === "http" && typeof row.url === "string" && row.url) return { ...base, type, url: row.url };
  if (type === "prompt" && typeof row.prompt === "string" && row.prompt) return { ...base, type, prompt: row.prompt };
  if (type === "agent" && typeof row.prompt === "string" && row.prompt) return { ...base, type, prompt: row.prompt };
  throw new Error(`hook ${type} is missing its required field`);
}

export async function loadNativeHooks(
  plugin: ValidatedNativePlugin,
): Promise<PluginComponentResult<HookDefinition[]>> {
  const hooks: HookDefinition[] = [];
  try {
    for (const declaredPath of plugin.manifest.components.hooks ?? []) {
      const file = await resolveNativePluginPath(plugin.root, declaredPath);
      const raw = JSON.parse(await readFile(file, "utf8")) as unknown;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("hook file must be an object");
      for (const [event, entries] of Object.entries(raw)) {
        if (!eventSet.has(event)) {
          return { status: "invalid", value: hooks, diagnostics: [{
            severity: "error", phase: "load", code: "native_hook_event_invalid",
            message: `Unknown Native hook event: ${event}`, pluginId: plugin.manifest.id,
            component: "hooks", path: declaredPath,
          }] };
        }
        if (!Array.isArray(entries)) throw new Error(`hooks for ${event} must be an array`);
        entries.forEach((entry, index) => hooks.push(parseHook(
          entry, event as HookEvent, `plugin:${plugin.manifest.id}:${event}:${index}`,
        )));
      }
    }
    return { status: "loaded", value: hooks, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", value: hooks, diagnostics: [{
      severity: "error", phase: "load", code: "native_hooks_invalid",
      message: `Cannot load Native hooks: ${String(error)}`, pluginId: plugin.manifest.id,
      component: "hooks",
    }] };
  }
}
