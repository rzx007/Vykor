import type { AgentJobHost } from "@vykor/jobs";
import type { DaemonOperationGate } from "../application/control/daemon-operation-gate.js";
import type { SessionRecord } from "@vykor/domain-contracts/sessions";
import type { ChildActivitySnapshot } from "@vykor/agent-contracts";
export {
  readPersistedChildActivity,
  type ChildActivityReader,
} from "./child-activity.js";
export interface JobSessionQueries {
  getSession(sessionId: string): SessionRecord | undefined;
  readChildActivity?(input: {
    parentSessionId: string;
    childSessionId: string;
    runId?: string;
  }): ChildActivitySnapshot | undefined;
}
export interface JobSessionStore extends JobSessionQueries {}
/** 权限核对后把操作交给 SDK 与 daemon 共用的执行来源。 */
export class DaemonJobService implements AgentJobHost {
  constructor(
    private readonly sessions: JobSessionQueries,
    private readonly getJobs: (sessionId: string) => AgentJobHost,
    private readonly operationGate?: Pick<DaemonOperationGate, "enter">,
  ) {}
  list(input: Parameters<AgentJobHost["list"]>[0]) {
    return this.host(input.sessionId).list(input);
  }
  read(input: Parameters<AgentJobHost["read"]>[0]) {
    return this.host(input.sessionId).read(input);
  }
  wait(input: Parameters<AgentJobHost["wait"]>[0]) {
    return this.host(input.sessionId).wait(input);
  }
  async send(
    input: Parameters<AgentJobHost["send"]>[0],
    authorization?: Parameters<AgentJobHost["send"]>[1],
  ) {
    const session = this.sessions.getSession(input.sessionId);
    if (!session) throw new Error(`Session not found: ${input.sessionId}`);
    if (session.status === "closing" || session.status === "archived")
      throw new Error("Session is not accepting new work");
    const lease = this.operationGate?.enter({ sessionId: session.id, cwd: session.cwd });
    try { return await this.getJobs(session.id).send(input, authorization); }
    finally { lease?.release(); }
  }
  cancel(input: Parameters<AgentJobHost["cancel"]>[0]) {
    return this.host(input.sessionId).cancel(input);
  }
  private host(sessionId: string) {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    return this.getJobs(sessionId);
  }
}
