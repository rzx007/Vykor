# 供应商请求头模板实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用
> superpowers:subagent-driven-development（推荐）或
> superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法
> 跟踪进度。

**目标：** 让真正的自定义供应商和已连接的 models.dev 目录供应商通过
`Settings.customProviders[].headers` 配置静态或动态请求头，并在造客户端时统一
展开 `{{sessionId}}`、`{{userAgent}}`，替换当前 OpenCode Go 专用适配。

**架构：** `@vykor/api` 提供无供应商知识的请求头规范化与模板展开器；
Provider Service 负责保存模板，agent runtime 负责用稳定会话上下文展开，daemon
继续只向下传 `sessionId`。Desktop 的自定义供应商表单和目录供应商连接/请求头
界面保持独立，仅复用请求头行编辑组件。

**技术栈：** TypeScript、Vitest、OpenAI SDK、Hono、Electron IPC、React、
Base UI/shadcn 组件、pnpm workspace。

**规格：**
`docs/superpowers/specs/2026-09-16-provider-request-header-templates-design.md`

---

## 文件结构

### 新建

- `packages/api/src/providers/request-header-templates.ts`：请求头规范化、变量校验和
  模板展开；不读取 settings，不识别供应商。
- `packages/api/src/providers/request-header-templates.test.ts`：模板与 HTTP 请求头
  安全规则单元测试。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/request-header-form.ts`：
  Desktop 请求头行与 Record 之间的纯函数转换、表单级完整性校验。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/request-header-form.test.ts`：
  请求头表单转换测试。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/request-header-editor.tsx`：
  自定义和目录供应商表单共用的请求头行编辑组件。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/provider-connection-dialog.tsx`：
  可连接供应商对话框；仅目录供应商显示高级请求头。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/provider-connection-dialog.test.tsx`：
  目录与内置供应商连接界面的分流测试。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/catalog-provider-headers-dialog.tsx`：
  已连接目录供应商的请求头编辑对话框。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/catalog-provider-headers-dialog.test.tsx`：
  编辑和清空目录请求头测试。

### 修改

- `packages/api/src/index.ts`：导出通用请求头模板 API；待所有调用者迁移后移除
  OpenCode Go 专用导出。
- `packages/core/src/config/settings.ts`：项目设置合并时忽略
  `customProviders`。
- `packages/core/src/config/settings.test.ts`：证明 daemon、CLI 和 SDK 共用的
  `loadSettings` 结果始终使用用户级供应商清单。
- `packages/agent-runtime/src/default-runtime-provider.ts`：对当前
  `customProviders` 请求头统一展开后再构造 OpenAI client。
- `packages/agent-runtime/src/default-runtime-provider.test.ts`：把 OpenCode Go 特判
  测试改成自定义/目录供应商的通用行为测试。
- `packages/agent-runtime/src/default-runtime.ts`：继续把已建立的 session ID 传入
  `resolveApiClient`。
- `packages/server/src/daemon/__test__/daemon-agent.test.ts`：证明 durable session ID
  原样进入 runtime options。
- `packages/server/src/application/settings-api.ts`：定义目录连接和请求头更新契约。
- `packages/server/src/application/default-services/provider-service.ts`：保存、重连、
  清空目录请求头，并统一规范化自定义请求头。
- `packages/server/src/application/default-services/credential-validation.ts`：校验请求
  使用固定上下文展开模板。
- `packages/server/src/application/default-services/credential-validation.test.ts`：由
  Go 专用断言改成通用模板断言。
- `packages/server/src/application/__test__/default-application-services.test.ts`：覆盖
  自定义和目录供应商的持久化、三态更新和孤立凭证。
- `packages/server/src/http/routes/system.ts`：扩展目录连接请求体并新增目录请求头
  PATCH。
- `packages/server/src/http/__test__/http.test.ts`：覆盖 HTTP 契约与 runtime 全量关闭。
- `packages/client/src/types/index.ts`：导出目录连接/请求头更新输入类型。
- `packages/client/src/transport/http-client.ts`：发送目录请求头连接和更新请求。
- `packages/client/src/transport/__test__/http-client.test.ts`：断言 URL、method 和
  body。
- `apps/desktop/src/shared/provider-types.ts`：扩展连接输入，新增目录请求头更新输入。
- `apps/desktop/src/shared/ipc-channels.ts`：新增类型化 IPC channel。
- `apps/desktop/src/shared/desktop-api-contract.ts`：暴露更新目录请求头方法。
- `apps/desktop/src/preload/desktop-api.ts`：桥接新增 IPC。
- `apps/desktop/src/main/features/provider/ipc.ts`：注册新增 handler。
- `apps/desktop/src/main/features/provider/provider-service.ts`：转发 headers、更新目录
  请求头，并按“快照 + API Key”判定目录已连接。
- `apps/desktop/src/main/features/provider/provider-service.test.ts`：覆盖目录连接状态和
  main 层转发。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.ts`：
  使用通用请求头表单纯函数。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.test.ts`：
  保持原表单验证并覆盖模板原文。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-dialog.tsx`：
  使用共用编辑组件并补充明文存储说明。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-dialog.test.ts`：
  断言模板说明和回显。
- `apps/desktop/src/renderer/src/components/desktop/settings-page/provider-settings.tsx`：
  接入两个独立目录供应商对话框和已连接行操作。
- `docs/auth-provider-model.md`：记录模板变量、存储位置和内置供应商不支持的边界。

### 删除

- `packages/api/src/providers/opencode-go.ts`：删除供应商专用实现。
- `packages/api/src/providers/opencode-go.test.ts`：由通用模板测试取代。

---

## 任务 1：建立通用请求头模板内核

**文件：**

- 创建：`packages/api/src/providers/request-header-templates.ts`
- 创建：`packages/api/src/providers/request-header-templates.test.ts`
- 修改：`packages/api/src/index.ts`

- [ ] **步骤 1：把专用测试改写为模板契约的失败测试**

创建测试并覆盖以下公开 API：

```ts
import {
  VYKOR_USER_AGENT,
  RequestHeaderTemplateError,
  expandRequestHeaderTemplates,
  normalizeRequestHeaderTemplates,
} from "./request-header-templates.js";

