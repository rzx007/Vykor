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

## 原生图表

创建时每张表可提供 charts（最多4张），每项含 type（column/line）、title、dataRange、可选 categories、anchor、category_title、value_title、axismin、axismax。dataRange 为含一行表头的真实数据区域，categories 为单列分类区域，不含表头且与数据行数一致；不传 categories 时，dataRange 首列作为分类，后续列为数据系列。示例：{type:"column",title:"销售额",dataRange:"明细!B1:B4",categories:"明细!A2:A4",anchor:"D2:L18",category_title:"月份",value_title:"金额（元）"}。anchor 须为4–12列、4–40行的矩形。柱状图默认数轴从0开始，不把不同单位混放到同一数轴。

已有工作簿追加图表：单独提交 {action:"add_chart",path:"/汇总",props:{...上述图表字段}}。修改现有图表：先读取 /汇总/chart[1]，再单独提交 {action:"update_chart",path:"/汇总/chart[1]",props:{title:"新标题",value_title:"金额（元）",axismin:0}}。可修改标题、位置与坐标轴文字／边界；不支持直接替换已有图表类型或数据绑定，源数据通过单元格编辑更新。不要用图片或文字条形冒充可编辑图表。

工具保存前检查图表类型、标题、系列数量、真实单元格绑定、坐标轴边界及位置；Check 对有图表的文件另做 chart_cache_stale 扫描。图表缓存可随输入变化，不把派生缓存变化误报成无关修改。交付仍需实际看图；截图范围应覆盖图表 anchor，如 D2:L18，而不是只截源数据。

## 普通工作簿行列增删

每次单独提交一项：{action:"insert_rows",sheet:"明细",index:2,count:1}、delete_rows、insert_columns、delete_columns。index 从1开始，列也用数字（A=1），单次最多20行／列；不与单元格或图表操作混用。插入先生成空行／列，再重新读取新位置填写数据。

删除必须先读取完整删除带内的实际内容，再提供 expected_cells 数组，每项 {path:"/明细/A2",expected_text:"00123"}；公式单元格还需 expected_formula。expected_text 使用 Read 返回的 text 原样填写。数组必须覆盖删除范围内全部非空单元格，不提供证据不能删除，空带明确传 []。不要猜行列编号。读取 /明细/row[2]、/明细/col[A] 或对应区域以定位；内容不完整时不执行。

保存前核对整带位置映射、其他工作表、数据与格式，并检查 A1、绝对引用、跨表引用和区间收缩。不能验证的结构化／外部／三维引用会拒绝保存；派生公式结果可能变化，应重新检查。复杂工作簿的合并、表对象、条件格式、验证、命名范围、图表等引用重排暂不支持，遇到此类文件不能强行执行行列增删。

## 复杂工作簿保留编辑

含合并、条件格式、验证、表对象、命名范围、图片、图表或批注时，可在保留已有结构的前提下修改普通单元格。合并区域仅改左上角主单元格。保存前核对范围外单元格、原有样式、规则、表定义、对象关系和二进制部件；不接受无关对象或图表绑定变化。

这不等于支持编辑复杂结构本身：宏、外部连接、透视表、富数据、签名、保护文件，以及共享／数组公式和富文字目标单元格仍有明确限制。不能只删除限制判断来绕过核对，也不能通过通用 Shell 改写文件。OfficeExcelCheck 的 workbook_capabilities 说明可编辑范围；preservation 说明本次保留核对结果。结构检查不证明 Excel/WPS 原生显示完全一致。

## 公式与结构检查

创建和编辑会执行结构及问题检查，交付前用 OfficeExcelCheck 核对当前版本。formula_check 分开返回 formula、cached_value、computed_value，以及 stale_cache_cells、unverified_cells、error_cells。

cached_value 是文件中的缓存，可能过期；computed_value 是 OfficeCLI 计算器的预测。evaluated=true 可能仅有缓存，不能当成已计算正确。不能计算、缓存过期或公式错误必须说明，不能只看 issues 数量为0就通过。evaluator_all_computed 不代表业务公式正确；calculation_verified 和 excel_recalculation_verified 均为 false，不声称已在 Excel/WPS 完整重算。抽查输入与代表性结果，保留公式，不用预测值替换公式，也不擅自刷新原文件。

## 区域截图与记录

OfficeExcelPreview 输入 path、sheet、range（如 A1:D12，最多12列40行）。返回 PNG 与 preview_id、sha256、实际工作表和范围；通过图片结果实际查看列宽、文字截断、单位和数字格式。截图可能需约30秒，不反复并发重试。HTML区域不是 Excel/WPS 原生打印页，不把区域截图说成整张表或整份工作簿已验收。

实际看图后用 OfficeExcelReview 输入 path、expected_sha256、regions，每项 {preview_id,conclusion:"passed"或"issues",findings:"实际看到的内容与问题"}。每轮返回独立 record_path，旧检查文件不被覆盖；同版本当前汇总按工作表和区域合并。检查结论只覆盖记录的区域，来源为模型报告；图像成功生成不等于检查通过。当前版本变化后必须重截，不套用旧结论。不做自动修复循环。

交付实际路径、文档版本、修改单元格、公式与缓存限制、实际检查区域及本轮 record_path；保留来源、单位、假设和数据限制，不编造业务数据。

应用异常退出后，新版工具只在确认本机原持有者进程已退出时，关闭并清理其已登记工作副本，再恢复操作。活跃或无法确认的持有者、旧版空锁与无登记目录不自动回收；遇到 office_recovery_required 应报告具体路径和原因，不通过 Shell 删锁、强杀进程或反复重试，不擅自换目录重建成果。
