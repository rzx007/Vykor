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
  replaceFact,
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
  it("shows the observation date and asks for verification before use", () => {
    const md = factsToRulesMarkdown([{
      key: "ssh_host:ops@10.1.2.3", type: "ssh_host", label: "SSH connection",
      value: "ops@10.1.2.3", confidence: 0.7,
      sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2025-09-24T00:00:00.000Z",
    }]);

    expect(md).toContain("`ops@10.1.2.3` (last observed 2025-09-24; verify current state)");
  });

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

describe("replaceFact", () => {
  it("links a selected old key to an already active new fact without replacing its source", () => {
    saveFacts({ facts: [
      { key: "ssh_host:ops@10.1.2.3", type: "ssh_host", label: "SSH connection", value: "ops@10.1.2.3", confidence: 0.7,
        sourceSessionId: "s1", sourceMessageId: "u-old", observedAt: "2026-09-23T00:00:00.000Z" },
      { key: "ssh_host:ops@10.1.2.4", type: "ssh_host", label: "SSH connection", value: "ops@10.1.2.4", confidence: 0.7,
        sourceSessionId: "s2", sourceMessageId: "u-new", observedAt: "2026-09-24T00:00:00.000Z" },
    ] }, projectDir);

    const result = replaceFact(projectDir, "ssh_host:ops@10.1.2.3", "ops@10.1.2.4", { sessionId: "s2" });
    const facts = loadFacts(projectDir).facts;
    expect(facts).toHaveLength(2);
    expect(facts.find((fact) => fact.key === result.oldKey)?.replacement)
      .toMatchObject({ byKey: result.newKey, operationId: result.operationId });
    expect(facts.find((fact) => fact.key === result.newKey))
      .toMatchObject({ sourceSessionId: "s2", sourceMessageId: "u-new", observedAt: "2026-09-24T00:00:00.000Z" });
    expect(facts.find((fact) => fact.key === result.newKey)?.manualSource).toBeUndefined();
    expect(loadLocalRules(projectDir)).toContain("ops@10.1.2.4");
    expect(loadLocalRules(projectDir)).not.toContain("ops@10.1.2.3");
    updateRulesFromSession([
      { id: "u-old", createdAt: Date.parse("2026-09-23T00:00:00.000Z"), role: "user", content: "ssh ops@10.1.2.3" },
      { id: "u-other", createdAt: Date.parse("2026-09-24T01:00:00.000Z"), role: "user", content: "ssh ops@10.1.2.4" },
    ], projectDir, "s3");
    expect(loadFacts(projectDir).facts.find((fact) => fact.key === result.newKey))
      .toMatchObject({ sourceSessionId: "s2", sourceMessageId: "u-new" });
    expect(replaceFact(projectDir, result.oldKey, "ops@10.1.2.4").operationId).toBe(result.operationId);
  });

  it("refuses to link to a target that has itself been superseded", () => {
    saveFacts({ facts: [
      { key: "ip_address:10.1.2.3", type: "ip_address", label: "Server IP", value: "10.1.2.3", confidence: 0.7,
        sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2026-09-23T00:00:00.000Z" },
      { key: "ip_address:10.1.2.4", type: "ip_address", label: "Server IP", value: "10.1.2.4", confidence: 0.7,
        sourceSessionId: "s1", sourceMessageId: "u2", observedAt: "2026-09-24T00:00:00.000Z" },
    ] }, projectDir);
    replaceFact(projectDir, "ip_address:10.1.2.4", "10.1.2.5");
    const path = join(dir, "facts.json");
    const before = readFileSync(path, "utf-8");
    expect(() => replaceFact(projectDir, "ip_address:10.1.2.3", "10.1.2.4"))
      .toThrowError(expect.objectContaining({ code: "CONFLICT" }));
    expect(readFileSync(path, "utf-8")).toBe(before);
  });

  it("supersedes only the selected fact and survives rescanning old messages", () => {
    const oldMessages = [{
      id: "u1", createdAt: Date.parse("2026-09-24T00:00:00.000Z"), role: "user",
      content: "ssh ops@10.1.2.3; ssh admin@10.9.8.7",
    }];
    updateRulesFromSession(oldMessages, projectDir, "s1");

    const result = replaceFact(projectDir, "ssh_host:ops@10.1.2.3", "ops@10.1.2.4", { sessionId: "s1" });
    expect(result.relatedActiveKeys).toContain("ip_address:10.1.2.3");
    expect(loadFacts(projectDir).facts.find((fact) => fact.key === result.oldKey)?.status).toBe("superseded");
    expect(loadFacts(projectDir).facts.find((fact) => fact.key === result.newKey)?.manualSource)
      .toMatchObject({ kind: "manual_replace", operationId: result.operationId, oldKey: result.oldKey, sessionId: "s1" });
    expect(loadLocalRules(projectDir)).toContain("ops@10.1.2.4");
    expect(loadLocalRules(projectDir)).not.toContain("ops@10.1.2.3");

    updateRulesFromSession(oldMessages, projectDir, "s1");
    const facts = loadFacts(projectDir).facts;
    expect(facts.find((fact) => fact.key === result.oldKey)?.status).toBe("superseded");
    expect(facts.find((fact) => fact.key === "ssh_host:admin@10.9.8.7")?.status).toBeUndefined();
    expect(replaceFact(projectDir, result.oldKey, "ops@10.1.2.4", { sessionId: "s1" }).operationId)
      .toBe(result.operationId);
  });

  it("does not report a different IP with the same prefix as related", () => {
    saveFacts({ facts: [
      { key: "ssh_host:ops@10.1.2.3", type: "ssh_host", label: "SSH connection", value: "ops@10.1.2.3", confidence: 0.7,
        sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2026-09-24T00:00:00.000Z" },
      { key: "ip_address:10.1.2.30", type: "ip_address", label: "Server IP", value: "10.1.2.30", confidence: 0.7,
        sourceSessionId: "s1", sourceMessageId: "u2", observedAt: "2026-09-24T00:00:00.000Z" },
    ] }, projectDir);

    const result = replaceFact(projectDir, "ssh_host:ops@10.1.2.3", "ops@10.1.2.4");
    expect(result.relatedActiveKeys).toEqual([]);
  });

  it("accepts canonical replacement values for every extracted fact type", () => {
    const examples = [
      ["ssh_host", "ops@10.1.2.3", "ops@10.1.2.4"],
      ["ip_address", "10.1.2.3", "10.1.2.4"],
      ["data_path", "/mnt/data/landing/old", "/mnt/data/landing/new"],
      ["conda_env", "old-env", "new-env"],
      ["python_env", "3.11.2", "3.12.1"],
      ["api_endpoint", "https://api.example.com/v2", "https://api.example.com/v3"],
      ["env_var", "DATA_ROOT", "MODEL_ROOT"],
      ["git_remote", "acme/old", "acme/new"],
      ["ray_cluster", "--address 10.1.2.3:6379", "--address 10.1.2.4:6379"],
      ["cron_schedule", "0 3 * * *", "0 4 * * *"],
    ] as const;
    for (const [type, oldValue, newValue] of examples) {
      saveFacts({ facts: [{
        key: `${type}:${oldValue}`, type, label: type, value: oldValue, confidence: 0.7,
        sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2026-09-24T00:00:00.000Z",
      }] }, projectDir);
      try {
        expect(replaceFact(projectDir, `${type}:${oldValue}`, newValue).newKey).toBe(`${type}:${newValue}`);
      } catch (error) {
        throw new Error(`${type}: ${String(error)}`);
      }
    }
  });

  it("rejects invalid replacements without modifying the facts file", () => {
    saveFacts({ facts: [{
      key: "ssh_host:ops@10.1.2.3", type: "ssh_host", label: "SSH connection", value: "ops@10.1.2.3", confidence: 0.7,
      sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2026-09-24T00:00:00.000Z",
    }, {
      key: "ssh_host:ops@10.1.2.4", type: "ssh_host", label: "SSH connection", value: "ops@10.1.2.4", confidence: 0.7,
      sourceSessionId: "s1", sourceMessageId: "u2", observedAt: "2026-09-24T00:00:00.000Z",
    }] }, projectDir);
    const path = join(dir, "facts.json");
    const before = readFileSync(path, "utf-8");
    for (const [oldKey, value, code] of [
      ["ssh_host:missing", "ops@10.1.2.5", "NOT_FOUND"],
      ["ssh_host:ops@10.1.2.3", "not-an-ssh-host", "INVALID_VALUE"],
      ["ssh_host:ops@10.1.2.3", "ops@sk-examplelongtoken123", "INVALID_VALUE"],
    ]) {
      expect(() => replaceFact(projectDir, oldKey!, value!)).toThrowError(expect.objectContaining({ code }));
      expect(readFileSync(path, "utf-8")).toBe(before);
    }
  });

  it("rejects an invalid IPv4 address even if the extractor matches its shape", () => {
    saveFacts({ facts: [{
      key: "ip_address:10.1.2.3", type: "ip_address", label: "Server IP", value: "10.1.2.3", confidence: 0.7,
      sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2026-09-24T00:00:00.000Z",
    }] }, projectDir);
    expect(() => replaceFact(projectDir, "ip_address:10.1.2.3", "999.999.999.999"))
      .toThrowError(expect.objectContaining({ code: "INVALID_VALUE" }));
  });

  it("does not overwrite an unreadable facts file", () => {
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "facts.json");
    writeFileSync(path, "{broken", "utf-8");
    expect(() => replaceFact(projectDir, "ssh_host:ops@10.1.2.3", "ops@10.1.2.4"))
      .toThrowError(expect.objectContaining({ code: "UNREADABLE" }));
    expect(readFileSync(path, "utf-8")).toBe("{broken");
  });

  it("keeps the replacement inside one project", () => {
    const projectB = join(cfgDir, "project-b");
    const old = {
      key: "ssh_host:ops@10.1.2.3", type: "ssh_host", label: "SSH connection", value: "ops@10.1.2.3", confidence: 0.7,
      sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2026-09-24T00:00:00.000Z",
    };
    saveFacts({ facts: [old] }, projectDir);
    saveFacts({ facts: [old] }, projectB);
    replaceFact(projectDir, old.key, "ops@10.1.2.4");
    expect(loadLocalRules(projectDir)).toContain("ops@10.1.2.4");
    expect(loadLocalRules(projectB)).toContain("ops@10.1.2.3");
  });

  it("keeps the authoritative replacement when the human-readable cache cannot be written", () => {
    saveFacts({ facts: [{
      key: "ssh_host:ops@10.1.2.3", type: "ssh_host", label: "SSH connection", value: "ops@10.1.2.3", confidence: 0.7,
      sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2026-09-24T00:00:00.000Z",
    }] }, projectDir);
    mkdirSync(join(dir, "rules.md"));
    const result = replaceFact(projectDir, "ssh_host:ops@10.1.2.3", "ops@10.1.2.4");
    expect(result.cacheWarning).toBeTruthy();
    expect(loadLocalRules(projectDir)).toContain("ops@10.1.2.4");
    expect(loadLocalRules(projectDir)).not.toContain("ops@10.1.2.3");
  });

  it("rebuilds a failed rules cache when the same replacement is retried", () => {
    saveFacts({ facts: [{
      key: "ssh_host:ops@10.1.2.3", type: "ssh_host", label: "SSH connection", value: "ops@10.1.2.3", confidence: 0.7,
      sourceSessionId: "s1", sourceMessageId: "u1", observedAt: "2026-09-24T00:00:00.000Z",
    }] }, projectDir);
    const cachePath = join(dir, "rules.md");
    mkdirSync(cachePath);
    const first = replaceFact(projectDir, "ssh_host:ops@10.1.2.3", "ops@10.1.2.4");
    expect(first.cacheWarning).toBeTruthy();
    rmSync(cachePath, { recursive: true });

    const retried = replaceFact(projectDir, "ssh_host:ops@10.1.2.3", "ops@10.1.2.4");
    expect(retried.operationId).toBe(first.operationId);
    expect(retried.cacheWarning).toBeUndefined();
    expect(readFileSync(cachePath, "utf-8")).toContain("ops@10.1.2.4");
  });

  it("keeps a manual replacement's source when old messages mention the new value", () => {
    const messages = [
      { id: "u1", createdAt: 1, role: "user", content: "ssh ops@10.1.2.3" },
      { id: "u2", createdAt: 2, role: "user", content: "ssh ops@10.1.2.4" },
    ];
    updateRulesFromSession([messages[0]!], projectDir, "s1");
    const result = replaceFact(projectDir, "ssh_host:ops@10.1.2.3", "ops@10.1.2.4", { sessionId: "s1" });
    updateRulesFromSession(messages, projectDir, "s1");

    expect(loadFacts(projectDir).facts.find((fact) => fact.key === result.newKey)?.manualSource?.operationId)
      .toBe(result.operationId);
  });
});
