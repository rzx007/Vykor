# OpenHarness 插件系统最终形态交接

> 状态：当前架构与实现交接。

日期：2026-09-14

状态：目标架构与当前实现交接

适用范围：Native Plugin、外部格式转换、安装、运行时激活、CLI、Desktop 和后续 Marketplace

## 1. 交接结论

OpenHarness 插件系统最终只保留一种运行格式：**OpenHarness Native Plugin（原生插件）**。

Claude Code、Codex、Git 仓库、npm 包、压缩包和 Marketplace 都只是不同的来源。它们可以有不同的下载与解析方式，但进入安装器之前必须变成同一种 Native Plugin。Runtime 不解析 Claude Code 或 Codex 的 manifest，也不根据来源格式走不同的执行分支。

完整链路如下：

```text
本地目录 / link ────────────────────────────────┐
Git / npm / archive ─ Source Resolver ──────────┤
Marketplace ───────── Source Resolver ──────────┘
                                                ↓
                                         Resolved Source
                                                ↓
                     ┌─ 已是 Native Plugin ─────┤
                     ├─ Claude Code ─ Converter ┤
                     ├─ Codex ─────── Converter ┤
                     └─ 其他格式 ──── Converter ┘
                                                ↓
                                    Native Plugin Artifact
                                                ↓
                         validate → permissions → snapshot → store
                                                ↓
                                         Runtime Activation
                                                ↓
               Skills / Agents / Hooks / MCP / Tools / 其他 Native 贡献
```

这里最重要的边界是：

- 下载器只取得源码或插件包，不理解组件语义；
- Converter 只做格式转换，不负责安装、启停和运行；
- Installer 只接收 Native Plugin，不理解 Claude Code 或 Codex；
- Runtime 只加载已经安装并再次校验通过的 Native Plugin；
- Desktop、CLI 和 Server 操作同一份安装状态，不各自维护插件副本。

## 2. 用户最终看到的插件

用户不需要区分“原生插件”和“转换插件”该怎么运行。安装完成后，两者都按同一种插件管理。

插件详情可以显示来源：

```text
Quality Tools
ID: example.quality-tools
Version: 1.4.0
Origin: Native
```

或：

```text
UI Designer
ID: converted.claude.ui-designer
Version: 1.0.0
Origin: Converted from Claude Code
Converter: claude-code@1.0.0
```

来源字段只用于：

- 展示插件从哪里来；
- 查看转换报告；
- 判断源插件或 Converter 更新后是否需要重新转换；
- 排查功能损失。

来源字段不能用于：

- 让 Runtime 切换到 Claude Code 或 Codex 兼容模式；
- 绕过 Native manifest 校验；
- 自动扩大权限；
- 在插件运行时重新读取原始插件目录。

## 3. 三种需要严格区分的对象

### 3.1 Source Plugin

Source Plugin 是尚未进入 OpenHarness 的输入，例如：

- Claude Code 插件目录；
- Codex 插件目录；
- Git 仓库中的插件；
- npm 包；
- `.zip`、`.tar.gz` 等压缩包；
- Marketplace 条目指向的某个版本。

Source Plugin 不可信。检查和转换阶段只能静态读取文件，不能执行安装脚本、import JavaScript、启动 MCP/LSP 或访问插件声明的网络地址。

### 3.2 Native Plugin Artifact

Native Plugin Artifact 是符合 OpenHarness 规范、可以送入 Validator 的完整目录。它可能由开发者直接编写，也可能由 Converter 生成。

Runtime 唯一认可的 manifest 是：

```text
<plugin-root>/.openharness-plugin/plugin.json
```

### 3.3 Installed Plugin

Installed Plugin 是已经完成以下步骤的 Native Plugin：

1. 校验 manifest 和组件路径；
2. 计算实际请求权限；
3. 获得用户明确授权；
4. 复制到不可变 cache 快照，或以显式开发 link 方式登记；
5. 写入 `installed.json`；
6. Runtime 加载前再次核对快照、identity、版本、权限和内容摘要。

“转换成功”不等于“已经安装”，“安装成功”也不等于“当前 Runtime 已经热加载”。这 3 个状态需要分别返回和展示。

### Desktop 当前入口