it("expands every supported placeholder without mutating input", () => {
  const input = {
    "User-Agent": "{{userAgent}}",
    "x-session": "prefix-{{sessionId}}-{{sessionId}}",
    "X-Tenant": "desktop",
  };

  expect(expandRequestHeaderTemplates(input, {
    sessionId: "session-1",
    userAgent: VYKOR_USER_AGENT,
  })).toEqual({
    "User-Agent": "vykor/1.0",
    "x-session": "prefix-session-1-session-1",
    "X-Tenant": "desktop",
  });
  expect(input["x-session"]).toBe("prefix-{{sessionId}}-{{sessionId}}");
});

it.each([
  [{ "Bad Header": "value" }, "name"],
  [{ "X-Test": "line1\r\nline2" }, "value"],
  [{ "X-Test": "{{unknown}}" }, "unknown"],
  [{ "X-Test": "one", "x-test": "two" }, "duplicate"],
])("rejects unsafe or ambiguous headers", (headers, reason) => {
  expect(() => normalizeRequestHeaderTemplates(headers)).toThrow(
    RequestHeaderTemplateError,
  );
  expect(() => normalizeRequestHeaderTemplates(headers)).toThrow(reason);
});

it("requires a session only when the template references it", () => {
  expect(() =>
    expandRequestHeaderTemplates(
      { "X-Session": "{{sessionId}}" },
      { userAgent: VYKOR_USER_AGENT },
    ),
  ).toThrow("sessionId");
  expect(
    expandRequestHeaderTemplates(
      { "X-Static": "value" },
      { userAgent: VYKOR_USER_AGENT },
    ),
  ).toEqual({ "X-Static": "value" });
});
```

- [ ] **步骤 2：运行测试，确认因通用模块不存在而失败**

运行：

```bash
pnpm --filter @vykor/api test src/providers/request-header-templates.test.ts
```

预期：FAIL，提示无法解析 `./request-header-templates.js`。

- [ ] **步骤 3：实现最小、无供应商知识的模板模块**

实现并导出：

```ts
export const VYKOR_USER_AGENT = "vykor/1.0";
const SUPPORTED_VARIABLES = new Set(["sessionId", "userAgent"]);
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const TEMPLATE = /\{\{([^{}]+)\}\}/g;

export interface RequestHeaderTemplateContext {
  sessionId?: string;
  userAgent: string;
}

export class RequestHeaderTemplateError extends Error {
  constructor(
    message: string,
    readonly headerName?: string,
  ) {
    super(message);
    this.name = "RequestHeaderTemplateError";
  }
}
```

`normalizeRequestHeaderTemplates` 必须返回新对象；去除首尾空白、丢弃空行，拒绝
非法 HTTP token、非字符串值、CR/LF、忽略大小写后的重复头名和未知变量。

`expandRequestHeaderTemplates` 先调用规范化函数，再替换所有受支持变量；只有实际
出现 `{{sessionId}}` 时才要求非空 session ID。

- [ ] **步骤 4：运行模板测试与 API 类型检查**

运行：

```bash
pnpm --filter @vykor/api test src/providers/request-header-templates.test.ts
pnpm --filter @vykor/api check-types
```

预期：全部 PASS。

- [ ] **步骤 5：提交模板内核**

```bash
git add packages/api/src/providers/request-header-templates.ts `
  packages/api/src/providers/request-header-templates.test.ts `
  packages/api/src/index.ts
