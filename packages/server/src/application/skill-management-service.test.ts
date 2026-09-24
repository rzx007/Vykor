import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSkillManagementService } from "./skill-management-service.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("SkillManagementService", () => {
  it("discovers registered project, agent, standard, personal, and bundled skills", async () => {
    const root = await temp();
    const project = join(root, "project");
    const config = join(root, "config");
    const standardAgents = join(root, ".agents", "skills");
    const standardConfig = join(root, ".config", "agents", "skills");
    await skill(join(project, ".agents", "skills", "agent.md"), "agent");
    await skill(
      join(project, ".claude", "skills", "claude", "SKILL.md"),
      "claude",
    );
    await skill(
      join(project, ".vykor", "skills", "project.md"),
      "project",
    );
    await skill(join(config, "skills", "personal.md"), "personal");
    await skill(join(standardAgents, "standard-a.md"), "standard-a");
    await skill(join(standardConfig, "standard-b.md"), "standard-b");
    const service = createSkillManagementService({
      projects: { list: () => [{ name: "Project", path: project }] },
      configDir: config,
      standardSkillsDirs: [standardAgents, standardConfig],
      bundledSkills: [bundled("builtin")],
    });

    const snapshot = await service.list();

    expect(
      snapshot.skills.map((item) => [item.name, item.source, item.readOnly]),
    ).toEqual([
      ["builtin", "bundled", true],
      ["agent", "agent", true],
      ["claude", "agent", true],
      ["project", "project", false],
      ["standard-a", "standard", true],
      ["standard-b", "standard", true],
      ["personal", "personal", false],
    ]);
    const standard = required(snapshot.skills, "standard-a");
    await expect(
      service.remove({ id: standard.id, expectedContent: standard.content }),
    ).rejects.toThrow(/只读/);
  });

  it("uses the authoritative project catalog and keeps VK global skills personal", async () => {
    const root = await temp();
    const config = join(root, ".vykor");
    await skill(join(config, "skills", "global.md"), "global");
    await skill(
      join(root, "unregistered", ".vykor", "skills", "hidden.md"),
      "hidden",
    );
    const service = createSkillManagementService({
      projects: { list: () => [{ name: "Home", path: root }] },
      configDir: config,
      bundledSkills: [],
    });

    const snapshot = await service.list();

    expect(
      snapshot.skills.find((item) => item.name === "global"),
    ).toMatchObject({ source: "personal" });
    expect(snapshot.skills.some((item) => item.name === "hidden")).toBe(false);
  });

  it("rejects readonly, stale, forged, and symlink-escaped removals", async () => {
    const root = await temp();
    const project = join(root, "project");
    const outside = join(root, "outside");
    const linked = join(project, ".vykor", "skills");
    await mkdir(dirname(linked), { recursive: true });
    await mkdir(outside, { recursive: true });
    await symlink(
      outside,
      linked,
      process.platform === "win32" ? "junction" : "dir",
    );
    const escapedContent = await skill(join(outside, "escaped.md"), "escaped");
    const service = createSkillManagementService({
      projects: { list: () => [{ name: "Project", path: project }] },
      configDir: join(root, "config"),
      bundledSkills: [bundled("builtin")],
    });
    const snapshot = await service.list();
    const builtin = required(snapshot.skills, "builtin");
    const escaped = required(snapshot.skills, "escaped");

    await expect(
      service.remove({ id: builtin.id, expectedContent: builtin.content }),
    ).rejects.toThrow(/只读/);
    await expect(
      service.remove({ id: "forged", expectedContent: "" }),
    ).rejects.toThrow(/找不到/);
    await expect(
      service.remove({ id: escaped.id, expectedContent: escapedContent }),
    ).rejects.toThrow(/符号链接|范围/);
  });

  it("deletes only the current writable entry file", async () => {
    const root = await temp();
    const config = join(root, "config");
    const file = join(config, "skills", "personal", "SKILL.md");
    const content = await skill(file, "personal");
    const reference = join(dirname(file), "reference.md");
    await writeFile(reference, "keep", "utf8");
    const service = createSkillManagementService({
      projects: { list: () => [] },
      configDir: config,
      bundledSkills: [],
    });
    const item = required((await service.list()).skills, "personal");
    await writeFile(file, markdown("personal", "changed"), "utf8");
    await expect(
      service.remove({ id: item.id, expectedContent: content }),
    ).rejects.toThrow(/修改/);
    const current = await readFile(file, "utf8");
    await service.remove({ id: item.id, expectedContent: current });
    await expect(stat(file)).rejects.toThrow();
    expect(await readFile(reference, "utf8")).toBe("keep");
  });
});

async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "vykor-skill-service-"));
  temporaryDirectories.push(path);
  return path;
}
async function skill(path: string, name: string): Promise<string> {
  const content = markdown(name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content, "utf8");
  return content;
}
function markdown(name: string, body = "body"): string {
  return `---\nname: ${name}\ndescription: ${name} description\n---\n\n${body}\n`;
}
function bundled(name: string) {
  return {
    name,
    description: `${name} description`,
    content: markdown(name),
    path: "",
  };
}
function required<T extends { name: string }>(items: T[], name: string): T {
  const item = items.find((candidate) => candidate.name === name);
  if (!item) throw new Error(`missing ${name}`);
  return item;
}
