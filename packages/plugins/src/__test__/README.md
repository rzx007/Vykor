# 插件跨分类测试

这里验证插件清单与组件读取之间的组合行为。单一分类测试放回对应分类的 `__test__/`。

`office-work-entry.test.ts` 是显式启用的官方插件兼容性检查：先设置 `VYKOR_OFFICIAL_PLUGINS_DIR` 指向 `vykor-plugins` 仓库的 `plugins` 目录，再运行此文件。未设置时跳过，宿主常规检查只使用本仓库测试夹具；不从邻居目录自动发现插件，不读取用户安装或数据。
