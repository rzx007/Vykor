import type { WorkflowRunRepository } from "@vykor/coordinator/workflow";
import { WorkflowHost } from "./workflow-host.js";

/** Explicit root-tree resource; children borrow hosts and close only their bound owner. */
export class WorkflowHostDirectory {
  private readonly hosts = new Map<string, WorkflowHost>();
  private readonly borrowed = new Set<WorkflowHost>();
  private closing?: Promise<void>;
  constructor(host?: WorkflowHost) {
    if (host) {
      this.hosts.set(host.repository.repositoryKey, host);
      this.borrowed.add(host);
    }
  }
  get(repository: WorkflowRunRepository): WorkflowHost {
    if (this.closing) throw new Error("Workflow host directory is closed.");
    let host = this.hosts.get(repository.repositoryKey);
    if (!host) {
      host = new WorkflowHost(repository);
      this.hosts.set(repository.repositoryKey, host);
    }
    return host;
  }
  close(): Promise<void> {
    return (this.closing ??= (async () => {
      const settled = await Promise.allSettled(
        [...this.hosts.values()]
          .filter((host) => !this.borrowed.has(host))
          .map((host) => host.close()),
      );
      const failures = settled.flatMap((result) =>
        result.status === "rejected" ? [result.reason] : [],
      );
      if (failures.length)
        throw new AggregateError(failures, "Workflow hosts failed to close");
    })());
  }
}
