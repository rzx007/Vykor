# Desktop 本地 Native Plugin ZIP 导入设计

> 状态：已实现；跨层验收与文档于 2026-09-09 完成。

## 目标

用户在 Desktop 的插件页面选择一个本地 `.zip`，系统在后台完成安全解压、Native Plugin 校验和安装。交互只呈现取消、成功或失败；插件申请权限时增加一次简短确认。Agent 对话内安装、Claude/Codex 转换、Git/npm/远程地址和其他压缩格式不在本阶段。

## 用户交互

插件页主操作由“添加插件配置”改为“导入插件”。点击后打开系统文件选择器，仅选择一个 ZIP。

- 用户取消文件选择：页面不提示错误，不改变列表。
- ZIP 不申请权限：后台校验并直接安装，成功提示“插件「名称」已安装，将在下次对话中生效”。
- ZIP 申请权限：弹出一个确认框，用通俗文字列出文件、网络、进程和密钥权限；只有“取消”和“安装”两个动作。点击安装表示批准框中列出的全部权限。
- 失败：页面显示一条可操作的主提示，例如“插件安装失败：压缩包中没有找到有效插件”。“查看详情”展示诊断代码和路径，默认收起。

不展示解压进度、摘要、manifest、组件清单、校验阶段或多步向导。导入进行时按钮显示加载状态并禁止重复操作。安装成功后刷新真实已安装列表。覆盖同 ID 的普通用户插件按重新安装处理；managed plugin 仍由 Installer/Plugin Service 拒绝。

原页面中的模板和本地插件配置不再作为插件安装入口。它们的 localStorage 数据保持原样，不迁移、不删除；插件页不再读取或展示这些数据。MCP 和 Skills 页不改变。

## 边界与数据流

```text
Renderer 点击导入
  → Desktop main 打开系统 ZIP 选择器
  → main 调用 daemon archive preview
  → Source Resolver 安全复制、读取、解压到临时目录
  → Native Validator + 静态组件 Loader
  → 无权限：daemon install archive
  → 有权限：Renderer 一次确认 → daemon install archive
  → 安装阶段重新读取 ZIP并核对 preview digest
  → Native Installer 建不可变快照并更新 installed.json
  → 关闭全部 Runtime → Desktop 刷新列表
```

Desktop renderer 不接收本地绝对路径。Desktop main 维护短期 `selectionId → { archivePath, archiveDigest, requestedPermissions }` 映射。选择结果和预览只返回文件名、插件身份和人类可读权限。进程重启或选择记录过期时要求重新选择。

Server 是安装规则的唯一入口。Desktop main 不解压、不校验 manifest、不写 cache 或 `installed.json`。Native Installer 仍只接收已经准备好的 Native Plugin 目录，不认识 ZIP。

## Local Archive Source Resolver

新增 `@vykor/plugin-sources` 包，首版只实现本地 ZIP。使用 `yauzl` 的 lazy entry/size validation 和流式解压，不执行 archive 内任何代码。

固定限制：

- ZIP 文件最大 100 MiB；
- 解压后总大小最大 250 MiB；
- 最多 5,000 个文件；
- 单文件最大 100 MiB；
- 非空文件压缩比最大 200；
- 文件路径 UTF-8 长度最大 1,024 字节，目录深度最大 32。

读取前拒绝源路径为符号链接或目录。先流式复制 ZIP 到 resolver 私有临时目录并计算 SHA-256；后续只解析私有副本。安装确认重新复制原 ZIP，摘要必须等于 preview 摘要，否则返回“文件已变化，请重新选择”。

每个 ZIP entry 在写盘前检查：

- 拒绝加密 entry、空名称、NUL、反斜杠、绝对路径、盘符、`..`、`.`、空路径段；
- 拒绝 Windows 保留名、冒号、结尾空格或句点；
- 以 Unicode NFC + 小写作为冲突键，拒绝重复路径、文件/目录冲突和大小写冲突；
- 检查 Unix mode，拒绝符号链接和普通文件/目录以外的类型；
- 流式写入带 `wx` 的目标文件，累计实际字节必须等于 central directory 声明并保持在限制内；
- 解析 CRC 错误、截断数据和格式错误统一失败并清理临时目录。

