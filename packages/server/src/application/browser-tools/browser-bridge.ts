import { randomUUID } from "node:crypto";
import type { ToolResult } from "@vykor/agent-contracts";
import type { BrowserApproval, BrowserDeveloperExecuteInput, BrowserDeveloperResult, BrowserHost, BrowserObservation } from "./browser-host.js";
import type { BrowserBridgeCommand, BrowserBridgeEvent } from "./browser-bridge-protocol.js";

const maxPending = 16;
const maxExecutionMs = 5 * 60_000;
export const BROWSER_BRIDGE_MAX_SCREENSHOT_BYTES = 8 * 1024 * 1024;
export const BROWSER_BRIDGE_MAX_RESULT_BODY_BYTES = 12 * 1024 * 1024;
export const BROWSER_BRIDGE_RESULT_TOO_LARGE = "The browser result was too large to return. The operation may already have run.";

type BrowserResult = BrowserObservation | BrowserDeveloperResult;
type ApprovalKind = "origin" | "developer";

interface Connection {
  id: string;
  send: (event: BrowserBridgeEvent) => boolean;
  close: () => void;
}

interface Pending {
  command: BrowserBridgeCommand;
  approvals: Partial<Record<ApprovalKind, BrowserApproval>>;
  approvalPending: boolean;
  controller: AbortController;
  finish: (result: BrowserResult | Error) => void;
}

export class BrowserBridgeError extends Error {
  constructor(message: string, readonly executionState: "not_started" | "unknown") {
    super(message);
  }
}

export function browserBridgeFailure(error: unknown): Pick<ToolResult, "executionState" | "failureKind"> {
  if (!(error instanceof BrowserBridgeError)) return {};
  return {
    executionState: error.executionState,
    failureKind: error.executionState === "unknown" ? "unknown_outcome" : "precondition",
  };
}

/** One attached Desktop, with no replay buffer for browser actions. */
export class DesktopBrowserBridge implements BrowserHost {
  private connection?: Connection;
  private readonly pending = new Map<string, Pending>();
  private closed = false;

  get connected(): boolean { return this.connection !== undefined; }

  attach(send: Connection["send"], close: Connection["close"]): string | undefined {
    if (this.connection || this.closed) return;
    const id = randomUUID();
    if (!send({ type: "hello", connectionId: id })) return;
    this.connection = { id, send, close };
    return id;
  }

  detach(connectionId: string): void {
    const connection = this.connection;
    if (connection?.id !== connectionId) return;
    this.connection = undefined;
    for (const pending of this.pending.values()) {
      pending.finish(new BrowserBridgeError("Desktop disconnected after the browser operation was dispatched.", "unknown"));
    }
    connection.close();
  }

  close(): void {
    this.closed = true;
    if (this.connection) this.detach(this.connection.id);
  }

  execute(input: Parameters<BrowserHost["execute"]>[0]): Promise<BrowserObservation> {
    return this.dispatch({ ...this.commandIdentity(input), kind: "browser", action: input.action,
      includeScreenshot: input.includeScreenshot }, { origin: input.approve }, input.signal) as Promise<BrowserObservation>;
  }

  executeDeveloper(input: BrowserDeveloperExecuteInput): Promise<BrowserDeveloperResult> {
    return this.dispatch({ ...this.commandIdentity(input), kind: "developer", action: input.action },
      { origin: input.approveOrigin, developer: input.approveDeveloper }, input.signal) as Promise<BrowserDeveloperResult>;
  }

  async approve(connectionId: string, requestId: string, kind: ApprovalKind, reason: string, signal: AbortSignal): Promise<boolean | undefined> {
    const pending = this.lookup(connectionId, requestId);
    const approve = pending?.approvals[kind];
    if (!pending || !approve || pending.approvalPending) return;
    pending.approvalPending = true;
    const approvalSignal = AbortSignal.any([signal, pending.controller.signal]);
    try {
      if (approvalSignal.aborted) return;
      const approved = await approve(reason, approvalSignal);
      return approvalSignal.aborted ? undefined : approved;
    } catch (error) {
      if (!approvalSignal.aborted) throw error;
    } finally {
      pending.approvalPending = false;
    }
  }

  complete(connectionId: string, requestId: string, body: Record<string, unknown>): boolean {
    const pending = this.lookup(connectionId, requestId);
    if (!pending || pending.approvalPending) return false;
    pending.finish(parseResult(pending.command, body));
    return true;
  }

