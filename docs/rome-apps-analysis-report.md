# Rome Apps 详细分析报告

> 状态：历史调研快照，记录本地源码分析及当时建议。当前插件页面机制见 [MCP Apps](./mcp-apps.md)，本文不作为已批准的实现规格。
> 调研日期：2026-10-11。
> 对象：`D:/code/personal-project/rome`；Rome HEAD：`3ddf88cbb950c543822676253d650204bdbce782`。
> OHS 对照基线：`feb050a3992096e9f73b4a6dece2a59c8ad9aaf4`。

## 1. 范围与阅读方式

本报告回答三个问题：Rome Apps 实际如何工作；它的 Web UI 如何与宿主和聊天协作；哪些设计适合 OHS 当前的内联卡片与右侧 panel。

研究依据是本地工作副本中的概念文档、安装与运行代码、浏览器宿主、开发 SDK 和第一方 app。HEAD 用于标记仓库参考位置，不表示本次读取的所有工作副本内容都已逐一证明与该提交一致。没有启动 Rome、安装样本或运行其测试，也没有验证 Rome Cloud 线上服务。文中“已实现”指找到对应代码路径，不等于所有场景已经通过运行验收。

全文区分三类内容：

- **源码事实**：可以在当前读取的实现中直接定位。
- **分析判断**：从这些路径推导出的产品效果、边界或风险。
- **OHS 建议**：可供后续讨论，不能视为本次已经授权开发的功能。

常用术语：daemon 是常驻后端服务；bundle 是打包后的代码文件；widget 是嵌在工作区布局中的 app 小窗口；CSP 是浏览器限制脚本、网络和资源加载的安全规则。文中的 Hook、SDK 和 Catalog 在首次展开其职责时进一步说明。

Rome 的 `northstars` 文档描述理想状态，本报告不把其中的设想直接记为当前能力。概念文档与实现不同处，以实现说明当前行为，同时保留差异。

本报告的 Rome 源码链接使用 `../../rome/`，假设 Rome 和 OpenHarness-ts 位于同一父目录；换机器阅读时需要同时取得 Rome 仓库。

