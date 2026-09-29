# Vykor 插件机制现状调研报告

> 状态：当前实现调研报告，以仓库代码为准。
> 调研范围：Git HEAD `c80ae066`（2026-09-28 提交），调研日期 2026-09-29。
> 审阅状态：经三轮独立只读审阅（第三轮只审增量）。第一轮发现的错误已修正；第二、三轮均判定可以当作权威文档，其应改项与措辞建议也已处理（见第 15.1–15.2 节）。
> 适用边界：所有结论在 Windows + Node 环境得到，macOS/Linux 与 WSL 运行期行为未验证；未验证项集中列在第 15.3 节。
> 阅读对象：需要修改插件代码、评估插件能力边界，或排查插件装载问题的开发者与维护者。

本报告只写代码当前实际做到的事，并从实现里读出取舍、缺口和容易误判的地方。设计意图与后续路线请配合 [Native Plugin 当前实现](./plugins-contributions-design.md)、[插件能力召唤与运行设计](./plugin-capability-invocation-design.md)、[原生插件开发指南](./native-plugin-authoring.md) 与 [Native Plugin 后续工作交接](./native-plugin-next-stage-handoff.md) 阅读；若与本报告冲突，以代码为准。

已知会与本报告冲突的文档只有一处：`docs/superpowers/specs/2026-09-02-user-scoped-native-plugin-installation-design.md` 说旧 scope 记录会被读取并忽略，当前代码是直接让 store 读取失败（见第 13 节）。

## 1. 结论速览

| 问题 | 当前答案 |
| --- | --- |
| 插件清单格式 | 只认一种：插件根目录下的 `.vykor-plugin/plugin.json`，schemaVersion 1，字段严格（多余字段直接判错） |
| 谁负责加载 | daemon 里的 Agent Runtime。单位是“会话暖 Runtime”，不是进程启动时一次性加载 |
| 插件代码何时执行 | 分两条路：Tool 入口模块只在独立的 Tool Host 子进程里 `import()`；插件的 `command`/`http` Hook 由 Hook Executor 直接在宿主进程里执行命令或发请求。校验和加载阶段既不 import 也不执行第三方代码 |
| 安装范围 | 只有用户级，落在 `~/.vykor/plugins/`。`user` 与 `managed` 之外的旧 scope 记录会让整个 `installed.json` 读取失败，不是被静默忽略 |
| 安装完立刻能用吗 | 不能。安装、启停、卸载都会关闭 Runtime，下一次对话才重新加载 |
| 权限是沙箱吗 | 不是。是宿主闸门（决定插件能不能走到调用点），不是操作系统级隔离 |
| 一次 Run 能用几个插件 | 最多一个 `pluginId`，由用户在输入里用 `@`/`+` 显式选择；跨插件组合被明确拒绝 |
| 组件支持度 | Skills、Agents、Hooks、MCP、Node Tools 已闭环；另外 9 类组件只保留 schema，装载时返回 warning |
| 更新与回滚 | 重新导入同一插件 ID 就是更新/修复；没有版本历史、回滚或自动更新 |

### 1.1 常见误解速查

以下每一条都是读代码时容易得出的错误结论，列在这里是为了避免后面逐个踩。

| 容易以为 | 实际 |
| --- | --- |
| 插件跑在沙箱里 | 只有 Tool 走独立子进程，且只是进程与环境变量隔离；`command`/`http` Hook 直接跑在宿主进程（第 8.6 节） |
| 没申请权限，插件就动不了文件和网络 | 错。manifest 权限是宿主闸门，不拦截 Node 代码；Hook 连闸门都没有（Hook 见第 8.6 节，权限模型本身见第 9 节） |
| 装了就能用 | 要先等 Runtime 重建（新会话或 `/reload-plugins`），再在输入里 `@` 选择该插件（第 10 节） |
| `@插件` 就等于执行插件 | 只表示“这一轮可以调用它的能力”，不执行、不加载全部 Skill 正文，也不把插件固定到 Runtime/会话生命周期（选择本身会随输入持久化，视图是每 Run 一份） |
| 改了插件目录马上生效 | link 安装也要显式重载；正式安装读的是不可变快照，改源目录完全无效（第 6.2 节） |
| 重新导入同一 ID 就等于回滚 | 没有版本历史，也没有选版本的入口；旧快照还在但用不上 |
| 工具名会自动带插件前缀 | 不会。工具名是全局注册名，撞上宿主保留名或别的插件就直接激活失败（第 8.4 节） |
| 某个组件没实现只是警告，插件照样是好的 | 插件会变 `degraded`；不过 9 类未实现组件确实不影响同插件内其他组件 |
| 插件 MCP 和宿主同名，重命名一下就好 | 是整插件出局，不是丢一个 server（第 7.1 节） |
| 安装记录里的旧 scope 会被忽略 | 会让整份 `installed.json` 读取失败，插件列表整体报错（第 5 节） |

## 2. 端到端流程

```text
作者打包                        用户安装                              运行（daemon）
────────────────────────        ──────────────────────────────        ──────────────────────────────
插件目录                        校验 manifest 与所有组件真实路径
  .vykor-plugin/plugin.json  → 复制成不可变快照 cache/<id>/<version>-<digest>
  skills/ agents/ hooks/    → 写 installed.json（记录版本、摘要、权限批准）
  mcp/ tools/index.mjs      → 关闭全部 Runtime，等下一次对话
                                              │
                                              ↓ 新会话/下一次使用
                                        会话暖 Runtime：
                                          discover → verify → load（全部只读文件，不执行代码）
                                          → 静态阶段到此结束，下面两件事才会真正执行插件内容
                                              ├─ 启动 Tool Host 子进程，import 工具入口模块（隔离进程）
                                              └─ 把 Hook 注册进 HookExecutor（宿主进程内执行，无隔离）
                                              │
                                              ↓ 用户在输入里选 @插件
                                        生成当轮冻结的 RunCapabilityView
                                          → 模型只看到该插件的 Tool schema、Skill 名称、Agent 名称、MCP 工具
                                          → Hook 不在此列：它已经在 Runtime 里生效，不受选择影响
```

一句话概括：**插件是“能力容器”**。安装只决定“能不能被发现”，`@插件` 才决定“这一轮能不能用”，两者都不等于放开每个高风险操作。

## 3. 代码地图

