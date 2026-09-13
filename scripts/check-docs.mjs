import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docsRoot = join(root, "docs");
const errors = [];

const markdownFiles = [join(root, "README.md"), ...walkMarkdown(docsRoot)];
for (const file of markdownFiles) checkLinks(file);

for (const file of readdirSync(docsRoot, { withFileTypes: true })) {
  if (!file.isFile() || extname(file.name) !== ".md") continue;
  const path = join(docsRoot, file.name);
  const firstLines = readFileSync(path, "utf-8").split(/\r?\n/u).slice(0, 8);
  if (!firstLines.some((line) => line.startsWith("> 状态："))) {
    errors.push(`${display(path)}: 前 8 行缺少“> 状态：...”`);
  } else {
    const status = firstLines.find((line) => line.startsWith("> 状态："));
    if (!/(?:当前|权威|历史|测试夹具)/u.test(status)) {
      errors.push(`${display(path)}: 状态必须明确归类为当前、权威、历史或测试夹具`);
    }
  }
}

const docsIndexPath = join(docsRoot, "README.md");
const docsIndex = readFileSync(docsIndexPath, "utf-8");
for (const required of [
  "architecture-overview.md",
  "durable-execution-data-model.md",
  "operations-and-recovery.md",
  "protocol-contract.md",
  "product-surface-integration.md",
  "security-and-trust-boundaries.md",
  "contract-test-index.md",
]) {
  if (!docsIndex.includes(`./${required}`)) {
    errors.push(`${display(docsIndexPath)}: 总目录缺少 ${required}`);
  }
}

for (const entry of readdirSync(docsRoot, { withFileTypes: true })) {
  if (!entry.isFile() || extname(entry.name) !== ".md" || entry.name === "README.md") continue;
  const path = join(docsRoot, entry.name);
  const firstLines = readFileSync(path, "utf-8").split(/\r?\n/u).slice(0, 8);
  const status = firstLines.find((line) => line.startsWith("> 状态：")) ?? "";
  if (/(?:当前|权威)/u.test(status) && !/历史/u.test(status) && !docsIndex.includes(`./${entry.name}`)) {
    errors.push(`${display(path)}: 当前文档没有从 docs/README.md 建立入口`);
  }
}

for (const file of currentTopLevelDocs()) checkSourcePaths(file);

const lifecycle = readFileSync(join(docsRoot, "agent-lifecycle-contract.md"), "utf-8");
const testIndex = readFileSync(join(docsRoot, "contract-test-index.md"), "utf-8");
for (const match of lifecycle.matchAll(/\*\*([ACDEPT]\d+)\*\*/gu)) {
  if (!testIndex.includes(match[1])) {
    errors.push(`docs/contract-test-index.md: 缺少生命周期契约 ${match[1]} 的测试映射`);
  }
}

for (const [fileName, forbidden] of [
  ["architecture-overview.md", "packages/channels/src/bridge.ts"],
  ["client-sync-flow.md", "本阶段保留可选字段以兼容现有调用者"],
  ["operations-and-recovery.md", "list-projection-settlements"],
  ["mcp-http-transport-design.md", "向后兼容"],
  ["daemon-application-architecture.md", "SessionTaskBridge"],
  ["slash-commands.md", "packages/server/src/commands.ts"],
  ["slash-commands-flow.md", "skillInvocation"],
  ["skill-prompt-flow.md", "skillInvocation"],
  ["skills-flow.md", "skillInvocation"],
  ["daemon-application-architecture.md", "skillInvocation"],
  ["tui-flow.md", "skillInvocation"],
  ["composer-capabilities-requirements.md", "skillInvocation"],
  ["desktop-agent-message-rendering.md", "skillInvocation"],
  ["README.md", "skillInvocation"],
  ["skill-prompt-flow.md", "客户端不发送 Skill 路径"],
  ["skills-flow.md", "客户端不发送 Skill 路径"],
  ["skill-prompt-flow.md", "buildSkillPrompt"],
  ["skills-flow.md", "buildSkillPrompt"],
]) {
  const path = join(docsRoot, fileName);
  if (readFileSync(path, "utf-8").includes(forbidden)) {
    errors.push(`${display(path)}: 仍包含已经删除或过时的说明：${forbidden}`);
  }
}

for (const removedPath of [
  "packages/services/src/compact/index.ts",
]) {
  if (existsSync(join(root, removedPath))) {
    errors.push(`${removedPath}: 已删除的重复实现重新出现`);
  }
}

