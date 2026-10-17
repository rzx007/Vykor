---
name: office-word
description: 创建带表格的 A4 DOCX 报告，增删正文段落及矩形表格行列、调整整段或段内文字格式，支持章节分页、默认页眉页脚、动态页码、图片图注来源，检查结构、查看 HTML 截图并按版本保存逐页发现。
---

# Word 报告

使用固定版本 OfficeCLI，仅操作当前工作区内、不超过 64 MB 的 .docx。先读取原报告和来源，保留数字、出处和证据限制，不编造资料。不通过 Shell、通用 Write 或直接改 XML 绕过工具。

## 创建与排版

OfficeWordCreate 输入 path、title、blocks，默认保存 office-work/<topic>/report.docx，不覆盖已有文件。blocks 按顺序包含 paragraph、table 或 image，最多 120 项。标题使用 Title；正文样式可选 Normal、Heading1、Heading2，对齐可选 left/center/right/justify。paragraph 可设置 pageBreakBefore（段前另起一页）、keepNext（与下一段同页）、keepLines（整段尽量不拆页）、widowControl（避免首尾孤行），均为布尔值；标题默认 keepNext、keepLines 为 true。默认 A4 纵向、四边 2.54cm、Microsoft YaHei、1.5 倍行距；标题 22pt、一二级标题 16/14pt、正文 11pt。

表格 rows 为矩形文字/数字数组，最多 20 行、8 列，单元格最多 2000 字符，可为空。列宽默认平均分配，colWidths 可指定 cm 数组，总宽须为正文宽 15.92cm，每列至少 1.27cm。表头重复，行高随文字增长，不设会裁切文字的固定行高。长表优先精简或拆表，不缩成不可读的小字。表格后的证据限制与来源使用后续 paragraph，按文档流排列。

示例：
```json
{"path":"office-work/example/report.docx","title":"方案评估","blocks":[{"type":"paragraph","style":"Heading1","text":"方案比较"},{"type":"table","colWidths":["5cm","10.92cm"],"rows":[["方案","边界"],["工具结果引用","以宿主契约为准"]]},{"type":"paragraph","text":"证据限制：缺少直接实现证据的结论保留为待确认。"}]}
```

## 读取与修改

OfficeWordRead 默认 /body，可按实际返回路径读取表格、行、单元格或段落。depth 可选 1–8；查看表格行列原文用 depth:4，查看段落文字片段用 depth:1。OfficeWordEdit 须使用实际路径和最新 expected_sha256。一次最多 20 项，每个目标段落只接受一项操作；文字和格式修改可以合并。所有路径先绑定到修改前的段落，增删不按变化后的序号猜位置。全部回读符合预期并通过结构检查后才保存。正文路径如 /body/p[@paraId=00100004]，单元格段落如 /body/tbl[1]/tr[2]/tc[2]/p[1]，不要猜编号。

operations 的 action 可选：
- update（默认）：props 包含字面 find/replace 和／或格式。find 必须恰好出现一次，replace 可为空。
- insert_before / insert_after：在指定正文段落前／后增加段落，props 含非空 text，可附格式。沿用创建报告的中文字体和默认间距；不插入表格内部。
- remove：删除指定正文段落，props.expected_text 必须与刚读取的整段原文完全一致；不删除表格单元格段落，正文至少保留一个段落。
- format_text：在正文或单元格内的普通文字段落中，props.find 须恰好出现一次；设置所选文字的 bold、italic、size、color，可组合。不是正则匹配；不传 replace。工具定位字符范围并核对范围外文字格式，含超链接、字段、复杂内嵌对象的段落会拒绝，不拆改。

update 的格式作用于目标**整段**；段内部分文字使用 format_text。支持 style（Normal/Heading1/Heading2）、align、bold/italic（布尔）、size（8–36pt，半磅精度）、color（#RRGGBB）、spaceBefore/spaceAfter（0–48pt，半磅精度）、lineSpacing（1x/1.15x/1.5x/2x），以及上述分页控制布尔项。不改全局样式定义；仅改 style 名称不会清除该段已有的直接字号等格式，需要时明确一并设置。缺少稳定 paraId 的旧文档暂不增删，不能猜路径或绕过检查。

示例：
```json
{"path":"office-work/example/report.docx","expected_sha256":"读取返回的64位摘要","operations":[{"action":"update","path":"/body/p[@paraId=00100004]","props":{"find":"待确认","replace":"依据有限证据支持","bold":true,"size":"12pt"}},{"action":"insert_after","path":"/body/p[@paraId=00100006]","props":{"text":"证据限制：仍需原始资料复核。"}}]}
```

## 分页、页眉页脚和页码

现有段落使用 update 的 props 设置 pageBreakBefore、keepNext、keepLines、widowControl，须指定实际段落路径和最新摘要；可设 false 关闭。这些是 Word 排版标志，不能保证内容放不下时仍在同一页。修改后重新截图检查所需页。

