import { randomUUID } from "node:crypto";
import type { PermissionRequestRecord } from "@vykor/domain-contracts/sessions";
import type { PermissionReplyStatus } from "../../permissions/permission-broker.js";
import type {
  ComputerAction,
  ComputerApprovalProposal,
  ComputerBridgeEvent,
  ComputerExecutionState,
  ComputerReply,
  ComputerResult,
  ComputerRunIdentity,
} from "./computer-bridge-protocol.js";

const maxExecutionMs = 5 * 60_000;

interface CaptureEvidence {
  requestId: string;
  revoked: boolean;
}

type DispatchResult = ComputerResult & { isImageCurrent?: () => boolean };

interface Connection {
  id: string;
  controller: AbortController;
  captures: Map<string, CaptureEvidence>;
  send(event: ComputerBridgeEvent): boolean;
  close(): void;
}

interface Pending {
  id: string;
  run: ComputerRunIdentity;
  action: ComputerAction["type"];
  dispatched?: boolean;
  isCurrent(): boolean;
  signal: AbortSignal;
  approvalAccess?: ComputerApprovalAccess;
  approval?: { requestId?: string; approved?: boolean; replyAttempted?: boolean };
  finish(result: DispatchResult | ComputerBridgeError): void;
}

export interface ComputerApprovalAccess {
  isOriginalScope(): boolean;
  ask(proposal: ComputerApprovalProposal, signal: AbortSignal, isCurrent: () => boolean, register: (requestId: string) => void): Promise<boolean>;
  reply(input: { requestId: string; status: PermissionReplyStatus }): PermissionRequestRecord;
}

function needsDispatch(action: ComputerAction["type"]): boolean {
  return action !== "observe" && action !== "capture" && action !== "handoff";
}

export class ComputerBridgeError extends Error {
  constructor(message: string, readonly executionState: ComputerExecutionState) {
    super(message);
  }
}

/** A single Desktop connection with one in-flight command and no replay. */
export class DesktopComputerBridge {
  private connection?: Connection;
  private pending?: Pending;
  private closed = false;

  constructor(private readonly captureApproval?: (run: ComputerRunIdentity) => ComputerApprovalAccess | undefined) {}

  attach(send: Connection["send"], close: Connection["close"]): string | undefined {
    if (this.closed || this.connection) return;
    const id = randomUUID();
    if (!send({ type: "connected", connectionId: id })) return;
    this.connection = { id, controller: new AbortController(), captures: new Map(), send, close };
    return id;
  }

  connectionSignal(id: string): AbortSignal | undefined {
    const connection = this.connection;
    return connection?.id === id ? connection.controller.signal : undefined;
  }

  detach(connectionId: string): void {
    const connection = this.connection;
    if (connection?.id !== connectionId) return;
    const pending = this.pending;
    this.connection = undefined;
    connection.controller.abort();
    pending?.finish(new ComputerBridgeError("Desktop disconnected after the Computer request was dispatched.", "unknown"));
    connection.close();
  }

  close(): void {
    this.closed = true;
    if (this.connection) this.detach(this.connection.id);
  }

  endRun(connectionId: string, run: ComputerRunIdentity): void {
    const connection = this.connection;
    if (connection?.id !== connectionId) return;
    connection.captures.delete(run.runId);
    const pending = this.pending;
    if (pending?.run.runId === run.runId && pending.run.sessionId === run.sessionId && pending.run.inputId === run.inputId) {
      pending.finish(new ComputerBridgeError("The Computer run ended after dispatch.", "unknown"));
    }
    if (!connection.send({ type: "ended", run })) this.detach(connectionId);
  }

  revokeImage(connectionId: string, requestId: string): boolean {
    const connection = this.connection;
    if (connection?.id !== connectionId) return false;
    for (const capture of connection.captures.values()) {
      if (capture.requestId !== requestId) continue;
      capture.revoked = true;
      return true;
    }
    return false;
  }

