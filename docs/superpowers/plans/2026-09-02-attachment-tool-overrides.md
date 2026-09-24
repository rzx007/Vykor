# 附件能力退出 Agent Runtime 实现计划

> **后续修订：** 本计划已经完成，但其中“`@vykor/tools` 保留可复用视觉 Tool”和“按图片服务配置注册”的实现结论已被 [Daemon 视觉工具所有权实现计划](./2026-09-02-daemon-visual-tools-ownership.md) 取代。当前边界是：视觉 Tool 完整属于 daemon/server，loader 通过唯一的 `tools(context)` 入口取得固定和动态工具。

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让默认 `Read` 独立可用，把附件文本读取、本地 OCR、图生文、文生图、Child → Root 授权和附件 compact 文案收回 daemon 装配，并让默认 Agent 不注册任何视觉 Tool。

**架构：** `@vykor/tools` 保留本地文件读取和可复用视觉 Tool 定义，但默认 Registry 只注册非视觉基础 Tool。`@vykor/core` 与 `@vykor/agent-runtime` 不再包含附件 Host、附件 Catalog、视觉服务装配或附件目录挂载。daemon 通过 `tools` 按配置注册 `ImageToText` / `ImageGeneration`，通过 `toolOverrides` 覆盖 `Read`，并用 `trustedToolOverrides: ["Read"]` 保留第一方 `Read` 的内置权限分类。

**技术栈：** TypeScript、Vitest、pnpm workspace、Turbo、Vykor ToolRegistry/QueryEngine、SessionStore、LocalOcrService。

**执行约束：** 用户明确要求直接在 `main` 实现，不创建 worktree。工作区存在其他任务的未提交改动；每次只用精确路径 `git add -- <files>`，提交前必须检查 `git diff --cached --stat`，不得暂存或修改计划范围外文件。

---

## 文件结构与职责

### `@vykor/agent-runtime`

- 修改 `packages/agent-runtime/src/agent-options.ts`：声明 `trustedToolOverrides`，删除附件/OCR Capability override。
- 修改 `packages/agent-runtime/src/default-runtime.ts`：校验第一方可信覆盖，恢复可信 builtin 权限分类；删除附件 Host、视觉 Capability 和附件目录挂载接线。
- 修改 `packages/agent-runtime/src/default-runtime.test.ts`：锁定可信/不可信覆盖和 cwd 权限边界。
- 修改 `packages/agent-runtime/src/child-agent-options.ts` 与 `child-agent-options.test.ts`：Root 的可信覆盖只读继承给 Child。
- 修改 `packages/agent-runtime/src/capability-resolution.ts`、`capability-resolution.test.ts`、`default-agent-capabilities.ts`：删除 `attachments`、`imageToText` 能力快照与解析。
- 修改 `packages/agent-runtime/src/kernel.ts`、`kernel.test.ts`：删除 QueryEngine 的附件/OCR setter 接线。
- 修改 `packages/agent-runtime/src/agent.ts`、`agent-composition.ts`、相关测试：删除 `attachmentResourceRoot`。
- 修改 `packages/agent-runtime/src/compact-context.ts` 与测试：只组合 `sessionMemory` 和通用 `supplementalSections`。

### `@vykor/core`

- 修改 `packages/core/src/types/tools.ts`：删除附件/OCR Host 类型和 `ToolContext` 字段。
- 修改 `packages/core/src/types/runtime.ts`：删除 `setAttachments()`、`setImageToText()`。
- 修改 `packages/core/src/engine/query-engine.ts` 与测试：删除 Host 状态和 ToolContext 注入。
- 修改 `packages/core/src/engine/compact-service.ts`：删除附件 Catalog 类型和格式化，增加通用 `CompactContextSection` 限额处理。
- 修改 `packages/core/src/engine/compact-service-advanced.test.ts`：锁定通用章节的格式化、折叠和限额。
- 修改 `packages/core/src/index.ts`：停止导出附件/OCR Host 和附件 Catalog，导出 `CompactContextSection`。

### `@vykor/tools`

- 修改 `packages/tools/src/file/read.ts` 与测试：恢复纯本地文件/目录读取。
- 删除 `packages/tools/src/file/attachment-uri.ts`：附件 URI 解析迁到 server。
- 修改 `packages/tools/src/media/image-to-text.ts` 与测试：恢复可复用的 `image_path` / `image_url` / `prompt` 视觉模型工具，使用 `ToolContext.settings.model`，不恢复已删除的 `visionModel`。
- 修改 `packages/tools/src/media/image-generation.ts` 与测试：让可复用文生图定义使用调用上下文配置并安全处理错误。
- 修改 `packages/tools/src/registry.ts` 与测试：删除 `imageToText` 开关，默认不注册 `ImageToText` 或 `ImageGeneration`。

### `@vykor/server`