git commit -m "feat(api): add provider request header templates"
```

---

## 任务 2：固定 customProviders 的用户级作用域

**文件：**

- 修改：`packages/core/src/config/settings.ts:74-140`
- 修改：`packages/core/src/config/settings.test.ts`

- [ ] **步骤 1：写项目设置不得覆盖供应商清单的失败测试**

```ts
it("keeps custom providers user-scoped when project settings are included", async () => {
  const projectRoot = join(configDir, "provider-project");
  const projectConfigDir = join(projectRoot, ".vykor");
  mkdirSync(projectConfigDir, { recursive: true });
  const globalProvider = {
    id: "global-provider",
    displayName: "Global",
    baseUrl: "https://global.example/v1",
    apiFormat: "openai",
    models: [{ id: "chat", displayName: "Chat" }],
  };
  writeFileSync(
    join(configDir, "settings.json"),
    JSON.stringify({ customProviders: [globalProvider] }),
  );
  writeFileSync(
    join(projectConfigDir, "settings.json"),
    JSON.stringify({ customProviders: [{ ...globalProvider, id: "project-provider" }] }),
  );

  const settings = await loadSettings(undefined, {
    includeProject: true,
    projectRoot,
  });

  expect(settings.customProviders).toEqual([globalProvider]);
});
```

- [ ] **步骤 2：运行 core 测试，确认项目数组当前覆盖全局数组**

运行：

```bash
pnpm --filter @vykor/core test src/config/settings.test.ts
```

预期：FAIL，得到 `project-provider`。

- [ ] **步骤 3：在统一设置合并边界恢复用户级 customProviders**

在普通 spread 合并后显式设置：

```ts
merged.customProviders = fileSettings?.customProviders;
```

项目设置、环境设置和 CLI override 都不能覆盖供应商清单；再增加一个显式传入
`cliOverrides.customProviders` 仍返回用户文件内容的测试。不修改其他字段优先级。

- [ ] **步骤 4：运行 core 测试与类型检查**

```bash
pnpm --filter @vykor/core test src/config/settings.test.ts
pnpm --filter @vykor/core check-types
```

预期：全部 PASS。

- [ ] **步骤 5：提交作用域约束**

```bash
git add packages/core/src/config/settings.ts packages/core/src/config/settings.test.ts
git commit -m "fix(core): keep provider inventory user scoped"
```

---

## 任务 3：在造客户端时展开模板

**文件：**

- 修改：`packages/agent-runtime/src/default-runtime-provider.ts`
- 修改：`packages/agent-runtime/src/default-runtime-provider.test.ts`
- 修改：`packages/agent-runtime/src/default-runtime.ts`
- 修改：`packages/server/src/daemon/__test__/daemon-agent.test.ts`

- [ ] **步骤 1：将 runtime 测试改成供应商无关的失败测试**

测试自定义与目录条目都按传入 session 展开：

```ts
it.each([
  [undefined, "office-gateway"],
  ["models.dev", "catalog-gateway"],
])("expands request headers for source=%s", async (source, provider) => {
  const client = await resolveApiClient(
    {
      ...BASE_SETTINGS,
      apiKey: "key",
      provider,
      customProviders: [{
        id: provider,
        displayName: provider,
        baseUrl: "https://gateway.example/v1",
        apiFormat: "openai",
        models: [{ id: "chat", displayName: "Chat" }],
        headers: {
          "User-Agent": "{{userAgent}}",
          "X-Session": "{{sessionId}}",
        },
        ...(source ? { source: "models.dev" as const } : {}),
      }],
    },
    { provider },
    undefined,
    "session-42",
  );

  expect(readDefaultHeaders(client)).toEqual({
    "User-Agent": VYKOR_USER_AGENT,
    "X-Session": "session-42",
  });
});
```

再增加：

- 两个 session 造出的 client 头不同；
- 同一 client 发出两次请求时，两次 fetch 的已展开请求头相同；
- 静态头在缺少 session 时仍可用；
- 包含 `{{sessionId}}` 且缺少 session 时抛错；
- registry 内置供应商不获得模板头。
- daemon agent loader 把 durable `SessionRecord.id` 原样传入 runtime；同一 session
  重建 runtime 时仍得到该 ID，子 session 使用自己的 ID。

- [ ] **步骤 2：运行 runtime 测试，确认仍依赖 Go 专用逻辑而失败**

```bash
pnpm --filter @vykor/agent-runtime test src/default-runtime-provider.test.ts
```

预期：FAIL，自定义/任意目录条目未展开。

- [ ] **步骤 3：用通用展开器替换 resolveRequestHeaders**

核心逻辑：

```ts
const requestHeaders = customProvider?.headers
  ? expandRequestHeaderTemplates(customProvider.headers, {
      sessionId,
      userAgent: VYKOR_USER_AGENT,
    })
  : undefined;
```

保持 `createVykorRuntime` 把 `options.sessionId` 传给
`resolveApiClient`。不要在 runtime 中生成随机 ID，也不要按 provider 名称或 URL
判断。

- [ ] **步骤 4：暂时保留 Go 专用 API，避免 Server 中间提交失编译**

本任务只让 runtime 停止使用专用逻辑。`credential-validation.ts` 尚未迁移，故
`opencode-go.ts` 和原导出必须保留到任务 4，确保本任务提交可独立编译。

- [ ] **步骤 5：运行 API/runtime/daemon 回归测试与类型检查**

```bash
pnpm --filter @vykor/api test
pnpm --filter @vykor/agent-runtime test `
  src/default-runtime-provider.test.ts src/default-runtime.test.ts
pnpm --filter @vykor/server test src/daemon/__test__/daemon-agent.test.ts
pnpm --filter @vykor/api --filter @vykor/agent-runtime check-types
```

