# 天气与出行助手工程

这是 create-plugin 的默认完整工程：城市搜索、当前天气、未来七日与逐小时数据、最多三个城市比较、城市收藏，以及可编辑的出行备忘。页面可以将明确选中的内容引用到聊天，或经确认把备忘导出为 Markdown/JSON。没有预订、地图或任意网络代理。

模板源由 create-plugin Skill 维护。新插件使用它的 `scripts/create-plugin.mjs` 初始化，不直接改一份旧插件清单后复制安装。如果已经位于生成的独立工程，直接执行下面从 `npm ci` 开始的命令。

## 生成与构建

使用 Node.js 24；后台依赖其内置 SQLite。将 `<skill-dir>` 换成 create-plugin Skill 的绝对路径，在希望保存新工程的位置执行：

```sh
node <skill-dir>/scripts/create-plugin.mjs --dir ./my-weather --id example.my-weather --name my-weather --backend native --display-name "我的天气助手" --version 1.0.0
cd my-weather
npm ci
npm run build
npm test
npm run validate
npm run pack
```

`--backend native` 也可以改成 `--backend mcp`，一次只选择一种后台；省略时默认 native。`--display-name` 和 `--version` 可选，版本默认 `1.0.0`。生成器拒绝已有目录；ID 使用稳定点分名称，name 使用小写连字符。生成工程可移到本仓库之外构建，不引用 Vykor 源码或仓库工作区包。

`src/app-tools.mjs` 为页面工具声明参数和结构化结果类型，真实名称取自 `src/identity.mjs`。`ui/view.mjs` 使用 `createPluginAppClient(app)` 调用；随包的 `ui/app-client.mjs` 和 `.d.mts` 提供运行封装及类型提示，构建时正常合入离线页面。封装仍调用官方 `callServerTool`，不改变可见性检查、保存协调、错误和原操作回执处理。

- `npm ci`：按锁文件安装作者的构建和测试依赖。
- `npm run build`：将官方页面 SDK 和源码构建为 `dist/ui/panel.html`，并构建所选后台。Native 输出 `dist/native/network.mjs`、`data.mjs`、`export.mjs`；MCP 输出 `dist/server.mjs`。
- `npm test`：检查业务与页面保存流程，天气请求使用固定响应，不代表真实联网或桌面验证。
- `npm run validate`：独立检查工程文件、身份、清单和页面声明，不依赖本仓库或 `vk`。真实宿主静态校验另用可用的 `vk plugin validate <目录>`。
- `npm run pack`：生成 `dist/<name>-<version>.zip` 及 `.sha256`。ZIP 内含实际清单、页面、后台和插件内 Skill，不包含 node_modules 或用户数据。

作者依赖固定为官方 `@modelcontextprotocol/ext-apps` 1.1.2、esbuild 0.25.12、JSZip 3.10.1；MCP 后台另用官方 `@modelcontextprotocol/sdk` 1.29.0，jsdom 26.1.0 只用于测试。最终用户导入构建好的 ZIP，不运行 npm；天气查询仍需要联网和对应权限。Native 使用宿主内置的 Node，已验证当前 Desktop 的 Electron 39 / Node 22.22 能保存并读取回执；MCP stdio 使用 PATH 中的 Node.js 24。

创建不会自动安装或发布。用户要求安装时，可在 Desktop 插件页导入 ZIP，并按实际预览批准权限。样式由用户查看反馈，本工程的代码检查不等同于浏览器或桌面验证。

## 后台与身份

`plugin.config.json` 保存 `id`、`name`、`displayName`、`version`、`toolPrefix`、`backend`。`src/identity.mjs` 从这里生成全局工具名、`ui://<name>/panel` 页面 URI 与 `<name>://trip` 文档 URI。创建时同步清单、页面声明、包名与锁文件版本；工具前缀和 MCP 服务名包含插件 ID 的短摘要，并检查宿主加前缀后的完整工具名不超过 64 字符。插件内 Skill 的本名是 `weather`，宿主入口为 `<name>:weather`；Skill 根据所选插件解析工具名称。

业务工具 key 如下，实际名称是 `toolPrefix` 加 key：

| key | 用途与入口 |
| --- | --- |
| `SearchPlaces` | 搜索候选城市，模型和页面均可调用 |
| `GetForecast` | 获取一个已确认地点的真实天气，模型和页面均可调用 |
| `ReadPlan` | 读取当前会话文档及 revision |
| `ApplyPlanOperations` | 模型按固定条目 ID 增删改，保留普通确认 |
| `SavePlanDraft` | 页面保存完整编辑草稿，仅 app 可见 |
| `ReadFavorites` | 读取插件共享收藏及 revision |
| `SetFavorite` | 页面设置收藏，仅 app 可见 |
| `ExportPlan` | 经普通确认将当前版本导出到工作区 |
| `GetOperation` | 查询原 operationId 的业务回执 |

