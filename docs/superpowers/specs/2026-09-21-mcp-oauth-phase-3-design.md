# MCP OAuth 第三阶段设计

**日期：** 2026-09-21
**状态：** 两轮独立审核通过，已修订；实施前供用户审阅
**目标：** 在已验收的 Streamable HTTP OAuth 闭环上补齐可靠性、系统安全存储和 App Server 授权入口，保持 CLI、Desktop 与 Session Runtime 的职责清晰。

## 阶段调整与现状

按用户决定，第二阶段尚未收口的“刷新错误分类”和“resource URL 绑定校验”移入第三阶段。第二阶段不再以这两项阻止阶段推进；这表示范围迁移，不表示它们已经实现。

已完成的能力继续复用：PKCE、localhost callback、DCR（动态注册 OAuth 客户端）、独立凭据文件、请求前到期检查、刷新锁、401 单次刷新重试、CLI 手动回调模式、Desktop 授权入口、活动 Session 重连与退出断开、scope 变更后的按需拦截。

用户已报告真实 Linear 登录、读取、重连与退出冒烟测试成功。该结果不覆盖 Token 到期、网络失败、Keyring 或本设计新增接口。

| 第三阶段交付 | 现状 | 本阶段变化 |
|---|---|---|
| 刷新错误分类 | 任意刷新异常都会写入需要重新授权 | 区分临时错误、失效凭据与配置错误 |
| resource 绑定 | 仅校验 metadata resource 的 origin | 明确发现来源、资源标识及 Token audience 参数 |
| OS Keyring + file fallback | 凭据保存在独立 JSON 文件 | Keyring 密钥保护加密记录；明确的文件降级 |
| oauth resource / callback 配置 | resource 使用 endpoint；callback 仅可改端口 | 增加 `oauth.resourceUrl`、`oauth.callbackUrl` |
| App Server 登录与完成事件 | daemon 仅提供 Runtime 查询/同步 | 有界的授权操作、状态查询和完成事件 |
| CLI / Desktop | 各自执行本地授权流程 | daemon 可用时共用操作接口，CLI 离线能力保留 |

## 方案选择

采用现有模块的增量扩展：协议判断留在 `mcp`，存储留在 `auth`，跨 Session 协调与授权操作留在 `server`，界面负责用户交互。保留现有凭据锁，不增加消息队列、后台刷新服务、跨设备同步或自动浏览器授权。

未选择两个更大的方案：把所有授权、存储和连接放进一个新管理器会重新混淆职责；把 OAuth 全面迁移到 daemon 并取消 CLI 离线授权会破坏已经具备的使用方式。

## 职责边界

| 模块 | 负责 | 不负责 |
|---|---|---|
| `packages/mcp` | discovery、resource/issuer/callback 校验、PKCE、DCR、Token 交换与刷新、连接决策、MCP client | 文件路径、OS Keyring、浏览器、HTTP 登录路由 |
| `packages/auth` | 凭据存取、加密、后端选择、迁移、跨进程锁 | OAuth 协议与 Runtime 重连 |
| `packages/server` | 配置读取与提交、授权操作生命周期、Runtime 协调、登录 HTTP 接口 | OS Keyring 的平台 API、界面弹窗 |
| `packages/agent-runtime` | 组装 Session 连接、执行连接决策、工具集合替换、Run 连接租约 | 解析刷新错误、判断 Token 权限、持久化登录流程 |
| `packages/core` / `packages/protocol` | 领域类型 / HTTP 与事件 DTO | Keyring 原生代码和授权执行逻辑 |
| `packages/client`、CLI、Desktop | typed API 调用、显示 URL/结果、用户确认后打开浏览器 | Token、client secret、PKCE verifier 的传递与展示 |

`McpOAuthRuntime.getConnectionAction()` 继续返回 `connect / disconnect / ignore`；agent-runtime 不重新读取或解析凭据记录。Session 配置读取由现有组装入口传给 MCP 层，避免新增全局配置 watcher。

## 交付 A：刷新错误与资源绑定

### 刷新错误分类

