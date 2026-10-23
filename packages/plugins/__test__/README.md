# SDK 编译测试

通过 TypeScript 编译检查公开插件 SDK 的使用约束。

## 主要文件与目录

- [sdk.type-test.ts](./sdk.type-test.ts)

## 入口与处理步骤

运行包的 check-types，专用配置编译 sdk.type-test.ts，检查合法调用及预期类型错误。

## 状态放在哪里

只有编译期声明，不创建运行期实例。

## 新代码与测试

SDK 编译用例放在这里，由 `tsconfig.sdk-tests.json` 的 include 覆盖。