- 创建 `packages/server/src/application/attachment-tools/attachment-access.ts`：server 私有类型、Child → Root 解析器、文本/OCR 的 session 引用授权边界。
- 创建 `packages/server/src/application/attachment-tools/attachment-uri.ts`：严格解析 `attachment://<assetId>/<displayName>`。
- 创建 `packages/server/src/application/attachment-tools/attachment-read-tool.ts`：覆盖 `Read`，附件 URI 走 server reader，普通路径委托默认 `fileReadTool`。
- 创建 `packages/server/src/application/attachment-tools/attachment-image-to-text-tool.ts`：作为 daemon 普通 Tool 注册；`attachment_id` 走本地 OCR，路径/URL 委托可复用 `imageToTextTool`。
- 创建对应 `__test__` 文件：分别验证路由、参数、Root/Child/嵌套 Child、关闭 Child 和跨 session 拒绝。
- 删除 `packages/server/src/application/attachment-resource/agent-attachment-resource-host.ts` 及测试。
- 删除 `packages/server/src/application/attachment-processing/agent-image-to-text-host.ts` 及测试。
- 修改 `packages/server/src/daemon/daemon-agent.ts` 与测试：通过 `tools`、`toolOverrides` 和 `trustedToolOverrides` 装配，不再注入附件 Capability、视觉 Capability 或目录。
- 修改 `packages/server/src/application/daemon-application.ts`：创建授权解析器，按服务配置注册 `ImageToText` / `ImageGeneration`，覆盖 `Read`，并向路由显式声明附件 OCR 是否安装。
- 修改 `packages/server/src/application/session/session-run-executor.ts` 与测试：不再读取 `inspection.capabilities.imageToText`。
- 修改 `packages/server/src/application/attachment-routing/attachment-routing-types.ts`、`attachment-capability-router.ts` 与测试：将 `imageToTextHostAvailable` 改为 `attachmentOcrAvailable`。
- 修改 `packages/server/src/application/attachment-resource/compact-attachment-catalog.ts` 与测试：改为构造通用 compact 章节，并承担附件专属限额和文案。
- 修改 `packages/server/src/application/agent/agent-pool.ts` 与测试：provider 只传 `supplementalSections` 和 `sessionMemory`。
- 修改 `packages/server/src/application/__test__/durable-agent-application.test.ts`：覆盖真实 Child 使用覆盖 Tool 读取 Root 附件、OCR 授权和 compact 回注。

### 文档

- 修改 `docs/agent-sdk.md`：删除附件/OCR Capability override，说明第一方可信 Tool 覆盖。
- 修改 `docs/agent-framework-capability-boundary.md`：将附件归为 daemon Tool 扩展，而非 Agent Capability。
- 修改 `docs/compact-service-design.md`：用 `supplementalSections` 替换 `attachmentCatalog`。
- 修改 `docs/superpowers/specs/2026-09-02-attachment-tool-overrides-design.md`：保持实现后的状态和实际 API 一致。

---

### 任务 1：第一方可信 Tool 覆盖

**文件：**

- 修改：`packages/agent-runtime/src/agent-options.ts`
- 修改：`packages/agent-runtime/src/default-runtime.ts`
- 修改：`packages/agent-runtime/src/default-runtime.test.ts`
- 修改：`packages/agent-runtime/src/child-agent-options.ts`
- 修改：`packages/agent-runtime/src/child-agent-options.test.ts`

- [x] **步骤 1：为配置校验写失败测试**

在 `default-runtime.test.ts` 使用已有的 `BASE_SETTINGS` 增加以下断言：

```ts
it("rejects a trusted name that is not part of toolOverrides", async () => {
  await expect(createVykorRuntime({
    settings: BASE_SETTINGS,
    configuration: {
      client: {
        async *streamMessage() {
          yield { type: "complete" as const, stopReason: "end_turn" as const };
        },
      },
      trustedToolOverrides: ["Read"],
    },
  })).rejects.toThrow(
    'Trusted Tool override "Read" must appear in toolOverrides',
  );
});

```

现有装配规则已经保证 `toolOverrides` 只能指向默认 Registry 中存在的 builtin；不要为了构造“不覆盖 builtin”的不可达状态增加测试后门。可信名称只需额外验证它确实属于本次 `toolOverrides`。

- [x] **步骤 2：运行测试，确认新字段和校验尚不存在**

运行：

```bash
pnpm --filter @vykor/agent-runtime test -- src/default-runtime.test.ts
```

预期：FAIL，原因是 `trustedToolOverrides` 尚未进入配置或无对应校验错误。

- [x] **步骤 3：声明配置并在应用覆盖前验证来源**

在 `VykorAgentConfiguration` 增加：

```ts
/** First-party overrides that retain the replaced builtin's permission classification. */
trustedToolOverrides?: string[];
```

让 `applyConfiguredTools()` 返回可信覆盖名称，并在真正 `override()` 之前验证：

```ts
function applyConfiguredTools(
  registry: IToolRegistry,
  configuration: VykorAgentConfiguration,
): ReadonlySet<string> {
  const overrideNames = assertUniqueToolNames(
    configuration.toolOverrides ?? [],
    "toolOverrides",
  );
  const trustedNames = new Set(configuration.trustedToolOverrides ?? []);

  for (const name of trustedNames) {
    if (!overrideNames.has(name)) {
      throw new Error(
        `Trusted Tool override "${name}" must appear in toolOverrides`,
      );
    }
    if (registry.inspect(name)?.source.kind !== "builtin") {
      throw new Error(
        `Trusted Tool override "${name}" must replace a builtin Tool`,
      );
    }
  }

  // 保留现有 additions/overrides 原子校验和应用顺序。
  return trustedNames;
}
```

计算权限信任集合时包含该返回值：

```ts
const trustedOverrides = applyConfiguredTools(baseToolRegistry, configuration);
const trustedBuiltinToolNames = new Set(
  baseToolRegistry.getAll()
    .filter((tool) =>
      baseToolRegistry.inspect(tool.name)?.source.kind === "builtin" ||
      trustedOverrides.has(tool.name)
    )
    .map((tool) => tool.name),
);
```

不要把它加入 `autoApproveTools`；继续交给 `PermissionChecker` 的 cwd 内本地只读规则。

- [x] **步骤 4：写可信和不可信 `Read` 的权限回归测试**

使用一个同名 override，分别创建未信任和已信任 runtime：

```ts
const readOverride = testTool("Read");

// 未声明可信：cwd 内也应 ask。
expect(await untrusted.permissionChecker.checkTool("Read", {
  file_path: join(TEST_CWD, "notes.txt"),
})).toMatchObject({ action: "ask" });

// 第一方可信：cwd 内 allow，cwd 外仍 ask。
expect(await trusted.permissionChecker.checkTool("Read", {
  file_path: join(TEST_CWD, "notes.txt"),
})).toMatchObject({ action: "allow" });
expect(await trusted.permissionChecker.checkTool("Read", {
  file_path: resolve(TEST_CWD, "..", "secret.txt"),
})).toMatchObject({ action: "ask" });
```