复用 SDK 结构化 `OAuthError.errorCode` / 对应错误类。不得靠 `error.message` 的正则猜测 `invalid_grant`。网络包装层仅保存安全的 HTTP 状态码、错误枚举及是否可重试；不保留响应正文、Token 或完整 URL。

| 失败 | 本次请求结果 | 凭据变化 | 下一次使用 |
|---|---|---|---|
| 连接失败、DNS、请求超时、429、5xx、`server_error`、`temporarily_unavailable` | 可重试刷新失败 | 保持原记录 | 再尝试一次正常流程 |
| 用户取消 | 取消 | 保持原记录 | 不自动继续 |
| `invalid_grant`、refresh token 缺失且必须刷新 | 需要重新授权 | 仅对原版本记录标记失效 | 用户显式 login |
| 刷新后重试仍为 401 | 需要重新授权 | 仅标记本次实际使用的凭据版本 | 用户显式 login |
| `invalid_client`、`unauthorized_client`、不支持的 grant/client auth | 配置错误 | 不删除 Token，不无限重试 DCR | 提示检查客户端配置或重新注册 |
| scope 扩张、绑定不一致 | 安全校验失败 | 不发布候选 Token；旧/新记录不得交叉标记 | 明确提示修复配置或重新授权 |
| 凭据文件锁/读写/Keyring 故障 | 存储错误 | 不将授权标记成永久失效 | 修复存储后重试 |

不新增后台刷新或自动退避循环。每次 MCP 请求仍最多执行一次 401 刷新恢复和一次请求重试；临时失败返回调用者，由下一次用户请求重新尝试。

写入失效诊断时必须重新持锁，核对 revision、serverUrl、issuer、resource 和本次使用的 Token 身份。若期间发生 logout 或另一次成功登录，不得创建已删除记录，也不得把新凭据标成失效。比较值只用于内存判断，不写日志。

CAS（先比较版本再更新）未命中时，store 必须真正不写文件、不增加 revision；不能把 `update(current => current)` 当成已经满足该要求。刷新返回给 401 恢复逻辑的内部结果须携带实际落盘 revision 与使用凭据的身份，不能仅返回 Token 字符串再猜测版本。

刷新已在远端轮换 Token、但本地提交失败时，报告存储提交失败；不在同一次调用里再次刷新旧 Token。下一次远端明确返回 `invalid_grant` 时再进入重新授权状态，不能声称旧 refresh token 一定可恢复。

### endpoint、resource 与发现来源

区分两个值：`serverUrl` 是实际 MCP 请求地址；`resourceUrl` 是传给 OAuth 服务、限定 Token 用途的资源标识。授权请求、授权码交换和刷新必须使用同一个已验证的 `resourceUrl`。

增加可选配置：

```json
{
  "mcpServers": {
    "linear": {
      "type": "http",
      "url": "https://mcp.linear.app/mcp",
      "oauth": {
        "scopes": ["read"],
        "resourceUrl": "https://mcp.linear.app/mcp"
      }
    }
  }
}
```

仓库字段统一使用 camelCase；`oauth_resource` 是需求描述中的名称，不再增加一组同义配置键。

discovery 需要返回 metadata 的来源：challenge 指定的地址、endpoint 对应的 well-known 地址、或 origin 根级 fallback。来源信息只在内存中使用。不能从最终 metadata 内容反推并“自证”它可信。

| 发现方式 | metadata 中 `resource` 的期望值 |
|---|---|
| 未配置 override，endpoint 的 challenge 指定 metadata | 本次访问的 MCP endpoint |
| 未配置 override，endpoint 对应的 well-known | 用于构造该 well-known URL 的 endpoint 资源标识 |
| 未配置 override，根级 well-known fallback | 用于构造该根级 URL 的 origin 资源标识 |
| 用户显式配置 `oauth.resourceUrl` | 该配置值；从该资源标识构造 well-known，challenge 不能改变配置值 |

验证分两层：先检查 metadata 的 `resource` 与上述期望值一致，再检查 endpoint 是否属于该资源。后者要求同 scheme/host/port，且 endpoint path 等于资源 path 或位于其完整路径段之下；`/api` 不覆盖 `/api-other`。同源不同租户路径不自动互认。

