---
name: excalidraw
description: 生成与编辑可交互的 Excalidraw 架构图、流程图和关系图，并按用户引用的画板或选区做局部修改。
---

# Excalidraw 画板

用户要画图、使用 Excalidraw，或引用画板选区要求修改时，使用本插件工具。生成可继续编辑的元素。以下名称是后台工具原名；调用会话中实际注册的本插件对应工具。

## 创建与打开

新图调用 `create_diagram(title, elements)`。元素使用稳定、简短的 ID，后续修改继续使用这些 ID，不随布局调整重新编号。

形状支持 `rectangle`、`ellipse`、`diamond`，可设置 `x/y/width/height`、`backgroundColor` 和 `strokeColor`。容器文字使用 `label: {text}`，工具会生成 `<id>-label` 的绑定文本。例如：

```json
{
  "title": "请求处理流程",
  "elements": [
    { "id": "request", "type": "rectangle", "x": 40, "y": 80, "width": 160, "height": 80, "label": { "text": "接收请求" } },
    { "id": "process", "type": "rectangle", "x": 320, "y": 80, "width": 160, "height": 80, "label": { "text": "处理请求" } },
    { "id": "request-to-process", "type": "arrow", "x": 210, "y": 120, "width": 100, "height": 0, "points": [[0, 0], [100, 0]] }
  ]
}
```

箭头使用 `type: arrow`、相对 `points: [[0,0],[dx,dy]]`，提供匹配的 `width/height`。`open_diagram` 可按文档 ID 打开，也可把工作区内的 `.excalidraw` 文件导入为新文档；导入不会自动覆盖源文件。

## 固定目标，先读再修改

1. 从用户明确引用的 `documentId` 及可选的 `elementIds` 固定这次编辑的目标。引用还带当时的 `revision`，它可能已过期。工具成功结果也携带文档引用。不要从相同标题或很久以前的工具结果猜目标；没有明确文档时先让用户引用或指定。
2. 调用 `read_scene(id, elementIds?)`，读取当前文档版本、稳定元素 ID、绑定文字与相关箭头。即使用户刚引用过选区，也先读最新版本。读取期间或操作发出后，用户切换标签不会改变这次编辑固定的文档 ID。
3. 调用 `apply_operations(id, expectedRevision, operationId, operations)`。`expectedRevision` 使用刚读取的文档 `revision`；`operationId` 为这次新操作的唯一 ID。使用 `add`、`update`、`delete` 按元素 ID 局部修改。文字作用于对应的 text 元素；不要全量重建已有画板，保留未选中元素与用户布局。
4. 发生 `revision_conflict` 时重新 `read_scene`，基于最新内容重新判断修改；不要只更换版本号后重放旧方案。文档 `revision` 与元素 `version` 是不同字段。
5. 一次 `apply_operations` 包含一个完整编辑动作，不为每个字段单独提交。相同操作的重试必须保留 `operationId` 和全部参数；结果未知时先核实原请求回执，不用新 ID 重发。明确失败或冲突也不能声称修改成功。

手工编辑和工具修改进入同一套撤销、重做历史。撤销也会保存成新版本，下一次 Agent 修改前仍需重新读取。

## 自动保存与导出

桌面右侧画板连续绘图时自动保存；收到服务器确认后才显示已保存。不要求用户额外手动保存，也不替页面调用 `commit_scene`；它是页面专用的完整草稿保存工具，Agent 编辑使用 `apply_operations`。

冲突或结果未知时，页面保留草稿并停止自动提交，用户可以保存副本或明确放弃后重载。切换、收起面板保留常驻页面草稿；关闭应用或重新加载页面不保证保留未保存内容。不要绕过冲突覆盖草稿，也不要声称关闭标签会删除文档。

`export_diagram` 将指定文档版本导出为当前工作区内的 `.excalidraw` 文件；PNG、SVG 由画板的“导出”入口渲染后调用页面专用 `save_image`。工作区导出仍须经过宿主原有工具确认，有限自动保存授权不能用于导出。已有文件只有在用户明确选择覆盖后才传 `overwrite:true`；默认不覆盖，不导出到工作区外。

## 绘图指导

先按含义分组，保持一致节点尺寸，给箭头和中文文字留足空间，控制每张图的层级密度。颜色表达分组，但不作为唯一信息载体。读代码画架构时只画已有证据支持的关系。

画板由本地插件提供，无需用户打开外部 Excalidraw 网站继续编辑。文档位于宿主绑定、按会话隔离的插件数据目录，不是导入文件的自动同步副本。
