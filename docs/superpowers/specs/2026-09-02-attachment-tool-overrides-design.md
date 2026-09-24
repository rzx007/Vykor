# 附件能力退出 Agent Runtime 设计

## 1. 状态

- 状态：已实现
- 日期：2026-09-02
- 范围：`@vykor/core`、`@vykor/tools`、`@vykor/agent-runtime`、`@vykor/server`
- 前置设计：`2026-09-02-agent-tool-override-design.md`
- 兼容策略：不兼容旧的附件 Capability 注入接口

## 2. 背景

当前 `Read` 和 `ImageToText` 通过 `ToolContext` 读取 Host 注入的附件能力：

```text
Read -> context.attachments -> AgentAttachmentResourceHost
ImageToText -> context.imageToText -> AgentImageToTextHost
```

这条链路能工作，但把 daemon 的附件存储、会话授权和本地 OCR 变成了 Agent Runtime 的公共能力。没有注入这些 Host 的调用方会得到缺失或不可执行的工具，`DefaultNodeAgent` 也因此不再是一个行为自洽的默认 Agent。

显式 `tools` / `toolOverrides` 已经提供了更合适的扩展边界：默认 Agent 提供普通文件工具；拥有附件和视觉服务的 daemon 注册完整视觉 Tool，并只覆盖需要扩展附件协议的 `Read`。模型仍然调用 `Read`、`ImageToText` 或 `ImageGeneration`，但 Agent Runtime 不再认识附件协议、附件存储、附件 OCR 或视觉服务配置。

本设计取代 `2026-09-02-agent-tool-override-design.md` 中“默认 `Read` 直接支持附件”的临时结论，具体包括该文档的第 14 节、15.5 节、验收标准第 11 项及相关实施描述。Tool 显式覆盖机制本身保持不变。

## 3. 设计结论

采用“默认基础 Tool + daemon 视觉 Tool 装配和附件 Read 覆盖”：

```text
DefaultNodeAgent
  ├─ Read：只读本地文件和目录
  ├─ 不默认注册 ImageToText / ImageGeneration
  └─ 不知道 attachment://、attachment_id、附件存储、本地 OCR 和视觉 Provider

Daemon
  ├─ 管理附件上传、存储、授权和生命周期
  ├─ 用附件版 Read 覆盖默认 Read
  ├─ 完整定义 ImageToText / ImageGeneration
  └─ 通过统一的 tools(context) 返回固定工具和动态工具
```

核心规则：

1. 附件不是 Agent Capability，而是 daemon 提供的业务资源。
2. Agent Runtime 不保留旧接口，也不同时支持 Capability 和 Tool override 两条注入路径。
3. 默认 `Read` 独立可用；默认 Registry 不提供图生文或文生图 Tool。
4. daemon 覆盖的是完整 `ToolDefinition`，执行仍经过 QueryEngine 的权限、Hook、超时、取消、审计和结果规范化。
5. `@vykor/tools` 不定义或导出视觉 Tool；`ImageToText` 和 `ImageGeneration` 的完整定义属于 daemon/server。
6. 附件目录不再隐式挂载给 Agent shell。
7. compact 只接受通用补充章节；附件 Catalog 的类型、构建、限额和文案全部由 server 负责。

## 4. 目标

1. `DefaultNodeAgent` 在没有 daemon 服务时仍拥有可用的本地 `Read`，但不暴露图生文或文生图 Tool。
2. `@vykor/core`、`@vykor/tools` 和 `@vykor/agent-runtime` 不再导出或传递附件专属 Host。
3. daemon 继续支持现有客户端附件上传和消息协议。
4. 文本附件继续通过 `Read({ file_path: "attachment://..." })` 读取。
5. 当前模型不能直接看图时，图片附件继续通过 `ImageToText({ attachment_id: "..." })` 做本地 OCR。
6. 附件读取始终在 daemon 中按当前 session 授权，不暴露物理存储路径。
7. Root Agent、Child Agent 和嵌套 Child Agent 使用同一 Root session 的附件授权范围，其他 session 不能借用该范围。

