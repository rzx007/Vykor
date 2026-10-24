# aora-bot 头像

桌面宠物和新对话起始页共用的轻量头像适配。页面持有随机标识与交互状态，这里只负责将标识显示成 SVG 头像。

- `aora-avatar.tsx` 是 React 入口，接受 `name`、`size`、`className`；浏览器挂载后加载引擎，标识变化或卸载时清理旧实例。
- `aora-runtime.ts` 按顺序加载本地引擎，以标识选取形态、配色；观察根元素的减少动态效果偏好和页面可见性，决定是否继续动画。
- [upstream](upstream/README.md) 保存固定版本的原始引擎和许可文件，不在这里维护上游实现的分支。
- `__test__/` 验证真实 SVG 与动画实例的创建、替换和清理。

头像本身不处理点击、拖拽、窗口 IPC 或表单操作，不拦截父节点的鼠标事件。新增头像展示适配放在这里；宠物交互留在 `pet-page`，对话操作留在 `conversation-page`。

上游球形角色仅限个人学习、研究等非商业用途，禁止商业使用；详见 [社区许可](upstream/LICENSE)、[使用声明](upstream/NOTICE.md) 和 [商业许可说明](upstream/LICENSE-COMMERCIAL.md)。发行包通过桌面打包配置保留这三份原始文件。