Desktop 插件页目前支持两个最小安装入口：从本地 Native Plugin 包导入，以及从 Git URL 安装。入口都收在右上角“添加”菜单里，Git 安装只打开一个 URL/ref 弹窗，不在页面主体常驻表单。本地包格式支持 `.zip`、`.tar`、`.tar.gz` 和 `.tgz`；Git 来源使用系统 `git` 固定到实际 commit，并在安装前移除 `.git`。两条入口都会在后台静态校验，未申请权限时直接安装，申请权限时只请求一次完整确认；重新导入同一插件 ID 时，既有批准覆盖本次权限便直接安装，只有新增权限才重新确认。重新安装沿用同一条安装链路，成功切换前保留旧记录，并保留插件原来的启停状态。结果返回成功、失败或待刷新确认，成功后的激活从下一次对话开始。绝对插件包路径和摘要不返回 Renderer，安装器收到的仍是已经准备好的目录。

这不改变最终多来源架构：Agent 对话安装、Claude Code/Codex 转换、npm、归档 URL 和 Marketplace 还没有进入 Desktop。旧插件页 localStorage 配置仅被隐藏，未迁移或删除。

## 4. Native Plugin 包结构

推荐目录如下：

```text
my-plugin/
├─ .openharness-plugin/
│  └─ plugin.json
├─ skills/
│  └─ review/
│     ├─ SKILL.md
│     ├─ scripts/
│     ├─ references/
│     └─ assets/
├─ agents/
│  └─ reviewer.md
├─ hooks/
│  └─ hooks.json
├─ mcp/
│  └─ servers.json
├─ tools/
│  └─ index.mjs
├─ workflows/
├─ channels/
├─ providers/
├─ ui/
├─ output-styles/
├─ themes/
├─ monitors/
├─ bin/
├─ assets/
├─ README.md
└─ LICENSE
```

目录名只是推荐组织方式。真正的组件入口由 manifest 的 `components` 明确声明，Loader 不能扫描未知目录并猜测功能。

转换产物可以额外包含：

```text
.openharness-conversion/
├─ provenance.json
├─ plan.json
└─ report.json
```

这 3 个文件只用于审计和展示，不是 Runtime 组件。删除它们不能改变插件的运行行为。

转换后的组件直接放进 Native 目录，不再保留 `payload/`、`generated/`、`agents/agents/` 等转换器内部包装层。

## 5. Manifest 最终职责

一个目标形态的 manifest 示例：

```json
{
  "$schema": "https://openharness.dev/schemas/plugin-v1.json",
  "schemaVersion": 1,
  "id": "example.quality-tools",
  "name": "quality-tools",
  "displayName": "Quality Tools",
  "version": "1.4.0",
  "description": "Code review and quality automation",
  "author": {
    "name": "Example Team"
  },
  "components": {
    "skills": ["./skills"],
    "agents": ["./agents"],
    "hooks": ["./hooks/hooks.json"],
    "mcpServers": ["./mcp/servers.json"],
    "tools": [
      {
        "entry": "./tools/index.mjs",
        "runtime": "node",
        "permissions": ["filesystem:workspace:read"]
      }
    ],
    "workflows": ["./workflows"],
    "channels": ["./channels"],
    "providers": ["./providers"],
    "ui": ["./ui"],
    "outputStyles": ["./output-styles"],
    "themes": ["./themes"],
    "monitors": ["./monitors"]
  },
  "permissions": {
    "filesystem": ["workspace:read"],
    "network": [],
    "process": [],
    "secrets": []
  },
  "runtime": {
    "engine": "node",
    "isolation": "process"
  }
}
```

转换插件只在 `metadata` 中增加轻量来源信息：

```json
{
  "metadata": {
    "origin": "converted",
    "sourceFormat": "claude-code",
    "converterId": "claude-code",
    "converterVersion": "1.0.0"
  }
}
```

manifest 描述插件包本身，不保存以下运行状态：

- 是否启用；
- 安装时间；
- cache path；
- 用户批准了哪些权限；
- 当前 Tool Host 是否存活；
- MCP 是否连接成功；
- 是否需要重载；
- Marketplace 收藏、下载量等展示数据。

这些信息分别属于 installation store、Runtime status 和 Marketplace metadata。

## 6. Native 贡献能力

最终所有扩展能力都通过 `components` 进入，但每种组件有自己的 Loader 和激活器，不能用一个万能的动态 import 处理。