for (const file of walkFiles(join(root, "packages"), ".ts")) {
  if (readFileSync(file, "utf-8").includes("taskManagerTaskId")) {
    errors.push(`${display(file)}: 仍使用已删除的 Workflow 元数据字段 taskManagerTaskId`);
  }
}

for (const forbidden of ["TaskCreate", "--task-worker", "compatibility fallback"]) {
  if (readFileSync(join(root, "README.md"), "utf-8").includes(forbidden)) {
    errors.push(`README.md: 仍包含已删除的入口或工具名：${forbidden}`);
  }
}

if (errors.length > 0) {
  console.error(`文档检查失败（${errors.length} 项）：`);
  for (const error of errors) console.error(`- ${error}`);
  process.exitCode = 1;
} else {
  console.log(`文档检查通过：${markdownFiles.length} 个 Markdown 文件；链接、章节、源码路径、状态、入口和契约测试映射均有效。`);
}

function walkMarkdown(directory) {
  return walkFiles(directory, ".md");
}

function walkFiles(directory, extension) {
  const result = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...walkFiles(path, extension));
    else if (entry.isFile() && extname(entry.name) === extension) result.push(path);
  }
  return result;
}

function checkLinks(file) {
  const content = readFileSync(file, "utf-8");
  const linkPattern = /\[[^\]]*\]\(([^)]+)\)/gu;
  for (const match of content.matchAll(linkPattern)) {
    let target = match[1].trim();
    if (target.startsWith("<") && target.endsWith(">")) target = target.slice(1, -1);
    target = target.split(/\s+["']/u, 1)[0];
    if (!target || target.startsWith("#") || /^(?:https?:|mailto:)/iu.test(target)) continue;
    const filePart = decodeURIComponent(target.split("#", 1)[0]);
    if (!filePart) continue;
    const resolved = resolve(dirname(file), filePart);
    if (!existsSync(resolved)) {
      const line = content.slice(0, match.index).split(/\r?\n/u).length;
      errors.push(`${display(file)}:${line}: 链接目标不存在：${target}`);
      continue;
    }
    const anchor = target.includes("#") ? decodeURIComponent(target.slice(target.indexOf("#") + 1)) : "";
    if (anchor && extname(resolved).toLowerCase() === ".md" && !markdownAnchors(resolved).has(anchor)) {
      const line = content.slice(0, match.index).split(/\r?\n/u).length;
      errors.push(`${display(file)}:${line}: 链接章节不存在：${target}`);
    }
  }
}

function currentTopLevelDocs() {
  return readdirSync(docsRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && extname(entry.name) === ".md")
    .map((entry) => join(docsRoot, entry.name))
    .filter((file) => {
      const head = readFileSync(file, "utf-8").split(/\r?\n/u).slice(0, 8);
      const status = head.find((line) => line.startsWith("> 状态：")) ?? "";
      return /(?:当前|权威)/u.test(status) && !/历史/u.test(status);
    });
}

function checkSourcePaths(file) {
  const content = readFileSync(file, "utf-8");
  const pattern = /`((?:packages|apps|scripts|tests|drizzle|docs)\/[^`\s#()]+)`/gu;
  for (const match of content.matchAll(pattern)) {
    const target = match[1].replace(/[.,;:]$/u, "");
    if (/[<>*]/u.test(target)) continue;
    if (!existsSync(resolve(root, target))) {
      const line = content.slice(0, match.index).split(/\r?\n/u).length;
      errors.push(`${display(file)}:${line}: 源码路径不存在：${target}`);
    }
  }
}

function markdownAnchors(file) {
  const counts = new Map();
  const anchors = new Set();
  for (const line of readFileSync(file, "utf-8").split(/\r?\n/u)) {
    const heading = /^(?:#{1,6})\s+(.+?)\s*#*$/u.exec(line)?.[1];
    if (!heading) continue;
    const base = heading
      .toLowerCase()
      .replace(/<[^>]*>/gu, "")
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .trim()
      .replace(/\s+/gu, "-");
    const count = counts.get(base) ?? 0;
    counts.set(base, count + 1);
    anchors.add(count === 0 ? base : `${base}-${count}`);
  }
  return anchors;
}

function display(path) {
  return relative(root, path).replaceAll("\\", "/");
}
