import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SkillRegistry,
  SkillLoader,
  parseSkillMarkdown,
  findProjectSkillDirs,
  createSkillRegistrySnapshot,
  standardUserSkillDirs,
  BUNDLED_SKILLS,
  type SkillDefinition,
} from "../src/index.js";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

/** 构造一个最小 SkillDefinition（补齐新增必填字段的默认值）。 */
function makeSkill(partial: Partial<SkillDefinition> & { name: string }): SkillDefinition {
  return {
    description: "",
    content: "",
    path: "",
    userInvocable: true,
    disableModelInvocation: false,
    ...partial,
  };
}

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(),
  readdir: vi.fn(),
  stat: vi.fn(),
}));

vi.mock("node:os", async () => {
  const actual = await vi.importActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: vi.fn(() => actual.homedir()),
  };
});

const mockedReadFile = vi.mocked(fs.readFile);
const mockedReaddir = vi.mocked(fs.readdir);
const mockedStat = vi.mocked(fs.stat);
const mockedHomedir = vi.mocked(os.homedir);

describe("SkillRegistry", () => {
  it("registers and retrieves a skill", () => {
    const reg = new SkillRegistry();
    const skill = makeSkill({ name: "test", description: "desc", content: "body", path: "/test.md" });
    reg.register(skill);
    expect(reg.get("test")).toBe(skill);
  });

  it("overwrites on duplicate register (last-writer-wins)", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ name: "x", description: "v1", content: "a", path: "/a.md" }));
    reg.register(makeSkill({ name: "x", description: "v2", content: "b", path: "/b.md" }));
    expect(reg.get("x")!.description).toBe("v2");
  });

  it("has returns true/false", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ name: "x", path: "/x.md" }));
    expect(reg.has("x")).toBe(true);
    expect(reg.has("y")).toBe(false);
  });

  it("unregister removes skill", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ name: "x", path: "/x.md" }));
    reg.unregister("x");
    expect(reg.has("x")).toBe(false);
  });

  it("getAll returns sorted skills", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ name: "beta", path: "/b.md" }));
    reg.register(makeSkill({ name: "alpha", path: "/a.md" }));
    const all = reg.getAll();
    expect(all[0].name).toBe("alpha");
    expect(all[1].name).toBe("beta");
  });

  it("resolveContent returns skill content", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ name: "x", content: "hello", path: "/x.md" }));
    expect(reg.resolveContent("x")).toBe("hello");
    expect(reg.resolveContent("nope")).toBeUndefined();
  });

  it("resolves by tolerant name and commandName", () => {
    const reg = new SkillRegistry();
    const skill = makeSkill({ name: "Dothing", commandName: "dt" });
    reg.register(skill);
    expect(reg.resolve("dothing")).toBe(skill);
    expect(reg.resolve("dt")).toBe(skill);
    expect(reg.resolve("missing")).toBeUndefined();
  });

  it("resolves only the current winner by its normalized path", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({
      name: "review",
      source: "user",
      path: "/user/review/SKILL.md",
      content: "user review",
    }));
    const projectReview = makeSkill({
      name: "review",
      source: "project",
      path: "/repo/.agents/skills/review/SKILL.md",
      content: "project review",
    });
    reg.register(projectReview);

    expect(reg.resolvePath("/user/review/SKILL.md")).toBeUndefined();
    expect(reg.resolvePath("/repo/.agents/skills/review/SKILL.md")).toBe(projectReview);
  });
});