同时增加 `attachment://att-1/notes.txt` 的 allow 断言，锁定第一方只读资源 URI 行为；deny/path deny 的现有优先级测试必须继续通过。

- [x] **步骤 5：让 Child 只读继承 Root 信任声明**

在 `deriveChildAgentOptions()` 明确复制：

```ts
trustedToolOverrides: configuration.trustedToolOverrides,
```

在 `child-agent-options.test.ts` 的父配置加入 `trustedToolOverrides: ["Read"]`，断言 Child 得到相同数组引用或相同内容；Child 输入结构没有追加可信名称的字段。

- [x] **步骤 6：运行 Agent Runtime 定向测试**

运行：

```bash
pnpm --filter @vykor/agent-runtime test -- src/default-runtime.test.ts src/child-agent-options.test.ts
pnpm --filter @vykor/agent-runtime check-types
```

预期：全部 PASS。

- [x] **步骤 7：提交可信覆盖能力**

```bash
git add -- packages/agent-runtime/src/agent-options.ts packages/agent-runtime/src/default-runtime.ts packages/agent-runtime/src/default-runtime.test.ts packages/agent-runtime/src/child-agent-options.ts packages/agent-runtime/src/child-agent-options.test.ts
git diff --cached --check
git diff --cached --stat
git commit -m "feat(agent-runtime): trust first-party tool overrides"
```

---

### 任务 2：恢复纯本地 `Read` 并从默认 Registry 移除视觉 Tool

**文件：**

- 修改：`packages/tools/src/file/read.ts`
- 修改：`packages/tools/src/file/__test__/read.test.ts`
- 删除：`packages/tools/src/file/attachment-uri.ts`
- 修改：`packages/tools/src/file/index.ts`（仅当它导出了附件 URI helper）
- 修改：`packages/tools/src/media/image-to-text.ts`
- 修改：`packages/tools/src/media/__test__/image-to-text.test.ts`
- 修改：`packages/tools/src/media/image-generation.ts`
- 创建：`packages/tools/src/media/__test__/image-generation.test.ts`
- 修改：`packages/tools/src/registry.ts`
- 修改：`packages/tools/src/__test__/registry.test.ts`

- [x] **步骤 1：把 `Read` 测试改成纯本地契约并确认失败**

删除测试中对 `context.attachments` 的 stub，加入：

```ts
it("does not advertise the daemon attachment protocol", () => {
  expect(fileReadTool.description).not.toContain("attachment://");
  const schema = fileReadTool.inputSchema as any;
  expect(schema.properties.file_path.description).not.toContain("attachment://");
});

it("treats attachment URIs as ordinary invalid local paths", async () => {
  const result = await fileReadTool.execute(
    { file_path: "attachment://att-1/notes.txt" },
    { cwd: testRoot } as any,
  );
  expect(result).toMatchObject({ isError: true });
});
```

运行：

```bash
pnpm --filter @vykor/tools test -- src/file/__test__/read.test.ts
```

预期：FAIL，当前描述仍宣称支持附件，并尝试读取 `context.attachments`。

- [x] **步骤 2：删除 `Read` 的附件分支**

从 `read.ts` 删除：

- `isAttachmentUri` / `parseAttachmentUri` 导入；
- `MAX_ATTACHMENT_READ_LINES`；
- `context.attachments.readText()` 分支；
- `validateAttachmentRange()`。

将描述恢复为只读本地文件和目录。保留现有 `resolveToolPath`、sandbox guard、目录排序、分页和行号逻辑。删除不再使用的 `attachment-uri.ts`；当前 `file/index.ts` 没有导出该 helper，无需修改。

- [x] **步骤 3：为视觉模型版 `ImageToText` 写失败测试**

替换当前 Host OCR 测试，至少覆盖：

```ts
it("sends a local image and prompt to an OpenAI-compatible vision endpoint", async () => {
  vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
    const body = JSON.parse(String(init?.body));
    expect(body.model).toBe("vision-main");
    expect(body.messages[0].content).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "image_url" }),
      { type: "text", text: "Extract every visible word." },
    ]));
    return new Response(JSON.stringify({
      choices: [{ message: { content: "invoice 123" } }],
    }), { status: 200 });
  }));

  const result = await imageToTextTool.execute(
    { image_path: imagePath, prompt: "Extract every visible word." },
    { cwd: testRoot, settings: openAiSettings("vision-main") } as any,
  );
  expect(result.content).toEqual([{ type: "text", text: "invoice 123" }]);
});
```

另写 Anthropic URL 输入、二选一校验、拒绝 `attachment_id`、缺少 settings、60 秒超时/取消、Provider 错误正文截断和不泄漏 API key 的测试。

运行：

```bash
pnpm --filter @vykor/tools test -- src/media/__test__/image-to-text.test.ts
```

预期：FAIL，当前 Tool 只接受本地 OCR Host，拒绝 prompt。

- [x] **步骤 4：实现最小视觉模型 Tool**

输入 Schema 固定为：

```ts
{
  image_path?: string;
  image_url?: string;
  prompt?: string;
}
```

实现规则：

```ts
const settings = context.settings;
if (!settings) return configurationError();
const model = settings.model; // 不重新引入 visionModel
const prompt = parsed.prompt ?? "Describe this image in detail.";
```

本地文件只接受 `jpg/jpeg/png/gif/webp`，读取后按 API 格式构造 Data URL 或 Anthropic base64 source；URL 必须是 HTTP(S)。OpenAI-compatible 请求发送到 `${baseUrl}/v1/chat/completions`，Anthropic 请求发送到 `${baseUrl}/v1/messages`。使用 `createToolAbortScope(context.abortSignal, 60_000)`；返回错误时只保留状态码和安全截断后的正文，不拼接 headers 或 API key。

- [x] **步骤 5：让默认 Registry 不包含视觉 Tool**

删除 `createDefaultToolRegistry()` options 中的：

