# 项目环境事实

[`index.ts`](index.ts) 是 `@vykor/personalization` 的公开入口和当前实现文件，提供事实提取、合并、保存、读取和替换 API。

| API | 用途 |
| --- | --- |
| `extractFactsFromText()`、`mergeFacts()` | 提取候选事实并按 `type:value` 合并 |
| `updateRulesFromSession()` | 从有标识与时间的用户消息提取事实并保存 |
| `loadFacts()`、`saveFacts()` | 校验并读写结构化事实 |
| `loadLocalRules()`、`factsToRulesMarkdown()` | 从有效事实生成提示词规则 |
| `replaceFact()` | 校验新值、记录旧值被取代，并刷新规则缓存 |

会话结束时，入口筛选用户消息，提取环境信息并附上消息来源，再过滤疑似凭据、合并和保存。`replaceFact()` 将旧事实标记为被取代，保留替换关系，避免重新扫描旧消息时恢复旧值。

长期状态由本模块写入 `getLocalRulesDir(cwd)` 返回的项目独立目录，保存为 `facts.json` 和 `rules.md`。路径由配置目录与项目绝对路径计算；事实文件通过临时文件替换写入，规则可以从事实重新生成。

新增事实类型和读写逻辑继续放在本目录，相关测试放同层 [`__test__`](__test__)。返回[包说明](../README.md)。
