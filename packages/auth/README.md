# @vykor/auth

管理模型服务商 API Key、读取外部 Codex 登录状态，并保存 MCP 授权和飞书渠道配置。三类本地文件由各自模块读写。

## 目录导航

- [src/](src/README.md)：公开导出及内存认证流程。
- [src/credentials/](src/credentials/README.md)：API Key 保存、选择规则及外部 Codex 登录源。
- [src/mcp/](src/mcp/README.md)：MCP OAuth 凭据、文件锁和退出计数。
- [src/channels/](src/channels/README.md)：飞书渠道完整配置及读写锁。

## 入口、文件与流程

包入口是 [src/index.ts](src/index.ts)。`CredentialStorage` 默认读写 `$VYKOR_CONFIG_DIR/credentials.json`，未设置时使用 `~/.vykor/credentials.json`；API Key 保存在服务商条目的 `api_key` 字段。`resolveApiKey` 按显式参数、设置、指定服务商、外部源和环境变量等规则选择凭据，完整顺序见 credentials 说明。

Codex 订阅使用外部认证源：`loadCodexCredential` 只读 `$CODEX_HOME/auth.json`，未设置时读 `~/.codex/auth.json`，不把令牌复制到 `credentials.json`。`describeCodexAuthState` 返回缺失、无效、过期或已配置状态。

`McpOAuthCredentialStore` 和 `ChannelConfigStore` 分别读写配置目录中的 `mcp-oauth.json`、`channel-credentials.json`，默认路径由 `@vykor/host-config` 提供。它们在文件锁内修改并使用临时文件替换原文件；MCP 协议和刷新决策在 `@vykor/mcp`，渠道消息收发在上层渠道模块。

```ts
import { CredentialStorage, describeCodexAuthState } from "@vykor/auth";

const storage = new CredentialStorage();
await storage.storeApiKey("deepseek", "sk-xxx");
const key = await storage.loadApiKey("deepseek");
const codex = await describeCodexAuthState();
```

CLI 的 `auth` 准备凭据来源，`provider` 选择服务商，`model` 选择模型。`vk auth login deepseek sk-xxx` 保存 API Key；`vk auth login codex` 使用外部登录源。参见 [认证、服务商与模型流程](../../docs/auth-provider-model.md)。

## 新增代码与检查

新增文件读写归对应分类，通用内存认证流程目前在 `src/index.ts`；单模块测试放同层 `__test__/`，覆盖公开认证流程的测试放 `src/__test__/`。

```bash
pnpm --filter @vykor/auth test
pnpm --filter @vykor/auth check-types
```