| 目录 / 文件 | 职责 |
| --- | --- |
| `packages/plugins/src/manifest/schema-v1.ts` | Native v1 manifest 的 zod 严格校验 |
| `packages/plugins/src/manifest/validate.ts` | 读 `.vykor-plugin/plugin.json`，解析 + 校验组件路径，产出诊断 |
| `packages/plugins/src/paths.ts` | 组件路径边界检查（lexical 与 symlink 真实路径双重校验） |
| `packages/plugins/src/load-native-plugin.ts` | 静态加载五类组件，其余组件给 unsupported warning |
| `packages/plugins/src/components/` | 五类组件各自的解析：`tools.ts`、`skills.ts`、`agents.ts`、`hooks.ts`、`mcp.ts` |
| `packages/plugins/src/installation/` | `installer.ts` 安装、`cache.ts` 不可变快照与摘要、`store.ts` 安装记录、`verify.ts` 运行前校验 |
| `packages/plugins/src/sdk.ts` | 插件作者的开发期类型入口，经 `@vykor/plugins/sdk` 暴露 |
| `packages/plugin-sources/src/local-zip.ts` | 把 `.zip`/`.tar`/`.tar.gz`/`.tgz` 安全解压成候选目录 |
| `packages/plugin-sources/src/git-source.ts` | 用系统 `git` 固定到具体 commit，删掉 `.git` 后交付候选目录 |
| `packages/plugin-converters/src/` | Claude Code / Codex 外部格式 → Native Plugin 的转换 |
| `packages/agent-runtime/src/plugin-discovery.ts` | 发现、校验并静态加载已安装插件 |
| `packages/agent-runtime/src/plugin-capability-inventory.ts` | 安装优先级、组件归属与同名冲突判定 |
| `packages/agent-runtime/src/plugin-activation.ts` | 注册 Hooks、激活 Native Tool |
| `packages/agent-runtime/src/native-tools/` | Tool Host 子进程、IPC 协议、调用闸门、运行状态 |
| `packages/agent-runtime/src/run-capability-view.ts` | 生成单轮 Run 的冻结能力视图 |
| `packages/server/src/application/default-services/plugin-service.ts` | 安装 / 启停 / 卸载 / 预览 / 列出的统一应用层 |
| `packages/server/src/application/session/session-plugin-capability-service.ts` | 决定一次输入能不能带 `pluginId`，以及带哪一个 |
| `packages/server/src/http/routes/service.ts` | `/plugins/**` HTTP 路由 |
| `packages/client/src/resources/plugin-resource.ts` | 各前端共用的插件 HTTP 客户端 |
| `apps/cli/src/commands/plugin.ts` | `vk plugin` 子命令 |
| `apps/desktop/src/main/features/plugin/plugin-service.ts` | Desktop 主进程的导入、确认与刷新 |
| `apps/desktop/src/renderer/src/components/desktop/plugin-page` | 插件管理页面 |
| `examples/plugins/text-inspector` | 官方参考插件，包含 Skill、Plugin Agent 和 Node Tool |

## 4. manifest 契约

唯一的运行时 manifest 是 `.vykor-plugin/plugin.json`。根级旧 `plugin.json`、snake_case 字段、Claude/Codex 的原生清单都不会被猜测或兼容。

字段（`packages/plugins/src/manifest/schema-v1.ts` 是权威定义）：

| 字段 | 约束 |
| --- | --- |
| `schemaVersion` | 必须字面量 `1` |
| `id` | 稳定点分标识符，至少两段，如 `example.text-inspector` |
| `name` | kebab-case，用于 Skill 命令前缀等展示与命名 |
| `version` | 非空字符串，与 `id` 一起构成安装身份 |
| `displayName`、`description`、`author`、`homepage`、`repository`、`license`、`keywords`、`metadata` | 可选元数据；`metadata.origin` / `metadata.sourceFormat` 会被安装器读取用于标记来源 |
| `components` | 必须至少声明一项；支持 14 个键，路径一律以 `./` 开头 |
| `permissions` | 可选，四类：`filesystem`、`network`、`process`、`secrets` |
| `runtime` | 可选 `{ engine: "node" \| "wasm", isolation: "worker" \| "process" }`；当前实现只按 node/process 有意义 |

`components` 支持 14 个键，其中只有 5 个有实现：

```ts
// 已实现
skills, agents, hooks, mcpServers, tools
// 已声明但只返回 unsupported 诊断
lspServers, workflows, channels, providers, ui, outputStyles, themes, monitors, binaries
```

`tools` 的每一项可以写成字符串，也可以写成显式对象：

```json
{
  "schemaVersion": 1,
  "id": "example.text-inspector",
  "name": "text-inspector",
  "version": "1.0.0",
  "components": {
    "agents": ["./agents/reviewer.md"],
    "skills": ["./skills/check-text/SKILL.md"],
    "tools": [{ "entry": "./tools/index.mjs", "runtime": "node", "permissions": [] }]
  },
  "permissions": {},
  "runtime": { "engine": "node", "isolation": "process" }
}
```

路径安全由 `packages/plugins/src/paths.ts` 兜底：必须相对且以 `./` 开头，先做字符串边界检查，再看符号链接解析后的真实路径是否仍在插件根内；目标尚不存在时，从最近存在的父目录继续做同样的检查。校验阶段还会拒绝重复组件来源（同一真实文件被两个组件引用）。

## 5. 磁盘布局与安装记录

```text
~/.vykor/plugins/
├─ cache/<plugin-id>/<version>-<digest>/   # 不可变内容快照，实际被运行的内容
├─ data/<plugin-id>/                       # 仅路径已定义，当前没有生产代码写入
├─ sources/                                # 仅路径已定义，当前没有生产代码写入
└─ installed.json                          # 安装记录（schemaVersion 1 + revision + plugins）
```

`installed.json` 中每条记录的关键字段（`packages/plugins/src/installation/store.ts`）：

| 字段 | 含义 |
| --- | --- |
| `id` / `scope` / `enabled` | 身份、安装范围（当前只有 `user` 会被写入）、启停状态 |
| `currentVersion` / `cachePath` | 期望版本，以及运行时应读取的目录 |
| `behaviorDigest` | 内容摘要。非 link 安装才有，运行前用它比对内容有没有被换过 |
| `linkedSourcePath` | link 安装才有，指向开发目录，不固定内容摘要 |
| `origin` / `sourceFormat` | `native` 或 `converted`，以及来源格式（如 `codex`） |
| `requestedPermissions` / `approvedPermissions` | 本次请求的权限，与用户实际批准过的权限 |
| `installedAt` / `updatedAt` | 首次安装时间与最近更新时间；重装会保留 `installedAt` |

写入方式是把整个 store 改完再原子替换（临时文件 + rename），revision 单调递增，避免半写状态。

读取时只接受 `user` 与 `managed` 两种 scope：任何一条记录是别的值，读取就抛 `Invalid installed plugin store`，整个插件列表随之报错。所以旧 `project`/`local` 记录不是“被忽略并给个提示”那种宽松处理。

**不可变快照**（`packages/plugins/src/installation/cache.ts`）的行为值得单独说明：

- 摘要是按“相对路径 + 文件内容”排序计算的 SHA-256，缓存源里出现符号链接直接报错。
- 快照目录名里的 version 会被清洗（只留字母、数字、`.`、`_`、`-`），因此 `1.0.0+beta` 这类版本在路径上会变成 `1.0.0_beta`，不影响记录里的版本号。
- 目标目录已存在且摘要一致，直接复用。
- 目标目录存在但摘要不一致，先把旧目录改名隔离（quarantine），再从可信源重建，成功后删除隔离目录。
- 复制到临时目录后会重新算一次摘要，防止复制期间源被改动；随后校验副本，最后才 rename 成最终快照。
- 最终快照必须是真实目录：不能是符号链接，也不能是 Windows 目录联接。

上面最后一条由两道独立的检查实现，实测（Windows + Node 24，用 `mklink /J` 造目录联接）结果如下：

| 场景 | `assertRegularPluginCacheSnapshot` | `computePluginBehaviorDigest` |
| --- | --- | --- |
| 真实目录（对照） | 接受 | 正常算出摘要 |
| 快照**根**是目录联接 | **拒绝**：`Plugin cache snapshot is not a regular directory` | 仍能算出摘要（顺链接走过去了） |
| 真实目录里含**嵌套**联接 | 接受（只看根，不遍历） | **拒绝**：`Cache source contains a symbolic link` |

