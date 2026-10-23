# office-work：办公文档

版本 0.12.3，通过 OpenHarness 插件市场独立构建和分发，插件 ID 保持 `vykor.office-work`。在市场中找到“办公文档”并按应用展示的权限列表安装，也可导入市场生成的 ZIP。同 ID 安装用于更新；原有 dataDir、检查历史和启用状态沿用宿主的更新规则，构建不会接触这些运行数据。

主 Agent 与工作 Agent 均先加载 `office-work-entry`，再加载官方基础与对应格式 Skill。入口说明工具尚未暴露时通过 ToolSearch 查找 OfficeCLI，并在下一次请求调用；不可用时停止，不通过 Shell 调用全局引擎。官方 Skill 原文保持不变。

使用固定版本 OfficeCLI 官方 Skill 创建、读取和修改 Word、Excel、PPT。四份官方技能原文位于 vendor/officecli/skills，与归档内 v1.0.139 引擎一致，来源和摘要见 vendor/officecli/SOURCE.json；不安装全局技能。

编辑入口只有 **OfficeCLI**：原生命令放 command，文件放 path，其余参数放 args，原生 batch 数组放 operations。模型先查官方 help，再按官方技能操作，不经过 shell，也不维护编辑属性白名单。原 Create／Read／Edit 工具、对应重复实现和三个旧自定义 Skill 已删除。

保留九个交付工具：OfficeWordCheck／Preview／Review、OfficePptCheck／Preview／Review、OfficeExcelCheck／Preview／Review。它们检查结构、返回指定页或区域图片，并保留与文件版本绑定的独立检查历史。

文件保护继续复用工作区路径限制、文件占用提示、同文件排队、私有工作副本、关闭清理和重启恢复。用户文件默认另存，编辑需要最新 expected_sha256；成果保存在工作区，记录保存在插件 dataDir，不修改用户已有文档或检查记录。

局部修改可选 scope_targets，复用 Word 正文路径、PPT 页面和对象、Excel 单元格与文件包检查；范围外变化会阻止发布。不传时明确 scope_verified:false，不能声称已自动证明只改目标区域。范围核对、结构验证与实际看图是不同结论。

详见 [官方技能接入](docs/official-skills.md) 和 [范围核对边界](docs/editing-scope.md)。已有真实引擎测试以 Windows x64 为主；其余平台需要实机验证，随包分发不代表已经完成各平台业务验收。

## 独立构建与归档

需要 Node.js 24 或更高版本，从本仓库检出源码后在本目录执行：

```sh
npm ci --ignore-scripts
npm run build
npm test
```

`npm run build` 从 `packages/services/src/office/office-engine.mjs` 复制共享引擎模块到 `tools/office-engine.mjs`，按该模块固定的 v1.0.139 下载并核验 Windows、macOS、Linux 的 x64 和 arm64 六个程序到 `bin/`。构建与桌面打包无关，Windows 的 `scripts/build.ps1` 只是同一 Node 入口的薄封装。无 npm 依赖；首次完整构建需要联网访问 OfficeCLI 官方 GitHub Release。

下载缓存默认位于 `~/.cache/vykor-officecli/v1.0.139`；`OFFICECLI_CACHE_DIR` 可指定缓存父目录。已有 `bin/` 或缓存每次复用前都检查 SHA-256。下载先写临时文件，摘要不匹配不会进入缓存或发行目录；缓存损坏会明确失败，删除报错指出的缓存文件后重建。官方四份 Skill 在构建前后检查完整正文、来源及摘要。

市场打包器将 manifest、`agents/`、`skills/`、`tools/`、`vendor/`、`bin/`、文档、LICENSE 和第三方许可放入一个通用 ZIP，保留官方技能目录和完整正文。构建仅准备这些发行文件，市场负责生成归档；源码内的 `out/` 是本地临时产物，不作为发行输入。归档安装后按当前平台选择 `bin/` 内程序并再次核验，不联网下载、不查找全局 OfficeCLI。Unix 的可执行权限若被 ZIP 解包丢失，运行器只给摘要通过的程序恢复权限。

`npm test` 离线运行单元测试，跳过以 `real OfficeCLI:` 开头的真实引擎用例，不下载程序。完整构建后可在 Windows x64 执行 `npm run test:native`，覆盖已有真实 Word、Excel、PPT 用例；其他平台的原生集成测试尚待补齐。修改后的 ZIP 可用 `node scripts/verify-official-skills.mjs . /absolute/path/plugin.zip` 再核对包内官方技能。

## 目录导航

- [插件清单](.vykor-plugin/plugin.json)：工具入口、权限、角色与技能目录。
- [构建与校验脚本](scripts/README.md)：六平台发行准备、缓存、归档内官方技能检查及离线测试入口。
- [工具实现](tools/README.md)：文件限制、工作副本、原生命令、预览与检查历史。
- `agents/` 与 `skills/office-work-entry/`：主助手和专家的调用说明；`vendor/officecli/`：固定上游技能原文和来源摘要。
- [边界说明](docs/README.md)：技能接入和局部修改核对。
- [新增发行回归测试](__test__/README.md)与 `test/`：构建和已有工具测试。
- `licenses/`、[LICENSE](LICENSE) 与 [第三方声明](THIRD-PARTY-NOTICES.md)：随归档分发。
