import { ComputerHost } from "./computer-host"
import type { ComputerInteraction } from "./interaction"
import { createWindowsApps, type WindowsAppWindow } from "./windows-apps"
import { createWindowsDriver } from "./windows-driver"
import { createWindowsForeground } from "./windows-foreground"

export function sameWindowsWindowInstance(expected: WindowsAppWindow, actual: WindowsAppWindow): boolean {
  return expected.windowId === actual.windowId && expected.ownerWindowId === actual.ownerWindowId &&
    expected.pid === actual.pid && expected.threadId === actual.threadId && expected.sessionId === actual.sessionId &&
    expected.processStartedAt === actual.processStartedAt && expected.processStartKey === actual.processStartKey &&
    expected.applicationPid === actual.applicationPid && expected.applicationStartKey === actual.applicationStartKey
}

export function createWindowsComputerPlatform() {
  return {
    apps: createWindowsApps(),
    sameWindowInstance: sameWindowsWindowInstance,
    openDriver: createWindowsDriver,
    foreground: createWindowsForeground(),
  }
}

export function createDesktopComputerHost(interaction: ComputerInteraction, previousInputCleanup: Promise<boolean>) {
  return new ComputerHost(createWindowsComputerPlatform(), interaction, previousInputCleanup)
}
