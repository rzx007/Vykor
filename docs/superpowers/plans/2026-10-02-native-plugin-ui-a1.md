# Native Plugin UI A1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
> 状态：A1 七项任务已实施并通过验收；实现保留在 codex/plugin-ui-a1 隔离分支，未合并 main。

**Goal:** 原生插件能够声明 UI 定义，经过严格静态校验、安装授权和快照验证，并在安装预览与管理页准确显示定义数量。

**Architecture:** UI 定义和 HTML 由现有 Native Plugin 加载器读取，执行前端代码的功能留给 A3。纯类型和规范化 JSON 位于共享协议；路径、文件读取和摘要位于 plugins。安装、授权、管理接口继续复用既有服务。

**Tech Stack:** TypeScript、Node.js 标准库、现有 Zod、Vitest、现有 Desktop 插件管理组件；不新增第三方依赖或独立 package。

**Spec:** [插件 UI 完整规格](../specs/2026-10-02-native-plugin-ui-design.md)，本计划落实第 7、9 节的静态部分，以及第 17–19 节中与文件、安装、诊断相关的要求。

## Global Constraints

- Native manifest schemaVersion 保持 `1`；UI 定义文件 schemaVersion 只接受 `1`。
- 首版运行端是 Desktop。Native Tool 目前只支持 local 环境；本规格不扩大到 WSL。
- UI 加载阶段只读取 JSON、文件信息与摘要，不执行 HTML、JavaScript 或 Node Tool。
- 不在 UI manifest 复制工具 inputSchema。以本次捕获的 Tool 定义为唯一参数检查来源。
- 单插件 UI manifest 数：8；单个 UI manifest JSON：UTF-8 256 KiB。
- 单插件组件总数：16；单组件动作数：16；单个预构建 HTML：UTF-8 2 MiB。
- JSON 最大嵌套深度：20；容器根节点记为深度 1。
- 两项推导授权固定为 `ui:render` 和 `ui:invoke-own-tools`；不能给旧安装记录自动补批准。
- 路径相对于插件根目录，必须以 `./` 开头；所有父路径和目标均禁止符号链接 / junction；目标必须为普通文件。
- 首版所有自定义插件界面统一在 sandbox iframe 中运行。A1 不创建或运行 iframe。
- UI-01–UI-04 是 A1 完成门槛；UI-05–UI-06 需要 A2 的来源绑定和可信实例，不能提前标为完成。
- A1 不公布 `features.pluginUi`，不加入 SDK 运行入口，不创建 UI 实例或工具操作 API。
- 数据继续使用现有 Part/Run metadata，不增加业务表，不要求数据库迁移。

## 1. 首版阶段与验收归属

| 阶段 | 交付 | 验收归属 |
| --- | --- | --- |
| A1，本计划 | 定义类型、文件校验、静态加载、安装授权、数量和诊断 | UI-01–UI-04；为 UI-26 准备静态文档 |
| A2 | 精确 Run 来源、实例、受检工具操作、防重复执行、恢复、API / Client | UI-05–UI-16，以及后台生命周期、日志和无界面部分 |
| A3 | Desktop 文档协议、frame、SDK、消息通道、卡片和侧栏 | UI-17–UI-23；其中 UI-19 必须有真实 Electron 证据 |
| A4 | 可操作参考插件、作者指南、外部格式诊断、交付验收 | UI-24–UI-26，并核对全部首版证据 |

A2–A4 的详细编码计划以先前阶段的已验证接口为输入分别编写。这是按依赖划分的阶段，不是将本计划未完成的任务移出验收。

MCP Apps、全局状态栏和独立应用不属于 A1–A4 的首版范围，继续按 Spec 第 22 节处理。

## 2. 实施前定位与工作区约束

当前工作区还有其他工具和运行能力改动。实施阶段先按 using-git-worktrees 的工作流准备隔离工作区，分支使用 `codex/plugin-ui-a1`，并把本 Spec 与计划带入该工作区；不把其他任务的未提交修改一起提交或重写。

执行前核对：

```sh
git status --short
git diff -- packages/plugins packages/protocol packages/server/src/application/default-services/plugin-service.ts
```

本计划基于已读取的现状：

- `validateNativePlugin()` 当前校验 manifest 和声明路径，不读取 UI 定义内容。
- `loadNativePlugin()` 当前将 ui 放在 deferredKinds 中。
- `requestedPluginPermissions()` 同时被 installer、verify 和安装预览复用。
- 安装预览的 `inspectCandidate()`、已安装列表的 `list()` 当前只按 manifest 数组长度计算 inventory。
- Server 的 `settings-api.ts` 和 Client 的 `extension-types.ts` 分别定义插件管理响应类型，新增字段须同步。
- DesktopPluginInfo 已是 Client PluginInfo 的别名，但安装确认的返回结构需要显式携带新增的安全数量字段。

## 3. 文件分工

