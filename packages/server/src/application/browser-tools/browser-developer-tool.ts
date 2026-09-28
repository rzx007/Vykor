import type { ToolDefinition, ToolResult } from "@vykor/core";
import type { BrowserDeveloperAction, BrowserHost } from "./browser-host.js";

/** Final server-side ceiling on one developer tool response. */
export const BROWSER_DEVELOPER_MAX_RESULT_BYTES = 48 * 1024;

const MAX_SELECTOR_LENGTH = 512;

const DEVELOPER_TOOL_NAME = "BrowserDeveloper";

export function createBrowserDeveloperTool(host: BrowserHost | undefined): ToolDefinition {
  const available = Boolean(host?.executeDeveloper);
  return {
    name: DEVELOPER_TOOL_NAME,
    description: available
      ? "Inspect the active desktop browser tab for troubleshooting: DOM structure, computed styles, and bounded console/network diagnostics. Each inspection needs its own approval; this tool cannot run arbitrary JavaScript or raw CDP commands."
      : "Browser developer inspection is unavailable in this runtime because the desktop browser host does not support it. Do not call this tool.",
    inputSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
            "inspect_dom",
            "inspect_styles",
            "start_diagnostics",
            "read_diagnostics",
            "stop_diagnostics",
          ],
        },
        selector: { type: "string", maxLength: MAX_SELECTOR_LENGTH },
      },
      required: ["action"],
      additionalProperties: false,
    },
    async execute(input, context) {
      if (!host?.executeDeveloper) {
        return failed(
          "Browser developer inspection is unavailable in this runtime because the desktop browser host does not support it.",
        );
      }
      if (!context.sessionId) {
        return failed("Browser developer inspection requires a desktop session.");
      }
      const action = parseDeveloperAction(input);
      if (!action) {
        return failed("Invalid browser developer action or missing action parameters.");
      }
      if (!context.requestPermission) {
        return failed("This host cannot request browser developer permissions.");
      }

      const ask = async (toolName: "Browser" | "BrowserDeveloper", reason: string) =>
        (await context.requestPermission!({
          toolName,
          reason,
          input: { action: action.action },
        }))?.status === "approved";

      try {
        const result = await host.executeDeveloper({
          action,
          sessionId: context.sessionId,
          cwd: context.cwd,
          approveOrigin: (reason) => ask("Browser", reason),
          approveDeveloper: (reason) => ask(DEVELOPER_TOOL_NAME, reason),
        });
        const serialized = JSON.stringify(result);
        if (Buffer.byteLength(serialized, "utf8") > BROWSER_DEVELOPER_MAX_RESULT_BYTES) {
          return failed(
            `Browser developer result exceeds the ${Math.floor(BROWSER_DEVELOPER_MAX_RESULT_BYTES / 1024)} KiB limit.`,
          );
        }
        return { content: [{ type: "text", text: serialized }] };
      } catch (error) {
        return failed(error instanceof Error ? error.message : String(error));
      }
    },
  };
}

function parseDeveloperAction(input: Record<string, unknown>): BrowserDeveloperAction | null {
  switch (input.action) {
    case "inspect_dom": {
      const selector = parseSelector(input.selector, false);
      if (!selector.ok) return null;
      return selector.value === undefined
        ? { action: "inspect_dom" }
        : { action: "inspect_dom", selector: selector.value };
    }
    case "inspect_styles": {
      const selector = parseSelector(input.selector, true);
      return selector.ok && selector.value !== undefined
        ? { action: "inspect_styles", selector: selector.value }
        : null;
    }
    case "start_diagnostics":
      return { action: "start_diagnostics" };
    case "read_diagnostics":
      return { action: "read_diagnostics" };
    case "stop_diagnostics":
      return { action: "stop_diagnostics" };
    default:
      return null;
  }
}

function parseSelector(
  value: unknown,
  required: boolean,
): { ok: true; value?: string } | { ok: false } {
  if (value === undefined || value === null) return required ? { ok: false } : { ok: true };
  if (typeof value !== "string") return { ok: false };
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_SELECTOR_LENGTH) return { ok: false };
  // Control characters (including NUL and newlines) never belong in a selector.
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) return { ok: false };
  return { ok: true, value: trimmed };
}

function failed(message: string): ToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}
