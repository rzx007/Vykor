# 天气与出行助手工程模板

状态：编码与定向验证已完成。用户已批准完整方案，本轮不提交、不推送、不发布；桌面样式与手工操作由用户体验验收。

## 交付与边界

- `skills/create-plugin/templates/weather-travel/` 保存同一业务与页面的工程源；初始化时选择 native 或 mcp，只交付一种后台。
- `skills/create-plugin/scripts/create-plugin.mjs` 在新目录生成独立工程，同步身份、工具名、页面 URI、清单与包版本，拒绝已有目录和无效名称。
- 真实天气使用 Open-Meteo 固定 HTTPS 域名；免费端点仅用于非商业评估，保留来源说明，不读取宿主密钥。
- 城市搜索、当前/七日/逐小时天气、最多三个城市比较、收藏、出行条目、自动保存、引用选区和 Markdown/JSON 导出。
- 网络工具、插件数据操作、工作区导出分开声明。有限自动保存只适用于 app-only 保存工具；模型修改和导出保留普通确认。
- 保存版本与操作回执原子持久化，重复 ID 同参返回原结果，异参拒绝。冲突保留草稿；未知结果只查询原回执，不重放。
- 收藏持久化并跨会话共享；出行文档与收到的冲突草稿按会话隔离。天气缓存是有容量和时效上限的实例内存，重启后重新获取；未被后台接收的最后输入不能保证跨退出恢复。
- 不修改宿主权限、应用运行时或现有用户安装数据。不实现预订、地图或任意网络代理。

## 共享接口

工程配置 `plugin.config.json`：id、name、displayName、version、toolPrefix、backend。
`src/identity.mjs` 导出 config、names（工具 key → 全局名称）、resourceUri（ui://<name>/panel）、planUri（<name>://trip）。

工具 key：SearchPlaces、GetForecast、ReadPlan、ApplyPlanOperations、SavePlanDraft、ReadFavorites、SetFavorite、ExportPlan、GetOperation。
SavePlanDraft、SetFavorite 仅 app；其他工具 model/app。参数不接受 dataDir、session 或后台地址。

- SearchPlaces `{query}` → `{kind:'places',places:[{id,name,country,latitude,longitude,timezone}]}`。
- GetForecast `{place,force?}` → `{kind:'forecast',place,timezone,fetchedAt,expiresAt,stale,source:{name,url},current:{time,temperature,weatherCode,windSpeed},days:[{date,min,max,rainProbability,weatherCode}],hours:[{time,temperature,rainProbability,windSpeed}]}`。
- ReadPlan `{}` → `{kind:'plan',document:{id:'trip',revision,title,entries},draft?}`。条目 `{id,date,title,notes,place?}`。
- SavePlanDraft `{documentId:'trip',expectedRevision,operationId,title,entries}` → `{kind:'plan',document,operationId,saved:true,duplicate?}`；冲突返回 saved:false、conflict:true、最新 document 和收到的 draft。
- ApplyPlanOperations `{documentId:'trip',expectedRevision,operationId,operations:[{type:'upsert',entry}|{type:'remove',id}],title?}`，只能在读取后按固定 ID 修改。
- ReadFavorites `{}` → `{kind:'favorites',revision,places}`。
- SetFavorite `{expectedRevision,operationId,place,enabled}` → 同上加 operationId、saved:true。
- ExportPlan `{documentId:'trip',expectedRevision,operationId,path,format:'markdown'|'json',overwrite?:boolean}` → `{kind:'export',operationId,saved:true,path,revision}`。默认不覆盖；用户明确选择覆盖才传 true，仍走普通权限确认。
- GetOperation `{operationId}` → 原业务结果；不存在返回 `{kind:'receipt',operationId,status:'missing'}`。

service `createService({dataDir,sessionId,sessionKey?,workspaceRoot,fetchImpl?,now?})` 返回 invoke(key,input,signal)、readPlan()、readFavorites()、close()。sessionKey 仅供 MCP 适配层接收宿主摘要，Native 对原始 sessionId 摘要一次；业务参数不能设置范围。错误带 code/message，不把未经确认的请求写成成功回执。

