# src

画板后台。`module.ts` 组合领域、编辑流程和外部适配；`contract.ts` 定义共享协议。状态由 `app/editor.ts` 控制，持久数据由 `adapters/store.ts` 写入宿主指定目录。新增纯场景规则放 `domain/`，流程放 `app/`，IO 放 `adapters/`，测试放对应 `__test__/`。
