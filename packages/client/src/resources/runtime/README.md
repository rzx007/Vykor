# 任务与运行资源

访问任务、终端和开发运行相关接口。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [development-resource.ts](./development-resource.ts) | `DevelopmentResource` |
| [job-resource.ts](./job-resource.ts) | `JobResource` |
| [terminal-resource.ts](./terminal-resource.ts) | `TerminalResource` |

## 入口与处理步骤

主要入口或定义见 [development-resource.ts](./development-resource.ts)。

先提交运行或控制请求，再取得任务、终端或开发服务状态，结果交给命令或界面处理。

## 状态放在哪里

远端业务数据由 daemon 保存；连接、订阅和展示状态保存在客户端对象中。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。


## 共用执行核心（阶段 A）

JobResource 使用完整 JobTarget；list 返回 JobListResult，send 返回可选 JobInputReceipt。HTTP 请求与协议 decoder 一起切换为版本 6，不保留旧参数重载。