| 文件 | 责任 |
| --- | --- |
| 新增 `packages/protocol/src/plugin-ui.ts` | UI 定义类型、数量类型、A1 限额和规范化 JSON |
| 新增 `packages/protocol/src/plugin-ui.test.ts` | JSON 规范化、数字、深度与键顺序 |
| 修改 `packages/protocol/src/index.ts` | 暴露公共协议入口 |
| 新增 `packages/plugins/src/components/ui-schema.ts` | 严格 UI 定义 schema，不执行代码 |
| 新增 `packages/plugins/src/components/ui-schema.test.ts` | 字段、ID、数量、重复声明和 Unicode 长度 |
| 新增 `packages/plugins/src/components/ui.ts` | 普通文件检查、有界读取、HTML 编码、摘要与 metadata |
| 新增 `packages/plugins/src/components/ui.test.ts` | 文件、链接、跨 manifest 重复、摘要和无执行副作用 |
| 新增 `packages/plugins/src/test-helpers/native-ui.ts` | 仅测试使用的临时插件构造，不从 package exports 暴露 |
| 修改 `packages/plugins/src/types.ts`、`index.ts`、`package.json` | UI metadata 类型、组件结果和 workspace protocol 直接依赖 |
| 修改 `pnpm-lock.yaml` 中对应 workspace 记录 | 仅同步新增的 protocol 直接依赖，不升级第三方版本 |
| 修改 `packages/plugins/src/manifest/schema-v1.ts`、`validate.ts` 及对应测试 | 外层数量限制、嵌套 UI 内容在安装前校验 |
| 修改 `packages/plugins/src/load-native-plugin.ts` 及对应测试 | UI 从 unsupported 变成静态 metadata 加载 |
| 修改 `packages/plugins/src/installation/installer.ts`、`installer.test.ts` | 推导授权和真实安装验收 |
| 新增 `packages/plugins/src/installation/verify-ui.test.ts` | 已安装 UI 授权和摘要的真实验证 |
| 修改 Server plugin-service 与测试 | 安装预览、列表数量、当前权限请求和诊断 |
| 修改 Server / Client 插件响应类型 | 使用同一 PluginUiInventory 定义 |
| 修改 Desktop shared、main 插件导入与管理组件及对应测试 | 透传安全数量、显示中文授权和静态定义数量 |
| 修改 `docs/native-plugin-authoring.md`、`docs/README.md` | 明确 A1 静态可用与 A3 交互可用的边界 |

---

## Task 1: 公共定义类型与规范化 JSON

**Files:** 新增 `packages/protocol/src/plugin-ui.ts`、`plugin-ui.test.ts`；修改 `packages/protocol/src/index.ts`。

**Interfaces:** 后续任务消费 `PluginUiManifestV1`、`PluginUiComponentDefinition`、`PluginUiInventory`、`PLUGIN_UI_LIMITS`、`stringifyPluginUiJson(value: unknown): string`。本任务不引用 plugins、core 或 Node。

- [x] **Step 1: 写出会失败的规范化测试。** 通过 protocol 的公开入口导入，先确认不存在导出导致失败。

```ts
import { expect, it } from "vitest";
import { stringifyPluginUiJson } from "./index.js";

it("recursively sorts object keys and keeps array order", () => {
  expect(stringifyPluginUiJson({ z: [{ b: 2, a: 1 }], a: null }))
    .toBe('{"a":null,"z":[{"a":1,"b":2}]}');
  expect(stringifyPluginUiJson(JSON.parse('{"2":2,"10":10}')))
    .toBe('{"10":10,"2":2}');
});

it.each([NaN, Infinity, undefined, 1n, new Date()])("rejects non-JSON data: %s", (value) => {
  expect(() => stringifyPluginUiJson(value)).toThrow();
});

it("rejects deeper than twenty containers", () => {
  let value: unknown = null;
  for (let i = 0; i < 20; i++) value = { nested: value };
  expect(() => stringifyPluginUiJson(value)).not.toThrow();
  expect(() => stringifyPluginUiJson({ nested: value })).toThrow();
});
```

- [x] **Step 2: 执行失败测试。** `pnpm --filter @vykor/protocol exec vitest run src/plugin-ui.test.ts`，失败原因应是缺少新导出，不是 Node 环境或依赖安装失败。
- [x] **Step 3: 定义实际接口和限额。** 下面类型全部位于新文件，随后从 index 导出。

```ts
export type JsonValue = null | boolean | number | string | JsonValue[]
  | { [key: string]: JsonValue };

export interface PluginUiActionDefinition {
  id: string;
  label: string;
  tool: string;
  completion: "keep-open" | "resolve";
}

export interface PluginUiComponentDefinition {
  id: string;
  title: string;
  entry: string;
  surfaces: Array<"tool-result" | "session-sidebar">;
  actions: PluginUiActionDefinition[];
}

export interface PluginUiManifestV1 {
  schemaVersion: 1;
  components: PluginUiComponentDefinition[];
}

export interface PluginUiInventory {
  manifestCount: number;
  componentCount: number | null;
  validatedComponentCount: number;
}

export const PLUGIN_UI_LIMITS = {
  manifestCount: 8,
  manifestBytes: 256 * 1024,
  componentCount: 16,
  actionsPerComponent: 16,
  htmlBytes: 2 * 1024 * 1024,
  titleCodePoints: 80,
  jsonDepth: 20,
} as const;
```

规范化实现不先构造“排序后对象”再 JSON.stringify，因为 JavaScript 会重新排列数字键。直接输出排序后的键值文本：

