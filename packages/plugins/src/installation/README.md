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

## 入口与处理步骤

主要入口或定义见 [cache.ts](./cache.ts)。

准备来源与安装目录，检查插件及批准信息，再写入缓存和安装记录；后续从记录定位并验证安装结果。

## 状态放在哪里

版本文件保存在安装缓存；安装状态和批准信息由本目录的安装记录管理。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
