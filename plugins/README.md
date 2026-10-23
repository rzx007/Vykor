# 正式插件源码

这里存放由插件市场单独分发的正式插件。桌面应用不再附带这些插件的归档，也不提供专门的内置安装入口；用户在“插件 → 浏览市场”选择安装。已有安装、授权和插件数据继续保留。

| 目录 | 用途 | 构建入口 |
| --- | --- | --- |
| [excalidraw](./excalidraw/README.md) | 对话侧栏画板、自动保存、引用选区和导出 | `npm run build` |
| [knowledge-work](./knowledge-work/README.md) | 研究、资料整理和写作 | `npm run build` |
| [office-work](./office-work/README.md) | Word、Excel、PPT 文档操作 | `npm run build` |

每个插件有独立清单、许可证、依赖锁和检查命令。新增正式插件放在这里；教学示例放在 `examples/plugins/`，创建插件的工程模板放在 `skills/create-plugin/templates/`。插件后端、界面、Skill 和测试随对应插件维护，不放入桌面宿主代码。

## 发布与状态

源码在本仓库维护，发布仓库 [rzx007/vykor-plugins](https://github.com/rzx007/vykor-plugins) 固定源码提交并构建归档，先发布不可变 Release，再更新市场索引。发布索引不是安装包，不应把插件源码复制到发布仓库。

安装仍经过原有权限确认和安装回执。工具权限、操作回执及应用草稿规则不随源码目录或分发方式改变；已有本地安装可从市场明确关联来源后更新，不自动替换。插件运行数据仍属于宿主分配的数据目录，不写回这里。
