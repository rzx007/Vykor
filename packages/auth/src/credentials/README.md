# 服务商凭据

保存 Vykor 管理的 API Key，读取外部 Codex 登录文件，并为模型请求选择凭据。

## 主要文件

- [credential-storage.ts](credential-storage.ts)：credentials.json 读写和实例缓存。
- [credential-resolution.ts](credential-resolution.ts)：按指定服务商与设置选择 API Key。
- [external.ts](external.ts)：只读 Codex 登录文件并描述状态。

## 调用与状态

从 `@vykor/auth` 使用 `CredentialStorage`、`resolveApiKey`、`loadCodexCredential` 和 `describeCodexAuthState`。

`resolveApiKey` 先使用显式 `options.apiKey`；非命名自定义服务商可使用 settings.apiKey。指定 Codex 时读取外部文件；指定其他服务商时先查存储再查服务商环境变量，命名自定义服务商缺失时返回空串。之后才按模型/地址检测服务商并读取其存储或环境变量，最终回退到 ANTHROPIC_API_KEY、OPENAI_API_KEY。

`CredentialStorage` 默认拥有 `$VYKOR_CONFIG_DIR/credentials.json`（默认 `~/.vykor/credentials.json`）和实例缓存；修改前重读文件，写入临时文件后替换。Codex 数据只从 `$CODEX_HOME/auth.json`（默认 `~/.codex/auth.json`）读取，其登录和令牌更新归 Codex CLI。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
