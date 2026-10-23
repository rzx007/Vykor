# SDK 编译测试

通过 TypeScript 编译检查公开插件 SDK 的使用约束。

## 主要文件与目录

- [sdk.type-test.ts](./sdk.type-test.ts)
- [app-client.type-test.ts](./app-client.type-test.ts)：页面工具名、参数、可选结构化结果及原传输选项的类型约束。

## 入口与处理步骤

运行包的 check-types，专用配置编译 sdk.type-test.ts，检查合法调用及预期类型错误。

`tsconfig.app-client-tests.json` 在只有浏览器类型的环境中检查页面调用，以及 Text Inspector、Notes、天气模板与官方 App 的兼容性。`check-types` 还检查独立插件携带的自动生成文件是否与源码一致。

## 状态放在哪里

只有编译期声明，不创建运行期实例。

## 新代码与测试

SDK 编译用例放在这里，由 `tsconfig.sdk-tests.json` 的 include 覆盖。