```ts
imageToText?: boolean;
```

删除默认注册 `imageToTextTool` 和 `imageGenerationTool`。更新 registry 测试，断言默认名称集合不包含 `ImageToText` 或 `ImageGeneration`；视觉定义仍从 `@vykor/tools` 导出，供 daemon 显式装配。

- [x] **步骤 6：用失败测试锁定文生图上下文配置和安全错误**

为 `imageGenerationTool` 增加测试，断言它使用 `ToolContext.settings`，不读取进程级 settings 缓存；取消信号能中止请求；Provider 错误正文被截断且不泄漏 API key。先运行该测试并确认当前全局缓存实现导致失败，再做最小修改。

- [x] **步骤 7：运行 Tools 全包测试和类型检查**

```bash
pnpm --filter @vykor/tools test
pnpm --filter @vykor/tools check-types
```

预期：全部 PASS；搜索生产代码时，`packages/tools/src` 中不存在 `context.attachments`、`context.imageToText` 或 `attachment_id`。

- [x] **步骤 8：提交默认 Tool 边界调整**

```bash
git add -- packages/tools/src/file/read.ts packages/tools/src/file/__test__/read.test.ts packages/tools/src/file/attachment-uri.ts packages/tools/src/media/image-to-text.ts packages/tools/src/media/__test__/image-to-text.test.ts packages/tools/src/media/image-generation.ts packages/tools/src/media/__test__/image-generation.test.ts packages/tools/src/registry.ts packages/tools/src/__test__/registry.test.ts
git diff --cached --check
git diff --cached --stat
git commit -m "refactor(tools): keep visual tools out of default registry"
```

---

### 任务 3：建立 server 私有附件访问边界和覆盖 Tool

**文件：**

- 创建：`packages/server/src/application/attachment-tools/attachment-access.ts`
- 创建：`packages/server/src/application/attachment-tools/attachment-uri.ts`
- 创建：`packages/server/src/application/attachment-tools/attachment-read-tool.ts`
- 创建：`packages/server/src/application/attachment-tools/attachment-image-to-text-tool.ts`
- 创建：`packages/server/src/application/attachment-tools/__test__/attachment-access.test.ts`
- 创建：`packages/server/src/application/attachment-tools/__test__/attachment-read-tool.test.ts`
- 创建：`packages/server/src/application/attachment-tools/__test__/attachment-image-to-text-tool.test.ts`

- [x] **步骤 1：先写 Child → Root 解析器失败测试**

使用带 `parentId` 的持久 session 和 `LiveChildAgentDirectory` stub 锁定：

```ts
expect(resolver.resolve("root-1")).toBe("root-1");
expect(resolver.resolve("child-live")).toBe("root-1");
expect(resolver.resolve("nested-live")).toBe("root-1");
expect(resolver.resolve("child-closed")).toBeUndefined();
expect(resolver.resolve("missing")).toBeUndefined();
```

其中 `child-closed` 在 Store 中存在且有 `parentId`，但不在 live directory；不得退回自身或父 ID。

运行：

```bash
pnpm --filter @vykor/server test -- src/application/attachment-tools/__test__/attachment-access.test.ts
```

预期：FAIL，模块尚不存在。

- [x] **步骤 2：实现 server 私有接口和授权解析器**

在 `attachment-access.ts` 定义规格中的三个接口：

```ts
export interface AttachmentAuthorizationSessionResolver {
  resolve(executionSessionId: string): string | undefined;
}

export interface AttachmentTextSlice {
  displayName: string;
  mediaType: string;
  encoding: "utf-8" | "utf-16le" | "utf-16be";
  content: string;
  startLine: number;
  endLine: number;
  hasMore: boolean;
}

export type AttachmentOcrResult = LocalOcrResult & { assetId: string };

export interface AttachmentTextReader {
  readText(input: {
    authorizationSessionId: string;
    assetId: string;
    offset: number;
    limit: number;
    signal?: AbortSignal;
  }): Promise<AttachmentTextSlice>;
}

export interface AttachmentOcrService {
  recognize(input: {
    authorizationSessionId: string;
    assetId: string;
    signal?: AbortSignal;
  }): Promise<AttachmentOcrResult>;
}
```

解析实现只允许两类映射：live directory 明确返回 Root；或 Store 中 `parentId` 为空的普通 session 返回自身。未知 session和非 live Child 返回 `undefined`。

- [x] **步骤 3：写 reader 和 OCR service 的 session 引用授权测试**

建立 Root A、Root B、live Child A 和同一个图片/文本 asset，断言：

```ts
await expect(textReader.readText({
  authorizationSessionId: "root-a",
  assetId: textAsset.id,
  offset: 1,
  limit: 20,
})).resolves.toMatchObject({ content: "root text" });

await expect(textReader.readText({
  authorizationSessionId: "root-b",
  assetId: textAsset.id,
  offset: 1,
  limit: 20,
})).rejects.toThrow("attachment_resource_access_denied");

await expect(ocr.recognize({
  authorizationSessionId: "root-b",
  assetId: imageAsset.id,
})).rejects.toThrow("attachment_resource_access_denied");
expect(localOcrRecognize).not.toHaveBeenCalled();
```

同时覆盖文本类型、图片类型、ready 状态、offset/limit 1..2000 和 AbortSignal。

- [x] **步骤 4：实现严格附件 URI parser**

把原 Tools parser 的合法格式迁入 server：assetId 只允许 `[A-Za-z0-9._-]+`，URI 不允许 query、fragment、userinfo、port、解码后的 `/`、`\`、`.` 或 `..`。增加逐项拒绝测试。

- [x] **步骤 5：先写附件版 `Read` Tool 测试**

测试必须断言普通路径委托原 Tool，附件 URI 先解析执行 session，再向 reader 传授权 Root：

```ts
expect(resolve).toHaveBeenCalledWith("child-live");
expect(readText).toHaveBeenCalledWith({
  authorizationSessionId: "root-a",
  assetId: "att-1",
  offset: 2,
  limit: 10,
  signal,
});
expect(defaultTool.execute).not.toHaveBeenCalled();
```

缺少 `context.sessionId`、resolver 返回 undefined、非法 URI 和范围错误都返回 `isError: true`，且不调用 reader。

- [x] **步骤 6：实现附件版 `Read` Tool**

Schema 保持默认字段，但 description 扩展 `attachment://`。普通路径执行：