```ts
export function stringifyPluginUiJson(value: unknown): string {
  const render = (item: unknown, depth: number): string => {
    if (item === null || typeof item === "string" || typeof item === "boolean") {
      return JSON.stringify(item);
    }
    if (typeof item === "number" && Number.isFinite(item)) return JSON.stringify(item);
    if (typeof item !== "object" || item === null) throw new Error("Plugin UI requires JSON data");
    if (depth >= PLUGIN_UI_LIMITS.jsonDepth) throw new Error("Plugin UI JSON nesting limit exceeded");
    if (Array.isArray(item)) {
      return `[${Array.from(item, child => render(child, depth + 1)).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("Plugin UI requires plain JSON objects");
    }
    const record = item as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${render(record[key], depth + 1)}`,
    ).join(",")}}`;
  };
  return render(value, 0);
}
```

- [x] **Step 4: 验证。** 补充包含 `__proto__` 的 JSON、空数组、循环引用、稀疏数组和对象中的 undefined 用例；循环/稀疏数组不能无限递归或静默变成不同数据。重复运行同一聚焦测试，再运行 `pnpm --filter @vykor/protocol check-types`。
- [x] **Step 5: 检查 diff。** 只检查这两个文件和 index；本任务不增加 Feature、不改基础协议版本。

## Task 2: 严格 UI schema 与测试插件构造

**Files:** 新增 `packages/plugins/src/components/ui-schema.ts`、`ui-schema.test.ts`、`src/test-helpers/native-ui.ts`；在 plugins/package.json 添加已有 workspace 包 `@vykor/protocol` 的直接依赖。

**Interfaces:** 产出 `PluginUiManifestV1Schema`。测试 helper 产出 `writeNativeUiFixture(root: string, ui?: PluginUiManifestV1): Promise<ValidatedNativePlugin>`，仅构造文件和测试对象，不调用待测 validator。

- [x] **Step 1: 写失败测试。** 最小定义为 `{ schemaVersion: 1, components: [{ id: "findings", title: "检查结果", entry: "./ui/findings.html", surfaces: ["tool-result"], actions: [] }] }`。

```ts
import { expect, it } from "vitest";
import { PluginUiManifestV1Schema } from "./ui-schema.js";

const component = {
  id: "findings", title: "检查结果", entry: "./ui/findings.html",
  surfaces: ["tool-result"], actions: [],
};
const manifest = { schemaVersion: 1, components: [component] };

it("accepts a presentation-only component", () => {
  expect(PluginUiManifestV1Schema.parse(manifest)).toEqual(manifest);
});
it.each([
  { ...manifest, schemaVersion: 2 },
  { ...manifest, executable: "./start.js" },
  { ...manifest, components: [] },
  { ...manifest, components: [component, component] },
  { ...manifest, components: [{ ...component, surfaces: ["tool-result", "tool-result"] }] },
  { ...manifest, components: [{ ...component, entry: "https://example.invalid/app.html" }] },
])("rejects an invalid definition", value => {
  expect(PluginUiManifestV1Schema.safeParse(value).success).toBe(false);
});
```

- [x] **Step 2: 执行失败测试。** `pnpm --filter @vykor/plugins exec vitest run src/components/ui-schema.test.ts`。
- [x] **Step 3: 使用现有 Zod 实现。** 所有对象 strict，数量与 Unicode 字符数有明确校验。

```ts
import { z } from "zod";
import { PLUGIN_UI_LIMITS } from "@vykor/protocol";

const id = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
const text = z.string().refine(value => value.trim().length > 0
  && Array.from(value).length <= PLUGIN_UI_LIMITS.titleCodePoints);
const action = z.object({
  id,
  label: text,
  tool: z.string().min(1).refine(value => value === value.trim()),
  completion: z.enum(["keep-open", "resolve"]),
}).strict();
const component = z.object({
  id,
  title: text,
  entry: z.string().refine(value => value.startsWith("./")),
  surfaces: z.array(z.enum(["tool-result", "session-sidebar"]))
    .min(1).max(2).refine(values => new Set(values).size === values.length),
  actions: z.array(action).max(PLUGIN_UI_LIMITS.actionsPerComponent)
    .refine(values => new Set(values.map(value => value.id)).size === values.length),
}).strict();
export const PluginUiManifestV1Schema = z.object({
  schemaVersion: z.literal(1),
  components: z.array(component).min(1).max(PLUGIN_UI_LIMITS.componentCount)
    .refine(values => new Set(values.map(value => value.id)).size === values.length),
}).strict();
```

测试 helper 的具体内容：

```ts
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PluginUiManifestV1 } from "@vykor/protocol";
import type { ValidatedNativePlugin } from "../types.js";

