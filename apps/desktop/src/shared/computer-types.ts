export type DesktopComputerAvailability = "unsupported" | "disabled" | "missing_driver" | "ready"

export interface DesktopComputerSettings {
  availability: DesktopComputerAvailability
  enabled: boolean
  alwaysForeground: boolean
  locked?: "unsupported" | "launch_disabled"
  inputRelease?: "unconfirmed"
}

export interface DesktopComputerSettingsUpdate {
  setting: "enabled" | "alwaysForeground"
  value: boolean
}

export interface DesktopComputerAppGrant {
  id: string
  name: string
}

export interface DesktopComputerCandidate {
  id: string
  label: string
  detail?: string
}

export type DesktopComputerPrompt = { id: string } & (
  | { kind: "authorize"; sessionId: string; appName: string }
  | { kind: "choose"; candidates: readonly DesktopComputerCandidate[]; confirmChange?: true }
)

export type DesktopComputerInteractionEvent =
  | { type: "prompt"; prompt: DesktopComputerPrompt }
  | { type: "dismissed"; id: string }

export interface DesktopComputerInteractionReply {
  id: string
  choice: string | null
}

export interface DesktopComputerActivity {
  sessionId: string
  runId: string
  phase: "ready" | "observing" | "foreground" | "paused" | "stopped"
  app?: string
  title?: string
  action?: string
  evidence?: string
  reason?: string
  captureEnabled?: boolean
  captureRevocation?: "pending" | "failed"
  inputRelease?: "pending" | "failed"
  preview?: { dataUrl: string; width: number; height: number }
}

export interface DesktopComputerActivityUpdate {
  sessionId: string
  activity: DesktopComputerActivity | null
}

export interface DesktopComputerControl {
  sessionId: string
  runId: string
  action: "pause" | "resume" | "stop" | "disable_capture" | "enable_capture"
}
