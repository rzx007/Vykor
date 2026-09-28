# MCP OAuth 第三阶段验收记录

**日期：** 2026-09-28
**范围：** [第三阶段设计](../specs/2026-09-21-mcp-oauth-phase-3-design.md) 与 [实现计划](../plans/2026-09-21-mcp-oauth-phase-3.md)
**当前结论：** 接手审核修复后，任务 1–8 已实现并通过下列自动检查；任务 9 的真实服务与安装产物验收仍未完成。无 Git 提交，改动保留在工作区。

> 本记录不是真实平台验收报告。本轮未执行真实 Linear 授权和安装版 Desktop 交互；受控 OAuth 集成、真实 HTTP 中间件及真实 loopback 回调测试不能替代这些验收。

## 接手审核与修复（2026-09-28）

两位子代理先分别审核协议/存储和服务端/接口，修复后交叉复审；任务 8 由独立实现者补齐，再进行入口复审。主线程核实发现并补充应用服务回归与受控全流程测试。已报告的阻断问题均已修复；原有暂存的 `notification-observer.test.ts` 未动，未创建提交。

| 审核发现 | 修复及证据 |
|---|---|
| 合法根级 resource 登录后被强制按 endpoint 判错；metadata 被归一化后才比较 | 沿用登录时验证过的资源，metadata 完整字符串比较，补路径末尾斜杠边界 |
| 删除固定回调/clientId 配置未触发重新授权；完整 callbackUrl 接受端口 0 | 保存显式配置与未配置标记；拒绝显式端口 0，保留默认随机端口 |
| 首次 401 重新读取凭据，可能把失败归因于新登录 | 保存实际使用版本并做条件更新；没有旧记录时不标记随后出现的新记录 |
| 429/5xx 正文含 invalid_grant 可能永久标失效；文件 IO 失败混入网络错误 | 临时 HTTP 状态优先；存储失败单独分类，保留凭据 |
| Token 请求可随重定向向其他地址发送秘密 | 禁止自动重定向，真实双 loopback 服务回归验证 |
| 非法手动 callback 结束整次授权；本地 callback 先到后输入仍悬挂 | 无效输入可重试；每次提交有校验反馈；单独取消输入等待，不取消已接受的授权 |
| 取消未贯通候选连接验证；等待 settings 写锁时仍可能提交 | signal 传入 SDK/fetch；实际 settings 修改前再次检查，真实 initialize 中途取消测试覆盖 |
| 空退出的 revoke 再取 store，可能删除后来登录；epoch 读取未持锁 | 显式空旧记录不再二次取删；epoch 持锁只读，两个真实 store 验证等待与提交顺序 |
| GET 恢复丢失重连警告，终态仍留授权 URL，SSE 断开不清订阅 | GET 保留 runtimeSync，终态清 URL，有界过期清理，流退出释放订阅 |
| logout 同步警告被 HTTP 吞掉；内部取消被误记 failed | 返回安全的已删除/同步失败错误；退出中止使用 AbortError |
| Desktop 浏览器异常可能带 URL 泄漏，重复事件可能打开两次；关闭窗口留下订阅 | 固定安全错误、共享打开过程、窗口销毁清本地记录与订阅，不取消仍存活 daemon 的操作 |
| CLI 手动输入与事件流互相阻塞，断流时操作恢复不完整 | 输入与 SSE 并行；同实例/同 requestId 或 loginId 恢复，结束始终清本地 watcher |

### 任务 8 实际交付

- CLI 在兼容 daemon 可用时走 typed API；明确离线才用本地授权，registry 损坏/认证失败/受理后断线不静默切换。手动模式打印 URL、允许重输 callback，取消会释放输入与订阅。
- Desktop 复用现有 daemon 接管流程。main 保存授权 URL、订阅和浏览器打开动作；IPC/preload 只传安全状态和取消动作。界面只修改主页插件页的 `mcp-manager.tsx`，不恢复设置页入口。
- 取消与提交竞争时按实际返回结果提示；凭据已保存但 Runtime 同步失败不回滚授权。CLI 返回非零，Desktop 保留最新快照并提示警告。
- 不引入 Keyring、加密、原生依赖、后台刷新服务或通用任务框架。