| Component | 实际作用 | 最终激活位置 | 当前状态 |
|---|---|---|---|
| Skills | 给模型提供按需加载的流程与知识 | Skill Registry | 已实现 |
| Agents | 提供可委派的专门 Agent | Coordinator / Agent Runtime | 已实现 |
| Hooks | 响应 Session、Tool 等 Runtime 事件 | Hook Executor | 已实现 |
| MCP Servers | 连接外部工具与数据 | MCP Runtime | 已实现 |
| Native Tools | 提供 OpenHarness 原生 Tool | 独立 Tool Host | Node 已实现，Wasm 未实现 |
| LSP Servers | 提供诊断、定义、引用和代码导航 | LSP Runtime | 暂缓 |
| Output Styles | 提供输出组织方式 | Output Style Registry | 未实现插件贡献 |
| Themes | 提供界面主题与 token | Desktop Theme Registry | 未实现插件贡献 |
| Monitors | 提供后台观察任务 | Monitor Runtime | 未实现插件贡献 |
| Workflows | 提供可复用工作流定义 | Workflow Registry | 未实现插件贡献 |
| Channels | 提供外部消息入口与回复能力 | Channel Runtime | 未实现插件贡献 |
| Providers | 提供模型 Provider 和认证适配 | Provider Registry | 未实现插件贡献 |
| UI | 提供页面、面板、设置和渲染贡献 | Desktop Contribution Host | 未实现插件贡献 |
| Binaries | 提供受管理的命令入口 | Binary Resolver | 未实现 |

“OpenHarness 自身已有某个系统”不等于“插件已经能贡献该能力”。只有完成 schema、静态校验、Loader、激活、卸载、诊断和测试闭环，才能把对应 Component 标记为已实现。

尚未支持的 Component 可以被 schema 识别，但加载时必须返回明确的 `unsupported` 诊断，不能静默忽略。

## 7. Converter 的最终形态

每种外部格式由独立 Converter 负责：

```text
packages/plugin-converters/
├─ src/core/
│  ├─ converter.ts
│  ├─ registry.ts
│  ├─ plan.ts
│  ├─ report.ts
│  └─ reconversion.ts
├─ src/claude-code/
└─ src/codex/
```

固定流程为：

```text
detect → inspect → plan → approve → convert → Native validate
```

- `detect`：根据只读证据判断来源格式；有歧义时要求用户指定 `--from`。
- `inspect`：读取 manifest、组件、资源、依赖和路径引用，不生成文件。
- `plan`：列出每一项如何转换、需要什么权限、会损失什么能力。
- `approve`：由用户确认新增权限和有损转换项。
- `convert`：生成干净的 Native Plugin 目录与审计报告。
- `validate`：使用统一 Native Validator 检查结果；Converter 不能自己宣布产物可安装。

每个转换项只能属于以下状态之一：

- `exact`：目标行为与源行为等价；
- `adapted`：可以运行，但语义或交互方式发生了明确变化；
- `unsupported`：Native Runtime 暂无等价能力，不进入可执行 manifest；
- `blocked`：理论上可转换，但需要额外权限或用户决定。

Converter 的职责在生成 Native Plugin 时结束。它不负责：

- 写 `installed.json`；
- 决定插件是否启用；
- 管理 cache；
- 启动 Tool、Hook、MCP 或 LSP；
- 执行 `npm install`；
- 从 GitHub 下载源码；
- 在 Runtime 中提供来源格式兼容层。

第三方 Converter 不能按普通 Native Plugin 的权限直接在 daemon 主进程加载。未来开放时，需要独立的签名、隔离进程、版本兼容检查和管理员级授权。

## 8. 下载、转换、依赖和安装必须分层

最终安装入口可以接受多种来源：

```text
local directory
local link
git URL + revision
npm package + version
archive file / URL + checksum
marketplace entry + resolved version
```

但内部必须拆成 4 层：

```text
Source Resolver
  ↓ 取得只读 source，并记录来源、revision、checksum
Format Detector / Converter
  ↓ 生成 Native Plugin candidate
Dependency Preparer
  ↓ 按批准后的声明准备依赖，不修改源目录
Native Installer
  ↓ 校验、授权、快照、写 store
```

### Source Resolver

Source Resolver 负责下载、解压、固定版本和校验摘要。压缩包必须防止路径穿越、绝对路径写入、符号链接逃逸和解压炸弹。Git 安装应固定到 commit；npm 安装应固定到解析后的版本和包完整性摘要。

### Dependency Preparer

自动依赖安装属于独立高风险阶段，不能藏在 Converter 或 Native Tool 首次启动里。它必须：

