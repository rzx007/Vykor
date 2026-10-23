# 统计图表

放置可以被多个页面复用的图表。业务数据的筛选、聚合和文案留在对应页面目录。

## 来源与入口

- [donut-chart.tsx](donut-chart.tsx)：从 beUI 公共 MCP 的 `donut-chart` 完整接入，来源为 [beUI Donut Chart](https://beui.dev/charts/donut-chart)。没有新增运行时依赖。
- [donut-chart/](donut-chart/README.md)：环形几何计算、共享交互状态、图形、中心读数与图例。

页面通过 `DonutChart` 提供真实的分组数据，再组合 `DonutChartPlot`、`DonutChartCenter` 和 `DonutChartLegend`。悬停与键盘聚焦共享同一活动项；状态保存在图表实例内，不写入用户设置。

接入时使用现有 `@renderer` 别名、`lib/utils`、`lib/ease` 与悬停检测 hook。按照桌面设计基线，图形直接显示，悬停只改变强调程度，过渡为 180ms，并支持减少动态效果；不旋转或缩放图形。极小占比使用准确角度和平端帽，避免圆端帽把它放大成互相重叠的圆点。