### 本轮验证证据

下列 Vitest/tsc 命令使用仓库或对应包内 `node_modules/.bin/*.CMD`；Desktop 的 Vitest 来自仓库根目录。沙箱无法读 pnpm 依赖时获批在沙箱外运行，未重装依赖。

| 工作目录 / 命令 | 结果 |
|---|---|
| packages/mcp：`vitest run` | 10 文件 / 156 测试通过 |
| packages/auth：`vitest run` | 5 文件 / 45 测试通过 |
| packages/server：OAuth application、operation、flow、MCP config、runtime coordinator、MCP routes 六组 | 6 文件 / 78 测试通过 |
| packages/server：真实 HTTP OAuth 认证/Origin/协议/能力定向测试 | 1 测试通过；覆盖七个接口未认证拒绝、非法 Origin、协议版本与 instanceId |
| packages/protocol：`vitest run src/mcp-oauth.test.ts src/capabilities.test.ts` | 17 测试通过 |
| packages/client：MCP resource 与 protocol-handshake | 16 测试通过 |
| packages/core：`vitest run src/config/settings.test.ts` | 26 测试通过 |
| packages/agent-runtime：`vitest run src/runtime-integrations.test.ts` | 26 测试通过 |
| apps/cli：MCP command 与 runtime coordinator | 34 测试通过 |
| apps/desktop：MCP service、preload、plugin-page/mcp-manager | 33 测试通过 |
| core、mcp、auth、agent-runtime、protocol、server、client、CLI 的 `tsc --noEmit` | 退出码 0 |
| Desktop：`tsc --noEmit -p tsconfig.node.json --composite false` 与 web 对应配置 | 均退出码 0 |
| `pnpm check:client-api` | 退出码 0：契约检查、31 个脚本测试、4 个公开 API 测试通过 |
| `node scripts/architecture-boundaries.mjs` | 退出码 0，未放宽架构基线 |
| `pnpm --filter @rzx/ohs build` | 退出码 0，CLI 构建成功 |
| `node apps/cli/dist/index.js mcp login --help` | 退出码 0，构建产物显示 scopes 与 no-browser 选项 |
| `node scripts/check-docs.mjs`、`git diff --check` | 退出码 0；文档检查通过，diff 无空白错误 |

新增 `packages/server/src/application/mcp-oauth-flow.test.ts` 使用真实 SDK、临时文件凭据 store、应用服务、操作服务和路由，仅替换外部提供方 fetch：覆盖发现、PKCE、错误 callback 重试、Token 交换、initialize/tools/list 验证、落盘、终态事件及退出撤销。它不是访问真实 Linear，也不是安装产物验收。

### 仍需人工/环境验收

1. 更新同一配置目录下的 CLI、daemon 和 Desktop，停止旧进程后再测试；v2 凭据文件不支持旧客户端混写。
2. 真实 Linear：本地 CLI、daemon CLI、Desktop 授权、读取、重连、退出，以及手动模式与固定 callback。不要为兼容服务而退回 origin-only 校验。
3. 安装产物中的 Desktop 点击/关闭窗口/取消流程，以及真正两个 OS 进程的文件锁竞争。已有两个 store 实例测试不能冒充两个进程验收。
4. 文件 rename 失败保持原记录的专项故障注入尚未覆盖；未声称完整跨平台权限加固或安装包验收。

## 首轮实现者交接（历史证据）

以下保留接手前任务 1–7 的实现和测试记录；其中“任务 8 未实现”等状态已由上面的本轮结果取代，不能作为当前完成状态。

## 执行基线

- 起始 HEAD：`61c8639db37ad759c2398a80bc4ba051bfde3c5c`（分支 `main`）。
- 起始工作区已有、非本次改动：暂存的 `apps/desktop/.../notification-observer.test.ts`，以及 `docs/superpowers/**` 四份文档的既存修改。上述内容未被覆盖、回退或提交。
- 本轮在 Windows 下用 `node_modules/.bin/vitest.CMD` 与 `node_modules/.bin/tsc.CMD` 运行，绕开 pnpm 沙箱的文件访问限制，未重装依赖。

## 实现范围与改动文件

