# 共享测试夹具

为包内与跨包测试提供可控 Agent 和插件应用宿主。

## 入口与流程

测试从本目录创建受控 Agent、应用测试宿主或 Electron 替身，注入被测服务并在结束后释放资源。

## 状态归属

模拟消息、事件和调用记录保存在夹具实例中；临时资源由使用夹具的测试负责清理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [hosted-agent.ts](./hosted-agent.ts) | `hostedAgentFixture`、`hostedAgentFactory` |
| [plugin-app-electron.mts](./plugin-app-electron.mts) | 内部辅助实现 |
| [plugin-app-harness.ts](./plugin-app-harness.ts) | `pluginAppHarness` |

## 测试与维护

多个测试共用的夹具留在这里，某个分类专用的辅助函数放入该分类的 `__test__/`。

本目录是测试支持代码；测试用例放在各被测分类的 `__test__/`，跨包组合测试放在仓库 `tests/`。

官方插件源码由 `vykor-plugins` 仓库维护。Excalidraw 的真实插件兼容性夹具要求显式提供 `VYKOR_OFFICIAL_PLUGINS_DIR`，指向已构建的官方插件目录；普通宿主测试不依赖该仓库。此变量仅用于测试，不影响客户端安装来源或运行数据。