## 阶段与接口检查

| 工作 | 产出与使用方 | 检查 |
| --- | --- | --- |
| 后台 | service、工具定义、native/mcp 适配；页面按共享接口调用 | 固定响应测试、版本/去重/冲突/隔离/路径与真实 stdio |
| 页面 | 官方 App、天气与备忘、保存协调；后台提供业务回执 | 编辑不覆盖、单次在途、未知不重试、选区版本、主题与错误 |
| 初始化 | 身份配置、清单、构建/校验/打包；后台和 UI 导入统一 names | 两个新名称、两种后台、无旧身份、仓库外构建与运行 |
| Skill | 创建入口、后台选择、dataDir、发布和权限边界 | 示例契约、独立分发、文档检查 |

所有实现任务均不提交；共享身份由主任务维护，后台与页面分别维护自己的目录，避免并发改同一文件。

## 界面

遵循 design-taste-frontend 的 app-screen 路径与 Desktop 设计基线，保留宿主 palette/type。选用 Achromatic ledger（seed 2098595309），把七日天气日期条作为主视觉；数值有单位和时间，只有真实数据才显示图表，首屏可搜索城市与编辑备忘。沿用语义颜色、圆角、键盘操作与减少动态效果。
按 AGENTS.md 由用户查看样式，本轮只做代码检查，不主动预览或截图。

## 复审修复

- 读取同一版本后继续调度自动保存；迟到的冲突回复不能降低已知最新版本。
- 用户明确采用新版时，复用 SavePlanDraft 清除后台保留的冲突稿，等待匹配回执后才显示成功，不增加保存点击。
- 初始化过滤只检查模板内部的相对路径段，Skill 放在 dist 等父目录下也能正常生成工程；两个分发测试同步修正同类过滤。
- 文件发布后若回执提交或清理失败，返回 operation_outcome_unknown。页面保留原操作，只查询原回执，不将 missing 视为可重试的失败。
- 独立分发测试补跑两种生成工程各自的 npm test，确认只加载所选适配器。

## 最新验证记录

- 初始化器：`node --test skills/create-plugin/tests/scaffold.test.mjs`，4 项通过，包含两种后台、名称与目录检查、全局工具名上限、不同插件服务名隔离及 dist 父目录回归。
- 模板后台与页面：设置 `WEATHER_TEST_ALL_BACKENDS=1` 后执行 `node --test tests/*.test.mjs`，41 项通过；包括官方 MCP 内存连接与 stdio、跨进程竞争、版本/回执/草稿/会话隔离、天气上限及页面保存流程；新增问题先观察失败再修复。
- 独立分发：plugins 包的 `src/manifest/weather-travel-starter.test.ts`，两种后台分别生成、仓库外安装构建打包、各自 npm test、实际宿主校验、解包后无作者依赖运行；2 项通过。skills 包原分发回归 8 项通过。
- 宿主权限和原始调用回归：plugin-app-policy、native/mcp-plugin-app-backend、plugin-app-runtime，共 16 项通过。
- plugins 与 skills 包 `tsc --noEmit` 通过；模板 build、validate、pack 通过；页面静态设计检查 0 fail / 0 warn。未运行浏览器预览或截图。
- 首轮真实联网：Hangzhou 搜索及预报成功，返回 Asia/Shanghai、7 日和 168 小时，stale=false，来源 Open-Meteo。本次复审未改网络逻辑，未重复联网；不使用固定测试响应冒充实时天气。
- 首轮 Desktop 的 Electron 39.8.10 / Node 22.22.1 后台探针成功保存并查询回执；作者工程和外部 MCP 使用 Node.js 24。本次复审未重复桌面探针。
- 本次文档检查通过（479 个 Markdown）；全局退役扫描 0 错误，退役检查自身回归 1 项通过。首轮由另一项计划引起的阻挡现已消失，本轮未修改该计划。
