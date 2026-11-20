# 服务商凭据

保存 Vykor 管理的 API Key，读取外部 Codex 登录文件，并为模型请求选择凭据。

## 主要文件

- [credential-storage.ts](credential-storage.ts)：credentials.json 读写和实例缓存。
- [credential-resolution.ts](credential-resolution.ts)：按指定服务商与设置选择 API Key。
- [external.ts](external.ts)：只读 Codex 登录文件并描述状态。

## 调用与状态

从 `@vykor/auth` 使用 `CredentialStorage`、`resolveApiKey`、`loadCodexCredential` 和 `describeCodexAuthState`。

`resolveApiKey` 先使用显式 `options.apiKey`；非命名自定义服务商可使用 settings.apiKey。指定 Codex 时读取外部文件；指定其他服务商时先查存储再查服务商环境变量，命名自定义服务商缺失时返回空串。之后才按模型/地址检测服务商并读取其存储或环境变量，最终回退到 ANTHROPIC_API_KEY、OPENAI_API_KEY。

`CredentialStorage` 默认通过 `@vykor/host-config/paths` 取得所选用户根下的 `credentials.json`，并拥有实例缓存；修改前重读文件，写入临时文件后替换。Codex 数据只从 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）读取，其登录和令牌更新归 Codex CLI。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。

`close()` 拒绝新操作，等待已接收的读写结束，再释放缓存；宿主停止使用原实例后应等待它关闭，再重建 store。显式 `new CredentialStorage(filePath)` 保留给嵌入调用和测试，路径固定在该实例上。共享的 [store-lifecycle.ts](store-lifecycle.ts) 也为 OAuth 与渠道 store 提供同样的等待边界，失败会返回给关闭调用方。