两种比较不得混用：构造发现请求之前先确定资源标识的实际字符串，并保存为 expectedResource；metadata.resource 与它做完整字符串相等检查，不能在收到 metadata 后通过去斜杠、排序 query 或解码路径把不一致改成一致。输入 URL 的 host/scheme 可在构造阶段按 URL 标准归一；最终以本次实际选定标识为准。

endpoint 包含检查才使用解析后的 origin 与路径段，并拒绝含编码路径分隔符等有歧义的路径。非根 path 的末尾 `/`、大小写和 query 不任意抹平。资源含 query 时必须与 endpoint 的 query 完全一致；资源不含 query 时，metadata 来源校验仍不可跳过。显式 resource 的 metadata 由它自身的 well-known 位置发现，不用 endpoint 的 challenge 来豁免 RFC 精确匹配要求。

缺失/非字符串 resource、userinfo、fragment、不安全协议、不同 origin、兄弟路径均失败。生产授权端点使用 HTTPS；仅测试可启用明确的 loopback HTTP 例外。拒绝令带 Token 的请求自动跟随跨 origin 重定向。

当前 SDK 的 `checkResourceAllowed()` 只有 origin + 路径段包含检查；本阶段可复用这部分，但必须补上 metadata 来源与 query 检查，不直接把 SDK helper 当成完整 RFC 校验。根资源兼容必须由正确的发现来源或显式配置建立，不保留“同域名即通过”的兜底。

凭据 `binding` 增加 `resourceUrl`。旧记录没有该字段时按旧代码实际使用的 `serverUrl` 解释，不在刷新中静默改 audience。新 discovery 或配置选出不同 resource 时要求重新授权。issuer、resource、endpoint、固定 callback 的变化都禁止沿用不匹配的凭据。

## 交付 B：系统安全存储与文件降级

### 方案

Keyring 保存每个配置目录的随机 256 位主密钥；现有凭据文件保存逐服务 AES-256-GCM 加密记录。这样保留现有单文件锁、revision 和原子 rename 提交，不把一次刷新拆成“metadata 文件 + 多个系统秘密”的跨后端事务。

这不是逐 Token 直接塞入 Keyring。该选择避免完整 OAuth 记录超过部分系统凭据项大小限制，也能在 Keyring 临时不可用时删除某一个服务的本地凭据，而不必解密其他服务。

优先采用 `@napi-rs/keyring` 的原生绑定，平台调用封装在 `packages/auth` 一个适配文件内。Linux 明确选择持久化 Secret Service，不接受库自动降级到重启即丢失的内核 keyutils。首次实现需固定兼容版本并完成 Node/Bun/Electron 打包验收；原生模块加载失败按“后端不可用”分类，而不是让 CLI 启动崩溃。

主密钥使用 service `openharness.mcp-oauth`，account 为规范化配置目录绝对路径的 SHA-256 摘要；Windows 路径大小写按现有路径策略统一。CLI、daemon、Desktop 在同一 OS 用户和配置目录下使用同一个键。不同配置目录独立。

### 格式与选择规则

凭据文件升级为 version 2：`servers[name]` 为 `file` 明文记录或 `keyring` 加密 envelope，另保留非秘密的 `logoutEpochs[name]`（见授权并发规则）。每个 envelope 使用独立随机 nonce；认证附加数据绑定格式版本、配置目录摘要和 server name。Token、registration client secret 及完整 binding 均在密文内。内存中仍还原为现有 `McpOAuthCredentialRecord`，上层不感知加密细节。

使用一个非秘密配置开关 `OPENHARNESS_MCP_CREDENTIAL_STORAGE=auto|keyring|file`，默认 `auto`，作用于新登录的存储选择：

| 模式/状态 | 行为 |
|---|---|
| auto + 持久 Keyring 可用 | 加密写入 |
| auto + 平台无持久 Keyring/原生绑定不可用 | 文件写入，CLI/Desktop 显示降级提示 |
| keyring + 不可用 | 登录提交失败，保留旧凭据 |
| file | 新登录使用受权限保护的明文文件，显式显示后端 |
| 既有加密记录 + 密钥丢失/Keyring 锁定或拒绝访问 | 报存储不可用；不得自动降级或生成新密钥覆盖 |