export async function writeNativeUiFixture(
  root: string,
  ui: PluginUiManifestV1 = { schemaVersion: 1, components: [{
    id: "findings", title: "检查结果", entry: "./ui/findings.html",
    surfaces: ["tool-result", "session-sidebar"], actions: [],
  }] },
): Promise<ValidatedNativePlugin> {
  await mkdir(join(root, ".vykor-plugin"), { recursive: true });
  await mkdir(join(root, "ui"), { recursive: true });
  await mkdir(join(root, "tools"), { recursive: true });
  await mkdir(join(root, "skills"), { recursive: true });
  const plugin: ValidatedNativePlugin = {
    root,
    manifestPath: join(root, ".vykor-plugin", "plugin.json"),
    manifest: {
      schemaVersion: 1, id: "example.ui-fixture", name: "ui-fixture", version: "1.0.0",
      components: {
        ui: ["./ui/manifest.json"], tools: ["./tools/not-executed.mjs"],
        skills: ["./skills/check/SKILL.md"],
      },
      runtime: { engine: "node", isolation: "process" },
    },
  };
  await mkdir(join(root, "skills", "check"), { recursive: true });
  await writeFile(plugin.manifestPath, JSON.stringify(plugin.manifest));
  await writeFile(join(root, "ui", "manifest.json"), JSON.stringify(ui));
  await writeFile(join(root, "ui", "findings.html"),
    "<!doctype html><script>throw new Error('HTML must not execute during loading')</script>");
  await writeFile(join(root, "tools", "not-executed.mjs"),
    "throw new Error('Tool module must not execute during loading')");
  await writeFile(join(root, "skills", "check", "SKILL.md"),
    "---\nname: check\ndescription: UI static fixture\n---\nCheck text.");
  return plugin;
}
```

- [x] **Step 4: 验证。** 测试动作 completion 必填、未知字段、ID 长度、纯空白标签、80 / 81 个 emoji、17 个组件和动作；确保 title 长度按 Unicode 字符数而非 UTF-16 单元计算。
- [x] **Step 5: 检查依赖与 diff。** 只增加已有 workspace 依赖；使用仓库指定 pnpm 同步锁文件与 workspace 链接，不升级第三方版本。网络受限时先使用已有依赖缓存和离线模式；不能为运行测试安装另一套依赖。

## Task 3: 有界文件读取与 Native UI metadata 加载

**Files:** 新增 `packages/plugins/src/components/ui.ts`、`ui.test.ts`；修改 `packages/plugins/src/types.ts`、`index.ts`。

**Interfaces:** 产出 `loadNativeUiMetadata(plugin: ValidatedNativePlugin): Promise<PluginComponentResult<NativeUiComponentMetadata[]>>`。metadata 只含定义、路径和摘要，不含可执行函数或 HTML 正文。

```ts
export interface NativeUiComponentMetadata {
  definition: import("@vykor/protocol").PluginUiComponentDefinition;
  declaredManifest: string;
  declaredEntry: string;
  entryPath: string;
  htmlSha256: string;
  componentDigest: string;
}
```

- [x] **Step 1: 写真实文件测试。** 每例 mkdtemp，afterEach 仅删除该测试临时根；先用 helper 构造，直接调用 loader。

```ts
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { writeNativeUiFixture } from "../test-helpers/native-ui.js";
import { loadNativeUiMetadata } from "./ui.js";

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "vk-ui-metadata-")); });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it("loads definitions and hashes without executing HTML or Node", async () => {
  const plugin = await writeNativeUiFixture(root);
  const loaded = await loadNativeUiMetadata(plugin);
  expect(loaded.status).toBe("loaded");
  expect(loaded.value).toHaveLength(1);
  expect(loaded.value![0]!.definition.id).toBe("findings");
  expect(loaded.value![0]!.componentDigest).toMatch(/^[a-f0-9]{64}$/);
});

it("changes the component digest when HTML bytes change", async () => {
  const plugin = await writeNativeUiFixture(root);
  const first = await loadNativeUiMetadata(plugin);
  await writeFile(join(root, "ui", "findings.html"), "<!doctype html><p>changed</p>");
  const second = await loadNativeUiMetadata(plugin);
  expect(second.value![0]!.componentDigest).not.toBe(first.value![0]!.componentDigest);
});
```

- [x] **Step 2: 执行失败测试。** `pnpm --filter @vykor/plugins exec vitest run src/components/ui.test.ts`。
- [x] **Step 3: 在 ui.ts 实现有界读取。** 以下 helper 只供该文件使用。路径边界复用已有 resolveNativePluginPath，另外检查原始普通文件路径上的所有父节点，防止允许“仍在根内”的链接。

```ts
import { lstat, open, realpath } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { resolveNativePluginPath } from "../paths.js";

class UiReadError extends Error {
  constructor(readonly code: string, readonly declaredPath: string) { super(code); }
}

async function readUiBytes(root: string, declaredPath: string, limit: number): Promise<{
  path: string; bytes: Buffer;
}> {
  const realRoot = await realpath(root);
  const path = await resolveNativePluginPath(realRoot, declaredPath);
  let parent = realRoot;
  for (const segment of relative(realRoot, resolve(realRoot, declaredPath)).split(sep)) {
    parent = join(parent, segment);
    if ((await lstat(parent)).isSymbolicLink()) {
      throw new UiReadError("plugin_ui_invalid_definition", declaredPath);
    }
  }
  const target = await lstat(path);
  if (!target.isFile()) throw new UiReadError("plugin_ui_invalid_definition", declaredPath);
  if (target.size > limit) throw new UiReadError("plugin_ui_payload_too_large", declaredPath);
  const file = await open(path, "r");
  try {
    const before = await file.stat();
    if (!before.isFile()) throw new UiReadError("plugin_ui_invalid_definition", declaredPath);
    if (before.size > limit) throw new UiReadError("plugin_ui_payload_too_large", declaredPath);
    const buffer = Buffer.alloc(limit + 1);
    let size = 0;
    while (size < buffer.length) {
      const result = await file.read(buffer, size, buffer.length - size, null);
      if (result.bytesRead === 0) break;
      size += result.bytesRead;
    }
    if (size > limit) throw new UiReadError("plugin_ui_payload_too_large", declaredPath);
    const after = await file.stat();
    const current = await lstat(path);
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs
      || before.ctimeMs !== after.ctimeMs
      || !current.isFile() || current.dev !== after.dev || current.ino !== after.ino
      || await realpath(resolve(realRoot, declaredPath)) !== path) {
      throw new UiReadError("plugin_ui_invalid_definition", declaredPath);
    }
    const bytes = buffer.subarray(0, size);
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { path, bytes };
  } finally {
    await file.close();
  }
}
```

大小读取不能改成 stat 后无界 readFile。stat 只用于预检，实际读取仍受 limit + 1 限制。检查 UTF-8 时保留 BOM 的字节语义，HTML 摘要对原字节求值。

loader 的组合逻辑：

```ts
import { createHash } from "node:crypto";
import { PLUGIN_UI_LIMITS, stringifyPluginUiJson } from "@vykor/protocol";
import { PluginUiManifestV1Schema } from "./ui-schema.js";
import type { NativeUiComponentMetadata, PluginComponentResult, ValidatedNativePlugin } from "../types.js";