插件 manifest 只能位于 ZIP 根目录的 `.vykor-plugin/plugin.json`，或唯一的一层顶级目录 `<name>/.vykor-plugin/plugin.json`。必须恰好一个候选；使用顶级目录包装时，ZIP 中所有有效文件都必须位于该目录下。这样不会猜测深层目录，也不会把插件外文件静默丢弃。

Resolver 返回 `{ archiveDigest, candidateRoot, cleanup }`。调用者必须在 finally 中 cleanup。任何失败不返回 candidate，不留下已安装记录。

## 预览与安装 API

Server PluginService 新增两个用例：

```ts
previewArchive({ cwd, archivePath }): Promise<PluginArchivePreview>
installArchive({ cwd, archivePath, expectedArchiveDigest, approvedPermissions }): Promise<PluginMutationResult>
```

`PluginArchivePreview` 包含 archiveDigest、identity、requestedPermissions、inventory、diagnostics。预览执行 Native Validator 和 `loadNativePlugin`；error 级组件诊断使预览失败，warning 级 unsupported 诊断允许安装并在结果详情中保留。

HTTP 路由为 `POST /plugins/archive/preview` 和 `POST /plugins/archive/install`。preview 是只读操作，不关闭 Runtime；install 使用全局 mutation lease，成功后关闭所有 Runtime。install 重新 resolve、核对摘要、重新 validate/load，并调用现有 `installLocalNativePlugin`。批准权限必须和实际请求权限完全匹配。

Server 统一把 Archive/Native 诊断映射成结构化错误响应：`code`、简短 `message`、可选 `diagnostics`。Client 不解析 stderr 或错误字符串来获得业务字段。

## Desktop IPC

Desktop shared contract 增加：

- `plugins.importArchive({ cwd })`：打开文件选择器并预览；取消、需要确认、安装成功三种结果。
- `plugins.confirmArchive({ cwd, selectionId })`：批准当前预览中的全部权限并安装。
- `plugins.cancelArchive({ selectionId })`：清除待确认选择。

main service 用注入的 file picker 便于测试；默认 picker 通过 `BrowserWindow.fromWebContents` 绑定拥有者并限制 `.zip`。selection 使用随机 ID、10 分钟 TTL、最多保存 8 条；新的选择和应用退出时清理。确认时 cwd 必须与预览一致。绝对路径只存在 main 内存和发往同机 daemon 的请求中。

## Renderer

`PluginManager` 收口为真实安装列表：删除模板、PluginEditor 和 localStorage 配置分支。空状态和页面顶部“添加”均调用导入。权限确认框显示插件名称及分组后的权限说明；不使用逐项 checkbox，因为确认按钮批准的就是完整列表。

失败反馈复用 Alert，但保存结构化错误详情；主消息始终是中文短句，详情默认收起。安装成功通过页面底部 status 提示并刷新 snapshot。需要权限确认时不触发安装，用户取消时调用 cancel IPC。

## 测试

- Resolver：有效根目录/单层包装 ZIP；缺失/多个 manifest；CRC/截断/加密；大小、数量、压缩比；路径穿越、绝对路径、反斜杠、Windows 名称、Unicode/大小写重复、文件目录冲突、symlink；失败清理；摘要变化。
- Server：预览不安装、不关闭 Runtime；error 组件拒绝；无权限安装；权限不匹配拒绝；摘要变化拒绝；成功创建不可变快照并关闭所有 Runtime。
- Desktop main/IPC：取消、错误、无权限直接成功、有权限返回确认、确认/取消、过期/错误 cwd、只允许 ZIP，renderer 永远不收到绝对路径。
- Renderer：点击导入、busy 防重入、成功提示、失败主提示和详情、权限一次确认、取消无安装、真实列表刷新；旧 localStorage 数据不读取也不删除。
- 端到端契约：用文本检查参考插件构造 ZIP，通过 daemon/client/Desktop service 安装，删除 ZIP 后仍可从快照发现并静态加载。测试不启动模型或 Agent 对话。

## 不在本阶段

不实现转换器调用、Agent 对话安装、拖拽安装、目录选择/link、远程下载、签名、Marketplace、自动依赖安装、安装历史 UI 或真实 Tool 激活状态改造。下一阶段再规划 Agent 对话和其他来源。
