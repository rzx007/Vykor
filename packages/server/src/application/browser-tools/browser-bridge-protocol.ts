import type { BrowserAction, BrowserDeveloperAction } from "./browser-host.js";

interface BrowserBridgeCommandBase {
  type: "command";
  requestId: string;
  sessionId: string;
  cwd: string;
  deadlineAt: number;
}

export type BrowserBridgeCommand = BrowserBridgeCommandBase & (
  | { kind: "browser"; action: BrowserAction; includeScreenshot: boolean }
  | { kind: "developer"; action: BrowserDeveloperAction }
);

export type BrowserBridgeEvent = BrowserBridgeCommand
  | { type: "hello"; connectionId: string }
  | { type: "cancel"; requestId: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isBrowserAction(value: Record<string, unknown>): boolean {
  switch (value.action) {
    case "inspect": return true;
    case "navigate": return typeof value.url === "string";
    case "click": return typeof value.elementId === "string";
    case "type": return typeof value.elementId === "string" && typeof value.text === "string";
    case "scroll": return (value.direction === "up" || value.direction === "down")
      && (value.amount === undefined || Number.isFinite(value.amount));
    default: return false;
  }
}

function isDeveloperAction(value: Record<string, unknown>): boolean {
  switch (value.action) {
    case "inspect_dom": return value.selector === undefined || typeof value.selector === "string";
    case "inspect_styles": return typeof value.selector === "string";
    case "start_diagnostics":
    case "read_diagnostics":
    case "stop_diagnostics": return true;
    default: return false;
  }
}

export function parseBrowserBridgeEvent(value: unknown): BrowserBridgeEvent {
  if (isRecord(value)) {
    if (value.type === "hello" && typeof value.connectionId === "string") {
      return { type: value.type, connectionId: value.connectionId };
    }
    if (value.type === "cancel" && typeof value.requestId === "string") {
      return { type: value.type, requestId: value.requestId };
    }
    if (value.type === "command" && typeof value.requestId === "string"
      && typeof value.sessionId === "string" && typeof value.cwd === "string"
      && Number.isSafeInteger(value.deadlineAt) && isRecord(value.action)
      && ((value.kind === "browser" && typeof value.includeScreenshot === "boolean" && isBrowserAction(value.action))
        || (value.kind === "developer" && isDeveloperAction(value.action)))) {
      return value as unknown as BrowserBridgeCommand;
    }
  }
  throw new Error("Invalid browser host event.");
}
