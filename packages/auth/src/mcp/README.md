# MCP OAuth 凭据存储

保存 MCP 服务器的 OAuth 授权记录，协调多个进程修改同一文件。OAuth 是服务器授权用户访问资源的登录流程，这里只负责保存结果。

## 主要文件

- [mcp-oauth-credential-store.ts](mcp-oauth-credential-store.ts)：凭据文件、修改锁、版本号与退出计数。

## 调用与状态

从 `@vykor/auth` 使用 `McpOAuthCredentialStore`；`get` / `list` 查询，`set` / `update` / `runExclusive` 修改，`takeAndDelete` / `delete` 退出并推进退出计数。

修改时先取得文件旁的 `.lock`，重读记录，为新值分配 revision，然后写临时文件并替换。退出即使没有现存记录也推进 logoutEpoch，供上层拒绝退出前启动、退出后才完成的旧登录。

默认路径由 `@vykor/host-config` 的 `getMcpOAuthFilePath` 提供，即配置目录下 `mcp-oauth.json`。文件是明文 JSON；可读 v1 和 v2，实际修改写 v2，纯查询不迁移，同一对象不变也不写入。协议发现、浏览器登录与令牌刷新归 `@vykor/mcp`，本模块只持有文件和锁。

v2 增加退出计数，旧客户端不能读取；共享同一配置目录的 CLI、daemon 和 Desktop 应一起更新。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
