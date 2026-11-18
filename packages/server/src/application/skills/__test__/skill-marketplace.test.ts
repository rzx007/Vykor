import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { Readable } from "node:stream";
import type { SkillMarketplaceInstallInput } from "@vykor/domain-contracts/skills";
import { createSkillRegistrySnapshot, findProjectSkillDirs } from "@vykor/skills";
import { afterEach, expect, it, vi } from "vitest";
import { createSkillManagementService } from "../skill-management-service.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, rm: vi.fn(fs.rm) };
});

// A stored ZIP containing SKILL.md, LICENSE, and references/guide.md.
const zip = Buffer.from("UEsDBBQAAAAAAAAAIQAezPWcUQAAAFEAAAAIAAAAU0tJTEwubWQtLS0KbmFtZTogbWFya2V0LXNhbXBsZQpkZXNjcmlwdGlvbjogTWFya2V0IHNhbXBsZQotLS0KUmVhZCByZWZlcmVuY2VzL2d1aWRlLm1kLgpQSwMEFAAAAAAAAAAhAKP/vDELAAAACwAAAAcAAABMSUNFTlNFTUlUIGV4YW1wbGVQSwMEFAAAAAAAAAAhADXHnsoFAAAABQAAABMAAAByZWZlcmVuY2VzL2d1aWRlLm1kZ3VpZGVQSwECFAAUAAAAAAAAACEAHsz1nFEAAABRAAAACAAAAAAAAAAAAAAAgAEAAAAAU0tJTEwubWRQSwECFAAUAAAAAAAAACEAo/+8MQsAAAALAAAABwAAAAAAAAAAAAAAgAF3AAAATElDRU5TRVBLAQIUABQAAAAAAAAAIQA1x57KBQAAAAUAAAATAAAAAAAAAAAAAACAAacAAAByZWZlcmVuY2VzL2d1aWRlLm1kUEsFBgAAAAADAAMArAAAAN0AAAAAAA==", "base64");
const sha256 = createHash("sha256").update(zip).digest("hex");
const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function setup(options: { corrupt?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "vykor-skill-market-test-"));
  dirs.push(root);
  const configDir = join(root, "personal");
  const projectPath = join(root, "project");
  await mkdir(projectPath);
  const name = "market-sample";
  let version = "1.0.0";
  let release = "skills-v1";
  let registered = true;
  const service = createSkillManagementService({
    configDir,
    standardSkillsDirs: [],
    bundledSkills: [],
    projects: { list: () => registered ? [{ name: "Project", path: projectPath }] : [] },
    marketplaceRequest: async (url) => {
      const skills = [{
        name, id: name, displayName: "Sample", description: "Sample", version, license: "MIT",
        source: { repository: "https://github.com/example/skills", commit: "a".repeat(40), path: "." },
        artifact: {
          url: `https://github.com/rzx007/vykor-skills/releases/download/${release}/${name}-${version}.zip`,
          sha256, size: zip.length,
        },
      }];
      return {
        status: 200, headers: {},
        body: Readable.from([url.pathname.endsWith(".json")
          ? Buffer.from(JSON.stringify({ schemaVersion: 1, release, skills }))
          : options.corrupt ? Buffer.alloc(zip.length) : zip]),
      };
    },
  });
  const install = async (input: SkillMarketplaceInstallInput) => {
    const prepared = await service.prepareMarketplaceInstall(input);
    try {
      await prepared.commit();
    } finally {
      await prepared.cleanup();
    }
    return service.list();
  };
  return {
    service, install, projectPath, configDir, root, name,
    selection: () => ({ id: name, version, sha256 }),
    updateCatalog: (minor = 1) => { version = `1.${minor}.0`; release = `skills-v${minor + 1}`; },
    unregisterProject: () => { registered = false; },
  };
}

it("installs complete skills into either scope, updates and uninstalls copies independently", async () => {
  const { service, install, projectPath, configDir, name, selection, updateCatalog } = await setup();
  expect(await service.listMarketplace()).toMatchObject([{ id: name, version: "1.0.0" }]);
  await install({ ...selection(), scope: "personal" });
  const snapshot = await install({ ...selection(), scope: "project", projectPath });
  const projectSkill = snapshot.skills.find((item) => item.source === "project")!;
  expect(await readFile(join(configDir, "skills", name, "references", "guide.md"), "utf8")).toBe("guide");
  expect(await readFile(join(projectPath, ".vykor", "skills", name, "references", "guide.md"), "utf8")).toBe("guide");
  expect(projectSkill.marketplace).toMatchObject({ id: name, version: "1.0.0" });
  const lookup = async (cwd: string) => (await createSkillRegistrySnapshot({
    bundled: false, userDir: join(configDir, "skills"), projectDirs: await findProjectSkillDirs(cwd),
  })).resolve(name)?.path;
  expect(await lookup(configDir)).toBe(join(configDir, "skills", name, "SKILL.md"));
  expect(await lookup(projectPath)).toBe(join(projectPath, ".vykor", "skills", name, "SKILL.md"));

  updateCatalog();
  const updated = await install({ ...selection(), scope: "personal" });
  expect(updated.skills.find((item) => item.source === "personal")?.marketplace?.version).toBe("1.1.0");
  expect(updated.skills.find((item) => item.source === "project")?.marketplace?.version).toBe("1.0.0");
  const reference = join(projectPath, ".vykor", "skills", name, "references", "guide.md");
  await writeFile(reference, "local edit");
  await expect(service.remove({ id: projectSkill.id, expectedContent: projectSkill.content })).rejects.toThrow(/本地修改/);
  await writeFile(reference, "guide");
  await service.remove({ id: projectSkill.id, expectedContent: projectSkill.content });
  await expect(stat(join(projectPath, ".vykor", "skills", name))).rejects.toMatchObject({ code: "ENOENT" });
  expect((await service.list()).skills.map((item) => item.source)).toEqual(["personal"]);
});