export async function loadNativeUiMetadata(
  plugin: ValidatedNativePlugin,
): Promise<PluginComponentResult<NativeUiComponentMetadata[]>> {
  const value: NativeUiComponentMetadata[] = [];
  const seen = new Set<string>();
  let currentManifest: string | undefined;
  try {
    const declarations = plugin.manifest.components.ui ?? [];
    if (declarations.length > PLUGIN_UI_LIMITS.manifestCount) {
      throw new UiReadError("plugin_ui_invalid_definition", "components.ui");
    }
    for (const declaredManifest of declarations) {
      currentManifest = declaredManifest;
      const source = await readUiBytes(plugin.root, declaredManifest, PLUGIN_UI_LIMITS.manifestBytes);
      const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(source.bytes);
      const manifest = PluginUiManifestV1Schema.parse(JSON.parse(text));
      for (const definition of manifest.components) {
        if (seen.has(definition.id) || value.length >= PLUGIN_UI_LIMITS.componentCount) {
          throw new UiReadError("plugin_ui_invalid_definition", declaredManifest);
        }
        seen.add(definition.id);
        const html = await readUiBytes(plugin.root, definition.entry, PLUGIN_UI_LIMITS.htmlBytes);
        const htmlSha256 = createHash("sha256").update(html.bytes).digest("hex");
        const componentDigest = createHash("sha256")
          .update(stringifyPluginUiJson(definition)).update(Buffer.from([0]))
          .update(html.bytes).digest("hex");
        value.push({ definition, declaredManifest, declaredEntry: definition.entry,
          entryPath: html.path, htmlSha256, componentDigest });
      }
    }
    return { status: "loaded", value, diagnostics: [] };
  } catch (error) {
    return { status: "invalid", diagnostics: [{
      severity: "error", phase: "load", component: "ui", pluginId: plugin.manifest.id,
      code: error instanceof UiReadError ? error.code : "plugin_ui_invalid_definition",
      message: "插件 UI 定义或入口无效，请检查插件包后重新导入。",
      ...(currentManifest ? { path: currentManifest } : {}),
    }] };
  }
}
```

- [x] **Step 4: 补齐文件和摘要回归。** 缺失/目录入口、HTML 超限、JSON 超限、非法 UTF-8、根外入口、指向根内的文件链接与目录 junction、两个 manifest 同名组件、跨 manifest 超过 16 个组件全部被拒绝。Windows 必须实际创建目录 junction，不能因为文件 symlink 权限缺失就跳过全部链接验收。
- [x] **Step 5: 验证摘要规则。** 仅改变标签、动作或 surfaces 时 componentDigest 改变；只改变 JSON 键排列不改变；htmlSha256 保持原字节摘要。错误不返回 HTML、绝对 entryPath 或异常正文。两个不同组件可以复用同一个 HTML 文件。
- [x] **Step 6: 运行聚焦检查并检查 diff。** `pnpm --filter @vykor/plugins exec vitest run src/components/ui.test.ts src/components/ui-schema.test.ts`，随后运行 plugins check-types。

## Task 4: 接入校验与加载，安装前拒绝错误 UI

**Files:** 修改 `manifest/schema-v1.ts`、`manifest/validate.ts`、`load-native-plugin.ts`、`types.ts`、`index.ts` 及现有对应测试。

**Interfaces:** NativePluginComponents 增加 `ui?: PluginComponentResult<NativeUiComponentMetadata[]>`；validateNativePlugin 的成功语义增加“UI 定义和 HTML 已通过静态校验”。其他组件的加载语义不变。

- [x] **Step 1: 写安装入口会失败的回归。** 在现有 validate.test.ts 的临时 root 内使用 helper。

```ts
it("rejects a broken UI definition before installation", async () => {
  await writeNativeUiFixture(root);
  await writeFile(join(root, "ui", "manifest.json"), "{");
  const validation = await validateNativePlugin(root);
  expect(validation.status).toBe("invalid");
  expect(validation.diagnostics).toEqual(expect.arrayContaining([
    expect.objectContaining({ component: "ui", code: "plugin_ui_invalid_definition" }),
  ]));
});
```

- [x] **Step 2: 执行失败测试。** `pnpm --filter @vykor/plugins exec vitest run src/manifest/validate.test.ts src/load-native-plugin.test.ts`；当前 validator 只看文件路径，应使上述新断言失败。
- [x] **Step 3: 接线。** 外层 `components.ui` 添加 8 个文件上限；在 validate.ts 现有路径校验结束、构造 plugin 后调用 UI loader：

```ts
if (plugin.manifest.components.ui) {
  const ui = await loadNativeUiMetadata(plugin);
  if (ui.status !== "loaded") return { status: "invalid", diagnostics: ui.diagnostics };
}
return { status: "valid", plugin, diagnostics };
```

不从 UI loader 反向导入 validator，避免循环依赖。invalid 结果不携带一个看似有效的 plugin 对象，防止现有 verify 路径只判断 plugin 存在而漏掉 invalid。

在 load-native-plugin.ts 移除 deferredKinds 中的 ui，增加实际加载，并纳入汇总结果：

```ts
if (plugin.manifest.components.ui) components.ui = await loadNativeUiMetadata(plugin);
const results = [components.skills, components.agents, components.hooks,
  components.mcpServers, components.tools, components.ui,
  ...Object.values(components.unsupported ?? {})].filter(value => value !== undefined);
