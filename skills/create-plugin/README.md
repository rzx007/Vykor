# create-plugin

可独立分发的 Native Plugin 开发 Skill。发布整个目录，保留 SKILL.md、references 和 assets；按个人或项目 Skill 的原安装方式使用。

assets/text-inspector 是 Native Tools + 官方 MCP Apps 页面样例。复制后执行 npm ci、npm run build；作者先准备锁定的官方 ext-apps 1.1.2 和 esbuild 依赖。生成 panel.html 为离线单文件，最终用户安装时不构建、不下载依赖。Native Tool 无额外运行依赖或 MCP 进程。

根清单和 apps.json 使用 schemaVersion 1，入口 components.apps。工具结果提供 metadata.appData；页面 callServerTool、updateModelContext、sendMessage 使用官方 API。按原重新导入流程升级版本，不修改安装快照或 dataDir。
