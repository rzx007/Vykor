# 正式插件统一由市场分发

> 状态：已实施的分发调整记录；以下宿主路径、版本与验证是当时结果。后续源码归属已更新为市场仓库。

当前 Excalidraw、研究与写作、办公文档的权威源码、测试、打包和发布位于[市场仓库 plugins](https://github.com/rzx007/vykor-plugins/tree/main/plugins)，不再保留宿主 `plugins/` 副本。官方条目使用 `localPath`，CI 记录实际 checkout 提交；本地未提交改动仅作预览、不能发布。第三方插件保持独立仓库，通过固定 40 位提交的 PR 收录。现行流程见[作者指南](../../native-plugin-authoring.md#源码与贡献位置)。

## 当时的范围与边界

- `plugins/` 是正式插件的权威源码目录，桌面安装包不携带插件 ZIP。
- Excalidraw 从示例目录迁到 `plugins/excalidraw`，同步测试夹具和文档引用；插件 ID 不变。
- 删除桌面专用内置入口、`bundledPlugin` 请求字段与打包步骤，保留市场与普通归档安装。宿主文档功能使用的 Office 引擎继续单独构建。
- 不卸载已有插件，不清理用户数据，不重置权限，不重载已打开的应用面板。已有安装需要用户明确关联市场来源后更新。

## 分阶段实施

1. 移除桌面附带插件链路，防止残留构建目录被装入应用，调整安装页与回归测试。
2. 为研究与写作、办公文档补齐独立包元数据、锁文件、许可证与构建检查。办公插件构建时准备经过固定摘要校验的引擎，安装后运行不依赖桌面注入或临时联网下载。
3. 迁移 Excalidraw，统一文档、测试入口与构建缓存声明。发布仓库允许合法的 Skill/Agent 目录入口，继续校验归档体积、固定版本、内容摘要和许可证。
4. 运行插件定向测试、桌面安装回归、相关类型检查、文档与旧 UI 退役检查。发布时固定已提交的源码，再构建 Release 与市场索引；不把未提交工作区伪装为固定源码。

## 验收

- 干净构建和有旧插件产物的构建均不随桌面分发插件；市场与普通 ZIP 安装仍保留确认和回执。
- 三个正式插件可构建为完整归档，清单 ID、权限和运行数据定位不变。
- Excalidraw 的自动保存、草稿和选区引用使用原流程；搬迁不改变工具执行逻辑。
- 办公归档包含声明支持平台的固定引擎及许可，官方 Skill 摘要检查和归档大小上限不放宽。

## 当时的发行

| 插件 ID | 当时版本 | 当前权威源码 |
| --- | --- | --- |
| `dev.vykor.excalidraw` | `1.0.2` | [市场仓库 Excalidraw](https://github.com/rzx007/vykor-plugins/tree/main/plugins/excalidraw) |
| `vykor.knowledge-work` | `1.1.1` | [市场仓库研究与写作](https://github.com/rzx007/vykor-plugins/tree/main/plugins/knowledge-work) |
| `vykor.office-work` | `0.12.3` | [市场仓库办公文档](https://github.com/rzx007/vykor-plugins/tree/main/plugins/office-work) |

已通过真实市场归档打包、宿主解压与组件加载：Excalidraw 1 个 Skill、1 个 MCP 后台与1个应用；研究与写作 3 个 Skill、2 个 Agent、3 个工具入口；办公文档 5 个 Skill、3 个 Agent、1 个工具入口。办公归档约 70 MiB，包含六个平台引擎。

桌面定向回归 81 项及 Node/Web 类型检查通过；Excalidraw 35 项单元测试、实际 stdio 服务及类型检查通过；两个 Native Tool 插件独立检查、文档和旧 UI 退役检查通过。Windows Word 预览在首次并发检查中操作超时，单独复跑通过，未改变业务超时或预览逻辑。

当时的发布由用户明确授权：只提交该轮文件，推送源码后将发布仓库锁定到该提交，沿用先 Release 后市场目录的顺序；其他任务未提交改动保留。这是历史授权记录，不代表后续迁移获得新的提交、推送或发布授权。