预期：全部 PASS。

- [ ] **步骤 6：提交 runtime 集成**

```bash
git add packages/agent-runtime/src/default-runtime-provider.ts `
  packages/agent-runtime/src/default-runtime-provider.test.ts `
  packages/agent-runtime/src/default-runtime.ts `
  packages/server/src/daemon/__test__/daemon-agent.test.ts
git commit -m "feat(runtime): expand configured provider headers"
```

---

## 任务 4：在 Provider Service 保存和校验目录模板

**文件：**

- 修改：`packages/server/src/application/settings-api.ts`
- 修改：`packages/server/src/application/default-services/provider-service.ts`
- 修改：`packages/server/src/application/default-services/credential-validation.ts`
- 修改：`packages/server/src/application/default-services/credential-validation.test.ts`
- 修改：`packages/server/src/application/__test__/default-application-services.test.ts`
- 修改：`packages/server/src/http/routes/system.ts`
- 修改：`packages/server/src/http/__test__/http.test.ts`
- 修改：`packages/api/src/index.ts`
- 删除：`packages/api/src/providers/opencode-go.ts`
- 删除：`packages/api/src/providers/opencode-go.test.ts`

- [ ] **步骤 1：为服务契约和持久化写失败测试**

将目录连接签名改为对象输入：

```ts
interface ConnectCatalogProviderInput {
  apiKey: string;
  headers?: Record<string, string>;
}

interface ProviderService {
  connectCatalog?(
    id: string,
    input: ConnectCatalogProviderInput,
  ): Promise<ProviderInfo> | ProviderInfo;
  updateCatalogHeaders?(
    id: string,
    headers: Record<string, string>,
  ): Promise<ProviderInfo> | ProviderInfo;
}
```

在 `default-application-services.test.ts` 添加以下独立用例：

1. 首次连接保存规范化后的模板原文。
2. 重连省略 `headers` 保留旧值。
3. 重连传 `{}` 清空旧值。
4. `updateCatalogHeaders` 只更新 `source: "models.dev"` 条目的 headers。
5. 更新真正的自定义供应商或不存在供应商返回明确错误。
6. 自定义供应商保存模板原文。
7. 未知变量、非法头名、CR/LF 和大小写重复头在写盘前被拒绝。
8. 目录首次连接校验失败时 settings 和 credentials 都不变化。
9. 已连接目录供应商重连校验失败时，原 settings 模板和原 credential 都保留。
10. 更新真正的自定义供应商时凭证校验失败，原 settings 和 credential 都保留。

- [ ] **步骤 2：把凭证校验测试改成通用模板失败测试**

```ts
await validateProviderCredential({
  providerName: "gateway",
  providerDisplayName: "Gateway",
  backendType: "openai_compat",
  apiKey: "key",
  baseUrl: "https://gateway.example/v1",
  headers: {
    "User-Agent": "{{userAgent}}",
    "X-Session": "{{sessionId}}",
  },
});

expect(fetchMock).toHaveBeenCalledWith(
  "https://gateway.example/v1/models",
  expect.objectContaining({
    headers: expect.objectContaining({
      "User-Agent": VYKOR_USER_AGENT,
      "X-Session": "vykor-credential-validation",
    }),
  }),
);
```

- [ ] **步骤 3：运行服务测试，确认契约和行为缺失**

```bash
pnpm --filter @vykor/server test `
  src/application/default-services/credential-validation.test.ts `
  src/application/__test__/default-application-services.test.ts
```

预期：FAIL，目录连接仍只接受字符串 API Key，且没有 headers 更新方法。

- [ ] **步骤 4：实现服务端规范化与三态语义**

在所有保存路径调用 `normalizeRequestHeaderTemplates`。目录重连逻辑必须区分
`"headers" in input`：

```ts
const headers = Object.prototype.hasOwnProperty.call(input, "headers")
  ? normalizeRequestHeaderTemplates(input.headers)
  : existing?.headers;
