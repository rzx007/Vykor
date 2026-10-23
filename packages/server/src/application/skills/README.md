# 技能管理应用服务

提供技能目录查询、安装与管理操作。

## 入口与流程

技能管理服务接收应用请求，解析工作目录与技能来源，调用技能能力并将结果返回调用方。

## 状态归属

技能文件与索引由技能和配置能力管理，服务仅持有依赖与操作期间的数据。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [skill-management-service.ts](./skill-management-service.ts) | `SkillManagementServiceOptions`、`SkillManagementService`、`createSkillManagementService` |

## 测试与维护

技能管理规则与应用接口放在这里；运行时技能发现放在 session/configuration。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
