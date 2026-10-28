import type { JobTarget, JobListResult, JobInputReceipt, JobKind, JobReadResult, JobSnapshot, JobStatus, JobWaitResult } from "@vykor/protocol";
import { ProtocolDataError, decodeJobListResult, decodeJobInputReceipt, decodeJobReadResult, decodeJobSnapshot, decodeJobWaitResult } from "@vykor/protocol";
import type {
  CreateBackgroundShellInput,
  CreateBackgroundShellResult,
} from "../../types/index.js";
import type { HttpTransport } from "../../transport/http-transport.js";
import { responseField } from "../../transport/http-transport.js";

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
  }): Promise<JobListResult> {
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
    return decodeJobListResult(response);
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
    target: JobTarget,
    options: {
      sessionId: string;
      after?: number;
      maxChars?: number;
      signal?: AbortSignal;
    },
  ): Promise<JobReadResult> {
    const { signal, ...query } = options;
    const response = await this.transport.request<unknown>(
      this.transport.path(`/jobs/${encodeURIComponent(target.jobId)}`, { ...query, kind: target.kind, ...(target.kind === "agent" ? { runId: target.runId } : {}) }),
      { signal },
    );
    return decodeJobReadResult(response);
  }

  async wait(
    target: JobTarget,
    input: {
      sessionId: string;
      timeoutMs?: number;
      after?: number;
      maxChars?: number;
    },
    options: { signal?: AbortSignal } = {},
  ): Promise<JobWaitResult> {
    const response = await this.transport.request<unknown>(
      `/jobs/${encodeURIComponent(target.jobId)}/wait`,
      {
        method: "POST",
        body: { ...input, target },
        signal: options.signal,
      },
    );
    return decodeJobWaitResult(response);
  }

  async send(
    target: JobTarget,
    input: { sessionId: string; data: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<JobInputReceipt | void> {
    const response = await this.transport.request<unknown>(`/jobs/${encodeURIComponent(target.jobId)}/input`, {
      method: "POST",
      body: { ...input, target },
      signal: options.signal,
    });
    if (responseField(response, "sent") !== true) throw new ProtocolDataError("Job input was not accepted", "sent");
    const receipt = (response as { receipt?: unknown }).receipt;
    return receipt === undefined ? undefined : decodeJobInputReceipt(receipt);
  }

  async cancel(
    target: JobTarget,
    input: { sessionId: string; reason?: string },
    options: { signal?: AbortSignal } = {},
  ): Promise<JobSnapshot> {
    const response = await this.transport.request<unknown>(
      `/jobs/${encodeURIComponent(target.jobId)}/cancel`,
      { method: "POST", body: { ...input, target }, signal: options.signal },
    );
    return decodeJobSnapshot(responseField(response, "snapshot"));
  }
}