Native 不启动额外 MCP 进程，分开的入口分别声明网络、插件数据和工作区导出权限。它从宿主调用上下文读取 `plugin.dataDir`、`sessionId` 和工作区 `cwd`。`plugin.root` 仅用于读取安装资源，不用于持久数据。

MCP 通过 stdio 运行官方 SDK 服务。配置的 `cwd` 使用完整值 `${VYKOR_PLUGIN_ROOT}`，以下环境变量也必须由宿主绑定完整值：

| 进程变量 | 配置值 |
| --- | --- |
| `VYKOR_WEATHER_DATA_DIR` | `${VYKOR_PLUGIN_DATA_DIR}` |
| `VYKOR_WEATHER_SESSION` | `${VYKOR_SESSION_ID}` |
| `VYKOR_WEATHER_WORKSPACE` | `${VYKOR_WORKSPACE_ROOT}` |

缺失或尚未解析的变量会使服务停止启动，不退回 cwd、临时目录或共享默认会话。工具输入不接受这些值，也不接受后台地址。更换 Native/MCP 时保持同一业务契约，但不会同时激活两套后台。

## 天气来源与边界

真实数据来自 [Open-Meteo](https://open-meteo.com/)，城市搜索只访问 `https://geocoding-api.open-meteo.com`，天气只访问 `https://api.open-meteo.com`。默认免费配置限定用于非商业评估，使用前核对 [Open-Meteo 使用条款](https://open-meteo.com/en/terms)；商业服务由作者按供应商条款接入相应方案。模板不提供统一密钥注入，不读取宿主密钥，不在包、工具输入或日志中放付费密钥。

地点结果包含名称、国家、经纬度和时区，重名城市先由用户或明确上下文消歧。预报返回来源链接、抓取与过期时间、时区及 stale 标记。页面和模型回答保留这些信息：缓存过期时明确说明，查询失败时显示错误或标明旧缓存。离线测试响应不能作为实时数据，七日以外的出行日期不能编造逐日预报。

## 数据、权限与保存回执

收藏保存在宿主分配的稳定插件数据目录，同一插件跨会话共享；出行文档、revision、操作回执与后台收到的冲突草稿按会话隔离。天气缓存只保留在后台实例内存，重启后重新获取。源工程、安装快照、工作区文件与插件数据目录各有用途，升级不修改用户数据。未送达后台的最后输入只在页面内，不能保证跨关闭或重启恢复。

根清单请求 UI、固定域名网络、插件数据与工作区导出所需权限。`pluginData:write` 只让精确 app-only 工具 `SavePlanDraft`、`SetFavorite` 按有限参数自动保存到插件自己的数据目录；它们不接受网络地址或用户文件路径。模型的 `ApplyPlanOperations` 和 `ExportPlan` 仍需普通确认，不能借自动保存权限导出或访问任意文件。

编辑时页面只保留一个在途保存。请求携带 `expectedRevision` 和唯一 `operationId`，后台将文档新版本与回执原子写入 SQLite；同 ID 同参数返回原结果，换参数复用 ID 会被拒绝。只有匹配请求的 `saved: true` 回执才能显示“已保存”，后输入的内容不能被旧回执覆盖。

版本冲突会返回最新文档并保留收到的草稿，页面让用户处理差异。明确采用新版后，页面通过同一有限保存工具确认清除后台的冲突草稿，不要求再点一次保存；收到回执后才显示保存成功。迟到回复不能将已知最新版本降回旧版，读取未变化的版本也不会取消待执行的自动保存。

结果 unknown 时保留草稿，不自动重发；恢复只查询原 operationId 的 `GetOperation`，没有回执也不能推断写入失败后重放。导出文件已发布、但回执提交或后续清理失败时返回 `operation_outcome_unknown`；页面保留原导出操作，只核实回执，不提供新的导出重试。

模型修改前先 `ReadPlan`，保留原条目 ID，使用读取到的 revision 提交明确操作。导出时传入当前 revision、用户指定的工作区内路径与格式，`overwrite` 默认为 `false`；只有用户明确选择覆盖才传 `true`，仍走普通权限确认。越界路径与符号链接始终拒绝。普通保存不会自动导出。引用选区只向当前聊天提供用户选择的内容，不代表已授权改写文档或导出。

页面使用官方 `App`，只声明 `fullscreen`，在会话右侧打开。它沿用宿主主题，保留键盘操作与减少动态效果支持；页面本身没有 Node、文件或直接网络权限，所有业务通过所选后台工具完成。