- 在安装前展示依赖、来源和安装脚本；
- 默认禁止 npm lifecycle script，除非有更强隔离和明确批准；
- 使用插件专属目录，不污染 OpenHarness 自身依赖；
- 保存 lock、解析版本和完整性摘要；
- 支持失败回滚、卸载清理和离线复用；
- 将网络、进程和文件写入纳入权限审批与审计。

### Native Installer

Installer 不关心输入来自本地、Git、npm、archive、Marketplace、Claude Code 或 Codex。它只接收已经准备好的 Native Plugin candidate。

## 9. 安装范围与本地状态

普通 Native Plugin 采用用户级安装。一个插件 ID 在当前用户下只有一条可变安装记录。项目目录只影响 Runtime 执行时的 `cwd`，不会生成另一份安装或另一套权限批准。

目标目录：

```text
~/.openharness-ts/plugins/
├─ installed.json
├─ cache/
│  └─ <plugin-id>/
│     ├─ <version>-<digest>/
│     └─ <older-version>-<older-digest>/
├─ data/
│  └─ <plugin-id>/
└─ sources/
   └─ <plugin-id>/source.json
```

各目录职责：

- `installed.json`：当前版本、快照路径、启停状态、来源摘要和权限批准；
- `cache/`：经过校验的不可变 Native Plugin 快照；
- `data/`：插件跨版本持久数据，普通卸载默认保留；
- `sources/`：Git/npm/Marketplace 等刷新与重新转换所需的来源信息，不参与 Runtime 加载。

缓存使用 `<version>-<digest>` 不可变快照，而不是覆盖 `current/`。原因是旧 Runtime 可能仍在执行；安装新版本时不能让旧 Runtime 读到一半新、一半旧的文件。

安装切换流程：

```text
校验 candidate
→ 计算 behavior digest
→ 复制到临时目录
→ 再次计算摘要并校验副本
→ 原子改名为 <version>-<digest>
→ 原子更新 installed.json 指向新快照
→ 标记 Runtime reload-required
```

旧快照不能在仍有 Runtime 引用时删除。后续垃圾回收应基于安装记录和活动 Runtime 引用，而不是安装完成后立即清空历史目录。

项目如果需要某个插件，只声明稳定插件 ID 和可接受版本范围。缺少时提示用户安装，不能因为打开仓库就静默下载、转换、授权或执行插件。

组织托管插件使用 `managed` 状态，普通用户不能在 UI 或 CLI 中禁用、替换和卸载。它的分发与策略来源应独立于普通用户安装流程。

## 10. Runtime 激活流程

每次创建或重新加载 Agent Runtime 时：

```text
读取 installed.json
→ 过滤已启用的 user / managed 记录
→ verifyInstalledNativePlugin
→ 校验快照根不是符号链接或目录联接
→ 核对 manifest ID、version、权限和 behavior digest
→ loadNativePlugin
→ 分组件注册到对应 Registry / Runtime
→ 返回 activation status 与结构化 diagnostics
```

发现以下任一情况时必须拒绝激活：

- cache 不存在或损坏；
- 实际 manifest ID 与安装记录不一致；
- 实际版本与安装记录不一致；
- 插件新增了未批准权限；
- behavior digest 不一致；
- 组件路径越过插件根目录；
- 非 link 快照根是符号链接或 Windows 目录联接；
- Native Tool 运行环境不满足要求。

插件损坏不能让整个插件从管理页面静默消失。管理接口仍需返回 identity、安装状态和诊断，让用户可以修复或卸载。

## 11. Native Tool Runtime

第三方 Node Tool 不得在 daemon 主进程中动态 import。一个插件快照对应一个独立 Tool Host 子进程。

调用流程：

```text
Agent 调用 Tool
→ 检查插件与权限状态
→ JSON Schema 参数校验
→ 并发限制
→ IPC 发送到 Tool Host
→ 超时 / 取消控制
→ 限制 stdout / stderr / IPC / 插件日志大小
→ 返回标准 ToolResult
→ 写入审计事件
```

审计事件至少包含：

- 插件 ID；
- Tool 名；
- `cwd`；
- Session ID（存在时）；
- 参数结构摘要，不记录敏感正文；
- 耗时；
- 完成或失败状态；
- 结构化错误码。

当前子进程可以隔离崩溃和环境变量，但不是操作系统级沙箱。最终要执行不可信 Node 代码，仍需增加受限用户、容器、系统调用策略或所有敏感能力都走宿主代理。manifest 权限不能被描述成完整的系统调用拦截。

