import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as frecency from "../frecency";

test("close flushes the bound root and reopens without cached data or an old timer", async () => {
  const base = mkdtempSync(join(tmpdir(), "vykor-frecency-"));
  const first = join(base, "first"), second = join(base, "second"), home = join(base, "home"); mkdirSync(home);
  const env = { config: process.env.VYKOR_CONFIG_DIR, home: process.env.HOME, profile: process.env.USERPROFILE };
  try {
    process.env.HOME = home; process.env.USERPROFILE = home; process.env.VYKOR_CONFIG_DIR = first;
    frecency.record("command", "first-command");
    process.env.VYKOR_CONFIG_DIR = second;
    frecency.closeFrecency();
    expect(JSON.parse(readFileSync(join(first, "frecency.json"), "utf8")).command["first-command"]).toHaveLength(1);
    expect(frecency.rank("command").size).toBe(0);
    frecency.record("file", "second-file"); frecency.closeFrecency();
    await new Promise(resolve => setTimeout(resolve, 550));
    expect(frecency.rank("file").has("second-file")).toBe(true);
    expect(frecency.rank("command").has("first-command")).toBe(false);
    expect(readdirSync(home)).toEqual([]);
  } finally {
    frecency.closeFrecency();
    for (const [name, value] of [["VYKOR_CONFIG_DIR", env.config], ["HOME", env.home], ["USERPROFILE", env.profile]]) {
      if (value === undefined) delete process.env[name!]; else process.env[name!] = value;
    }
    rmSync(base, { recursive: true, force: true });
  }
});
