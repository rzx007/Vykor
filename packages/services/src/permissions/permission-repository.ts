import { randomUUID } from "node:crypto";

import type {
  CreatePermissionRequestInput,
  ListPermissionRequestsOptions,
  PermissionRequestRecord,
  ReplyPermissionInput,
} from "@openharness/protocol";

import type { PermissionRepositoryOptions } from "./permission-records.js";

export class PermissionRepository {
  constructor(private readonly options: PermissionRepositoryOptions) {}

  create(input: CreatePermissionRequestInput): PermissionRequestRecord {
    return this.write(() => {
      this.options.assertSession(input.sessionId);
      if (input.runId && !this.options.getRun(input.runId)) {
        throw new Error(`Session run not found: ${input.runId}`);
      }
      const id = input.id ?? randomUUID();
      if (this.options.storage.state.permissions[id]) {
        throw new Error(`Permission request already exists: ${id}`);
      }
      const timestamp = Date.now();
      const request: PermissionRequestRecord = {
        id,
        sessionId: input.sessionId,
        ...(input.runId ? { runId: input.runId } : {}),
        toolName: input.toolName,
        payload: input.payload ?? {},
        status: "pending",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      this.options.storage.state.permissions[id] = request;
      this.options.storage.mutations.permissions.add(id);
      this.emit("permission.asked", request);
      return clone(request);
    });
  }

  reply(input: ReplyPermissionInput): PermissionRequestRecord {
    return this.write(() => this.replyPending(input));
  }

  expirePending(
    reason = "Daemon restarted before the permission was resolved",
  ): number {
    return this.write(() => {
      const pending = Object.values(this.options.storage.state.permissions).filter(
        (request) => request.status === "pending",
      );
      for (const request of pending) {
        this.replyPending({
          requestId: request.id,
          status: "expired",
          decision: reason,
        });
      }
      return pending.length;
    });
  }

  get(requestId: string): PermissionRequestRecord | undefined {
    const request = this.options.storage.state.permissions[requestId];
    return request ? clone(request) : undefined;
  }

  list(
    options: ListPermissionRequestsOptions = {},
  ): PermissionRequestRecord[] {
    let requests = Object.values(this.options.storage.state.permissions);
    if (options.sessionId) {
      requests = requests.filter((request) => request.sessionId === options.sessionId);
    }
    if (options.status) {
      requests = requests.filter((request) => request.status === options.status);
    }
    if (options.toolName) {
      requests = requests.filter((request) => request.toolName === options.toolName);
    }
    requests.sort((left, right) => left.createdAt - right.createdAt);
    if (options.limit !== undefined) requests = requests.slice(0, options.limit);
    return clone(requests);
  }

  private replyPending(input: ReplyPermissionInput): PermissionRequestRecord {
    const request = this.options.storage.state.permissions[input.requestId];
    if (!request) {
      throw new Error(`Permission request not found: ${input.requestId}`);
    }
    if (request.status !== "pending") {
      throw new Error(`Permission request already resolved: ${input.requestId}`);
    }
    request.status = input.status;
    if (input.decision !== undefined) request.decision = input.decision;
    if (input.clientId !== undefined) request.decidedByClientId = input.clientId;
    if (input.answer !== undefined) request.payload.answer = input.answer;
    request.updatedAt = Date.now();
    this.options.storage.mutations.permissions.add(request.id);
    this.emit("permission.replied", request);
    return clone(request);
  }

  private write<T>(work: () => T): T {
    return this.options.storage.atomic(() => {
      this.options.storage.assertWritable();
      return work();
    });
  }

  private emit(
    type: "permission.asked" | "permission.replied",
    request: PermissionRequestRecord,
  ): void {
    this.options.appendEvent({
      type,
      sessionId: request.sessionId,
      payload: { request },
    });
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
