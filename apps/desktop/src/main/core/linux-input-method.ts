import type { CommandLine } from "electron"

/** Must run before app.whenReady(): Chromium selects the input method at startup. */
export function configureLinuxInputMethod(
  commandLine: Pick<CommandLine, "appendSwitch">,
  platform: NodeJS.Platform,
): void {
  if (platform !== "linux") return

  // Electron 39 selects native Wayland automatically, but its IME connection
  // still needs enabling. X11 ignores this switch; keep the backend user's choice.
  commandLine.appendSwitch("enable-wayland-ime")
}