记录已经选定的存储格式是读取和刷新的依据，环境变量变化不能把一次读取变成迁移。刷新沿用该记录后端；显式成功登录可按选择模式替换目标记录。既有加密记录降级为 file 必须来自用户显式选择 file 后的新登录，auto 不执行该降级。

file fallback 在 POSIX 使用目录 0700/文件 0600；Windows 设置仅当前用户及必要系统主体可访问的 ACL，不能把 chmod 成功当作 Windows 权限验证。无法建立所需权限时拒绝写入。

v1 明文记录继续可读。第一次受锁保护的写入将其封装为 v2 的 file 项；目标服务的成功新登录可升级为加密项，其他服务保持原记录。status/list 不迁移、不创建密钥。旧版本客户端读取 v2 必须失败而不是覆盖；升级说明要求同一配置目录中的进程一起更新，不支持新旧版本混写。

### 原子性、退出与打包

继续复用跨进程文件锁。创建/读取主密钥、加密和文件替换发生在同一提交区；新密文写入失败不能先删除原记录。只有“当前文件没有任何加密记录且 Keyring 明确返回不存在”才能创建主密钥；所有服务删除后可据此重新初始化，无需额外历史标记。锁定、拒绝与不可用均不等于不存在。认证失败或既有密文的密钥缺失不当成空凭据。

logout 的远端撤销是尽力而为；本地删除不依赖解密成功。即使 Keyring 锁定，也要在文件锁内移除目标 envelope 并通知 Runtime 断开。不得把凭据读取放在删除保障的 try/finally 之外。退出不删除主密钥，避免破坏其他服务或并发写入。

快照新增可选 `credentialStorage: "keyring" | "file"` 和安全的存储故障/降级提示；不返回主密钥、nonce 对应明文、密文、系统 account 标识或秘密文件内容。读取某项失败时该服务的 `authStatus` 使用新增 `unavailable`，其余服务仍正常列出；不能把存储锁定显示成未登录或已失效。CLI/Desktop 同批更新此枚举，HTTP 客户端通过能力声明确认支持。

加密记录备份只包含密文，不包含系统密钥；恢复需要同一 OS 用户、配置目录身份和 Keyring 密钥。跨机器/跨配置目录转移秘密不在本阶段支持范围内，不能把复制凭据文件描述成可移植备份。

原生绑定作为按平台安装的可选依赖；CLI bundle、agent-runtime bundle 与 Electron packaging 必须正确 externalize 并携带实际二进制。CI fake backend 只覆盖逻辑，发布前必须分别在 Windows、macOS、Linux Secret Service 和无 Keyring 环境验证写入、跨进程读取、重启后读取、删除及降级。

## 交付 C：自定义 callback 与 App Server 授权操作

### Callback 配置

`oauth.callbackPort` 保持兼容。新增 `oauth.callbackUrl`；两者同时配置时报配置冲突，避免实际注册 URI 与监听地址分离。

- 未配置完整 URL：保留 `http://127.0.0.1:<随机或指定端口>/oauth/callback`。
- `http://127.0.0.1:<端口>/<路径>` 或 `http://[::1]:<端口>/<路径>`：只监听该 loopback 地址，允许自定义端口和路径。禁止 0.0.0.0、通配地址及非 loopback HTTP。
- HTTPS URL：只在手动回调模式下接受；使用用户已经拥有并在授权服务中登记的接收地址。本项目不托管公网回调代理，不请求该 URL 去“取回”授权码。
- 自定义 URL 不允许 userinfo、fragment、固定 query；端口和路径在启动前验证。授权、DCR、交换和回调校验使用同一个不可变 redirect URI。