```

构造 `settingsProvider` 时只在规范化结果有键时写入 `headers`。显式 `{}` 规范化为
`undefined`，从而删除字段；省略则保留旧字段。

把 `RequestHeaderTemplateError` 转成状态码 400 的 `ProviderMutationError`，确保直接
HTTP 调用传入数组、非字符串值或非法模板时不会变成 500。

`updateCatalogHeaders` 必须：

- 找到且只接受 `source === "models.dev"` 的条目；
- 规范化输入；
- 只替换 headers，保留 ID、Base URL、models、source；
- 通过 `saveCustomProviders` 保存并返回目录 ProviderInfo；
- 不读取或写入 CredentialStorage。

- [ ] **步骤 5：在凭证校验边界展开模板**

定义并使用固定上下文：

```ts
const VALIDATION_HEADER_CONTEXT = {
  sessionId: "vykor-credential-validation",
  userAgent: VYKOR_USER_AGENT,
};
```

`validateOpenAICompatibleCredential` 在 fetch 前调用通用展开器。删除所有
OpenCode Go 名称、URL 和常量判断。

- [ ] **步骤 6：修正目录连接状态的服务/快照前提**

服务层目录快照仍由 `source: "models.dev"` 条目产生。增加测试确保仅有
CredentialStorage 孤立 API Key 时，不生成一条伪造的已配置目录快照；重新连接会
建立快照并复用/覆盖凭证。

- [ ] **步骤 7：先写并运行 Server HTTP 失败测试**

测试覆盖：

- POST 把 `{ apiKey, headers }` 原样传给 Provider Service；
- PATCH 缺少 `headers` 返回 400；
- PATCH `{ headers: {} }` 调用更新方法并返回 200；
- 成功 POST/PATCH 都调用一次 `closeAllRuntimes()`；
- 服务失败时不关闭 runtime，且 mutation lease 始终释放；
- 非法模板错误映射成 400。

运行：

```powershell
pnpm --filter @vykor/server test src/http/__test__/http.test.ts
```

预期：FAIL，现有路由仍传字符串 API Key 且没有 PATCH。

- [ ] **步骤 8：迁移 Server HTTP 路由**

在同一任务迁移 `POST /providers/catalog/:id/connect`，把 `{ apiKey, headers }`
对象传给新的 `connectCatalog` 签名；新增
`PATCH /providers/catalog/:id`。PATCH 缺少 `headers` 返回 400，
`headers: {}` 必须传给 `updateCatalogHeaders`。两个成功 mutation 都在保存后调用
`closeAllRuntimes()`；失败时不关闭，且 lease 必须在 finally 中释放。

- [ ] **步骤 9：删除 OpenCode Go 专用实现和专用导出**

此时 Server 已迁移到通用展开器，可以安全删除 `opencode-go.ts`、原专用测试及
`packages/api/src/index.ts` 中所有 `OPENCODE_GO_*`、`buildOpenCodeGoHeaders`、
`isOpenCodeGoTarget` 导出。

- [ ] **步骤 10：运行服务、HTTP、API 测试和类型检查**

```bash
pnpm --filter @vykor/server test `
  src/application/default-services/credential-validation.test.ts `
  src/application/__test__/default-application-services.test.ts `
  src/http/__test__/http.test.ts
pnpm --filter @vykor/api test
pnpm --filter @vykor/api --filter @vykor/server check-types
```

预期：全部 PASS。

- [ ] **步骤 11：提交 Server 垂直切片**

```bash
git add packages/api/src/index.ts packages/api/src/providers `
  packages/server/src/application/settings-api.ts `
  packages/server/src/application/default-services/provider-service.ts `
  packages/server/src/application/default-services/credential-validation.ts `
  packages/server/src/application/default-services/credential-validation.test.ts `
  packages/server/src/application/__test__/default-application-services.test.ts `
  packages/server/src/http/routes/system.ts `
  packages/server/src/http/__test__/http.test.ts
git commit -m "feat(server): persist catalog provider header templates"
```

---

## 任务 5：贯通 TypeScript Client 契约

**文件：**

- 修改：`packages/client/src/types/index.ts`
- 修改：`packages/client/src/transport/http-client.ts`
- 修改：`packages/client/src/transport/__test__/http-client.test.ts`

- [ ] **步骤 1：写 client 请求 body 和 PATCH 的失败测试**

```ts
await client.connectCatalogProvider("remote", {
  apiKey: "catalog-secret",
  headers: { "X-Session": "{{sessionId}}" },
});
await client.updateCatalogProviderHeaders("remote", {
  "User-Agent": "{{userAgent}}",
});
```

断言调用序列包含：

```ts
[
  "/providers/catalog/remote/connect", "POST",
  {
    apiKey: "catalog-secret",
    headers: { "X-Session": "{{sessionId}}" },
  },
]
[
  "/providers/catalog/remote", "PATCH",
  { headers: { "User-Agent": "{{userAgent}}" } },
]
```

- [ ] **步骤 2：运行 client 定向测试，确认接口不存在**

```bash
pnpm --filter @vykor/client test src/transport/__test__/http-client.test.ts
```

预期：FAIL，缺少对象输入和 PATCH 方法。

- [ ] **步骤 3：实现共享 client 类型与 transport**

在 client 类型中增加：

```ts
export interface ConnectCatalogProviderInput {
  apiKey: string;
  headers?: Record<string, string>;
}