## 5. 非目标

本次不做：

- 通用 `ResourceResolver` 或新的 Capability Provider；
- Plugin 覆盖内置 Tool 的权限体系；
- 让 shell 直接操作附件目录；
- 改变客户端上传接口、附件 metadata 或消息展示；
- 用视觉模型替换 daemon 现有的附件本地 OCR；
- 重构所有媒体 Tool 的 Provider 客户端；
- 为旧的 `capabilityOverrides.attachments`、`capabilityOverrides.imageToText` 或 `attachmentResourceRoot` 提供兼容层。

## 6. 默认 Tool 契约

### 6.1 默认 `Read`

默认 `Read` 恢复为本地文件系统工具：

```ts
Read({
  file_path: string,
  offset?: number,
  limit?: number,
})
```

它支持本地文件、目录、分页、编码识别和现有路径规则。它不识别 `attachment://`，不解析 `assetId`，也不读取 session 状态。

独立 Agent 收到 `attachment://...` 时，按无效或不存在的本地路径返回稳定错误。只有 daemon 覆盖后的 `Read` 才承诺支持该协议。

### 6.2 视觉 Tool 不属于默认 Agent 或 `@vykor/tools`

daemon 的完整 `ImageToText` 定义支持三种输入：

```ts
ImageToText({
  attachment_id?: string,
  image_path?: string,
  image_url?: string,
  prompt?: string,
})
```

要求 `attachment_id`、`image_path` 和 `image_url` 恰好提供一个。附件输入只做本地 OCR，不能与 `prompt` 组合；路径或 URL 输入可以通过 `prompt` 指定视觉模型任务。该定义：

- 对 `attachment_id` 先执行 Child → Root 授权解析，再调用 daemon 本地 OCR；
- 使用 `ToolContext.settings` 中当前 Agent 的模型、API 格式、地址和凭据；当前 Settings 已没有单独的 `visionModel`，不重新引入该配置；
- 本地图片按受支持媒体类型编码为模型图片输入；
- URL 只作为模型图片输入，不经过附件存储；
- 使用 Tool 调用的 `abortSignal` 和 60 秒内部超时；
- 不调用 `AgentImageToTextHost`；
- 不进入默认 Registry，也不从 `@vykor/tools` 导出。

`ImageGeneration` 同样由 daemon/server 完整定义。loader 不读取图片生成专用 Settings 字段，也不根据某个 URL 字段决定它是否存在；工具可以使用 HTTP、本地程序、固定路径或其他 daemon 自己选择的实现。错误响应不得返回 API key，Provider 响应正文需要安全截断。

## 7. daemon Tool 装配

daemon 在创建 Agent 时覆盖 `Read`，并通过唯一的 `tools(context)` 入口注册普通 Tool：

```ts
createDaemonAgentLoader({
  tools: async ({ session, settings }) => [
    daemonImageToTextTool,
    daemonImageGenerationTool,
    ...await dynamicToolRegistry.resolve({ session, settings }),
  ],
  toolOverrides: [
    createAttachmentReadTool({ defaultTool: fileReadTool, attachmentReader }),
  ],
  trustedToolOverrides: ["Read"],
});
```

`Read` 的 `defaultTool` 是从 `@vykor/tools` 明确导入的内置定义。daemon 的 `ImageToText` 没有 `defaultTool`：附件、本地路径和 URL 三条分支都在 server 实现。固定工具和动态工具从同一个 `tools(context)` 返回；loader 只提供当前 session 和最终 Settings，不解释工具名称或注册条件。

`trustedToolOverrides` 是第一方 Agent 创建者的显式信任声明：指定的覆盖 Tool 保留被替换内置 Tool 的权限分类。名称必须同时存在于 `toolOverrides`，而且被替换目标必须是 builtin；否则 Agent 创建失败。Extension、Plugin 和 MCP 不能设置或继承这项声明。daemon 只信任自己构造的 `Read` 覆盖，不信任第三方 Tool。

