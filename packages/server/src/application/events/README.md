# 应用事件出口

把已保存的事件重放和后续通知提供给 HTTP、渠道及嵌入调用方。

## 入口与流程

`ApplicationEventService.subscribe()` 建立订阅，读取事件序号并重放历史，再持续输出新提交的事件；订阅终止时清理队列。

## 状态归属

事件事实与序号保存在存储中，订阅者和待发送队列保存在服务实例内。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [application-event-service.ts](./application-event-service.ts) | `ApplicationEventStore`、`ApplicationEventStreamOptions`、`ApplicationEventSubscription`、`ApplicationEventService` |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |

## 测试与维护

事件重放、游标推进和订阅释放放在这里；执行事件如何写入会话记录由 agent 与 session/transcript 处理。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
