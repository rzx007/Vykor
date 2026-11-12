import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { writeDataRootSelector } from "../data-root-selection.js";
import { securePrivateFile } from "../private-file-permissions.js";

vi.mock("../private-file-permissions.js", async importOriginal => {
  const actual = await importOriginal<typeof import("../private-file-permissions.js")>();
  return { securePrivateFile: vi.fn(actual.securePrivateFile) };
});
afterEach(() => { vi.clearAllMocks(); });

it("keeps the old selector and removes candidate files if securing the candidate fails", async () => {
  const home = mkdtempSync(join(tmpdir(), "root-permission-failure-"));
  const original = { version: 1 as const, dataRoot: join(home, "old") };
  try {
    await writeDataRootSelector(home, original);
    const actual = await vi.importActual<typeof import("../private-file-permissions.js")>("../private-file-permissions.js");
    vi.mocked(securePrivateFile).mockImplementationOnce(actual.securePrivateFile).mockRejectedValueOnce(new Error("OS refused the private ACL"));
    await expect(writeDataRootSelector(home, { version: 1, dataRoot: join(home, "new") })).rejects.toThrow(/private ACL/);
    expect(JSON.parse(readFileSync(join(home, ".vykor-root.json"), "utf8"))).toEqual(original);
    expect(readdirSync(home)).toEqual([".vykor-root.json"]);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