```

- [x] **Step 4: 验证独立组件与无执行副作用。** 正常 UI 加载得到 loaded，unsupported.ui 不再出现。先取得有效 plugin，再损坏 UI 文件、调用 loadNativePlugin，必须得到 degraded 且 Skills 仍加载。HTML / Tool 的 throw 标记不能被触发。
- [x] **Step 5: 验证实际安装安全。** installLocalNativePlugin 面对错误 UI 必须返回 invalid，installed store 不增加记录，cache 不产生已提交快照；有效快照复制后须再次通过同一静态校验。
- [x] **Step 6: 检查公开入口和聚焦回归。** 从 `@vykor/plugins` 可导入 loader 和 metadata 类型；运行 manifest、paths、load-native-plugin、installer、cache 的现有聚焦测试。保持其他 deferredKinds 不变，不在 A1 注册 UI 执行能力。

## Task 5: UI 授权贯穿安装、旧记录验证和重新安装

**Files:** 修改 `installation/installer.ts`、`installer.test.ts`；新增 `installation/verify-ui.test.ts`；根据新回归确有必要时修改 verify.ts 的错误展示，不重写安装器。

**Interfaces:** 现有 `requestedPluginPermissions(manifest): string[]` 保持签名，新增两项推导值，所有调用方使用同一个函数。

- [x] **Step 1: 写权限计算和真实安装的失败测试。** 在 installer.test.ts 的既有 root 中构造有效 UI。

```ts
it("requires both inferred UI permissions without executing the plugin", async () => {
  const sourcePath = join(root, "ui-plugin");
  const plugin = await writeNativeUiFixture(sourcePath);
  expect(requestedPluginPermissions(plugin.manifest)).toEqual([
    "ui:invoke-own-tools", "ui:render",
  ]);
  const result = await installLocalNativePlugin({ sourcePath, scope: "user", cwd: root,
    approvedPermissions: [], cacheDir: join(root, "cache"), storePath: join(root, "installed.json") });
  expect(result.status).toBe("blocked");
  expect((await readInstalledPluginStore(join(root, "installed.json"))).plugins).toEqual({});
});
```

- [x] **Step 2: 执行失败测试。** `pnpm --filter @vykor/plugins exec vitest run src/installation/installer.test.ts`。
- [x] **Step 3: 在唯一权限计算入口加入 UI 推导。** 在既有 result Set 中增加：

```ts
if (manifest.components.ui?.length) {
  result.add("ui:render");
  result.add("ui:invoke-own-tools");
}
```

纯展示组件也申请同样两项能力。不能扩展 VykorPluginPermissions 的 filesystem/network/process/secrets 解析去识别 UI，更不能把 UI 授权翻译为文件、网络或进程权限。

- [x] **Step 4: 写真实已安装验证。** verify-ui.test.ts 自己创建临时根、helper 插件，安装并批准两项，再修改保存记录模拟旧状态：

```ts
const approved = ["ui:invoke-own-tools", "ui:render"];
const result = await installLocalNativePlugin({ sourcePath, scope: "user", cwd: root,
  approvedPermissions: approved, cacheDir, storePath });