export interface UpdateCatalogProviderHeadersInput {
  headers: Record<string, string>;
}
```

Transport 实现：

```ts
connectCatalogProvider(id, input, options)
updateCatalogProviderHeaders(id, headers, options)
```

PATCH body 始终包含 `headers`，包括空对象。

为避免这个独立提交让尚未迁移的 Desktop main 失编译，
`connectCatalogProvider` 提供旧字符串调用的兼容 overload：

```ts
connectCatalogProvider(id: string, apiKey: string, options?): Promise<ProviderInfo>;
connectCatalogProvider(
  id: string,
  input: ConnectCatalogProviderInput,
  options?,
): Promise<ProviderInfo>;
```

内部立即统一成对象 body；新代码只使用对象签名。兼容 overload 可在后续独立的
breaking change 中删除，不在本功能中强迫现有 SDK 调用方迁移。

- [ ] **步骤 4：运行 transport、Server 契约回归和类型检查**

```bash
pnpm --filter @vykor/client test src/transport/__test__/http-client.test.ts
pnpm --filter @vykor/server test src/http/__test__/http.test.ts
pnpm --filter @vykor/client --filter @vykor/server check-types
```

预期：全部 PASS。

- [ ] **步骤 5：提交 Client 契约**

```bash
git add packages/client/src/types/index.ts `
  packages/client/src/transport/http-client.ts `
  packages/client/src/transport/__test__/http-client.test.ts
git commit -m "feat(client): add catalog provider header resources"
```

---

## 任务 6：贯通 Desktop main、IPC 与连接状态

**文件：**

- 修改：`apps/desktop/src/shared/provider-types.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts`
- 修改：`apps/desktop/src/preload/desktop-api.ts`
- 修改：`apps/desktop/src/main/features/provider/ipc.ts`
- 修改：`apps/desktop/src/main/features/provider/provider-service.ts`
- 修改：`apps/desktop/src/main/features/provider/provider-service.test.ts`

- [ ] **步骤 1：写 Desktop main 的失败测试**

增加以下行为测试：

```ts
it("requires both catalog snapshot and credential to report connected", () => {
  const withoutSnapshot = buildDesktopProviderSnapshot({
    providers: [{
      name: "remote",
      displayName: "Remote",
      hasKey: true,
      active: false,
      source: "catalog",
    }],
    auth: {
      codex: { configured: false, state: "missing", source: "none" },
      storedProviders: ["remote"],
      envProviders: [],
    },
    settings: { customProviders: [] },
    models: [],
  });

  expect(withoutSnapshot.providers[0]).toMatchObject({
    connected: false,
    credentialSource: "none",
  });
});
```

再 mock `VykorClient`，断言：

- catalog connect 转发模板；
- 内置 connect 继续只调用 `authLogin`，忽略 headers；
- `updateCatalogHeaders` 只调用 client 的目录更新方法；
- snapshot 回显目录模板；
- 无 API Key 的真正自定义供应商仍为 `configured`。

- [ ] **步骤 2：运行 Desktop main 测试，确认状态和方法缺失**

```bash
pnpm --filter @vykor/desktop exec vitest run `
  src/main/features/provider/provider-service.test.ts
```

预期：FAIL，孤立目录凭证仍被标为 connected，且没有更新方法。

- [ ] **步骤 3：扩展 Desktop 类型**

```ts
export interface ConnectDesktopProviderInput {
  provider: string;
  apiKey: string;
  headers?: Record<string, string>;
  setActive?: boolean;
}

export interface UpdateDesktopCatalogProviderHeadersInput {
  provider: string;
  headers: Record<string, string>;
}
```

新增 `provider:catalog-headers-update` channel，并同步更新
`IpcInvokeMap`、`DesktopApiContract`、preload 与 main handler。

- [ ] **步骤 4：实现 DesktopProviderService**

目录连接改为：

```ts
await client.connectCatalogProvider(provider, {
  apiKey,
  ...("headers" in input ? { headers: input.headers } : {}),
});
```

内置供应商保持 `authLogin({ provider, apiKey })`。

新增：

```ts
async updateCatalogHeaders(
  input: UpdateDesktopCatalogProviderHeadersInput,
): Promise<DesktopProviderSnapshot>
```

目录连接状态必须同时检查：

```ts
source === "catalog" &&
stored.has(provider.name) &&
customByProvider.get(provider.name)?.source === "models.dev"
```

为 `CustomProviderSettingView` 保留 `source`，避免 snapshot 丢失区分依据。

- [ ] **步骤 5：运行 Desktop main、IPC 类型和边界检查**

```bash
pnpm --filter @vykor/desktop exec vitest run `
  src/main/features/provider/provider-service.test.ts
pnpm --filter @vykor/desktop typecheck:node
pnpm --dir apps/desktop exec node scripts/verify-workspace-boundaries.mjs
```

预期：全部 PASS。

- [ ] **步骤 6：提交 Desktop bridge**

```bash
git add apps/desktop/src/shared/provider-types.ts `
  apps/desktop/src/shared/ipc-channels.ts `
  apps/desktop/src/shared/desktop-api-contract.ts `
  apps/desktop/src/preload/desktop-api.ts `
  apps/desktop/src/main/features/provider/ipc.ts `
  apps/desktop/src/main/features/provider/provider-service.ts `
  apps/desktop/src/main/features/provider/provider-service.test.ts
