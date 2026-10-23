# 文件查找与文本搜索

提供文件匹配及宿主文本搜索的共用实现。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [glob.ts](./glob.ts) | `createGlobTool`、`globTool` |
| [grep-fallback.ts](./grep-fallback.ts) | `FALLBACK_FILE_BYTES`、`searchFallback` |
| [grep-search.ts](./grep-search.ts) | `GREP_OUTPUT_BYTES`、`GREP_LIMIT_HINT`、`GrepSearchError` |
| [host-search.ts](./host-search.ts) | `globToRegex`、`MAX_LINE_BYTES`、`SKIP_DIRS` |

## 入口与处理步骤

主要入口或定义见 [glob.ts](./glob.ts)。

规范化搜索条件，调用宿主搜索能力或现有备用搜索，再整理匹配结果供文件与搜索工具使用。

## 状态放在哪里

单次调用保存输入、取消信号和执行结果；文件、进程及任务状态由注入的宿主接口或目标系统保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
