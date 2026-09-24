/**
 * Shared formatters / pure helpers used by daemon-services and tests.
 * Not a slash-command executor — TUI/daemon use catalog + resource APIs.
 */

import { isKnownOutputStyle, type OutputStyleDefinition } from "@vykor/output-styles";
import {
  renderPromptLayers,
  type PersonalPromptFileDiagnostic,
  type PromptLayers,
} from "@vykor/prompts";

export { coerceConfigValue } from "../config-coerce.js";

/**
 * Parse `/output-style` args into a display message + optional switch.
 * Semantics align with Python `_output_style_handler`.
 */
export function buildOutputStyleResult(
  rawArgs: string,
  styles: OutputStyleDefinition[],
  current: string,
): { message: string; newStyle?: string; isError?: boolean } {
  const trimmed = rawArgs.trim();
  const firstSpace = trimmed.search(/\s/);
  const first = firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace);
  const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

  if (first === "" || first === "show") {
    return { message: `Output style: ${current}` };
  }
  if (first === "list") {
    const lines = styles.map(
      (s) => `${s.name === current ? "* " : "  "}${s.name} [${s.source}]`,
    );
    return { message: lines.join("\n") };
  }

  let styleName: string | undefined;
  if (first === "set" && rest !== "") {
    styleName = rest;
  } else if (rest === "") {
    styleName = first;
  }

  if (styleName !== undefined) {
    if (!isKnownOutputStyle(styleName, styles)) {
      return { message: `Unknown output style: ${styleName}`, isError: true };
    }
    return { message: `Output style set to ${styleName}`, newStyle: styleName };
  }
  return { message: "Usage: /output-style [show|list|NAME]" };
}

const CONTEXT_PREVIEW_CHARS = 2_000;
const SECTION_PREVIEW_CHARS = 350;

function layerCharCount(parts: string[]): number {
  return parts.filter((s) => s.trim()).join("\n\n").length;
}

function formatLayerPreview(name: keyof PromptLayers, parts: string[]): string {
  const sections = parts.filter((s) => s.trim());
  if (sections.length === 0) return [`[${name}]`, "(empty)"].join("\n");

  const previews = sections.map((section, index) => {
    const trimmed = section.trim();
    const preview =
      trimmed.length > SECTION_PREVIEW_CHARS
        ? trimmed.slice(0, SECTION_PREVIEW_CHARS) + "\n... (truncated)"
        : trimmed;
    return `section ${index + 1}:\n${preview}`;
  });

  return [`[${name}]`, ...previews].join("\n\n");
}

export function formatPersonalPromptDiagnostics(diagnostics: PersonalPromptFileDiagnostic[]): string {
  const lines = ["Personal prompt files:"];
  for (const item of diagnostics) {
    const flags = [
      item.truncated ? "truncated" : "",
      item.issues.length > 0 ? `${item.issues.length} issue(s)` : "",
    ].filter(Boolean);
    lines.push(`- ${item.file}: ${item.status}${flags.length ? ` (${flags.join(", ")})` : ""}`);
    lines.push(`  path: ${item.path}`);
    if (item.message) lines.push(`  note: ${item.message}`);
    for (const issue of item.issues) {
      lines.push(`  ${issue.severity}: ${issue.code} - ${issue.message}`);
    }
  }
  return lines.join("\n");
}

export function formatPromptLayersReport(
  layers: PromptLayers,
  previewChars = CONTEXT_PREVIEW_CHARS,
  diagnostics: PersonalPromptFileDiagnostic[] = [],
): string {
  const prompt = renderPromptLayers(layers);
  const preview =
    prompt.length > previewChars
      ? prompt.slice(0, previewChars) + "\n... (truncated)"
      : prompt;
  return [
    "Current system prompt layers:",
    `- stable: ${layers.stable.length} section(s), ${layerCharCount(layers.stable)} characters`,
    `- context: ${layers.context.length} section(s), ${layerCharCount(layers.context)} characters`,
    `- volatile: ${layers.volatile.length} section(s), ${layerCharCount(layers.volatile)} characters`,
    "─".repeat(60),
    formatLayerPreview("stable", layers.stable),
    "─".repeat(60),
    formatLayerPreview("context", layers.context),
    "─".repeat(60),
    formatLayerPreview("volatile", layers.volatile),
    "─".repeat(60),
    "Flat preview:",
    preview,
    "─".repeat(60),
    ...(diagnostics.length > 0
      ? [formatPersonalPromptDiagnostics(diagnostics), "─".repeat(60)]
      : []),
    `Total length: ${prompt.length} characters`,
  ].join("\n");
}
