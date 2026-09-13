import {
  filterJobSnapshots,
  type AgentJobHost,
  type JobCancelRequest,
  type JobListRequest,
  type JobReadRequest,
  type JobReadResult,
  type JobSendRequest,
  type JobSnapshot,
  type JobWaitRequest,
  type JobWaitResult,
} from "./index.js";

/** Combines independent job hosts behind one session-aware control surface. */
export class CompositeAgentJobHost implements AgentJobHost {
  private readonly sources: AgentJobHost[];
  private readonly ownerByJobKey = new Map<string, AgentJobHost>();

  constructor(sources: Iterable<AgentJobHost>) {
    this.sources = [...new Set(sources)];
  }

  async list(input: JobListRequest): Promise<JobSnapshot[]> {
    const { limit: _limit, sessionId, ...filters } = input;
    const jobsBySource: Array<[AgentJobHost, JobSnapshot[]]> = [];

    for (const source of this.sources) {
      jobsBySource.push([source, await source.list({ sessionId, ...filters })]);
    }

    this.indexOwners(sessionId, jobsBySource);
    return filterJobSnapshots(jobsBySource.flatMap(([, jobs]) => jobs), { ...filters, limit: _limit });
  }

  async read(input: JobReadRequest): Promise<JobReadResult> {
    return await (await this.resolveOwner(input.sessionId, input.jobId)).read(input);
  }

  async wait(input: JobWaitRequest): Promise<JobWaitResult> {
    return await (await this.resolveOwner(input.sessionId, input.jobId)).wait(input);
  }

  async send(input: JobSendRequest, authorization?: Parameters<AgentJobHost["send"]>[1]): Promise<void> {
    const owner = await this.resolveOwner(input.sessionId, input.jobId);
    if (authorization) await owner.send(input, authorization);
    else await owner.send(input);
  }

  async cancel(input: JobCancelRequest): Promise<JobSnapshot> {
    return await (await this.resolveOwner(input.sessionId, input.jobId)).cancel(input);
  }

  private async resolveOwner(sessionId: string, jobId: string): Promise<AgentJobHost> {
    const key = jobKey(sessionId, jobId);
    const cached = this.ownerByJobKey.get(key);
    if (cached) return cached;

    const jobsBySource: Array<[AgentJobHost, JobSnapshot[]]> = [];
    for (const source of this.sources) {
      jobsBySource.push([source, await source.list({ sessionId, includeFinished: true })]);
    }
    this.indexOwners(sessionId, jobsBySource, true);

    const owner = this.ownerByJobKey.get(key);
    if (owner) return owner;
    throw new Error(`Job not found: ${jobId}`);
  }

  private indexOwners(
    sessionId: string,
    jobsBySource: Iterable<readonly [AgentJobHost, Iterable<JobSnapshot>]>,
    replaceSession = false,
  ): void {
    const ownerByJobId = new Map<string, AgentJobHost>();
    for (const [source, jobs] of jobsBySource) {
      for (const job of jobs) {
        const owner = ownerByJobId.get(job.id);
        if (owner && owner !== source) throw new Error(`Job source conflict: ${job.id}`);
        ownerByJobId.set(job.id, source);
      }
    }
    if (replaceSession) this.removeSessionOwners(sessionId);
    for (const [jobId, owner] of ownerByJobId) {
      this.ownerByJobKey.set(jobKey(sessionId, jobId), owner);
    }
  }

  private removeSessionOwners(sessionId: string): void {
    const prefix = `${sessionId}\0`;
    for (const key of this.ownerByJobKey.keys()) {
      if (key.startsWith(prefix)) this.ownerByJobKey.delete(key);
    }
  }
}

function jobKey(sessionId: string, jobId: string): string {
  return `${sessionId}\0${jobId}`;
}
