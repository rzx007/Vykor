# 工具输出长度策略

集中定义工具结果内联、预览和压缩的长度规则。

## 入口与流程

调用方读取默认值或环境配置，通过辅助函数判断输出长度和是否进入压缩处理。

## 状态归属

长度设置由常量及当前环境提供，实际输出内容和保存位置由调用方管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [tool-outputs.ts](./tool-outputs.ts) | `DEFAULT_TOOL_OUTPUT_INLINE_CHARS`、`DEFAULT_TOOL_OUTPUT_PREVIEW_CHARS`、`DEFAULT_MICROCOMPACT_TOOL_RESULT_CHARS` 等 |

## 测试与维护

输出长度与压缩判定放在这里，输出捕获和进程生命周期由 execution-node 提供。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
