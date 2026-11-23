# 桌面附件

`ipc.ts` 接收界面的附件请求。`attachment-upload-service.ts` 和 `attachment-file-service.ts` 分别上传本机附件和读取后台已有附件，通过公开 SDK 返回上传记录或文件。附件内容和会话关联由后台保存。

`readDocumentPreview` 按附件 ID 检查文档格式和大小，通过限定字节数的下载返回文档内容。界面将内容交给独立的文档预览页签。

设置页检查、修复或清理附件存储时，经 `attachment-storage-resource.ts` 使用已认证的后台连接返回报告。新增附件文件操作或存储维护请求放在本目录，新测试放在 `__test__/`。
