import { resolve } from "node:path";
import {
  FactMutationError,
  loadFacts,
  replaceFact,
} from "@vykor/personalization";
import { detectCredentialValue } from "@vykor/memory";
import type { SessionStore } from "@vykor/services";
import type { DaemonControlService } from "../control/index.js";
import { ApplicationError } from "../../shared/application-error.js";
export interface ReplaceProjectFactInput {
  cwd: string;
  oldKey: string;
  newValue: string;
  sessionId?: string;
}
export interface ProjectFactsContext {
  control: Pick<
    DaemonControlService,
    "acquireCwdMutation" | "closeRuntimesForCwd"
  >;
  sessions: Pick<SessionStore["sessions"], "get">;
  readiness?(): { phase: string; accepting: boolean };
}
export function createProjectFactsService(context: ProjectFactsContext) {
  return {
    list(cwd: string) {
      if (!cwd) throw new ApplicationError(400, "cwd is required");
      try {
        return {
          facts: loadFacts(cwd).facts.filter(
            (fact) => !detectCredentialValue(fact.value),
          ),
        };
      } catch {
        throw new ApplicationError(500, "Project facts file is unreadable");
      }
    },
    async replace(input: ReplaceProjectFactInput) {
      const state = context.readiness?.();
      if (state && (state.phase !== "ready" || !state.accepting))
        throw new ApplicationError(
          409,
          "后台尚未就绪或已停止准入，拒绝事实写操作",
        );
      for (const key of ["cwd", "oldKey", "newValue"] as const)
        if (typeof input[key] !== "string" || !input[key].trim())
          throw new ApplicationError(400, key + " is required");
      if (input.sessionId !== undefined && typeof input.sessionId !== "string")
        throw new ApplicationError(400, "sessionId must be a string");
      if (input.sessionId !== undefined) {
        const session = context.sessions.get(input.sessionId);
        if (!session || resolve(session.cwd) !== resolve(input.cwd))
          throw new ApplicationError(400, "sessionId must belong to cwd");
      }
      const lease = context.control.acquireCwdMutation(input.cwd);
      if (!lease)
        throw new ApplicationError(
          409,
          "Cannot update facts while session runs are active for this cwd",
        );
      try {
        const result = replaceFact(input.cwd, input.oldKey, input.newValue, {
          sessionId: input.sessionId,
        });
        await context.control.closeRuntimesForCwd(input.cwd);
        return { result };
      } catch (error) {
        if (error instanceof FactMutationError)
          throw new ApplicationError(
            error.code === "NOT_FOUND"
              ? 404
              : error.code === "INVALID_VALUE"
                ? 400
                : error.code === "CONFLICT"
                  ? 409
                  : 500,
            error.message,
          );
        throw new ApplicationError(500, "Project fact replacement failed");
      } finally {
        lease.release();
      }
    },
  };
}
export type ProjectFactsService = ReturnType<typeof createProjectFactsService>;
