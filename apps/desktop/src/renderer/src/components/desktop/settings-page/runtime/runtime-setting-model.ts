import type { DesktopAgentEnvironment } from "@shared/settings-types"

const LABELS: Record<DesktopAgentEnvironment, string> = {
  native: "本机",
  wsl: "WSL",
}

export function runtimeEnvironmentLabel(environment: DesktopAgentEnvironment): string {
  return LABELS[environment]
}

export function runtimeEnvironmentNotice(restartRequired: boolean): string | null {
  if (restartRequired) return "已保存，重启 Vykor 后生效。"
  return null
}
