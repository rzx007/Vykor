import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { documentationKind, protocolVersionErrors, collectReadmeFiles, sourcePathReferences } from "../documentation-policy.mjs";

test("classifies the document itself instead of words in its cross references", () => {
  assert.equal(documentationKind("# X\n\n> 状态：当前实现。历史说明见旧设计。"), "current");
  assert.equal(documentationKind("# X\n\n> 状态：历史记录。当前实现见新手册。"), "history");
  assert.equal(documentationKind("# X\n\n> 状态：2026-10-08 的历史分析，当前说明见新手册。"), "history");
  assert.equal(documentationKind("# X\n\n> 状态：提案，尚未实现。当前代码另见说明。"), "proposal");
  assert.equal(documentationKind("# X\n\n> 状态：当前待实现需求。"), "proposal");
  assert.equal(documentationKind("# X\n\n> 状态：测试夹具，不是产品说明。"), "fixture");
  assert.equal(documentationKind("# X\n\n> 状态：programmatic agent 的权威使用文档。"), "current");
  assert.equal(documentationKind("# X\n\n没有状态"), undefined);
});

test("rejects a stale declared protocol version while allowing migration context", () => {
  assert.deepEqual(protocolVersionErrors("当前精确协议版本是 `5`（从 4 提升到 5）。", 5), []);
  assert.deepEqual(protocolVersionErrors("HTTP 协议版本见权威协议手册。", 5), []);
  assert.deepEqual(protocolVersionErrors("# X\n协议版本 3。\nHTTP 协议版本是 `4`。", 5), [
    "第 2 行声明协议版本 3，源码当前为 5",
    "第 3 行声明协议版本 4，源码当前为 5",
  ]);
  assert.deepEqual(protocolVersionErrors("协议版本为 6。", 6), []);
  assert.deepEqual(protocolVersionErrors("协议 3 的服务提供插件能力。", 5), ["第 1 行声明协议版本 3，源码当前为 5"]);
  assert.deepEqual(protocolVersionErrors("MCP 协议版本 1，HTTP 协议 1.1，OAuth 协议 2。", 5), []);
});

test("collects nested module READMEs without generated or installed dependencies", () => {
  const directory = mkdtempSync(join(tmpdir(), "vykor-doc-policy-"));
  try {
    for (const file of ["README.md", "src/session/README.md", "node_modules/dependency/README.md", "dist/README.md", "out/README.md", "src/note.md"]) {
      const parts = file.split("/");
      mkdirSync(join(directory, ...parts.slice(0, -1)), { recursive: true });
      writeFileSync(join(directory, file), "# Example\n");
    }
    assert.deepEqual(collectReadmeFiles(directory).map(file => relative(directory, file).replaceAll("\\", "/")).sort(), [
      "README.md", "src/session/README.md",
    ]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("finds repository source files in prose and code blocks as well as inline paths", () => {
  const source = "`packages/core/src/engine`\n(packages/coordinator/src/definitions/loader.ts)\n```text\napps/cli/src/index.ts\n```\nhttps://example.com/packages/old.ts\n[local docs](docs/packaging.md)";
  assert.deepEqual(sourcePathReferences(source), [
    { target: "packages/core/src/engine", line: 1 },
    { target: "packages/coordinator/src/definitions/loader.ts", line: 2 },
    { target: "apps/cli/src/index.ts", line: 4 },
  ]);
});