describe("createSkillRegistrySnapshot", () => {
  beforeEach(() => vi.resetAllMocks());

  it("does not retain a user Skill removed between refreshes", async () => {
    mockedReaddir
      .mockResolvedValueOnce([
        { name: "temporary.md", isFile: () => true, isDirectory: () => false } as any,
      ])
      .mockResolvedValueOnce([]);
    mockedReadFile.mockResolvedValue("---\nname: temporary\ndescription: temporary\n---\nbody");

    const first = await createSkillRegistrySnapshot({ userDir: "/user-skills" });
    const second = await createSkillRegistrySnapshot({ userDir: "/user-skills" });

    expect(first.has("temporary")).toBe(true);
    expect(second.has("temporary")).toBe(false);
  });

  it("applies bundled < plugin < user < project precedence", async () => {
    mockedReaddir.mockImplementation(async (target) => {
      const value = String(target);
      if (value === "/user-skills" || value === "/project-skills") {
        return [{ name: "winner.md", isFile: () => true, isDirectory: () => false }] as any;
      }
      return [] as any;
    });
    mockedReadFile.mockImplementation(async (target) => {
      const description = String(target).includes("project-skills") ? "project" : "user";
      return `---\nname: winner\ndescription: ${description}\n---\n${description}`;
    });
    const base = makeSkill({ name: "winner", description: "bundled", source: "bundled" });
    const plugin = makeSkill({ name: "winner", description: "plugin", source: "plugin" });

    const registry = await createSkillRegistrySnapshot({
      bundled: [base],
      plugins: [plugin],
      userDir: "/user-skills",
      projectDirs: ["/project-skills"],
    });

    expect(registry.get("winner")?.description).toBe("project");
    expect(registry.get("winner")?.source).toBe("project");
  });

  it("loads standard user directories before the VK user directory", async () => {
    const standardA = path.resolve("/standard-a");
    const standardB = path.resolve("/standard-b");
    const personal = path.resolve("/personal");
    mockedReaddir.mockImplementation(async (target) => {
      const value = String(target);
      if ([standardA, standardB, personal].includes(value)) {
        return [{ name: "winner.md", isFile: () => true, isDirectory: () => false }] as any;
      }
      return [] as any;
    });
    mockedReadFile.mockImplementation(async (target) => {
      const value = String(target);
      const directory = value.includes("personal") ? "personal" : "standard";
      return `---\nname: winner\ndescription: ${directory}\n---\n${directory}`;
    });

    const registry = await createSkillRegistrySnapshot({
      bundled: false,
      userDirs: [standardA, standardA, standardB],
      userDir: personal,
    });

    expect(registry.get("winner")?.description).toBe("personal");
    expect(mockedReaddir.mock.calls.filter(([target]) => target === standardA)).toHaveLength(1);
  });
});

describe("standardUserSkillDirs", () => {
  it("returns both open Agent Skills global directories", () => {
    expect(standardUserSkillDirs(path.resolve("/home/dev"))).toEqual([
      path.join(path.resolve("/home/dev"), ".agents", "skills"),
      path.join(path.resolve("/home/dev"), ".config", "agents", "skills"),
    ]);
  });
});

describe("SkillRegistry.modelVisibleList", () => {
  it("maps to {name, description} and is sorted by name", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ name: "beta", description: "B desc" }));
    reg.register(makeSkill({ name: "alpha", description: "A desc" }));
    const list = reg.modelVisibleList();
    expect(list).toEqual([
      { name: "alpha", description: "A desc" },
      { name: "beta", description: "B desc" },
    ]);
  });

  it("excludes skills with disableModelInvocation=true", () => {
    const reg = new SkillRegistry();
    reg.register(makeSkill({ name: "visible", description: "v" }));
    reg.register(
      makeSkill({ name: "hidden", description: "h", disableModelInvocation: true }),
    );
    const list = reg.modelVisibleList();
    expect(list.map((s) => s.name)).toEqual(["visible"]);
  });

  it("includes userInvocable=false skills as long as model invocation is allowed", () => {
    const reg = new SkillRegistry();
    // user 不可调但模型可见：仍应出现在 model-visible 列表里
    reg.register(makeSkill({ name: "modelonly", description: "m", userInvocable: false }));
    expect(reg.modelVisibleList().map((s) => s.name)).toEqual(["modelonly"]);
  });

  it("returns empty list for an empty registry", () => {
    expect(new SkillRegistry().modelVisibleList()).toEqual([]);
  });
});

