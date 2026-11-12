import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { currentDataRoot } from "./data-root-selection.js";
export * from "./data-root-selection.js";

/** Project-level config directory name, matching the user-level `~/.vykor`. */
export const PROJECT_CONFIG_DIR_NAME = ".vykor";

/** User-owned locations; calculating them never reads or creates directories. */
export interface UserDataPaths {
  dataRoot: string;
  dataDir: string;
  cacheDir: string;
  channelsDir: string;
  workspacesDir: string;
  worktreesDir: string;
  desktopDataDir: string;
  agentsDir: string;
  localRulesDir: string;
  outputStylesDir: string;
  userProfilePendingDir: string;
  modelsDevCacheFilePath: string;
  frecencyFilePath: string;
  runtimeEnvironmentSecretsFilePath: string;
  soulFilePath: string;
  userProfileFilePath: string;
  sessionRuntimeDir: string;
  sessionsDatabasePath: string;
  attachmentBlobsDir: string;
  attachmentStagingDir: string;
  attachmentSessionResourcesDir: string;
  notesDir: string;
  notesOrganizationFilePath: string;
  notesOrganizationPreviousFilePath: string;
  storagePolicyFilePath: string;
  usageSettingsFilePath: string;
  imageAttachmentCacheDir: string;
  composerRecoveryFilePath: string;
  notesRecoveryFilePath: string;
  quickNotesRecoveryFilePath: string;
  imageAnnotationsDir: string;
  gitSettingsFilePath: string;
  legacyImportFilePath: string;
  daemonDir: string;
  daemonRegistryFilePath: string;
  shellOutputDir: string;
  userMemoryDir: string;
  sessionMemoryDir: string;
  memoryBackupsDir: string;
  exportsDir: string;
  backupAuditsDir: string;
  maintenanceAuditsDir: string;
  migrationsDir: string;
  pathMapFilePath: string;

  logsDir: string;
  sessionsDir: string;
  pluginsDir: string;
  pluginCacheDir: string;
  pluginDataDir: string;
  pluginSourcesDir: string;
  installedPluginStorePath: string;
  skillsDir: string;
  tasksDir: string;
  feedbackDir: string;
  configFilePath: string;
  credentialsFilePath: string;
  mcpOAuthFilePath: string;
  channelCredentialsFilePath: string;
}

export interface ResolvedPaths extends UserDataPaths {
  /** Compatibility alias for dataRoot; never an independent root. */
  configDir: string;
  memoryDir: string;
}

export function resolveUserDataPaths(dataRoot: string): UserDataPaths {
  return buildUserDataPaths(dataRoot, join(dataRoot, "data"));
}

