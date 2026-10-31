# 应用事件出口

把已保存的事件重放和后续通知提供给 HTTP、渠道及嵌入调用方。

## 入口与流程

`ApplicationEventService.subscribe()` 先接入实时通知并记录历史截止序号，消费者开始读取时才每次取最多 128 条历史，重放止于该截止点，之后输出新提交的事件。每条交给消费者后才更新已消费游标；排队进度不作为恢复位置。

每个订阅最多排队 128 条实时事件，另保留当前一页历史。超限立即清空队列、移除该订阅，并通过订阅的 `signal` 通知传输层；后续迭代抛出 `ApplicationEventBackpressureError`，其中 `lastConsumedCursor` 是实际交付的最后一条序号。其他订阅继续工作。调用方用自己实际应用成功的游标重连；会话临时正文仍由已有快照恢复。取消信号在迭代尚未开始时也会释放订阅。

历史读取失败时，服务先把原始 Error 放进终止信号，再让当前迭代抛出同一个错误；非 Error 的失败在终止信号中转换为固定的错误，避免被当作正常取消。HTTP 因而返回读取失败，不会把异常当作正常关闭。正常取消和服务关闭仍使用正常终止原因。

## 状态归属

事件事实与序号保存在存储中，订阅者和待发送队列保存在服务实例内。

历史查询与实时广播共用 `matchesSessionEventScope`：指定会话时接收该会话的事件及没有 `sessionId` 的全局事件，过滤其他会话的私有事件。因此删除父会话树产生的全局 `session.deleted` 也会到达子会话订阅，客户端可沿用已有删除处理。规则位于 domain-contracts 的会话契约，不在 HTTP 或客户端各维护一份。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [application-event-service.ts](./application-event-service.ts) | `ApplicationEventStore`、`ApplicationEventStreamOptions`、`ApplicationEventSubscription`、`ApplicationEventService` |
| [index.ts](./index.ts) | 汇总本分类的公开接口 |

## 测试与维护

事件重放、游标推进和订阅释放放在这里；执行事件如何写入会话记录由 agent 与 session/transcript 处理。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