```ts
return await options.defaultTool.execute(input, context);
```

附件路径执行 server parser、resolver 和 reader，并沿用当前带行号及 `has_more` 的结果格式。

- [x] **步骤 7：先写并实现 daemon 版 `ImageToText` Tool**

Schema 用 `oneOf` 表达：

```ts
{ required: ["attachment_id"] }
// 或 image_path/image_url 二选一，prompt 可选
```

`attachment_id` 与 `image_path`、`image_url`、`prompt` 同时出现时返回命令错误。附件分支断言 resolver 收到实际 Child sessionId、OCR service 收到 Root sessionId；普通路径/URL完整委托明确传入的可复用视觉 Tool 定义。OCR 输出保留不可信内容边界和 `attachmentOcr` metadata。该 Tool 后续通过 daemon 的普通 `tools` 注册，不使用 `toolOverrides`。

- [x] **步骤 8：运行 server 新模块测试和类型检查**

```bash
pnpm --filter @vykor/server test -- src/application/attachment-tools/__test__/attachment-access.test.ts src/application/attachment-tools/__test__/attachment-read-tool.test.ts src/application/attachment-tools/__test__/attachment-image-to-text-tool.test.ts
pnpm --filter @vykor/server check-types
```

预期：全部 PASS。

- [x] **步骤 9：提交 server 附件 Tool 基础设施**

```bash
git add -- packages/server/src/application/attachment-tools
git diff --cached --check
git diff --cached --stat
git commit -m "feat(server): add session-authorized attachment tools"
```

---

### 任务 4：daemon 改用 Tool 覆盖

**文件：**

- 修改：`packages/server/src/daemon/daemon-agent.ts`
- 修改：`packages/server/src/daemon/__test__/daemon-agent.test.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/application/session/session-run-executor.ts`
- 修改：`packages/server/src/application/session/__test__/session-run-executor.test.ts`
- 修改：`packages/server/src/application/attachment-routing/attachment-routing-types.ts`
- 修改：`packages/server/src/application/attachment-routing/attachment-capability-router.ts`
- 修改：`packages/server/src/application/attachment-routing/__test__/attachment-capability-router.test.ts`
- 修改：`packages/server/src/application/__test__/durable-agent-application.test.ts`
- 删除：`packages/server/src/application/attachment-resource/agent-attachment-resource-host.ts`
- 删除：`packages/server/src/application/attachment-resource/__test__/agent-attachment-resource-host.test.ts`
- 删除：`packages/server/src/application/attachment-processing/agent-image-to-text-host.ts`
- 删除：`packages/server/src/application/attachment-processing/__test__/agent-image-to-text-host.test.ts`

- [x] **步骤 1：修改 daemon loader 测试，要求普通 Tool 配置接线**

在 `daemon-agent.test.ts` 将旧 Host 断言替换成：

```ts
expect(capturedOptions.tools?.map((tool) => tool.name))
  .toEqual(["ImageToText", "ImageGeneration"]);
expect(capturedOptions.toolOverrides?.map((tool) => tool.name))
  .toEqual(["Read"]);
expect(capturedOptions.trustedToolOverrides).toEqual(["Read"]);
expect(capturedOptions.capabilityOverrides).not.toHaveProperty("attachments");
expect(capturedOptions.capabilityOverrides).not.toHaveProperty("imageToText");
expect(capturedOptions).not.toHaveProperty("attachmentResourceRoot");
```

运行该文件确认失败。

- [x] **步骤 2：给 daemon loader 增加第一方 Tool 配置输入**

`DaemonAgentLoaderOptions` 增加：

```ts
tools?: ToolDefinition[];
toolOverrides?: ToolDefinition[];
trustedToolOverrides?: string[];
```

删除 `imageToText`、`attachments`、`attachmentResourceRoot`。构造 `VykorAgentOptions` 时直接传递 `tools`、`toolOverrides`、`trustedToolOverrides`，不放进 `capabilityOverrides`。

- [x] **步骤 3：在 DaemonApplication 创建共享服务和覆盖 Tool**

用同一个 resolver 构造两工具：

```ts
const authorizationSessions = createAttachmentAuthorizationSessionResolver({
  store,
  liveChildren: this.liveChildren,
});
const attachmentReader = createAttachmentTextReader({
  store,
  attachments: this.attachments,
});
const attachmentOcr = createAttachmentOcrService({
  store,
  attachments: this.attachments,
  recognize: (input) => this.localOcr.recognize(input),
});

tools: [
  createAttachmentImageToTextTool({
    defaultTool: imageToTextTool,
    authorizationSessions,
    attachmentOcr,
  }),
  imageGenerationTool,
],
toolOverrides: [
  createAttachmentReadTool({
    defaultTool: fileReadTool,
    authorizationSessions,
    attachmentReader,
  }),
],
trustedToolOverrides: ["Read"],
```

`tools` 必须按实际服务配置构造：图像读取/OCR 服务不可用时不加入 `ImageToText`，图片生成服务不可用时不加入 `ImageGeneration`。

在 daemon 测试中分别覆盖完整配置、仅 OCR、仅图片生成和两者都未配置，断言最终工具清单与服务事实一致。

删除旧 Host 和附件目录准备函数的装配。

- [x] **步骤 4：把路由能力判断改为 server 事实**

把 `imageToTextHostAvailable` 和错误码 `attachment_ocr_host_unavailable` 改名为 `attachmentOcrAvailable` / `attachment_ocr_unavailable`。`SessionRunExecutorContext` 增加明确布尔值：