Native Tool 在 WSL、远程主机或其他执行环境中必须显式声明可用性。不能把 Windows 本地路径直接传给另一执行环境中的插件代码。

## 12. Desktop、CLI 与 Server 的最终管理面

3 个入口必须操作同一个 Plugin Service，不重复实现安装规则。

### Desktop

最终插件页面应包含：

- 已安装插件列表；
- 搜索、过滤和来源展示；
- 组件、权限、转换报告和 Runtime 状态详情；
- 启用、禁用、重载和卸载；
- 从本地目录、Git、npm 和 archive 安装；
- Claude Code / Codex 转换预览；
- 权限和有损转换确认；
- 安装进度与失败修复建议；
- Marketplace 浏览与安装；
- managed plugin 的只读状态。

当前 Desktop 已完成列表、搜索、详情、启停、卸载、刷新，以及 Skills/MCP 管理页面。插件页可从右上角“添加”菜单导入本地 Native Plugin 包，或打开 Git URL/ref 弹窗从 Git 安装。本地包支持 `.zip`、`.tar`、`.tar.gz` 和 `.tgz`；Git 来源固定到实际 commit 后进入同一安装链路。无权限时直接安装，有权限时只显示一次确认。插件列表和详情会显示 Plugin Service 计算出的 Runtime 主状态：已禁用、等待下次对话生效、已加载、部分能力不可用或加载失败。旧“插件配置”和静态模板已从实际页面隐藏，localStorage 原数据仍保留，未迁移或删除。

### CLI

最终 CLI 建议保留以下稳定命令：

```text
ohs plugin list [--verbose] [--json]
ohs plugin details <id>
ohs plugin validate <path>
ohs plugin install <source> [--from <format>]
ohs plugin link <native-directory>
ohs plugin convert <source> --from <format> --output <directory>
ohs plugin enable <id>
ohs plugin disable <id>
ohs plugin reload
ohs plugin uninstall <id>
ohs plugin repair <id>
```

默认文本输出和 `--json` 必须由同一份结构化结果生成，不能依赖解析 stderr。

### Server

Server 的 Plugin Service 是管理规则的唯一应用层入口，负责：

- 串行化影响插件状态的写操作；
- 调用 Source Resolver、Converter、Dependency Preparer 和 Installer；
- 返回统一 PluginInfo 和 diagnostics；
- 在变更后使相关 Runtime 失效或标记重载；
- 保证 Desktop 与 CLI 看见相同状态。

## 13. Marketplace 的定位

Marketplace 是“插件发现和来源解析层”，不是另一套插件格式，也不是 Runtime 的一部分。

Marketplace 条目至少包含：

- 稳定条目 ID；
- 显示名称、说明、图标和分类；
- 发布者和验证状态；
- 当前版本与历史版本；
- 对应 Native schema 版本；
- 来源类型与固定引用；
- archive checksum 或 npm integrity；
- 权限摘要；
- 组件摘要；
- 支持的平台与运行环境；
- 若为外部格式，所需 Converter ID 与版本范围。

点击“安装”后，Marketplace 只把解析后的来源交给统一安装流程。Marketplace 不能直接把文件写入 cache，也不能绕过权限确认。

## 14. 更新、重新转换、卸载与修复

### 更新

更新不是覆盖目录，而是创建新快照并切换安装记录：

```text
resolve new source
→ inspect / plan（外部格式）
→ 对比权限和转换损失
→ 用户确认新增内容
→ prepare candidate
→ Native validate
→ immutable snapshot
→ switch installed record
→ reload Runtime
```

### 重新转换

以下变化要求重新转换：

- 源内容或 revision 改变；
- Converter 版本改变且会影响输出；
- Native schema 目标版本改变；
- conversion options 改变；
- mapping semantic version 改变；
- OpenHarness 新增了之前 unsupported 的组件。

### 卸载

普通卸载删除安装记录并停止后续 Runtime 激活，默认保留 `data/<plugin-id>/`。删除插件数据必须是另一个明确操作。

### 修复

`repair` 应根据已记录来源重新取得候选内容并重建快照。无法重新取得来源时，提示用户重新选择本地目录或重新登录来源，不应尝试信任损坏 cache 中的文件。

## 15. 包与职责边界