手动提交的完整 callback URL 视为秘密输入：拒绝 userinfo/fragment，校验 origin/path、state、issuer，再处理 code/error。畸形请求、无关路径或无效 state/issuer 不能消费合法授权的等待状态。通过这些校验的 `error=access_denied` 则消费一次并结束 failed；不能让用户拒绝授权后继续等待。浏览器的 favicon 或无关路径请求返回 404。成功 callback 只能消费一次。

### 授权操作接口

授权仍显式由用户点击按钮或执行 CLI login 开始；模型调用遇到需要重新授权时只返回操作提示。

由 daemon 的应用层持有授权操作，HTTP 路由只做校验/转换：

| 接口 | 用途 |
|---|---|
| `GET /mcp/oauth/status` | 读取当前服务认证快照，含存储状态与 Runtime 状态 |
| `POST /mcp/:name/oauth/login` | `{oauthInstanceId, requestId, scopes?, callbackMode:"local"|"manual"}`；创建操作，返回 202 与 `loginId` |
| `GET /mcp/oauth/operations/:loginId` | 查询当前操作、可用的授权 URL 和最终安全结果 |
| `GET /mcp/oauth/operations/:loginId/events` | 订阅当前状态及完成事件 |
| `POST /mcp/oauth/operations/:loginId/callback` | 手动模式提交 `{callbackUrl}` |
| `DELETE /mcp/oauth/operations/:loginId` | 取消未提交的授权操作 |
| `POST /mcp/:name/oauth/logout` | 删除凭据并同步活动 Runtime |

所有接口继承 daemon Bearer、协议版本与 origin 校验；只接受已配置服务，不允许请求体直接覆盖任意 endpoint、issuer、resource 或 redirect URL。当前范围为同一用户配置的本地 daemon；不提供多用户授权隔离或跨账号凭据代理。

能力握手提供本次 daemon 启动的随机 `oauthInstanceId`，创建请求必须携带该值。同一实例内，同 requestId + 相同输入返回同一操作，不重复启动 callback/DCR；同 requestId 不同输入返回 409。先查幂等记录再检查容量。同一服务只有一个未完成登录，新请求返回 busy，不抢占已有授权。

最多保留 20 个未完成操作，超过返回 429；pending 超时为 5 分钟；终态保留 10 分钟，总缓存上限 100 条，优先清理已过期终态。若 100 条都未过期则新创建返回 429，不能提前淘汰而破坏幂等保证。查询和重放不受创建限额影响。超时/终结释放 callback listener 与 timer；SSE 断开释放对应订阅。

daemon 重启后操作丢失；旧实例创建请求返回实例冲突，不在新实例自动重新授权，旧 loginId 查询返回 404。客户端要求用户重新显式发起。受理响应丢失时仅可带原 instanceId + requestId 重试；不能更新实例标识后透明重发。

状态仅使用 `pending / completed / failed / cancelled`。操作内部沿用现有 discovery→callback→候选验证→提交→Runtime 同步顺序。候选 Token 与 PKCE/state 只留在该操作内存中，提交前不进入共享凭据。

`completed` 表示凭据已提交；结果另含 `runtimeSync` 和警告。凭据提交成功、Runtime 同步失败不是“授权失败”；CLI 仍按现有约定非零退出，Desktop 保留已登录状态并显示同步警告。`failed` 表示没有新凭据成功提交；`cancelled` 表示提交前已取消。

取消、超时与同进程 logout 先在队列外设置 abort，及时中断 discovery、callback 和候选验证，再进入按服务串行入口收尾。取得文件锁后、写入 settings 之前再次检查取消信号。已真正进入提交步骤时取消返回冲突/已完成，最终查询反映提交事实；不能声称已经回滚成功提交的凭据。

跨进程防护复用 v2 文件中的 `logoutEpochs`：登录开始时持锁读取服务 epoch（缺省 0）；提交时在同一文件锁内比较；logout/remove 即使目标凭据已经为空也递增 epoch，删除后保留该值。任何旧登录的迟到 callback 都不能通过 epoch 检查。普通刷新、诊断更新及成功登录不递增 logout epoch；跨进程同时成功登录仍按原先最后成功提交者生效。