创建时可传 page_settings，必须同时提供 header、footer（各最多 80 字符的单行文字，可为空）、page_numbers（布尔）。默认页眉右对齐、页脚居中、Microsoft YaHei 9pt，距页边 1.27cm；启用页码时 footer 文字后添加分隔符及真实 PAGE 域，十进制、从 1 开始，并设置打开时更新字段。空 header 移除页眉；空 footer 且 page_numbers=false 移除页脚。

修改时单独提交一项 {action:"page_settings",path:"/body/sectPr[1]",props:{header:"报告名称",footer:"内部资料",page_numbers:true}}。三项表示目标完整设置，替换当前默认页眉页脚，须先读 /header[N]、/footer[N] 和节设置。仅支持单节、统一默认页眉页脚；首页不同、奇偶页不同、多组或含图片／链接／非 PAGE 复杂字段的页眉页脚会拒绝修改。不会套用到多个节。

页码保存的是动态域，写入时缓存可能仍为 1，真实页码需由 Word 打开后更新；WPS 需实际验收更新情况。返回 pagination_verified:false，不把 HTML 预览中的缓存数字当成最终分页，不手工填静态页码冒充动态域。page_settings 结果绑定本次文件 sha256；OfficeWordCheck 只附带当前版本成果记录中的设置。

## 图片、图注与来源

创建 blocks 可包含 {type:"image",src:"assets/chart.png",width:"12cm",height:"18cm",caption:"图 1：比较结果",source:"资料名称或出处",alt:"图像说明"}。caption、source 必填且为最多 200 字符的单行文字；alt 可选，默认图注。图注编号由实际内容明确给出，不自动改已有图号。

图片仅限工作区内本地 PNG/JPEG（最多 10 MB、4000 万像素，单次最多 8 张），不读取 URL、data URI 或越出工作区的链接。width、height 是最大尺寸框，默认 12cm × 18cm，宽上限 15.92cm、高上限 20cm；保持原图比例缩放，实际尺寸会返回。单节 A4 正文区域放不下图片与图注时要求缩小尺寸。

采用随正文排列的内嵌图片，下方独立放置图注和“来源：…”段落；图片及图注设置与下一段同页，仍需看图确认跨页效果。先复制来源图片到本次工作副本，嵌入后核对图片字节摘要、尺寸、替代文字及图注来源。image_sources 返回实际来源路径、来源描述、图片摘要、尺寸、图片路径及本次 DOCX 的 sha256；它只表示本次插入已核对，不自动沿用到其他文件版本。

修改已有报告时，单独提交一项 {action:"insert_image",path:"刚读出的正文稳定段落路径",props:{src:"assets/chart.png",width:"6cm",height:"4cm",caption:"图 2：补充证据",source:"资料出处"}}，插在该段之后，记录图片、图注、来源三个新增段落及实际图片路径。不在表格、页眉页脚中插图，不提供浮动绕排、裁剪或替换已有复杂图片的接口。原始图片和旧文档不被修改。

## 已有表格排版与行列增删

以下 action 的 path 均为实际正文表格路径，如 /body/tbl[1]。每张表每次只提交一项表格操作，不与该表内部段落编辑混用；每次完成后重读最新路径和 sha256。仅支持最多 20 行、8 列、无合并单元格、无嵌套表格的矩形表格。

- table_layout：props 可选 colWidths（所有列的 cm 数组）、repeat_header（首行是否重复）、allow_row_split（是否允许行跨页）。至少设置一项。只切换首行表头标志，其他已有表头行保留；多行表头不在本轮范围。
- insert_row：props.index 为从 1 开始的位置，在该行前插入；末尾使用原行数加一。values 为新行每列的文字，数量须与列数一致。新行为普通行、默认禁止行内跨页；首行前插入后如需新表头，再重读设置 table_layout。
- remove_row：props.index 指定行，expected_values 为刚读出的该行所有单元格原文，须完全一致。至少保留一行；删除首行不会自动把下一行标为表头。
- insert_column：props.index 与插行规则相同；values 为自上而下每行的新单元格文字。colWidths 必须给出修改后全部列宽。
- remove_column：props.index 指定列，expected_values 为刚读取的该列自上而下原文。colWidths 必须给出删除后全部列宽，至少保留一列。

列宽每列至少 1.27cm，总宽不能超过当前单节报告的正文宽度。无法确定页边距、多节文档、合并单元格等情况不调整列宽，不重建表格绕过限制。新单元格采用 Microsoft YaHei、10.5pt；保留已有单元格原文与格式，不猜 CSV，不使用固定行高裁切文字。允许跨页只表示写入对应标志，实际排版仍需截图及 Word/WPS 验收。

示例：
```json
{"path":"office-work/example/report.docx","expected_sha256":"读取返回的64位摘要","operations":[{"action":"table_layout","path":"/body/tbl[1]","props":{"colWidths":["5cm","10.92cm"],"repeat_header":true,"allow_row_split":false}}]}
```