describe("parseSkillMarkdown", () => {
  it("extracts name from heading", () => {
    const result = parseSkillMarkdown("default", "# My Skill\n\nSome description here.");
    expect(result.name).toBe("My Skill");
    expect(result.description).toBe("Some description here.");
  });

  it("uses default name when no heading", () => {
    const result = parseSkillMarkdown("myfile", "Just some text without heading.");
    expect(result.name).toBe("myfile");
    expect(result.description).toBe("Just some text without heading.");
  });

  it("parses YAML frontmatter", () => {
    const md = "---\nname: Custom Name\ndescription: A custom skill\n---\n\n# Irrelevant\n\nBody text.";
    const result = parseSkillMarkdown("default", md);
    expect(result.name).toBe("Custom Name");
    expect(result.description).toBe("A custom skill");
  });

  it("parses CRLF YAML frontmatter", () => {
    const md = "---\r\nname: shadcn\r\ndescription: Manage shadcn components\r\nuser-invocable: false\r\n---\r\n\r\n# Body";
    const result = parseSkillMarkdown("default", md);
    expect(result.name).toBe("shadcn");
    expect(result.description).toBe("Manage shadcn components");
    expect(result.userInvocable).toBe(false);
  });

  it("parses folded multiline YAML descriptions", () => {
    const md = `---
name: agent-reach
description: >
  MUST USE when user wants to 调研/research/搜索/search/查/找/look up anything
  on the internet — e.g. 全网调研 X / 帮我调研一下 X / 查一下 X
user-invocable: true
---
# Agent Reach`;

    expect(parseSkillMarkdown("default", md).description).toBe(
      "MUST USE when user wants to 调研/research/搜索/search/查/找/look up anything on the internet — e.g. 全网调研 X / 帮我调研一下 X / 查一下 X",
    );
  });

  it("parses literal multiline YAML descriptions", () => {
    const md = `---
name: ai-radar
description: |
  雷达Skill（AI Radar）——零API、零Key、零服务器的中文AI资讯查询。
  触发条件：用户想知道今天 AI 圈有什么。
---
# AI Radar`;

    expect(parseSkillMarkdown("default", md).description).toBe(
      "雷达Skill（AI Radar）——零API、零Key、零服务器的中文AI资讯查询。\n触发条件：用户想知道今天 AI 圈有什么。",
    );
  });

  it("frontmatter with quoted values", () => {
    const md = '---\nname: "Quoted Name"\ndescription: \'Quoted desc\'\n---\n\nBody.';
    const result = parseSkillMarkdown("default", md);
    expect(result.name).toBe("Quoted Name");
    expect(result.description).toBe("Quoted desc");
  });

  it("falls back when frontmatter has no description", () => {
    const md = "---\nname: OnlyName\n---\n\n# OnlyName\n\nFirst paragraph after heading.";
    const result = parseSkillMarkdown("default", md);
    expect(result.name).toBe("OnlyName");
    expect(result.description).toBe("First paragraph after heading.");
  });

  it("generates fallback description", () => {
    const result = parseSkillMarkdown("myskill", "# myskill");
    expect(result.description).toBe("Skill: myskill");
  });

  it("truncates long description to 200 chars", () => {
    const longDesc = "x".repeat(300);
    const result = parseSkillMarkdown("default", `# title\n\n${longDesc}`);
    expect(result.description.length).toBe(200);
  });
});

describe("parseSkillMarkdown extended frontmatter", () => {
  it("defaults: userInvocable=true, disableModelInvocation=false, others undefined", () => {
    const r = parseSkillMarkdown("d", "# d\n\nbody");
    expect(r.userInvocable).toBe(true);
    expect(r.disableModelInvocation).toBe(false);
    expect(r.model).toBeUndefined();
    expect(r.argumentHint).toBeUndefined();
    expect(r.commandName).toBeUndefined();
    expect(r.displayName).toBeUndefined();
  });

  it("parses all extended fields (hyphen style)", () => {
    const md = [
      "---",
      "name: x",
      "description: a skill",
      "user-invocable: false",
      "disable-model-invocation: true",
      "model: claude-opus-4-8",
      "argument-hint: <file>",
      "command-name: xcmd",
      "display-name: The X",
      "---",
      "",
      "body",
    ].join("\n");
    const r = parseSkillMarkdown("default", md);
    expect(r.userInvocable).toBe(false);
    expect(r.disableModelInvocation).toBe(true);
    expect(r.model).toBe("claude-opus-4-8");
    expect(r.argumentHint).toBe("<file>");
    expect(r.commandName).toBe("xcmd");
    expect(r.displayName).toBe("The X");
  });

  it("tolerates underscore key style (user_invocable etc.)", () => {
    const md = [
      "---",
      "name: x",
      "description: d",
      "user_invocable: no",
      "disable_model_invocation: yes",
      "argument_hint: foo",
      "command_name: c",
      "display_name: D",
      "---",
      "body",
    ].join("\n");
    const r = parseSkillMarkdown("default", md);
    expect(r.userInvocable).toBe(false);
    expect(r.disableModelInvocation).toBe(true);
    expect(r.argumentHint).toBe("foo");
    expect(r.commandName).toBe("c");
    expect(r.displayName).toBe("D");
  });

  it("boolean parsing covers true/1/yes/on and false/0/no/off", () => {
    const cases: Array<[string, boolean]> = [
      ["true", true], ["1", true], ["yes", true], ["on", true],
      ["TRUE", true], ["Yes", true],
      ["false", false], ["0", false], ["no", false], ["off", false],
      ["FALSE", false], ["No", false],
    ];
    for (const [raw, expected] of cases) {
      const md = `---\nname: x\ndescription: d\nuser-invocable: ${raw}\n---\nbody`;
      expect(parseSkillMarkdown("default", md).userInvocable).toBe(expected);
    }
  });

  it("falls back to defaults on unrecognized boolean value", () => {
    const md = "---\nname: x\ndescription: d\nuser-invocable: maybe\n---\nbody";
    expect(parseSkillMarkdown("default", md).userInvocable).toBe(true);
  });
});

