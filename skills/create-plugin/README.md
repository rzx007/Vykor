# create-plugin

可独立分发的 Vykor 插件开发 Skill，包含当前 Native Plugin 接口、插件 UI 说明和可离线构建的工具＋UI 样例。不是 Vykor 内置技能，也不是一个需要直接导入插件页的 Native Plugin 包。

发布单位是整个 `create-plugin/` 目录。请保留 `SKILL.md`、`references/` 和 `assets/`；只发布 `SKILL.md` 会丢失接口和 SDK。发布前由你选择版本、许可证与发布渠道，本目录没有替你创建远程仓库或执行上传。

用户可手动把目录安装为个人 Skill（例如 `~/.vykor/skills/create-plugin/`），或放到项目的 `.vykor/skills/create-plugin/`。使用支持 Agent Skills 的其他工具时，放到该工具自己的技能目录。安装后按工具的刷新方式重新发现技能；Vykor 可通过 `/create-plugin` 或 `Skill` 工具调用它。

工具＋UI 样例位于 `assets/text-inspector/`。复制到新的开发目录后，可直接修改并运行 `node scripts/build-ui.mjs`；不需要本仓库、pnpm、Vite 或 npm SDK。样例的普通 Node 工具没有运行依赖，构建后的 UI 不访问外部资源。

接口基于 Native manifest schemaVersion 1、UI 定义 schemaVersion 1 与 UI bridge version 1。是否能显示交互仍取决于安装的 Desktop、后台版本和用户授权；本 Skill 不升级用户的桌面程序。