阅读导航：[核心结论](#2-核心结论) · [声明格式](#4-声明格式appyaml-定义什么) · [安装与恢复](#6-安装启用卸载与启动恢复) · [Web UI](#9-web-ui从资源清单到页面) · [聊天交互](#11-聊天内联组件完整交互链路) · [OHS 对照](#17-与-ohs-当前插件-ui-的对照) · [建议](#18-对-ohs-的建议先完善两种现有展示面)。

## 2. 核心结论

Rome Apps 不是“给一个 tool 配一段 HTML”。它把一项完整业务能力做成一个可安装单元：可以同时包含 Agent、Action、Skill、Hook、Web 页面、聊天内联组件、API 和数据库迁移，也可以只提供其中一部分。

其中，Action 是可被 Agent 或服务调用的业务操作；Hook 是在 app 启动、Agent 回合等事件发生时执行的处理器；SDK 是 app 作者调用宿主能力的开发接口。

最值得借鉴的是五点：

1. **一份业务能力，多种入口。** 同一 app 可以从应用页面、聊天卡片、工作区 widget 或 Agent 调用进入，不需要复制成几套插件。
2. **业务状态与显示位置分开。** 安装文件、业务数据、聊天结果、工作区布局分别保存，换展示位置不应等于重建业务。
3. **宿主提供上下文与公共能力。** app 作者不用自己猜主题、语言、API 地址和会话归属，也不用手写一套创建聊天的流程。
4. **内联组件可以交回结构化结果。** 卡片不是只有展示效果，用户完成选择后，结果能进入聊天并触发后续处理。
5. **视觉统一靠语义样式和作者工具。** 颜色、字体、控件尺寸、弹层位置由共享约定连接，而不是仅要求“看起来像宿主”。

但不能把 Rome 等同于安全隔离插件平台：Shadow DOM 主要隔离样式；widget 的 iframe 没有配置 sandbox；API 模块在 daemon 中导入；Action 在主进程注册时也会实例化模块。Action 正式执行使用 worker 子进程，并不代表所有 app 代码都只在隔离进程运行。

对 OHS，建议借鉴**产品组织、作者体验和状态模型**，保留我们自己的 Native Plugin 安装体系、受控工具执行、iframe 安全边界和历史实例校验。当前不需要为了借鉴 Rome 同时建设 Marketplace、独立 app API 或完整数据库平台。

主要依据：[Apps 概念](../../rome/docs/concepts/apps.md)、[App 生命周期](../../rome/docs/architecture/app-lifecycle.md)、[manifest 实现](../../rome/packages/core/src/apps/packaging/manifest.ts)、[Web 宿主](../../rome/packages/web/src/components/rome-app-host.tsx)。

## 3. 代码组成与职责

| 模块 | 主要职责 | 不应误解为 |
| --- | --- | --- |
| [Core Apps](../../rome/packages/core/src/apps/) | 读取声明、准备安装文件、保存安装记录、提供当前可用 app、加载 API 和数据迁移 | 一个单纯的前端插件注册表 |
| [Core Actions](../../rome/packages/core/src/actions/) | 加载业务操作、校验与审批、执行、记录运行信息、调度 worker | 任意 app 代码的统一安全沙箱 |
| [Web](../../rome/packages/web/src/) | 页面路由、聊天记录、卡片宿主、工作区 widget、app 管理 | app 自己的前端源码 |
| [App Runtime SDK](../../rome/packages/app-runtime-sdk/src/index.ts) | 服务端 app 类型、Action 结果类型、宿主上下文接口 | 浏览器全权限桥接 |
| [App Web SDK](../../rome/packages/app-web-sdk/src/runtime/index.ts) | 页面启动上下文、API 请求、内联组件、导航、创建聊天 | 一个仅封装 React 控件的库 |
| [App Web CLI](../../rome/packages/app-web-sdk/src/cli/) | 构建入口、生成 Web 资源清单、开发与发布工具 | daemon 内的运行解释器 |
| [UI Kit](../../rome/packages/ui/) | 与宿主共享的控件、样式、排版和弹层约定 | app 使用能力的强制前提 |
| [App Template](../../rome/packages/app-template/) | 作者开发起点与包工具配置 | 独立的 app 运行机制 |
| [Rome Apps](../../rome/rome_apps/) | 第一方 app，使用同一声明和运行模型 | 仅靠硬编码页面实现的系统菜单 |

整体链路可以简化为：

```text
作者源码 / 已打包产物 / App Store 版本
                  │
                  ▼
         AppManager：决定安装与启用状态
                  │
                  ▼
         AppInstaller：准备文件、切换 active
                  │
                  ▼
         AppCatalog：给出当前可运行的 app
                  │
       ┌──────────┼───────────┐
       ▼          ▼           ▼
  Agent/Action  API/数据库   Web 资源与组件
       │          │           │
       └──────────┴───────────┘
                  ▼
         页面、工作区、聊天与业务结果
```

这里的 Catalog 是当前可用 app 的统一读取入口。安装记录不直接等于“可以调用”：安装中、已禁用、损坏或解析失败的 app 不会拥有相同的运行能力。

## 4. 声明格式：app.yaml 定义什么

### 4.1 身份与组件清单

Rome 使用 `app.yaml` 描述 app。当前 schema 支持 `formatVersion: 1` 和 `2`，未知字段会被严格拒绝。

| 声明 | 内容与作用 |
| --- | --- |
| `id` | 安装记录键与能力命名空间；支持小写 slug 或 `@handle/slug` |
| `version` | 作者声明的语义版本；不是安装内容指纹 |
| `name`、`description`、`icon`、`tagline` | 展示信息；图标相对解析根目录读取 |
| `appRoot` | 将运行内容的相对解析根目录切到例如 `dist` |
| `agents`、`actions`、`skills`、`hooks` | 显式列出需要加载的组件路径 |
| `components` | 允许出现在聊天里的内联组件 ID 列表 |
| `web` | 指向构建后的 Web 资源清单，并提供显示名等信息 |
| `api` | app API 入口、匿名访问声明、Webhook relay 配置 |
| `db` | 迁移目录和可选表名前缀 |
| `includeSource`、`remix` | 源码是否随包提供，以及复制改造的来源信息 |
| `suggestedChannelBindings` | 建议绑定到某个渠道的 Agent，不是安装即自动授予权限 |

明确声明组件有两个效果：未声明的目录不自动成为能力；卸载或禁用时可以按 app 归属清理注册项。

v2 的公开能力引用采用 `<app-id>:<local-name>`，避免不同 app 用同一个短名字发生冲突。v1 仍有旧名字与别名处理。这里是 Rome 自己的格式版本，不是对 Claude Code 或 Codex 格式的直接兼容。

`components` 当前主要校验“这个 ID 是否声明过”，并没有在 app manifest 中给每个组件定义完整的 props、返回结果和操作参数 schema。组件自身的业务校验不能因此省略。

依据：[manifest schema](../../rome/packages/core/src/apps/packaging/manifest.ts)、[组件配置](../../rome/packages/core/src/apps/packaging/artifact-config.ts)、[产物命名](../../rome/packages/core/src/apps/packaging/artifact-name.ts)。

### 4.2 源码、构建结果、安装结果不是同一个目录

下面是综合源码和模板的示意，不代表每个 app 都需要所有目录：

```text
my-app/                       作者工作区
├─ app.yaml
├─ package.json
├─ src/
│  ├─ web/                    页面与内联组件
│  ├─ api/                    API 处理代码
│  ├─ actions/                业务操作
│  ├─ agents/
│  ├─ skills/
│  ├─ hooks/
│  └─ db/migrations/
├─ dist/                      appRoot 对应的构建结果
│  ├─ web/manifest.json
│  ├─ web/…js、…css
│  ├─ api/
│  ├─ actions/
│  └─ 其他声明的运行内容
└─ .rome/artifact/             本地打包输出
   ├─ .rome-artifact.json      明确标识“这是安装产物”
   └─ 经过筛选的声明与运行文件
```

Core 的一般 manifest 允许不写 `appRoot`；Web CLI 的常规构建流程要求它，并要求可用的 Web 入口。不能据此推断“所有 Rome app 都必须有网页”。

已打包产物不靠“没有 src”来识别，而是有专门标记。普通源码工作区需要先构建、再打包，安装器消费的是产物。

打包会排除依赖目录、开发临时目录和一些凭据文件，是否带源码另由 `includeSource` 决定。这是防误带文件措施，不应作为“自动扫描出了所有秘密”的承诺。数据库业务数据不属于安装包。

依据：[产物设计](../../rome/docs/architecture/app-artifact.md)、[Pack](../../rome/packages/core/src/apps/packaging/pack.ts)、[产物识别](../../rome/packages/core/src/apps/packaging/recognition.ts)、[Web 构建配置](../../rome/packages/app-web-sdk/src/cli/createRslibConfig.ts)。

## 5. 构建与资源身份

### 5.1 Web 构建协议

App Web CLI 为用户入口生成一层包装代码。用户代码注册页面和内联组件，包装层负责提供宿主期望的函数：

- `mount(container, bootstrap)`：把 app 页面挂到宿主给的容器。
- `unmount()`：清理页面 React root。
- `mountComponent(container, componentId, context)`：渲染指定内联组件。
- `unmountComponent(container)`：执行该组件的清理函数。

构建会把 app 的前端依赖打进浏览器 bundle。React 与 ReactDOM 使用构建工具选择的匹配版本，不要求共享宿主正在运行的那一份 React。

生成的 Web manifest 记录 `entry`、`styles`、`assetVersion`、显示信息等。CLI 还写入 `routing: "client"`；当前安装器读取 schema 中并没有把这个字段作为完整路由能力约束，因此它不是“宿主已经实现所有 app 路由规则”的证据。

依据：[入口生成](../../rome/packages/app-web-sdk/src/cli/generateEntry.ts)、[Rslib 配置](../../rome/packages/app-web-sdk/src/cli/createRslibConfig.ts)、[manifest 生成](../../rome/packages/app-web-sdk/src/cli/manifestPlugin.ts)、[安装器](../../rome/packages/core/src/apps/installer.ts)。

### 5.2 三种版本不能混用

| 值 | 对应什么 | 用途 |
| --- | --- | --- |
| `version` | app 作者写的语义版本 | 展示、发布与版本选择 |
| `installedHash` / Store `contentHash` | 被安装产物的内容身份 | 安装记录、校验、缓存和 active 指向 |
| Web `assetVersion` | 按已输出的 Web 资源名与字节计算的 12 位十六进制指纹 | 浏览器资源 URL 与缓存区分 |

本地产物 hash 与 Store 下载包 hash 的计算对象不完全相同；不要把它们当成任意环境下同一目录的相同校验值。Web 指纹更不是整个后端包的版本。

安装后的生产依赖还需要由包管理器求解。若 app 没有锁定依赖，不能因为产物 hash 固定，就认为所有机器安装出的整个 `node_modules` 完全相同。

## 6. 安装、启用、卸载与启动恢复

### 6.1 状态分别保存在哪里

```text
~/.rome/<profile>/
├─ apps.lock.json                         安装来源、启用开关、状态和内容身份
└─ apps/
   ├─ installed/<encoded-app-id>/
   │  ├─ <hash>/                         某份已准备好的安装内容
   │  └─ active -> <hash>                当前安装内容入口
   ├─ data/<encoded-app-id>/              app 独立文件数据目录
   └─ runtime-status.json                运行状态记录
```

这里的 `~/.rome` 是通常的配置位置示意，实际由 profile 路径函数决定。带 `/` 的 scoped app ID 经过目录名编码。共享数据库另由 Core 配置，不是每个 app 自动得到一个独立 SQLite 文件。

运行时组件由 AppCatalog 汇总。业务数据库、文件数据、聊天记录、工作区布局与安装清单不是同一份状态。

依据：[路径函数](../../rome/packages/core/src/paths.ts)、[Lockfile](../../rome/packages/core/src/apps/lockfile.ts)、[Catalog](../../rome/packages/core/src/apps/catalog.ts)。

### 6.2 一次安装的实际顺序

1. 从本地 manifest 或 Store listing 确定 app ID，不允许请求方随意指定一个不同 ID。
2. 按 app ID 串行处理，检查系统 app 和第一方 app 的保护规则。
3. 若输入是源码，先用其工具链构建，再打包；这一阶段旧 app 保持原状态。
4. 设置正在安装状态，并刷新 Catalog；旧 app 在安装转换期间不再保持相同的可解析运行视图。
5. 在临时目录复制或解包，安装生产依赖，校验产物，再完成目录落位与 active 切换。
6. 写入安装记录，保存新 hash、版本和启用状态。
7. 清理旧安装缓存；当前 active hash 被保护，旧快照保留策略有限，不是无限版本仓库。
8. 清除操作中的临时状态，刷新 Catalog，等待订阅者的重载处理，再返回安装结果。

本地源码来源被保存在安装记录中，下一次重新安装会重新构建。相同产物可以命中准备缓存。App Store 来源会固定解析出的内容 hash，避免每次都靠模糊来源重新决定内容。

Catalog 按顺序通知 Agent、Action、Skill、迁移、运行状态等订阅者。但订阅者发生异常时可能记录失败并继续，所以**安装请求返回成功，不等于所有能力都已健康加载**。需要结合运行诊断。

依据：[Manager](../../rome/packages/core/src/apps/manager.ts)、[Installer](../../rome/packages/core/src/apps/installer.ts)、[Prepare](../../rome/packages/core/src/apps/prepare.ts)、[Catalog](../../rome/packages/core/src/apps/catalog.ts)、[启动装配](../../rome/packages/core/src/index.ts)。

### 6.3 自动依赖安装的边界

源码构建可能执行 app 的安装与构建脚本。准备安装产物时，当前生产依赖安装参数包含：

```text
pnpm install --prod --no-frozen-lockfile --config.minimum-release-age=0
```

产物没有自己的 `pnpm-workspace.yaml` 时，还会使用 `--ignore-workspace` 和 `--config.strict-dep-builds=false`。带 workspace 配置的产物可以保留其 `allowBuilds` 决策。这里并没有全局强制 `--ignore-scripts`。

因此，自动安装不仅是复制文件，还涉及网络、依赖求解和可能的构建脚本执行。在源码开发环境中还存在将服务端 SDK 链接到宿主工作区的逻辑。不能把这一套直接当成 OHS 无需授权的依赖安装规则。

### 6.4 失败与损坏：必须按阶段区分

| 场景 | 当前读取到的行为 | 对使用者的含义 |
| --- | --- | --- |
| 来源无效、保护检查拒绝 | 在进入安装转换前失败 | 不应产生正常安装记录变更 |
| 源码构建或打包失败 | 不写新安装状态，不触发安装期 Catalog 切换 | 已运行旧 app 继续存在 |
| 来源身份不一致 | 特殊拒绝路径，不把不一致 ID 写成 failed 安装项 | 需要修正来源后重试 |
| 进入安装阶段后一般失败 | 安装项改为 `failed`，保留先前 hash、版本等字段 | 保留旧字节不等于旧 app 继续可调用 |
| 启动时 active 丢失或安装内容无效 | 检测并标记损坏；普通 app 与系统 app 的处理强度不同 | 需要修复或重装，而不是显示为健康 |
| 某个运行组件加载失败 | 通过失败跟踪与运行状态暴露 | 可以出现安装存在但功能不完整 |

需要特别注意一处差异：[Apps 概念文档](../../rome/docs/concepts/apps.md)对安装失败保留先前状态有较强表述；但 [Manager 的异常分支](../../rome/packages/core/src/apps/manager.ts)在安装阶段一般失败时写入 `state: "failed"`，而 [Catalog](../../rome/packages/core/src/apps/catalog.ts)仅对满足 installed、enabled 条件的记录提供完整运行解析。

因此，本报告不把“失败升级总能继续使用旧 app”作为 Rome 当前已经兑现的保证。构建失败、安装失败和重载失败是不同情况。active 切换、lockfile 写入、数据库迁移也不能笼统视为一个覆盖所有步骤的原子事务。

### 6.5 启用、禁用与第一方 app

禁用 app 后可以保留名称、图标等被动展示信息，但不完整解析和加载运行组件。启用时重新进入当前可用 app 集合。卸载会清理安装归属，并不默认清除业务数据。

第一方 app 使用相同包装与加载机制，同时有持久的 `firstParty` 标记。用户不能通过复用 ID 的包替换它们，也不能正常卸载；系统 app 还有不能禁用等更强保护。第一方 app 的代码更新由启动阶段与发行包收敛。

启动恢复会处理临时目录、探测安装入口并重新建立运行视图。整个安装清单无法解析时，与单条记录异常时的处理不同：前者可能阻止启动，后者可以隔离成坏记录。不要把所有配置损坏都说成“自动修好了”。

### 6.6 管理 UI：使用入口和管理入口分开

Apps 首页采用图标与名称的启动器布局，按来源区分自己创建的 app、Store 安装项和内置入口，并提供实时搜索。这里的内置入口分组还包含宿主自带页面，不应把启动器中的每一项都算成一个动态 app 包。

点击 app 优先打开其可用前端；某些后端 app 有宿主提供的固定页面；都没有时打开详情。这样用户不用先看一堆能力计数和安装字段，才能开始使用。

详情页承担管理职责：状态与错误、版本和来源信息、能力明细、启用开关、访问设置、更新、发布、复制改造、卸载。普通卸载与带数据清理的卸载明确分开。可用操作由服务端返回的能力字段控制，不是所有卡片永远显示全部按钮。

图标网格、嵌入页面菜单和详情页复用操作定义与生命周期处理：

- 菜单条目根据是否有前端、能否修改、能否发布、是否有更新等条件生成。
- 修改时控制 busy 状态，完成后重新读取服务端事实，不靠前端猜测安装结果。
- 一次请求失败用 toast 提示；持续存在的 app 错误由详情页展示。
- 公开访问设置区分私人、公开和受邮箱控制等模式。这是部署访问规则，不是 app 的文件或网络权限清单。

对 OHS，最值得参考的是“列表用于找到和使用，详情用于理解和管理”以及多入口复用操作逻辑。是否采用图标网格取决于插件数量和是否多数具有独立页面，不必照搬；没有 Marketplace 也能保持这个分工。

依据：[Apps 首页](../../rome/packages/web/src/pages/AppsIndexPage.tsx)、[详情页](../../rome/packages/web/src/pages/AppDetailPage.tsx)、[共享菜单](../../rome/packages/web/src/components/app-action-menu.tsx)、[生命周期处理](../../rome/packages/web/src/hooks/use-app-lifecycle.tsx)。

### 6.7 安装状态、操作状态与运行诊断

Rome 至少有三类状态，不能只显示一个“已安装”标签：

| 状态层 | 代表什么 | 当前例子 |
| --- | --- | --- |
| 持久安装状态 | 安装记录是否成功或损坏 | installed、failed、broken |
| 临时操作阶段 | 此刻正在进行什么 | installing、uninstalling，保存在运行时 overlay |
| 运行诊断 | 是否禁用、是否有加载错误 | active、disabled、failed，并合并组件错误 |

运行失败跟踪按 app 与错误来源归集，避免 Action、Hook 等加载失败被安装成功掩盖。但 runtime status 的词汇较粗，一处组件失败可以把整体映射为 failed；用户仍需查看具体错误判断哪些能力可用。操作阶段也不能从 active 一词反推。

依据：[状态类型](../../rome/packages/core/src/apps/state.ts)、[运行状态订阅者](../../rome/packages/core/src/apps/runtime-status-subscriber.ts)、[详情页](../../rome/packages/web/src/pages/AppDetailPage.tsx)。

## 7. 服务端能力与执行边界

### 7.1 Agent、Skill、Action、Hook 如何进入宿主

声明路径经过解析后进入各自的 loader 和注册表。公开能力名字带 app 归属，重载时可以卸载原归属并注册新内容。

Action 配置包含名称、描述、入口、可见性、复杂度与速度提示、是否写数据、是否审批、是否可取消等。输入 schema 由业务模块提供，不是“在 action YAML 中写任意字段就自动生效”。显式可见的 Action 也不等于在所有 Agent 的默认工具集合中出现。

SDK 推荐的 `defineAction` 用同一份 Zod schema 生成给模型看的参数定义，并在 execute / preview 入口执行实际校验。它明确说明上游参数未经统一验证，因此作者直接构造 Action 对象时，不能只声明 inputSchema 却不落实运行时校验。

ActionEngine 统一处理 Action 执行及其审批、运行记录等流程。`sideEffects: read-only` 是声明的业务性质，不等于操作系统禁止模块写文件或联网。

服务端 SDK 的 Action 结果还区分以下情况：

| 结果 | 表示什么 | 不代表什么 |
| --- | --- | --- |
| `ok` / `error` | 业务操作完成或被拒绝 | UI 已自动渲染全部结果，或所有基础设施异常都变成 error |
| `pending_approval` | 需要审批处理 | 已经执行成功，再补一次确认 |
| `pending_interaction` | 请求用户完成一次交互 | 旧 Action 进程长期停在按钮前 |
| `handoff` | 将特定工作交给子会话，后续交回结果 | 普通卡片只是放大到侧栏 |
| `place_widget` | 请求在工作区放置 app 页面 | 必须暂停 Agent 等待一次用户提交 |

审批是在操作权限上的确认；交互是收集业务结果。把两者分开，可以避免“用户点过卡片，所以后续所有写操作已获批准”的错误理解。

处理器抛出异常、序列化失败或 worker 崩溃走基础设施错误路径，不是业务 `error` 结果。调用者应区分“业务不允许这样做”和“这次执行无法完成”。

依据：[Action 概念](../../rome/docs/concepts/actions.md)、[服务端 SDK](../../rome/packages/app-runtime-sdk/src/index.ts)、[配置 schema](../../rome/packages/core/src/apps/packaging/artifact-config.ts)、[Loader](../../rome/packages/core/src/actions/loader.ts)、[注册](../../rome/packages/core/src/actions/app-actions-wiring.ts)、[Engine](../../rome/packages/core/src/actions/engine.ts)。

### 7.2 子进程执行不等于全包隔离

当前 main 角色的根 Action 调用由 worker 子进程执行。嵌套调用根据是否可取消等条件，在当前执行进程中运行或交给子进程路径。worker 有容量控制和预热管理，app 变更会触发相关 worker 的更新处理。

但下面的代码仍然很关键：主进程启动调用 `registerAppActions`，该函数对 app Action 执行 `instantiateActionFromDirectory`；API 分发器也在 daemon 内导入 API 模块并调用处理器。

这意味着模块顶层和实例化代码不能因为业务操作本体随后进入 worker，就被视为已经离开 daemon 信任范围。本次没有找到足以支持“所有第三方 app 均有 OS 级沙箱”的证据。

| 执行位置 | 当前行为 | 隔离含义 |
| --- | --- | --- |
| daemon 注册路径 | 读取并实例化 app Action 模块 | 需要信任被导入代码 |
| worker 正式执行 | 运行根 Action；处理嵌套执行与取消 | 有进程边界，但不自动具备文件、网络最小权限 |
| daemon API 路径 | 导入 API 模块并调用处理器 | API 不天然隔离到 worker |
| daemon Hook 加载路径 | 导入 Hook 模块并调用 createHook | Hook 初始化也需要信任模块代码 |
| 浏览器 app 模块 | 动态导入到页面环境 | Shadow DOM 不限制 JavaScript 权限 |

对 OHS 的借鉴重点应是执行记录、容量、取消与重载组织；不能借此放松 Native Tool 或 UI 的现有安全限制。

### 7.3 App API 与调用者身份

App API 通过宿主路由进入。浏览器常用 `/api/apps/<app-id>/…`，另有面向公开入口与 Webhook 的 app API 路径。宿主先解析 app 是否当前可用，再准备上下文并把请求交给 app。

调用者身份由宿主决定，区分 guardian、visitor 与 anonymous 等类别。guardian 是宿主认可的主要使用者；visitor 是已验证但受不同访问规则约束的访问者。浏览器 bootstrap 中的 caller 只是展示提示，不能作为服务端授权证据。

`api.noAuth` 可以开放整个入口或列出的路径，Connector 就声明了匿名 Webhook 路径。这是明确的公开服务能力，不应当成 UI 自动获得任意网络和账户权限。

服务端上下文可以提供日志、数据库、repositories、运行 Action 等宿主服务。API 调用 `runAction` 时进入 ActionEngine；API 处理器自行写数据库的代码，并不会因为同属一个 app 自动走 Action 审批。

有繁忙期间请求排队等行为，但这不是对每个自定义 API 的统一超时、资源预算或可靠任务队列承诺。

依据：[API 分发器](../../rome/packages/core/src/apps/api.ts)、[API 路由](../../rome/packages/core/src/api/routes/app-api.ts)、[上下文](../../rome/packages/core/src/apps/context.ts)。

### 7.4 Hook 并不只是启动回调

Core 还装配 Agent 生命周期 Hook、处理回合的 middleware 和 channel-message Hook。middleware 是包住或参与一次处理流程的代码，与“回合结束后记一条日志”这类观察回调不是同一权限级别。

共享 Hook loader 解析声明路径，导入模块，调用 `createHook(deps)`，再由具体调用方校验其需要的接口。上下文可以包含 app logger、appContext 和 agentRunner。因此它能参与宿主业务流程，不是一个纯前端事件系统。

重载时需要与 app 归属、注册和清理联动，初始化失败进入运行诊断。channel-message 的特定 Hook 还影响入站渠道处理；不能将其误写成所有第三方 app 默认同时订阅全部消息。

依据：[Hook Loader](../../rome/packages/core/src/core/hook-loader.ts)、[渠道 Hook 类型](../../rome/packages/core/src/hooks/types.ts)、[Core 装配](../../rome/packages/core/src/index.ts)。

## 8. 数据、迁移与定时任务

### 8.1 安装文件与业务数据分开

安装内容可以被替换和清理；业务数据不应该随重装丢失。Rome 主要提供两类 app 数据位置：

- app 的文件数据目录，用于非数据库文件。
- 共享数据库中的 app 表，通过前缀和迁移记录管理归属。

`tableName(name)` 拼出 `<prefix>__<name>`。scoped app ID 若使用数据库，需要显式的合法表名前缀，避免直接把带符号 ID 作为 SQL 标识符。

这种前缀是**逻辑归属约定，不是数据库权限隔离**。上下文提供原始数据库 connection；恶意代码不是因为用了前缀就无法访问其他表。

### 8.2 迁移、卸载与 purge

Catalog 的数据迁移订阅者在运行装配期间应用 app 迁移。迁移失败会记录失败并将 app 标记为损坏，不应继续假装数据库就绪。

普通卸载保留业务数据；purge 才承担清理所属数据库表、迁移记录和文件数据目录的职责。数据库中的清理可以在事务中完成，但数据库事务与文件系统删除不是一个共同的原子事务。

当前还有一处需要验收的清理边界：`resolveTablePrefixForPurge` 只从当前已解析的 Catalog 视图取表名前缀，没有落盘 manifest 的回退。已禁用、损坏或孤立 app 可能拿不到前缀，从而跳过数据库表删除；LifecycleService 对已经不存在的 app 也不会再次执行 purge。界面提供“卸载并清理”不等于所有残留状态都能在这条路径被清空。

业务状态长期保存与执行可靠性也要分开。Action 返回 detached 接收回执，并不证明它的后台执行能够在 daemon 崩溃后自动续跑；当前 Action 概念文档明确限制了这一点。

依据：[迁移订阅者](../../rome/packages/core/src/apps/db-migration-subscriber.ts)、[数据上下文](../../rome/packages/core/src/apps/context.ts)、[生命周期服务](../../rome/packages/core/src/apps/lifecycle-service.ts)、[数据清理实现](../../rome/packages/core/src/apps/user-data-purge.ts)、[Action 概念](../../rome/docs/concepts/actions.md)。

### 8.3 启动 Hook 与定时任务

app 启动 Hook 在相关能力重载收尾后处理，可用于初始化或调整宿主中的任务。它应设计为可重复调用且不重复创建业务数据。启动 Hook 的失败记录与正式 Action 结果不是同一种返回渠道，也不应当成安装成功的充分条件。

Rome 的定时任务由宿主提供，不要求每个 app 单独开启一个长期调度进程。Briefing 的 `sync-routines` 将用户配置转换为应存在的 routines，API 在设置变更等路径调用它。

需要避免一个具体误读：当前 Briefing manifest 没有声明 app-started Hook，不能把“平台支持启动 Hook”写成“Briefing 每次启动都会自动同步任务”。

依据：[app-started](../../rome/packages/core/src/core/app-started.ts)、[Briefing 声明](../../rome/rome_apps/briefing/app.yaml)、[同步任务操作](../../rome/rome_apps/briefing/src/actions/sync-routines/index.ts)、[Briefing API](../../rome/rome_apps/briefing/src/api/index.ts)。

## 9. Web UI：从资源清单到页面

### 9.1 宿主准备启动上下文

打开 app 时，页面先取得宿主生成的 Web manifest 与 bootstrap。bootstrap 是启动上下文，不是整个数据库或模型对话，主要包含：

| 类别 | 典型内容 | 作者用它做什么 |
| --- | --- | --- |
| app 身份 | app ID、版本 | 判断当前 app |
| 路径 | routeBase、path、apiBase、assetBase | 路由、请求和资源定位 |
| shell | locale、theme、themeName、embedded/full 模式 | 适配宿主环境 |
| caller | 宿主给出的调用者提示 | 选择展示文案；不能代替服务端鉴权 |
| globalParams | 会话等动态上下文 | 关联当前工作区或交互 |

宿主给出 `/app-assets/<app-id>/<assetVersion>/…` 资源地址，校验资源位于允许的目录，随后加载样式和入口模块。资源路径校验和浏览器脚本权限是不同的安全层。

静态资源 URL 带指纹，可以做长期缓存。当前资源路由还会检查指纹与**当前可用 app** 一致；不是保证所有历史版本 URL 都长期由服务器继续服务。旧聊天因此不能仅依赖“URL 有版本”来得到完整历史保真。

依据：[Apps API](../../rome/packages/core/src/api/routes/apps.ts)、[资源路由](../../rome/packages/core/src/api/routes/app-assets.ts)、[Embedded 页面](../../rome/packages/web/src/pages/AppEmbeddedPage.tsx)。

### 9.2 Shadow DOM 的实际作用

页面宿主创建 ShadowRoot，放入挂载容器和样式，将 app 的 `:root` 样式适配为 `:host`，处理 CSS 相对资源路径，然后动态导入入口并执行 `mount`。

Shadow DOM 是浏览器中的独立样式区域：宿主和 app 的普通 CSS 选择器不轻易互相污染；CSS 变量仍可从宿主继承。这样不同 bundle 可以使用自己的样式，而公共主题值仍然一致。

但它不创建新的 JavaScript 安全环境。app 模块与页面共享 window，能够运行普通浏览器代码。它不是 OHS 当前 sandbox iframe 的替代方案。

页面离开或重载时调用 `unmount`；宿主也处理异步加载已取消的情况，避免离开页面后再把 app 挂回来。Embedded 页面订阅 app 变更并更新资源；不能把“所有路由与所有展示面完全一致地热重载”作为已经证明的结论。

依据：[RomeAppHost](../../rome/packages/web/src/components/rome-app-host.tsx)、[AppEmbeddedPage](../../rome/packages/web/src/pages/AppEmbeddedPage.tsx)、[AppFullPage](../../rome/packages/web/src/pages/AppFullPage.tsx)。

## 10. 三种展示面，不是三个插件

| 展示面 | 如何加载 | 谁拥有外围布局 | 主要用途 |
| --- | --- | --- | --- |
| 独立 / embedded app 页面 | 加载同一 Web bundle，调用页面 mount | Rome 路由和页面 shell | 完整业务页面 |
| 工作区 widget | iframe 加载 `/full/apps/...` | 工作区布局系统 | 与聊天、工具并排的持续页面 |
| 聊天内联组件 | 加载该 app bundle，按 component ID 调用 mountComponent | 聊天记录与卡片宿主 | 一次具体操作所需的选择、配置或结果 |

### 10.1 Widget 的动态上下文

Widget 的路由地址与 app 自定义标量参数形成 iframe URL；当前会话等宿主上下文不必全部塞进 URL，而是通过 ready 握手和 `postMessage` 更新。

宿主检查消息来源 origin 和 iframe window。会话上下文变化可以传入已存在的 widget，不要求每次重设 iframe src。初始路由被冻结；widget 后续位置变化可以记录给工作区，而不是把每次记录都反向变成页面重载。

需要区分“更新正在显示的 app 上下文”和“切换到一个新 widget”。前者可以保留当前页面，后者可能需要新的 placement 身份。

当前 widget iframe 没有 sandbox 属性，不能因为用了 iframe 就认定它和宿主隔离。它更接近同源页面嵌入。

依据：[AppWidget](../../rome/packages/web/src/pages/free/AppWidget.tsx)、[浏览器 SDK](../../rome/packages/app-web-sdk/src/runtime/index.ts)。

### 10.2 对 OHS 的意义

OHS 的内联与右侧 panel 已经是同一 Native UI 组件的两个展示位置，方向与“同一业务多入口”相符。Rome 的 widget 不是 OHS session-sidebar 的直接同义词：它还涉及完整页面路由、工作区 placement 和保存的布局。

可以先改进两种现有展示面之间的体验，不必立即新增 app 页面或自由布局工作区。重要的是让业务实例、临时显示容器和未提交草稿分别有明确身份。

## 11. 聊天内联组件：完整交互链路

### 11.1 注册、请求、渲染

作者通过 `defineComponent(componentId, renderer)` 在 app Web bundle 中注册组件，并在 app.yaml 的 `components` 列表声明 ID。

一个 Action 可以返回 `pending_interaction`，包含所属 app、文字问题以及 inline 渲染描述。文字问题是非交互渠道的降级入口，不是装饰性字段。

Webchat 从 Action 的 tool result 中识别这种结果，检查所属 app 当前已解析、组件已声明，保存 pending card 并通过消息流发给前端。内联宿主随后取得 app manifest、加载 CSS 和模块，调用 `mountComponent`。

```text
Agent 调用 Action
       │
       ▼
Action 返回 pending_interaction + promptText + 组件 ID / props
       │
       ▼
Webchat 校验声明 → 保存卡片 → 发给浏览器
       │
       ▼
组件拿到 props、历史 result 和 host 接口
       │
       ▼
用户提交 / 关闭
       │
       ▼
interaction_result 进入所属会话 → 新回合读取结果并继续
```

这里不是让一个旧 tool call 保持执行几小时等待按钮。原 Action 已返回一种交互结果，后续通过新的聊天回合继续。

依据：[服务端 SDK 结果类型](../../rome/packages/app-runtime-sdk/src/index.ts)、[Agent 会话适配](../../rome/packages/core/src/core/agent-session.ts)、[Webchat](../../rome/packages/core/src/api/routes/webchat.ts)、[AppComponentView](../../rome/packages/web/src/components/chat/entries/AppComponentView.tsx)。

### 11.2 组件拿到的接口

内联上下文主要是：

```text
bootstrap       当前 app 与宿主环境
props           此次交互的输入
result          已保存的交互结果（若有）
host.submit     提交结构化输出，可带摘要
host.dismiss    结束交互，不产出普通业务结果
host.resolved   当前交互是否已经结束
```

这套设计将“请求用户做什么”和“用户最终做了什么”分开。历史组件可以用保存的 result 还原最终选择，不必把所有内容重算一遍。

但 `resolved` 是交互状态，不是前端安全禁令；组件仍要按状态展示只读内容，服务端还需要校验提交。当前组件 ID 清单也不是返回结果 JSON Schema，不能把任意卡片输出称为已完成通用业务校验。

### 11.3 提交的归属、重复提交与历史

Chat 将卡片结果发回卡片所属的 session，带对应 toolUseId，而不是凭“当前正在看的会话”决定归属。服务端按会话历史重建尚未完成的交互集合，只接受对应开放交互的结果，防止过期、伪造或重复结果被正常处理。

toolUseId 在不同回合可能复用，所以服务端按历史顺序处理卡片与结果；前端历史关联也考虑 session。不能把 toolUseId 当成永久全局 UUID。

普通输出会被组织成新的 Agent 输入；dismiss 有单独文案，提示不应自行重开交互。多个内联卡片可以同时开放，它们不必锁住整个对话。Handoff 是另一种机制：创建子会话并约束父会话，不能与普通内联卡片混为一谈。

还存在一个历史边界：内联宿主使用当前 app 的 Web manifest 加载代码。本次未看到为每张卡片固定原始 app bundle 内容指纹的同等机制。升级后，新代码如何解释旧 props/result，需要作者兼容或额外版本方案。

### 11.4 降级到非 Web 渠道

没有交互展示面的渠道使用 `promptText` 形成普通文字问题。它让同一能力在不能渲染组件时仍有可读入口，但不保证文字回答自动具有与表单完全相同的约束、字段完整性和业务效果。

这点适合 OHS：即便 UI 是最佳入口，也应给模型、CLI、历史消息和加载失败场景保留明确的文字解释。

## 12. App 与聊天互相进入

### 12.1 导航与草稿

浏览器 SDK 提供类型化的宿主导航入口，可以去聊天、app、设置、项目等页面。聊天草稿、选用 Skill、Agent 和工作区 widget 等可放在路由状态中，不需要把所有内容编码成 URL。

“把输入放进聊天草稿”和“自动发送并开始运行”是两种行为，前者不会自然意味着后者被授权。

### 12.2 startChat 的实际流程

`startChat` 将常见入口串起来：创建 session，按需保存 widget 布局，发送第一条输入，然后导航到新聊天。Workflow Studio 的首页就使用这个入口，以指定 Skill 开始工作流设计。

这是好的作者体验：业务作者关注“希望启动什么任务”，不必重复接入会话创建、布局保存和跳转。

但当前 SDK 对布局保存或首轮发送的部分失败会记录错误并继续返回 session / 导航，不是覆盖整条链路的事务。调用者不能只拿到 sessionId 就宣布任务已经成功开始。

对 OHS，可以先讨论受控的“预填聊天草稿”能力。若要直接开始新 Run，必须单独定义用户确认、目标会话、可用 Skill/Agent、失败回执与重复点击规则。

依据：[导航与 startChat](../../rome/packages/app-web-sdk/src/runtime/index.ts)、[宿主导航处理](../../rome/packages/web/src/hooks/use-host-navigation.ts)、[Workflow Studio 首页](../../rome/rome_apps/workflow-studio/src/web/App.tsx)。

## 13. 统一视觉与作者体验

### 13.1 不是仅共享一个 dark 布尔值

Rome 把视觉分成具体值、语义名称和组件约定。语义样式值是按用途命名的颜色与尺寸，例如 app 背景、聊天背景、正文、次要文字、错误、控件高度，而不是让每个作者硬编码一个灰色。

宿主注入当前主题颜色；组件库提供固定的排版与几何值；app 的 Shadow DOM 继承需要的 CSS 变量。`themeName` 与明暗模式是两个不同维度，同一组件不必逐个主题重新写配色。

App 页面和聊天内联分别使用 app-canvas、chat-canvas 的背景角色，内联区域可以顺着聊天底色融合，而不是强制再加一张厚边框大卡片。

这正好对应 OHS 曾出现的体验问题：宿主已经追求轻边框、小标题和安静的操作布局，但插件页面自己硬编码标题、背景、圆角和阴影，就会再次变成一块外来管理后台。

依据：[设计系统](../../rome/docs/design-system.md)、[UI Kit](../../rome/packages/ui/README.md)、[Web 宿主](../../rome/packages/web/src/components/rome-app-host.tsx)。

### 13.2 弹层必须挂到正确位置

对话框、下拉菜单等经常通过 portal 渲染到页面另一处容器。若默认插入 document.body，它们会跑出 app 样式区域，丢失颜色、字体或主题。

Rome SDK / UI Kit 为弹层提供挂载容器约定。这是完整的作者体验问题，不是再补一个 CSS 类即可解决。

不过当前 SDK 中也存在全局 mount container 与 bootstrap 状态。多 app、多挂载场景不能假设所有接口天然按实例隔离；内联宿主源码明确注明了不同 app 同时渲染时全局 bootstrap 竞争的限制。

### 13.3 构建工具承担重复工作

CLI 生成入口、挂载导出、Web manifest、样式列表和指纹；SDK 提供注册、上下文、导航与请求；模板给出起点。可选 UI Kit 帮助作者统一控件。

值得 OHS 借鉴的是减少作者手写易错协议，而不是照搬 Rome 的 React/Shadow DOM 运行方式。OHS 已有 UI SDK、构建流程和原生插件开发指南，可以在其上增加语义样式与推荐组件。

## 14. 四个第一方 app 展示的产品模式

| app | 已声明的主要能力 | 展示出的模式 | 借鉴重点 |
| --- | --- | --- | --- |
| [Workflow Studio](../../rome/rome_apps/workflow-studio/app.yaml) | Web、Skill | 页面作为 AI 工作流入口，开始专门聊天 | 页面不一定需要自己的后端或数据库 |
| [Connector](../../rome/rome_apps/connector/app.yaml) | Web、API、数据库、Action、Skill、内联组件 | 设置页、连接卡片和 Agent 调用共用一项连接能力 | 同一业务在页面与聊天中分工 |
| [Welcome to Rome](../../rome/rome_apps/welcome-to-rome/app.yaml) | Web、内联组件等 | 在聊天中收集姓名、想法与初始偏好 | 组件返回明确字段，历史显示最终结果 |
| [Briefing](../../rome/rome_apps/briefing/app.yaml) | Web、API、数据库、Action | 页面配置长期任务，Action 使用持久设置，宿主 routines 执行 | 插件可以是持续服务，而不只是单次工具 |

### 14.1 Workflow Studio：界面是任务入口

首页调用 `startChat`，携带设计工作流的 Skill 和初始输入。manifest 并未要求 app 自建 API 与数据库，说明“app”可以是一项以 AI 对话完成的产品入口。

不能根据源码中的说明性注释，推断它已完整实现所有“聊天旁边同步编辑器”体验；本报告以实际注册和调用为准。

### 14.2 Connector：一个能力，多处使用

连接设置页负责长期账户管理；内联 connect-card 和 login-card 处理当次调用的连接前提；Action 提供实际业务操作。认证凭据不需要交给前端作为普通 props。

login-card 的登录成功和某个第三方工具已经连接是两个状态。组件提交的结果应告诉 Agent 下一步是什么，不能把所有“完成设置”都缩成一个 success 布尔值。

### 14.3 Welcome：小组件也应有最终结果

[Name Card](../../rome/rome_apps/welcome-to-rome/src/web/name-card.tsx)将初始输入、用户提交和历史结果分开；[Idea Picker](../../rome/rome_apps/welcome-to-rome/src/web/idea-picker.tsx)把选择转换成后续聊天入口。这些例子比通用仪表盘更接近 OHS 内联卡片应优先尝试的形态。

### 14.4 Briefing：页面配置，平台运行

Briefing 保存业务设置和 scouts，提供执行与同步操作，使用宿主定时任务。它展示了 app 可以维护长期业务，而不用所有计算都发生在打开页面的那一刻。

对 OHS，这可以作为后续“工具 + 持久状态 + Monitor/Workflow + 可视配置”的产品参考；不意味着本阶段要一次性提供全部运行服务。

## 15. App Store、来源与 Remix

Rome 的来源模型区分源码、bundle 和 App Store。Store 来源带 listing、版本和内容 hash；下载后核对内容与 manifest 身份。这里不等同于 OHS 的 Git、npm、archive 来源已经获得同样实现。

本地代码中有商店安装、发布、复制改造的入口。商店版本的不可变与保留规则还有服务端责任；本次未审查线上 registry，不能仅凭客户端逻辑保证远端一定实施了所有规则。

当没有独立传入 contentHash 时，安装器会从同一 registry 获取 hash 与包。源码自己也指出：两者来自同一信任来源，不形成独立的真实性证明。内容一致性校验不等于发布者身份或供应链可信。

Remix 是从已有 app 复制出一个新的作者工作区：确定来源内容，检查是否提供源码，生成新 app ID，调整相关引用和数据命名，保留来源关系。它不应改动原 app，也不是“下载后自动替换原安装”。创建工作区与正式安装仍是不同步骤。

商店展示素材、发布元数据可以作为 sidecar 保存，不必全部进入运行包。这一点值得参考：来源记录、发布说明与运行时 manifest 可以分别承担职责。

对 OHS，此阶段不必引入 Marketplace。外部 Converter 转出 Native Plugin 后，仍交给原生管理系统；不能为 Rome 风格 app 再开一套独立生命周期，也不能让 Converter 承担发布、依赖安装或长期运行管理。

依据：[Installer](../../rome/packages/core/src/apps/installer.ts)、[Remix](../../rome/packages/core/src/apps/remix.ts)、[Remix Source](../../rome/packages/core/src/apps/remix-source.ts)、[Store CLI](../../rome/packages/app-web-sdk/src/cli/store/)。

## 16. 当前边界与不宜直接照搬的部分

| 边界 | 源码依据 / 观察 | 需要怎样理解 |
| --- | --- | --- |
| Shadow DOM 不是脚本沙箱 | Web 宿主动态 import，同一 window | 适合样式组织，不是恶意代码权限边界 |
| Widget iframe 不带 sandbox | AppWidget 的 iframe | 页面嵌入，不等于第三方代码隔离 |
| Bootstrap 存在全局状态 | AppComponentView 明确标注并发 app 竞争 | 上下文应按挂载实例隔离，不能照抄全局变量 |
| 主题变更可能重挂载内联组件 | 内联宿主 effect 依赖 theme 等值 | 文案“实时主题”不代表草稿一定不丢 |
| 历史卡片加载当前 bundle | 读取当前 app manifest | 需要旧数据兼容策略，或固定历史代码 |
| 返回结果没有通用组件 schema | manifest 仅列 component ID | 声明检查与业务字段检查是两层 |
| 服务端 API 在 daemon 加载 | API dispatcher 导入并运行模块 | 不能把 worker 执行视为全包隔离 |
| Action 注册也实例化代码 | main 的 registerAppActions | 顶层代码仍在主进程信任范围内 |
| 数据表前缀不是 SQL 授权 | app context 暴露 connection | 逻辑数据归属不等于恶意代码隔离 |
| purge 依赖当前可解析的数据归属 | 无前缀回退；已不存在项不继续 purge | 禁用、损坏和残留数据需要额外验收 |
| 安装会安装依赖 | Prepare 的 pnpm 参数与 workspace 分支 | 网络和脚本执行需要明确政策 |
| 失败升级不总是保持旧 app 活跃 | Manager 写 failed，Catalog 筛 installed | 原子文件步骤不等于整条安装事务 |
| startChat 可能部分成功 | SDK 对部分步骤失败记录后继续 | 会话存在不等于首轮已经执行 |
| Web 指纹只服务当前资源 | app-assets 对比当前 assetVersion | 不保证历史包长期可访问 |
| detached 不保证跨重启执行 | Action 概念文档 | 持久业务状态与后台执行恢复分开 |

这些不是未经运行复现就宣布的完整缺陷清单，而是当前源码能确定的设计边界、明确注释和需要验收的风险。是否对 Rome 自己构成问题，还取决于它对第三方 app 的信任模型和产品目标。

## 17. 与 OHS 当前插件 UI 的对照

OHS 这里指当前 OpenHarness-ts / Vykor Native Plugin 实现，不是早期规划中所有可能贡献类型都已实现的理想平台。

| 维度 | Rome Apps | OHS 当前 Native Plugin UI |
| --- | --- | --- |
| 运行单元 | app 可组合 Web、API、数据库、Action 等 | Native Plugin；UI 是其中一个贡献，仍使用原生安装与权限机制 |
| 展示位置 | app 页面、工作区 widget、聊天内联 | tool-result 内联与 session-sidebar |
| 加载形式 | JS bundle + CSS manifest，页面动态 import | 本地受限 HTML 文档，通过隔离 iframe 加载 |
| 样式连接 | 语义 CSS 变量、共享 UI Kit、Shadow DOM | bridge 提供 light/dark、locale、surface；没有同等宿主语义样式集合 |
| 作者接口 | defineComponent、app API、导航、startChat 等 | 已有 SDK：snapshot、requestAction、openSidebar、resize、dismiss |
| 业务操作 | API 或 Action；卡片也可交回聊天结果 | 只调用声明且经宿主核验的自身 Native Tool 操作 |
| 模型继续 | 交互结果作为新输入，让 Agent 继续 | UI action 是独立工具 Run，不自动开始模型回合 |
| 实例历史 | 保存 props/result，但加载当前 bundle | 保存实例及关联 Run/Part，并校验插件与组件内容身份 |
| 切换展示面 | 页面 / widget / inline 有不同宿主机制 | 同一业务实例切换，但临时 frame 会重新挂载 |
| 未提交草稿 | 取决于组件、页面和挂载方式 | 当前未提供通用宿主草稿保存接口 |
| 前端网络 | app fetchAppApi 调宿主 API | CSP 的 connect-src 为 none，须通过受控 bridge 请求工具操作 |

依据：`OHS UI 协议`（旧实现已移除）、`Bridge 协议`（旧实现已移除）、`现有 UI SDK`（旧实现已移除）、`展示管理`（旧实现已移除）、`Frame`（旧实现已移除）、`文档 CSP`（旧实现已移除）、`当前实例校验`（旧实现已移除）。

### 17.1 OHS 应保留的已实现优势

OHS 的 iframe 仅允许 scripts，不给同源权限，配合限制网络、子页面和对象等能力的 CSP。通信使用按挂载建立的 MessageChannel，bridge 只开放明确方法。

UI 操作走宿主确认和服务端检查，并调用插件自己的受控工具；不是把 daemon API 和桌面 IPC 直接交给网页。插件禁用、内容变化和历史实例不匹配时，执行路径会重新核验，不偷偷替换为任意最新代码。

这些约束更适合可导入的第三方 Native Plugin。参考 Rome 的界面能力时，不应以“让作者更容易”为由删除它们。

### 17.2 OHS 当前体验缺口

目前主题上下文只有明暗值，作者仍容易硬编码配色、字体、边框和标题。参考插件就有自身页面标题与宿主标题同时出现的问题。

内联转侧栏会创建新的临时 frame；插件仅存在 JavaScript 内存中的选择会丢失。[文本检查示例](../examples/plugins/text-inspector/ui/panel.mjs)使用内存 Set 保存选择，且业务 revision 变化时主动清空。这两种清空要区分：同一业务版本的视图迁移可以保留草稿；数据已经变更后的旧选择不应无条件恢复。

此外，OHS 当前没有 Rome 同等的结构化“提交给聊天并继续”接口。这是现有规格的明确行为边界，不是漏接一个按钮。下一阶段若提供，必须按新业务行为设计。

依据：[OHS 完整 UI 规格](./superpowers/specs/2026-10-02-native-plugin-ui-design.md)、`工具执行器`（旧实现已移除）、[示例 HTML](../examples/plugins/text-inspector/ui/panel.template.html)。

当前规格与 [A4 验证记录](./superpowers/reviews/2026-10-04-native-plugin-ui-a4-verification.md)还将用户人工验收与发布单列。本报告所说的已实现代码，不替代这两个验收步骤。

## 18. 对 OHS 的建议：先完善两种现有展示面

以下为调研建议，不是执行计划。优先顺序以降低现有插件 UI 作者负担、改善内联和侧栏一致性为准。

### 18.1 优先一：建立插件 UI 视觉契约

由宿主提供一小组语义样式值：背景、表面、正文、次要文字、分割线、主操作、危险操作、字体、圆角和控件尺寸。通过现有受控文档或 snapshot 注入，不依赖 iframe 跨越安全边界继承宿主 DOM。

同时区分内联与侧栏的默认内容规则：内联避免重复主标题和大外框；侧栏可以有紧凑工具条，主动作位置固定；两种位置使用同一业务组件，但允许不同密度。

在现有作者指南、SDK 和构建工具中提供轻量 CSS / 可选组件，不强制所有插件使用 React。键盘、焦点、减少动态效果和弹层范围都要写进推荐模板。

### 18.2 优先二：草稿与显示位置分开

草稿身份应关联业务 instanceId、组件与数据 revision，不关联随机 mountId。草稿保存只负责选择、输入和折叠等未提交状态，不能伪造工具执行结果或修改正式业务快照。

需要约定大小限制、过期与清理、禁用和卸载处理、敏感字段禁止保存、revision 不匹配时的重置方式。内联转侧栏只是迁移视图时，应恢复同一版本的草稿；正式数据变动时由组件决定转换或重置。

也可以先采用单个活跃 frame 的迁移方式减少重挂载，但需要评估桌面宿主布局成本，不能把“永不重挂载”当成唯一正确实现。

### 18.3 优先三：按需要增加“交回聊天”

首先区分三个用户意图：

- 调用工具执行动作：继续使用 requestAction，不自动唤起模型。
- 把选择放进输入框：只预填草稿，让用户决定发送。
- 提交结果并继续任务：新接口、有明确确认和回执，创建新的正常 Run。

第三种需要服务端验证实例归属与状态，限制输出大小并按声明校验字段，记录提交结果与摘要，拒绝重复提交，并给 CLI 等渠道保留文字 fallback。不能让插件直接拼接一段任意隐藏系统指令送入模型。

### 18.4 后续再讨论完整 app 能力

独立 app 页面、持久插件数据、API、定时任务和工作区贡献有各自授权与生命周期成本。可以沿 Native Plugin 的统一契约逐项扩展，不需要先创建第二套“App 安装器”。

现阶段不因本次调研推进 LSP、Marketplace、自动依赖安装或任意第三方脚本直连 daemon。Converter 的职责仍截止于产出 Native Plugin，来源字段用于区分原生或转换，不影响统一管理原则。

## 19. 后续验证问题与源码测试入口

本次是源码分析，以下仍需单独运行验收：

| 要验证什么 | 建议场景 |
| --- | --- |
| 安装失败后的旧版本可用性 | 分别模拟构建、生产依赖、active 切换、lockfile、订阅者阶段失败 |
| 多 app 上下文归属 | 同一聊天中同时挂两种 app 卡片，各自请求 API、导航与打开弹层 |
| 主题与草稿 | 有未提交输入时切主题、切页面、切工作区，观察重挂载与恢复 |
| 历史卡片 | 修改组件 ID、props 结构或结果解释后升级，再打开旧记录 |
| 交互结果提交 | 双击、刷新后重提、错误会话、重复 toolUseId、网络失败与关闭 |
| 数据清理 | 普通卸载、重装、purge 失败、表前缀冲突与迁移失败 |
| startChat 部分失败 | 布局保存失败、首轮发送失败后，对调用方是否有足够提示 |
| 运行隔离 | 在 Action 顶层、createAction、API 处理器中分别触发故障，观察 daemon 影响 |

Rome 有相关自动测试文件，可作为后续执行入口。下面只确认这些文件存在，不表示本次已运行或通过：

- [生命周期端到端测试](../../rome/packages/core/src/apps/lifecycle.e2e.test.ts)、[Context 测试](../../rome/packages/core/src/apps/context.test.ts)、[Remix 测试](../../rome/packages/core/src/apps/remix.test.ts)。
- [Web 资源路由测试](../../rome/packages/core/src/api/routes/app-assets.test.ts)、[API Caller 测试](../../rome/packages/core/src/api/routes/app-api-caller.e2e.test.ts)、[API 路由顺序测试](../../rome/packages/core/src/api/routes/app-api-route-order.e2e.test.ts)。
- [Web SDK 测试](../../rome/packages/app-web-sdk/src/runtime/index.test.ts)、[构建 manifest 测试](../../rome/packages/app-web-sdk/src/cli/manifestPlugin.test.ts)、[构建配置测试](../../rome/packages/app-web-sdk/src/cli/createRslibConfig.test.ts)。
- [Web 宿主测试](../../rome/packages/web/src/components/rome-app-host.test.ts)、[App 页面测试](../../rome/packages/web/src/pages/AppEmbeddedPage.test.tsx)、[Chat 测试](../../rome/packages/web/src/components/chat/Chat.test.tsx)、[历史视图测试](../../rome/packages/web/src/components/chat/chat-view.test.ts)。

## 20. 结论：借鉴能力组合，不照搬信任模型

Rome 最有价值的不是某个 panel 组件，而是完整路径：作者声明业务能力，平台负责安装与加载，同一业务从页面和聊天进入，用户结果被保存并交回后续处理，长期数据不跟安装文件一起丢失。

OHS 当前已经具备统一 Native Plugin 管理、UI 作者接口、内联与侧栏、持久实例和受控工具执行。下一步更适合把这条已有链路打磨完整：统一视觉、明确上下文与草稿、按需增加结构化结果回到聊天的能力。

Rome 的全局浏览器上下文、同源 Web 运行、daemon API 和自动依赖安装，是它自身信任模型下的选择。我们可以学习它如何让插件像一项可使用的业务功能，而不必复制它对第三方代码授予的权限。
