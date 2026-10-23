# 渠道配置存储

保存飞书或 Lark 应用凭据、启用状态、允许发送者及回复选项，供上层创建渠道连接。

## 主要文件

- [channel-config-store.ts](channel-config-store.ts)：飞书完整配置校验、查询、替换、更新、删除和文件锁。

## 调用与状态

从 `@vykor/auth` 使用 `ChannelConfigStore` 的 `getFeishu`、`setFeishu`、`updateFeishu`、`deleteFeishu`。

每次操作在文件锁内重读配置，校验 appId、appSecret、domain、allowFrom 等字段；修改通过临时文件替换写回。旧 v1 只有密钥，读取时视作渠道未配置，后续写入采用 v2 完整配置。

默认文件是 `getChannelCredentialsFilePath` 返回的配置目录下 `channel-credentials.json`，包含渠道密钥和配置；没有长期内存缓存。实际消息收发和渠道连接状态由调用方管理。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