两个附件工厂必须显式接收同一个授权会话解析器：

```ts
export interface AttachmentAuthorizationSessionResolver {
  resolve(executionSessionId: string): string | undefined;
}

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

export interface AttachmentReadToolOptions {
  defaultTool: ToolDefinition;
  authorizationSessions: AttachmentAuthorizationSessionResolver;
  attachmentReader: AttachmentTextReader;
}

export interface AttachmentImageToTextToolOptions {
  defaultTool: ToolDefinition;
  authorizationSessions: AttachmentAuthorizationSessionResolver;
  attachmentOcr: AttachmentOcrService;
}
```

`executionSessionId` 是实际执行 Tool 的 Root 或 Child session；返回值是用来查询附件引用的授权 session。解析规则固定为：

```text
当前是存活的 Child 或嵌套 Child
  -> 返回所属 Root sessionId

当前是普通 Root session
  -> 返回自身 sessionId

session 不存在，或无法证明它属于一个可访问的 Root tree
  -> 返回 undefined，Tool 拒绝访问
```

解析器只负责确定“去哪个 session 查引用”，不能只凭 assetId 授权。两个 Tool 得到授权 sessionId 后，都必须确认该 session 的输入附件记录中存在目标 assetId，再读取正文或启动 OCR。

这个确认由上面的 reader/OCR service 作为最后一道边界执行：`authorizationSessionId` 是必填参数，service 先查询该 session 的附件引用，再访问 asset。Tool 负责从执行上下文解析授权 session 并传入，service 不接受缺少授权 session 的 asset-only 调用。这样即使以后其他 server 代码直接复用这些 service，也不能跳过 session 引用校验。

### 7.1 附件版 `Read`

附件版 `Read` 保持默认参数，并扩展 `file_path` 的描述以说明 `attachment://`：

```text
file_path 以 attachment:// 开头
  -> 严格解析 assetId 和展示文件名
  -> 使用 authorizationSessions.resolve(context.sessionId) 得到授权 session
  -> 确认授权 session 的输入附件记录引用了 assetId
  -> 将 offset / limit 传给 daemon AttachmentTextReader
  -> 格式化文本片段和分页提示

其他 file_path
  -> defaultTool.execute(input, context)
```

附件 URI 的解析和合法性校验从 `@vykor/tools` 迁到 server 附件模块。`offset`、`limit` 和现有最大返回量继续沿用当前行为。

### 7.2 附件版 `ImageToText`

附件版 Schema 接受两类互斥输入：

```ts
{ attachment_id: string }

// 或
{
  image_path?: string,
  image_url?: string,
  prompt?: string,
}
```

执行规则：

```text
存在 attachment_id
  -> 禁止同时提供 image_path、image_url 或 prompt
  -> 使用 authorizationSessions.resolve(context.sessionId) 得到授权 session
  -> 确认授权 session 的输入附件记录引用了 attachment_id
  -> 调用 daemon 当前的附件本地 OCR
  -> 返回带不可信内容边界和 OCR metadata 的 ToolResult

不存在 attachment_id
  -> defaultTool.execute(input, context)
```

附件本地 OCR 仍只提取可见文字，不接受描述性 prompt，也不推断非文字内容。普通本地文件和 URL 则由默认视觉模型 Tool 处理，可以接受 prompt。

## 8. 类型与所有权调整

从 `@vykor/core` 删除：

- `AgentAttachmentResourceHost`
- `AgentAttachmentTextSlice`
- `AgentImageToTextHost`
- `AgentImageToTextInput`
- `AgentImageToTextResult`
- `ToolContext.attachments`
- `ToolContext.imageToText`
- Runtime 接口中的 `setAttachments()`
- Runtime 接口中的 `setImageToText()`

从 `@vykor/agent-runtime` 删除：

- `AgentCapabilityOverrides.attachments`
- `AgentCapabilityOverrides.imageToText`
- `ResolvedAgentCapabilities.attachments`
- `ResolvedAgentCapabilities.imageToText`
- 默认 Capability 解析中的对应分支
- Kernel 与 QueryEngine 的对应接线
- `attachmentResourceRoot` 配置和附件目录沙箱挂载

