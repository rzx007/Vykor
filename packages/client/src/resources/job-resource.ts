import type {
  JobKind,
  JobReadResult,
  JobSnapshot,
  JobStatus,
  JobWaitResult,
} from "@vykor/protocol";
import {
  decodeJobReadResult,
  decodeJobSnapshot,
  decodeJobWaitResult,
} from "@vykor/protocol";
import type {
  CreateBackgroundShellInput,
  CreateBackgroundShellResult,
} from "../types/index.js";
import type { HttpTransport } from "../transport/http-transport.js";
import { responseArray, responseField } from "../transport/http-transport.js";

export class JobResource {
  constructor(private readonly transport: HttpTransport) {}

  async list(options: {
    sessionId: string;
    kinds?: JobKind[];
    statuses?: JobStatus[];
    startedAfter?: number;
    startedBefore?: number;
    updatedAfter?: number;
    updatedBefore?: number;
    includeFinished?: boolean;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<JobSnapshot[]> {
    const { signal, kinds, statuses, includeFinished, ...query } = options;
    const response = await this.transport.request<unknown>(
      this.transport.path("/jobs", {
        ...query,
        ...(kinds ? { kinds: kinds.join(",") } : {}),
        ...(statuses ? { statuses: statuses.join(",") } : {}),
        ...(includeFinished !== undefined
          ? { includeFinished: String(includeFinished) }
          : {}),
      }),
      { signal },
    );
    return responseArray(response, "jobs", decodeJobSnapshot);
  }

  async createBackgroundShell(
    input: CreateBackgroundShellInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<CreateBackgroundShellResult> {
    return await this.transport.request<CreateBackgroundShellResult>(
      "/background-shells",
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
  }

  async read(
    jobId: string,
    options: {
      sessionId: string;
      after?: number;
      maxChars?: number;
      signal?: AbortSignal;
    },
  ): Promise<JobReadResult> {
    const { signal, ...query } = options;
    const response = await this.transport.request<unknown>(
      this.transport.path(`/jobs/${encodeURIComponent(jobId)}`, query),
      { signal },
    );
    return decodeJobReadResult(response);
  }

  async wait(
    jobId: string,
    input: {
      sessionId: string;
      timeoutMs?: number;
      after?: number;
      maxChars?: number;
    },
    options: { signal?: AbortSignal } = {},
  ): Promise<JobWaitResult> {
    const response = await this.transport.request<unknown>(
      `/jobs/${encodeURIComponent(jobId)}/wait`,
      {
        method: "POST",
        body: input,
        signal: options.signal,
      },
    );
    return decodeJobWaitResult(response);
  }

  async send(
    jobId: string,
    input: { sessionId: string; data: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<void> {
    await this.transport.request(`/jobs/${encodeURIComponent(jobId)}/input`, {
      method: "POST",
      body: input,
      signal: options.signal,
    });
  }

  async cancel(
    jobId: string,
    input: { sessionId: string; reason?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<JobSnapshot> {
    const response = await this.transport.request<unknown>(
      `/jobs/${encodeURIComponent(jobId)}/cancel`,
      { method: "POST", body: input, signal: options.signal },
    );
    return decodeJobSnapshot(responseField(response, "snapshot"));
  }
}
