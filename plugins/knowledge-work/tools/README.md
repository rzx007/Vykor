# 研究与写作工具

manifest 分别加载 `index.mjs`、`source-records.mjs` 和 `academic.mjs` 的 `registerTools`。`index.mjs` 组合预算、证据压缩、引用和写作检查；`source-records.mjs` 读取本轮宿主结果并保存来源及账本；`academic.mjs` 请求声明的学术 API 并保存真实来源。

研究来源和请求账本归插件 dataDir 下的 `research/`，报告与稿件归用户指定工作目录。构建不会读取、迁移或删除这些数据。相关算法放本目录，已有测试在 `../test/`，新增测试放本目录的 `__test__/`。
