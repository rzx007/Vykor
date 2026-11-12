import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, it, vi } from "vitest";
import { initializeDataRoot } from "@vykor/host-config/paths";
import { SkillRegistry, createSkillRegistrySnapshot } from "../index.js";

it("renders builtin personal skill write instructions for the selected root at registration", async () => {
  const base = await mkdtemp(join(tmpdir(), "vykor-bundled-root-"));
  const home = join(base, "home"), root = join(base, "selected-$&-root"); await mkdir(home);
  try {
    await initializeDataRoot({ explicitRoot: root, homeDir: home, env: {} });
    vi.stubEnv("VYKOR_CONFIG_DIR", join(base, "late-env"));
    const registry = new SkillRegistry(); registry.registerBundled();
    const snapshot = await createSkillRegistrySnapshot();
    for (const skills of [registry, snapshot]) {
      const create = skills.get("create-skill")!;
      expect(create.content).toContain(`${join(root, "skills").replaceAll("\\", "/")}/<skill-name>/`);
      expect(create.description).toContain(join(root, "skills").replaceAll("\\", "/"));
      expect(create.content).not.toContain("~/.vykor/skills");
      expect(create.description).not.toContain("~/.vykor/skills");
      expect(create.content).toContain("<cwd>/.vykor/skills/<skill-name>/");
    }
  } finally { vi.unstubAllEnvs(); await rm(base, { recursive: true, force: true }); }
});
