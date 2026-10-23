# MCP HTTP 授权

处理远端 HTTP MCP 服务器的授权协议、登录候选凭据验证、运行时令牌刷新及状态判断。

## 主要文件

- [login.ts](login.ts)：发现服务、授权码登录、生成候选凭据和撤销。
- [protocol.ts](protocol.ts)：元数据发现、令牌请求、撤销和带超时网络请求。
- [callback.ts](callback.ts)：loopback 或手动回调与状态校验。
- [runtime-auth.ts](runtime-auth.ts)：运行请求注入令牌、合并刷新及 401 恢复。
- [resource-binding.ts](resource-binding.ts)：校验 endpoint、资源标识及凭据绑定。
- [security.ts](security.ts)：授权地址、发行者和权限范围校验。
- [status.ts](status.ts)：认证模式和凭据状态判断。
- [snapshot.ts](snapshot.ts)：服务器身份和可展示的授权快照。
- [verify-connection.ts](verify-connection.ts)：使用候选凭据验证实际 MCP 连接。
- [errors.ts](errors.ts)：授权错误代码。

## 调用与状态

包根导出 `loginMcpOAuth`、`revokeMcpOAuthCredential`、`McpOAuthRuntime`、`verifyMcpOAuthConnection`、回调与状态/快照函数。宿主向它们注入凭据存储和浏览器或手动回调能力。

登录先发现元数据并校验资源与权限，再生成 PKCE 校验值、接收授权码、交换令牌并可选验证连接；返回候选凭据，由宿主决定提交。运行请求读取当前凭据，临近过期时在存储锁内刷新；401 最多刷新恢复一次，确认失效才标记重新授权。

回调控制器保存本次登录等待状态；`McpOAuthRuntime` 保存进行中刷新 Promise。持久凭据、revision 与退出计数由注入的存储（通常是 `@vykor/auth`）管理，活动 Session 重连由 server 管理。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
