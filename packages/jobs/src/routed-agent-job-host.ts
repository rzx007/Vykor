import {
  filterJobSnapshots,
  type AgentJobHost,
  type JobKind,
  type JobListRequest,
  type JobListResult,
} from "./index.js";

/** 每种任务固定一个来源；定点操作不需要列举其他任务。 */
export class RoutedAgentJobHost implements AgentJobHost {
  private readonly sources: Partial<Record<JobKind, AgentJobHost>>;
  constructor(sources: Partial<Record<JobKind, AgentJobHost>>) {
    this.sources = { ...sources };
  }
  async list(input: JobListRequest): Promise<JobListResult> {
    const { limit, ...query } = input;
    const entries = Object.entries(this.sources).filter(
      ([kind]) => !input.kinds?.length || input.kinds.includes(kind as JobKind),
    ) as [JobKind, AgentJobHost][];
    const results = await Promise.allSettled(
      entries.map(([kind, source]) => source.list({ ...query, kinds: [kind] })),
    );
    const jobs: JobListResult["jobs"] = [],
      errors: JobListResult["errors"] = [];
    results.forEach((result, index) => {
      const kind = entries[index]![0];
      if (result.status === "fulfilled") {
        jobs.push(...result.value.jobs.filter((job) => job.kind === kind));
        errors.push(...result.value.errors);
      } else
        errors.push({
          kind,
          message:
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason),
        });
    });
    return { jobs: filterJobSnapshots(jobs, { ...query, limit }), errors };
  }
  async read(input: Parameters<AgentJobHost["read"]>[0]) {
    return this.sourceFor(input.target.kind).read(input);
  }
  async wait(input: Parameters<AgentJobHost["wait"]>[0]) {
    return this.sourceFor(input.target.kind).wait(input);
  }
  async send(
    input: Parameters<AgentJobHost["send"]>[0],
    authorization?: Parameters<AgentJobHost["send"]>[1],
  ) {
    return this.sourceFor(input.target.kind).send(input, authorization);
  }
  async cancel(input: Parameters<AgentJobHost["cancel"]>[0]) {
    return this.sourceFor(input.target.kind).cancel(input);
  }
  private sourceFor(kind: JobKind): AgentJobHost {
    const source = this.sources[kind];
    if (!source) throw new Error(`Job kind not supported: ${kind}`);
    return source;
  }
}
