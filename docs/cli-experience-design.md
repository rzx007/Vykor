# 设计：CLI 体验 — oh provider / --dry-run / oh setup（E.1）

> 状态：历史设计记录。当前认证、Provider 和 Model 行为见 [Auth、Provider、Model](./auth-provider-model.md)；当前斜杠命令见 [Slash Command Flow](./slash-commands-flow.md)。

> Current status: implemented behavior now separates `auth`, `provider`, and
> `model`. API keys are stored by `auth login` / `provider add`; Codex
> subscription auth is read from the external Codex CLI auth source. See
> [auth-provider-model.md](auth-provider-model.md) for the current runtime
> contract.

## 2026-09-26：模型重试输出约定

以下是本次网络重试改造的输出约定；其余章节仍是历史设计。

- 普通 text 模式保留终端已经打印的内容，重试提示写 stderr，并明确标注上一段输出中断。终端历史字符不可撤回，不应将两次尝试的文字作为一个完整回答解析。
- `--output-format json` 输出一个最终对象，包含 `sessionId`、`runId`、`status`、`text` 和 `usage`。text 从有效持久消息生成，usage 标注 `incomplete`、未知/部分已知尝试数。与原先逐行事件 JSON 不同，需要事件流的调用者使用 stream-json。
- `--output-format stream-json` 保留逐行事件，为相关输出带上 `modelGeneration`；失效片段发出 `session.model.generation.superseded`，结束发出 `session.output.final`。消费者应处理替换事件或直接使用 final 的有效正文，不能把全部 delta 无条件拼接。
- CLI/TUI 与服务端须同为协议版本 5。TUI 显示重试倒计时和用量不完整提示，停止操作复用原中断机制。

## 范围（本批）

1. `oh provider`（list/use/add/edit/remove）—— 从 CLI 管 provider + key。
2. `oh --dry-run` —— 不跑模型，预览解析后的运行时配置 + readiness。
3. `oh setup` —— 交互式首次配置向导。

**oh provider 最小版**：只做 `settings.provider` + `credentials.json[name]` 的 API key；
**不做**命名 ProviderProfile 体系 / keyring（那是 C.2，单独做）。原始规划中 copilot/codex OAuth 属 E.4；当前实现已接入 Codex 订阅外部 auth source，Copilot 仍未接入。

## 现状（可复用）

- 子命令：auth/mcp/plugin/cron/config/version/doctor（无 provider/setup/dry-run）。
- `CredentialStorage`（auth）：`storeCredential(p,'api_key',v)`/`loadApiKey(p)`/`clearProviderCredentials(p)`/`listStoredProviders()`。
- `PROVIDERS`/`findByName`（api）：21 个内置 provider（name/envKey/defaultBaseURL/displayName/backendType）。
- `loadSettings`/`saveSettings`（core）。
- doctor 的 `checkApiKey(settings, storage)`（apps/cli/src/doctor.ts）→ {ok, source}，dry-run 复用。

## 组件

### a) `oh provider` 子命令（新建 apps/cli/src/commands/provider.ts）
- `provider list`：遍历 PROVIDERS（+ credentials 里有但不在 PROVIDERS 的），每行：name、是否 active（`settings.provider`）、key 来源（credentials.json / env `<ENVKEY>` / none）、registry 的 displayName/defaultBaseURL。
- `provider use <name> [--model <m>]`：校验 name（findByName，未知给提示但仍允许）；`settings.provider=name`，有 `--model` 则 `settings.model=m`；saveSettings。
- `provider add <name> --api-key <key> [--model <m>] [--base-url <url>] [--use]`：`storeCredential(name,'api_key',key)`；`--model`→settings.model、`--base-url`→settings.baseUrl（全局）、`--use`→同时 settings.provider=name；saveSettings（有变更才存）。
- `provider edit <name> [--api-key|--model|--base-url]`：同 add 的更新语义（至少给一个）。
- `provider remove <name>`：`clearProviderCredentials(name)`；若它是 active 则提示（不强制改 settings）。
- 抽可测纯函数：如 `formatProviderRow(spec, { active, keySource })`、`resolveKeySource(name, creds, env)`。

### b) `oh --dry-run`
- index.ts 加 `--dry-run` flag；MainOptions.dryRun。
- mainAction 早分支（在 backendOnly/tui/print 之前）：若 dryRun → 调 `runDryRun(settings, options)` 并 return。
- `runDryRun`（apps/cli/src/dry-run.ts，可测）：打印
  - model / provider / **key 来源**(checkApiKey) / baseURL / apiFormat / permission-mode
  - 工具数（createDefaultToolRegistry + 黑白名单过滤后的 count）
  - MCP servers（settings.mcpServers 的名字 + 推断 transport）
  - skills 数（loadSkillsThreeSources 后 count）
  - **readiness**：`ready`（key 有、model 有）/ `warning`（如无 skills/无 MCP，非阻塞）/ `blocked`（无 key）。
  - 不创建 API client、不调模型。

### c) `oh setup`（交互向导，新建 apps/cli/src/commands/setup.ts）
- readline：① 列已知 provider（编号）让选 → ② 输 API key → ③ 输 model（给该 provider 的默认/建议）→ ④ 确认 → 写 settings.json（provider/model/apiFormat=该 provider 的 backendType 对应）+ `storeCredential(name,'api_key',key)`。
- 复用 a) 的配置写入逻辑（抽 `applyProviderConfig({name, apiKey, model, baseUrl, setActive})`）。
- 已有配置时提示"将覆盖"，可取消。

## 测试

- `formatProviderRow`/`resolveKeySource`：active 标记、key 来源(credentials/env/none) 判定。
- `applyProviderConfig`：写 settings.provider/model + 存 credential（mock storage + settings）。
- `runDryRun` 的 readiness 判定纯函数：有 key+model→ready、无 key→blocked、缺 skills/MCP→warning。
- provider use/add/remove 的 settings/credentials 变更（mock）。
- setup 的选择→配置映射纯函数（交互层难测，把"选择结果→applyProviderConfig 入参"抽出来测）。

## 范围外

- 命名 ProviderProfile 体系 + keyring（C.2）。
- copilot/codex OAuth（E.4）。
- E.2 斜杠命令（后续规划）。