describe("BUNDLED_SKILLS", () => {
  it("is non-empty", () => {
    expect(BUNDLED_SKILLS.length).toBeGreaterThan(0);
  });

  it("contains the bundled skills including create-skill", () => {
    const names = BUNDLED_SKILLS.map((s) => s.name).sort();
    expect(names).toEqual(["commit", "create-skill", "debug", "plan", "review", "test"]);
  });

  it("create-skill tells the model where to write local skills", () => {
    const skill = BUNDLED_SKILLS.find((s) => s.name === "create-skill");
    expect(skill).toBeDefined();
    expect(skill!.description.toLowerCase()).toMatch(/install|create|write/);
    expect(skill!.content).toContain("~/.vykor/skills/");
    expect(skill!.content).toContain(".vykor/skills/");
  });

  it("every bundled skill has valid fields", () => {
    for (const s of BUNDLED_SKILLS) {
      expect(s.name).toBeTruthy();
      expect(s.description).toBeTruthy();
      expect(s.content.trim().length).toBeGreaterThan(0);
      expect(s.source).toBe("bundled");
      expect(s.userInvocable).toBe(true);
      expect(s.disableModelInvocation).toBe(false);
    }
  });
});

describe("SkillRegistry.registerBundled + source priority", () => {
  it("registerBundled registers every bundled skill", () => {
    const reg = new SkillRegistry();
    reg.registerBundled();
    for (const s of BUNDLED_SKILLS) {
      expect(reg.has(s.name)).toBe(true);
    }
    expect(reg.modelVisibleList()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "create-skill",
          description: expect.stringMatching(/~\/\.vykor\/skills/),
        }),
      ]),
    );
  });

  it("user overrides bundled, project overrides user (last-writer-wins)", () => {
    const reg = new SkillRegistry();
    // bundled first
    reg.registerBundled();
    expect(reg.get("commit")!.source).toBe("bundled");
    // user wins over bundled
    reg.register(makeSkill({ name: "commit", description: "user", source: "user", content: "u" }));
    expect(reg.get("commit")!.source).toBe("user");
    // project wins over user
    reg.register(makeSkill({ name: "commit", description: "project", source: "project", content: "p" }));
    expect(reg.get("commit")!.source).toBe("project");
    expect(reg.get("commit")!.content).toBe("p");
  });
});

