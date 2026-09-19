# Security and Trust Boundaries

> 状态：当前认证、权限、运行环境/SRT、Secret、Owner 和 Channel ACL 的权威总览。最后核对：2026-09-08。

## 先分清六道门

```text
客户端能不能连接 daemon？       -> Bearer token
这个进程能不能写这份数据库？    -> Application Owner
这个 Tool 这一次能不能执行？     -> Permission
模型启动的进程在哪里、能碰什么？ -> ExecutionEnvironment + SRT
外部聊天是谁发来的？             -> Channel ACL
Provider 密钥放在哪里、谁能看？  -> Credential Storage / host
```

它们解决不同问题，不能互相代替。拿到 daemon token 不代表所有 Tool 自动批准；选择 WSL 或启用 SRT 也不代表可以接受陌生 Bot 用户；Owner 只能阻止双写，不能认证远程客户端。

## 信任边界

```text
用户 / 外部平台
       |
  产品入口与 Channel adapter
       |  Bearer token / ACL
       v
Durable Agent Application ---- Credential Storage / provider
       |  Permission decision
       v
Agent Runtime ---- ExecutionEnvironment ---- 文件、进程、终端、Git、MCP
                         |
                   Native 可选 SRT
```

## Daemon Bearer token

daemon HTTP API 需要 Bearer token。它保护 Session、消息、Run、权限决定、设置和运维接口。

- token 由宿主保存和传给 client，不应写进 URL、日志或前端状态快照。
- 浏览器远程接入还要限制允许的 Origin。
- `/health` 是否公开由部署方式决定；业务 route 不能因为在 localhost 就跳过认证。
- 发生 401/403 时客户端应停止业务重试，提示重新连接或授权。

## Application Owner

Owner 用数据库租约保证同一数据目录只有一个活动写入者。租约包含 owner ID、PID、generation 和心跳时间。

它防止双 daemon 同时写入和旧 generation 在接管后继续写，但不防止本机其他进程读取数据库文件。文件系统权限仍由部署者负责。

## Tool Permission

Permission 是每次 Tool 执行前的业务决定：

```text
Runtime 发 permission.requested
  -> Application 保存 pending request
  -> TUI/Desktop/其他授权客户端回复
  -> Application 原子决定一次
  -> Runtime 收到 approved / denied / expired
```

禁止规则优先于自动批准和白名单。`disallowedTools`、危险命令和拒绝路径不能被 session approval 绕过。多个客户端同时回复时只有第一个有效决定成功，之后的回复得到冲突。

Permission 决定“允许不允许做”，不保证操作成功，也不证明操作没有在超时前发生。

## 运行环境与 SRT Sandbox

运行环境决定模型发起的文件和进程在 Native 还是 WSL 中执行；可选 SRT 为 Native 进程增加本机权限边界。Docker Agent Runtime 已移除，WSL 本身不等于安全沙箱。

- Sandbox 不是 Permission 的替代品：即使 SRT 已启用，也可能不应执行删除操作。
- Permission 也不是 Sandbox：批准 Bash 不应该自动获得宿主全部文件和网络。
- Terminal、child worktree 和后台进程必须由宿主显式提供能力，Kernel 不创建隐藏后门。
- 运行位置使用 `agentEnvironment.kind = native | wsl`；`sandbox` 只保留 SRT 配置，不接受 backend、Docker 或旧 runtime 字段。

详细行为见 [Agent 运行环境调用链](./sandbox-runtime-flow.md)。

## Provider Secret

API key 和订阅凭据留在 Node 宿主的 Credential Storage 或环境中：

- 不进入 Session metadata、event payload、snapshot 或 SSE；
- 不传给 renderer/WebView；
- 错误消息和结构化日志必须遮盖 Authorization、cookie、token 和 key；
- Tool 输出若包含 secret，观察和导出层也应按敏感数据处理。

## Channel ACL

外部平台消息在进入 daemon 前由 `ChannelManager` 检查 `allowFrom`：

- 缺失或空名单时全部拒绝；
- 命中的是**发送者或会话**：`ou_...` 放行某个人，`oc_...` 放行某个群；
- connector、account、chat 和 thread 共同决定 Session 映射；
- 平台 message ID 用于幂等，不作为身份认证本身；
- adapter secret 只用于连接平台，不应该出现在 Agent prompt；飞书密钥存在独立凭据文件 `channel-credentials.json`（POSIX `0600`），不放进 `settings.json`；
- 主动推送工具仍只能使用设置中已有的命名目标。

通过 ACL 后，消息仍受普通 Permission、Sandbox 和 Run 规则约束。

## child Agent 与 Workflow

child 继承宿主工具上限和禁止列表，不能通过内置角色定义扩大权限。全树共享预算限制默认深度、活动 child 数和累计创建数；关闭后只释放活动名额，不退还累计额度。

Workflow retry 会创建新的 child 和 Attempt，仍消耗同一预算。Workflow snapshot 不保存 live Handle，重启后不能伪造旧 child 仍然在线。

## 日志与诊断

可以记录：traceId、Session/Run/Tool/Attempt ID、状态、耗时、错误分类、token 数和 owner generation。

默认不要记录：prompt 正文、Tool 完整 input/output、Authorization header、provider key、平台 secret、cookie 和未经处理的环境变量。

`/debug/runs/:runId` 默认只显示白名单 metadata；只有显式 `includeContent=true` 才允许返回内容，调用者仍必须通过 daemon 认证。

## Native Plugin 与 Converter

Runtime 只读取 installed store 指向、且通过 `validateNativePlugin()` 的 Native Plugin。所有 component path 都检查规范化路径和符号链接后的真实路径。第三方 Tool 在隔离执行环境完成前只返回 unsupported，daemon 不动态 import 插件模块。

Claude Code 等外部插件由独立 Converter 离线读取。detect、inspect、plan、convert 不执行脚本、不启动 Hook/MCP、不安装依赖、不联网；plan 后源内容变化时拒绝物化。权限必须明确批准，并由 daemon 根据最终 Native manifest 重新计算。

## 上线前检查

- daemon 是否使用随机 token，远程连接是否走受保护网络？
- 浏览器 Origin 是否限制到实际产品地址？
- 数据库、配置和 credential 文件（含飞书 `channel-credentials.json`）权限是否只给运行用户？
- `allowFrom` 是否明确配置，空名单是否保持 fail-closed？
- 危险 Tool 是否有 deny、Permission 和 Sandbox 三层约束？
- 日志和错误响应是否不含 secret 与正文？
- owner 心跳丢失后是否停止写入？
- backup 是否存放在独立受控目录，并包含 checksum？

## 相关文档

- [Permission Flow](./permission-flow.md)
- [Sandbox Runtime Flow](./sandbox-runtime-flow.md)
- [Auth、Provider、Model](./auth-provider-model.md)
- [Channels Flow](./channels-flow.md)
- [Operations and Recovery](./operations-and-recovery.md)
