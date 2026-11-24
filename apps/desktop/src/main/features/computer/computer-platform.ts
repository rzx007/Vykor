import type { ComputerCaptureRegion, ComputerPointerGesture } from "@vykor/server/daemon-host"

export interface ComputerApp {
  id: string
  name: string
  confirmExistingWindow?: true
  /** Local application chooser only. Never include native details in a model result. */
  detail?: string
}

export interface ComputerWindow {
  windowId: string | number
  ownerWindowId?: string | number
  /** A blocked root has no safe dialog the host may inherit from this scan. */
  blocked?: boolean
  title: string
  document?: string
  /** Desktop chooser only. Input geometry is captured and verified separately. */
  position?: { left: number; top: number }
}

export interface ComputerApps<Window extends ComputerWindow> {
  catalogName?: string
  discover(name: string, signal: AbortSignal): Promise<ComputerApp[]>
  windows(app: ComputerApp, signal: AbortSignal): Promise<Window[]>
  launch(app: ComputerApp, signal: AbortSignal): Promise<void>
}

export class ComputerAppUnavailableError extends Error {
  constructor(message: string, readonly reason: "desktop_unavailable" | "window_restricted" | "app_changed") {
    super(message)
  }
}

export interface ComputerDriverElement {
  token: string
  role: string
  label: string
  automationId?: string
  actions: string[]
  value?: string
  /** Proof of the complete native field value, including text outside the preview. */
  valueDigest?: string
  valueTruncated?: boolean
  enabled?: boolean
  protected?: boolean
  selected?: boolean
  checked?: boolean
  expanded?: boolean
  identity?: string
  index?: number
  parentIndex?: number
  depth?: number
  horizontalScrollPercent?: number
  verticalScrollPercent?: number
}

export interface ComputerDriverObservation {
  title: string
  elements: ComputerDriverElement[]
  focusIdentity?: string
}

export type ComputerDriverAction =
  | { type: "invoke" | "choose"; token: string }
  | { type: "set_text"; token: string; text: string }
  | { type: "scroll"; token: string; direction: "up" | "down" | "left" | "right"; amount?: number }

export interface ComputerDriver {
  observe(signal: AbortSignal, readback?: { title: string }): Promise<ComputerDriverObservation>
  act(action: ComputerDriverAction, signal: AbortSignal): Promise<void>
  close(): Promise<void>
}

export class ComputerDriverError extends Error {
  constructor(message: string, readonly executionState: "not_started" | "unknown" = "not_started") {
    super(message)
    this.name = "ComputerDriverError"
  }
}

export class ComputerDriverHandoffError extends ComputerDriverError {
  constructor(message: string) {
    super(message)
  }
}

export type ComputerInputAction =
  | ComputerPointerGesture
  | { type: "key"; key: string; modifiers?: ("ctrl" | "alt" | "shift")[]; focusIdentity?: string }
  | { type: "text"; text: string; focusIdentity?: string }

export interface ComputerForegroundFrame {
  mimeType: "image/png"
  data: string
  width: number
  height: number
  geometry: { left: number; top: number; width: number; height: number; dpi: number; monitor: string }
  /** Native pixels relative to the captured window, when only part of it was captured. */
  region?: ComputerCaptureRegion
  signature?: string
  focusIdentity?: string
}

export type ComputerForegroundRevokeReason = "focus_lost" | "physical_input" | "emergency_stop" |
  "window_changed" | "desktop_unavailable" | "driver_lost" | "release_unverified"

export interface ComputerForegroundRelease { released: boolean; exited: boolean }
export interface ComputerForegroundResult { state: "sent" | "refused" | "unknown"; released: boolean }
export interface ComputerForegroundLease {
  perform(action: ComputerInputAction, frame: ComputerForegroundFrame | undefined, signal: AbortSignal): Promise<ComputerForegroundResult>
  release(): Promise<ComputerForegroundRelease>
}
export type ComputerForegroundCrop = {
  geometry: ComputerForegroundFrame["geometry"]
  region: ComputerCaptureRegion
}
export interface ComputerForeground<Window extends ComputerWindow> {
  capture(
    window: Window,
    signal: AbortSignal,
    crop?: ComputerForegroundCrop
  ): Promise<ComputerForegroundFrame>
  enter(window: Window, onRevoked: (reason: ComputerForegroundRevokeReason) => void, signal: AbortSignal): Promise<ComputerForegroundLease>
}

export class ComputerForegroundStartError extends Error {
  constructor(message: string, readonly cleanup: ComputerForegroundRelease) {
    super(message)
  }
}

export interface ComputerPlatform<Window extends ComputerWindow> {
  apps: ComputerApps<Window>
  /** Compare the native instance, independently of its title or document. */
  sameWindowInstance(expected: Window, actual: Window): boolean
  openDriver?(window: Window, signal: AbortSignal): Promise<ComputerDriver>
  foreground?: ComputerForeground<Window>
}

export function frameContainsPoint(
  frame: { width: number; height: number },
  x: number,
  y: number
): boolean {
  return (
    Number.isSafeInteger(x) &&
    Number.isSafeInteger(y) &&
    x >= 0 &&
    y >= 0 &&
    x < frame.width &&
    y < frame.height
  )
}

export function nativeRegion(frame: ComputerForegroundFrame): ComputerCaptureRegion {
  return frame.region ?? { x: 0, y: 0, width: frame.geometry.width, height: frame.geometry.height }
}

export function cropFromFrame(
  frame: ComputerForegroundFrame,
  selection: ComputerCaptureRegion
): ComputerForegroundCrop | undefined {
  if (
    selection.width < 1 ||
    selection.height < 1 ||
    !frameContainsPoint(frame, selection.x, selection.y) ||
    !frameContainsPoint(
      frame,
      selection.x + selection.width - 1,
      selection.y + selection.height - 1
    )
  )
    return
  const region = nativeRegion(frame)
  const scaleX = region.width / frame.width,
    scaleY = region.height / frame.height
  const left = Math.floor(selection.x * scaleX),
    top = Math.floor(selection.y * scaleY)
  const width = Math.min(region.width, Math.ceil((selection.x + selection.width) * scaleX)) - left
  const height = Math.min(region.height, Math.ceil((selection.y + selection.height) * scaleY)) - top
  return {
    geometry: frame.geometry,
    region: { x: region.x + left, y: region.y + top, width, height },
  }
}

export function sameCaptureEvidence(saved: ComputerForegroundFrame, latest: ComputerForegroundFrame): boolean {
  const before = saved.geometry
  const after = latest.geometry
  return saved.focusIdentity === latest.focusIdentity && saved.data === latest.data && saved.width === latest.width && saved.height === latest.height &&
    before.left === after.left && before.top === after.top && before.width === after.width && before.height === after.height &&
    before.monitor === after.monitor && before.dpi === after.dpi
}
