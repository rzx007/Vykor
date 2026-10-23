# 图片标准化与文字识别

准备图片输入，并通过本地识别引擎读取图片文字。

## 入口与流程

图片标准化器处理大小与格式，本地识别服务调用 OCR 引擎并返回识别结果；错误模块统一处理能力不可用和读取失败。

## 状态归属

输入与输出属于当前处理任务，引擎资源由对应服务管理，附件的长期保存交给调用方。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [image-normalizer.ts](./image-normalizer.ts) | `OcrImageLimits`、`NormalizedOcrImage`、`normalizeOcrImage` |
| [light-ocr-engine.ts](./light-ocr-engine.ts) | `LightOcrEngineLibrary`、`LightOcrEngineOptions`、`LightOcrRecognition` 等 |
| [local-ocr-errors.ts](./local-ocr-errors.ts) | `LocalOcrErrorCode`、`LocalOcrError`、`normalizeLocalOcrError` |
| [local-ocr-service.ts](./local-ocr-service.ts) | `LOCAL_OCR_PROCESSOR`、`LOCAL_OCR_PROCESSOR_VERSION`、`OCR_NORMALIZATION_VERSION` 等 |

## 测试与维护

图片处理和识别适配放在这里，识别结果如何存入附件记录由 persistence 负责。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
