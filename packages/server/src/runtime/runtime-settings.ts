import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { tmpdir } from "node:os";
import { getProjectConfigDir, getProjectSettingsFilePath, loadProjectSettings, loadSettings, parseAgentEnvironmentSettings,
  saveProjectSettings, SettingsConflictError, updateSettings, withSettingsFileLock, mergeAgentEnvironmentSettings, type AgentEnvironmentSettings } from "@vykor/core";
import { hostPathToWslPath, preflightWsl, resolveShellDescriptor } from "@vykor/sandbox";
import { loadRuntimeSecrets, runtimeSecretsRevision, saveRuntimeSecrets } from "./runtime-secrets.js";

const exec = promisify(execFile);
export function environmentFingerprint(config: AgentEnvironmentSettings): string {
  const canonical = { kind: config.kind,
    ...(config.distribution ? { distribution: config.distribution } : {}),
    ...(config.shell ? { shell: { executable: config.shell.executable, ...(config.shell.args ? { args: config.shell.args } : {}) } } : {}),
    ...(Object.keys(config.env ?? {}).length ? { env: Object.fromEntries(Object.entries(config.env!).sort(([a], [b]) => a.localeCompare(b))) } : {}),
    ...(config.secretEnv?.length ? { secretEnv: [...config.secretEnv].sort() } : {}) };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export async function inspectRuntimeEnvironment(input: { cwd?: string; activeDefault?: AgentEnvironmentSettings; kindOverride?: "native" | "wsl" } = {}) {
  const user = (await loadSettings(undefined, { includeEnvironment: false })).agentEnvironment ?? { kind: "native" as const };
  const project = input.cwd ? (await loadProjectSettings(input.cwd))?.agentEnvironment : undefined;
  const base = input.activeDefault ?? user;
  const effective = mergeAgentEnvironmentSettings(base, project, input.kindOverride ? { kind: input.kindOverride } : undefined);
  const savedDefault = mergeAgentEnvironmentSettings(user, input.kindOverride ? { kind: input.kindOverride } : undefined);
  const activeDefault = mergeAgentEnvironmentSettings(base, input.kindOverride ? { kind: input.kindOverride } : undefined);
  return { userConfig: user, projectConfig: project ?? null, effective, activeDefault,
    source: input.kindOverride ? "启动环境变量覆盖" : project ? "当前项目" : "用户默认", restartRequired: environmentFingerprint(activeDefault) !== environmentFingerprint(savedDefault),
    wslSupported: process.platform === "win32", inheritedVariableNames: Object.keys(process.env).sort(), secretRevision: await runtimeSecretsRevision() };
}

export async function validateRuntimeEnvironmentConfig(config: AgentEnvironmentSettings, cwd?: string, sandboxEnabled?: boolean) {
  parseAgentEnvironmentSettings(config);
  if (config.kind === "wsl") {
    const settings = await loadSettings(undefined, { includeProject: Boolean(cwd), projectRoot: cwd });
    if (sandboxEnabled ?? settings.sandbox?.enabled) throw new Error("WSL 与 SRT 隔离目前不能同时启用，请先关闭对应访问隔离。");
    if (cwd) hostPathToWslPath(cwd);
    await preflightWsl({ distribution: config.distribution });
    await checkWslCommandShell(config, cwd);
  } else if (config.shell) await resolveShellDescriptor({ configuredExecutable: config.shell.executable, tempDir: tmpdir() });
}

async function checkWslCommandShell(config: AgentEnvironmentSettings, cwd?: string, signal?: AbortSignal) {
  const command = config.shell?.executable ?? "/bin/sh";
  const { stdout } = await exec("wsl.exe", [
    ...(config.distribution ? ["--distribution", config.distribution] : []),
    ...(cwd ? ["--cd", hostPathToWslPath(cwd)] : []),
    "--exec", command, ...(config.shell?.args.length ? config.shell.args : ["-lc"]), "printf '%s' vykor-shell-ready",
  ], { windowsHide: true, timeout: 10_000, signal });
  if (!stdout.includes("vykor-shell-ready")) throw new Error("所选 WSL 命令 Shell 或启动参数无法执行命令。");
  return command;
}

export async function saveRuntimeEnvironment(input: { cwd?: string; config: AgentEnvironmentSettings | null;
  expected: AgentEnvironmentSettings | null; secrets?: Record<string, string | null>; expectedSecretRevision?: string }) {
  const config = input.config === null ? null : parseAgentEnvironmentSettings(input.config);
  if (!input.cwd && !config) throw new Error("用户默认运行环境不能移除。");
  if (input.cwd && !isAbsolute(input.cwd)) throw new Error("请选择完整项目目录。");
  const scope = input.cwd ? resolve(input.cwd) : "global";
  const secretNames = config?.secretEnv ?? [];
  const supplied = { ...await loadRuntimeSecrets("global", secretNames), ...await loadRuntimeSecrets(scope, secretNames), ...input.secrets };
  if (secretNames.some(name => !Object.hasOwn(supplied, name) || supplied[name] === undefined || supplied[name] === null)) throw new Error("新机密变量尚未配置，请填写值后保存。");
  let previousSecrets: Record<string, string> = {}, secretsChanged = false;
  const writeSecrets = async () => {
    if (!input.secrets || !Object.keys(input.secrets).length) return;
    if (typeof input.expectedSecretRevision !== "string") throw new Error("请重新读取机密变量状态后保存。");
    previousSecrets = await loadRuntimeSecrets(scope, Object.keys(input.secrets));
    await saveRuntimeSecrets(scope, input.secrets, undefined, input.expectedSecretRevision);
    secretsChanged = true;
  };
  const restoreSecrets = async () => {
    if (secretsChanged) await saveRuntimeSecrets(scope, Object.fromEntries(Object.keys(input.secrets ?? {}).map(name => [name, previousSecrets[name] ?? null])), input.secrets);
  };
  if (config) {
    if (Object.keys(config.env ?? {}).some(key => /TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY|CREDENTIAL/i.test(key))) throw new Error("可能包含机密的变量必须标记为机密后保存。");
    await validateRuntimeEnvironmentConfig(config, input.cwd);
  }
  const unchanged = (current: AgentEnvironmentSettings | null) => {
    if (!isDeepStrictEqual(current, input.expected)) throw new SettingsConflictError("agentEnvironment");
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
    }, { includeEnvironment: false }); } catch (error) { await restoreSecrets(); throw error; }
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
    try { checks.push({ name: "Shell", status: "ok", detail: await checkWslCommandShell(config, input.cwd, input.signal) }); }
    catch { input.signal?.throwIfAborted(); checks.push({ name: "Shell", status: "failed", detail: "命令 Shell 或启动参数无法执行命令" }); }
    for (const [name, command, args] of [["Git", "git", ["--version"]], ["Node.js", "node", ["--version"]], ["Python", "python3", ["--version"]]] as const) {
      try { const { stdout } = await exec("wsl.exe", [...dist, "--cd", cwd, "--exec", command, ...args], { windowsHide: true, timeout: 10_000, signal: input.signal }); checks.push({ name, status: "ok", detail: stdout.trim().slice(0, 300) || command }); }
      catch { input.signal?.throwIfAborted(); checks.push({ name, status: "warning", detail: "无法启动或未安装" }); }
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
