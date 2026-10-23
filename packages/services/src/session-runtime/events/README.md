# 持久事件定义与校验

集中定义可保存的事件类型及其数据校验规则。

## 入口与流程

DurableEventRegistry 登记事件定义，按事件类型检查负载和作用范围；默认注册表供会话存储使用，也允许调用方显式传入扩展注册表。

## 状态归属

事件定义保存在注册表实例中，事件事实由会话存储保存；本目录不拥有通知订阅队列。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [event-registry.ts](./event-registry.ts) | `DurableEventScope`、`DurableEventDefinition`、`PreparedDurableEvent` 等 |

## 测试与维护

事件定义、校验和注册错误放在这里，事件写入与通知生命周期由 SessionStore 协调。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
