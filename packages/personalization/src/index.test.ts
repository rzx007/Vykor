import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  extractFactsFromText,
  factsToRulesMarkdown,
  loadFacts,
  saveFacts,
  mergeFacts,
  loadLocalRules,
  saveLocalRules,
  getLocalRulesDir,
  updateRulesFromSession,
} from "./index.js";

// 经 VYKOR_CONFIG_DIR 指向临时目录（仓库既有约定）：完全不碰真实
// ~/.vykor，崩溃也不会伤用户数据。
let cfgDir: string;
let dir: string;
let projectDir: string;

beforeEach(() => {
  cfgDir = mkdtempSync(join(tmpdir(), "vk-pers-"));
  process.env.VYKOR_CONFIG_DIR = cfgDir;
  projectDir = join(cfgDir, "project");
  dir = getLocalRulesDir(projectDir);
});

afterEach(() => {
  delete process.env.VYKOR_CONFIG_DIR;
  rmSync(cfgDir, { recursive: true, force: true });
});

describe("extractFactsFromText", () => {
  it("extracts all ten fact types", () => {
    const text = [
      "ssh deploy@10.0.0.5",
      "the server is at 192.168.1.100",
      "data lives in /mnt/data/landing/2026",
      "conda activate ml-env",
      "requires Python 3.11.2",
      "POST https://api.example.com/v2/ with the token",
      "export OPENAI_API_KEY=sk-xxx",
      "clone from github.com/acme/widgets.git",
      "ray start --address 10.0.0.9:6379",
      "0 3 * * * /usr/local/bin/backup.sh",
    ].join("\n");
    const facts = extractFactsFromText(text);
    const types = new Set(facts.map((f) => f.type));
    for (const t of [
      "ssh_host", "ip_address", "data_path", "conda_env", "python_env",
      "api_endpoint", "env_var", "git_remote", "ray_cluster", "cron_schedule",
    ]) {
      expect(types.has(t), `missing ${t}`).toBe(true);
    }
    expect(facts.find((f) => f.type === "ssh_host")!.value).toBe("deploy@10.0.0.5");
    expect(facts.find((f) => f.type === "env_var")!.value).toBe("OPENAI_API_KEY");
    expect(facts.find((f) => f.type === "git_remote")!.value).toBe("acme/widgets");
    expect(facts.every((f) => f.confidence === 0.7)).toBe(true);
  });

  it("filters IP false positives and dedupes by key", () => {
    const facts = extractFactsFromText("ping 127.0.0.1 and 0.0.0.0 and 255.255.255.0 and 10.1.1.1 and 10.1.1.1");
    const ips = facts.filter((f) => f.type === "ip_address").map((f) => f.value);
    expect(ips).toEqual(["10.1.1.1"]);
  });

  it("strips trailing punctuation and drops too-short values", () => {
    const facts = extractFactsFromText("server at 10.2.3.4."); // 尾部句号
    expect(facts.find((f) => f.type === "ip_address")!.value).toBe("10.2.3.4");
  });
});

describe("factsToRulesMarkdown", () => {
  it("groups facts by type with section titles", () => {
    const md = factsToRulesMarkdown([
      { key: "ssh_host:a@b", type: "ssh_host", label: "SSH connection", value: "a@b.example", confidence: 0.7 },
      { key: "conda_env:ml", type: "conda_env", label: "Conda environment", value: "ml", confidence: 0.7 },
    ]);
    expect(md).toContain("# Local Environment Rules");
    expect(md).toContain("## SSH Hosts");
    expect(md).toContain("## Python Environments");
    expect(md).toContain("- `a@b.example`");
  });

  it("returns empty string for no facts", () => {
    expect(factsToRulesMarkdown([])).toBe("");
  });
});

