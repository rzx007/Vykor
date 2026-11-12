import { mkdtemp, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
const exit = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ app: { isPackaged: false, exit } }));
vi.mock("../core/linux-input-method", () => ({ configureLinuxInputMethod: () => undefined }));
vi.mock("../features/workspace/document-preview-protocol", () => ({ registerDocumentPreviewScheme: () => undefined }));
vi.mock("../features/plugin-apps/document-protocol", () => ({ registerPluginAppScheme: () => undefined }));

it("stops Desktop before loading the application when a directory override conflicts", async () => {
  const home = await mkdtemp(join(tmpdir(), "vykor-desktop-overrides-"));
  const argv = process.argv;
  try {
    vi.stubEnv("HOME", home); vi.stubEnv("USERPROFILE", home);
    vi.stubEnv("VYKOR_CONFIG_DIR", join(home, "selected"));
    vi.stubEnv("VYKOR_DATA_DIR", join(home, "old-data"));
    process.argv = ["node", "desktop.ts"];
    const errors: unknown[][] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => { errors.push(args); });
    await import("../index");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1));
    expect(String(errors[0]?.[1])).toContain("VYKOR_DATA_DIR");
    expect(await readdir(home)).toEqual([]);
  } finally { process.argv = argv; vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(home, { recursive: true, force: true }); }
});
