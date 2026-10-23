# ui

右侧画板应用。`bootstrap.ts` 建立连接并加载离线资源，`main.tsx` 挂载 Excalidraw；`client.ts`/`bridge.ts` 连接宿主，界面样式在 `panel.css`，对话框和菜单按用途分文件。草稿与保存状态遵循后台协议，切换或收起不销毁应用。新增界面组件放这里，测试放 `__test__/`。
