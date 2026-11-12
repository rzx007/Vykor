import { describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ packaged: true }));
vi.mock("electron", () => ({ app: {
  get isPackaged() { return state.packaged; }, getAppPath: () => "D:/application", getPath: () => "D:/unused",
} }));
import { createDesktopDaemonSystemService } from "../daemon-autostart-service";

describe("desktop daemon root arguments", () => {
  it.each([true, false])("places the root before service flags (packaged=%s)", packaged => {
    state.packaged = packaged;
    const args = createDesktopDaemonSystemService().invocation().args;
    expect(args).toEqual([
      ...(packaged ? [] : ["D:/application"]),
      "--data-root", process.env.VYKOR_CONFIG_DIR,
      process.platform === "win32" ? "--daemon-watchdog" : "--daemon-service",
    ]);
  });
});
