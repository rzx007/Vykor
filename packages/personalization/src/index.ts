import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";

/**
 * Personalization：从会话历史抽取环境事实（移植自 Python personalization/）。
 *
 * 10 个正则识别 SSH/IP/数据路径/conda/Python 版本/API 端点/env 变量/git 远端/
 * Ray 集群/cron；按项目和 key 去重合并后持久化到 `~/.vykor/local_rules/projects/`
 * （facts.json + 重新生成的 rules.md）。rules.md 由 prompts 包注入 system prompt。
 */

export interface ExtractedFact {
  key: string;
  type: string;
  label: string;
  value: string;
  confidence: number;
  sourceSessionId?: string;
  sourceMessageId?: string;
  observedAt?: string;
}

export interface FactsFile {
  facts: ExtractedFact[];
  last_updated?: string | null;
}

/** 宽松的消息形状：兼容引擎 Message 联合（SystemMessage 无 role，块按 unknown 收）。 */
export interface SessionMessageLike {
  id?: string;
  createdAt?: number;
  role?: string;
  content: string | ReadonlyArray<unknown>;
}

// ---------------------------------------------------------------------------
// 抽取
// ---------------------------------------------------------------------------

/** 环境事实正则（对齐 Python _FACT_PATTERNS，含 type/label/pattern）。 */
const FACT_PATTERNS: Array<[type: string, label: string, pattern: RegExp]> = [
  ["ssh_host", "SSH connection", /ssh\s+(?:-[io]\s+\S+\s+)*(\S+@[\d.]+|\S+@\S+)/gi],
  ["ip_address", "Server IP", /(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/g],
  ["data_path", "Data path", /(\/(?:ext|mnt|home|data|root)\S*\/(?:data\S*|landing|derived|reference)\S*)/g],
  ["conda_env", "Conda environment", /conda\s+activate\s+(\S+)/g],
  ["python_env", "Python version", /[Pp]ython\s*(3\.\d+(?:\.\d+)?)/g],
  ["api_endpoint", "API endpoint", /(https?:\/\/\S+\/v\d+\/?)\b/g],
  ["env_var", "Environment variable", /export\s+([A-Z][A-Z0-9_]+)(?:=\S+)?/g],
  ["git_remote", "Git remote", /(?:github|gitlab)\.com[:/](\S+?)(?:\.git)?(?=\s|$)/g],
  ["ray_cluster", "Ray cluster", /ray\s+(?:start|init|submit)\b.*?(--address\s+\S+|\d+\.\d+\.\d+\.\d+:\d+)/gi],
  ["cron_schedule", "Cron schedule", /((?:\d+|\*)\s+(?:\d+|\*)\s+(?:\d+|\*)\s+(?:\d+|\*)\s+(?:\d+|\*))\s+\S+/g],
];

/** 用正则从文本抽事实：按 `type:value` 去重，IP 假阳性过滤，值长度≥3。 */
export function extractFactsFromText(text: string): ExtractedFact[] {
  const facts: ExtractedFact[] = [];
  const seenKeys = new Set<string>();

  for (const [factType, label, pattern] of FACT_PATTERNS) {
    pattern.lastIndex = 0;
    for (const match of text.matchAll(pattern)) {
      let value = (match[1] ?? match[0]).trim().replace(/[.,;:)]+$/, "");
      if (!value || value.length < 3) continue;

      // 常见假阳性：保留地址段/广播/回环。
      if (factType === "ip_address" && (value.startsWith("0.") || value.startsWith("255.") || value.startsWith("127.0.0.1"))) {
        continue;
      }

      const key = `${factType}:${value}`;
      if (seenKeys.has(key)) continue;
      seenKeys.add(key);

      facts.push({ key, type: factType, label, value, confidence: 0.7 });
    }
  }
  return facts;
}

const SECTION_TITLES: Record<string, string> = {
  ssh_host: "SSH Hosts",
  ip_address: "Known Servers",
  data_path: "Data Paths",
  conda_env: "Python Environments",
  python_env: "Python Versions",
  api_endpoint: "API Endpoints",
  env_var: "Environment Variables",
  git_remote: "Git Repositories",
  ray_cluster: "Ray Cluster Config",
  cron_schedule: "Scheduled Jobs",
};

