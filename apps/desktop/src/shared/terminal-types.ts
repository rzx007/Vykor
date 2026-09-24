import type {
  TerminalCreateRequest,
  TerminalEvent,
  TerminalReadRequest,
  TerminalReadResult,
  TerminalResizeRequest,
  TerminalSessionInfo,
  TerminalWriteRequest,
} from "@vykor/client"

export type DesktopDetectedTerminalShell = { id: string; label: string }

export type DesktopTerminalCreateInput = TerminalCreateRequest
export type DesktopTerminalRecord = TerminalSessionInfo
export type DesktopTerminalWriteInput = TerminalWriteRequest
export type DesktopTerminalResizeInput = TerminalResizeRequest
export type DesktopTerminalReadInput = TerminalReadRequest
export type DesktopTerminalReadResult = TerminalReadResult
export type DesktopTerminalEvent = TerminalEvent
