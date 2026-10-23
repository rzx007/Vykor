# 请求检查

集中解析 HTTP 请求，并复用领域字段的检查规则。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [domain-validation.ts](./domain-validation.ts) | `adaptDomainValidation` |
| [requests.ts](./requests.ts) | `ProtocolError`、`ProtocolValidationError`、`assertPromptMetadataAllowed` |

## 入口与处理步骤

主要入口或定义见 [domain-validation.ts](./domain-validation.ts)。

请求体进入解析函数，字段逐项验证后返回明确的数据对象；验证失败时返回带字段位置和稳定错误代码的错误。

## 状态放在哪里

这里只定义和校验传输数据；业务数据由 Services 保存，客户端展示状态由 Client 保存。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
