import type { AgentJobHost } from "@vykor/jobs";
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
  send(
    input: Parameters<AgentJobHost["send"]>[0],
    authorization?: Parameters<AgentJobHost["send"]>[1],
  ) {
    return this.host(input.sessionId, true).send(input, authorization);
  }
  cancel(input: Parameters<AgentJobHost["cancel"]>[0]) {
    return this.host(input.sessionId).cancel(input);
  }
  private host(sessionId: string, writing = false) {
    const session = this.sessions.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (
      writing &&
      (session.status === "closing" || session.status === "archived")
    )
      throw new Error("Session is not accepting new work");
    return this.getJobs(sessionId);
  }
}
