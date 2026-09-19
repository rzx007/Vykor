import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

/** Project-level config directory name, matching the user-level `~/.openharness-ts`. */
export const PROJECT_CONFIG_DIR_NAME = ".openharness-ts";

export interface ResolvedPaths {
  configDir: string;
  dataDir: string;
  logsDir: string;
  sessionsDir: string;
  pluginsDir: string;
  skillsDir: string;
  memoryDir: string;
  tasksDir: string;
  feedbackDir: string;
  configFilePath: string;
  credentialsFilePath: string;
  mcpOAuthFilePath: string;
  channelCredentialsFilePath: string;
}

let _cached: ResolvedPaths | undefined;

export function resolvePaths(projectRoot?: string): ResolvedPaths {
  const configDir =
    process.env.OPENHARNESS_CONFIG_DIR ?? join(homedir(), ".openharness-ts");
  if (_cached && !projectRoot && _cached.configDir === configDir) return _cached;

  const dataDir = join(configDir, "data");
  const projectRootResolved = projectRoot ?? process.cwd();

  const paths: ResolvedPaths = {
    configDir,
    dataDir,
    logsDir: join(dataDir, "logs"),
    sessionsDir: join(dataDir, "sessions"),
    pluginsDir: join(configDir, "plugins"),
    skillsDir: join(configDir, "skills"),
    memoryDir: join(projectRootResolved, PROJECT_CONFIG_DIR_NAME, "memory"),
    tasksDir: join(dataDir, "tasks"),
    feedbackDir: join(dataDir, "feedback"),
    configFilePath: join(configDir, "settings.json"),
    credentialsFilePath: join(configDir, "credentials.json"),
    mcpOAuthFilePath: join(configDir, "mcp-oauth.json"),
    channelCredentialsFilePath: join(configDir, "channel-credentials.json"),
  };

  if (!projectRoot) _cached = paths;
  return paths;
}

export function getConfigDir(): string {
  return resolvePaths().configDir;
}

export function getConfigFilePath(): string {
  return resolvePaths().configFilePath;
}

export function getProjectConfigDir(projectRoot?: string): string {
  return join(resolve(projectRoot ?? process.cwd()), PROJECT_CONFIG_DIR_NAME);
}

export function getProjectSettingsFilePath(projectRoot?: string): string {
  return join(getProjectConfigDir(projectRoot), "settings.json");
}

export function getDataDir(): string {
  return resolvePaths().dataDir;
}

export function getLogsDir(): string {
  return resolvePaths().logsDir;
}

export function getSessionsDir(): string {
  return resolvePaths().sessionsDir;
}

export function getTasksDir(): string {
  return resolvePaths().tasksDir;
}

export function getPluginsDir(): string {
  return resolvePaths().pluginsDir;
}

export function getPluginCacheDir(): string {
  return join(getPluginsDir(), "cache");
}

export function getPluginDataDir(): string {
  return join(getPluginsDir(), "data");
}

export function getPluginSourcesDir(): string {
  return join(getPluginsDir(), "sources");
}

export function getInstalledPluginStorePath(): string {
  return join(getPluginsDir(), "installed.json");
}

export function getSkillsDir(): string {
  return resolvePaths().skillsDir;
}

export function getMemoryDir(projectRoot?: string): string {
  return resolvePaths(projectRoot).memoryDir;
}

export function getProjectMemoryDir(projectRoot?: string): string {
  const root = resolve(projectRoot ?? process.cwd());
  const key = process.platform === "win32" ? root.toLowerCase() : root;
  const digest = createHash("sha1").update(key).digest("hex").slice(0, 12);
  return join(getDataDir(), "memory", `${basename(root)}-${digest}`);
}

export function getFeedbackDir(): string {
  return resolvePaths().feedbackDir;
}

export function getCredentialsFilePath(): string {
  return resolvePaths().credentialsFilePath;
}

export function getMcpOAuthFilePath(): string {
  return resolvePaths().mcpOAuthFilePath;
}

export function getChannelCredentialsFilePath(): string {
  return resolvePaths().channelCredentialsFilePath;
}

/** 渠道会话专用工作区根目录；可用 OPENHARNESS_CHANNELS_DIR 覆盖。 */
export function getChannelWorkspaceRoot(): string {
  return process.env.OPENHARNESS_CHANNELS_DIR ?? join(getConfigDir(), "channels");
}
