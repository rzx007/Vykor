# Excalidraw 文档与页面约定

已提交文档只由 DocumentStore 保存。入口是 MCP 的 create/read/list/commit/apply；SQLite 文件位于宿主注入的插件数据目录下 `sessions/<宿主会话摘要>/documents.sqlite`。所有同步数据库操作放在 worker，避免阻塞工具通信。

页面用官方 MCP Apps 1.1.2 的 App 连接宿主。小 HTML 先建立连接，再通过 resources/read 加载 CSS 和每块至多 4 MiB UTF-8 的脚本；字体是内嵌 data URL。页面不直接读工作区文件，也不另建私有宿主协议。

每次绘图只更新最新草稿；同一时刻最多一个 commit_scene 在途。提交带文档 ID、expectedRevision 和唯一 operationId。只有返回 saved:true、相同 operationId、文档 ID 与下一版本才能显示已保存。服务器在同一事务中更新内容、标题、版本和请求记录；相同请求不重复写。

宿主明确返回 error.data={code:plugin_app_busy或plugin_app_hidden,notAccepted:true} 时，草稿保留；资源读取恢复后才重新提交。其他异常、未知结果、权限拒绝和版本冲突均停止自动保存。不会把未知结果当成新操作重发。

冲突草稿可切到其他画板，再回来继续处理。切换时已接纳的提交先结算；未保存内容放在常驻 frame 的页面内存。标签与草稿不跨页面销毁、应用退出或撤销插件保留。冲突后可保存副本；明确确认后才能放弃草稿并重载。

页面订阅文档资源，服务器发送标准 resources/updated 与 resources/list_changed。当前文档无草稿时采用新版本，并进入当前撤销历史；有草稿时保留本地内容。首次打开和切换画板会初始化撤销历史，撤销后的内容沿相同自动保存流程写入。

引用固定 documentId、revision 和 elementIds；引用前先确认保存。Agent 先 read_scene 获取当前版本与元素 ID，再 apply_operations 对具体元素添加、修改或删除。版本不符必须重读，不覆盖整张图。

commit_scene 仅声明自身插件数据写入授权。创建、导入、保存副本和导出仍经过普通工具确认。导出 `.excalidraw`、PNG、SVG 仅允许当前工作区内的路径，并校验扩展名；默认原子拒绝覆盖已有文件。用户明确选择覆盖后才发送 overwrite:true。