git commit -m "feat(desktop): bridge catalog provider headers"
```

---

## 任务 7：构建分离的 Desktop 请求头界面

**文件：**

- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/request-header-form.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/request-header-form.test.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/request-header-editor.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/provider-connection-dialog.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/provider-connection-dialog.test.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/catalog-provider-headers-dialog.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/settings-page/catalog-provider-headers-dialog.test.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-form.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-dialog.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/custom-provider-dialog.test.ts`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/provider-settings.tsx`

- [ ] **步骤 1：先查项目中已安装组件的正确 API**

当前项目已有 `Dialog`、`FieldSet`、`Input`、`Button` 和 `Collapsible`。实现前运行：

```bash
pnpm dlx shadcn@latest docs dialog field input button collapsible
```

只读取与当前 Base UI 版本匹配的文档；不重新安装或覆盖已有组件。

- [ ] **步骤 2：写请求头表单纯函数失败测试**

```ts
it("preserves template text and reports incomplete rows", () => {
  expect(headersFromRows([
    { key: "1", name: " X-Session ", value: " {{sessionId}} " },
  ])).toEqual({ ok: true, headers: { "X-Session": "{{sessionId}}" } });

  expect(headersFromRows([
    { key: "1", name: "X-Session", value: "" },
  ])).toEqual({
    ok: false,
    message: "请求头名称和值需要同时填写。",
  });
});

it("returns an explicit empty object when every row is removed", () => {
  expect(headersFromRows([])).toEqual({ ok: true, headers: {} });
});
```

- [ ] **步骤 3：写连接与编辑对话框的失败测试**

`ProviderConnectionDialog` 测试：

- `source: "catalog"` 显示默认收起的“高级选项”；
- 展开后显示 `{{sessionId}}`、`{{userAgent}}` 和明文存储警告；
- 提交 `{ apiKey, headers, setActive }`；
- 目录供应商存在已保存 headers 但当前缺少凭证时，未编辑请求头则省略 headers，
  编辑后提交完整模板，删除全部行后提交 `{}`；
- builtin 不渲染高级选项，提交时不包含 headers；
- 关闭后重新打开另一供应商不会保留旧请求头行。

`CatalogProviderHeadersDialog` 测试：

- 回显已保存模板；
- 不渲染 API Key 输入框；
- 删除全部行提交 `{}`；
- busy 时禁用保存和关闭。

`CustomProviderDialog` 测试：

- 使用相同模板说明；
- 编辑时回显模板原文；
- 不改变现有密钥遮罩/更换行为。

- [ ] **步骤 4：运行 Renderer 测试，确认组件和纯函数不存在**

```bash
pnpm --filter @vykor/desktop exec vitest run `
  src/renderer/src/components/desktop/settings-page/request-header-form.test.ts `
  src/renderer/src/components/desktop/settings-page/provider-connection-dialog.test.tsx `
  src/renderer/src/components/desktop/settings-page/catalog-provider-headers-dialog.test.tsx `
  src/renderer/src/components/desktop/settings-page/custom-provider-dialog.test.ts
```

预期：FAIL，缺少新模块和界面。

- [ ] **步骤 5：实现纯函数和共用 RequestHeaderEditor**

定义：

```ts
export interface RequestHeaderRow {
  key: string;
  name: string;
  value: string;
}

export function rowsFromHeaders(
  headers?: Record<string, string>,
): RequestHeaderRow[];

export function headersFromRows(
  rows: RequestHeaderRow[],
): { ok: true; headers: Record<string, string> } |
   { ok: false; message: string };
```

`RequestHeaderEditor` 只负责行编辑与错误展示，不拥有供应商、API Key、Dialog 或提交
状态。使用现有 `FieldSet`、`FieldLegend`、`FieldDescription`、`Input`、`Button`，
保持 `data-invalid` / `aria-invalid`，按钮图标使用 `data-icon`。

- [ ] **步骤 6：让自定义表单复用编辑器但保持独立业务表单**

`CustomProviderDialog` 继续拥有 ID、显示名、Base URL、API Key 和模型字段，只把原
内嵌请求头行替换成 `RequestHeaderEditor`。`validateCustomProviderForm` 调用
`headersFromRows`，成功时仍可在空对象下省略 `headers`。

说明文字：

```text
用于租户或网关路由信息。值可以使用 {{sessionId}} 和 {{userAgent}}，
发送请求时会替换为当前会话和客户端标识。请求头会明文保存在 settings.json，
请勿填写 API Key 或 Bearer Token。
```

- [ ] **步骤 7：实现目录连接和已连接目录编辑**

`ProviderConnectionDialog` 保持现有 API Key 与“连接后设为当前供应商”。仅当
`provider.source === "catalog"` 时，使用 `Collapsible` 展示高级
`RequestHeaderEditor`；目录目标打开时从 `provider.headers` 初始化请求头行，并用
`headersDirty` 区分“没有编辑”和“显式清空”。没有编辑时省略 `headers`，编辑后即使
为空也提交 `{}`，从而严格对应服务端三态语义。builtin 完全不创建 headers 状态。

`CatalogProviderHeadersDialog` 只接受：

```ts
{
  provider: DesktopProviderInfo;
  busy: boolean;
  onSubmit(headers: Record<string, string>): void;
}
```

在 `ProviderRow` 中仅对 `provider.source === "catalog" && provider.connected`
显示“请求头”操作。它不能打开 `CustomProviderDialog`。

`ProviderSettings` 分别维护连接对话框目标和已连接目录请求头目标；成功或关闭时
清理局部状态。

- [ ] **步骤 8：运行 Renderer 测试、Web 类型检查和 lint**

```bash
pnpm --filter @vykor/desktop exec vitest run `
  src/renderer/src/components/desktop/settings-page/request-header-form.test.ts `
  src/renderer/src/components/desktop/settings-page/provider-connection-dialog.test.tsx `
  src/renderer/src/components/desktop/settings-page/catalog-provider-headers-dialog.test.tsx `
  src/renderer/src/components/desktop/settings-page/custom-provider-form.test.ts `
  src/renderer/src/components/desktop/settings-page/custom-provider-dialog.test.ts
pnpm --filter @vykor/desktop typecheck:web
pnpm --filter @vykor/desktop lint
```

