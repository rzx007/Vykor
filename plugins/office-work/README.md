# office-work：办公文档

主 Agent 与工作 Agent 均先加载 `office-work-entry`，再加载官方基础与对应格式 Skill。入口说明工具尚未暴露时通过 ToolSearch 查找 OfficeCLI，并在下一次请求调用；不可用时停止，不通过 Shell 调用全局引擎。官方 Skill 原文保持不变。

0.12.0 使用固定版本 OfficeCLI 官方 Skill 创建、读取和修改 Word、Excel、PPT。四份官方技能原文位于 vendor/officecli/skills，与内置 v1.0.139 引擎一致，来源和摘要见 vendor/officecli/SOURCE.json；不安装全局技能，不下载第二份引擎。

编辑入口只有 **OfficeCLI**：原生命令放 command，文件放 path，其余参数放 args，原生 batch 数组放 operations。模型先查官方 help，再按官方技能操作，不经过 shell，也不维护编辑属性白名单。原 Create／Read／Edit 工具、对应重复实现和三个旧自定义 Skill 已删除。

保留九个交付工具：OfficeWordCheck／Preview／Review、OfficePptCheck／Preview／Review、OfficeExcelCheck／Preview／Review。它们检查结构、返回指定页或区域图片，并保留与文件版本绑定的独立检查历史。

文件保护继续复用工作区路径限制、文件占用提示、同文件排队、私有工作副本、关闭清理和重启恢复。用户文件默认另存，编辑需要最新 expected_sha256；成果保存在工作区，记录保存在插件 dataDir，不修改用户已有文档或检查记录。

局部修改可选 scope_targets，复用 Word 正文路径、PPT 页面和对象、Excel 单元格与文件包检查；范围外变化会阻止发布。不传时明确 scope_verified:false，不能声称已自动证明只改目标区域。范围核对、结构验证与实际看图是不同结论。

详见 [官方技能接入](docs/official-skills.md) 和 [范围核对边界](docs/editing-scope.md)。Word 原有截图尺寸／格式失败仍是已知问题，本轮没有改动截图实现，不能据此宣称 Word 全流程验收完成。

打包：运行 scripts/build.ps1，产物为 apps/desktop/out/bundled-plugins/office-work.zip。Windows x64 已实测；其他平台仍需实机验收。源码、第三方技能与原始许可一并打包。
