# Personalization 环境事实（当前实现）

> 状态：当前实现。

> 本文说明 `packages/personalization/src/index.ts` 的当前行为。记忆体系全景见 [memory-system.md](./memory-system.md)。经 daemon 提交的 Run 共用收尾接线；SDK 单独嵌入时由宿主决定是否调用 personalization。

## 它做什么

每个 daemon root Run 成功收尾后，用 10 个正则从当前 durable transcript 中有 ID 和创建时间的用户消息抽取环境事实：SSH 主机、服务器 IP、数据路径、conda 环境、Python 版本、API 端点、环境变量、git 远端、Ray 集群和 cron 表达式。按 `type:value` 去重后，按项目持久化到 `~/.vykor/local_rules/projects/<项目>-<hash>/`（`VYKOR_CONFIG_DIR` 可改配置根目录）：

```
local_rules/
└── projects/<项目>-<hash>/
    ├── facts.json   # 权威事实、来源与取代状态
    └── rules.md     # 由 facts 重新生成的分组 Markdown（自动生成，勿手改）
```

自动抽取的事实记录 `sourceSessionId`、`sourceMessageId` 和消息时间 `observedAt`。助手回复与工具输出不会被自动抽成事实。`facts.json` 是提示词的权威来源；`rules.md` 仅是供人查看、可重建的缓存。提示词只使用未被取代且未命中明显凭据检查的有效事实，并显示记录日期及使用前核验提示；记录日期不是工具核验时间，也不触发自动过期。

`facts.json` 先写临时文件再原子替换。缺来源或损坏的文件不可读，下一次自动抽取不会把它当空集合覆盖；`/context status` 会显示不可读。

## 入口和状态变化

这些入口目前都在 `packages/personalization/src/index.ts`，不是三个独立的 TS 文件：

- `extractFactsFromText(text)` 用 10 个正则提取候选；`updateRulesFromSession(messages, cwd, sessionId)` 只处理带 ID、创建时间的用户消息，附上来源后合并并写入 `facts.json`、`rules.md`，返回新增事实数。重复扫描同一批消息不会把观察时间改成 Run 收尾时间。
- `loadFacts(cwd)` 校验文件格式和来源；`saveFacts()` 原子写权威文件；`mergeFacts()` 按键和置信度合并，但不会让历史消息覆盖已取代的旧键、手动新键或已关联的新键。
- `loadLocalRules(cwd)` 从有效事实生成 prompt 内容，不读取 `rules.md`；`factsToRulesMarkdown()` 按类型分组并过滤已取代条目。
- `replaceFact(cwd, oldKey, newValue, options)` 只处理用户精确指定的旧键。旧条目保留 `superseded` 状态、目标键、操作 ID 和时间；若目标键不存在，就创建带 `manualSource` 的新条目；若目标键已有有效条目，只建立取代关系，保留目标原来源。失效目标、格式错误或明显凭据值被拒绝。再次扫描历史不会让旧键复活。

手动操作不伪造消息 ID。`manualSource` 记录操作 ID、操作时间、旧键和可选会话 ID；通过 `/facts` 接口提交时，daemon 会核对该会话属于当前项目。它表示用户明确修改，不表示工具已经核验环境。

## 接线（R2）

- **prompt 注入**：`packages/prompts` 在 Project Instructions 段后追加由本项目有效事实生成的 Local Environment Rules（非空才注入）。
- **Run 收尾触发**：`SessionPostRunMaintenance` 只在 durable Run 已是 `completed` 后读取 Store transcript，再调用 `updateRulesFromSession(messages, cwd, sessionId)`。失败只记告警，不回退 Run 终态。
- **手动触发**：`/remember` 成功后也会扫描当前 transcript。
- **查看与替换**：`/facts list` 查看当前项目的键、状态和来源；`/facts replace <旧键> => <新值>` 通过 daemon 写入锁修改。若旧地址还在其他有效键中，返回那些键供用户判断，不连带改写。`/context status` 只计实际可注入的事实。
- **边界**：framework 的 `VykorAgent.close()` 只管理 live 执行资源，不写 personalization；这项持久化由拥有 transcript 的 daemon Application 负责。

## 与 Python 差异

| 点 | Python | TS | 原因 |
|----|--------|----|------|
| 触发点 | ui/runtime 关停一处 | durable root Run 成功收尾；`/remember` 也会触发 | 不依赖某个界面是否正常退出 |
| 失败处理 | logging.info | Run 收尾抽取失败只记结构化告警；显式 `/facts replace` 返回错误 | 自动维护不回退 Run，显式操作要让用户知道结果 |
| 消息形状 | ConversationMessage.content blocks | `{id?, createdAt?, role?, content: string \| unknown[]}`；只自动抽有来源的 user 消息 | 适配 TS 消息，并保留 durable 来源 |
| git_remote 正则 | 懒惰 `\S+?` 后仅跟可选组 → 恒捕获 1 字符,被长度过滤丢弃(死代码) | 追加 `(?=\s\|$)` 锚,真正捕获 `owner/repo` | 修 Python 的失效模式 |
| prompt 注入包装 | 外层再包一层 `# Local Environment Rules` 标题（与 rules.md 自带标题重复） | 从有效 facts 生成一次 Local Environment Rules | 旧缓存不能绕过来源与取代状态筛选 |
| 信号路径 | 单一关停钩子 | 只处理已经 durable completed 的 Run；进程中断的 Run 不假装完成抽取 | 与 durable 终态一致 |
| 配置目录 | 默认 ~/.vykor | 尊重 VYKOR_CONFIG_DIR(仓库既有约定) | 测试隔离/Electron 预留 |

## 测试

- `packages/personalization/src/index.test.ts`：10 类抽取、来源校验、损坏文件保护、项目隔离、旧键取代和重扫防复活、已有目标关联及来源保留、凭据风险与缓存写入失败。
- `packages/prompts/src/index.test.ts`：即使 `rules.md` 缓存仍含旧值，提示词也只读有效事实。
- `packages/server/src/http/routes/facts.test.ts` 与 `packages/server/src/http/__test__/http.test.ts`：显式操作的输入、锁、来源 cwd、状态码和真实 daemon 路由。
- `packages/client/src/commands/__test__/session-commands.test.ts`：`/facts` 列表和替换命令的呈现与参数解析。
