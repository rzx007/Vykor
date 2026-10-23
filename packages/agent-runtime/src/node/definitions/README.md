# 本地 Agent 定义

`definitions.ts` 提供 `loadNodeAgentDefinitions()`：读取用户 agent 目录中的 Markdown 文件，再调用 `@vykor/coordinator/definitions` 的解析与合并函数，与内置、插件定义合成当前可用列表。

默认用户目录由 `getUserAgentsDir()` 解析。读取失败的目录或单个文件按已有规则跳过，加载结果返回组装层，本目录不保存全局定义缓存。

新增本机目录读取规则放在这里，定义格式和合并优先级放在定义所属包。测试放在同层 `__test__/definitions.test.ts`。
