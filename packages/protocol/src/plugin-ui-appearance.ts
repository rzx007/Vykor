import { isPluginUiRecord } from "./plugin-ui.js";
import { ProtocolValidationError } from "./requests.js";

export interface PluginUiAppearance {
  theme: "light" | "dark";
  colors: {
    background: string;
    foreground: string;
    muted: string;
    mutedForeground: string;
    primary: string;
    primaryForeground: string;
    accent: string;
    border: string;
    destructive: string;
  };
  fontFamily: string;
  fontSizePx: number;
  reducedMotion: boolean;
}

const colorFields = [
  "background",
  "foreground",
  "muted",
  "mutedForeground",
  "primary",
  "primaryForeground",
  "accent",
  "border",
  "destructive",
] as const;

/** Only plain values travel over the bridge; actual CSS color support is checked by the browser. */
export function parsePluginUiAppearance(value: unknown): PluginUiAppearance {
  function invalid(): never {
    throw new ProtocolValidationError("Invalid Plugin UI appearance");
  }
  const exact = (record: Record<string, unknown>, keys: readonly string[]) =>
    keys.every((key) => Object.hasOwn(record, key)) &&
    Object.keys(record).every((key) => keys.includes(key));
  const safeValue = (value: unknown, limit: number): value is string =>
    typeof value === "string" &&
    value.trim().length > 0 &&
    value.length <= limit &&
    !/[;{}\\\u0000-\u001f\u007f]/.test(value) &&
    !/url\s*\(|var\s*\(|\/\*|\*\/|@|:\/\//i.test(value);
  if (
    !isPluginUiRecord(value) ||
    !exact(value, [
      "theme",
      "colors",
      "fontFamily",
      "fontSizePx",
      "reducedMotion",
    ]) ||
    (value.theme !== "light" && value.theme !== "dark") ||
    !isPluginUiRecord(value.colors) ||
    !exact(value.colors, colorFields) ||
    !safeValue(value.fontFamily, 256) ||
    typeof value.fontSizePx !== "number" ||
    !Number.isFinite(value.fontSizePx) ||
    value.fontSizePx < 8 ||
    value.fontSizePx > 32 ||
    typeof value.reducedMotion !== "boolean"
  )
    invalid();
  const colors = value.colors as Record<string, unknown>;
  if (!colorFields.every((key) => safeValue(colors[key], 128))) invalid();
  return structuredClone(value) as unknown as PluginUiAppearance;
}