两道检查是哪一道触发，实测说得很清楚：

- 根联接是**第一道**触发的。Windows 上 `lstat()` 对 `mklink /J` 的联接返回 `isDirectory() === false`、`isSymbolicLink() === true`，所以 `assertRegularPluginCacheSnapshot` 开头的 `!isDirectory() || isSymbolicLink()` 直接成立并抛出。第二道 realpath 比对在这个场景里实测也成立（`realpath` 结果确实不等于“父目录 + 同名子项”），但第一道已经先抛出，代码走不到它。
- 第二道是独立兜底：它不依赖 libuv 把 reparse point 报成 symlink 的行为，用于 `lstat` 没能识别、但解析后确实跳到别处的目录项。两道都留着才完整。
- 嵌套联接则由摘要遍历里的符号链接检查拦住——`readdir` 的 `Dirent` 对联接同样报 `isSymbolicLink() === true`，而那道检查不看根目录本身。

嵌套链接会让摘要算不出来，这正是重装时把快照判定为损坏并隔离重建的触发条件之一。

## 6. 生命周期：六个阶段各自做什么

### 6.1 校验

入口 `validateNativePlugin(root)`。

顺序是：读 manifest → JSON 解析 → schema 校验 → 逐个组件解析真实路径 → 检查存在性与重复。任何 error 级诊断都会让结果变成 `invalid`，同时返回结构化的 `PluginDiagnostic[]`（带 `severity`、`phase`、`code`、`message`、`path`、`component`）。

常见诊断码：`native_manifest_missing`、`native_manifest_invalid_json`、`native_manifest_schema_invalid`、`component_path_outside_root`、`component_path_invalid`、`component_path_missing`、`component_source_duplicate`。

### 6.2 安装

入口 `installLocalNativePlugin(input)`。当前只接受 `scope: "user"`，传其他值返回 `plugin_scope_not_supported`。

1. 校验源目录；
2. 从 manifest 算出请求权限集合（`requestedPluginPermissions`）；
3. 要求“批准集合”与“请求集合”完全一致，不一致返回 `plugin_permissions_not_approved`（多批准和少批准都算不匹配）；
4. 计算内容摘要，复制成不可变快照；
5. 写 `installed.json`。重装同一 ID 时保留原来的 `installedAt` 与 `enabled`，只更新版本、路径、摘要、权限和 `updatedAt`。

link 安装（`vk plugin link`）跳过复制和摘要，直接引用开发目录，因此开发目录改动在下一次重载后可见。

### 6.3 发现

入口 `discoverVykorExtensions(cwd, settings, { pluginsEnabled })`，由 `packages/agent-runtime/src/plugin-discovery.ts` 实现。

- 总开关：`settings.plugins.enabled` 与 `--no-plugins` 都为真才去读安装记录；两者是“与”关系。
- 只取 `enabled === true` 的记录；同一 ID 有多条记录时按 `managed > user` 选唯一 winner，无法唯一确定就丢弃并记 error 诊断。
- 每条记录都先过 `verifyInstalledNativePlugin`，不通过就跳过（fail closed）。
- 通过后再 `loadNativePlugin` 静态加载组件。
- 最后用 `createPluginCapabilityInventory` 算出“谁能用哪些组件”，并处理同名冲突。

发现结果只是数据。把它接成“活的 Runtime”的入口是 `packages/agent-runtime/src/runtime-integrations.ts`：它调用上面的发现与激活，并挂上 `runtime.createRunCapabilityView`，也就是第 10 节那个按 Run 过滤的能力视图。选中插件的 Native Tool 没起来、MCP 没连上时，“插件不可用”的 readiness 错误就是在这一层产生的，对应回归测试是 `packages/agent-runtime/src/runtime-plugin-readiness.test.ts`。改插件装载链路时，这个文件是必须一起看的入口。

### 6.4 运行前校验

入口 `verifyInstalledNativePlugin(record)`，是所有入口共用的同一份校验（Runtime 发现、管理列表、CLI dry-run 都用它）。它按顺序做 6 项检查，每失败一项就返回对应的诊断码：

| # | 检查 | 失败时的诊断码 |
| --- | --- | --- |
| 1 | 非 link 安装必须有内容摘要记录 | `plugin_content_digest_missing` |
| 2 | 非 link 安装的缓存根必须是真实目录（不是符号链接/目录联接） | `plugin_cache_snapshot_invalid` |
| 3 | manifest 的 `id` 与 `version` 同时等于记录里的 `id` 与 `currentVersion`（一个条件同时比对两者） | `plugin_installation_identity_mismatch` |
| 4 | 从实际 manifest 重算的权限集合，与记录的 `requestedPermissions` 完全一致 | `plugin_installation_permissions_mismatch` |
| 5 | 每个实际请求的权限都在 `approvedPermissions` 里 | `plugin_permissions_not_approved` |
| 6 | 非 link 安装：当前内容摘要等于记录的 `behaviorDigest` | `plugin_content_digest_mismatch`；摘要算不出来时是 `plugin_content_digest_verification_failed` |

任一项不符就拒绝加载，并提示重新批准或重装。link 安装只跳过第 1、2、6 项这组内容一致性检查，身份与权限（第 3、4、5 项）每次仍然重查。

按诊断码匹配时注意第 3 项：id 与 version 是同一个条件、同一个错误码，没有单独的 version 不匹配码。

### 6.5 静态加载

入口 `loadNativePlugin(plugin)`，返回 `status: "loaded" | "degraded"` 以及各组件的 `PluginComponentResult`（状态为 `loaded`、`unsupported`、`invalid` 或 `blocked`）。

关键点是**这一阶段不 import 任何第三方代码**。Tool 组件在这里只解析出元数据：

```ts
{ declaredEntry, entryPath, runtime, requestedPermissions, effectivePermissions }
```

Tool 声明的权限必须在 manifest 里声明过，否则整条 Tool 声明被判 error（`native_tool_permission_not_declared`）。声明 `runtime: "wasm"` 的 Tool 目前只给 warning（`native_tool_runtime_unsupported`），不会激活。9 类未实现组件各自产生一条 `native_<kind>_not_supported` warning，并让插件进入 `degraded`。

### 6.6 激活

入口 `activateDiscoveredPlugins(...)`（`packages/agent-runtime/src/plugin-activation.ts`）：

1. 把插件 Hooks 注册进 HookExecutor，失败时回滚已注册的 Hook；
2. 调 `activateNativePluginTools` 为插件启动 Tool Host，注册 Tool；
3. 把清理函数登记给 Runtime，Runtime 关闭或 Host 崩溃时注销该插件的全部 Tool。

Hook 的 id 形如 `plugin:<pluginId>:<event>:<index>`，在插件范围内稳定。

## 7. 各组件现在的实际能力

