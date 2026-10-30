# Client 只读查询与资源边界清理

> 状态：已实现并通过独立 review。仅处理 SDK 拆分审查的两项 P3，当前行为见各包 README。

## 设计与范围

只读模型、技能、Agent persona 和会话 MCP 查询统一使用现有 `RuntimeResource`。应用和命令改用 `client.runtime`；删除 Development/System 中的重复查询。私有 Provider 的强制刷新入口明确命名为 `refreshModels`，继续发送 `refresh=true`。不增加资源工厂、转发层或依赖。

现有公开 API JSON 清单增加各 Resource 的公开成员集合。复用已有 TypeScript 编译器检查，在同一次类型分析中比较成员；private、protected、`#private` 不参与公开集合。应用私有扩展继续独立于公开 SDK。

## 实施与验证

- [x] 先通过私有客户端测试复现重复入口未删除、刷新入口未明确的问题。
- [x] 先通过公开契约测试复现资源成员清单缺失。
- [x] 删除重复请求，迁移应用、命令、测试夹具，保留刷新请求的参数和取消信号。
- [x] 更新公开 API 清单及 schema，并补充资源公开成员检查。
- [x] 运行相关测试、类型检查、文档及旧引用检查。
- [x] 独立 review 确认复杂度和改动范围。

## 验证记录

- 公开 SDK 179 项、私有客户端 73 项、桌面相关调用 54 项、服务端模型刷新联测 9 项、TUI 同步 23 项测试通过。
- 私有客户端、TUI、桌面主进程及 Server/Client 联合类型检查通过。
- `pnpm check:retired-ui` 与 `pnpm check-docs` 通过。
- 独立内存编译器反例验证确认：公开方法和属性改变会触发清单差异；private、protected、`#private` 不影响集合。
