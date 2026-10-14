# 统一示例插件源码与打包设计

## 目标

让 `examples/plugins` 成为仓库内可维护的示例和测试插件源码唯一位置。插件 ZIP 是从源码生成的临时产物，不再作为源码或测试夹具提交到 `artifacts/plugin-test`。

## 方案

- 将 `artifacts/plugin-test/agent-reviewer` 迁移到 `examples/plugins/agent-reviewer`。保留插件 ID、manifest 和测试用途，不改变插件运行行为。
- 在 `packages/plugin-sources` 中新增 Node 打包脚本，复用已有的 JSZip 依赖。脚本扫描 `examples/plugins` 的每个直接子目录；每个子目录都必须包含 `.vykor-plugin/plugin.json`，并生成一个 ZIP。
- 输出目录固定为仓库根目录的 `.plugin-dist`，输出名为 `<插件目录名>.zip`。ZIP 内保留插件目录这一层包装目录，便于 Desktop 安装器识别。
- 覆盖本次生成的同名 ZIP，但不清空输出目录、不删除其他文件。遇到无法读取的插件目录、缺少清单或写入失败时，脚本以非零状态明确报错。
- 在 `.gitignore` 忽略 `.plugin-dist/`，不将生成包误当作源码提交。
- 更新 Text Inspector README 和原生插件开发指南，统一改为调用这一条打包命令；保留有关归档格式及 Desktop 导入的说明。
- 保持当前两个旧 ZIP 的删除状态，不在实现时恢复或提交生成 ZIP。

## 使用流程

维护者只编辑 `examples/plugins/<plugin>` 下的源码。执行 `pnpm --filter @vykor/plugin-sources package:examples` 后，所有示例插件都会在仓库根目录的 `.plugin-dist` 下生成 ZIP；再从 Desktop 插件页导入所需包。新增示例插件无需再登记到单独的打包列表。

## 验证

- 将 Agent Reviewer 迁移后，插件校验及所有引用它的测试仍从 `examples/plugins/agent-reviewer` 读取。
- 运行打包命令，确认每个示例插件生成对应 ZIP，归档内保留顶层插件目录及 `.vykor-plugin/plugin.json`。
- 确认脚本重复运行可覆盖生成的同名包，错误路径会报告失败，且不会触碰其他输出文件。
- 运行受影响的插件来源测试及插件目录校验。
- 确认 `git status` 不会将 `.plugin-dist` 中的生成包列为待提交文件。

## 不在本次范围

- 不更改插件 manifest 的 ID、名称、权限或运行逻辑。
- 不自动安装插件或调用 Desktop；生成的 ZIP 仅用于本地导入，不纳入版本控制。
- 不删除 `artifacts/plugin-test` 中现有的 ZIP 删除记录或清理其他 artifacts。