  private lookup(connectionId: string, requestId: string): Pending | undefined {
    return this.connection?.id === connectionId ? this.pending.get(requestId) : undefined;
  }

  private commandIdentity(input: { sessionId: string; cwd: string; deadlineAt?: number }) {
    return {
      type: "command" as const,
      requestId: randomUUID(),
      sessionId: input.sessionId,
      cwd: input.cwd,
      deadlineAt: Math.min(input.deadlineAt ?? Infinity, Date.now() + maxExecutionMs),
    };
  }

  private async dispatch(command: BrowserBridgeCommand, approvals: Pending["approvals"], signal?: AbortSignal): Promise<BrowserResult> {
    const connection = this.connection;
    if (!connection) throw new BrowserBridgeError("Open Desktop and connect its browser to use this tool.", "not_started");
    if (signal?.aborted || command.deadlineAt <= Date.now()) {
      throw new BrowserBridgeError("Browser operation was cancelled before dispatch.", "not_started");
    }
    if (this.pending.size >= maxPending) {
      throw new BrowserBridgeError("Desktop browser is busy.", "not_started");
    }
    return await new Promise<BrowserResult>((resolve, reject) => {
      const controller = new AbortController();
      const cancel = () => {
        finish(new BrowserBridgeError("Browser operation was cancelled after dispatch.", "unknown"));
        if (!connection.send({ type: "cancel", requestId: command.requestId })) this.detach(connection.id);
      };
      const timer = setTimeout(cancel, Math.max(0, command.deadlineAt - Date.now()));
      timer.unref();
      const finish = (result: BrowserResult | Error) => {
        this.pending.delete(command.requestId);
        signal?.removeEventListener("abort", cancel);
        clearTimeout(timer);
        controller.abort();
        if (result instanceof Error) reject(result);
        else resolve(result);
      };
      this.pending.set(command.requestId, { command, approvals, approvalPending: false, controller, finish });
      signal?.addEventListener("abort", cancel, { once: true });
      if (!connection.send(command)) finish(new BrowserBridgeError("Desktop browser stream is busy.", "not_started"));
    });
  }
}

function parseResult(command: BrowserBridgeCommand, body: Record<string, unknown>): BrowserResult | Error {
  if (typeof body.error === "string" && body.error.length > 0 && body.error.length <= 4_096
    && body.result === undefined && body.screenshotBase64 === undefined) return new Error(body.error);
  const result = body.result;
  if (!result || typeof result !== "object" || Array.isArray(result) || body.error !== undefined) {
    throw new Error("Invalid browser result.");
  }
  const value = result as Record<string, unknown>;
  if (typeof value.url !== "string") throw new Error("Invalid browser result URL.");
  if (command.kind === "developer") {
    if (value.action !== command.action.action || !Object.hasOwn(value, "data")
      || (value.truncated !== undefined && typeof value.truncated !== "boolean") || body.screenshotBase64 !== undefined) {
      throw new Error("Invalid browser developer result.");
    }
    return { action: command.action.action, url: value.url, data: value.data,
      ...(value.truncated === true ? { truncated: true } : {}) };
  }
  if (typeof value.title !== "string" || typeof value.pageText !== "string"
    || (value.elements !== undefined && !Array.isArray(value.elements))
    || (value.annotations !== undefined && !Array.isArray(value.annotations))) {
    throw new Error("Invalid browser observation.");
  }
  const screenshot = body.screenshotBase64;
  const observation: BrowserObservation = { url: value.url, title: value.title, pageText: value.pageText,
    elements: value.elements as BrowserObservation["elements"], annotations: value.annotations as BrowserObservation["annotations"] };
  if (screenshot === undefined) return observation;
  if (command.action.action !== "inspect" || !command.includeScreenshot || typeof screenshot !== "string"
    || screenshot.length > Math.ceil(BROWSER_BRIDGE_MAX_SCREENSHOT_BYTES / 3) * 4 || screenshot.length % 4 !== 0) {
    throw new Error("Invalid browser screenshot.");
  }
  const bytes = Buffer.from(screenshot, "base64");
  if (bytes.byteLength > BROWSER_BRIDGE_MAX_SCREENSHOT_BYTES || bytes.toString("base64") !== screenshot
    || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new Error("Invalid browser screenshot.");
  }
  return { ...observation, screenshotBytes: bytes };
}
