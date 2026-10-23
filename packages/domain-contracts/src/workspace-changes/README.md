# 工作目录变更摘要

定义一次运行期间观察到的 Git 变更摘要，供保存和展示使用。摘要说明观察结果，不证明每处修改的作者。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `@vykor/domain-contracts/workspace-changes` 公开入口 |
| [records.ts](records.ts) | 文件变更、摘要状态、不可用原因、上限和只读解析函数 |

消费方用 `readWorkspaceChangesMetadata` 校验版本、状态、文件路径、数量及增删行数，合法时返回摘要，非法时返回 `undefined`。旧记录可不带增删拆分，新记录一旦携带则必须成对出现并与总行数一致。

Git 命令执行、变更采集和摘要保存由消费方负责，本目录只解析传入数据。新增摘要字段与对应校验放本目录，测试建议放同层 `__test__/`。
