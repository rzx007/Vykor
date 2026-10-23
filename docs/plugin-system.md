---
title: Vykor 新插件体系
subtitle: 从插件包到实际调用：结构、安装、权限与开发入口
template: doc
theme: paper
source: 当前工作区源码 · 2026-10-23
---
> 状态：当前插件体系开发说明；以当前源码和插件清单校验规则为准。

插件以 Native Plugin 包为入口。技能、工具和页面分别加载，调用始终受实际权限约束。

这份文档介绍插件整体机制。页面协议和常驻面板见独立的 [MCP Apps 文档](mcp-apps.html)。

## A 先分清插件包、工具、服务和页面

| 名称 | 实际做什么 | 当前定位 |
| --- | --- | --- |
| Native Plugin | 用清单声明一组插件能力 | 当前原生插件包格式，保留 |
| Native Tool | 在 Node 子进程内执行插件工具 | 一种工具实现方式，保留 |
| MCP Server | 通过 MCP 协议提供工具和资源 | 另一种能力接入方式，保留 |
| MCP Apps | 让页面通过标准协议使用宿主能力 | 统一的插件页面机制 |
| 旧 Native UI | 旧的页面清单和私有交互机制 | 已退役，新包改用 components.apps |

```callout info 核心关系
插件可以只提供技能或工具，也可以附带应用页面。
Native Tool 接入 MCP Apps 时，无需另起 MCP 服务。
```

### 两种带页面的插件怎样选

| 组合 | 作者实现什么 | Vykor 怎样执行 | 页面怎样得到结果 |
| --- | --- | --- | --- |
| Native Tool＋MCP Apps | registerTools 工具入口、Apps 清单和 HTML 页面 | 校验后由 Tool Host 调用 invoke | metadata.appData 转为 structuredContent |
| MCP 服务＋MCP Apps | 标准 MCP 工具与资源、服务配置、Apps 清单和 HTML 页面 | 校验后由 MCP Client 调用服务 | 直接使用 MCP structuredContent |

两种页面都使用官方 App SDK，与 Vykor 通过标准 MCP Apps 协议通信。Native 的适配只发生在后台工具接口这一段。

MCP 服务提供页面 HTML，但页面实际运行在 Vykor 右侧。服务进程与页面沙箱分别运行；页面不能直接操作服务进程或宿主文件。

| 谁发起 | 请求入口 | 结果回来后 |
| --- | --- | --- |
| Agent | 已关联页面的模型工具 | 返回 Agent，并由宿主投递给页面的 ontoolresult |
| 页面按钮 | 作者绑定事件，调用 app.callServerTool | 返回原 Promise，由页面显示；不重复推送 ontoolresult |

两种组合都保留原工具权限、安装批准和操作回执。协议不会自动替作者完成按钮绑定、草稿保存或版本冲突处理。

两套完整流程图和页面接线示例见 [MCP Apps 开发与运行机制](mcp-apps.html)。

当前可激活 Skills、Agents、Hooks、MCP、Node Tools 和 Apps。Wasm Tool 尚不激活。

LSP、Workflows、Channels 等字段可被识别，但尚无对应激活能力。不要把清单通过校验当成能力已经可用。

## B 一个插件包包含什么

```tree
plugin/
  .vykor-plugin/
    plugin.json | 唯一原生清单入口
  skills/ | 按需读取的流程说明
  agents/ | 角色定义与工具限制
  hooks/ | 生命周期事件处理配置
  tools/ | Native Tool 的可执行模块
  mcp.json | 可选 MCP 服务配置
  ui/
    apps.json | 后台、页面资源与打开入口
    panel.html | 构建后的离线应用页面
```

**清单中的组件路径必须留在插件目录内。** 各目录按需提供，无须全部创建。

下面是包声明示意，需同时提供所引用的文件。

```json title="原生插件清单 · 示意"
{
  "schemaVersion": 1,
  "id": "demo.text-helper",
  "name": "text-helper",
  "version": "1.0.0",
  "components": {
    "skills": ["./skills/check/SKILL.md"],
    "tools": [{
      "entry": "./tools/index.mjs",
      "runtime": "node",
      "permissions": []
    }],
    "apps": ["./ui/apps.json"]
  },
  "runtime": { "engine": "node", "isolation": "process" }
}
```