| 模块 | 负责 | 不负责 |
|---|---|---|
| `@openharness/plugins` | Native schema、路径校验、组件加载、安装记录、快照校验 | Claude/Codex 解析、网络下载、Marketplace UI |
| `@openharness/plugin-converters` | detect、inspect、plan、convert、report | 安装、运行、依赖安装、远程下载 |
| Source Resolver | Git/npm/archive/Marketplace 来源解析与完整性校验 | 组件转换、Runtime 激活 |
| Dependency Preparer | 准备经过批准的插件依赖 | 猜测依赖、执行未批准脚本 |
| `@openharness/agent-runtime` | 发现已安装插件并激活组件 | 安装插件、解析外部 manifest |
| Server Plugin Service | 管理用例、状态变更、Runtime 失效 | 自己实现另一套 Validator |
| Desktop / CLI | 用户交互和结果展示 | 直接写 cache 或 `installed.json` |
| Marketplace | 发现、版本和可信来源 metadata | 定义新的运行格式、绕过 Installer |

禁止形成以下依赖：

```text
agent-runtime → claude-code converter
packages/plugins → Claude / Codex parser
Desktop → 直接修改 installed.json
Marketplace → 直接写 plugin cache
Native Plugin → 在 daemon 主进程注册 Converter
```

## 16. 当前实现与剩余工作

截至 2026-09-09：

### 已完成

- Native Plugin v1 manifest、路径校验和结构化诊断；
- 用户级安装记录和不可变 `<version>-<digest>` 快照；
- Runtime 激活前统一验证实际快照；
- Skills、Agents、Hooks、MCP 和 Node Tool 加载；
- Node Tool 独立子进程、参数校验、审计、超时、取消、并发和输出限制；
- Converter core；
- Claude Code Converter；
- Codex Converter 首版：legacy/portable 格式识别、Skills、保守 MCP 映射、有损批准和 CLI 导入；
- 转换后的扁平 Native Plugin 目录；
- CLI 的本地 Native 安装、link、转换、启停、详情和卸载；
- 原生插件开发期 SDK 类型、五类组件开发指南和零运行依赖的文本检查参考插件；
- 参考插件的实际 checkJs、独立进程调用、正式安装、link 重载、主动取消及跨 cwd 停用/卸载验收；
- `/reload-plugins` 展示校验诊断和重新登记/批准提示，明确下次使用时才加载；
- Desktop 扩展管理页面主体；
- Desktop 插件页本地 Native 插件包导入、后台安全校验、权限确认与结果反馈；支持 `.zip`、`.tar`、`.tar.gz` 和 `.tgz`，重新导入同一 ID 可完成手动更新或修复，且只在新增权限时重新确认；
- 本地 Archive Resolver：路径、类型、大小、数量、压缩比、CRC、摘要和临时目录清理；
- 真实 Claude Code 插件抽样回归。

### 部分完成

- Converter Registry：内部注册接口已存在，但第三方 Converter 发现和隔离加载未实现；
- Native Tool：Node 已实现，Wasm 和操作系统级沙箱未实现；
- managed plugin：状态边界已存在，完整组织分发链路未实现。

### 未实现

- Codex Apps、Hooks、技能专用策略和复杂 MCP 配置转换（首版明确报告 unsupported）；
- Output Styles、Themes、Monitors 插件贡献；
- Workflows、Channels、Providers、UI 插件贡献；
- Git、npm 和 archive URL Source Resolver；
- Marketplace；
- 自动依赖安装；
- 第三方 Converter 的签名、隔离和注册；
- 插件自动更新、来源刷新、独立修复命令、版本回滚和安全垃圾回收完整流程；
- Wasm Tool Runtime。

### 暂缓

- Native LSP。等 OpenHarness 的 LSP 工具与 Runtime 契约稳定后再设计插件贡献，不提前写兼容层。

## 17. 建议实施顺序

2026-09-09 Desktop 本地 ZIP 阶段已完成：插件页可导入一个本地 Native `.zip`，交互只呈现成功、失败、结果待确认或一次权限确认；Archive Resolver、Native 校验、摘要复核和临时清理由后台完成。Agent 对话安装、转换插件和远程来源后续再规划。详见 [ZIP 导入设计](./superpowers/specs/2026-09-09-desktop-native-plugin-zip-import-design.md)和[实施计划](./superpowers/plans/2026-09-09-desktop-native-plugin-zip-import.md)。

