import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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
  it("round-trips rules.md and facts.json with last_updated stamp", () => {
    expect(loadLocalRules(projectDir)).toBe("");
    saveLocalRules("# Rules\n- x", projectDir);
    expect(loadLocalRules(projectDir)).toBe("# Rules\n- x");

    expect(loadFacts(projectDir)).toEqual({ facts: [], last_updated: null });
    saveFacts({ facts: [{ key: "k", type: "t", label: "l", value: "v", confidence: 0.7 }] }, projectDir);
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
  it("keeps environment facts within their project and ignores old global rules", () => {
    const projectA = join(cfgDir, "project-a");
    const projectB = join(cfgDir, "project-b");
    const legacyDir = join(cfgDir, "local_rules");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(join(legacyDir, "rules.md"), "# Old global fact\n- 10.9.9.9\n");

    expect(loadLocalRules(projectA)).toBe("");
    expect(updateRulesFromSession([{ role: "user", content: "ssh ops@10.1.2.3" }], projectA)).toBe(2);
    expect(loadLocalRules(projectA)).toContain("10.1.2.3");
    expect(loadLocalRules(projectB)).toBe("");
    expect(loadFacts(projectB).facts).toEqual([]);
    expect(getLocalRulesDir(projectA)).not.toBe(getLocalRulesDir(projectB));
  });

  it("extracts from messages, persists both files, returns new fact count", () => {
    const count = updateRulesFromSession([
      { role: "user", content: "deploy via ssh ops@172.16.0.2 please" },
      { role: "assistant", content: [{ text: "ok, conda activate prod-env first" }] },
    ], projectDir);
    expect(count).toBeGreaterThanOrEqual(2);
    expect(loadLocalRules(projectDir)).toContain("ops@172.16.0.2");
    expect(loadFacts(projectDir).facts.length).toBe(count);

    // 再跑一遍同样内容：无新增。
    const again = updateRulesFromSession([{ role: "user", content: "ssh ops@172.16.0.2" }], projectDir);
    expect(again).toBe(0);
  });

  it("returns 0 for empty or fact-free sessions", () => {
    expect(updateRulesFromSession([], projectDir)).toBe(0);
    expect(updateRulesFromSession([{ role: "user", content: "hello there" }], projectDir)).toBe(0);
  });
});
