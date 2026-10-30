# 图像工具接入

提供图片生成、图片转文字、远程图片读取与取消处理。

## 入口与流程

工具工厂校验请求并调用图像能力；远程图片读取器检查地址与重定向；取消范围辅助函数将宿主取消接到当前工具调用。

## 状态归属

生成文件和读取结果由工具及其宿主保存，取消监听只属于当前调用并在结束时释放。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [daemon-image-generation-tool.ts](./daemon-image-generation-tool.ts) | `DaemonImageGenerationToolOptions`、`createDaemonImageGenerationTool` |
| [daemon-image-to-text-tool.ts](./daemon-image-to-text-tool.ts) | `createDaemonImageToTextTool` |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |
| [remote-image-source.ts](./remote-image-source.ts) | `ImportedImageSource`、`downloadRemoteImage`、`isPublicAddress`、图片字节共用的 `streamOf` |
| [tool-abort-scope.ts](./tool-abort-scope.ts) | `createToolAbortScope` |

## 测试与维护

图像工具组装、下载规则和取消衔接放在这里，附件授权读取放在 attachments/tools。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
