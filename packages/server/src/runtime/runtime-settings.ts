import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { getProjectConfigDir, getProjectSettingsFilePath, loadProjectSettings, loadSettings, parseAgentEnvironmentSettings,
  saveProjectSettings, SettingsConflictError, updateSettings, withSettingsFileLock, type AgentEnvironmentSettings } from "@vykor/core";
import { hostPathToWslPath, preflightWsl, resolveShellDescriptor } from "@vykor/sandbox";
import { loadRuntimeSecrets, saveRuntimeSecrets } from "./runtime-secrets.js";

const exec = promisify(execFile);
export function environmentFingerprint(config: AgentEnvironmentSettings): string {
  return createHash("sha256").update(JSON.stringify(config)).digest("hex");
}

export async function inspectRuntimeEnvironment(input: { cwd?: string; activeDefault?: AgentEnvironmentSettings } = {}) {
  const user = (await loadSettings()).agentEnvironment ?? { kind: "native" as const };
  const project = input.cwd ? (await loadProjectSettings(input.cwd))?.agentEnvironment : undefined;
  const base = input.activeDefault ?? user;
  const effective: AgentEnvironmentSettings = { ...base, ...project,
    env: { ...base.env, ...project?.env }, secretEnv: [...new Set([...(base.secretEnv ?? []), ...(project?.secretEnv ?? [])])] };
  return { userConfig: user, projectConfig: project ?? null, effective, activeDefault: base,
    source: project ? "当前项目" : "用户默认", restartRequired: environmentFingerprint(base) !== environmentFingerprint(user),
    wslSupported: process.platform === "win32", inheritedVariableNames: Object.keys(process.env).sort() };
}

export async function saveRuntimeEnvironment(input: { cwd?: string; config: AgentEnvironmentSettings | null;
  expected: AgentEnvironmentSettings | null; secrets?: Record<string, string | null> }) {
  const config = input.config === null ? null : parseAgentEnvironmentSettings(input.config);
  if (!input.cwd && !config) throw new Error("用户默认运行环境不能移除。");
  if (input.cwd && !isAbsolute(input.cwd)) throw new Error("请选择完整项目目录。");
  const scope = input.cwd ? resolve(input.cwd) : "global";
  const secretNames = config?.secretEnv ?? [];
  const supplied = { ...await loadRuntimeSecrets("global", secretNames), ...await loadRuntimeSecrets(scope, secretNames), ...input.secrets };
  if (secretNames.some(name => supplied[name] === undefined || supplied[name] === null)) throw new Error("新机密变量尚未配置，请填写值后保存。");
  let previousSecrets: Record<string, string> = {}, secretsChanged = false;
  const writeSecrets = async () => {
    if (!input.secrets) return;
    previousSecrets = await loadRuntimeSecrets(scope, Object.keys(input.secrets));
    await saveRuntimeSecrets(scope, input.secrets);
    secretsChanged = true;
  };
  const restoreSecrets = async () => {
    if (secretsChanged) await saveRuntimeSecrets(scope, Object.fromEntries(Object.keys(input.secrets ?? {}).map(name => [name, previousSecrets[name] ?? null])), input.secrets);
  };
  if (config) {
    if (Object.keys(config.env ?? {}).some(key => /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL/i.test(key))) throw new Error("可能包含机密的变量必须标记为机密后保存。");
    if (config.kind === "wsl") {
      const effectiveSettings = await loadSettings(undefined, { includeProject: Boolean(input.cwd), projectRoot: input.cwd });
      if (effectiveSettings.sandbox?.enabled) throw new Error("WSL 与 SRT 隔离目前不能同时启用，请先关闭对应访问隔离。");
      if (input.cwd) hostPathToWslPath(input.cwd);
      await preflightWsl({ distribution: config.distribution });
    } else if (config.shell) await resolveShellDescriptor({ configuredExecutable: config.shell.executable, tempDir: tmpdir() });
  }
  const unchanged = (current: AgentEnvironmentSettings | null) => {
    if (JSON.stringify(current) !== JSON.stringify(input.expected)) throw new SettingsConflictError("agentEnvironment");
  };
  if (input.cwd) {
    await mkdir(getProjectConfigDir(input.cwd), { recursive: true });
    await withSettingsFileLock(async () => {
      const project = await loadProjectSettings(input.cwd) ?? {};
      unchanged(project.agentEnvironment ?? null);
      await writeSecrets();
      if (config) project.agentEnvironment = config; else delete project.agentEnvironment;
      try { await saveProjectSettings(project, input.cwd); }
      catch (error) { await restoreSecrets(); throw error; }
    }, { lockPath: `${getProjectSettingsFilePath(input.cwd)}.lock` });
  } else {
    try { await updateSettings(async latest => {
      unchanged(latest.agentEnvironment ?? null);
      await writeSecrets();
      return { ...latest, agentEnvironment: config! };
    }); } catch (error) { await restoreSecrets(); throw error; }
  }
}

