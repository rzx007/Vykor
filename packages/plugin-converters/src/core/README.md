# 转换共用流程

组织转换器注册、计划、报告、内容摘要和再次转换。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [converter.ts](./converter.ts) | `ConversionFidelity`、`ConverterDiagnostic`、`ConversionItem` |
| [digest.ts](./digest.ts) | `digestValue`、`digestSource` |
| [plan.ts](./plan.ts) | 统一导出本分类的类型与函数 |
| [reconversion.ts](./reconversion.ts) | `ConversionBehaviorIdentity`、`needsReconversion` |
| [registry.ts](./registry.ts) | `ConverterRegistry` |
| [report.ts](./report.ts) | 统一导出本分类的类型与函数 |

## 入口与处理步骤

主要入口或定义见 [converter.ts](./converter.ts)。

注册或选择转换器，检查源内容并生成计划，执行后记录报告及摘要，供后续再次转换比较。

## 状态放在哪里

输入放在源目录；转换结果及转换记录放在目标目录，检查与计划对象由调用方持有。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
