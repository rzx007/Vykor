# 验证与交付

## 分开说明验证到哪一步

1. 独立构建：在生成工程目录使用 Node.js 24 执行 `npm ci`、`npm run build`。入口、页面和依赖必须在本仓库之外也能构建，不能通过工作区依赖或仓库私有 import 才运行。
2. 文件与清单：运行生成工程的 `npm run validate`，检查实际文件、身份、根清单和页面声明；它不依赖 `vk`。有可用 CLI 时再运行 `vk plugin validate <目录>`，记录真实宿主校验结果。两者均不等于执行工具或前端。
3. 业务逻辑：运行 `npm test`，用固定的天气响应检查来源、过期状态、城市和日期边界，用临时数据目录检查保存、重复操作、冲突、会话隔离与导出路径。MCP 还要实际启动 stdio 服务并发现/调用工具；import 成功不代替业务验证。
4. 分发产物：运行 `npm run pack`，检查生成的 ZIP 只包含一个根清单、构建入口与 HTML，名称与版本对应，没有 node_modules、仓库依赖、凭据或用户数据。
5. 宿主激活与交互：仅在用户要求安装或 link 后检查 Tool Host、MCP 连接、组件诊断、真实确认/取消、保存回执和会话切换。代码检查、jsdom 测试、构建成功均不能称为浏览器或桌面验证。按本项目约定由用户查看样式，不主动搭建预览或截图。

只安装 Desktop 的用户不一定有 `vk`。先检测命令是否存在，不要求为了通过一句检查而安装不明 CLI。没有 CLI 时仍完成工程自带校验，并报告未完成静态宿主校验；用户可在插件页导入并查看详情。没有模型或可运行客户端时，不声称完成对应验收。

纯逻辑工具可用 Node 的 `node:assert/strict` 直接测试 `registerTools()` 返回的 invoke；有外部访问和副作用的工具用隔离输入，不在测试里连接生产服务。真实 Tool Host 的权限、超时与取消仍需宿主验证。

默认天气工程的离线测试不会证明 Open-Meteo 当时可访问。真实联网检查与固定响应测试分开报告，并核对实际来源、抓取时间、时区与 stale 状态；无法联网时显示错误或过期缓存，不能用样例数据冒充实时预报。初始化分发测试应覆盖两个新名称和两种后台，确认全局工具名、页面 URI、Skill 声明与宿主命令前缀、清单和包版本一致。还要覆盖 Skill 位于任意父目录（如 dist）时的生成，以及每种生成工程自己的 npm test，不能用源模板同时带着两种适配器的测试代替独立工程测试。

## 安装仅在用户要求时执行

```sh
vk plugin validate ./my-plugin
vk plugin link ./my-plugin --approve ui:render --approve ui:invoke-own-tools
vk plugin list --verbose
vk plugin details example.my-plugin
```

上述批准项只适用于带 UI 的无其他权限插件。天气工程还声明插件数据、固定域名网络与工作区导出权限，必须按真实安装预览逐项批准，不能照抄这条最小命令。Skill-only 插件不应照抄 UI 权限。不要绕过权限确认；创建工程本身不包含安装、更新、替换或发布。

link 用于开发，源目录改动后在没有运行任务的会话使用 `/reload-plugins`。它关闭当前 cwd 的旧 Runtime，后续使用重新加载，不是热更新；ID、版本或权限变化要重新 link 并确认。

正式安装用 `vk plugin install-local <目录>`；Desktop 也支持本地 `.zip`、`.tar`、`.tar.gz`、`.tgz` 或 Git URL/ref 导入。安装后的内容是快照，改源目录不会改变已安装版本。重新导入同一 ID 是更新/修复，新权限要确认，通常从下一次对话生效。

## 打包

打包实际插件目录，不要把整个 create-plugin Skill 分发目录当作 Native Plugin。默认工程使用：

```sh
npm run build
npm run validate
npm run pack
```

包里必须只有一个 `.vykor-plugin/plugin.json`，位于根目录或唯一一层包装目录。包含已生成的 `dist/ui/panel.html`、所选后台入口和插件内 Skill，不能依赖接收者安装 node_modules 后才生成文件。Native 入口构建在 `dist/native/`，MCP 入口为 `dist/server.mjs`；不要同时打入两个可激活后台。默认脚本输出 `dist/<name>-<version>.zip` 与相邻的 `.sha256`。

非默认工程需要手工压缩时，以插件目录名 `my-plugin` 为例，在其父目录执行：

```sh
tar -czf my-plugin.tgz my-plugin
```

使用 ZIP 时确认压缩工具保留 `.vykor-plugin/`；一些工具会跳过隐藏文件。排除 node_modules、凭据、日志、SQLite 数据库、缓存、回执、临时测试数据和符号链接；依赖应在作者侧构建到运行文件里。源工程可以保留 package.json 和锁文件用于作者复现，安装包运行不依赖它们。

## 发布到插件市场

仅在用户要求发布时执行。把作者展示信息写入实际插件根清单，先按 Native manifest 校验，再检查 ZIP 中的图标、介绍和使用示例与清单一致。图标使用内嵌图片数据或 HTTPS，不能用相对路径让市场可展示、安装却失败。

源码先提交推送，市场源再引用固定的完整提交编号与插件相对目录。构建从该提交生成离线包和公开索引；不要提交依赖、临时检出目录或用户数据。市场源的维护命令、上传和部署流程以目标仓库文档为准。

已发布版本的包内容不可覆盖；即使只改图标、简介、示例或许可证，也递增稳定版本，并同步 manifest、package.json 和锁文件中的包版本。保持已有 ID、name 和实际权限声明。

发布前检查实际 ZIP 的唯一清单、入口、许可证、SHA-256 和大小。索引里的版本、来源提交和下载地址必须对应已上传的包。发布后重新读取公开索引，核对图标和示例，再下载包核对摘要与清单；流水线成功不单独作为内容已上线的证据。更新对话应用时保留原安装确认、操作回执和草稿机制，不修改用户快照或数据目录。

## 出问题时

| 表现 | 检查 |
| --- | --- |
| 导入失败 | 包内唯一 manifest、路径、大小、快照诊断 |
| 等待生效 | 新建对话；或在无任务时重新加载插件 |
| 缺少权限 | 重新导入并确认新增权限，不修改批准记录 |
| 工具不可用 | entry 路径、Node 24、运行期 import、local 环境、Tool Host 或 MCP 连接详情 |
| MCP 启动失败 | 已构建的 dist/server.mjs、宿主绑定的 dataDir/session/workspace 完整值、stderr 诊断 |
| 有文字没有 UI | Native metadata.appData 或 MCP structuredContent、apps.json 工具映射、UI 授权、客户端/后台能力、数据大小 |
| UI 操作失败 | 实际注册工具名、真实 inputSchema、当前 availability/controlRevision、会话忙状态 |
| 保存冲突或结果未知 | 保留本地草稿，读取最新 revision 或原 operationId 的回执，不重放写入 |

交付时写明目录、组件、权限、调用入口、已执行的检查和未验证项。发布到哪里、使用哪种许可证、由谁安装由用户决定；不要把未发布 SDK、未完成 GUI 验收或安装成功包装成完整运行验证。
