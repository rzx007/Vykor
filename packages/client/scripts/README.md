# 客户端构建与安装包验证

`build.mjs` 是构建入口：浏览器客户端与 Node 服务管理分别打包，公开类型声明同时合并进发布文件。源码仍通过工作区 Protocol 开发，安装包不依赖未发布的内部包。

Node 入口内联跨进程锁的实现，并将这些第三方代码的许可证汇总到 `dist/THIRD_PARTY_NOTICES.txt`。

`verify-pack.mjs` 在系统临时目录安装真实 npm tarball，执行 Node 客户端、本机服务、NodeNext/Bundler 类型检查和浏览器构建。服务夹具的协议版本取自已安装 SDK 的公开常量，随候选安装包一起验证；完成后删除本次创建的临时项目，不触碰用户服务。

会话文件验证同时检查五个只读方法及返回类型；真实安装包在 Node 和浏览器入口都能引用这些方法，类型检查和运行时检查确认没有写入、创建或删除文件的入口。

`release.mjs` 是根命令 `release:client` / `release:client:dry` 的实现，要求明确 `x.y.z`。临时设置候选版本，验证安装包后才调用发布；始终恢复 manifest。发布顺序和预演回归放在 `__test__/release.test.mjs`。

```powershell
pnpm --filter @rzx/client build
pnpm --filter @rzx/client test:pack
```

构建文件位于包内 `dist/`，业务数据仍在 daemon 中。新增发布产物检查放在这里，脚本自身的行为回归放在 `__test__/`。