if (result.status !== "installed") throw new Error("expected installed fixture");
expect((await verifyInstalledNativePlugin(result.record)).status).toBe("valid");
await updateInstalledPluginStore(storePath, store => {
  const record = store.plugins[`user::${result.record.id}`]!;
  record.requestedPermissions = [];
  record.approvedPermissions = [];
});
const oldRecord = (await readInstalledPluginStore(storePath)).plugins[`user::${result.record.id}`]!;
const verified = await verifyInstalledNativePlugin(oldRecord);
expect(verified.status).toBe("invalid");
expect(verified.diagnostics[0]?.code).toBe("plugin_installation_permissions_mismatch");
```

该片段置于具有 beforeEach/afterEach 的测试内；sourcePath、cacheDir、storePath 分别是 root 下 ui-plugin、cache、installed.json，均由本用例初始化。

- [x] **Step 5: 覆盖批准缺失、快照篡改和重装。** requested 两项正确但 approved 少一项，诊断必须是 plugin_permissions_not_approved。安装后修改 HTML，诊断必须是 plugin_content_digest_mismatch。仅重新生成 UI 授权请求，不自动写 approved。重装增加 UI 时再次确认；同样授权重装沿用既有权限覆盖逻辑；保留 disabled 和 installedAt。
- [x] **Step 6: 检查并验证。** `pnpm --filter @vykor/plugins exec vitest run src/installation/installer.test.ts src/installation/verify-ui.test.ts src/installation/cache.test.ts`；原有无 UI 插件的 requested 数组保持原语义。

## Task 6: 安装预览、列表和 Desktop 管理反馈

**Files:** 修改 Server `settings-api.ts`、`default-services/plugin-service.ts`、`plugin-service.test.ts`；Client `types/extension-types.ts`；Desktop `shared/plugin-types.ts`、main 插件 service 与测试、renderer plugin-manager 与测试、settings-page/plugin-settings.tsx。

**Interfaces:** 在 PluginInfo / PluginArchivePreview / PluginGitPreview 增加 `uiInventory?: PluginUiInventory`。原 inventory.ui 继续表示 UI manifest 文件数，不偷偷改变既有字段含义。Desktop 的 approval-required 返回增加相同的可选安全数量字段。

- [x] **Step 1: 写真实 ZIP 安装预览测试。** 在现有 Server 测试中复用 writeNativeArchive，不新增解压器或网络依赖。

```ts
it("reports two UI components from one manifest and requests approval", async () => {
  const definition = { id: "first", title: "第一个界面", entry: "./ui/app.html",
    surfaces: ["tool-result"], actions: [] };
  const archivePath = await writeNativeArchive("ui.zip", {
    ".vykor-plugin/plugin.json": JSON.stringify({ schemaVersion: 1,
      id: "dev.vykor.archive", name: "archive", version: "1.0.0",
      components: { tools: ["./tools/not-executed.js"], ui: ["./ui/manifest.json"] } }),
    "ui/manifest.json": JSON.stringify({ schemaVersion: 1,
      components: [definition, { ...definition, id: "second", title: "第二个界面" }] }),
    "ui/app.html": "<!doctype html><script>throw new Error('not executed')</script>",
  });
  const plugins = service();
  if (!plugins.previewArchive) throw new Error("previewArchive must be configured");
  const preview = await plugins.previewArchive({ cwd: root, archivePath });
  expect(preview.inventory.ui).toBe(1);
  expect(preview.uiInventory).toEqual({ manifestCount: 1, componentCount: 2,
    validatedComponentCount: 2 });
  expect(preview.approvalRequired).toBe(true);
  expect(preview.requestedPermissions).toEqual(["ui:invoke-own-tools", "ui:render"]);
});
```

- [x] **Step 2: 执行失败测试。** `pnpm --filter @vykor/server exec vitest run src/application/default-services/plugin-service.test.ts -t "UI components"`。
- [x] **Step 3: 计算并传递明确数量。** 在 plugins 新增/导出一个纯 helper，放在 components/ui.ts 中，参数和产出如下；Server 预览和列表都调用它：

```ts
export function summarizeNativeUi(
  manifestCount: number,
  loaded: PluginComponentResult<NativeUiComponentMetadata[]> | undefined,
): import("@vykor/protocol").PluginUiInventory | undefined {
  if (manifestCount === 0) return undefined;
  return {
    manifestCount,
    componentCount: loaded?.status === "loaded" ? loaded.value!.length : null,
    validatedComponentCount: loaded?.status === "loaded" ? loaded.value!.length : 0,
  };
}
```

预览传 `validation.plugin.manifest.components.ui?.length ?? 0` 和 `loaded.components.ui`。列表在验证失败但仍有可信 root manifest 时报告已知文件数、未知组件数 null、静态有效数 0；manifest 不可读时不凭安装记录猜 UI 数量。

Plugin Service 对权限不一致的旧记录，在展示层使用 `manifest ? requestedPluginPermissions(manifest) : record.requestedPermissions` 计算当前 requested 与 missing，不回写安装记录。这能显示真实缺少的 UI 授权，而不是仅显示旧空数组。

新 UI 定义 / 大小诊断映射为 component_invalid、建议 reimport。安装成功、定义静态有效、工具 Host active 分别沿用已有事实；validatedComponentCount 不表示 UI 已运行。

- [x] **Step 4: 同步类型并验证透传。** Server / Client 的三个响应结构引用共享 PluginUiInventory，不再各写一份数量类型。Desktop approval-required 在 archive 和 Git 两条返回分支透传 uiInventory，但不传 HTML、entryPath、digest 或包源路径；selection-store 原有授权与摘要校验保持不变。
- [x] **Step 5: 增加中文反馈。** 在既有 groupPermissions 中识别 ui 分类；两项 suffix 显示为“显示插件的隔离交互界面”和“请求插件自身工具，执行前仍需确认”。安装预览显示组件数量；详情页显示“已校验 2 个 UI 定义”，A1 交付文案附“交互界面尚未接入”。null 显示“UI 定义数量暂不可确认”，不能显示 0 或“全部已加载”。

在现有 PluginManager 测试的 root / props / window.desktop setup 中加入：

```tsx
it("explains UI permissions in the host approval dialog", async () => {
  vi.mocked(window.desktop!.plugins.importArchive).mockResolvedValue({
    status: "approval-required", selectionId: "ui-selection", pluginName: "UI Fixture",
    requestedPermissions: ["ui:render", "ui:invoke-own-tools"],
    uiInventory: { manifestCount: 1, componentCount: 2, validatedComponentCount: 2 },
  });
  await act(async () => {
    root.render(<PluginManager {...props} addRequest={1} />);
  });
  expect(document.body.textContent).toContain("显示插件的隔离交互界面");
  expect(document.body.textContent).toContain("执行前仍需确认");
  expect(document.body.textContent).toContain("2 个 UI 定义");
});
```

- [x] **Step 6: 验证管理服务。** 有效预览/批准安装/列表的 uiInventory 一致；错误 ZIP 无提交残留；同一审批内容变更仍按原 archiveDigest / sourceDigest 拒绝安装。Git 共用 inspectCandidate 的计算，不访问真实网络；采用现有 Git fixture。保持现有权限分类和旧插件展示。
- [x] **Step 7: 聚焦检查。** 运行 Server 插件 service、Desktop main plugin-service、renderer plugin-manager 测试；运行 Client check-types、Server check-types、Desktop typecheck:node / typecheck:web。

## Task 7: 文档与 A1 交付检查

**Files:** 修改 `docs/native-plugin-authoring.md`、`docs/README.md`；必要时更新本计划的已完成勾选和证据，不能提前写入“首版完成”。

**Interfaces:** 作者得到与实际静态校验一致的 Native UI 示例和授权解释；A2 得到已验证的公共类型、metadata 与数量接口。

- [x] **Step 1: 作者指南新增 A1 状态说明。** 使用以下原文，位置紧邻当前组件支持范围：

```text
UI 定义的静态校验、安装授权和元数据加载已经接入。
当前阶段尚未显示自定义交互界面，也没有 UI 动作 API。
UI 定义有效不等于组件已经运行；交互能力由后续 Desktop 接入阶段交付。
```

- [x] **Step 2: 插入真实格式示例。** 从 Spec 第 7 节复制 Native manifest 和 UI manifest 的三方一致例子，明确 entry 相对于插件根、不复制 inputSchema、两项推导权限与文件/数量上限。未提供 ui-sdk 调用代码，不把 A3 的接口写成当前 API。
- [x] **Step 3: 执行 A1 合并检查。** UI-01 字段、数量、重复 ID；UI-02 文件、链接、边界；UI-03 两项授权与预览/安装/验证；UI-04 no-execute。每项记录实际测试文件与命令结果。
- [x] **Step 4: 验证文档。** 运行 `node scripts/check-docs.mjs`、`git diff --check`；逐个检查新 JSON 示例、公共导出、相对路径及文档状态。
- [x] **Step 5: 准备单阶段 diff。** 只包含本计划涉及的 A1 文件。实现的每个任务完成后保留可独立审阅的提交边界；本次写计划不执行代码提交。禁止把 QueryEngine、UI 实例、MCP Apps、frame 或新数据库表混入 A1。

## 4. 验证命令与当前环境备用路径

常规从仓库根执行：

```sh
pnpm --filter @vykor/protocol exec vitest run src/plugin-ui.test.ts
pnpm --filter @vykor/plugins exec vitest run src/components/ui-schema.test.ts src/components/ui.test.ts src/manifest/validate.test.ts src/manifest/schema-v1.test.ts src/load-native-plugin.test.ts src/installation/installer.test.ts src/installation/verify-ui.test.ts src/installation/cache.test.ts src/paths.test.ts
pnpm --filter @vykor/server exec vitest run src/application/default-services/plugin-service.test.ts
pnpm --filter @vykor/desktop exec vitest run src/main/features/plugin/plugin-service.test.ts src/renderer/src/components/desktop/plugin-page/plugin-manager.test.tsx
pnpm --filter @vykor/protocol check-types
pnpm --filter @vykor/plugins check-types
pnpm --filter @vykor/client check-types
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/desktop typecheck:node
pnpm --filter @vykor/desktop typecheck:web
node scripts/check-docs.mjs
git diff --check
```

当前会话曾遇到 pnpm 启动器联网取版本失败。不要将其当作测试失败或为了写计划安装依赖。执行期若同样受限，可以检查 plugins/protocol/server 下已定位的本地 Vitest 与 TypeScript；切到对应包工作目录后调用本地 Node 脚本，例如：

```sh
node node_modules/vitest/vitest.mjs run src/components/ui.test.ts
node node_modules/typescript/bin/tsc --noEmit
```

必须保持包的工作目录，让 tsconfig / test config 按原方式解析。plugins 的完整类型检查还包括 `tsconfig.sdk-tests.json` 和 `tsconfig.sdk-examples.json`，不能只跑上面一个 tsc 就声称完整 check-types 通过。

本次已通过授权的只读执行访问 plugins 中的 TypeScript 编译器，解析计划与 Spec 的 24 个 TypeScript 示例；这只证明示例语法，不证明未来实现的类型或行为。沙箱曾拒绝读取依赖的 junction 真实路径；存在路径不等于当前权限下能运行，实际验证必须确认完整命令退出码与输出。

本次定位没有确认 Desktop 包内的直接 Vitest 入口可用。实际执行先核对该包配置可解析的 Vitest 与 TypeScript；必要时用指定 pnpm 和现有缓存恢复工作区已有依赖链接。不能假定 root 二进制存在，也不能把未执行的 Desktop 测试写成通过。

## 5. A1 交接给 A2 的确定接口

- `@vykor/protocol` 导出定义类型、数量类型、限额和规范化 JSON。
- `@vykor/plugins` 导出 NativeUiComponentMetadata、loadNativeUiMetadata、summarizeNativeUi。
- `LoadedNativePlugin.components.ui` 提供静态定义、精确 HTML 和组件摘要。
- 安装验证能够证明两项 UI 能力已获批准、插件快照字节未被修改。
- 管理接口提供静态数量与诊断，未宣称有任意窗口运行 UI。

A2 在这些接口之上建立不可变 Run UI 定义视图和实例，不反向把 UI-05 / UI-06 的运行保证塞进静态 schema。UI 工具名目前仅是经检查的字符串；只有 A2 真实注册来源检查后才可执行。

## 6. 计划自检与完成定义

- 所有新增接口都在对应任务给出名称、输入、返回值与真实文件位置。
- schema、普通文件和字节上限均在安装前检查；没有 import 第三方代码的路径。
- 授权计算只有一个入口，旧批准记录保持原事实。
- manifest 文件数与组件数分开，不用缓存文件数假装组件数量。
- 每个代码任务都有失败测试、最小实现和聚焦验证步骤。
- 用户工作区的其他改动不会被本计划的实施或提交覆盖。
- A1 已按 UI-01–UI-04 完成验证；复核问题、构建准备和测试结果见 [A1 验收记录](../reviews/2026-10-03-native-plugin-ui-a1-verification.md)。