| 组件 | 静态加载 | 运行方式 | 需要注意 |
| --- | --- | --- | --- |
| Skills | 读目录或单个 Markdown | 正文经 `Skill` 工具调用后作为 tool result 进入上下文 | 命令名加插件 `name` 前缀：`<name>:<skillName>`；普通 Run 不会自动发现插件 Skill |
| Agents | 递归收集 Markdown，解析 frontmatter | 名字加插件 `id` 前缀：`<id>:<name>` | 插件 Agent 里内嵌的 `hooks` 与 `mcpServers` 被强制清空；`omitClaudeMd` 固定为 false |
| Hooks | 读 JSON，按事件分组 | 随 Runtime 注册，生命周期事件触发 | 未知事件名直接判 invalid；支持 `command`/`http`/`prompt`/`agent` 四种；**不受 `@插件` 控制** |
| MCP | 读 JSON 的 `servers` 对象 | Runtime 连接，工具按归属暴露 | 必须显式写 `type`，`stdio` 要 `command` 且不能同时有 `url`，`http`/`sse` 要 `url` 且不能有 `command`；声明远端地址不代表已完成认证 |
| Node Tools | 只解析元数据，不执行 | 独立 Tool Host 子进程 | 入口必须导出 `registerTools(context)` 并返回定义数组 |
| 其余 9 类 | 识别但不实现 | 无 | 只产生 warning，不影响同插件其他组件 |

参考插件 `examples/plugins/text-inspector` 覆盖了 Skill + Plugin Agent + Node Tool 的最小闭环，工具名为 `TextInspectorCheck`。

### 7.1 插件 MCP 与宿主 Settings MCP 的合并规则

这一块容易踩坑，单独说明：

- 运行时最后使用的 MCP 配置是 `{ ...插件提供的 servers, ...settings.mcpServers }`，**同名的宿主 Settings 配置覆盖插件配置**。
- 但在合并之前，`packages/agent-runtime/src/plugin-capability-inventory.ts` 会先检查插件 MCP 名字是否撞上宿主已保留的 server 名。撞上就记一条 error 级 `plugin_mcp_server_name_conflict`，并把**整个插件**排除出可用集合，而不是只丢掉那一个 server。
- 插件之间的同名 MCP server 也会触发 `plugin_component_name_conflict`，同样把涉及的插件全部排除。
- `packages/agent-runtime/src/runtime-integrations.ts` 在装配阶段还会对重复 owner 直接抛错。注意这条守卫遍历的是**已经排除过冲突**的 inventory，所以宿主同名和跨插件同名这两种情况根本到不了这里；它实际主要拦的是显式传入的 `options.mcpServers` 与插件 server 撞名。

结论：插件 MCP 的命名冲突是“整插件出局”的严重程度，不是“重命名后继续”。作者应给 server 加上插件专属前缀。

## 8. Native Tool 的运行机制

这是插件系统里唯一会 `import()` 第三方模块的地方，也是最复杂的一段。但它不是唯一会“跑第三方东西”的地方：`command` 与 `http` Hook 由 Hook Executor 在宿主进程内执行，见第 8.6 节。

### 8.1 进程与协议

`NativeToolHost`（`packages/agent-runtime/src/native-tools/tool-host.ts`）用 `child_process.fork` 启动 `host-entry.mjs`，IPC 用 advanced serialization，走四种请求方法：`healthcheck`、`registerTools`、`callTool`、`shutdown`，另有宿主主动发的 `cancel`。

子进程侧（`packages/agent-runtime/src/native-tools/host-entry.mjs`）：

- 逐个 `import()` manifest 声明的入口模块，要求导出 `registerTools`；
- 校验每个工具定义（`name`、`description`、`inputSchema`、`invoke` 都要合法），工具名在一个插件内不能重复；
- 调用时把 `plugin`、`permissions`、`cwd`、`sessionId`、`deadline`、`signal` 交给插件，其中 `plugin` 与 `permissions` 是冻结副本；
- 校验返回值形状必须是 `{ content: [...] }`；
- `uncaughtException` / `unhandledRejection` 会把栈写回宿主日志后退出，宿主据此判为崩溃。

`deadline` 是绝对毫秒时间戳，`signal` 用于协作式取消——插件不响应取消时，宿主会在 grace period 后杀进程。

### 8.2 调用闸门

每次调用都经过 `NativeToolCallGuard`（`packages/agent-runtime/src/native-tools/guard.ts`）：

1. **并发上限**，默认 4，超了返回 `tool_concurrency_limit`；
2. **输入校验**，按 `inputSchema` 支持的部分 JSON Schema 关键字（`const`、`enum`、`type`、`required`、`properties`、`additionalProperties: false`、`items`、`minItems`/`maxItems`、`minLength`/`maxLength`）校验，失败返回 `tool_input_invalid`，**插件代码根本不执行**。有两个作者常踩的坑：一是这里不是完整的 JSON Schema 实现，数值范围（`minimum`/`maximum`）和 `pattern` 都不生效，需要强约束的插件要自己在 `invoke` 里再查一遍；二是只要出现 `properties`、`required` 或 `additionalProperties: false` 中的任意一个，校验器就会按对象处理，即使没写 `type: "object"`；
3. **审计日志**，记录插件 ID、工具名、cwd、sessionId、参数摘要（只记类型和长度，不记原文）、耗时、状态和错误码。

### 8.3 超时、取消与崩溃

| 行为 | 默认值 | 结果 |
| --- | --- | --- |
| 注册/健康检查超时 | 10 s | 激活失败，`tool_protocol_timeout` |
| 单次调用超时 | 60 s | `tool_call_timeout`，并通知子进程取消 |
| 关闭握手超时 | 2 s | 直接 kill |
| 取消宽限期 | 250 ms | 插件仍未停下就杀进程，报 `tool_host_unresponsive` |
| stdout / stderr / IPC 日志上限 | 各 64 KiB | 截断并抑制后续输出，只提示一次 |
| 单条日志上限 | 8 Ki 字符（`String.length`，即 UTF-16 代码单元，不是字节） | 截断 |

Host 崩溃或退出时，宿主会注销该插件的全部 Tool，激活结果与运行状态记为 `error`，`runtimeStatus` 显示 `tool_host_failed`，建议用户先禁用该插件。

一个实测出来的细节：**别用 `host.state` 判断“这个插件曾经起不来”**。启动失败路径里 `start()` 会先置 `error`，随后在清理时调用 `stop()`，而 `stop()` 会把状态归零成 `inactive`，所以失败后读到的往往仍是 `inactive`。判断失败要看激活返回的 `state`、诊断或 `runtimeStatus`，不要看 Host 对象自己的状态。

### 8.4 环境变量与命名

子进程**只继承白名单环境变量**：`PATH`、`Path`、`SystemRoot`、`WINDIR`、`ComSpec`、`PATHEXT`、`TEMP`、`TMP`、`TMPDIR`、`LANG`，再加上标记位 `VYKOR_NATIVE_TOOL_HOST=1`（Electron 场景补 `ELECTRON_RUN_AS_NODE=1`）。daemon 的 API key 等环境变量不会泄漏给 Tool Host 子进程。

注意这条白名单的作用范围仅限 Tool Host。插件的 `command` Hook 在宿主进程内执行，不受这层保护，见第 8.6 节。

工具名是全局注册名，不加插件前缀，因此可能撞名。以下情况直接判冲突并让激活失败：

- 撞到宿主保留名 `Shell`、`Bash`；
- 撞到已注册工具，返回 `tool_name_conflict`。

建议作者用带产品前缀的工具名，参考插件用的是 `TextInspectorCheck`。