```ts
attachmentOcrAvailable?: boolean;
```

路由输入使用：

```ts
attachmentOcrAvailable: this.context.attachmentOcrAvailable === true,
```

不再读取 `inspection.capabilities.imageToText`；工具过滤仍由 `availableTools` 判断 `ImageToText` 是否可见。

- [x] **步骤 5：迁移 durable Child 集成测试**

更新现有真实 Child 测试，不再从 `capabilityOverrides.attachments` 抓 Host。让模型实际调用覆盖后的 `Read`，保留以下断言：

- live Child 读到 Root 附件；
- Tool event 的 `sessionId` 仍是 Child；
- 关闭 Child 后直接执行覆盖 Tool 会被拒绝；
- 其他 Root session 不能读取该附件。

增加图片等价测试：另一个 Root 的 `attachment_id` 在调用 Local OCR 前失败，并断言 OCR spy 未调用。

- [x] **步骤 6：删除旧 Host 适配器和测试**

确认生产引用已清零后删除四个旧文件。执行：

```bash
rg -n "AgentAttachmentResourceHost|AgentImageToTextHost|createAgentAttachmentResourceHost|createAgentImageToTextHost" packages/server/src
```

预期：无结果。

- [x] **步骤 7：运行 server 定向与全包测试**

```bash
pnpm --filter @vykor/server test -- src/daemon/__test__/daemon-agent.test.ts src/application/session/__test__/session-run-executor.test.ts src/application/attachment-routing/__test__/attachment-capability-router.test.ts src/application/__test__/durable-agent-application.test.ts
pnpm --filter @vykor/server test
pnpm --filter @vykor/server check-types
```

预期：全部 PASS。

- [x] **步骤 8：提交 daemon 迁移**

```bash
git add -- packages/server/src/daemon/daemon-agent.ts packages/server/src/daemon/__test__/daemon-agent.test.ts packages/server/src/application/daemon-application.ts packages/server/src/application/session/session-run-executor.ts packages/server/src/application/session/__test__/session-run-executor.test.ts packages/server/src/application/attachment-routing packages/server/src/application/__test__/durable-agent-application.test.ts packages/server/src/application/attachment-resource/agent-attachment-resource-host.ts packages/server/src/application/attachment-resource/__test__/agent-attachment-resource-host.test.ts packages/server/src/application/attachment-processing/agent-image-to-text-host.ts packages/server/src/application/attachment-processing/__test__/agent-image-to-text-host.test.ts
git diff --cached --check
git diff --cached --stat
git commit -m "feat(server): install attachment-aware tool overrides"
```

---

### 任务 5：删除 Core 与 Agent Runtime 的附件 Capability

**文件：**

- 修改：`packages/core/src/types/tools.ts`
- 修改：`packages/core/src/types/runtime.ts`
- 修改：`packages/core/src/engine/query-engine.ts`
- 修改：`packages/core/src/engine/integration.test.ts`（若 fixture 实现 setter）
- 修改：`packages/core/src/index.ts`
- 修改：`packages/agent-runtime/src/agent-options.ts`
- 修改：`packages/agent-runtime/src/capability-resolution.ts`
- 修改：`packages/agent-runtime/src/capability-resolution.test.ts`
- 修改：`packages/agent-runtime/src/default-agent-capabilities.ts`
- 修改：`packages/agent-runtime/src/kernel.ts`
- 修改：`packages/agent-runtime/src/kernel.test.ts`
- 修改：`packages/agent-runtime/src/default-runtime.ts`
- 修改：`packages/agent-runtime/src/default-runtime.test.ts`
- 修改：`packages/agent-runtime/src/agent.ts`
- 修改：`packages/agent-runtime/src/agent-composition.ts`
- 修改：`packages/agent-runtime/src/child-agent.test.ts`

- [x] **步骤 1：先把类型/快照测试改成目标形状**

在 `capability-resolution.test.ts` 删除附件和 imageToText fixture，断言快照只包含：

```ts
expect(Object.keys(snapshot).sort()).toEqual([
  "backgroundShell",
  "childEnvironment",
  "jobs",
  "memory",
  "schedules",
  "terminal",
  "workflowRepository",
].sort());
```

在 QueryEngine 相关测试增加 ToolContext 捕获，断言：

```ts
expect(context).not.toHaveProperty("attachments");
expect(context).not.toHaveProperty("imageToText");
```

运行 core 与 agent-runtime 定向测试，确认旧字段仍存在导致失败。

- [x] **步骤 2：删除 core 公共 Host 类型和 QueryEngine 接线**

从 `types/tools.ts` 删除：

```text
AgentImageToTextInput
AgentImageToTextResult
AgentImageToTextHost
AgentAttachmentTextSlice
AgentAttachmentResourceHost
ToolContext.imageToText
ToolContext.attachments
```

从 runtime interface、QueryEngine 字段/setter/context 构造和 `core/index.ts` 导出中同步删除。

- [x] **步骤 3：删除 Agent Capability 解析和 Kernel 接线**

从 `AgentCapabilityOverrides`、`ResolvedAgentCapabilities`、snapshot、default resolver 和 Kernel 删除两个能力。更新 `child-agent.test.ts`：不再测试借用 attachment Host；改为断言 `toolOverrides`、`trustedToolOverrides` 和 effects 向 Child 继承，而 Host cleanup 不涉及 ToolDefinition。

- [x] **步骤 4：删除附件目录配置和 sandbox mount**

删除：

```text
VykorAgentOptions.attachmentResourceRoot
AgentCompositionOptions.attachmentResourceRoot
VykorRuntimeOptions.attachmentResourceRoot
attachSandboxRuntime(..., attachmentResourceRoot)
managedReadOnlyMounts 中的附件 mount
```

删除 `default-runtime.test.ts` 中只验证该 mount 的测试。保留正常 sandbox 启停测试。