预期：全部 PASS，且没有 accessibility 或 hooks 警告。

- [ ] **步骤 9：提交 Desktop UI**

```bash
git add apps/desktop/src/renderer/src/components/desktop/settings-page
git commit -m "feat(desktop): configure provider header templates"
```

---

## 任务 8：文档、架构边界与完整验证

**文件：**

- 修改：`docs/auth-provider-model.md`
- 核对：`docs/superpowers/specs/2026-09-16-provider-request-header-templates-design.md`
- 核对：`scripts/architecture-boundaries.mjs`

- [ ] **步骤 1：更新用户文档**

在 `docs/auth-provider-model.md` 补充：

```json
{
  "customProviders": [{
    "id": "opencode-go",
    "source": "models.dev",
    "headers": {
      "User-Agent": "{{userAgent}}",
      "x-opencode-session": "{{sessionId}}"
    }
  }]
}
```

明确：

- 模板原文在 `settings.json`，不是 `credentials.json`；
- API Key 仍在 `credentials.json`；
- 两个变量的含义；
- 真正自定义与目录供应商支持，内置供应商暂不支持；
- 请求头是明文配置，不应保存秘密。

- [ ] **步骤 2：扫描供应商专用残留**

运行：

```bash
rg "isOpenCodeGoTarget|buildOpenCodeGoHeaders|OPENCODE_GO_" `
  packages apps
```

预期：无生产代码和测试匹配。规格中的历史说明允许保留。

- [ ] **步骤 3：运行相关包完整测试**

```bash
pnpm --filter @vykor/api test
pnpm --filter @vykor/core test
pnpm --filter @vykor/agent-runtime test
pnpm --filter @vykor/client test
pnpm --filter @vykor/server test
pnpm --filter @vykor/desktop test
```

预期：所有 test files 通过，0 failures。

- [ ] **步骤 4：运行类型、lint、架构和文档验证**

```bash
pnpm --filter @vykor/api `
  --filter @vykor/core `
  --filter @vykor/agent-runtime `
  --filter @vykor/client `
  --filter @vykor/server check-types
pnpm --filter @vykor/desktop typecheck
pnpm --filter @vykor/desktop lint
pnpm check:architecture
pnpm check-docs
git diff --check
```

预期：所有命令 exit 0。

- [ ] **步骤 5：按验收标准人工核对数据流**

核对一条目录供应商和一条真正自定义供应商：

```text
Desktop 输入模板
  -> HTTP/Provider Service 保存模板原文
  -> settings.json customProviders[].headers
  -> daemon/CLI/SDK 创建稳定 sessionId
  -> resolveApiClient 展开模板
  -> OpenAI SDK defaultHeaders
```

确认内置供应商不显示高级头、不读取模板，daemon 中没有供应商名称判断。

- [ ] **步骤 6：请求最终代码审查**

派遣只读审查子代理，对照规格检查：

- 分层职责；
- 所有入口覆盖；
- session 稳定性；
- 目录三态语义；
- 孤立凭证显示；
- runtime 失效；
- 安全校验和明文提示；
- OpenCode Go 专用逻辑是否彻底删除。

修复所有 Critical 和 Important 反馈，再重新运行步骤 3、4。

- [ ] **步骤 7：提交文档和最终修正**

```bash
git add docs/auth-provider-model.md `
  docs/superpowers/specs/2026-09-16-provider-request-header-templates-design.md
git commit -m "docs: document provider request header templates"
```

---

## 规格覆盖检查

- 模板变量与校验：任务 1。
- 用户级 `customProviders` 作用域：任务 2。
- 造客户端展开、稳定 session、删除专用适配：任务 3。
- 自定义/目录持久化、三态语义、凭证校验、HTTP 与全量 runtime 失效：任务 4。
- TypeScript Client 资源契约与兼容入口：任务 5。
- Desktop main、IPC、目录连接状态：任务 6。
- 两套独立 UI 与共用行编辑器：任务 7。
- 用户文档、全量回归与最终审查：任务 8。