从 QueryEngine 删除：

- `attachments`、`imageToText` 状态字段；
- 两个 setter；
- 构造 `ToolContext` 时对两个字段的注入。

server 内部保留实现当前业务所需的小接口，例如 `AttachmentTextReader` 和 `AttachmentOcrService`。这些接口使用 server/services 自己的类型，不再从 core 导出，也不再出现在 `agent.inspect().capabilities`。

`CompactAttachmentCatalog` 和 `CompactAttachmentCatalogEntry` 也从 core 删除。它们迁到 server 附件模块，或直接成为 server 构造补充章节时使用的私有类型。

## 9. daemon 装配

`daemon-application.ts` 继续创建现有附件读取与 OCR 服务，但不再把它们放进 `capabilityOverrides`。它把服务交给两个 server Tool 工厂，再将结果传给 daemon Agent factory。

daemon 同时创建一个 `AttachmentAuthorizationSessionResolver`，供两个 Tool 共享。它用 `LiveChildAgentDirectory` 将存活的 Child 和嵌套 Child 映射到 Root；普通持久 session 映射到自身；未知 session 返回 `undefined`。关闭 Child 后不得继续沿用之前的 Root 映射。

`daemon-agent.ts` 的输入从：

```ts
{
  attachments,
  imageToText,
  attachmentResourceRoot,
}
```

改为普通 Agent 配置里的：

```ts
{
  tools: async ({ session, settings }) => [
    daemonImageToTextTool,
    daemonImageGenerationTool,
    ...await dynamicToolRegistry.resolve({ session, settings }),
  ],
  toolOverrides: [attachmentReadTool],
  trustedToolOverrides: ["Read"],
}
```

daemon 自己决定 `tools(context)` 返回哪些固定或动态工具。loader 不读取视觉工具的配置字段，也不对 `ImageToText` 或 `ImageGeneration` 做特殊判断。

## 10. 附件路由与 compact

客户端上传和 server 附件 Catalog 中保存的 `attachment://` URI 不变。它们属于 daemon 会话数据，不要求 Agent Runtime 原生理解该 URI。

图片附件路由不再检查：

```ts
inspection.capabilities.imageToText.status
```

路由只根据最终可见工具及 daemon 自己是否安装了附件 OCR 覆盖来判断：

```text
ImageToText 不可见
  -> 过滤错误

ImageToText 可见但附件 OCR 不可用
  -> 不生成 attachment_id 调用提示

ImageToText 可见且附件 OCR 可用
  -> 生成只传 attachment_id 的 OCR 提示
```

实现中可以把现有 `imageToTextHostAvailable` 改成语义准确的 `attachmentOcrAvailable`，它是 server 路由输入，不是 Agent Capability 快照。

### 10.1 compact 退出附件类型

core 当前的 `CompactContext.attachmentCatalog`、`CompactAttachmentCatalog`、`CompactAttachmentCatalogEntry` 和 `CompactService.formatAttachmentCatalog()` 全部删除。Agent Runtime 的 `CompactContextSources.attachmentCatalog` 也删除。

`CompactContext` 改为接受通用补充章节：

```ts
export interface CompactContextSection {
  heading: string;
  content: string;
}

export interface CompactContext {
  // 现有 sessionMemory、taskFocus、recentFiles、plan、workLog 保持不变。
  supplementalSections?: CompactContextSection[];
}
```

core 只负责将经过通用长度限制的章节放进 compact prompt，不识别 assetId、媒体类型、representation、`attachment://`、`Read` 或 `ImageToText`。规则固定为：最多 8 节；heading 去除首尾空白、把换行折叠为空格并截到 120 字符，空 heading 的章节跳过；单节 content 最多 16,000 字符；所有补充章节合计最多 32,000 字符；空 content 跳过。这样任意 Host 都不能无限撑大 compact prompt。

server 将现有 `buildCompactAttachmentCatalog()` 调整为构建一个有界的通用章节，例如：

