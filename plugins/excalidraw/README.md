# Excalidraw 画板

正式插件 `dev.vykor.excalidraw`，版本 `1.0.2`。在会话右侧绘图，连续编辑自动保存。可创建、导入、打开、重命名和切换画板，引用选中元素到聊天，并导出 `.excalidraw`、PNG、SVG。

## 构建与安装

需要 Node.js 24 或更新版本（使用内置 SQLite）。在本目录执行：

```sh
npm ci --ignore-scripts --legacy-peer-deps
npm run build
npm test
npm run test:stdio
npm run typecheck
```

正式使用请在桌面“插件 → 浏览市场”安装 Excalidraw，不随应用附带。开发时可用 `vk plugin link ./plugins/excalidraw`，正式安装可用桌面插件页导入包含下述文件的 ZIP（或使用 `vk plugin install-local ./plugins/excalidraw` 并按实际权限批准）。构建后分发必须包含 `.vykor-plugin/plugin.json`、`mcp.json`、`ui/apps.json`、整个 `dist/`、`skills/excalidraw/SKILL.md`、`LICENSE` 和 `licenses/`；安装后不需要 npm、网络服务或 CDN。`dist/` 是可重新构建的产物，未放入源码版本控制。

主 HTML 小于 1 MiB，先通过官方 MCP Apps SDK 建立连接，再用标准 `resources/read` 加载七个左右的脚本块（每块最多 4 MiB UTF-8）。所有字体以内嵌数据加载，第三方和字体许可随插件分发。

## 保存和草稿

右上角状态点带可读标签：服务器确认后才显示“已保存”。绘图期间只保留最新待保存内容，同时最多一个写入请求。标题与场景一起按版本保存；撤销和重做也使用相同保存流程。

宿主忙或面板收起、且明确证明请求尚未接纳时，草稿保留，资源读取恢复后再提交。结果未知、版本冲突或权限拒绝会停止自动保存。原请求已接纳时由宿主继续查原回执，插件不会改请求 ID 重放。

有冲突时可以切到别的画板，再切回来继续处理；本地内容保留，可“保存副本”，或确认后“放弃草稿并重载”。已接纳的保存先结算再切换。收起面板保留页面和草稿；重新加载页面、退出应用、撤销插件会丢失尚未保存的页面内存草稿。

## 与 Agent 协作

安装并启用插件后，在 Vykor 会话中输入 `/excalidraw:excalidraw` 调用插件提供的绘图 Skill，例如“画出请求从接收、校验到处理的流程图”。也可明确要求使用 Excalidraw 画图。技能名由插件名 `excalidraw` 与 Skill 名 `excalidraw` 组成。命令行开发校验可用 `vk plugin validate ./plugins/excalidraw`；修改链接插件的清单后，按原链接与权限批准流程重新加载，并在新会话中使用。

选择元素后点击“引用选区到对话”，或使用右键菜单。引用会先等待当前草稿保存，然后固定文档 ID、版本号和元素 ID；切换标签不会替换已引用的目标；用户在聊天中写需求并发送。Agent 使用 `read_scene` 查看最新元素，再用 `apply_operations` 按 ID 局部修改。版本不匹配必须重新读取，不能盲目覆盖。

## 权限和文件

安装时明确授权“写入插件自身数据”。仅 `commit_scene` 可使用这份有限授权；模型调用不能借用页面自动保存授权。创建、导入、副本和工作区导出沿用普通工具确认。

场景写入宿主绑定的插件数据目录 `sessions/<会话摘要>/documents.sqlite`。服务器要求宿主注入数据目录、会话摘要和工作区；缺少时拒绝启动，没有用户目录回退。页面不直接访问文件。

导出限制在当前工作区，检查路径和符号链接，扩展名必须匹配格式；默认拒绝覆盖，勾选覆盖后仍由宿主确认工具操作。场景最多 6 MiB、5000 个元素，单次导出最多 12 MiB。较大的图片或 SVG 可能触及这些界限，失败会保留画板。

这些规则约束正常插件的工具流程。MCP 后台仍执行用户安装的代码，权限标签不构成操作系统文件沙箱。

## 来源与许可证

移植自 [zai-org/zcode-plugins](https://github.com/zai-org/zcode-plugins/tree/413f8b688ee9b5bfc763a9cf5dd1fc5913be99cc/ui-plugins/excalidraw)，锁定提交 `413f8b688ee9b5bfc763a9cf5dd1fc5913be99cc`，上游插件 `0.3.4`，Excalidraw `0.18.1`、React `19.2.7`。复用上游场景处理、SQLite worker、局部操作、导出和界面，适配 Vykor 的清单、SDK 1.1.2、数据目录、保存回执与资源通知。

插件图标沿用同一上游仓库的 `assets/excalidraw/icon.png`。

`LICENSE` 保留上游 Excalidraw 插件的完整 MIT 许可；`licenses/` 保留 Excalidraw、各字体、其他上游许可及仓库 Apache 2.0 声明。构建额外生成 `dist/THIRD_PARTY_NOTICES.txt`，列出实际打包依赖的完整许可。

## 目录导航

- [后台与流程](./src/README.md)：模块协议、编辑流程、存储与文件适配。
- [侧栏应用](./ui/README.md)：离线画板、宿主连接与选区引用。
- [构建脚本](./scripts/README.md)：生成完整发行资源。
- [集成测试](./__test__/README.md)：构建后检查实际 MCP 服务。

模块单元测试放在各模块的 `__test__/`，由 `npm test` 统一执行。用户数据不写入这些源码目录。