2026-09-14 本地插件包格式补齐 v1 已完成：Desktop 仍只有一个“导入本地插件包”入口，交互不增加复杂度；后台 Source Resolver 在原 ZIP 校验基础上补齐 `.tar`、`.tar.gz` 和 `.tgz`，TAR 解析交给成熟的 `tar` 包，外层继续做路径、类型、大小、数量、压缩比、摘要和临时目录清理校验。Agent 对话安装、Git、npm、归档 URL、Marketplace 和自动更新继续暂缓。

2026-09-14 Git Source Resolver v1 已完成实现，等待最终验收：Git 来源使用系统 `git` 作为成熟工具，不自研 Git 协议；预览和安装都固定到实际 commit，安装前移除 `.git` 元数据，并复用现有 Native 校验、权限确认和不可变快照。Desktop 入口放在右上角“添加”菜单下，通过一个 Git URL/ref 弹窗完成安装，不在插件页主体常驻表单。该阶段只做 Desktop Git URL 安装，不包含自动更新、npm、archive URL、Marketplace 或自动依赖安装。

2026-09-10 补充最小重新安装语义：用户重新导入同一插件 ID 的可信 ZIP，即可手动更新或修复。Server 复用能够覆盖本次请求的既有权限批准，新增权限仍请求一次完整确认；Installer 只在新快照成功后切换记录，并保留原启停状态。自动更新、Repair 命令、版本回滚和垃圾回收仍不在近期范围。详见[核心设计](./superpowers/specs/2026-09-10-native-plugin-reinstall-core-design.md)和[实施计划](./superpowers/plans/2026-09-10-native-plugin-reinstall-core.md)。

2026-09-14 Native Plugin 运行诊断 v1 已完成：`PluginInfo.runtimeStatus` 返回 `disabled`、`pending_reload`、`loaded`、`degraded` 和 `failed`，Plugin Service 根据安装校验、组件诊断和 Native Tool Runtime 状态计算，Desktop 插件页展示主状态和一条建议动作。该阶段不包含自动修复、自动更新、新来源或复杂诊断树。Agent 对话内安装、`output_styles`、自动更新、Marketplace 和远程来源继续暂缓。

2026-09-14 Native Plugin 作者体验小修已完成：开发指南和文本检查参考插件补齐 Desktop 本地插件包打包、重新导入验证、运行状态查看和常见失败排查。该阶段没有新增安装来源、命令、Runtime 能力或 UI 复杂度，只把现有 Native 本地导入和 `runtimeStatus` 诊断串成作者可照做的闭环。

2026-09-14 Plugin Agent 可用性收口已完成：核心加载、能力选择和 Child 边界已有测试覆盖，本阶段补了文本检查参考插件的最小 Agent 示例和说明。作者现在能看到 `components.agents` 怎样声明、安装后名字是什么、何时可见，以及它不能越过当前 Run 的插件能力边界。

2026-09-09 调整：Converter 本轮开发到此结束。原生插件第一阶段已完成：公开开发类型、五类组件指南，以及无外部服务依赖的“文本检查助手”，覆盖安装、加载、调用、真实重载和清理。详见 [开发指南](./native-plugin-authoring.md)、[第一阶段设计](./superpowers/specs/2026-09-09-native-plugin-authoring-v1-design.md)和[实施计划](./superpowers/plans/2026-09-09-native-plugin-authoring-v1.md)。相关测试共 146 项通过，类型、缓存输入和文档检查通过，独立审查无代码阻断项。验收使用真实插件进程和管理路由，不包含完整 AgentPool、模型会话或桌面 UI。Desktop 本地 Native 插件包导入也已在本阶段完成；以下长期顺序作为后续路线参考。

后续不要一次实现所有 Component。建议顺序如下：