```ts
{
  heading: "Conversation Attachments",
  content: "...server 格式化后的附件目录和访问提示...",
}
```

附件条目数量、预览长度、Catalog 总长度、不可信预览边界，以及提示模型使用 `Read` / `ImageToText` 的文案，都在 server 中生成和测试。AgentPool 只把 server 生成的章节通过通用 `supplementalSections` provider 传给 Agent。

这样 compact 仍能保留附件引用，但 core 和 Agent Runtime 只看见普通文本章节，不拥有附件类型或附件格式化规则。独立 Agent 没有 daemon 提供的附件章节，因此不会产生附件提示。

## 11. 安全与错误处理

附件版 Tool 必须：

1. 只接受规范化的 `attachment://` 或不透明 `attachment_id`，不接受附件物理路径。
2. 使用正式的授权会话解析器处理 Root、Child 和嵌套 Child；缺少 session、解析失败或 Root 引用不存在时拒绝附件访问。
3. 继续校验附件状态、媒体类型、大小和可用 representation。
4. 将 `abortSignal` 传到底层读取和 OCR。
5. 限制单次文本返回量，保留分页信息。
6. 将附件正文和 OCR 文本标记为不可信数据，防止其被当成系统指令。
7. 不在 Tool 结果中暴露物理目录、堆栈、凭据或完整 Provider 错误正文。

稳定错误至少覆盖：

- 附件不存在；
- 当前 session 无权访问；
- Child 已关闭或无法解析到有效 Root；
- 附件尚未处理完成；
- 类型不支持；
- 内容或图片过大；
- 读取/OCR 超时或被取消；
- daemon 视觉服务配置缺失或 Provider 不支持图片。

错误沿用现有 `ToolResult` 和 `failureKind`，本次不新增一套异常基类。

### 11.1 Tool 权限

普通覆盖 Tool 继续遵循前置设计：不能只因为名称仍叫 `Read` 就继承内置实现的隐式信任。本次增加一个只供创建 Agent 的第一方调用者使用的明确例外：

```ts
interface VykorAgentConfiguration {
  toolOverrides?: ToolDefinition[];
  /** 覆盖实现保留原 builtin 的权限分类；只能引用本次 toolOverrides 中的 builtin 目标。 */
  trustedToolOverrides?: string[];
}
```

daemon 创建并控制附件版 `Read`，因此同时传入 `trustedToolOverrides: ["Read"]`。这不是按名称自动信任所有同名实现：没有显式声明的 SDK 覆盖仍失去信任，Extension、Plugin 和 MCP 仍然没有覆盖或声明可信覆盖的入口。

可信覆盖保留的是原 builtin 的权限分类，不等于无条件加入 `autoApproveTools`：

- 普通本地路径继续沿用 `Read` 的 cwd 内只读放行和 cwd 外询问；
- `attachment://` 被视为可信 Host `Read` 管理的只读资源 URI，Tool 权限可以放行，但执行时仍必须做 Child → Root 和附件引用授权；
- denied tool、path deny 和显式策略继续优先；
- `ImageToText` 和 `ImageGeneration` 是 daemon 注册的普通 Tool，不加入 `trustedToolOverrides`，继续沿用普通 Tool 权限行为。

实际行为固定为：

- `full_auto` 等原本无需询问的模式继续执行；
- 用户已有的 deny、allow、path rule 和显式 `autoApproveTools` 继续生效；
- 默认询问模式下，daemon 的可信 `Read` 覆盖保留普通 builtin `Read` 的只读体验；
- 附件分支即使通过 Tool 权限，仍必须在执行内部做 session 级资源授权。

`trustedToolOverrides` 随 Root Agent 配置传给 Child，但只能信任同一组由第一方 daemon 构造并继承的 Tool 定义，Child 不能自行追加可信名称。

## 12. 生命周期

覆盖 Tool 是普通不可变定义，不拥有需要单独释放的生命周期。附件存储、OCR worker 和缓存仍由 daemon/application 层创建和关闭。Agent Runtime 不释放这些服务。

