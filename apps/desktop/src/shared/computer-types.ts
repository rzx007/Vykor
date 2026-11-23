export const COMPUTER_AVAILABLE_ARGUMENT = "--vykor-computer-ready"

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
  | { kind: "authorize"; sessionId: string; appName: string; onceOnly?: true }
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
