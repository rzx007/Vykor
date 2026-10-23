# 记忆源码

公开入口为 `@vykor/memory` 的 [index.ts](index.ts)，该文件同时实现 `MemoryManager` 并导出格式和抽取 API。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | 条目管理、搜索排序、提示词选取和可选文件保存 |
| [memory-format.ts](memory-format.ts) | 记忆类型与作用范围、签名、Markdown 解析和索引裁剪 |
| [extraction.ts](extraction.ts) | 抽取提示词、响应解析、可写范围筛选和记忆写入识别 |
| [sensitive-content.ts](sensitive-content.ts) | `detectCredentialValue()`，识别疑似凭据 |
| [__test__](__test__) | 管理、持久化、抽取和凭据检测测试 |

首次操作时按需加载存储目录。新增条目会校验内容、去重并更新内存表，配置存储目录后再排队写条目文件和索引。搜索和 `buildMemoryPrompt()` 从有效条目中选择结果。抽取辅助函数只构造或解析数据，不自行调用模型；当前可写候选会排除团队范围。

内存表、加载标志和写队列属于 `MemoryManager` 实例；长期状态保存在调用方指定的目录，未指定时只使用内存。新增相关实现保持在本目录，测试放同层 `__test__/`。返回[包说明](../README.md)。
