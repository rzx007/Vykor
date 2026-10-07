import { getSkillsDir, type Settings } from "@vykor/core";
import { createWorkspaceBinding, type ExecutionEnvironmentHandle } from "@vykor/environment";
import type { SessionRecord } from "@vykor/protocol";
import { createExecutionEnvironment, hostPathToWslPath, resolveExecutionEnvironmentConfig } from "@vykor/sandbox";
import { createEnvironmentFileSystem } from "@vykor/tools";
import { loadRuntimeSecrets } from "./runtime-secrets.js";
import { resolve } from "node:path";
import { sessionSettingsRoot } from "./session-settings-root.js";

export function createSessionEnvironmentAcquirer(_input?: unknown) {
  return async (session: SessionRecord, settings: Settings): Promise<ExecutionEnvironmentHandle> => {
    const config = resolveExecutionEnvironmentConfig({ surface: "desktop_managed", settings, cwd: session.cwd });
    const binding = createWorkspaceBinding({
      kind: config.kind,
      hostRoot: session.cwd,
      executionRoot: config.kind === "wsl" ? hostPathToWslPath(session.cwd) : session.cwd,
    });
    const secretNames = settings.agentEnvironment?.secretEnv ?? [];
    const secretEnv = { ...await loadRuntimeSecrets("global", secretNames),
      ...await loadRuntimeSecrets(resolve(sessionSettingsRoot(session)), secretNames) };
    if (secretNames.some(name => !Object.hasOwn(secretEnv, name) || secretEnv[name] === undefined)) throw new Error("任务所需的机密环境变量尚未配置。");
    const base = await createExecutionEnvironment({
      config,
      settings,
      binding,
      sessionId: session.id,
      userSkillsRoot: getSkillsDir(),
      env: secretEnv,
    });
    return { ...base, files: createEnvironmentFileSystem(base) };
  };
}
