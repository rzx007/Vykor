# 模型图片内容

从本地图片生成满足模型输入大小限制的内容，并处理历史工具结果中已经丢失的图片。

## 主要文件

- [vision-image-preparer.ts](vision-image-preparer.ts)：读取图片、校验大小、旋转缩放、编码与缓存。
- [native-image-payload.ts](native-image-payload.ts)：为消息准备图片内容，生成 data URL，替换缺失历史图片。

## 调用与状态

公开客户端的 `prepareUserContent` 是调用入口；客户端内部调用 `prepareUserContentWithVisionImages` 和 `prepareNativeImagePayload`。这些底层函数没有从包根直接导出。

先检查媒体类型和源文件，再校验实际图片数据；符合要求的图片可直接复用，否则通过 sharp 转换。准备结果带尺寸、编码大小和策略版本，供客户端组装请求；缺失的历史工具图片改为文字说明。

Computer 只把宿主已核对尺寸和大小的窗口图像放进一次模型请求。`prepareNativeImagePayload` 直接使用这份内存数据，Provider 完成组装后会在发送前再核对截图权限。重试和工具历史使用文字结果。含图请求失败时，Core 保留结构化错误类别和数字用量，供应商错误原文和开放的计量字段不会进入会话记录。

`sharedVisionImagePreparer` 持有有容量和闲置时间限制的内存缓存，并合并相同图片的进行中请求；源文件仍归调用方管理，准备结果不会写回源文件。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
