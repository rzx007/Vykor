import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import { CommandRegistry } from "@vykor/commands";
import { SkillRegistry, type SkillDefinition } from "@vykor/skills";
import {
  buildSlashCommandList,
  buildSlashCommandDetails,
  matchUserInvocableSkill,
  buildSkillPrompt,
  buildUserContentWithAttachments,
  resolveMainEntryMode,
} from "./main";

/** 构造一个最小 SkillDefinition（补齐新增必填字段的默认值）。 */
function makeSkill(partial: Partial<SkillDefinition> & { name: string }): SkillDefinition {
  return {
    description: `desc-${partial.name}`,
    content: `# ${partial.name}\nbody`,
    path: "",
    userInvocable: true,
    disableModelInvocation: false,
    ...partial,
  };
}

function makeSkillRegistry(skills: SkillDefinition[]): SkillRegistry {
  const reg = new SkillRegistry();
  for (const s of skills) reg.register(s);
  return reg;
}

function makeRegistry(): CommandRegistry {
  const reg = new CommandRegistry();
  reg.register({
    name: "/help",
    description: "help",
    handler: async () => ({ success: true, output: "HELP TEXT" }),
  });
  reg.register({
    name: "/exit",
    description: "exit",
    handler: async () => ({ success: true, output: "__EXIT__" }),
  });
  reg.register({
    name: "/clear",
    description: "clear",
    handler: async () => ({ success: true, output: "cleared" }),
  });
  reg.register({
    name: "/new",
    description: "new conversation",
    handler: async () => ({ success: true, output: "new conversation" }),
  });
  return reg;
}

describe("resolveMainEntryMode", () => {
  it("defaults to tui when there is no prompt", () => {
    expect(resolveMainEntryMode(undefined, {})).toBe("tui");
    expect(resolveMainEntryMode(undefined, { tui: true })).toBe("tui");
  });

  it("routes prompts and --print to print mode", () => {
    expect(resolveMainEntryMode("hello", {})).toBe("print");
    expect(resolveMainEntryMode("hello", { print: true })).toBe("print");
  });

  it("keeps dry-run ahead of tui/print", () => {
    expect(resolveMainEntryMode(undefined, { dryRun: true })).toBe("dry-run");
    expect(resolveMainEntryMode("x", { tui: true })).toBe("tui");
  });
});

describe("buildSlashCommandList", () => {
  it("keeps the single leading slash from registered names (no //help)", () => {
    const list = buildSlashCommandList(makeRegistry());
    expect(list).toContain("/help");
    expect(list.every((n) => !n.startsWith("//"))).toBe(true);
  });
});

describe("buildSlashCommandDetails", () => {
  it("returns name + description pairs for registered commands", () => {
    const details = buildSlashCommandDetails(makeRegistry());
    const help = details.find((d) => d.name === "/help");
    expect(help).toEqual({ name: "/help", description: "help" });
    const newCmd = details.find((d) => d.name === "/new");
    expect(newCmd?.description).toBe("new conversation");
  });
});

const isBuiltin = (reg: CommandRegistry) => (name: string) => reg.get(name) !== undefined;

describe("matchUserInvocableSkill", () => {
  it("matches a user-invocable skill by /<name> and returns args", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "commit" })]);
    const cmds = makeRegistry();
    const m = matchUserInvocableSkill("/commit fix the parser bug", skills, isBuiltin(cmds));
    expect(m).not.toBeNull();
    expect(m!.skill.name).toBe("commit");
    expect(m!.args).toBe("fix the parser bug");
  });

  it("matches with no args (empty args string)", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "review" })]);
    const cmds = makeRegistry();
    const m = matchUserInvocableSkill("/review", skills, isBuiltin(cmds));
    expect(m).not.toBeNull();
    expect(m!.args).toBe("");
  });

  it("does not override a builtin command (builtin wins, e.g. /help)", () => {
    // 注册一个与内置命令同名的 skill，仍应不命中（内置优先）。
    const skills = makeSkillRegistry([makeSkill({ name: "help" })]);
    const cmds = makeRegistry(); // contains /help
    const m = matchUserInvocableSkill("/help", skills, isBuiltin(cmds));
    expect(m).toBeNull();
  });

  it("does not match a non-user-invocable skill", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "secret", userInvocable: false })]);
    const cmds = makeRegistry();
    const m = matchUserInvocableSkill("/secret", skills, isBuiltin(cmds));
    expect(m).toBeNull();
  });

  it("returns null for unknown skill names", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "commit" })]);
    const cmds = makeRegistry();
    expect(matchUserInvocableSkill("/nope", skills, isBuiltin(cmds))).toBeNull();
  });

  it("matches by commandName when set", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "do-thing", commandName: "dt" })]);
    const cmds = makeRegistry();
    const m = matchUserInvocableSkill("/dt args", skills, isBuiltin(cmds));
    expect(m).not.toBeNull();
    expect(m!.skill.name).toBe("do-thing");
    expect(m!.args).toBe("args");
  });

  it("returns null for non-slash input", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "commit" })]);
    const cmds = makeRegistry();
    expect(matchUserInvocableSkill("commit", skills, isBuiltin(cmds))).toBeNull();
  });
});