### 8.5 运行状态

`packages/agent-runtime/src/native-tools/status.ts` 维护进程内的 Host 状态汇总（状态、Host 数量、已注册工具名、最近启动时间、最近错误）。同一插件在多个 live Runtime 里会各有一个 Host，所以 `hostCount` 可能大于 1。这份状态是进程内内存，不持久化。

### 8.6 Hook 的执行边界（与 Tool 不同，容易误判）

Hooks 不走 Tool Host。`packages/agent-runtime/src/plugin-activation.ts` 只是把 Hook 定义注册进 HookExecutor，真正执行发生在宿主进程里（`packages/hooks/src/index.ts`）：

| Hook 类型 | 实际执行位置 | 是否受 Tool Host 的环境变量白名单约束 |
| --- | --- | --- |
| `command` | 宿主进程通过 shell 执行插件声明的命令字符串 | 否 |
| `http` | 宿主进程直接发起 HTTP 请求 | 否 |
| `prompt` / `agent` | 走模型调用 | 否 |

也就是说：

- **第 8.4 节的环境变量白名单只保护 Tool Host 子进程**，不保护 `command` Hook。`command` Hook 拿到的 cwd 是 HookExecutor 的 cwd，环境变量只额外注入 `VYKOR_HOOK_EVENT` 和 `VYKOR_HOOK_PAYLOAD`。
- **manifest 权限不拦截 Hook**。`command`/`http` Hook 没有经过第 9 节的权限解析或批准流程，插件在 `hooks` 文件里写一条 `type: "command"` 就能让宿主执行命令。
- **Hook 也不受 `@插件` 控制**：它随 Runtime 注册，只要插件被加载就生效。

因此“插件能做什么”的准确答案是两条路径的并集：Tool 走受管子进程，Hook 走宿主进程。评估插件风险时必须把 Hook 一起算进去。

## 9. 权限模型：三层，而且都不是沙箱

| 层 | 位置 | 作用 |
| --- | --- | --- |
| 声明 | manifest `permissions` | 插件说自己需要什么，例如 `filesystem: ["workspace:read"]` |
| 细化 | Tool 条目的 `permissions` | 单个工具额外要什么，写法是 `类别:值`（`:` 或 `.` 都接受），**必须是 manifest 已声明的子集** |
| 批准 | 安装记录 `approvedPermissions` | 用户实际批准过的权限，必须与请求集合完全一致才能安装 |

三层关系是“逐层收紧”：Tool 要的权限如果 manifest 没声明，整条 Tool 直接判 error；安装时批准集合与请求集合必须精确匹配；运行前再检查每个请求权限是否都在批准列表里，缺一个就拒绝加载整个插件并提示重新批准或重装。

需要明确的是：**这些权限目前是宿主闸门，不是系统调用过滤**。第三方 Node Tool 仍然可以直接调用 Node 的文件、网络和进程 API，manifest 权限不能阻止它。子进程边界隔离的是崩溃影响面和环境变量，不是文件系统访问。

## 10. Run 级能力视图

安装并启用只代表“可被发现”。真正决定一轮对话能用什么的是 `RunCapabilityView`（`packages/agent-runtime/src/run-capability-view.ts`）。

流程是：用户在输入里选 `@插件` → 输入只持久化 `pluginId` 和展示名 → 服务端 `SessionPluginCapabilityService` 校验这个 `pluginId` 在当前目录下是否有效、Plugin Agent 归属是否匹配、是否一次混用了多个插件 → Run 从会话暖 Runtime 的已加载状态生成内存视图 → 视图创建后冻结。

视图的过滤规则可以概括成一句：

```text
当前 Run 可见能力
= 非插件基线能力（内置工具、Settings MCP、用户/项目 Skill、非插件 Agent）
+ 当前 pluginId 拥有且已启用、已批准的插件能力
```

视图创建前还会检查该插件的真实准备结果：Native Tool 未启动、Host 已退出、MCP 未连接或工具发现失败，都会在调用模型前让 Run 失败并记录原因，而不是仅凭静态目录把插件当成可用。

执行阶段的防绕过来自三点：调用 Tool、加载 Skill、创建 Child 时，用的是视图里冻结的 binding（定义对象与路径），不按名字回查全局 Registry；Tool 注册时还嵌了一层 `capabilityView.pluginId` 与 `ownerPluginId` 的双重比对；Plugin Agent 创建 Child 时，子视图从父视图派生，换工作目录也不会重新发现并扩大范围。

### 10.1 子视图到底收了什么

这里容易把“交集”说得太满。`packages/agent-runtime/src/child-agent-options.ts` 的 `deriveChildCapabilityView` 实际只收窄两类能力：

| 能力 | 子视图实际行为 |
| --- | --- |
| `tools` | 按 Agent 声明的 `allowedTools`/`disallowedTools` 过滤，并丢掉指向不可见 MCP server 的绑定 |
| `mcpServers` | 只有在 Agent 声明了 `requiredMcpServers` 时才收窄到匹配的那几个；没声明就整份继承 |
| `skills` | **原样继承父视图，不收窄** |
| `agents` | **原样继承父视图，不收窄** |

两点推论：

- `requiredMcpServers` 里的名字必须在父视图里恰好匹配一个 server（按 `serverId` 或 `serverName` 匹配），匹配到 0 个或多个直接抛错，不给“勉强放行”的机会。
- 因为 `pluginId` 是随父视图一路继承的，父 Run 选了插件 P，Child 依然只在 P 的范围内；但反过来，Child 上看得到的 `skills`/`agents` 比 Agent 自己声明的更多，不要用 Agent 定义去推断它实际可见的技能与子代理清单。

## 11. 管理面

**HTTP 路由**（`packages/server/src/http/routes/service.ts`）：

```text
GET    /plugins?cwd=                    列出插件与 runtimeStatus
POST   /plugins/install-local           安装本地目录
POST   /plugins/link-local              链接本地目录（开发用）
POST   /plugins/archive/preview         预览本地插件包
POST   /plugins/archive/install         安装本地插件包（校验摘要一致）
POST   /plugins/git/preview             预览 Git 来源
POST   /plugins/git/install             安装 Git 来源
POST   /plugins/:id/enable|disable      启停
DELETE /plugins/:id                     卸载
POST   /plugins/reload                  关闭该 cwd 的 Runtime，下次使用重新加载
```

并发保护：安装、链接、插件包安装、Git 安装、启停和卸载都用全局 mutation lease，拿不到就返回 409；`reload` 用 cwd 级 lease，且不改安装状态。安装成功后关闭全部 Runtime，这正是“下一次对话生效”的实现方式。

**插件包与 Git 来源**（`packages/plugin-sources/src/`）：

- 支持 `.zip`、`.tar`、`.tar.gz`、`.tgz`；
- 硬限制：源包 100 MiB、解压总量 250 MiB、最多 5,000 个条目、单文件 100 MiB、压缩比 200、路径 UTF-8 1,024 字节、目录深度 32；
- 拒绝加密条目、绝对路径、反斜杠、`..`、Windows 保留名、Unicode/大小写重复、文件与目录冲突、符号链接；
- manifest 位置只允许包根 `.vykor-plugin/plugin.json`，或唯一一层包装目录 `<name>/.vykor-plugin/plugin.json`；
- Git 来源用系统 `git`（`init` → `remote add` → `fetch --depth=1` → `checkout --detach FETCH_HEAD` → `rev-parse HEAD`），固定到具体 commit，删掉 `.git` 再交付；`sourceDigest` 绑定 URL + ref + commit，preview 与 install 之间源变了就要求重新预览。