移除 `attachmentResourceRoot` 后，Agent shell 和任何执行环境都不会自动看到附件存储目录。未来若需要 shell 操作附件，应单独设计显式的“导出附件到受控工作目录”工具，不恢复隐式目录暴露。

## 13. 测试范围

### 13.1 `@vykor/tools`

- `Read` 读取普通文件、目录和分页内容。
- `Read` 的描述和 Schema 不再宣称支持 `attachment://`。
- `Read` 不调用任何附件 Host。
- 默认 Registry 不包含 `ImageToText` 或 `ImageGeneration`。
- 包入口不导出 `ImageToText` 或 `ImageGeneration`，源码目录中也不保留两者的 Tool 定义。

### 13.2 `@vykor/core` 与 `@vykor/agent-runtime`

- `ToolContext` 不再携带附件或 OCR Host。
- QueryEngine 不再保存或设置附件能力。
- 默认 Agent 无附件 Host 也能运行通用 `Read`，但不注册视觉 Tool。
- Capability 解析和 inspect 快照中不再出现 `attachments`、`imageToText`。
- Runtime 配置不再接受 `attachmentResourceRoot`，沙箱不再自动挂载附件目录。
- core 不再导出附件 Catalog 类型，也不格式化附件 compact 文案。
- 通用 `supplementalSections` 能进入 compact prompt，并执行 heading、单节和总长度限制。
- Agent Runtime 的 compact provider 只透传通用补充章节和 session memory。
- 未声明可信的覆盖 Tool 仍失去 builtin 信任。
- `trustedToolOverrides` 只能引用当前第一方 `toolOverrides` 中实际替换 builtin 的名称。
- daemon 的可信 `Read` 覆盖保留 cwd 内本地读取的隐式放行，cwd 外读取仍按原规则询问。
- 可信 `Read` 的 `attachment://` 分支通过 Tool 权限后仍执行 session 资源授权。
- 现有 `toolOverrides` 仍受 allow/deny、权限、Hook、超时和取消控制。

### 13.3 `@vykor/server`

- 附件版 `Read` 对普通路径委托默认 Tool。
- 附件版 `Read` 严格解析 URI、传递分页参数并校验 session。
- daemon 版 `ImageToText` 在 server 内直接处理普通路径、URL 和授权附件，不委托 `@vykor/tools`。
- daemon 版 `ImageToText` 对 `attachment_id` 调用本地 OCR。
- `attachment_id` 与其他来源或 prompt 同时出现时拒绝。
- 两个附件 Tool 都验证普通 Root session 可以访问自己的附件。
- 两个附件 Tool 都验证存活 Child 和嵌套 Child 解析到同一个 Root，并可访问 Root 附件。
- 两个附件 Tool 都拒绝其他 Root 的附件、未知 session 和缺少 session 的请求。
- Child 关闭并从 live directory 注销后，两个附件 Tool 都不再允许它借用原 Root 的附件授权。
- 两个附件 Tool 的单元测试断言解析器收到实际 Child sessionId，而 reader/OCR service 收到解析后的 Root sessionId。
- reader 和 OCR service 都拒绝缺少 `authorizationSessionId` 的 asset-only 访问；类型层面不提供这种调用签名。
- 图片 OCR 在调用 processor 前完成 session 引用校验，不能只凭 assetId 识别图片。
- 附件不存在和取消请求都返回正确错误。
- daemon 创建 Agent 时覆盖 `Read`，并通过唯一的 `tools(context)` 注册固定和动态 Tool。
- 路由只在附件 OCR 覆盖真实可用且 Tool 可见时生成提示。
- server 负责附件 Catalog 的条目、预览和总长度限制，并产出通用 compact 章节。
- compact 后的 server 附件章节仍能触发覆盖 Tool。

### 13.4 回归