describe("buildSkillPrompt", () => {
  it("uses skill.content and appends args when present", () => {
    const skill = makeSkill({ name: "commit", content: "# commit\nDo the commit thing." });
    const prompt = buildSkillPrompt(skill, "scope=auth");
    expect(prompt).toContain("Do the commit thing.");
    expect(prompt).toContain("## Arguments");
    expect(prompt).toContain("scope=auth");
  });

  it("returns skill.content unchanged when args is empty", () => {
    const skill = makeSkill({ name: "commit", content: "# commit\nbody" });
    const prompt = buildSkillPrompt(skill, "");
    expect(prompt).toBe("# commit\nbody");
    expect(prompt).not.toContain("## Arguments");
  });
});

describe("buildSlashCommandList with skills", () => {
  it("appends /<name> for user-invocable skills (incl. disableModelInvocation)", () => {
    const skills = makeSkillRegistry([
      makeSkill({ name: "commit" }),
      makeSkill({ name: "stealth", disableModelInvocation: true }),
    ]);
    const list = buildSlashCommandList(makeRegistry(), skills);
    expect(list).toContain("/commit");
    // disableModelInvocation 只挡模型不挡用户：命令列表仍含它。
    expect(list).toContain("/stealth");
  });

  it("does not duplicate builtin command names (builtin wins)", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "help" })]);
    const list = buildSlashCommandList(makeRegistry(), skills);
    expect(list.filter((n) => n === "/help")).toHaveLength(1);
  });

  it("omits non-user-invocable skills", () => {
    const skills = makeSkillRegistry([makeSkill({ name: "secret", userInvocable: false })]);
    const list = buildSlashCommandList(makeRegistry(), skills);
    expect(list).not.toContain("/secret");
  });

  it("returns only registry commands when no skillRegistry passed", () => {
    const list = buildSlashCommandList(makeRegistry());
    expect(list).toContain("/help");
    expect(list).not.toContain("/commit");
  });
});

describe("buildUserContentWithAttachments", () => {
  it("builds multimodal user content from image attachments", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-attachment-"));
    const previousCacheDir = process.env.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR;
    try {
      process.env.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR = join(dir, "cache");
      const imagePath = join(dir, "shot.png");
      await writeFile(imagePath, Buffer.from([1, 2, 3, 4]));

      const content = await buildUserContentWithAttachments("what is this?", [
        { type: "image", path: imagePath },
      ]);

      expect(Array.isArray(content)).toBe(true);
      const blocks = content as any[];
      expect(blocks[0]).toEqual({ type: "text", text: "what is this?" });
      expect(blocks[1]).toMatchObject({
        type: "image",
        source: { type: "file", mediaType: "image/png", sizeBytes: 4 },
      });
      expect("data" in blocks[1].source).toBe(false);
      expect(await readFile(blocks[1].source.path)).toEqual(Buffer.from([1, 2, 3, 4]));
    } finally {
      if (previousCacheDir === undefined) {
        delete process.env.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR;
      } else {
        process.env.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR = previousCacheDir;
      }
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("rejects unsupported image attachment extensions", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-attachment-"));
    try {
      const imagePath = join(dir, "vector.svg");
      await writeFile(imagePath, "<svg />");

      await expect(buildUserContentWithAttachments("look", [
        { type: "image", path: imagePath },
      ])).rejects.toThrow("Unsupported image attachment extension");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts source images above 5 MB so the provider can prepare them", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-attachment-"));
    const previousCacheDir = process.env.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR;
    const previousLimit = process.env.VYKOR_MAX_IMAGE_BYTES;
    try {
      process.env.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR = join(dir, "cache");
      delete process.env.VYKOR_MAX_IMAGE_BYTES;
      const imagePath = join(dir, "large.png");
      await writeFile(imagePath, Buffer.alloc(5_000_001));

      const content = await buildUserContentWithAttachments("compress this", [
        { type: "image", path: imagePath },
      ]) as any[];

      expect(content[1].source).toMatchObject({
        type: "file",
        mediaType: "image/png",
        sizeBytes: 5_000_001,
      });
      expect(content[1].source.prepared).toBeUndefined();
    } finally {
      if (previousCacheDir === undefined) delete process.env.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR;
      else process.env.VYKOR_IMAGE_ATTACHMENT_CACHE_DIR = previousCacheDir;
      if (previousLimit === undefined) delete process.env.VYKOR_MAX_IMAGE_BYTES;
      else process.env.VYKOR_MAX_IMAGE_BYTES = previousLimit;
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });

  it("rejects source images above the 20 MiB preparation guard", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-attachment-"));
    const previousLimit = process.env.VYKOR_MAX_IMAGE_BYTES;
    try {
      delete process.env.VYKOR_MAX_IMAGE_BYTES;
      const imagePath = join(dir, "too-large.png");
      await writeFile(imagePath, Buffer.alloc(20 * 1024 * 1024 + 1));

      await expect(buildUserContentWithAttachments("too large", [
        { type: "image", path: imagePath },
      ])).rejects.toThrow(`max ${20 * 1024 * 1024} bytes`);
    } finally {
      if (previousLimit === undefined) delete process.env.VYKOR_MAX_IMAGE_BYTES;
      else process.env.VYKOR_MAX_IMAGE_BYTES = previousLimit;
      await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
    }
  });
});
