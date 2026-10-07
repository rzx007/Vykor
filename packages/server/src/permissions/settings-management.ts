import {
  parsePermissionSettings,
  type PermissionSettings,
  type SandboxConfig,
} from "@vykor/core";
import { PermissionChecker } from "@vykor/permissions";
import {
  getSandboxAvailability,
  hostPathToWslPath,
  normalizeSandboxConfig,
} from "@vykor/sandbox";

/** Host-side settings inspection; no tools, model calls, or processes are started. */
export function inspectPermissionConfiguration(
  settings: Record<string, unknown>,
) {
  const permission = parsePermissionSettings(
    settings.permission ?? { mode: "default" },
  );
  const sandbox = normalizeSandboxConfig(
    settings.sandbox as SandboxConfig | undefined,
  );
  const wsl =
    (settings.agentEnvironment as { kind?: string } | undefined)?.kind ===
    "wsl";
  const availability = wsl
    ? {
        enabled: sandbox.enabled,
        available: false,
        active: false,
        reason: "当前不支持 WSL 与 SRT 隔离同时使用。",
      }
    : getSandboxAvailability({ ...sandbox, enabled: true });
  const { backend: _backend, ...configuration } = sandbox;
  return {
    permission,
    sandbox: configuration,
    isolationAvailable: availability.available,
    isolationReason:
      !wsl && process.platform === "win32"
        ? "Windows 本机暂不支持 SRT 隔离，WSL 与 SRT 的组合也不支持。"
        : (availability.reason ?? null),
    environment: wsl ? ("wsl" as const) : ("native" as const),
  };
}

export async function checkPermissionConfiguration(input: {
  permission: unknown;
  toolName: string;
  path?: string;
  command?: string;
  cwd: string;
  environment: "native" | "wsl";
}) {
  if (!input.toolName.trim()) throw new Error("请输入工具名称。");
  const permission = parsePermissionSettings(input.permission);
  const cwd =
    input.environment === "wsl" ? hostPathToWslPath(input.cwd) : input.cwd;
  const path =
    input.environment === "wsl" &&
    input.path &&
    /^[a-z]:[\\/]/i.test(input.path)
      ? hostPathToWslPath(input.path)
      : input.path;
  const checker = new PermissionChecker({
    ...permission,
    cwd,
    pathStyle:
      input.environment === "wsl" || process.platform !== "win32"
        ? "posix"
        : "windows",
  });
  return checker.checkTool(input.toolName, {
    ...(path ? { path } : {}),
    ...(input.command ? { command: input.command } : {}),
  });
}

export function validatePermissionConfiguration(
  value: unknown,
): PermissionSettings {
  return parsePermissionSettings(value);
}

export function validateIsolationConfiguration(value: unknown): SandboxConfig {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("隔离设置必须是对象。");
  const config = value as SandboxConfig;
  const keys = [
    "enabled",
    "failIfUnavailable",
    "enabledPlatforms",
    "filesystem",
    "network",
    "srt",
  ];
  if (Object.keys(config).some((key) => !keys.includes(key)))
    throw new Error("隔离设置包含未知字段。");
  for (const key of ["enabled", "failIfUnavailable"] as const) {
    if (typeof config[key] !== "boolean")
      throw new Error("隔离开关必须是布尔值。");
  }
  const groups = [config.filesystem, config.network, config.srt];
  if (
    groups.some(
      (group) => !group || typeof group !== "object" || Array.isArray(group),
    )
  )
    throw new Error("隔离设置缺少必要分组。");
  const array = (list: unknown) =>
    Array.isArray(list) &&
    list.every((item) => typeof item === "string" && item.trim());
  const filesystem = config.filesystem!;
  const network = config.network!;
  const pathKeys = [
    "allowRead",
    "denyRead",
    "allowWrite",
    "denyWrite",
    "extraAllowedRoots",
  ] as const;
  if (
    Object.keys(filesystem).some(
      (key) => !pathKeys.includes(key as (typeof pathKeys)[number]),
    ) ||
    pathKeys.some((key) => !array(filesystem[key]))
  )
    throw new Error("文件边界必须是路径列表。");
  if (
    !array(network.allowedDomains) ||
    !array(network.deniedDomains) ||
    !["none", "bridge", "host", "proxy"].includes(network.mode ?? "") ||
    typeof network.strictDomainPolicy !== "boolean" ||
    Object.keys(network).some(
      (key) =>
        ![
          "mode",
          "allowedDomains",
          "deniedDomains",
          "strictDomainPolicy",
        ].includes(key),
    )
  )
    throw new Error("网络边界设置无效。");
  if (
    !array(config.enabledPlatforms) ||
    config.enabledPlatforms!.some(
      (platform) => !["linux", "wsl", "macos"].includes(platform),
    )
  )
    throw new Error("隔离平台设置无效。");
  if (
    typeof config.srt!.runtimeCommand !== "string" ||
    !config.srt!.runtimeCommand.trim() ||
    Object.keys(config.srt!).some((key) => key !== "runtimeCommand")
  )
    throw new Error("请输入 SRT 可执行文件名称。");
  return structuredClone(config);
}