  async execute(
    connectionId: string,
    run: ComputerRunIdentity,
    action: ComputerAction,
    options: { signal?: AbortSignal; deadlineAt?: number; isCurrent?: () => boolean } = {},
  ): Promise<DispatchResult> {
    const connection = this.connection;
    if (connection?.id !== connectionId) {
      throw new ComputerBridgeError("The Computer task no longer has a Desktop connection.", "not_started");
    }
    const deadlineAt = Math.min(options.deadlineAt ?? Infinity, Date.now() + maxExecutionMs);
    const { signal } = options;
    if (signal?.aborted || !Number.isFinite(deadlineAt) || deadlineAt <= Date.now()) {
      throw new ComputerBridgeError("The Computer request ended before dispatch.", "not_started");
    }
    if (this.pending) throw new ComputerBridgeError("Desktop Computer is busy.", "not_started");

    const approvalAccess = needsDispatch(action.type) ? this.captureApproval?.(run) : undefined;
    const requestId = randomUUID();
    if (action.type === "capture") connection.captures.set(run.runId, { requestId, revoked: false });
    return await new Promise<DispatchResult>((resolve, reject) => {
      const finished = new AbortController();
      const pending: Pending = {
        id: requestId,
        run,
        action: action.type,
        signal: finished.signal,
        approvalAccess,
        isCurrent: () => this.pending === pending && this.connection === connection
          && !connection.controller.signal.aborted && !signal?.aborted && Date.now() < deadlineAt
          && (options.isCurrent?.() ?? true),
        finish: (result) => {
          if (this.pending !== pending) return;
          this.pending = undefined;
          clearTimeout(timer);
          signal?.removeEventListener("abort", cancel);
          finished.abort();
          if (result instanceof Error) reject(result);
          else resolve(result);
        },
      };
      const cancel = () => {
        pending.finish(new ComputerBridgeError("The Computer request ended after dispatch.", "unknown"));
        if (this.connection === connection && !connection.send({ type: "cancel", requestId })) {
          this.detach(connectionId);
        }
      };
      const timer = setTimeout(cancel, Math.max(0, deadlineAt - Date.now()));
      timer.unref();
      this.pending = pending;
      signal?.addEventListener("abort", cancel, { once: true });
      if (!connection.send({ type: "execute", requestId, run, action, deadlineAt })) {
        pending.finish(new ComputerBridgeError("The Desktop Computer stream is busy.", "not_started"));
        this.detach(connectionId);
      }
    });
  }

  complete(connectionId: string, requestId: string, reply: ComputerReply): boolean {
    const connection = this.connection;
    const pending = this.pending;
    if (connection?.id !== connectionId || pending?.id !== requestId) return false;
    if ("result" in reply && ((reply.result.image && (pending.action !== "capture" || !pending.isCurrent()))
      || (pending.approval && (!pending.approval.approved || !pending.isCurrent()))
      || (needsDispatch(pending.action) && !pending.dispatched))) return false;
    if ("error" in reply) {
      pending.finish(new ComputerBridgeError(reply.error, reply.executionState));
      return true;
    }
    const { text, image } = reply.result;
    const runId = pending.run.runId;
    const capture = connection.captures.get(runId);
    const isImageCurrent = () => this.connection === connection && capture?.requestId === requestId && !capture.revoked
      && connection.captures.get(runId) === capture;
    pending.finish(image && isImageCurrent() ? { text, image, isImageCurrent } : { text });
    return true;
  }

  authorizeDispatch(connectionId: string, requestId: string): boolean {
    const pending = this.pending;
    if (this.connection?.id !== connectionId || pending?.id !== requestId || pending.dispatched || !pending.isCurrent()
      || !pending.approvalAccess?.isOriginalScope()) return false;
    if ((pending.action === "foreground" || pending.approval) && !pending.approval?.approved) return false;
    pending.dispatched = true;
    return true;
  }

  async requestApproval(connectionId: string, requestId: string, proposal: ComputerApprovalProposal, requestSignal: AbortSignal): Promise<boolean | undefined> {
    const pending = this.pending;
    const access = pending?.approvalAccess;
    if (this.connection?.id !== connectionId || pending?.id !== requestId || !access || pending.action === "open_app"
      || pending.approval || requestSignal.aborted || !pending.isCurrent()) return;
    const approval: NonNullable<Pending["approval"]> = {};
    pending.approval = approval;
    const signal = AbortSignal.any([requestSignal, pending.signal, this.connection.controller.signal]);
    const approved = await access.ask(proposal, signal, pending.isCurrent, id => { approval.requestId = id; });
    approval.approved = approved && !signal.aborted && pending.isCurrent();
    return approval.approved;
  }

  replyApproval(connectionId: string, input: { requestId: string; sessionId: string; status: PermissionReplyStatus }): PermissionRequestRecord | undefined {
    const pending = this.pending;
    const approval = pending?.approval;
    if (this.connection?.id !== connectionId || !approval || approval.requestId !== input.requestId
      || approval.replyAttempted || pending.run.sessionId !== input.sessionId || !pending.isCurrent()) return;
    const access = pending.approvalAccess;
    if (!access) return;
    approval.replyAttempted = true;
    return access.reply({ requestId: input.requestId, status: input.status });
  }
}