describe("rules persistence", () => {
  it("rejects project facts without a durable source on both read and write", () => {
    const unsourced = { key: "ip_address:10.9.9.9", type: "ip_address", label: "Server IP", value: "10.9.9.9", confidence: 0.7 };
    expect(() => saveFacts({ facts: [unsourced] }, projectDir)).toThrow("Project facts require valid records");

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "facts.json"), JSON.stringify({ facts: [unsourced] }), "utf-8");
    expect(() => loadFacts(projectDir)).toThrow("Project facts file is unreadable");
    expect(loadLocalRules(projectDir)).toBe("");
  });

  it("rejects sourced project facts with missing values", () => {
    const invalid = {
      key: "ip_address:missing", type: "ip_address", label: "Server IP", confidence: 0.7,
      sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2026-09-24T00:00:00.000Z",
    };
    expect(() => saveFacts({ facts: [invalid as never] }, projectDir)).toThrow("Project facts require valid records");

    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "facts.json"), JSON.stringify({ facts: [invalid] }), "utf-8");
    expect(() => loadFacts(projectDir)).toThrow("Project facts file is unreadable");
  });

  it("does not overwrite an unreadable facts file during a later extraction", () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "facts.json");
    writeFileSync(path, "{incomplete-json", "utf-8");

    expect(loadLocalRules(projectDir)).toBe("");
    expect(() => updateRulesFromSession([
      { id: "u-new", createdAt: 1, role: "user", content: "ssh ops@10.1.2.3" },
    ], projectDir, "s1")).toThrow("Project facts file is unreadable");
    expect(readFileSync(path, "utf-8")).toBe("{incomplete-json");
  });

  it("rejects a facts file whose facts property is not an array", () => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "facts.json"), '{"facts":{}}', "utf-8");

    expect(() => loadFacts(projectDir)).toThrow("Project facts file is unreadable");
    expect(loadLocalRules(projectDir)).toBe("");
  });

  it("renders stored facts instead of cached rules text", () => {
    saveFacts({ facts: [
      { key: "ip_address:10.1.2.3", type: "ip_address", label: "Server IP", value: "10.1.2.3", confidence: 0.7,
        sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2026-09-24T00:00:00.000Z" },
    ] }, projectDir);
    saveLocalRules("# Local Environment Rules\n- `10.9.9.9`", projectDir);

    expect(loadLocalRules(projectDir)).toContain("10.1.2.3");
    expect(loadLocalRules(projectDir)).not.toContain("10.9.9.9");
  });

  it("does not treat blank source identifiers as provenance", () => {
    const invalid = {
      key: "ip_address:10.8.8.8", type: "ip_address", label: "Server IP", value: "10.8.8.8", confidence: 0.7,
      sourceSessionId: " ", sourceMessageId: "u1", observedAt: "2026-09-24T00:00:00.000Z",
    };
    expect(() => saveFacts({ facts: [invalid] }, projectDir)).toThrow("Project facts require valid records");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "facts.json"), JSON.stringify({ facts: [invalid] }), "utf-8");

    expect(() => loadFacts(projectDir)).toThrow("Project facts file is unreadable");
    expect(loadLocalRules(projectDir)).toBe("");
  });

  it("does not inject previously stored credential-like facts with provenance", () => {
    saveFacts({ facts: [{
      key: "ssh_host:ops@sk-examplelongtoken123", type: "ssh_host", label: "SSH connection",
      value: "ops@sk-examplelongtoken123", confidence: 0.7,
      sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2026-09-24T00:00:00.000Z",
    }] }, projectDir);

    expect(loadLocalRules(projectDir)).toBe("");
    expect(loadFacts(projectDir).facts).toHaveLength(1);
  });

  it("persists rules.md and facts.json without trusting a stale cache", () => {
    expect(loadLocalRules(projectDir)).toBe("");
    saveLocalRules("# Rules\n- x", projectDir);
    expect(readFileSync(join(dir, "rules.md"), "utf-8")).toBe("# Rules\n- x\n");
    expect(loadLocalRules(projectDir)).toBe("");

    expect(loadFacts(projectDir)).toEqual({ facts: [], last_updated: null });
    saveFacts({ facts: [{ key: "k", type: "t", label: "l", value: "v", confidence: 0.7,
      sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2026-09-24T00:00:00.000Z" }] }, projectDir);
    const loaded = loadFacts(projectDir);
    expect(loaded.facts).toHaveLength(1);
    expect(typeof loaded.last_updated).toBe("string");
    expect(getLocalRulesDir(projectDir)).toBe(dir);
  });

  it("mergeFacts dedupes by key, higher confidence wins", () => {
    const merged = mergeFacts(
      { facts: [
        { key: "a", type: "t", label: "l", value: "old", confidence: 0.9 },
        { key: "b", type: "t", label: "l", value: "keep", confidence: 0.7 },
      ] },
      [
        { key: "a", type: "t", label: "l", value: "low", confidence: 0.5 }, // 低置信不覆盖
        { key: "c", type: "t", label: "l", value: "new", confidence: 0.7 },
      ],
    );
    const byKey = Object.fromEntries(merged.facts.map((f) => [f.key, f.value]));
    expect(byKey).toEqual({ a: "old", b: "keep", c: "new" });
  });
});

describe("updateRulesFromSession", () => {
  it("does not persist credential-like environment fact values", () => {
    expect(updateRulesFromSession([
      { id: "u-secret", createdAt: 1, role: "user", content: "ssh ops@sk-examplelongtoken123" },
    ], projectDir, "s-secret")).toBe(0);
    expect(loadFacts(projectDir).facts).toEqual([]);
  });

  it("records user fact provenance without promoting assistant guesses or refreshing old observations", () => {
    const messages = [
      { id: "u1", createdAt: Date.parse("2026-09-24T00:00:00.000Z"), role: "user", content: "ssh ops@10.1.2.3" },
      { id: "a1", createdAt: Date.parse("2026-09-24T00:00:01.000Z"), role: "assistant", content: "ssh ops@10.9.9.9" },
    ];

    expect(updateRulesFromSession(messages, projectDir, "s1")).toBe(2);
    const first = loadFacts(projectDir).facts;
    expect(first).toHaveLength(2);
    expect(first.every((fact) => fact.sourceSessionId === "s1" && fact.sourceMessageId === "u1")).toBe(true);
    expect(first.every((fact) => fact.observedAt === "2026-09-24T00:00:00.000Z")).toBe(true);
    expect(first.some((fact) => fact.value.includes("10.9.9.9"))).toBe(false);

    expect(updateRulesFromSession(messages, projectDir, "s1")).toBe(0);
    expect(loadFacts(projectDir).facts).toEqual(first);
  });

  it("keeps environment facts within their project", () => {
    const projectA = join(cfgDir, "project-a");
    const projectB = join(cfgDir, "project-b");

    expect(loadLocalRules(projectA)).toBe("");
    expect(updateRulesFromSession([{ id: "u-project-a", createdAt: 1, role: "user", content: "ssh ops@10.1.2.3" }], projectA, "s-project-a")).toBe(2);
    expect(loadLocalRules(projectA)).toContain("10.1.2.3");
    expect(loadLocalRules(projectB)).toBe("");
    expect(loadFacts(projectB).facts).toEqual([]);
    expect(getLocalRulesDir(projectA)).not.toBe(getLocalRulesDir(projectB));
  });

  it("extracts from messages, persists both files, returns new fact count", () => {
    const count = updateRulesFromSession([
      { id: "u-deploy", createdAt: 1, role: "user", content: "deploy via ssh ops@172.16.0.2 please" },
      { id: "a-deploy", createdAt: 2, role: "assistant", content: [{ text: "ok, conda activate prod-env first" }] },
    ], projectDir, "s-deploy");
    expect(count).toBeGreaterThanOrEqual(2);
    expect(loadLocalRules(projectDir)).toContain("ops@172.16.0.2");
    expect(loadFacts(projectDir).facts.length).toBe(count);

    // 再跑一遍同样内容：无新增。
    const again = updateRulesFromSession([{ id: "u-deploy", createdAt: 1, role: "user", content: "ssh ops@172.16.0.2" }], projectDir, "s-deploy");
    expect(again).toBe(0);
  });

  it("returns 0 for empty or fact-free sessions", () => {
    expect(updateRulesFromSession([], projectDir, "s1")).toBe(0);
    expect(updateRulesFromSession([{ id: "u-hello", createdAt: 1, role: "user", content: "hello there" }], projectDir, "s1")).toBe(0);
  });
});
