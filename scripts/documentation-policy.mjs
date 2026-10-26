import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export function documentationKind(source) {
  const status = source.split(/\r?\n/u).slice(0, 8)
    .find(line => line.startsWith("> 状态："))?.slice("> 状态：".length).trim();
  if (!status) return undefined;
  if (/^(?:历史|\d{4}.*历史)/u.test(status)) return "history";
  if (status.startsWith("测试夹具")) return "fixture";
  if (/^(?:提案|待实施|待评审|提议|当前待实现)/u.test(status)) return "proposal";
  if (/(?:当前|权威)/u.test(status)) return "current";
  return undefined;
}

export function protocolVersionErrors(source, currentVersion) {
  const errors = [];
  source.split(/\r?\n/u).forEach((line, index) => {
    for (const match of line.matchAll(/协议(?:版本)?(?:是|为)?\s*[:：]?\s*`?(\d+)(?![\d.])`?/gu)) {
      if (/(?:MCP|OAuth|JSON-RPC)\s*$/iu.test(line.slice(0, match.index))) continue;
      if (Number(match[1]) !== currentVersion) {
        errors.push(`第 ${index + 1} 行声明协议版本 ${match[1]}，源码当前为 ${currentVersion}`);
      }
    }
  });
  return errors;
}

export function sourcePathReferences(source) {
  const patterns = [
    /`((?:packages|apps|scripts|tests|drizzle|docs)\/[^`\s#()]+)`/gu,
    /(?<![\w/.-])((?:packages|apps|scripts|tests|drizzle)\/[\w./-]+\.(?:tsx?|mjs|md|json|sql|yaml))\b/gu,
  ];
  const seen = new Set();
  return patterns.flatMap(pattern => [...source.matchAll(pattern)])
    .sort((a, b) => a.index - b.index)
    .flatMap(match => {
      const target = match[1].replace(/[.,;:]$/u, "");
      const line = source.slice(0, match.index).split(/\r?\n/u).length;
      const key = `${line}:${target}`;
      if (/[<>*]/u.test(target) || seen.has(key)) return [];
      seen.add(key);
      return [{ target, line }];
    });
}

export function collectReadmeFiles(directory) {
  if (!existsSync(directory)) return [];
  const ignored = new Set(["node_modules", "dist", "out", "build", "coverage", ".git", ".turbo"]);
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && !ignored.has(entry.name)) return collectReadmeFiles(path);
    return entry.isFile() && entry.name === "README.md" ? [path] : [];
  });
}