### 任务 1：刷新错误分类与条件诊断

- `packages/mcp/src/oauth/runtime-auth.ts`：按 SDK 结构化 `errorCode` 分类；临时失败（网络/超时/429/5xx/`server_error`/`temporarily_unavailable`）保持记录；`invalid_grant` 才标记重新授权；配置类错误提示检查客户端；取消原样结束。失效写入改为 CAS：仅当 `revision`、`serverUrl`、`issuer`、`resourceUrl` 与本次实际使用的 Token 身份一致才写入；未命中不写文件、不递增 revision。
- `packages/mcp/src/oauth/errors.ts`：沿用 `McpOAuthError(code, message, retryable)`。
- `packages/auth/src/mcp-oauth-credential-store.ts`：`runExclusive` 增加 `CredentialMutationContext`（`nextRevision`、`logoutEpoch`），操作返回原记录视为 no-op，不写文件、不增 revision。
- 测试：`runtime-auth.test.ts`（表驱动 timeout/429/503/取消/普通 message 与 SDK `InvalidGrantError`）、`mcp-oauth-credential-store.test.ts`（no-op 不改文件、CAS 未命中不复活删除项）。

### 任务 2：resource 发现来源、配置与凭据绑定

- 新建 `packages/mcp/src/oauth/resource-binding.ts`：`ResourceDiscoverySource`、`validateResourceBinding`、`endpointBelongsToResource`、`resourceMetadataCandidates`、`normalizeResourceUrl`。metadata `resource` 与 expected 做完整字符串比较，不做去斜杠/排序/解码；endpoint 需同 scheme/host/port 且处于资源完整路径段之下；拒绝编码路径分隔符、userinfo、fragment、不安全协议。
- `packages/mcp/src/oauth/protocol.ts`：`discoverOAuth` 先确定 expectedResource 与来源（challenge / endpoint-well-known / origin-well-known / explicit），再逐个候选获取 metadata 并校验；显式 `oauth.resourceUrl` 优先且 challenge 不能替换。
- `login.ts` / `runtime-auth.ts` / `status.ts`：授权、授权码交换、刷新使用同一个已验证 `resourceUrl`；凭据 `binding.resourceUrl` 落盘；旧记录按 `serverUrl` 解释；endpoint/resource 变化触发重新授权。
- `packages/core/src/types/mcp-oauth.ts`、`config/settings.ts`：新增 `oauth.resourceUrl`、`binding.resourceUrl` 及 settings 白名单/类型校验。
- `packages/agent-runtime/src/runtime-integrations.ts`：`getConfiguredScopes` 收敛为 `getConfiguredOAuth(name, config)`，返回最新非秘密 OAuth 设置。
- 测试：`resource-binding.test.ts`、`protocol.test.ts`（challenge/路径 well-known/根 fallback/显式 override/兄弟路径/跨 origin/query/编码）、`login.test.ts`（三种 resource 参数一致性）、`status.test.ts`、`settings.test.ts`。

### 任务 3：最小文件格式与跨进程退出保护

- `mcp-oauth-credential-store.ts`：v1 只读不迁移；首次实际写入原子升级为最小 v2（`{version:2, logoutEpochs, servers}`）；未知版本/非法 epoch 报错不覆盖；`readLogoutEpoch`、`takeAndDelete`（空删除也递增 epoch，溢出报错）；普通 `delete` 委托 `takeAndDelete`。
- `packages/mcp/src/oauth/login.ts`：`revokeMcpOAuthCredential` 改为对已取出的旧记录尽力撤销，删除后不再读共享 store。
- 测试：auth store 11 项（含并发两实例、v1→v2 升级保留他服务、epoch 递增、`takeAndDelete`、溢出、非法版本）。

### 任务 4：完整 callback URL 与抗无关请求干扰