- [x] **步骤 5：确认生产代码没有 Agent 附件能力残留**

```bash
rg -n "AgentAttachmentResourceHost|AgentImageToTextHost|setAttachments|setImageToText|attachmentResourceRoot|capabilities\.attachments|capabilities\.imageToText" packages/core/src packages/agent-runtime/src packages/server/src
```

预期：无结果。注意协议层 `features.attachments` 是客户端上传能力，不属于本次删除目标，不要删除。

- [x] **步骤 6：运行 core 与 agent-runtime 全包验证**

```bash
pnpm --filter @vykor/core test
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/core check-types
pnpm --filter @vykor/agent-runtime check-types
pnpm --filter @vykor/server check-types
```

预期：全部 PASS。

- [x] **步骤 7：提交 Capability 清理**

```bash
git add -- packages/core/src/types/tools.ts packages/core/src/types/runtime.ts packages/core/src/engine/query-engine.ts packages/core/src/engine/integration.test.ts packages/core/src/index.ts packages/agent-runtime/src/agent-options.ts packages/agent-runtime/src/capability-resolution.ts packages/agent-runtime/src/capability-resolution.test.ts packages/agent-runtime/src/default-agent-capabilities.ts packages/agent-runtime/src/kernel.ts packages/agent-runtime/src/kernel.test.ts packages/agent-runtime/src/default-runtime.ts packages/agent-runtime/src/default-runtime.test.ts packages/agent-runtime/src/agent.ts packages/agent-runtime/src/agent-composition.ts packages/agent-runtime/src/child-agent.test.ts
git diff --cached --check
git diff --cached --stat
git commit -m "refactor(agent-runtime): remove attachment capabilities"
```

提交前检查 cached stat，确保没有把 agent-runtime 中其他任务正在修改的文件误带入；若路径重叠，必须逐文件检查 `git diff --cached` 后再提交。

---

### 任务 6：compact 改为通用补充章节

**文件：**

- 修改：`packages/core/src/engine/compact-service.ts`
- 修改：`packages/core/src/engine/compact-service-advanced.test.ts`
- 修改：`packages/core/src/index.ts`
- 修改：`packages/agent-runtime/src/compact-context.ts`
- 修改：`packages/agent-runtime/src/compact-context.test.ts`
- 修改：`packages/server/src/application/attachment-resource/compact-attachment-catalog.ts`
- 修改：`packages/server/src/application/attachment-resource/__test__/compact-attachment-catalog.test.ts`
- 修改：`packages/server/src/application/agent/agent-pool.ts`
- 修改：`packages/server/src/application/agent/__test__/agent-pool.test.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/application/__test__/durable-agent-application.test.ts`

- [x] **步骤 1：写 core 通用章节失败测试**

将 attachment Catalog fixture 替换为：

```ts
supplementalSections: [
  {
    heading: "Conversation Attachments",
    content: "- attachment://att-1/notes.txt",
  },
],
```

断言 compact prompt 包含 heading/content，但 core 测试中不出现 `assetId` 字段结构、媒体类型分支或 `Use Read` 自动生成逻辑。

增加限额测试：9 节只保留前 8 节；heading 的 CR/LF 折叠为空格并截到 120 字符；单节截到 16,000；总计截到 32,000；空 heading/content 跳过。

- [x] **步骤 2：实现 `CompactContextSection` 和通用格式化**

删除 `CompactAttachmentCatalog`、`CompactAttachmentCatalogEntry`、`attachmentCatalog` 字段和 `formatAttachmentCatalog()`。增加：

```ts
export interface CompactContextSection {
  heading: string;
  content: string;
}

export interface CompactContext {
  // existing fields
  supplementalSections?: CompactContextSection[];
}
```

实现一个纯函数按规格的 8/120/16,000/32,000 限额生成：

```text
## <normalized heading>
<bounded content>
```

合并外部 context 时使用 `external.supplementalSections ?? context.supplementalSections`。

- [x] **步骤 3：更新 agent-runtime provider**

`CompactContextSources` 改为：

```ts
export interface CompactContextSources {
  supplementalSections?: CompactContextSource<"supplementalSections">;
  sessionMemory?: CompactContextSource<"sessionMemory">;
}
```

测试同时、单独和 undefined 三种来源，不再导入 core 附件类型。

- [x] **步骤 4：把 server Catalog formatter 变成章节 builder**

保留附件专属的 20 条、每个 preview 1,000 字符、Catalog 总计 12,000 字符限制，但返回：

```ts
CompactContextSection | undefined
```

建议公开函数改名：

```ts
buildCompactAttachmentSection(store, sessionId, options)
```

该 server 函数负责生成 `Conversation Attachments` heading、`attachment://`、`Read` / `ImageToText` 提示、不可信 preview 边界和 omitted 计数。没有条目时返回 `undefined`。

- [x] **步骤 5：更新 AgentPool 与 daemon provider**

`AgentPoolContext` 将 `attachmentCatalog` 改为：

```ts
supplementalSections?(
  sessionId: string,
): CompactContextSection[] | Promise<CompactContextSection[]>;
```

daemon provider 调用 server builder，并把有值的单节包装成数组。与 `sessionMemory` 同时回传，验证 compact prompt 同时包含附件章节和 checkpoint。

- [x] **步骤 6：运行三包定向测试**

```bash
pnpm --filter @vykor/core test -- src/engine/compact-service-advanced.test.ts
pnpm --filter @vykor/agent-runtime test -- src/compact-context.test.ts
pnpm --filter @vykor/server test -- src/application/attachment-resource/__test__/compact-attachment-catalog.test.ts src/application/agent/__test__/agent-pool.test.ts src/application/__test__/durable-agent-application.test.ts
pnpm --filter @vykor/core check-types
pnpm --filter @vykor/agent-runtime check-types
pnpm --filter @vykor/server check-types
```

预期：全部 PASS。

- [x] **步骤 7：确认 core/agent-runtime 不含附件 compact 类型**