describe("SkillLoader", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("loads a single markdown file", async () => {
    mockedReadFile.mockResolvedValue("# Test Skill\n\nA test description.");
    const reg = new SkillRegistry();
    const loader = new SkillLoader(reg);
    const skill = await loader.loadFromMarkdown("/skills/test.md");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("Test Skill");
    expect(skill!.description).toBe("A test description.");
    expect(reg.has("Test Skill")).toBe(true);
  });

  it("marks loaded markdown with the provided source", async () => {
    mockedReadFile.mockResolvedValue("# User Skill\n\nA user skill.");
    const reg = new SkillRegistry();
    const loader = new SkillLoader(reg);
    const skill = await loader.loadFromMarkdown("/skills/user.md", { source: "user" });
    expect(skill!.source).toBe("user");
    expect(reg.get("User Skill")!.source).toBe("user");
  });

  it("returns undefined for unreadable file", async () => {
    mockedReadFile.mockRejectedValue(new Error("not found"));
    const reg = new SkillRegistry();
    const loader = new SkillLoader(reg);
    const skill = await loader.loadFromMarkdown("/skills/missing.md");
    expect(skill).toBeUndefined();
  });

  it("uses filename as default name when no heading", async () => {
    mockedReadFile.mockResolvedValue("Just some content without a heading.");
    const reg = new SkillRegistry();
    const loader = new SkillLoader(reg);
    const skill = await loader.loadFromMarkdown("/skills/myutil.md");
    expect(skill!.name).toBe("myutil");
  });

  it("loads all skills from a directory", async () => {
    mockedReaddir.mockResolvedValue([
      { name: "alpha.md", isFile: () => true, isDirectory: () => false } as any,
      { name: "beta.md", isFile: () => true, isDirectory: () => false } as any,
      { name: "notes.txt", isFile: () => true, isDirectory: () => false } as any,
    ]);
    mockedReadFile
      .mockResolvedValueOnce("# Alpha\n\nAlpha skill")
      .mockResolvedValueOnce("# Beta\n\nBeta skill");
    const reg = new SkillRegistry();
    const loader = new SkillLoader(reg);
    const skills = await loader.loadFromDirectory("/skills", { source: "project" });
    expect(skills).toHaveLength(2);
    expect(skills.map((s) => s.source)).toEqual(["project", "project"]);
    expect(reg.has("Alpha")).toBe(true);
    expect(reg.has("Beta")).toBe(true);
  });

  it("returns empty for non-existent directory", async () => {
    mockedReaddir.mockRejectedValue(new Error("not found"));
    const reg = new SkillRegistry();
    const loader = new SkillLoader(reg);
    const skills = await loader.loadFromDirectory("/nope");
    expect(skills).toHaveLength(0);
  });

  it("recursive discovery loads directory skills from SKILL.md", async () => {
    mockedReaddir
      .mockResolvedValueOnce([
        { name: "my-skill", isFile: () => false, isDirectory: () => true } as any,
      ])
      .mockResolvedValueOnce([
        { name: "SKILL.md", isFile: () => true, isDirectory: () => false } as any,
        { name: "notes.md", isFile: () => true, isDirectory: () => false } as any,
      ]);
    mockedReadFile.mockResolvedValue("Directory skill body.");
    const reg = new SkillRegistry();
    const loader = new SkillLoader(reg);
    const skills = await loader.loadFromDirectory("/skills", true);
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("my-skill");
    expect(reg.has("my-skill")).toBe(true);
    expect(reg.has("notes")).toBe(false);
  });
});