清单描述包内容，不保存用户批准、启用状态或进程状态。新包声明旧 components.ui 时，正常校验会拒绝。

## C 安装以后，能力怎样进入一次任务

```flow
插件包 -> 清单与文件校验
清单与文件校验 -> 安装记录与权限批准
安装记录与权限批准 -> 会话运行时加载
会话运行时加载 -> 这次任务可用的插件能力
这次任务可用的插件能力 -> 模型或用户明确调用
模型或用户明确调用 -> 原有执行与校验
原有执行与校验 -> 工具结果与操作记录
```

“这次任务可用的插件能力”表示一份允许清单。它列出助手处理这次请求可用的工具、技能和角色。

允许使用不代表每项能力都会执行。基础工具仍按原有权限使用。

| 能力 | 加载后做什么 | 执行时机 |
| --- | --- | --- |
| Skill | 提供技能名称、说明和来源 | 正文按需读取，安装不执行脚本 |
| Agent | 注册角色及工具限制 | 明确派发任务后执行 |
| Hook | 装配受支持的事件处理配置 | 对应事件发生时触发 |
| MCP | 连接适用的服务，登记工具与资源 | 调用时走 MCP 后台 |
| Native Tool | 读取元数据，再由 Tool Host 加载代码 | 调用时校验参数并执行 |
| App | 提供可打开的应用入口 | 用户打开或实时工具结果触发 |

自动模式可让模型按需使用多个已启用、已授权的插件。

显式 @插件 会把插件范围限制到指定插件。当前显式引用不能混选不同插件。

后续普通消息会延续手动选择。切换或清除选择后，再按相应设置确定可用插件。

例如，你要求“检查文本，再保存到笔记”：

- 自动模式允许两个插件时，可用 Text Inspector 检查、Notes 保存。
- 显式 @Text Inspector 时，只允许使用它的插件能力。

宿主收到消息时保存候选范围。任务开始时再次校验并固定实际能力。

后续选择不改变已经运行的任务。运行中的调用也不能因目录刷新而悄悄换成另一版本。

## D 如何安装、开发和更新

| 入口 | 用途 | 生效方式 |
| --- | --- | --- |
| Desktop 导入本地包 | 安装打包产物 | 写入用户安装记录，按会话加载规则生效 |
| Desktop 从 Git 安装 | 固定仓库内容 | 先解析实际 commit，再进入安装流程 |
| install-local | 安装本地目录 | 复制到不可变代码快照 |
| link | 本地开发 | 记录开发目录，修改后显式重载 |
| enable / disable | 启停一个插件 | 改变后续运行时的可用能力 |

Desktop 支持 ZIP、TAR、TAR.GZ 和 TGZ。一个包只放一个可识别的原生插件。

以下是仓库样例的开发命令，仅供手工执行。

```sh title="Text Inspector 开发命令"
vk plugin validate ./examples/plugins/text-inspector
vk plugin link ./examples/plugins/text-inspector --approve ui:render --approve ui:invoke-own-tools
vk plugin details example.text-inspector
```

链接目录变化不会自动热更新。在没有活动任务时，用 /reload-plugins 重新加载。

正式更新时，重建产物并重新安装同一插件 ID。权限增加时重新确认；安装成功前保留旧记录。

普通用户管理 user 插件。managed 插件由管理渠道控制，普通安装和卸载流程不能修改。

## E 哪些检查真正决定能否执行

| 检查层 | 检查内容 | 不能替代什么 |
| --- | --- | --- |
| 安装层 | 文件边界、摘要、组件和权限批准 | 不能代替运行时检查 |
| 这次任务可用的能力 | 插件身份、版本、工具与技能来源 | 不能扩大角色权限 |
| 调用层 | 工具权限、角色限制、禁用项和执行环境 | 不能靠模型选择绕过 |
| Native Tool Guard | 输入格式、并发控制和审计摘要 | 不能代替业务数据校验 |
| 应用操作层 | 页面可见性、确认、原会话与固定来源 | 不能任意调用其他插件工具 |

声明 Apps 会产生 ui:render 和 ui:invoke-own-tools 两项安装批准。实际工具仍需满足自己的权限要求。自身数据自动保存还需单独声明并批准 pluginData:write，且只对绑定的应用专用保存工具免重复确认；工作区导出和模型调用仍按原权限处理。