function buildUserDataPaths(dataRoot: string, dataDir: string): UserDataPaths {
  const cacheDir = join(dataRoot, "cache");
  const pluginsDir = join(dataRoot, "plugins");
  const desktopDataDir = join(dataDir, "desktop");
  const sessionRuntimeDir = join(dataDir, "session-runtime");
  return {
    dataRoot,
    dataDir,
    cacheDir,
    channelsDir: join(dataRoot, "channels"),
    workspacesDir: join(dataRoot, "workspaces"),
    worktreesDir: join(dataRoot, "worktrees"),
    desktopDataDir,
    agentsDir: join(dataRoot, "agents"),
    localRulesDir: join(dataRoot, "local_rules", "projects"),
    outputStylesDir: join(dataRoot, "output_styles"),
    userProfilePendingDir: join(dataRoot, "user_profile_pending"),
    modelsDevCacheFilePath: join(cacheDir, "models-dev.json"),
    frecencyFilePath: join(dataRoot, "frecency.json"),
    runtimeEnvironmentSecretsFilePath: join(dataRoot, "runtime-environment-secrets.json"),
    soulFilePath: join(dataRoot, "SOUL.md"),
    userProfileFilePath: join(dataRoot, "USER.md"),
    sessionRuntimeDir,
    sessionsDatabasePath: join(sessionRuntimeDir, "sessions.db"),
    attachmentBlobsDir: join(sessionRuntimeDir, "attachments", "blobs"),
    attachmentStagingDir: join(sessionRuntimeDir, "attachments", "staging"),
    attachmentSessionResourcesDir: join(sessionRuntimeDir, "attachment-session-resources"),
    notesDir: join(sessionRuntimeDir, "notes"),
    notesOrganizationFilePath: join(sessionRuntimeDir, "notes", "organization.json"),
    notesOrganizationPreviousFilePath: join(sessionRuntimeDir, "notes", "organization.previous.json"),
    storagePolicyFilePath: join(sessionRuntimeDir, "storage-policy.json"),
    usageSettingsFilePath: join(sessionRuntimeDir, "usage-settings.json"),
    imageAttachmentCacheDir: join(dataDir, "attachments", "images"),
    composerRecoveryFilePath: join(desktopDataDir, "composer-recovery.json"),
    notesRecoveryFilePath: join(desktopDataDir, "notes-recovery.json"),
    quickNotesRecoveryFilePath: join(desktopDataDir, "quick-notes-recovery.json"),
    imageAnnotationsDir: join(desktopDataDir, "image-annotations"),
    gitSettingsFilePath: join(desktopDataDir, "git-settings.json"),
    legacyImportFilePath: join(desktopDataDir, "legacy-import.json"),
    daemonDir: join(dataDir, "daemon"),
    daemonRegistryFilePath: join(dataDir, "daemon", "registry.json"),
    shellOutputDir: join(dataDir, "tasks", "shell-output"),
    userMemoryDir: join(dataDir, "memory"),
    sessionMemoryDir: join(dataDir, "session-memory"),
    memoryBackupsDir: join(dataDir, "memory-backups"),
    exportsDir: join(dataDir, "exports"),
    backupAuditsDir: join(dataDir, "backup-audits"),
    maintenanceAuditsDir: join(dataDir, "maintenance-audits"),
    migrationsDir: join(dataDir, "migrations"),
    pathMapFilePath: join(dataDir, "migrations", "path-map.json"),
    logsDir: join(dataDir, "logs"),
    sessionsDir: join(dataDir, "sessions"),
    pluginsDir,
    pluginCacheDir: join(pluginsDir, "cache"),
    pluginDataDir: join(pluginsDir, "data"),
    pluginSourcesDir: join(pluginsDir, "sources"),
    installedPluginStorePath: join(pluginsDir, "installed.json"),
    skillsDir: join(dataRoot, "skills"),
    tasksDir: join(dataDir, "tasks"),
    feedbackDir: join(dataDir, "feedback"),
    configFilePath: join(dataRoot, "settings.json"),
    credentialsFilePath: join(dataRoot, "credentials.json"),
    mcpOAuthFilePath: join(dataRoot, "mcp-oauth.json"),
    channelCredentialsFilePath: join(dataRoot, "channel-credentials.json"),
  };
}

export function getDataRoot(): string {
  return currentDataRoot();
}

export function resolvePaths(projectRoot?: string): ResolvedPaths {
  const dataRoot = getDataRoot();
  // Keep the existing override until startup migration guards are connected.
  const dataDir = process.env.VYKOR_DATA_DIR ?? join(dataRoot, "data");
  return {
    ...buildUserDataPaths(dataRoot, dataDir),
    configDir: dataRoot,
    memoryDir: join(projectRoot ?? process.cwd(), PROJECT_CONFIG_DIR_NAME, "memory"),
  };
}

export function getConfigDir(): string {
  return getDataRoot();
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
  return resolvePaths().pluginCacheDir;
}

export function getPluginDataDir(): string {
  return resolvePaths().pluginDataDir;
}

export function getPluginSourcesDir(): string {
  return resolvePaths().pluginSourcesDir;
}