```bash
rg -n "CompactAttachmentCatalog|attachmentCatalog|Conversation Attachments|attachment://" packages/core/src packages/agent-runtime/src
```

预期：无结果；附件文案只存在于 server。

- [x] **步骤 8：提交 compact 边界迁移**

```bash
git add -- packages/core/src/engine/compact-service.ts packages/core/src/engine/compact-service-advanced.test.ts packages/core/src/index.ts packages/agent-runtime/src/compact-context.ts packages/agent-runtime/src/compact-context.test.ts packages/server/src/application/attachment-resource/compact-attachment-catalog.ts packages/server/src/application/attachment-resource/__test__/compact-attachment-catalog.test.ts packages/server/src/application/agent/agent-pool.ts packages/server/src/application/agent/__test__/agent-pool.test.ts packages/server/src/application/daemon-application.ts packages/server/src/application/__test__/durable-agent-application.test.ts
git diff --cached --check
git diff --cached --stat
git commit -m "refactor(compact): move attachment context to server"
```

---

### 任务 7：文档收口与全量验证

**文件：**

- 修改：`docs/agent-sdk.md`
- 修改：`docs/agent-framework-capability-boundary.md`
- 修改：`docs/compact-service-design.md`
- 修改：`docs/superpowers/specs/2026-09-02-attachment-tool-overrides-design.md`
- 修改：`docs/superpowers/plans/2026-09-02-attachment-tool-overrides.md`（只勾选已完成步骤和记录实际命令）

- [x] **步骤 1：更新当前架构文档**

文档必须明确：

```text
DefaultNodeAgent
  Read(local only)
  no ImageToText / ImageGeneration

Daemon
  trusted Read override -> attachment text
  ImageToText tool -> path/URL vision + attachment local OCR
  ImageGeneration tool -> configured image provider
  supplemental compact section -> attachment resume hints
```

从 agent SDK/Capability 文档删除 `attachments`、`imageToText` 和 `attachmentResourceRoot`；保留客户端/协议的附件上传能力说明。说明 `trustedToolOverrides` 仅由第一方 Agent 创建者显式使用，第三方集成没有入口。

- [x] **步骤 2：做残留搜索**

```bash
rg -n "AgentAttachmentResourceHost|AgentImageToTextHost|setAttachments|setImageToText|attachmentResourceRoot|CompactAttachmentCatalog|attachmentCatalog|imageToTextHostAvailable" packages docs/agent-sdk.md docs/agent-framework-capability-boundary.md docs/compact-service-design.md
```

预期：生产代码与这三份当前文档无结果。历史 specs/plans 可以保留历史记录，不为通过搜索而改写已完成的旧阶段文档。

再运行：

```bash
rg -n "context\.attachments|context\.imageToText|capabilities\.attachments|capabilities\.imageToText" packages
```

预期：无结果。

- [x] **步骤 3：运行四个核心包的全包测试**

```bash
pnpm --filter @vykor/core test
pnpm --filter @vykor/tools test
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/server test
```

预期：全部 PASS。Windows 上若出现 node-pty `AttachConsole failed` 噪音，以测试进程退出码和 Vitest 汇总为准，并在交接记录中说明。

- [x] **步骤 4：运行全仓类型、测试和文档检查**

```bash
pnpm check-types
pnpm test
pnpm check-docs
git diff --check
```

预期：所有命令退出码为 0。若 `pnpm test` 因当前工作区其他任务的未提交代码失败，先用 `git status --short` 和失败文件确认归属；不得修改或回退无关改动。

- [x] **步骤 5：检查提交范围和实现事实**

```bash
git status --short
git log --oneline --decorate -12
git diff HEAD~6..HEAD --stat
```

确认每个实现提交只包含本计划文件；确认没有意外删除客户端附件、协议 attachment part、上传 API、SessionStore 附件表或 LocalOcrService。

- [x] **步骤 6：提交文档收口**

```bash
git add -- docs/agent-sdk.md docs/agent-framework-capability-boundary.md docs/compact-service-design.md docs/superpowers/specs/2026-09-02-attachment-tool-overrides-design.md docs/superpowers/plans/2026-09-02-attachment-tool-overrides.md
git diff --cached --check
git diff --cached --stat
git commit -m "docs(agent-runtime): document server-owned attachments"
```

- [x] **步骤 7：按 verification-before-completion 做最终证据复核**

重新运行最后一次会受文档提交影响的轻量验证：

```bash
pnpm check-docs
git diff --check
git status --short
```

最终报告列出：实现提交、四包测试数量、全仓类型检查任务数、全仓测试结果、已保留的无关工作区改动，以及未执行 push。

## 执行记录

- 实现提交：`5ccc8573`、`7cd78810`、`1eac4fde`、`c6a1ed8f`、`4251cccb`、`7f2603b4`；边界文档提交：`1fb7a7c7`。
- 四个核心包全包测试通过：core 112、tools 191、agent-runtime 162、server 434。
- `pnpm check-types` 通过：57/57 tasks。
- `pnpm test` 在全仓高并发运行时退出 1：sandbox 两个 5 秒超时、plugin-converters 一个 20 秒超时，agent-runtime worktree 清理出现超时/临时目录占用；相关包降低并发单独重跑后，plugin-converters 6/6、sandbox 58/58（另 11 skipped）、agent-runtime 162/162 均通过。未修改这些无关测试的超时配置。
- `pnpm check-docs` 保留既有失败：`docs/contract-test-index.md:55` 指向不存在的 `../tests/browser-client/vite.config.ts`，不属于本计划改动。
- 残留搜索只命中 daemon 测试对旧字段“不存在”的回归断言，以及协议层合法的客户端附件 capability；生产 core/agent-runtime 没有附件 Host、视觉 Host 或附件 compact 类型。
- 客户端附件上传、协议 attachment part、上传 API、SessionStore 附件记录、Blob 存储和 `LocalOcrService` 均保留；未执行 push。
