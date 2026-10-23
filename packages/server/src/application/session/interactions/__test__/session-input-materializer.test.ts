import { describe, expect, it } from "vitest";

import {
  materializeSessionInput,
  applyMaterializedSessionInput,
  type SessionInputSkillCatalog,
} from "../session-input-materializer.js";

const catalog: SessionInputSkillCatalog = {
  resolvePath(path) {
    return {
      "/skills/super/SKILL.md": { name: "using-superpowers", path, displayName: "Using Superpowers" },
      "/skills/plan/SKILL.md": { name: "writing-plans", path, displayName: "Writing Plans" },
    }[path];
  },
};

describe("materializeSessionInput", () => {
  it("routes a selected plugin agent through the root Agent tool and preserves attachments", () => {
    const materialized = materializeSessionInput([
      { type: "capability", kind: "plugin_agent", pluginId: "plugin", agentId: "plugin:review", displayName: "Review" },
      { type: "text", text: "Review this" },
    ], catalog);
    expect(materialized.instruction).toContain('"subagentType":"plugin:review"');
    expect(materialized.instruction).toContain("Agent");
    expect(materialized.instruction).toContain("JobWait");
    const image = { type: "image" as const, source: { type: "base64" as const, media_type: "image/png", data: "a" } };
    const applied = applyMaterializedSessionInput([image], materialized);
    expect(applied).toEqual([{ type: "text", text: expect.stringContaining("Agent") }, image]);
  });
  it("does not wrap ordinary input in a Skill instruction", () => {
    expect(materializeSessionInput([{ type: "text", text: "plain follow up" }], catalog).instruction)
      .toBe("plain follow up");
  });
  it("keeps readable markers and emits one ordered skill loading instruction", () => {
    const result = materializeSessionInput([
      { type: "text", text: "使用 " },
      { type: "skill", name: "using-superpowers", path: "/skills/super/SKILL.md" },
      { type: "text", text: " 写计划 " },
      { type: "skill", name: "writing-plans", path: "/skills/plan/SKILL.md" },
    ], catalog);

    expect(result.text).toBe("使用 $using-superpowers 写计划 $writing-plans");
    expect(result.skills.map((skill) => skill.path)).toEqual([
      "/skills/super/SKILL.md",
      "/skills/plan/SKILL.md",
    ]);
    expect(result.instruction).toBe(
      "用户显式选择了以下技能，请按出现顺序使用 Skill 工具的 { name, path } 加载并遵循：\n" +
        "1. using-superpowers (path: /skills/super/SKILL.md)\n" +
        "2. writing-plans (path: /skills/plan/SKILL.md)\n\n" +
        "用户输入：\n使用 $using-superpowers 写计划 $writing-plans",
    );
  });

  it("loads duplicate skill paths once while retaining readable input markers", () => {
    const result = materializeSessionInput([
      { type: "skill", name: "using-superpowers", path: "/skills/super/SKILL.md" },
      { type: "text", text: " 然后 " },
      { type: "skill", name: "using-superpowers", path: "/skills/super/SKILL.md" },
    ], catalog);

    expect(result.text).toBe("$using-superpowers 然后 $using-superpowers");
    expect(result.skills).toHaveLength(1);
  });

  it("rejects a selected name that no longer matches its catalog path", () => {
    expect(() => materializeSessionInput([
      { type: "skill", name: "writing-plans", path: "/skills/super/SKILL.md" },
    ], catalog)).toThrowError("session_input_skill_catalog_mismatch");
  });

  it("accepts a skill-only input", () => {
    expect(materializeSessionInput([
      { type: "skill", name: "writing-plans", path: "/skills/plan/SKILL.md" },
    ], catalog).text).toBe("$writing-plans");
  });

  it("materializes a bounded conversation reference", () => {
    const result = materializeSessionInput([
      { type: "context", kind: "conversation", id: "s2", displayName: "登录问题" },
      { type: "text", text: "继续处理" },
    ], catalog, {
      resolveConversation: (id) => id === "s2"
        ? { id, title: "登录问题", summary: "用户：登录失败\n助手：检查令牌" }
        : undefined,
    });
    expect(result.instruction).toContain("用户引用了以下历史对话作为只读参考上下文")
    expect(result.instruction).toContain("用户：登录失败")
    expect(result.text).toBe("@登录问题继续处理")
  });

  it("rejects a missing conversation reference", () => {
    expect(() => materializeSessionInput([
      { type: "context", kind: "conversation", id: "missing", displayName: "已删除会话" },
    ], catalog, { resolveConversation: () => undefined }))
      .toThrowError("session_input_conversation_not_found");
  });
});
