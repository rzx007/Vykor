# Auth、Provider、Model

> 状态：当前认证、Provider 路由和模型选择说明。

本文说明 OpenHarness 如何区分认证、provider 路由、模型选择与本地配置存储。

## 心智模型

`auth` 回答：OpenHarness 如何拿到凭证？

`provider` 回答：请求应路由到哪家模型厂商？

`model` 回答：该 provider 下应使用哪个模型名？

简言之：先准备凭证，再切换 provider，最后选择模型。

## API Key 流程

CLI：

```bash
ohs auth login deepseek sk-xxx
ohs provider use deepseek
ohs config set model deepseek-chat
```

REPL/TUI：

```text
/auth login deepseek sk-xxx
/provider deepseek
/models
```

`ohs provider add deepseek -k sk-xxx --use --model deepseek-chat` 是快捷方式：一条命令写入 API key，并可选择同时激活 provider + model。

`ohs provider use <name>` 默认只切换 provider；要同时切换模型，请加
`-m/--model`，例如 `ohs provider use deepseek -m deepseek-chat`。

## Codex 订阅流程

OpenHarness 不负责 Codex 订阅登录本身，而是读取本地 Codex CLI 的登录状态。

CLI：

```bash
ohs auth login codex
ohs provider use codex
ohs config set model gpt-5.4
```

REPL/TUI：

```text
/auth login codex
/provider codex
/models
```

`auth login codex` 会检查 Codex CLI 的认证源是否就绪；真正的登录仍由 Codex CLI 管理。`auth codex-login` 仍可作为别名使用。

## 存储

默认情况下，OpenHarness 将自身配置存放在：

```text
~/.openharness-ts
```

可通过以下环境变量重定向：

```text
OPENHARNESS_CONFIG_DIR
```

主要文件如下：

| 文件 | 用途 |
|---|---|
| `settings.json` | 非机密运行时设置，如 `provider`、`model`、`baseUrl`、`apiFormat`、`customProviders`（含请求头模板原文）、权限、插件与 UI 偏好 |
| `credentials.json` | OpenHarness 管理的凭证，按 provider 分组（API Key 等机密） |
| daemon SQLite | TUI/Web/Desktop/Bot 共用的 Session、Run、消息和权限记录 |
| `plugins`、`skills`、`data/*` | 用户安装的插件、技能、日志、任务、cron 状态及其他本地数据 |

`settings.json` 示例：

```json
{
  "_formatVersion": 1,
  "provider": "deepseek",
  "model": "deepseek-chat",
  "apiFormat": "openai",
  "permission": { "mode": "default" }
}
```

`credentials.json` 示例：

```json
{
  "deepseek": {
    "api_key": "sk-xxx"
  }
}
```

### 自定义 / 目录供应商的请求头模板

真正自定义供应商与 models.dev 目录供应商可以把额外 HTTP 请求头写在
`settings.json` 的 `customProviders[].headers` 里。这里保存的是**模板原文**，不是
展开后的值；API Key 仍只放在 `credentials.json`。

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

支持的模板变量（区分大小写，只能出现在请求头**值**中）：

| 变量 | 含义 |
|---|---|
| `{{sessionId}}` | 当前会话 ID。同一会话内稳定；不同会话不同。凭证校验时使用固定占位会话 ID。 |
| `{{userAgent}}` | 客户端标识，当前为 `openharness-ts/1.0`。 |

适用范围：

- **真正自定义供应商**与**目录供应商**（`source: "models.dev"`）：支持在设置 UI / API 中配置并持久化这些头。
- **内置供应商**（registry 中的 DeepSeek、Anthropic 等）：暂不支持请求头模板；UI 不展示高级头，运行时也不读取。

安全注意：请求头是明文配置。不要把 API Key、token 或其他秘密写进
`headers`；机密只应放在 `credentials.json`。

造客户端时，runtime 会用当前会话上下文展开模板，再把结果交给对应 SDK 的
默认请求头。展开后的值不会写回 `settings.json`。

## Codex 凭证来源

Codex 订阅凭证是外部的。OpenHarness 读取：

```text
~/.codex/auth.json
```

若设置了 `CODEX_HOME`，则读取：

```text
%CODEX_HOME%/auth.json
```

OpenHarness 不会把 Codex token 复制进 `credentials.json`；`auth logout codex` 也不会删除 Codex CLI 的 `auth.json`。

## 运行时解析

设置按以下顺序加载，后者覆盖前者：

```text
defaults
settings.json
environment variables
CLI overrides
```

凭证按以下顺序解析：

```text
explicit CLI/settings apiKey
Codex external auth source, when provider is codex
credentials.json entry for the active/detected provider
provider-specific environment variable
ANTHROPIC_API_KEY or OPENAI_API_KEY fallback
empty string
```

这样可以把密钥排除在 `settings.json` 之外，同时仍允许通过 CLI 做临时覆盖。
