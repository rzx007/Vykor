# Managed Remember Tool 设计

## 目标

当用户要求 Agent“记住”某件事时，Agent 不再猜测或直接编辑 `USER.md`、项目跨会话记忆目录。系统提供一个按用途写入的 `Remember` 工具，内部继续使用现有 Markdown 存储和路径解析函数。

本次只修复写入入口，不引入新的 Context Service、数据库、HTTP 接口、客户端状态或存储结构。

## 交互与作用域

`Remember` 接收两个字段：

- `scope: "user" | "project"`
- `content: string`

行为如下：

- `user`：用于跨项目生效的用户偏好和稳定个人信息。内容通过现有个人提示词安全扫描后，立即追加到由 `getConfigDir()` 管理的 `USER.md`。
- `project`：用于当前项目后续会话需要复用的信息。内容通过当前 `AgentMemoryRuntime` 的 `MemoryManager` 写入由 `getProjectMemoryDir(cwd)` 管理的 Markdown 记忆目录。
- 内容为空、安全扫描阻止写入、项目记忆已关闭或底层写入失败时，工具明确返回错误，不降级为直接文件写入。

工具描述明确要求：用户明确表达“记住”时使用该工具；不得用通用 `Write`、`Edit` 操作受管理的持久化文件。

## 组件改动

### `@vykor/prompts`

提取一个可复用的 `appendUserProfileUpdate()`：负责清理输入、运行现有安全扫描、初始化配置目录并追加 `USER.md`。现有 pending 审批函数也复用它，避免出现两套写入规则；旧 pending API 保留，但 `Remember` 不使用它。

### `@vykor/agent-runtime`

新增一个很薄的 `Remember` 工具工厂，并在 Agent 组合阶段注册。工具只负责校验 `scope/content` 并路由到：

- `appendUserProfileUpdate()`；或
- 当前组合实例已有的 `AgentMemoryRuntime.manager.add()`。

路径不会成为工具参数，也不会要求模型知道实际文件位置。

### `@vykor/tools`

在 `Write` 和 `Edit` 的路径校验中增加受管理持久化路径保护：

- 精确命中当前配置目录下的 `USER.md`；
- 命中当前项目的跨会话记忆目录及其子文件。

命中时返回可操作的错误，要求改用 `Remember`。这只是防止 Agent 误用通用文件工具，不改变用户通过其他方式手工维护文件的能力。

`SOUL.md` 不在本次保护范围；它不是普通“记住用户偏好”的目标，现有 `/profile` 与手工维护方式保持不变。

## 不改变的行为

- 仍以现有 Markdown 文件持久化，不迁移旧数据。
- 现有启动时读取 `USER.md`、项目记忆检索和 Run 后自动提取记忆的行为不变。
- session memory/compact checkpoint 是内部会话续接数据，不暴露给 `Remember`。
- 不增加 machine、candidate、index 等新作用域。
- 不让 daemon 或客户端接管路径计算。

## 验证

至少覆盖以下测试：

1. `scope=user` 将合法内容追加到测试配置目录的 `USER.md`，保留已有内容。
2. `scope=user` 拒绝空内容和现有安全扫描认定的阻止内容。
3. `scope=project` 通过现有 `MemoryManager` 写入当前项目记忆，并返回条目 ID。
4. 项目记忆关闭时，`scope=project` 返回明确错误且不写文件。
5. `Write/Edit` 拒绝 `USER.md` 和当前项目记忆目录，但不影响普通项目文件。
6. 现有 USER profile、memory runtime 和 file tools 测试继续通过。

## 完成标准

Agent 在工具列表中可发现 `Remember`；明确的用户记忆请求可以在不知道任何文件路径的情况下落入正确的现有 Markdown 存储；通用 `Write/Edit` 无法再误写这两类受管理文件。
