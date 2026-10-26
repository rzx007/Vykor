# 工具结果补读

这里把工具输出转换成可以分页和按字面文字检索的文本，并提供 SDK 的有容量上限的内存结果存储。

入口是 `MemoryToolResultArchive.forRun(scope, bindings)`：宿主传入当前运行和实际获准工具，返回该运行专用的 `RunToolResultStore`。执行完成后先 `retain`，模型再用引用 `list`、`read` 或 `search`；工具输出自带的 `resultRef` 不决定引用。后续运行可以列出同一会话仍有权访问的历史结果。

| 文件 | 用途 |
| --- | --- |
| [memory-tool-result-archive.ts](./memory-tool-result-archive.ts) | 保存有限数量和总字符数的文本；容量不足时移除最早记录，单项超限明确报错。 |
| [result-text.ts](./result-text.ts) | 转导出 agent-contracts 的纯文本规则，统一 UTF-16 字符位置、分页和字面检索，图片只显示类型提示。 |
| [result-reader-identity.ts](./result-reader-identity.ts) | 宿主标记真实补读工具；捕获后的定义还需原身份与执行函数同时匹配。 |
| [index.ts](./index.ts) | 公开入口。 |
| [__test__/memory-tool-result-archive.test.ts](./__test__/memory-tool-result-archive.test.ts) | 大正文尾部、分页、容量、会话和来源权限、运行释放与身份核验。 |

正文和引用在 archive 实例中；当前工具集合和取消信号由宿主提供。宿主须在运行结束调用 `releaseRun(runId)`，使旧能力失效；这不会删除后续运行仍可查询的历史。取消会自动释放能力。未知执行结果不提供完整结果引用。

每次读取最多 16000 字符，列表及检索最多 100 项；偏移量为 JavaScript 字符串的 UTF-16 位置。共享纯文本操作放在 agent-contracts 的 `tools/result-text.ts`，新增存储放在本目录，测试放在 `__test__/`。