**转换器**（`packages/plugin-converters/src/`）：内置 Claude Code 与 Codex 两个转换器，流程固定为 `detect → inspect → plan → approve → convert → Native 校验`，逐项标记 `exact`/`adapted`/`unsupported`/`blocked`。转换期只读源文件，不执行代码、不连网、不装依赖。

两个转换器的批准门**并不相同**，这点容易写错：

| | Claude Code 转换器 | Codex 转换器 |
| --- | --- | --- |
| 需要批准的内容 | 实际上没有：`plan()` 只产出 `exact`/`adapted`/`unsupported`，既不产出 `blocked`，也不设置 `requiredApprovals`，所以 `convert()` 里那段 `blocked` 检查目前走不到 | 每个 MCP server 条目，以及每个 unsupported 条目，都带 `requiredApprovals`；MCP 还会为推导出的 `network`/`process` 权限各加一项 `类别:权限` |
| 缺批准时的行为 | 不适用 | `convert()` 抛错 `Explicit conversion approval required: ...`，不产出目录 |
| 返回状态 | 有 `unsupported` 项时 `partial`，否则 `success` | 同左 |

注意两点：一是“缺批准”是**抛异常**，不是返回 `status: "blocked"`——`ConversionReport.status` 的联合类型里有 `blocked`/`failed`，但当前代码路径不会返回它们，想按状态分支的调用方会踩空；二是 Codex 的 `convert()` 会先从源重新推导一次 plan 并比对摘要，plan 过期或源已变化都会先于批准检查抛错。两个转换器在 `convert()` 里都会拒绝已存在的输出目录、源在 plan 之后被改动、以及“没有任何可转换组件”的源。

**客户端**（`packages/client/src/resources/plugin-resource.ts`）：路由映射与上面的 HTTP 表一致，注意 `installLocal()` 一个方法覆盖 `/plugins/install-local` 与 `/plugins/link-local` 两条路由，靠 `link` 参数分流，没有单独的 link 方法。`reload()` 返回 `ReloadPluginsResponse`（`message` + 插件列表 + `warnings`）。CLI 与会话命令展示重载结果用 `packages/client/src/commands/plugin-presentation.ts` 的 `formatPluginReload`，输出会明确写“重载只让 Runtime 失效，实际加载发生在下一次使用”，并在权限缺失时提示重新 link/安装并补 `--approve`。

**CLI**（`apps/cli/src/commands/plugin.ts`）：

```bash
vk plugin list [--verbose] [--json]
vk plugin details <id>
vk plugin validate <path>
vk plugin install-local <path> [--approve <permission>]
vk plugin link <path>                  # 开发用，目录改动重载后生效
vk plugin enable|disable <id>
vk plugin uninstall <id>
vk plugin convert <source> --from codex|claude-code [--dry-run] [--output <dir>]
vk plugin install <source> --from codex|claude-code
```

全局开关有两条：`vk --no-plugins` 只影响本次新建会话；`vk config set plugins.enabled false` 持久关闭所有已安装插件的贡献（不影响内置 Skill、普通用户/项目 Skill、Settings Hooks 与 Settings MCP）。

**Desktop**：插件页通过主进程 IPC 走 daemon，渲染进程拿不到插件包绝对路径和摘要；主进程维护 `selectionId → { archivePath, archiveDigest, requestedPermissions }` 的短期映射（10 分钟 TTL，最多 8 条）。插件包与 Git 来源各用一张独立的映射表（`PluginArchiveSelectionStore` / `PluginGitSelectionStore`），两张表分别按 8 条封顶、TTL 相同，确认时 `consume()` 会立即移除条目。一次导入只会有三种结果：成功、需要一次权限确认、失败。

### 11.1 打包后的 Tool Host 入口

`NativeToolHost` 用 `new URL("./host-entry.mjs", import.meta.url)` 定位子进程入口，所以打包时必须把这个 `.mjs` 原样放到编译产物旁边。当前有三处保证：

- `packages/agent-runtime/scripts/build.mjs` 把它复制到 `dist/host-entry.mjs`；
- `apps/desktop/electron.vite.config.ts` 把它复制到 main 产物目录；
- `apps/desktop/scripts/verify-update-packaging.mjs` 断言产物里存在该文件，缺失即报错。

这段是插件机制里最容易被构建改动破坏的耦合点：改了 agent-runtime 的打包方式、或换了 main 产物目录，都必须同步改这三处。实测（把 `tool-host.ts` 单独放到一个没有 `host-entry.mjs` 的目录里再启动）缺失入口时的表现是：`fork` 本身不报错，子进程加载模块失败后以 code=1 退出，宿主因此抛出 `tool_host_crashed`（`Native Tool Host exited (code=1, signal=none)`），用户侧统一显示为 `tool_host_failed`。注意不是 `tool_host_spawn_failed`，也不是 `tool_host_unavailable`——不要按这两个码去排查这种情况。

**Slash**：会话里的插件命令是 `/plugin [list|enable ID|disable ID]` 和 `/reload-plugins`。`/reload-plugins` 关闭当前 cwd 的旧 Runtime，下一次使用时重新加载；HTTP 返回成功不等于插件已激活。

## 12. 观察到的设计取舍

这些是从代码里读出来的稳定约定，改动插件相关代码时应尽量保持：

- **能装 ≠ 能用**。安装、启用、`@选择`、单次工具授权是四个独立层级，代码里没有把它们合并成“一个状态”。
- **一切失败都 fail closed**。校验不过、摘要不符、权限缺失、Host 起不来，全都是拒绝加载并给诊断，不会“降级放行”。
- **内容不可变**。安装内容是带摘要的快照，正在被旧 Runtime 使用的目录不会被原地改写；重装是新建快照再切记录。
- **静态检查不执行代码**。解析、校验、加载三个阶段既不 import 也不执行第三方代码，并且有测试专门断言这一点。真正的执行只有两条路：Tool Host 子进程，以及宿主进程里的 `command`/`http` Hook。
- **活动 Run 不受插件更新影响**。Run 一旦开始，视图就冻结；插件更新通过“关闭 Runtime → 下次重建”生效，不做热替换。
- **能力只收不放**。Run 视图和 Child 视图都不会扩大范围：Child 视图把 `tools`、`mcpServers` 收窄，`skills`、`agents` 原样继承（第 10.1 节）；两者都不能恢复被权限、环境或宿主上限禁止的能力。
- **诊断结构化**。所有阶段返回同一套 `PluginDiagnostic`，并且管理接口把它映射成用户能执行的下一步动作，而不是把内部错误直接抛给用户。

## 13. 现状缺口与容易误判的地方

以下都是本次调研在代码里直接看到的、文档未完全覆盖的事实：

**能力边界**

