---
name: office-excel
description: 创建、读取和局部修改普通 XLSX 报表，支持多工作表、文字数字、公式、基础格式、列宽、冻结和筛选，核对公式缓存与预测结果，并保存区域截图及版本绑定的检查记录。
---

# Excel 常用报表

只使用 OfficeExcel 工具处理当前工作区内的 .xlsx，不安装依赖，不通过 Shell、通用 Write 或原始 XML 改写最终文件。应用内置读取与只读预览继续承担附件浏览；本技能负责创建、编辑与交付检查。

## 创建

OfficeExcelCreate 输入 path 和 sheets。每张表包含 name、rows，可选 columns（从 A 列开始的列宽数字数组，5–80）、freeze（如 A2 冻结首行）、filter（如 A1:D20）。先收齐工作表与公式计划，一次创建后在同一成果上局部修改，不反复创建多个候选文件。

最多 8 张表、每表 200 行26列、共5000个非 null 单元格。null 跳过，空字符串表示空文字。第一行默认表头样式，显式 bold/fill 可覆盖。文字始终写为文本，编号、前导零、超过15位的标识符用字符串；数字用 JSON number，避免把日期和编号猜成数字。

单元格可以是文字／数字，或 {value:120,format:"#,##0.00"}、{formula:"SUM('明细'!B2:B3)",format:"0.00"}。value 与 formula 互斥；formula 可带开头等号。以等号开头的普通字符串仍按文字保存。基础样式支持 bold、fill、color（#RRGGBB）、wrap、align（left/center/right）、format（Excel 数字格式）。公式引用的工作表先统一创建，再写内容。不支持外部工作簿引用、网络公式或宏。

```json
{"path":"office-work/excel-demo/report.xlsx","sheets":[{"name":"明细","rows":[["编号","金额"],["00123",100],["00456",50]],"columns":[18,18],"freeze":"A2","filter":"A1:B3"},{"name":"汇总","rows":[["合计",{"formula":"SUM('明细'!B2:B3)","format":"#,##0.00"}]],"columns":[18,18]}]}
```

## 读取和局部修改

OfficeExcelRead 默认 target:"/" 仅列工作表；读取内容须使用实际返回的工作表名及 /明细/A1:B10、/明细/A2 或 /明细。每个矩形区域最多2000个单元格。普通工作表完整回读仍受工具输出大小限制，遇到内容不完整必须缩小范围，不能据截断结果修改。

OfficeExcelEdit 输入 path、最新 expected_sha256 和 operations（最多100个不同单元格），每项 {path:"/明细/B2",props:{value:120}}。props 与创建时单元格对象相同，空字符串清空内容，格式单独修改会保留原值及公式。用户已有文件默认另存 -edited.xlsx；插件在当前工作区创建且记录过的成果可原位继续修改。已有目标不能覆盖，文件版本不一致必须重读。

首版仅编辑普通单元格工作簿；合并、保护、条件格式、验证、图表、表对象、透视表、外链等复杂内容会拒绝编辑。行列增删、排序、图表、宏、.xls/.xlsm 不在首版范围，不通过改扩展名规避。change_check 核对完整回读中的范围外单元格内容、格式及公式；依赖公式的计算结果允许变化，不能误判成无关单元格改写。此检查不证明整个 Office 文件包或原生排版完全不变。

## 公式与结构检查

创建和编辑会执行结构及问题检查，交付前用 OfficeExcelCheck 核对当前版本。formula_check 分开返回 formula、cached_value、computed_value，以及 stale_cache_cells、unverified_cells、error_cells。

cached_value 是文件中的缓存，可能过期；computed_value 是 OfficeCLI 计算器的预测。evaluated=true 可能仅有缓存，不能当成已计算正确。不能计算、缓存过期或公式错误必须说明，不能只看 issues 数量为0就通过。evaluator_all_computed 不代表业务公式正确；calculation_verified 和 excel_recalculation_verified 均为 false，不声称已在 Excel/WPS 完整重算。抽查输入与代表性结果，保留公式，不用预测值替换公式，也不擅自刷新原文件。

## 区域截图与记录

OfficeExcelPreview 输入 path、sheet、range（如 A1:D12，最多12列40行）。返回 PNG 与 preview_id、sha256、实际工作表和范围；通过图片结果实际查看列宽、文字截断、单位和数字格式。截图可能需约30秒，不反复并发重试。HTML区域不是 Excel/WPS 原生打印页，不把区域截图说成整张表或整份工作簿已验收。

实际看图后用 OfficeExcelReview 输入 path、expected_sha256、regions，每项 {preview_id,conclusion:"passed"或"issues",findings:"实际看到的内容与问题"}。每轮返回独立 record_path，旧检查文件不被覆盖；同版本当前汇总按工作表和区域合并。检查结论只覆盖记录的区域，来源为模型报告；图像成功生成不等于检查通过。当前版本变化后必须重截，不套用旧结论。不做自动修复循环。

交付实际路径、文档版本、修改单元格、公式与缓存限制、实际检查区域及本轮 record_path；保留来源、单位、假设和数据限制，不编造业务数据。

应用异常退出后，新版工具只在确认本机原持有者进程已退出时，关闭并清理其已登记工作副本，再恢复操作。活跃或无法确认的持有者、旧版空锁与无登记目录不自动回收；遇到 office_recovery_required 应报告具体路径和原因，不通过 Shell 删锁、强杀进程或反复重试，不擅自换目录重建成果。
