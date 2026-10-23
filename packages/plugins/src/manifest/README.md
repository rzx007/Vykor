# 原生 manifest 校验

检查原生插件 manifest 的结构和字段。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [schema-v1.ts](./schema-v1.ts) | `VykorPluginManifestV1Schema` |
| [validate.ts](./validate.ts) | `validateNativePlugin` |

## 入口与处理步骤

主要入口或定义见 [schema-v1.ts](./schema-v1.ts)。

读取 manifest 后先检查 schema 与字段，生成验证结果，只有通过验证的数据才交给后续加载和安装。

## 状态放在哪里

安装文件和安装记录由 installation 管理；加载与激活结果、运行期实例由调用方管理。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