- **不是操作系统级沙箱**。这是当前最大的边界：Node Tool 可以任意访问文件、网络和进程，manifest 权限不构成拦截。
- **Hook 不受权限闸门保护，可能是最容易被忽略的风险点**。`command`/`http` Hook 在宿主进程内执行，既不经过 Tool Host 的环境变量白名单，也不经过第 9 节的权限解析与批准流程。评估一个插件的实际能力时必须把 Hook 算进去，只看 Tool 会低估风险。
- **Wasm Tool 未实现**。声明 `runtime: "wasm"` 只会得到 warning，不激活。
- **9 类组件未实现**：lspServers、workflows、channels、providers、ui、outputStyles、themes、monitors、binaries。schema 已预留，装载时返回 `unsupported`。
- **一次 Run 最多一个插件**。跨插件组合输入被明确拒绝（`session_plugin_capability_conflict`）。
- **Hooks 不受 `@插件` 控制**。Hook 随 Runtime 注册，只要插件被加载就生效，不参与 Run 级选择。
- **插件级动态配置、密钥读取、持久数据 API 都还不存在**。`permissions.secrets` 只是声明，没有对应的读取接口。
- **Native Tool 只在本地环境可用**。`environmentKind !== "local"`（例如 WSL）时直接返回 `native_tools_unavailable_in_environment`。要注意 MCP 仍然会连接，所以“只有 Native Tool 一个组件”的插件在 WSL 里会静默地什么都不贡献；跨环境使用本地路径的问题另见 [原生插件开发指南](./native-plugin-authoring.md)。
- **多个 live Runtime 会各起一个 Tool Host**，插件会经历多次 `registerTools`。工具注册逻辑应当可重复执行且不依赖外部副作用。

**实现细节**

- **`managed` scope 是只读预留**。代码里决策优先级偏好 `managed`，但没有任何生产代码会写 `scope: "managed"` 的记录（只有测试构造它），安装器也明确拒绝非 user scope。也就是说这个通道当前只能被手工预置的文件使用。
- **`packages/plugins/src/activation/activate.ts` 已无调用点**。它导出的 `activateNativePlugin` 在仓库内没有任何调用者；Runtime 走的是 `packages/agent-runtime/src/plugin-activation.ts` 里的 `activateDiscoveredPlugins`。两套激活语义并存，容易误导后来者。
- **`discoverInstalledNativePlugins({ cwd })` 忽略 `cwd`**。函数签名保留了它，但函数体只读 `storePath`。这是 user-only 安装策略的残留。
- **`@vykor/plugins` 是 optional peer + dev 依赖，不是运行期依赖**。`packages/agent-runtime/package.json` 的 `dependencies` 只有 `@vykor/terminal-node`、`better-sqlite3`、`node-pty`、`sharp`；`@vykor/plugins` 出现在 `peerDependencies` 且被 `peerDependenciesMeta` 标为 optional，同时也在 `devDependencies` 里。构建时 esbuild 按 `bundle: true` 把它打进 `dist/index.js`，这也是运行期不需要单独安装它的原因。若将来把插件相关代码改成 external，这个声明会立刻变成运行期缺包问题。
- **旧 scope 记录会让整个 store 读取失败**。`readInstalledPluginStore` 只接受 `user` 与 `managed`，遇到其他 scope 直接抛 `Invalid installed plugin store`，因此旧 `project`/`local` 记录不是“被忽略并提示”，而是让插件列表整体报错。这与 `docs/superpowers/specs/2026-09-02-user-scoped-native-plugin-installation-design.md` 里“读取旧值并忽略它们、给出 warning”的描述已经不一致——是代码收紧、文档没跟上，按代码理解。
- **`data/` 与 `sources/` 目录只有路径定义**。`getPluginDataDir()` 和 `getPluginSourcesDir()` 除定义与自身测试外没有调用者，普通卸载“保留插件数据”目前没有实际数据可保留；插件包与 Git 来源都落在系统临时目录，不在 `sources/`。
- **缓存快照没有垃圾回收**。每次换版本都会留下旧快照，损坏快照会改名隔离留在原地，当前没有清理入口。
- **没有版本历史与回滚**。更新只有“重新导入同一 ID”一条路，且要求包仍在用户手里。
- **`runtimeStatus` 只是展示层派生**。它每次从安装记录、校验结果和 Tool 运行状态现算，不持久化；非 Tool 组件在缺少 live 证据时一律显示 `pending_reload`（“已启用，下一次对话生效”），这是刻意的诚实处理，不是 bug。

**验证覆盖**

- `plugin-capability-invocation-design.md` 记录的最后一次完整手动验收**没有在真实 Electron 里连模型跑通管理更新链**，该文档第 15 节列了 8 步待执行的手动验收。发版前值得补。

## 14. 后续路线（不含新增承诺）

按 [Native Plugin 后续工作交接](./native-plugin-next-stage-handoff.md) 的既有排序：作者体验（已完成）之后是 P2 Agent 对话内安装 → P3 更多来源（npm、archive URL、Marketplace）→ P4 声明式组件（Themes、Monitors、Workflows、Output Styles）→ P5 高风险能力（Channels、Providers、UI、自动依赖、第三方 Converter、操作系统级沙箱、Wasm Tool）。

明确暂缓、不要抢跑的项：`output_styles` 插件贡献、Agent 对话安装、自动更新、独立 Repair 命令、版本回滚、旧快照 GC 界面、Marketplace、npm 远程来源、第三方 Converter 动态加载、UI 与 LSP 插件贡献、操作系统级沙箱。

## 15. 本次调研的验证记录

在仓库根目录（HEAD `c80ae066`）实际执行：

```powershell
node node_modules/vitest/vitest.mjs run --root packages/plugins
node node_modules/vitest/vitest.mjs run --root packages/agent-runtime src/native-tools src/run-capability-view.test.ts src/runtime-plugin-readiness.test.ts
```

| 范围 | 结果 |
| --- | --- |
| `packages/plugins` | 12 个测试文件、51 个用例全部通过（退出码 0） |
| `packages/agent-runtime` 插件相关 | 5 个测试文件、46 个用例全部通过 |

其中两个用例直接支撑本报告的关键断言：`native-plugin-authoring.test.ts` 断言“静态校验/加载/发现阶段不执行入口代码，只有激活才在子进程中执行”，以及“源目录删除后，已校验的用户快照仍可调用”；`run-capability-view.test.ts` 覆盖 Run 视图的执行边界。

补充说明：后一条命令 PowerShell 退出码为 1，原因是测试用例故意把 `[plugins] dev.failed: registration exploded` 写到 stderr，被 PowerShell 5.1 当成 `NativeCommandError` 上报；Vitest 自身输出 `5 passed / 46 passed`，无失败用例。

### 15.1 三轮独立审阅与其结论

本报告经过两轮独立只读审阅，审阅者的目标是证伪而不是确认。

**第一轮结论：不安全**，找出两处实质性错误，均已按代码修正：

1. 初版称“只有 Native Tool 会执行第三方代码 / 唯一会执行第三方代码的地方”。这是错的：`command`/`http` Hook 由宿主进程内的 Hook Executor 执行，不走 Tool Host 子进程，见第 8.6 节。
2. 初版称旧 `project`/`local` 记录“被忽略并提示重新安装”。这是错的：store 读取会直接失败，见第 5 节与第 13 节。

同时补入了几处初版没有覆盖的内容：MCP 与宿主 Settings 的合并与整插件排除规则（第 7.1 节）、把发现结果接成活 Runtime 的入口文件（第 6.3 节）、打包后 Tool Host 入口的三处构建保证（第 11.1 节）、WSL 下 MCP 仍连接而 Tool 不可用的组合后果（第 13 节）。

