import { getSkillsDir, type Settings } from "@vykor/core";
import { createWorkspaceBinding, type ExecutionEnvironmentHandle } from "@vykor/environment";
import type { SessionRecord } from "@vykor/protocol";
import { createExecutionEnvironment, hostPathToWslPath, resolveExecutionEnvironmentConfig } from "@vykor/sandbox";
import { createEnvironmentFileSystem } from "@vykor/tools";

export function createSessionEnvironmentAcquirer(_input?: unknown) {
  return async (session: SessionRecord, settings: Settings): Promise<ExecutionEnvironmentHandle> => {
    const config = resolveExecutionEnvironmentConfig({ surface: "desktop_managed", settings, cwd: session.cwd });
    const binding = createWorkspaceBinding({
      kind: config.kind,
      hostRoot: session.cwd,
      executionRoot: config.kind === "wsl" ? hostPathToWslPath(session.cwd) : session.cwd,
    });
    const base = await createExecutionEnvironment({
      config,
      settings,
      binding,
      sessionId: session.id,
      userSkillsRoot: getSkillsDir(),
    });
    return { ...base, files: createEnvironmentFileSystem(base, { settings, sessionId: session.id }) };
  };
}