1. **Codex Converter**：首版已接入 Converter → Native → Installer，并增加依据真实 manifest 结构独立编写的 fixture；范围和限制见 [Codex 转换器设计](./superpowers/specs/2026-09-09-codex-plugin-converter-design.md)。
2. **Desktop 本地 Native 插件包导入**：已完成最简导入、后台校验、权限确认和结构化失败反馈；当前支持 `.zip`、`.tar`、`.tar.gz` 和 `.tgz`。Agent 对话、Claude/Codex 和远程来源仍延后。
3. **Native Plugin 运行诊断 v1**：已完成。Plugin Service 返回用户可读的运行主状态，Desktop 列表与详情页直接显示下一步建议。
4. **作者体验小修**：已完成。开发指南和参考插件 README 已补充打包、重装验证、看诊断和常见失败排查说明。
5. **声明式贡献**：`output_styles` 已决定暂缓；Themes、Monitors、Workflows 等需要重新开规格后再做。
6. **Source Resolver**：本地 archive 已完成，Git 来源已完成实现并待验收；后续再依次考虑 npm 和归档 URL。每一种都要做完整性和路径安全测试。
7. **Marketplace**：建立在 Source Resolver 和统一安装流程之上，不先做另一套假安装 UI。
8. **Channels 与 Providers**：分别设计认证、生命周期、冲突和隔离，不能复用普通 Tool 的简单注册方式。
9. **UI contributions**：最后处理，需要明确可用组件、导航、CSP、数据访问、权限和崩溃隔离。
10. **自动依赖安装**：在 Source Resolver 和隔离策略稳定后单独实施。
11. **第三方 Converter**：最后开放，使用比普通插件更高的信任等级。

LSP 不进入以上近期顺序。

## 18. 每个新 Component 的完成标准

任何新 Component 只有同时满足以下条件才算完成：

- manifest schema 有明确且严格的结构；
- Validator 检查路径、字段、权限和平台要求；
- Loader 不执行不该在加载阶段执行的代码；
- 激活器有清晰的生命周期和 cleanup；
- 名称冲突与优先级规则明确；
- 启用、禁用、重载和卸载行为明确；
- 坏组件返回结构化诊断，其他独立组件仍可工作；
- Desktop、CLI 和 Server 能展示相同状态；
- 权限不足时不执行，并给出可修复提示；
- 有成功、坏输入、缺权限、冲突、取消和清理测试；
- 转换器只能在目标 Component 真正支持后生成它；
- 文档区分“系统本身存在”和“插件可贡献”。

## 19. 不可破坏的系统约束

后续实现和评审至少要守住这些约束：

1. Runtime 只接受 `.openharness-plugin/plugin.json`。
2. 外部格式只能在安装前通过 Converter 进入。
3. Converter 不执行 Source Plugin。
4. Installer 不解析 Claude Code、Codex 或 Marketplace 私有格式。
5. 非 link 安装使用不可变内容快照。
6. Runtime 激活前重新验证实际快照，不盲信 `installed.json`。
7. 权限批准属于安装记录，不写回 manifest。
8. 项目目录不能自动把项目级授权扩大成用户级授权。
9. 第三方 Tool 不在 daemon 主进程中 import。
10. 未支持的 Component 返回 `unsupported`，不能静默忽略。
11. `.openharness-conversion/` 不参与 Runtime 行为。
12. Desktop、CLI 和 Marketplace 不直接写 cache 或安装记录。
13. 插件来源、安装、激活和连接状态分别建模。
14. 打开一个项目不能触发未经确认的下载、转换、授权或执行。

## 20. 接手开发时的阅读顺序

建议依次阅读：

1. 本文：最终形态、边界和剩余工作；
2. [Native Plugin 当前实现](./plugins-contributions-design.md)：当前已经能跑什么；
3. [用户级 Native Plugin 安装设计](./superpowers/specs/2026-09-02-user-scoped-native-plugin-installation-design.md)：不可变快照与权限边界；
4. [原生插件与外部转换器设计](./superpowers/specs/2026-08-25-native-plugin-and-converters-design.md)：完整历史设计；
5. [Claude Code 真实插件回归](./claude-real-plugin-regression.md)：真实样本和保守转换原则；
6. `packages/plugins/src/load-native-plugin.ts`：当前支持与 deferred Component；
7. `packages/plugins/src/installation/`：安装、store、cache 和激活前验证；
8. `packages/plugin-converters/src/`：Converter SPI 与 Claude Code 实现；
9. `packages/agent-runtime/src/extensions.ts`：Runtime 组合入口；
10. `packages/agent-runtime/src/native-tools/`：隔离 Tool Runtime；
11. `apps/desktop/src/renderer/src/components/desktop/plugin-page/`：Desktop 管理页面；
12. `apps/cli/src/commands/plugin.ts` 与 Server Plugin Service：管理入口。

如果旧计划与当前代码冲突，以 2026-09-02 的用户级不可变快照安全设计和当前测试为准。特别是 [2026-08-30 转换目录收口计划](./superpowers/plans/2026-08-30-native-plugin-conversion-simplification.md) 中的 `cache/<id>/current` 已被后续安全设计替代；保留该文档只是为了记录设计演进，不能再作为安装实现依据。