**第二轮结论：可以当作权威文档**，未发现新的实质性错误，并确认上述两处已真正修好。第二轮提出 3 条应改项与 4 条措辞建议，均已处理：

- §5 原来把根联接的拦截归因给 realpath 比对，审阅指出该文件有两道检查、抛的是同一句错误信息，从代码无法判定是哪一道。实测后确认审阅的怀疑成立：Windows 上 `lstat()` 对联接就返回 `isSymbolicLink() === true`，触发的是**第一道**检查，归因已改正（第 5 节）。
- §12 “只能进一步缩小范围”与第 10.1 节的“skills/agents 原样继承”读起来冲突，已改为按能力分别表述。
- §1.1 有一行把 Hook 无权限门的事引到了第 9 节，已改引到第 8.6 节。
- 另外收紧了 §2 流程图（补上 Hook 执行这条路径）、§1.1 中 `@插件` 一行（选择本身会持久化，每 Run 冻结的是视图）、§7.1 中重复 owner 抛错的实际适用范围、以及第 11 节客户端路由映射的表述。

**第三轮结论：可以当作权威文档**，只审本轮增量。确认 §5 的归因改对了（第一道检查先触发，realpath 比对是独立兜底），其余 5 处增量与代码一致，且增量之外的已审部分没有回退。

三轮审阅都不重复运行测试套件，只做静态读码核对；本报告里所有实测结论都来自本节记录的有界实验。

### 15.2 补充验证清单

审阅列出的“未覆盖”项中，以下几项已直接查证，结论写进了正文：

| 项 | 做法 | 结果 |
| --- | --- | --- |
| 客户端资源路由映射与重载返回 | 逐行读 `packages/client/src/resources/plugin-resource.ts` 与 `packages/client/src/commands/plugin-presentation.ts` | 与 HTTP 路由对应（`installLocal` 一个方法覆盖 install-local 与 link-local），已补入第 11 节 |
| 转换器批准链路 | 读两个转换器的 `plan()` 与 `convert()` 实现 | 发现两个转换器的批准门不同，且缺批准是抛异常而非返回 `blocked` 状态；已按实际重写第 11 节转换器一段 |
| Windows 目录联接是否被拦 | 在临时目录用 `mklink /J` 造根联接与嵌套联接，直接调用 `assertRegularPluginCacheSnapshot` 与 `computePluginBehaviorDigest`，并带真实目录做对照 | 根联接被快照守卫拒绝、嵌套联接被摘要遍历拒绝；已补入第 5 节 |
| 根联接是被哪一道检查拦下的 | 另跑一个探针，对同一联接同时打印 `lstat()` 的 `isDirectory()`/`isSymbolicLink()`、realpath 比对结果，以及 `readdir` 的 `Dirent` 标志 | `lstat` 对联接报 `isDirectory()=false`、`isSymbolicLink()=true`，所以是 `assertRegularPluginCacheSnapshot` 的第一道检查触发；realpath 比对是独立兜底。归因已改正（第 5 节） |
| `@vykor/plugins` 的依赖声明 | 读 `packages/agent-runtime/package.json` 与构建脚本 | 是 optional peer + dev 依赖，靠 esbuild 打包进产物；已补入第 13 节 |
| Tool Host 入口缺失时到底报哪个错误码 | 把 `tool-host.ts` 复制到一个没有 `host-entry.mjs` 的目录，构造带一个 Tool 声明的插件并直接调 `start()` | 实际是 `tool_host_crashed`（子进程 code=1 退出），不是 `tool_host_spawn_failed` 或 `tool_host_unavailable`；同时发现失败后 `host.state` 会被 `stop()` 归零成 `inactive`。两处都已按实测改写（第 8.3、11.1 节） |
| 子视图是否真的是“交集” | 读 `packages/agent-runtime/src/child-agent-options.ts` 的 `deriveChildCapabilityView` | 只收窄 `tools` 与 `mcpServers`；`skills` 与 `agents` 原样继承。已把第 10 节的“取交集”改成按能力分类的实际规则（第 10.1 节） |

### 15.3 仍未验证的部分

以下项不在本报告的证据范围内，**不要当作已验证**：

- 所有结论都在 Windows + Node 环境得到；**macOS/Linux 未验证**，尤其是符号链接、路径大小写与文件权限相关行为。第 5 节关于联接的具体归因依赖 libuv 在 Windows 上的行为，换平台需要重新确认。
- WSL 下“MCP 仍连接、Native Tool 不可用”的组合后果来自代码分支推断，没有在真实 WSL 环境跑过。
- 插件同名冲突或快照失败被排除后，Desktop 插件页具体怎么呈现给用户，只追到 `runtimeStatus` 与 CLI 输出这一层。
- 真实 Electron 连模型的端到端手动验收（`plugin-capability-invocation-design.md` 第 15 节列的 8 步）没有执行；本报告不对其负责。
- 第 15 节的用例数为实测结果；两轮审阅与本章补充验证都是静态读码加有界实验，没有重跑完整测试套件。

## 16. 关键文件速查

改插件相关代码时，按需求直接跳到对应文件：

| 想做什么 | 看哪里 |
| --- | --- |
| 加/改 manifest 字段 | `packages/plugins/src/manifest/schema-v1.ts`、`packages/plugins/src/types.ts` |
| 改路径安全规则 | `packages/plugins/src/paths.ts` |
| 新增一种组件的加载 | `packages/plugins/src/components/`、`packages/plugins/src/load-native-plugin.ts` |
| 改安装与快照语义 | `packages/plugins/src/installation/installer.ts`、`cache.ts`、`store.ts`、`verify.ts` |
| 改运行前校验 | `packages/plugins/src/installation/verify.ts` |
| 改 Tool 子进程协议 | `packages/agent-runtime/src/native-tools/protocol.ts`、`tool-host.ts`、`host-entry.mjs` |
| 改 Tool 调用限制 | `packages/agent-runtime/src/native-tools/guard.ts` |
| 改插件发现/冲突规则 | `packages/agent-runtime/src/plugin-discovery.ts`、`plugin-capability-inventory.ts` |
| 把发现接成活 Runtime | `packages/agent-runtime/src/runtime-integrations.ts` |
| 改 Hook 的执行方式或边界 | `packages/agent-runtime/src/plugin-activation.ts`、`packages/hooks/src/index.ts` |
| 改 Run 可见性 | `packages/agent-runtime/src/run-capability-view.ts`、`packages/server/src/application/session/session-plugin-capability-service.ts` |
| 改管理接口 | `packages/server/src/application/default-services/plugin-service.ts`、`packages/server/src/http/routes/service.ts` |
| 加命令 | `apps/cli/src/commands/plugin.ts` |
| 改插件页 | `apps/desktop/src/main/features/plugin/plugin-service.ts`、`apps/desktop/src/renderer/src/components/desktop/plugin-page` |
| 改打包后 Tool Host 入口 | `packages/agent-runtime/scripts/build.mjs`、`apps/desktop/electron.vite.config.ts`、`apps/desktop/scripts/verify-update-packaging.mjs` |
| 看参考写法 | `examples/plugins/text-inspector` |
