---
name: office-work-entry
description: 在本应用中创建、读取、修改或检查 Word、Excel、PPT 文件时使用；主 Agent 和工作 Agent 在加载 OfficeCLI 官方技能前均先加载此接入技能。
---

# Office 文档接入

本技能说明本应用的执行入口；官方 Skill 负责文档制作方法。无需创建专家，主 Agent 可以直接完成任务。本技能不授予新权限，只使用本轮已授权的工具。

## 先发现执行工具

1. 当前请求已有 OfficeCLI 工具定义时直接调用，不重复搜索。
2. OfficeCLI 定义未暴露时，先调用 `ToolSearch({"query":"OfficeCLI","limit":1})`。核对返回工具名为 `OfficeCLI`，来源为插件 `vykor.office-work`；返回后等到下一次模型请求，按实际工具定义调用。
3. ToolSearch 不可用、搜索无匹配、没有返回正确来源，或下一次请求仍没有定义时，停止 Office 操作并报告该工具不可用。不得通过 Shell 检查版本、安装或调用全局 officecli、插件内二进制或另一份引擎；不得搜索磁盘、解压插件或自写脚本替代入口。实际调用被拒绝时同样不得绕过，说明错误和未完成部分。

## 再加载官方方法

加载 `Skill({"name":"office-work:officecli"})`，按格式再加载一个：Word 用 `office-work:officecli-docx`，Excel 用 `office-work:officecli-xlsx`，PPT 用 `office-work:officecli-pptx`。同名或路径不确定时，用 ListSkills 的 ownerPluginId=`vykor.office-work` 查询当前条目，使用实际名称和路径。

官方正文保持原样。官方示例中的安装、Shell、MCP 参数形式和驻留生命周期说明不适用于本应用执行入口；不要照搬到 Shell。缺少专项技能时报告限制，不自动下载。

## 把官方示例交给 OfficeCLI 工具

- 示例 `officecli help pptx shape --json` 对应 `OfficeCLI({"command":"help","args":["pptx","shape","--json"]})`。先按当前引擎 help 确认语法，不猜属性。
- 动词放 command，成果文件放 path，其余参数逐项放 args；去掉 officecli、文件路径和 shell 引号，不传管道、重定向、变量或 `$FILE`。
- 原生 batch 数组放 operations，不使用 `--input` 或临时批处理文件。插件自动管理工作副本、排队与关闭，不调用 open/save/close。
- 创建使用新工作区路径，不覆盖已有成果。修改前读取最新 sha256，写入传 expected_sha256；后续使用工具顶层返回的实际 path 和 sha256，不使用原生结果内的工作副本路径。用户原文件默认另存。
- 局部修改按实际对象路径传 scope_targets；不传时不声称范围检查通过。工具拒绝版本或路径时先核对，不取消保护或改走 Shell。

## 检查与交付

显式回读、检查问题并 validate，执行成功不等于结构、范围或视觉检查通过。PPT 截图使用 OfficePptPreview，实际看图后用 OfficePptReview 记录所看页面及对应文件版本；Word、Excel 使用对应的插件 Preview/Review 工具。定义未暴露时，按上面的 ToolSearch 流程逐个发现并核对来源，不预先批量加载。

Preview 工具不可用时标记视觉未检查，不改用 Shell 截图；Review 不可用时说明没有版本绑定检查记录。只报告实际检查的页面或区域，修改后旧版本检查不代表新版本通过。

等待本轮所有 Office 调用返回后再核对工作副本与锁的清理；不删除运行中的副本或锁。交付实际成果路径、版本、已检查项和未验证项，保留来源、内部假设与人工复核要求。