/** facts → 分组 Markdown（注入 system prompt 用）。 */
export function factsToRulesMarkdown(facts: ExtractedFact[]): string {
  if (facts.length === 0) return "";

  const grouped = new Map<string, ExtractedFact[]>();
  for (const fact of facts) {
    const list = grouped.get(fact.type) ?? [];
    list.push(fact);
    grouped.set(fact.type, list);
  }

  const lines = [
    "# Local Environment Rules",
    "",
    "*Auto-generated from session history. Do not edit manually.*",
    "",
  ];
  for (const [factType, items] of grouped) {
    const title =
      SECTION_TITLES[factType] ??
      factType.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    lines.push(`## ${title}`, "");
    for (const item of items) {
      lines.push(`- \`${item.value}\``);
    }
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 持久化
// ---------------------------------------------------------------------------

export function getLocalRulesDir(cwd: string): string {
  // 与 core/paths、auth 同约定：VYKOR_CONFIG_DIR 可重定向（测试隔离/Electron 预留）。
  const base = process.env.VYKOR_CONFIG_DIR ?? join(homedir(), ".vykor");
  const project = resolve(cwd);
  const digest = createHash("sha1").update(project).digest("hex").slice(0, 12);
  return join(base, "local_rules", "projects", `${basename(project)}-${digest}`);
}

const rulesFile = (cwd: string): string => join(getLocalRulesDir(cwd), "rules.md");
const factsFile = (cwd: string): string => join(getLocalRulesDir(cwd), "facts.json");

export function loadLocalRules(cwd: string): string {
  const path = rulesFile(cwd);
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf-8").trim();
  } catch {
    return "";
  }
}

export function saveLocalRules(content: string, cwd: string): string {
  mkdirSync(getLocalRulesDir(cwd), { recursive: true });
  writeFileSync(rulesFile(cwd), content.trim() + "\n", "utf-8");
  return rulesFile(cwd);
}

export function loadFacts(cwd: string): FactsFile {
  const path = factsFile(cwd);
  if (!existsSync(path)) return { facts: [], last_updated: null };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as FactsFile;
    return { facts: parsed.facts ?? [], last_updated: parsed.last_updated ?? null };
  } catch {
    return { facts: [], last_updated: null };
  }
}

export function saveFacts(facts: FactsFile, cwd: string): void {
  mkdirSync(getLocalRulesDir(cwd), { recursive: true });
  const payload: FactsFile = { ...facts, last_updated: new Date().toISOString() };
  writeFileSync(factsFile(cwd), JSON.stringify(payload, null, 2) + "\n", "utf-8");
}

/** 按 key 去重合并：同 key 置信度高者胜（平手取新值）。 */
export function mergeFacts(existing: FactsFile, newFacts: ExtractedFact[]): FactsFile {
  const byKey = new Map<string, ExtractedFact>();
  for (const fact of existing.facts ?? []) {
    byKey.set(fact.key, fact);
  }
  for (const fact of newFacts) {
    if (!fact.key) continue;
    const old = byKey.get(fact.key);
    if (!old || (fact.confidence ?? 0) >= (old.confidence ?? 0)) {
      byKey.set(fact.key, fact);
    }
  }
  return { facts: [...byKey.values()] };
}

// ---------------------------------------------------------------------------
// session-end 钩子
// ---------------------------------------------------------------------------

/**
 * 会话结束时调用：抽取 → 合并 → 双写 facts.json + rules.md。
 * 返回新增事实数。调用方应 try/catch（best-effort，绝不阻塞退出）。
 */
export function updateRulesFromSession(messages: SessionMessageLike[], cwd: string, sessionId: string): number {
  const newFacts: ExtractedFact[] = [];
  for (const msg of messages) {
    if (msg.role !== "user" || !msg.id || !sessionId ||
        typeof msg.createdAt !== "number" || !Number.isFinite(msg.createdAt)) continue;
    const observedAt = new Date(msg.createdAt);
    if (Number.isNaN(observedAt.getTime())) continue;
    const text = typeof msg.content === "string"
      ? msg.content
      : msg.content.map((block) => (block as { text?: unknown } | null)?.text)
          .filter((value): value is string => typeof value === "string").join("\n");
    for (const fact of extractFactsFromText(text)) {
      newFacts.push({
        ...fact,
        sourceSessionId: sessionId,
        sourceMessageId: msg.id,
        observedAt: observedAt.toISOString(),
      });
    }
  }
  if (newFacts.length === 0) return 0;

  const existing = loadFacts(cwd);
  const merged = mergeFacts(existing, newFacts);
  saveFacts(merged, cwd);

  const rulesMd = factsToRulesMarkdown(merged.facts);
  if (rulesMd) saveLocalRules(rulesMd, cwd);

  return Math.max(merged.facts.length - (existing.facts?.length ?? 0), 0);
}