it("rejects unsafe targets, conflicts and corrupt packages without replacing local files", async () => {
  const { install, configDir, root, name, selection } = await setup({ corrupt: true });
  await expect(install({ ...selection(), scope: "project", projectPath: root })).rejects.toThrow(/项目/);
  await expect(install({ ...selection(), scope: "personal" })).rejects.toThrow(/摘要/);
  const target = join(configDir, "skills", name);
  await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
  await mkdir(target, { recursive: true });
  const manual = join(target, "SKILL.md");
  await writeFile(manual, `---\nname: ${name}\n---\nLocal skill.\n`);
  await expect(install({ ...selection(), scope: "personal" })).rejects.toThrow(/已存在|同名/);
  expect(await readFile(manual, "utf8")).toContain("Local skill.");
});

it("can upgrade again after deletion of an obsolete version removes its marker and then fails", async () => {
  const { service, install, configDir, selection, updateCatalog } = await setup();
  const installSelected = () => install({ ...selection(), scope: "personal" });
  const installedVersion = async () => (await service.list()).skills[0]?.marketplace?.version;
  const realRm = (await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")).rm;
  await installSelected();
  updateCatalog();

  let interrupted = false;
  vi.mocked(rm).mockImplementation(async (path, options) => {
    if (typeof path === "string" && path.startsWith(configDir + sep)) {
      const children = await readdir(path, { withFileTypes: true }).catch(() => []);
      const candidates = [path, ...children.filter((child) => child.isDirectory()).map((child) => join(path, child.name))];
      for (const candidate of candidates) {
        const marker = join(candidate, ".vykor-skill-install.json");
        const version = await readFile(marker, "utf8").then((data) => JSON.parse(data).version, () => undefined);
        if (version !== "1.0.0") continue;
        interrupted = true;
        await realRm(marker);
        throw new Error("Interrupted cleanup");
      }
    }
    await realRm(path, options);
  });
  try {
    await installSelected();
    expect(interrupted).toBe(true);
  } finally {
    vi.mocked(rm).mockImplementation(realRm);
  }
  expect(await installedVersion()).toBe("1.1.0");
  updateCatalog(2);
  await installSelected();
  expect(await installedVersion()).toBe("1.2.0");
});

it("checks that the project is still registered when publishing a prepared install", async () => {
  const { service, projectPath, name, selection, unregisterProject } = await setup();
  const prepared = await service.prepareMarketplaceInstall({ ...selection(), scope: "project", projectPath });
  try {
    unregisterProject();
    await expect(prepared.commit()).rejects.toThrow(/已登记的项目/);
    await expect(stat(join(projectPath, ".vykor", "skills", name))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await prepared.cleanup();
  }
});

it("preserves a same-name skill created at another path after preparation", async () => {
  const { service, configDir, name, selection } = await setup();
  const prepared = await service.prepareMarketplaceInstall({ ...selection(), scope: "personal" });
  try {
    const skills = join(configDir, "skills");
    const manual = join(skills, "manual.md");
    const content = `---\nname: ${name}\n---\nLocal skill.\n`;
    await writeFile(manual, content);
    await expect(prepared.commit()).rejects.toThrow(/同名技能/);
    expect(await readFile(manual, "utf8")).toBe(content);
    await expect(stat(join(skills, name))).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await prepared.cleanup();
  }
});

it("restores an intact previous version at commit if an interrupted upgrade left the target absent", async () => {
  const { service, install, configDir, name, selection } = await setup();
  const input = { ...selection(), scope: "personal" } as const;
  await install(input);
  const target = join(configDir, "skills", name);
  const backup = join(configDir, `.skill-rollback-${name}`);
  await rename(target, backup);

  const prepared = await service.prepareMarketplaceInstall(input);
  try {
    await expect(stat(target)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(prepared.commit()).resolves.toBe(true);
    expect(await readFile(join(target, "references", "guide.md"), "utf8")).toBe("guide");
    await expect(stat(backup)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await prepared.cleanup();
  }
});
