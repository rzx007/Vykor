# 技能管理应用服务

提供本地技能查询、官方技能市场安装和技能卸载。

## 入口与流程

技能管理服务接收应用请求，解析工作目录与技能来源，调用技能能力并将结果返回调用方。

市场索引由 [Vykor 技能市场](https://github.com/rzx007/vykor-skills) 维护。安装请求携带技能 ID、版本、ZIP 摘要和安装范围。服务重新读取目录确认版本，校验下载并在临时目录解包。此时可以继续对话。准备完成后，主机在没有对话运行时重新检查安装范围和同名技能，再将完整目录移入个人数据目录的 `skills/` 或已登记项目的 `.vykor/skills/`。

## 状态归属

每份市场安装用技能目录内的 `.vykor-skill-install.json` 保存来源、版本和文件摘要。更新与卸载针对对应目录，遇到手工同名技能或本地文件改动时保留现有文件。更新期间，原版本可在目标目录缺失时用于恢复。新版本就位后，原版本先移入本次安装的临时目录，再从那里清理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [skill-management-service.ts](./skill-management-service.ts) | `SkillManagementServiceOptions`、`SkillManagementService`、`createSkillManagementService` |
| [skill-marketplace.ts](./skill-marketplace.ts) | 官方索引校验、技能包安装和按目录卸载 |

## 测试与维护

技能管理规则与应用接口放在这里；运行时技能发现放在 session/configuration。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。

内置 CreateSkill 的个人写入目录通过 `createBundledSkills(this.personalSkillsDir)` 注入；默认使用已选择的数据根，显式 `configDir` 也用于生成说明，不回退到旧 home。用户与插件正文不经过该模板替换。