- Schedules、Workflow、Memory、Terminal、Jobs 和 Background Shell 的 API、装配和生命周期不变。
- daemon 通过 `trustedToolOverrides` 让第一方 `Read` 覆盖保留内置权限分类；其他覆盖不继承。
- 全仓类型检查通过。
- core、tools、agent-runtime、server 测试通过。
- `git diff --check` 通过。

## 14. 实施分段

1. 用失败测试锁定默认 `Read`、默认 Registry 无视觉 Tool 和无附件 Capability 的目标契约。
2. 恢复纯本地 `Read`，并从 `@vykor/tools` 完整移除 `ImageToText` / `ImageGeneration` 定义和导出。
3. 增加并测试第一方 `trustedToolOverrides`，保持默认拒绝继承、daemon `Read` 显式信任和原有 cwd 权限边界。
4. 删除 core、QueryEngine、Agent Runtime 中的附件/OCR Capability 接口和 `attachmentResourceRoot`。
5. 在 server 中实现共享的 Child → Root 授权会话解析器、附件 `Read` 覆盖和完整视觉 Tool，并迁移 daemon 装配。
6. 将附件 Catalog 类型和格式化迁到 server，compact 改为通用补充章节，再调整路由与集成测试。
7. 更新架构文档，运行全量验证并分批提交。

每一段都先写或调整失败测试，再实现最小改动。提交不夹带工作区中已有的无关变更。

## 15. 验收标准

1. `createDefaultNodeAgent({ cwd })` 不依赖附件 Host，始终提供通用 `Read`，且默认不提供 `ImageToText` / `ImageGeneration`。
2. core、tools、agent-runtime 的公共类型中不存在附件或本地 OCR Host，`@vykor/tools` 也不定义或导出视觉 Tool。
3. Agent 配置和 inspect 中不存在 `attachments`、`imageToText`、`attachmentResourceRoot`。
4. daemon 中的文本附件仍可通过 `Read(attachment://...)` 分页读取。
5. daemon 中的图片附件仍可通过 `ImageToText(attachment_id)` 做现有本地 OCR。
6. daemon 注册的 `ImageToText` 支持普通本地文件、图片 URL 和授权后的附件；默认 Agent 不承诺这些能力。
7. 附件访问不能跨 session，也不暴露物理存储路径。
8. daemon 使用 `toolOverrides` 接入附件，不存在旧 Capability 兼容通道。
9. 附件目录不再自动挂载到 Agent shell 或 sandbox。
10. Tool 覆盖不绕过 QueryEngine 的统一执行流程。
11. daemon 显式信任自己构造的 `Read` 覆盖，普通 cwd 内本地读取不新增权限询问，cwd 外读取不扩大授权。
12. 未显式声明可信的 SDK 覆盖以及所有 Extension、Plugin、MCP Tool 不继承 builtin 信任。
13. core 和 Agent Runtime 不再包含附件 Catalog 类型或附件 compact 格式化逻辑。
14. 两个附件 Tool 使用同一个正式授权会话解析器，Child 和嵌套 Child 只能继承所属 Root 的附件范围。
15. 图片附件在 OCR 前执行与文本附件相同的 session 引用授权。
16. Schedules、Workflow、Memory 及其他默认能力的 API、装配和生命周期无变化。
17. 相关测试、全仓测试、类型检查和 diff 检查全部通过。

## 16. 最终运行模型

```text
客户端上传附件
  -> daemon 保存附件并建立 session 关系
  -> daemon 把附件引用放进消息或 compact Catalog
  -> daemon 通过 tools(context) 向模型提供 ImageToText / ImageGeneration 和其他动态 Tool
  -> QueryEngine 执行最终同名 Tool
  -> daemon 覆盖 Tool 识别附件输入并校验 session
  -> 附件服务返回文本片段或本地 OCR 结果
  -> daemon 视觉 Tool 直接处理普通图片路径或 URL
  -> ToolResult 回到模型
```

最终边界是：Agent Runtime 提供完整的通用文本/代码 Agent；daemon 通过已有 Tool 注册和覆盖机制增加附件、图生文和文生图能力。视觉功能仍然完整，但不再属于默认 Agent 的能力集合。
