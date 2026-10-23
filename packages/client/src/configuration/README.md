# 运行配置

处理客户端提交运行配置时使用的公共规则。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [runtime-configuration.ts](./runtime-configuration.ts) | `normalizeApprovalMode`、`isWorkMode`、`readSessionRuntimeConfig` |

## 入口与处理步骤

主要入口或定义见 [runtime-configuration.ts](./runtime-configuration.ts)。

调用方传入配置数据，经本目录函数整理或检查后，再通过资源接口提交给 daemon。

## 状态放在哪里

远端业务数据由 daemon 保存；连接、订阅和展示状态保存在客户端对象中。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