- `packages/mcp/src/oauth/callback.ts`：`oauth.callbackUrl` 支持（loopback HTTP 监听指定 host/port/path；HTTPS 仅手动模式，不监听、不请求公网）；`callbackUrl` 与 `callbackPort` 冲突报错；校验与消费分离——无效路径/state/issuer 只回失败且不消费等待，`access_denied` 消费一次并结束 failed，重复成功回调被拒；无关路径 404；abort/timeout 关闭监听器与 timer。
- `login.ts`：DCR/授权/交换共用冻结 `redirectUri`；新增 `onAuthorizationUrl`，自动/手动都通知一次；手动模式不打开浏览器。
- `packages/core/src/types/mcp-oauth.ts`、`config/settings.ts`：新增 `oauth.callbackUrl`。
- 测试：`callback.test.ts`（真实 loopback server）、`login.test.ts`（冲突、单次通知、HTTPS 手动回填）。

### 任务 5：应用服务可取消提交与跨进程 logout

- `packages/server/src/application/mcp-oauth-application-service.ts`：`login` 保留 CLI 现有非零退出语义；新增 `beginLogin` 返回 `McpOAuthCommitOutcome`（`credentialCommitted` + `runtimeSync`），已提交但同步失败不再视为授权失败。启动时捕获 `logoutEpoch` 与授权相关配置（endpoint、resource、callback、clientId、scopes）；文件锁内、写 settings 前复核取消信号、epoch 与配置，未修改的 scopes 仍可被本次显式选择更新。logout 先 `takeAndDelete` 落盘再尽力 revoke 旧记录，本地删除失败如实报错。
- 测试：`mcp-oauth-application-service.test.ts` 17 项（取消等待浏览器/等待文件锁/提交后取消、配置变更、另一 store 实例 logout 提升 epoch、最后提交生效、logout 同步告警）。

### 任务 6：有界授权操作与状态订阅

- 新建 `packages/server/src/application/mcp-oauth-operation-service.ts`：单 Map + 每操作订阅集合；随机 `oauthInstanceId`；requestId 幂等（同输入重放、异输入 409）；同服务 pending busy；pending 上限 20、总缓存 100、终态保留 10 分钟；pending 超时 5 分钟；手动回调 deferred；`cancel` 先 abort 再等收尾；`close` 停止接收、abort 未提交并等提交区收尾；GET 纯读；终态订阅立即返回并关闭。
- `daemon-application.ts` / `application/index.ts`：daemon 持有并导出 `McpOAuthApplicationService` 与 `McpOAuthOperationService`，关闭时 `close()`。
- 测试：`mcp-oauth-operation-service.test.ts` 10 项。

### 任务 7：协议、HTTP/SSE 与 typed client

- 新建 `packages/protocol/src/mcp-oauth.ts`（+测试）：登录/回调/操作视图/事件/状态快照 DTO 与校验；长度上限、禁止任意 endpoint/redirect 覆盖、错误响应只含安全字段。
- `capabilities.ts`（+测试）：`features.mcpOAuth = 1` 与 `mcpOAuth: { instanceId }`，缺失仍兼容旧 server。
- `packages/server/src/http/routes/mcp.ts`（+测试）：`GET /mcp/oauth/status`、`POST /mcp/:name/oauth/login`、`GET/DELETE /mcp/oauth/operations/:loginId`、`GET .../events`（SSE）、`POST .../callback`、`POST /mcp/:name/oauth/logout`，全部 `no-store`，callbackUrl 仅 POST body；操作错误映射 400/404/409/429/503。`routes/system.ts`、`http/server.ts` 注入 instanceId 与两个服务。
- `packages/client/src/resources/mcp-resource.ts`（+测试）：`authStatus/startLogin/getLogin/watchLogin/submitCallback/cancelLogin/logout`，SSE 复用现有 transport 并支持 `AbortSignal`。
- 未改动 `packages/client/src/index.ts` 导出集合，`check:client-api` 保持通过。

### 计划任务 8：未实现

CLI 的 daemon 操作路径、Desktop main/IPC/preload 与 `mcp-manager.tsx` 的取消/SSE 接入均未改动。CLI 仍走“明确离线时的本地授权”，与第三阶段现状一致；daemon 虽已暴露任务 7 的接口，但尚无用户入口调用它。

## 测试命令与结果

