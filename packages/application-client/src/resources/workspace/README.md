# 工作区资源

访问项目、笔记、渠道与调度配置。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [channel-resource.ts](./channel-resource.ts) | `FeishuComposedSnapshot`、`ChannelResource` |
| [note-resource.ts](./note-resource.ts) | `NoteResource` |
| [project-resource.ts](./project-resource.ts) | `ProjectResource` |
| [schedule-resource.ts](./schedule-resource.ts) | `ScheduleResource` |

## 入口与处理步骤

主要入口或定义见 [channel-resource.ts](./channel-resource.ts)。

调用方提供目标项目或资源标识，接口发送读取或修改请求，再返回工作区中的资源数据。

## 状态放在哪里

远端业务数据由 daemon 保存；连接、订阅和展示状态保存在客户端对象中。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
