export type JsonValue = null | boolean | number | string | JsonValue[]
  | { [key: string]: JsonValue };

export interface PluginUiActionDefinition {
  id: string;
  label: string;
  tool: string;
  completion: "keep-open" | "resolve";
}

export interface PluginUiComponentDefinition {
  id: string;
  title: string;
  entry: string;
  surfaces: Array<"tool-result" | "session-sidebar">;
  actions: PluginUiActionDefinition[];
}

export interface PluginUiManifestV1 {
  schemaVersion: 1;
  components: PluginUiComponentDefinition[];
}

/** Static definitions only; these counts do not prove a UI is running. */
export interface PluginUiInventory {
  manifestCount: number;
  componentCount: number | null;
  validatedComponentCount: number;
}

export const PLUGIN_UI_LIMITS = {
  manifestCount: 8,
  manifestBytes: 256 * 1024,
  componentCount: 16,
  actionsPerComponent: 16,
  htmlBytes: 2 * 1024 * 1024,
  titleCodePoints: 80,
  jsonDepth: 20,
} as const;

/** JSON with deterministic object-key order, including numeric and literal prototype keys. */
export function stringifyPluginUiJson(value: unknown): string {
  const render = (item: unknown, depth: number): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean") {
      return JSON.stringify(item);
    }
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null) throw new Error("Plugin UI requires JSON data");
    if (depth >= PLUGIN_UI_LIMITS.jsonDepth) throw new Error("Plugin UI JSON nesting limit exceeded");
    if (Array.isArray(item)) {
      return `[${Array.from(item, child => render(child, depth + 1)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Plugin UI requires plain JSON objects");
    }
    const record = item as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${render(record[key], depth + 1)}`,
    ).join(",")}}`;
  };
  return render(value, 0);
}