| 命令（工作目录） | 结果 |
|---|---|
| `vitest run`（packages/mcp） | 通过：10 文件 / 134 测试 |
| `vitest run`（packages/auth） | 通过：5 文件 / 43 测试 |
| `vitest run`（packages/protocol） | 通过：11 文件 / 112 测试 |
| `vitest run src/mcp-oauth-application-service.test.ts src/mcp-oauth-operation-service.test.ts src/mcp-config-application-service.test.ts src/mcp-runtime-connection-coordinator.test.ts src/http/routes/mcp.test.ts`（packages/server） | 通过：5 文件 / 70 测试 |
| `vitest run src/runtime-integrations.test.ts`（packages/agent-runtime） | 通过：26 测试 |
| `vitest run src/config/settings.test.ts`（packages/core） | 通过：26 测试 |
| `vitest run src/resources/__test__/mcp-resource.test.ts`（packages/client） | 通过：8 测试 |
| `vitest run src/commands/mcp.test.ts`（apps/cli） | 通过：15 测试（回归） |
| `tsc --noEmit`（mcp / auth / core / agent-runtime / protocol / server / client / cli / desktop） | 全部退出码 0 |
| `pnpm check:client-api` | 退出码 0（含 client 导出契约、架构边界、负向 fixture） |
| `node scripts/architecture-boundaries.mjs` | 退出码 0 |
| `node scripts/check-docs.mjs` | 退出码 0 |

未运行：真实 Linear 授权、daemon 端到端、Desktop/CLI 的 daemon 授权流程、跨进程真实文件锁竞态、`pnpm check-types`（turbo 全量；按包分别跑了 tsc）。

## 设计符合性与剩余风险

- **并发/CAS**：`runExclusive` 的 no-op 语义以对象引用判定；`markReauthentication` 的 CAS 覆盖 revision、endpoint、issuer、resource 与 Token 身份。刷新在远端已轮换但本地提交失败时按“提交失败”处理，不再用同一次调用的旧 Token 重试（设计第 65 行的要求由此满足）。
- **取消**：应用服务在锁内、写 settings 前复核 `signal.aborted`；已进入提交区后取消不保证回滚（与设计“取消返回冲突/已完成”一致），提交事实以 `credentialCommitted` 为准。
- **退出**：logout 先落盘递增 epoch 再 revoke；epoch 检查在提交锁内。store 的 epoch 溢出与非法值均报错。
- **敏感信息**：授权 URL 只出现在受认证的 GET/创建响应且 `no-store`；SSE 只含 `authorizationReady` 与安全终态；未发现 Token/secret/verifier 进入事件、日志或 DTO。
- **模块边界**：mcp 未依赖 auth；协议判断在 mcp，存储在 auth，编排在 server；agent-runtime 只提供配置读取。
- **剩余风险**：
  1. 真实 Linear 的 metadata 是否落在 challenge / endpoint-well-known / origin 中某一分支未验证；若其根级 metadata 报 `resource` 为 endpoint 而非 origin，会按设计被拒（需真实验收确认，不应退回 origin-only 兜底）。
  2. `packages/mcp` 通过 `errorCode` 结构化字段识别 SDK 错误，未直接 `import` SDK 错误类；若 SDK 变更该字段名需同步。
  3. 任务 8 未做，daemon OAuth 接口目前无 CLI/Desktop 调用方；新增的 7 条路由与 operation service 仅在路由单测与注入假应用下验证，未跑真实 daemon。
  4. `rename` 失败保留原文件的场景缺少可控注入点，未单测覆盖（仅由 `write` 的临时文件清理逻辑保证）。
  5. 预存的暂存改动与文档改动原样保留在工作区，本轮未提交。

## 交接摘要

- **已验证**：上述测试与 tsc、`check:client-api`、架构与文档检查全部通过。
- **未验证**：真实 Linear、真实 daemon 端到端、CLI/Desktop 授权流程、任务 8 全部用户交互。
- **受阻**：任务 8 需在 daemon 运行/接管语义与 Electron IPC 上继续，建议单独一轮实现并补 `mcp-manager.test.tsx`。
- **建议后续**：先在本地受控 OAuth server 上跑任务 5/6/7 的端到端，再对真实 Linear 执行任务 9 的真实验收；随后以既有 `plugin-page/mcp-manager.tsx` 为唯一入口接入任务 7 的 client 方法，不恢复旧设置页。