export function getInstalledPluginStorePath(): string {
  return resolvePaths().installedPluginStorePath;
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
  return join(getUserMemoryDir(), `${basename(root)}-${digest}`);
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

/**
 * 渠道会话工作区根目录。默认落在"项目外工作区"根（`<文档>/Vykor`）下的 `channels`，
 * 以便 Desktop 把它当作项目外工作区隐藏；可用 VYKOR_CHANNELS_DIR 显式覆盖。
 */
export function resolveChannelWorkspaceRoot(input: {
  envDir?: string | undefined;
  outsideProjectWorkspaceRoot?: string | undefined;
  homedir?: string | undefined;
} = {}): string {
  if (input.envDir) return input.envDir;
  const base =
    input.outsideProjectWorkspaceRoot ??
    join(input.homedir ?? homedir(), "Documents", "Vykor");
  return join(base, "channels");
}

export function getChannelWorkspaceRoot(): string {
  return resolveChannelWorkspaceRoot({
    envDir: process.env.VYKOR_CHANNELS_DIR,
  });
}

export function getCacheDir(): string {
  return resolvePaths().cacheDir;
}

export function getChannelsDir(): string {
  return resolvePaths().channelsDir;
}

export function getWorkspacesDir(): string {
  return resolvePaths().workspacesDir;
}

export function getWorktreesDir(): string {
  return resolvePaths().worktreesDir;
}

export function getDesktopDataDir(): string {
  return resolvePaths().desktopDataDir;
}

export function getAgentsDir(): string {
  return resolvePaths().agentsDir;
}

export function getLocalRulesDir(): string {
  return resolvePaths().localRulesDir;
}

export function getOutputStylesDir(): string {
  return resolvePaths().outputStylesDir;
}

export function getUserProfilePendingDir(): string {
  return resolvePaths().userProfilePendingDir;
}

export function getModelsDevCacheFilePath(): string {
  return resolvePaths().modelsDevCacheFilePath;
}

export function getFrecencyFilePath(): string {
  return resolvePaths().frecencyFilePath;
}

export function getRuntimeEnvironmentSecretsFilePath(): string {
  return resolvePaths().runtimeEnvironmentSecretsFilePath;
}

export function getSoulFilePath(): string {
  return resolvePaths().soulFilePath;
}

export function getUserProfileFilePath(): string {
  return resolvePaths().userProfileFilePath;
}

export function getSessionRuntimeDir(): string {
  return resolvePaths().sessionRuntimeDir;
}

export function getSessionsDatabasePath(): string {
  return resolvePaths().sessionsDatabasePath;
}

export function getAttachmentBlobsDir(): string {
  return resolvePaths().attachmentBlobsDir;
}

export function getAttachmentStagingDir(): string {
  return resolvePaths().attachmentStagingDir;
}

export function getAttachmentSessionResourcesDir(): string {
  return resolvePaths().attachmentSessionResourcesDir;
}

export function getNotesDir(): string {
  return resolvePaths().notesDir;
}

export function getNotesOrganizationFilePath(): string {
  return resolvePaths().notesOrganizationFilePath;
}

export function getNotesOrganizationPreviousFilePath(): string {
  return resolvePaths().notesOrganizationPreviousFilePath;
}

export function getStoragePolicyFilePath(): string {
  return resolvePaths().storagePolicyFilePath;
}

export function getUsageSettingsFilePath(): string {
  return resolvePaths().usageSettingsFilePath;
}

export function getImageAttachmentCacheDir(): string {
  return resolvePaths().imageAttachmentCacheDir;
}

export function getComposerRecoveryFilePath(): string {
  return resolvePaths().composerRecoveryFilePath;
}

export function getNotesRecoveryFilePath(): string {
  return resolvePaths().notesRecoveryFilePath;
}

export function getQuickNotesRecoveryFilePath(): string {
  return resolvePaths().quickNotesRecoveryFilePath;
}

export function getImageAnnotationsDir(): string {
  return resolvePaths().imageAnnotationsDir;
}

export function getGitSettingsFilePath(): string {
  return resolvePaths().gitSettingsFilePath;
}

export function getLegacyImportFilePath(): string {
  return resolvePaths().legacyImportFilePath;
}

export function getDaemonDir(): string {
  return resolvePaths().daemonDir;
}

export function getDaemonRegistryFilePath(): string {
  return resolvePaths().daemonRegistryFilePath;
}

export function getShellOutputDir(): string {
  return resolvePaths().shellOutputDir;
}

export function getUserMemoryDir(): string {
  return resolvePaths().userMemoryDir;
}

export function getSessionMemoryDir(): string {
  return resolvePaths().sessionMemoryDir;
}

export function getMemoryBackupsDir(): string {
  return resolvePaths().memoryBackupsDir;
}

export function getExportsDir(): string {
  return resolvePaths().exportsDir;
}

export function getBackupAuditsDir(): string {
  return resolvePaths().backupAuditsDir;
}

export function getMaintenanceAuditsDir(): string {
  return resolvePaths().maintenanceAuditsDir;
}

export function getMigrationsDir(): string {
  return resolvePaths().migrationsDir;
}

export function getPathMapFilePath(): string {
  return resolvePaths().pathMapFilePath;
}
