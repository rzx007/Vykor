# 插件安装与记录

维护安装路径、版本缓存、安装记录、完整性检查和安装执行。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [cache.ts](./cache.ts) | `computePluginBehaviorDigest`、`assertRegularPluginCacheSnapshot`、`materializePluginCache` |
| [installer.ts](./installer.ts) | `requestedPluginPermissions`、`InstallLocalNativePluginInput`、`InstallLocalNativePluginResult` |
| [paths.ts](./paths.ts) | `NativePluginPathErrorCode`、`NativePluginPathError`、`resolveNativePluginPath` |
| [store.ts](./store.ts) | `NativePluginInstallScope`、`InstalledPluginRecord`、`InstalledPluginStoreV1` |
| [verify.ts](./verify.ts) | `InstalledNativePluginVerification`、`verifyInstalledNativePlugin` |
| [relocation.ts](./relocation.ts) | `relocateInstalledPluginStore`：校验暂存实物，只改安装记录的受管缓存路径 |

## 入口与处理步骤

主要入口或定义见 [cache.ts](./cache.ts)。

准备来源与安装目录，检查插件及批准信息，再写入缓存和安装记录；后续从记录定位并验证安装结果。

## 状态放在哪里

版本文件保存在安装缓存；安装状态和批准信息由本目录的安装记录管理。

迁移调用 `relocateInstalledPluginStore(copyStore, moves, { stagedRoot, targetRoot })`。`moves` 指向最终根；验证器读取投影到 `stagedRoot` 的插件副本，不要求最终目标已经安装。全部插件身份、权限和内容摘要校验成功后才原子替换副本记录；外链路径、批准信息、版本、摘要和 revision 不变。两个参数的形式只用于副本已位于最终物理位置的调用，暂存阶段必须传第三个参数。不要为通过摘要验证修改插件文件。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
