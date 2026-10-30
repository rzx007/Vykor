import { getSkillsDir, type Settings } from "@vykor/host-config";
import { createWorkspaceBinding, type ExecutionEnvironmentHandle } from "@vykor/environment";
import { normalizeApprovalMode } from "@vykor/host-config";
import { readSessionRuntimeConfig } from "../application/session/configuration/runtime-configuration.js";
import type { SessionRecord } from "@vykor/domain-contracts/sessions";
import { createExecutionEnvironment, hostPathToWslPath, resolveExecutionEnvironmentConfig, settingsForApprovalMode } from "@vykor/sandbox";
import { createEnvironmentFileSystem } from "@vykor/tools";
import { loadRuntimeSecrets } from "./runtime-secrets.js";
import { resolve } from "node:path";
import { sessionSettingsRoot } from "./session-settings-root.js";

export function createSessionEnvironmentAcquirer(input: {surface?: "desktop_managed" | "cli_advanced"; loadSecrets?: boolean} = {}) {
  return async (session: SessionRecord, settings: Settings): Promise<ExecutionEnvironmentHandle> => {
    const runtime = readSessionRuntimeConfig(session, { approvalMode: normalizeApprovalMode(settings.permission.mode) });
    settings = settingsForApprovalMode(settings, runtime.approvalMode);
    const surface = input.surface ?? "desktop_managed";
    // CLI advanced Agents use native file tools even if desktop WSL preferences exist.
    if (surface === "cli_advanced") settings = { ...settings, agentEnvironment: { ...settings.agentEnvironment, kind: "native" } };
    const config = resolveExecutionEnvironmentConfig({ surface, settings, cwd: session.cwd });
    const binding = createWorkspaceBinding({
      kind: config.kind,
      hostRoot: session.cwd,
      executionRoot: config.kind === "wsl" ? hostPathToWslPath(session.cwd) : session.cwd,
    });
    const secretNames = input.loadSecrets === false ? [] : settings.agentEnvironment?.secretEnv ?? [];
    const secretEnv = input.loadSecrets === false ? {} : { ...await loadRuntimeSecrets("global", secretNames),
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
