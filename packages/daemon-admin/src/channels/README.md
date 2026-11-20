# 渠道管理

从 `@vykor/daemon-admin/channels` 使用 `ChannelResource` 查询投递状态、启停渠道、接入飞书或修改允许名单。客户端调用现有渠道路由，daemon 保存接入状态、运行连接和配对回执。新增管理请求放在 `channel-resource.ts`，传输回归放在 [__test__/](./__test__/README.md)。