// M-12: 路径穿越防护测试
// discoverMarkdownFiles 有两层防护：
//   1. resolve + sep 检查：过滤名称中带 ".." 的条目（路径字符串逃逸）。
//   2. entry.isFile() / isDirectory()：Node.js 以 withFileTypes 模式 readdir 时，
//      symlink 的 Dirent 两个方法均返回 false，自然跳过——包括 Windows 跨盘符 symlink。
describe("SkillLoader.discoverMarkdownFiles path-traversal protection", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("symlink entries (isFile=false, isDirectory=false) are silently skipped", async () => {
    // Node.js readdir({ withFileTypes: true }) 对 symlink 返回 isFile()=false,
    // isDirectory()=false（不解引用），所以 symlink——包括 Windows 跨盘符 symlink——
    // 在第二层检查（isFile）前就已被自然排除。
    mockedReaddir.mockResolvedValue([
      { name: "legit.md", isFile: () => true, isDirectory: () => false } as any,
      { name: "evil-link", isFile: () => false, isDirectory: () => false } as any, // symlink
    ]);
    mockedReadFile.mockResolvedValue("# Legit\n\nOK skill");

    const reg = new SkillRegistry();
    const loader = new SkillLoader(reg);
    const skills = await loader.loadFromDirectory("/skills");
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("Legit");
  });

  it("symlink-to-directory (isDirectory=false) is not recursed into", async () => {
    // symlink 指向目录时，Dirent.isDirectory() 仍为 false，不会被递归扫描。
    // Windows 跨盘符 symlink 目录 (D: → C:) 触发同样路径。
    mockedReaddir.mockResolvedValueOnce([
      { name: "real-sub", isFile: () => false, isDirectory: () => true } as any,
      { name: "evil-dir-link", isFile: () => false, isDirectory: () => false } as any, // symlink to dir
    ]);
    mockedReaddir.mockResolvedValueOnce([
      { name: "SKILL.md", isFile: () => true, isDirectory: () => false } as any,
    ]);
    mockedReadFile.mockResolvedValue("# Nested\n\nNested skill");

    const reg = new SkillRegistry();
    const loader = new SkillLoader(reg);
    const skills = await loader.loadFromDirectory("/skills", true);
    // 只有 real-sub/SKILL.md 被加载；evil-dir-link 被忽略
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("Nested");
  });

  it("resolve+sep guard: entry whose path resolves outside root is filtered", async () => {
    // 第一层防护：路径字符串含 ".." 时，resolve 解析后不以 resolvedDir+sep 开头，
    // 在到达 isFile() 检查前即被跳过。
    // Windows 场景等价：若 resolve 得到不同盘符前缀（如 C:\\），startsWith("D:\\skills\\") 为 false。
    const outsideName = path.join("..", "escape.md"); // resolves to /escape.md, not /skills/...
    mockedReaddir.mockResolvedValue([
      { name: "good.md", isFile: () => true, isDirectory: () => false } as any,
      { name: outsideName, isFile: () => true, isDirectory: () => false } as any,
    ]);
    mockedReadFile.mockResolvedValueOnce("# Good\n\nGood skill");

    const reg = new SkillRegistry();
    const loader = new SkillLoader(reg);
    const skills = await loader.loadFromDirectory("/skills");
    expect(skills).toHaveLength(1);
    expect(skills[0].name).toBe("Good");
  });
});

describe("findProjectSkillDirs", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    delete process.env.VYKOR_CONFIG_DIR;
  });

  it("collects only .agents and .vykor skill dirs from git root to cwd", async () => {
    mockedStat.mockImplementation(async (target) => {
      if (String(target).endsWith(path.join("repo", ".git"))) return {} as any;
      throw new Error("not found");
    });

    const cwd = path.resolve("/repo/packages/app");
    const dirs = await findProjectSkillDirs(cwd);

    expect(dirs).toEqual([
      path.join(path.resolve("/repo"), ".agents", "skills"),
      path.join(path.resolve("/repo"), ".vykor", "skills"),
      path.join(path.resolve("/repo/packages"), ".agents", "skills"),
      path.join(path.resolve("/repo/packages"), ".vykor", "skills"),
      path.join(path.resolve("/repo/packages/app"), ".agents", "skills"),
      path.join(path.resolve("/repo/packages/app"), ".vykor", "skills"),
    ]);
  });

  it("does not walk past cwd when there is no git root", async () => {
    mockedStat.mockRejectedValue(new Error("not found"));

    const cwd = path.resolve("/home/user/notes");
    const dirs = await findProjectSkillDirs(cwd);

    expect(dirs).toEqual([
      path.join(cwd, ".agents", "skills"),
      path.join(cwd, ".vykor", "skills"),
    ]);
    expect(dirs.some((dir) => dir.includes(path.join("home", "user", ".vykor")))).toBe(
      false,
    );
  });

  it("excludes the personal skills directory even when home is the git root", async () => {
    const home = path.resolve("/home/user");
    process.env.VYKOR_CONFIG_DIR = path.join(home, ".vykor");
    mockedHomedir.mockReturnValue(home);
    mockedStat.mockImplementation(async (target) => {
      if (String(target) === path.join(home, ".git")) return {} as any;
      throw new Error("not found");
    });

    const dirs = await findProjectSkillDirs(home);

    expect(dirs).not.toContain(path.join(home, ".vykor", "skills"));
    expect(dirs).not.toContain(path.join(home, ".claude", "skills"));
    expect(dirs).not.toContain(path.join(home, ".agents", "skills"));
    expect(dirs).not.toContain(path.join(home, ".config", "agents", "skills"));
    expect(dirs).toEqual([]);
  });
});