修改返回 change_check，并写入当前成果记录。包含 source_sha256、sha256、请求操作和实际 updated_paragraphs / inserted_paragraphs / removed_paragraphs、updated_tables、formatted_text_ranges（段落路径、find 及从 0 开始且右端不含的字符范围）。OfficeWordCheck 仅附带当前文件版本匹配的 change_check。检查 scope=officecli_body_tree：核对完整正文回读树中的未请求段落、表格与节设置；无法完整读取或发现无关改动就不保存。普通正文修改不覆盖全部 OOXML 部件或页眉页脚；page_settings 单独核对正文、默认页眉页脚及相关设置，scope=officecli_body_and_default_stories。上述检查都不证明视觉不变。增删、字号或间距修改可能让后文重新分页，需要查看受影响的 HTML 渲染页并为新版本重做看图记录。

用户已有文件默认另存 -edited.docx；插件成果依据 dataDir/documents 记录持续修订。摘要变化先重读，保留手工修改。占用提示按具体原因处理，不杀进程、不删除锁、不循环重试。工作副本沿用关闭与清理流程，清理警告不等于文件未保存。

## 检查与看图记录

OfficeWordCheck 回读正文、检查 OpenXML 结构，附带当前版本的 visual_review。结构检查不是视觉检查。

支持看图时调用 OfficeWordPreview，输入 path 和单个 page，查看必要的 HTML 渲染页，关注表格、证据限制、跨页和字体。当前仅支持统一 A4 纵向报告；页码依据 OfficeCLI HTML 分页，不等于 Word/WPS 原生页码。不拿段落数当页数，不假报总页数。没有有效单页图片时报告错误，不安装浏览器或自动切换渲染器。0.7.2 预留页面外边距和滚动条宽度，避免响应式缩放污染裁切；先触发完整分页再提取指定页，避开 OfficeCLI 的单页快速路径；截图记录 capture_method=word-paginated-strip-v2。rendered_pages 仅表示本次渲染的前序页范围，不是文档总页数。像素格式或页面几何不受支持时明确失败，不返回可能错页的图片。

实际看图后调用 OfficeWordReview，传 path、截图返回的 expected_sha256 和 pages 数组，每项含 preview_id、checks。checks 必须包含 body、header、footer、pagination 四项；每项含 status 与非空 observation。status 可选 passed、issues、uncertain、not_applicable。只在文档未设置对应页眉／页脚时可给该项 not_applicable，正文与分页不能跳过。不再直接提交整页 conclusion 或 findings；由工具根据四项检查生成它们，任何 issues 或 uncertain 都使整页及汇总结论为 issues。

每页独立观察：body 记录正文末行、表格图片与图注来源是否完整、是否越过页脚；header 记录该页实际看见的页眉文字和位置；footer 记录实际页脚文字与显示数字；pagination 记录本页起止内容及与相邻页的衔接。不能把 XML 存在页眉引用当作截图已显示页眉，不能从第一页推断其他页。出现缺失、截断、溢出、重叠或重复正文即填 issues，即使怀疑是渲染器问题也不能标 passed。看不清或无法确认填 uncertain；没有实际看图或没有图片输入能力就不保存视觉记录。

示例（只有实际观察符合时才这样填写）：
```json
{"path":"office-work/example/report.docx","expected_sha256":"截图返回的64位摘要","pages":[{"preview_id":"截图返回的编号","checks":{"body":{"status":"issues","observation":"正文末段进入页脚区域，无法确认内容完整。"},"header":{"status":"issues","observation":"该页未显示文档要求的页眉。"},"footer":{"status":"passed","observation":"底部居中可见“验收稿 · 2”。"},"pagination":{"status":"uncertain","observation":"尚未核对相邻页衔接。"}}}]}
```

记录仍核对文件版本、截图编号和图片摘要，标记 review_protocol=word-page-checks-v1。同版本逐页合并，重查某页替换该页发现；新版本不能沿用旧结论。旧版截图须重新生成；旧版自由文字检查历史保留，但不作为新版有效检查返回。四项约束不会自动理解图片，观察仍由模型报告，不能证明模型没有误看。

交付实际路径、sha256、结构检查、实际查看的 HTML 页码与逐页发现。记录来源 model_reported，范围 checked_pages_only；部分页通过不能说全稿通过。不同文件和版本不能混用截图。visual_checked:false 表示工具没有自动做视觉判断。不做自动修复循环。

本轮不做合并单元格、嵌套表格或复杂表格重构、浮动图片、修订、批注、任意字段、分节或复杂页眉页脚修改，不承诺复杂文档无损修订或 Word/WPS 版式、原生分页一致。

每次 Review 返回的 record_path 指向独立检查快照，后续复查不会覆盖它；当前汇总结果另存，复查仅更新当前汇总中的对应页。已有历史文件保留。交付请引用本轮返回的 record_path。