logout 必须尽早持锁递增 epoch 并从本地可读集合删除记录，再用已取得的旧凭据尽力远端 revoke，并通知 Runtime。Keyring 不可读时跳过 revoke，仍完成删除与通知。撤销不能在删除之后重新读共享 store 取 Token，以免撤销另一次新登录。

同一提交区还要重新加载配置，比较本次授权启动时的 endpoint、显式 resource、固定 callback、clientId 与配置 scope 集合。等待浏览器期间这些值发生变化则拒绝候选提交与 scopes 写入；不能把过时授权提交给修改后的服务。未修改的 scopes 仍可被本次用户显式选择值更新。

完成事件中的 `credentialCommitted` 是历史操作事实；logout 或后续登录之后，当前认证状态仍须从最新服务 snapshot 获取，不能以旧 completed 事件恢复“已登录”。

### 完成事件与敏感信息

每个操作提供独立 SSE，事件名 `mcp.oauth.login.completed` 携带 `loginId`、server name、终态、稳定错误码、凭据是否提交及安全 Runtime 同步摘要；失败/取消同样产生终态事件。操作建立订阅时先登记监听再读取状态；已经终结的操作立即返回终态并结束流，不要求客户端恰好在 callback 前在线。

授权 URL 就绪时发送安全的 `mcp.oauth.login.updated`，其中仅含 `authorizationReady: true`，客户端据此通过受认证的 GET 操作接口取得 URL。初始状态同样含此布尔值，保证迟订阅也能继续；该事件不含 URL 或 callback 参数。完成后通过 `/mcp/oauth/status` 重新取得当前认证状态。

只保留内存中的最新状态和终态；不把 OAuth 操作塞进需要 Session 的持久事件表。断线后 GET 操作状态即可恢复，不建设通用事件日志。SSE 和普通状态可重复到达，客户端按 loginId + 终态幂等处理。

授权 URL 只由带认证的创建/查询响应提供，响应 `Cache-Control: no-store`。普通完成事件、访问日志和错误不能含 URL query、state、code、verifier、Token 或 client secret。手动 callback 放在 POST body，不进 URL/query；日志中不记录请求/响应 body。前端仅在用户触发的本次操作中持有授权 URL。

### CLI、Desktop 与无浏览器模式

- daemon 可用且声明该能力时，CLI/Desktop 使用 `@openharness/client` 的操作接口；浏览器由 CLI/Desktop 本机打开，daemon 不执行系统 open 命令。
- CLI 的 `--no-browser` 明确打印授权 URL 并接收粘贴 callback URL；本地与 daemon 两条路径保持同样的 URL/state/issuer 校验。
- CLI 未运行 daemon 时保留现有本地应用服务执行，不为 login 启动 daemon。401、协议不兼容或操作已经被受理后的网络中断不触发本地重新登录；受理响应丢失时用同一 requestId 恢复。
- Desktop 在创建授权操作前完成现有 daemon 连接/接管动作；创建后固定 instanceId/loginId，不在掉线时切到其他 daemon 或本地授权。已启动的旧 daemon 不支持该功能时提示更新/重启。只有操作尚未受理、也未发出可能已受理的请求时，明确离线才可沿用现有本地应用服务路径。
- Electron main 持有 Bearer、授权 URL、SSE 和 `shell.openExternal()`；renderer 只接收安全状态、loginId 及按钮动作。关闭窗口释放 UI 订阅，daemon 仍存活则操作继续；关闭内置 daemon 时 abort 所有未提交操作并清理 listener，正在提交的操作等待提交点收尾。
- Desktop 延续首次授权、重新授权与退出按钮，补充取消和安全失败提示。scope 变更仅在下一次使用时拦截并提示；本阶段不增加工具调用自动暂停、自动弹浏览器或授权后自动重放写操作。

## DCR 与旧凭据兼容

已有 DCR 继续复用，显式 clientId 优先。client registration 必须与 issuer、resource、redirect URI 相匹配；不为每次临时刷新重新注册。callback 固定地址/资源绑定改变后，新显式登录才取得新的注册或使用用户配置的预注册 clientId。