export async function listRuntimeDistributions(): Promise<string[]> {
  if (process.platform !== "win32") return [];
  try { const { stdout } = await exec("wsl.exe", ["--list", "--quiet"], { encoding: "utf16le", windowsHide: true, timeout: 10_000 });
    return stdout.replace(/\0/g, "").split(/\r?\n/).map(line => line.trim()).filter(Boolean); }
  catch { return []; }
}

export async function checkRuntimeEnvironment(input: { cwd: string; config: AgentEnvironmentSettings; signal?: AbortSignal }) {
  input.signal?.throwIfAborted();
  const config = parseAgentEnvironmentSettings(input.config);
  if (!isAbsolute(input.cwd)) throw new Error("请选择完整项目目录。");
  const checks: Array<{ name: string; status: "ok" | "warning" | "failed"; detail: string }> = [];
  if (config.kind === "wsl") {
    await preflightWsl({ distribution: config.distribution });
    const cwd = hostPathToWslPath(input.cwd);
    const dist = config.distribution ? ["--distribution", config.distribution] : [];
    await exec("wsl.exe", [...dist, "--cd", cwd, "--exec", "/bin/test", "-d", cwd], { windowsHide: true, timeout: 10_000, signal: input.signal });
    checks.push({ name: "项目目录", status: "ok", detail: cwd });
    for (const [name, command, args] of [["Shell", config.shell?.executable ?? "/bin/sh", ["--version"]], ["Git", "git", ["--version"]], ["Node.js", "node", ["--version"]], ["Python", "python3", ["--version"]]] as const) {
      try { const { stdout } = await exec("wsl.exe", [...dist, "--cd", cwd, "--exec", command, ...args], { windowsHide: true, timeout: 10_000, signal: input.signal }); checks.push({ name, status: "ok", detail: stdout.trim().slice(0, 300) || command }); }
      catch { input.signal?.throwIfAborted(); checks.push({ name, status: name === "Shell" ? "failed" : "warning", detail: "无法启动或未安装" }); }
    }
  } else {
    const shell = await resolveShellDescriptor({ configuredExecutable: config.shell?.executable, tempDir: tmpdir() });
    checks.push({ name: "Shell", status: "ok", detail: shell.executable });
    const { stat } = await import("node:fs/promises");
    if (!(await stat(input.cwd)).isDirectory()) throw new Error("项目目录不可用。");
    checks.push({ name: "项目目录", status: "ok", detail: input.cwd });
    for (const [name, command] of [["Git", "git"], ["Node.js", "node"], ["Python", "python"]]) {
      try { const { stdout } = await exec(command!, ["--version"], { cwd: input.cwd, windowsHide: true, timeout: 10_000, signal: input.signal }); checks.push({ name: name!, status: "ok", detail: stdout.trim().slice(0, 300) }); }
      catch { input.signal?.throwIfAborted(); checks.push({ name: name!, status: "warning", detail: "未安装或不在执行路径中" }); }
    }
  }
  return checks;
}
