import { readdirSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/**
 * 一个具名输出样式。对齐 Python `OutputStyle(name, content, source)`。
 *
 * 输出样式是 **REPL 渲染模式**(由 name 驱动渲染分支),不是 system prompt 注入,
 * 也不是文本后处理函数。`content` 只是人类可读的描述。
 */
export interface OutputStyleDefinition {
  name: string;
  content: string;
  source: "builtin" | "user";
}

/** 内置三个样式(对齐 Python loader)。只有 `minimal` 在渲染层被特判;`codex` 暂同 default。 */
const BUILTIN_STYLES: OutputStyleDefinition[] = [
  { name: "default", content: "Standard rich console output.", source: "builtin" },
  { name: "minimal", content: "Very terse plain-text output.", source: "builtin" },
  { name: "codex", content: "Codex-like compact transcript and tool output.", source: "builtin" },
];

/** 用户自定义样式目录:`~/.vykor/output_styles`(递归创建)。 */
export function getOutputStylesDir(): string {
  const dir = join(homedir(), ".vykor", "output_styles");
  try {
    mkdirSync(dir, { recursive: true });
  } catch {
    /* 目录创建失败不致命:用户样式将为空,内置样式仍可用 */
  }
  return dir;
}

/**
 * 加载内置 + 用户输出样式。
 *
 * 用户样式来自 `~/.vykor/output_styles/*.md`:文件名(去扩展名)为 name、
 * 文件内容为 content、source="user",按 name 排序后追加在内置之后。
 * 与内置同名的用户样式按追加顺序排在其后(消费方取列表,渲染按 name 匹配,不冲突)。
 */
export function loadOutputStyles(): OutputStyleDefinition[] {
  const styles: OutputStyleDefinition[] = [...BUILTIN_STYLES];
  const dir = getOutputStylesDir();
  let files: string[] = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".md")).sort();
  } catch {
    return styles;
  }
  for (const file of files) {
    try {
      const content = readFileSync(join(dir, file), "utf-8");
      styles.push({ name: file.replace(/\.md$/, ""), content, source: "user" });
    } catch {
      /* 单个文件读失败跳过 */
    }
  }
  return styles;
}

/** 校验某个样式名是否存在(内置或用户)。 */
export function isKnownOutputStyle(name: string, styles = loadOutputStyles()): boolean {
  return styles.some((s) => s.name === name);
}
