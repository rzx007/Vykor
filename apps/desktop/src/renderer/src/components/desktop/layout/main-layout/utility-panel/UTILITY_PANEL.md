# 右侧工具面板状态说明

本文说明桌面端右侧工具面板（Utility Panel）的状态边界、会话切换流程和持久化位置。修改面板行为前，应先确认变化属于视图状态、运行时状态还是具体工具自身的状态。

## 设计目标

右侧面板遵守以下约束：

1. 每个会话拥有独立的面板实例和状态，不能按项目共用。
2. 对话起始页也拥有一个临时的草稿实例；从起始页创建新会话时，该实例迁移给新会话。
3. 切换到已有会话时只恢复该会话自己的状态，不能迁移当前实例。
4. 关闭全部终端标签后，旧标签不能在下一次新建终端时重新出现。
5. Panel 的展开、最大化和尺寸状态可以跨应用重启恢复；终端和浏览器等运行时对象只在当前 renderer 生命周期中保留。

## 范围标识

`utilityPanelScopeId` 生成面板范围：

```text
有活动会话：session:<sessionId>
没有活动会话：draft:<projectId>
未选择项目：draft:outside-project
```

项目只参与草稿范围的生成。正式会话始终使用 session ID，因此同一个项目里的多个会话不会共享面板。

## 文件职责

面板实现集中在 `layout/main-layout/utility-panel/`。`index.ts` 是对外入口；`MainLayout` 和标题栏只从这里引用面板组件、controller 和 `UtilityToolRequest`。

### `../main-layout.tsx`

页面组合层。它创建 `react-resizable-panels` 的引用，将当前会话和引用传给 controller，并把 controller 返回的状态传给 `UtilityPanel`。

这里不保存会话级面板状态，也不直接读写 `localStorage`。

### `use-utility-panel-controller.ts`

面板的入口控制器，负责：

- 计算当前 scope。
- 识别“草稿创建为新会话”的迁移场景。
- 恢复和保存展开、最大化及尺寸状态。
- 将声明式状态同步给 `react-resizable-panels` 的命令式 API。
- 将打开文件、打开终端和打开工具请求绑定到发起请求时的 scope。

`MainLayout`、标题栏快捷操作和对话消息中的文件/终端入口都应调用 controller 暴露的方法，不应绕过 controller 直接修改 Panel。

### `utility-panel-repository.ts`

唯一的面板缓存和持久化入口。它隐藏数据实际存放在哪里，对外提供读取、写入、patch 和 scope 迁移。

目前数据位置如下：

| 数据                                         | 位置              | 生命周期     |
| -------------------------------------------- | ----------------- | ------------ |
| 展开、最大化、尺寸                           | `localStorage`    | 跨应用重启   |
| 已打开文件路径                               | `localStorage`    | 跨应用重启   |
| 工具标签、浏览器标签、文件预览、终端标签描述 | renderer 内存 Map | 当前应用进程 |

继续增加可恢复状态时，应先扩展 repository，而不是在组件中新增 `localStorage` 访问。

### `utility-panel-state.ts`

保存共享状态类型和无副作用的解析、范围判断函数。这里的函数不调用 React，也不操作 Panel DOM，便于直接进行单元测试。

### `use-utility-panel-runtime.ts`

管理一个 scope 内可缓存的工具标签快照。reducer 将以下字段作为同一个状态快照更新：

- 工具标签和浏览器标签。
- 文件预览标签、当前文件和加载中文件。
- 当前激活的工具标签。
- 终端工具是否已经挂载。
- 文件/工具打开请求是否已经消费。

终端命令队列不进入该快照。它是发往 `TerminalTool` 的一次性命令，消费完成后立即删除。

### `utility-panel-tab-strip.tsx`

只负责标签条、右键菜单、“新建工具”菜单和面板右上角按钮的渲染。菜单开关属于临时视图状态，不应随会话缓存。

### `utility-panel-tabs.ts`

定义工具种类、标签数据结构、工具名称和图标等静态元数据，以及标题栏可请求打开的 `UtilityToolRequest`。该文件不导出 React 组件，避免视图组件同时承担共享配置职责。

### `utility-panel.tsx`

负责把工具标签模型连接到 Files、Terminal、Browser 和 Agents 等具体工具。它消费 controller 发来的请求，并通过 runtime reducer 更新当前 scope 的标签快照。

## 关键运行流程

### 打开已有会话

```text
desktop-session store 更新 activeSessionId
  -> controller 计算 session:<id>
  -> repository 读取该 scope 的视图状态
  -> controller 恢复展开/最大化/尺寸
  -> UtilityPanel 使用 scope + revision 作为实例 key
  -> runtime hook 读取该 scope 的内存快照
```

此流程不迁移前一个会话的任何状态。

### 从起始页创建新会话

```text
当前 scope 是 draft:<projectId>
  -> activeSessionId 从 null 变为一个“不在已知会话集合中”的 ID
  -> controller 判定为新建会话
  -> repository 将草稿视图、文件标签和运行时快照迁移到 session:<id>
  -> instance revision 增加，UtilityPanel 在迁移后重新挂载
```

revision 只用于保证迁移后的新 scope 读取已经移动完成的运行时快照。普通会话切换不依赖 revision。

### 打开文件、终端或工具

```text
调用 controller.openFile/openTerminal/openTool
  -> controller 先展开面板
  -> 请求记录发起时的 scope 和唯一 ID
  -> 仅相同 scope 的 UtilityPanel 能看到该请求
  -> UtilityPanel 消费请求并记录 handled request ID
```

因此在请求发出后立即切换会话，请求也不会被新会话误消费。

### 关闭终端标签

关闭动作先从 runtime reducer 的标签快照移除对应标签，再向 `TerminalTool` 发送一次性 `close` 命令。终端服务回报 session 删除时会再次执行幂等移除。

关闭最后一个标签后，`activeTabId` 置空。runtime repository 保存的是删除后的快照，因此后续点击“新建终端”不会恢复已经关闭的标签。

## 持久化格式

当前使用以下稳定存储键：

```text
vykor.desktop.utility-panel-states
vykor.desktop.file-tabs
```

不读取或迁移其他历史键。调整数据结构时直接更新当前解析规则，不通过在键名后追加版本号来保留旧格式。

解析函数会忽略非法条目。存储不可用、空间不足或隐私模式导致写入失败时，面板继续工作，只是不保证下次恢复。

## 修改时必须保持的规则

- 新增会话级字段时，以 scope 为第一层键。
- 不要使用 project ID 代替正式会话 ID。
- 不要在 `UtilityPanel`、工具组件或 `MainLayout` 中直接读写面板存储键。
- 依赖旧状态的更新使用 reducer action 或函数式 state update。
- scope 切换 effect 优先依赖 session ID、project ID 等基础值，不依赖完整 session 对象。
- 一次性请求必须带唯一 ID，并记录是否已经消费。
- 运行时实例不能序列化进 `localStorage`；只持久化重建实例所需的描述数据。

## 测试重点

`utility-panel-state.test.ts` 覆盖范围生成、草稿迁移、不同会话隔离、非法持久化数据和 runtime reducer。修改相关逻辑后，至少还应运行：

```powershell
..\..\node_modules\.bin\vitest.CMD run src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel-state.test.ts
.\node_modules\.bin\tsc.CMD --noEmit -p tsconfig.web.json --composite false
```

涉及终端标签生命周期时，还应运行完整 desktop 测试，确认关闭全部标签和重新创建终端的路径没有回退。
