# 示例插件打包

把示例原生插件目录打包为可分发的 ZIP。

## 主要文件与目录

- [package-example-plugins.mjs](./package-example-plugins.mjs)

## 入口与处理步骤

调用 packageExamplePlugins 或包命令，遍历插件目录并检查 manifest，再把归档写入指定输出目录。

## 状态放在哪里

输入位于示例目录；输出 ZIP 保存在调用方指定目录。

## 新代码与测试

新增脚本放在这里；对应测试放在同层的 `__test__/`，包的 Vitest 配置同时覆盖 src 与 scripts。