Native Tool 入口导出 registerTools(context)，返回工具定义数组。工具定义提供名称、说明、inputSchema 和 invoke。

一个插件版本共用一个 Tool Host 子进程。当前 Native Tool 在 local 环境激活。

```callout warn 安全边界
Node 子进程隔离崩溃和宿主环境，但不是操作系统级沙箱。
第三方 Node 代码仍可直接使用文件、网络和进程 API。
安装批准和调用门禁不等于拦截全部系统调用。
```

## F 代码、配置、草稿和业务数据放在哪里

| 内容 | 保存位置或归属 | 更新与关闭的影响 |
| --- | --- | --- |
| 插件代码 | 安装快照或开发链接目录 | 正式快照不原地修改 |
| 批准与启用状态 | 插件安装记录 | 与根清单分开保存 |
| 长期业务数据 | Native 使用 context.plugin.dataDir；MCP 使用宿主注入的插件数据目录 | 普通更新和卸载不主动删除 |
| 页面未保存草稿 | 当前 iframe 的内存 | 切换和收起保留，重启不保证恢复 |
| 应用身份与操作回执 | 宿主会话存储 | 用于来源核对及恢复，不由页面伪造 |

dataDir 的约定位置是 ~/.vykor/plugins/data/插件ID。它与代码版本及项目工作目录分开。

插件负责数据格式、迁移和清理。页面需要持久保存时，应调用原有后台工具。

## G 从完整模板到已有示例

新插件优先从 [天气与出行模板](../skills/create-plugin/templates/weather-travel/README.md) 生成。初始化时选择 --backend native 或 --backend mcp，两版共用页面与业务逻辑，可分别构建、校验和打包。

Native 版生成 components.tools 和 native-tools 后台。MCP 版生成 components.mcpServers、stdio 服务配置和 mcp-server 后台。两版都生成 components.apps，无需叠加两套工具入口。

天气模板覆盖真实天气查询、收藏、会话出行备忘、有限自动保存、选区引用和确认导出。初始化命令及安装步骤见 [原生插件开发指南](native-plugin-authoring.md)。

| 示例 | 组成与后台 | 主要体验 | 数据行为 |
| --- | --- | --- | --- |
| Text Inspector 1.2.1 | Skill、Agent、Native Tool、App | 编辑、检查、选择问题、修复预览 | 只处理传入文本，不改文件 |
| Notes 1.0.1 | MCP Server、App | 编辑草稿、手工保存、对照远端版本 | 后台按原会话保存笔记与业务回执 |

Text Inspector 的模型新结果不会覆盖正在编辑的正文。用户明确选择后才采用新结果。

Notes 的远端更新保留本地草稿。采用远端正文需要确认，保存请求携带业务版本与操作 ID。

样例源目录分别是 examples/plugins/text-inspector 和 examples/plugins/notes-app。打包产物位于 .plugin-dist。

重新导入新版包后，才会更新已有安装。修改源码不会自动替换用户安装快照。

## H 开发验收与源码导航

- 校验完整插件目录及所引用的文件。
- 明确真正需要的权限，避免泛化授权。
- 测试工具输入、取消和失败处理。
- 有页面时，额外验证 MCP Apps 的生命周期。
- 重建离线 HTML，再打包安装。
- 分别验证代码更新与数据保留。

| 想了解什么 | 仓库内入口 |
| --- | --- |
| 根清单字段 | packages/plugins/src/manifest/schema-v1.ts |
| 文件与旧 UI 校验 | packages/plugins/src/manifest/validate.ts |
| 当前可激活组件 | packages/plugins/src/loading/load-native-plugin.ts |
| 安装权限汇总 | packages/plugins/src/installation/installer.ts |
| 任务可用能力的绑定 | packages/agent-runtime/src/node/plugins/run-capability-view.ts |
| 自动与显式插件范围 | packages/server/src/application/session/plugins/session-plugin-capability-service.ts |
| Native Tool 校验 | packages/agent-runtime/src/node/plugins/native-tools/guard.ts |

源码基准为 D:/code/personal-project/OpenHarness-ts 当前工作区。本文记录实现状态，不把历史设计方案当作已上线能力。

继续阅读：[MCP Apps 开发与运行机制](mcp-apps.html)。
