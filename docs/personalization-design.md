# 设计：Personalization 环境事实抽取（C.5）

> 状态：当前实现。每个成功完成的 daemon root Run 都会从 durable transcript 抽取环境事实，持久化后由后续 runtime 的 prompt 读取。记忆体系全景见 [memory-system.md](./memory-system.md)。
> 新建 `packages/personalization`，移植 Python
> `personalization/{extractor,rules,session_hook}.py`（共 273 行）。
>
> CLI、TUI、Web、Desktop、Bot 等经 daemon 提交的 Run 共用同一条收尾接线；SDK 单独嵌入时由自己的宿主决定是否调用 personalization。

## 它做什么

每个 root Run 成功收尾后，用 10 个正则从当前 durable transcript 中有 ID 和创建时间的用户消息抽「环境事实」（SSH 主机、服务器 IP、数据
路径、conda 环境、Python 版本、API 端点、环境变量、git 远端、Ray 集群、cron
表达式），按项目去重合并持久化到 `~/.vykor/local_rules/projects/<项目>-<hash>/`：

```
local_rules/
└── projects/<项目>-<hash>/
    ├── facts.json   # facts 还含 sourceSessionId、sourceMessageId、observedAt
    └── rules.md     # 由 facts 重新生成的分组 Markdown（自动生成，勿手改）
```

同项目下次会话启动时，只从 `facts.json` 中有来源且未命中凭据值检查的条目生成 system prompt 内容（CLAUDE.md 段之后）。`rules.md` 供人查看；旧全局文件即使存在也不自动注入或迁移。`facts.json` 先写临时文件再替换；旧文件不可读时停止合并并在 `/context status` 报告，不以空集合覆盖旧数据。

## 模块（对齐 Python）

- `extractor.ts`：`FACT_PATTERNS`（10 个）、`extractFactsFromText`（去重、
  IP 假阳性过滤 0./255./127.0.0.1、值长度≥3、剥尾部标点）、
  `factsToRulesMarkdown`（按类型分组的固定标题表）。
- `rules.ts`：`loadLocalRules`/`saveLocalRules`/`loadFacts`/`saveFacts`
  （写入带 last_updated ISO 时间戳）/`mergeFacts`（按 key 去重，置信度高者胜）。
- `session-hook.ts`：`updateRulesFromSession(messages, cwd)`——抽取 → 按项目合并 →
  双写 facts.json + rules.md，返回新增数。调用方传入 sessionId；消息包含
  `{id, createdAt, role, content}`。只处理带有效来源的用户消息，`observedAt`
  使用消息创建时间，重复扫描旧消息不会刷新观察时间。

## 接线（R2）

- **prompt 注入**：`packages/prompts` 的 system prompt 构建在 CLAUDE.md 段后
  追加由有来源的 `facts.json` 条目生成的 Local Environment Rules（非空才注入）。
- **Run 收尾触发**：`SessionPostRunMaintenance` 只在 durable Run 已经是 `completed` 后读取 Store transcript，再调用 `updateRulesFromSession(messages)`。失败只记告警，不回退 Run 终态。
- **手动触发**：`/remember` 成功后也会扫描当前 transcript。
- **边界**：framework 的 `VykorAgent.close()` 只管理 live 执行资源，不写 personalization；这项持久化由拥有 transcript 的 daemon Application 负责。

## 与 Python 差异

| 点 | Python | TS | 原因 |
|----|--------|----|------|
| 触发点 | ui/runtime 关停一处 | durable root Run 成功收尾；`/remember` 也会触发 | 不依赖某个界面是否正常退出 |
| 日志 | logging.info | 无（静默） | TS 无 logger 基建 |
| 消息形状 | ConversationMessage.content blocks | `{id?, createdAt?, role?, content: string \| unknown[]}`；只自动抽有来源的 user 消息 | 适配 TS 消息，并保留 durable 来源 |
| git_remote 正则 | 懒惰 `\S+?` 后仅跟可选组 → 恒捕获 1 字符,被长度过滤丢弃(死代码) | 追加 `(?=\s\|$)` 锚,真正捕获 `owner/repo` | 修 Python 的失效模式 |
| prompt 注入包装 | 外层再包一层 `# Local Environment Rules` 标题(与 rules.md 自带标题重复) | 从有来源的 facts 生成一次 Local Environment Rules | 旧缓存不能绕过来源筛选 |
| 信号路径 | 单一关停钩子 | 只处理已经 durable completed 的 Run；进程中断的 Run 不假装完成抽取 | 与 durable 终态一致 |
| 配置目录 | 默认 ~/.vykor | 尊重 VYKOR_CONFIG_DIR(仓库既有约定) | 测试隔离/Electron 预留 |

## 测试

- extractor：10 类正则各至少 1 例、IP 假阳性过滤、去重、尾部标点剥除、
  markdown 分组输出。
- rules：load/save 往返、mergeFacts 置信度胜出与新 key 追加、目录懒建。
- session-hook：端到端（消息 → facts.json + rules.md 落盘 → 返回新增数）、
  空会话返回 0。
- prompts 注入：有来源的 facts 存在时进 prompt；只有旧缓存或无来源事实时不注入。

每轮 `pnpm check-types` + `pnpm test` 全绿。