不新增 Client ID Metadata Documents 托管服务、不支持多账号同时登录同一个 name。第三阶段的“Codex 对齐”是列出的能力对齐，不承诺兼容 Codex JSON-RPC 方法名、配置文件或凭据库。

## 分批验收

第三阶段按三个可独立交付的批次形成实施计划，顺序为 A→B→C。按用户本次要求，设计独立审核修订通过后编写计划；代码实施等待用户审阅本设计及计划后安排。

### A：协议可靠性

- timeout/429/5xx/取消不修改 Token 或诊断；结构化 invalid_grant 才按条件写失效。
- 两个进程并发刷新时只保留最终 Token；旧失败不标记新凭据，logout 不被旧失败复活。
- 表格覆盖 metadata challenge、路径 well-known、根 fallback、显式 resource、兄弟路径、跨 origin、query 与编码差异。
- 授权、交换和刷新捕获的 resource 参数完全一致；旧记录更换 audience 时请求被拦截。
- 用真实 Linear 再验收一次，发现兼容性差异必须说明具体 metadata 来源，不能退回 origin-only 校验。

### B：存储

- fake Keyring 断言成功、缺失、锁定、拒绝、文件提交失败与解密失败；临时不可用不生成替代密钥。
- v1→v2、混合记录、成功登录升级和刷新保持后端都有 fixture；恢复错误不能覆盖原文件。
- CAS 未命中不增加 revision；logout epoch 在空记录和加密不可读时仍更新，旧登录无法跨退出提交。
- Keyring 锁定时 logout 仍删除目标记录并断开 Runtime。
- Node、Bun、Electron 的安装产物可读同一份已加密记录，实际 OS Keyring 重启测试通过。

### C：控制面与界面

- 登录创建、URL 获取、手动 callback、取消、超时、busy、重复 requestId、同实例响应丢失恢复、跨实例拒绝恢复和终态重放；缓存未过期满额时拒绝新建。
- 取消/提交/logout 并发测试；未认证和非法 origin 请求在产生副作用前拒绝。
- completed + Runtime 警告保持有效凭据；CLI 退出码与 Desktop 状态一致。
- CLI 本地、CLI daemon、Desktop 三条路径使用同一协议与 store，不传 Token 到 renderer。
- 固定端口冲突、无关 callback 路径、错误 state/issuer、重复 callback、HTTPS 手动回调都有测试。

本阶段不修改 agent-runtime 的通用推理循环，也不扩大 Session 权限。回归必须包含 scope 按需拦截、静态 Header 优先、Run 连接租约和 logout 强制断开。

## 依据与代码落点

协议依据：[MCP 2025-11-25 Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)、[RFC 9728 §3.3](https://www.rfc-editor.org/rfc/rfc9728.html#section-3.3)、[RFC 8707](https://www.rfc-editor.org/rfc/rfc8707.html)、[RFC 6749 §5.2](https://www.rfc-editor.org/rfc/rfc6749.html#section-5.2)。前述 metadata 来源校验与 resource 使用依据这些规范；显式 override 的限制、存储格式和操作接口为本项目设计。

原生绑定依据：[keyring-node README](https://github.com/Brooooooklyn/keyring-node/blob/main/README.md)。Linux 必须固定持久化后端；不能把内核 keyutils 的可写误报成持久安全存储。

主要现有落点：

- `packages/mcp/src/oauth/runtime-auth.ts`、`protocol.ts`、`login.ts`、`callback.ts`：协议校验与错误分类。
- `packages/auth/src/mcp-oauth-credential-store.ts`：锁、记录格式、后端与迁移。
- `packages/core/src/types/mcp-oauth.ts`、`packages/core/src/config/settings.ts`：配置字段和领域契约。
- `packages/server/src/application/mcp-oauth-application-service.ts`、`packages/server/src/http/routes/mcp.ts`：操作编排与路由。
- `packages/client/src/resources/mcp-resource.ts`、CLI MCP command、Desktop MCP service/settings：用户入口与 typed API。
- `apps/cli/build.ts`、`packages/agent-runtime/scripts/build.mjs`、`apps/desktop/electron-builder.yml`：原生依赖打包。
