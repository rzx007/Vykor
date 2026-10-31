# 文件修改协调

让同一 Node 进程内、来自不同调用入口的文件修改共同排队，避免两个调用同时读取旧内容后互相覆盖。主要文件是 [file-mutation-coordinator.ts](file-mutation-coordinator.ts)，公开入口由 [../index.ts](../index.ts) 导出；回归测试放在 [__test__/file-mutation-coordinator.test.ts](__test__/file-mutation-coordinator.test.ts)。

## 调用入口与步骤

宿主文件入口先调用 `hostFileMutationKey(path, signal)`，得到用于排队的文件标识。函数把相对路径转为本机绝对路径，通过 `realpath` 找到最近存在祖先的真实位置，再接回尚未创建的目录和文件名。因此，指向同一现存目录的链接，以及新文件创建前后的路径，会使用相同标识。

调用 `withFileMutationLocks(keys, work, signal)` 后，先获得共享通行资格，再将标识去重、排序并逐个取锁。不同文件可以同时执行；涉及多个文件的调用使用相同取锁顺序，避免彼此等待。`work` 必须包括读取、校验和写入的完整过程；结果和异常原样返回调用方，结束时在 `finally` 中倒序释放文件锁和共享资格。

WSL 或其他无法可靠对应到宿主文件的后端，使用 `withUnidentifiedFileMutationLock(work, signal)`。它等待已进入的宿主调用结束，再独占整个文件修改入口；后来的宿主调用也要等待它完成。通行队列按到达顺序处理，连续的共享请求可一起进入，排在前面的独占请求不会被后续共享请求越过。不要在两个入口的 `work` 内再次嵌套调用本模块。

`signal` 只取消尚未开始的工作。等待文件锁或通行资格时取消，会移除该等待项并释放已取得的锁；`work` 开始后，即使收到取消信号，也要等 `work` 真正返回或抛错才释放，防止尚未结束的写入与后续调用重叠。

## 状态归属与支持范围

文件队列和共享／独占通行状态保存在 `globalThis` 的 `Symbol.for` 槽位中。同一 JavaScript 运行环境内的不同 owner、不同模块副本共享这些状态，不归某个 owner 持有或关闭。最后一个持有者退出后，空文件队列立即删除；通行状态只保留空队列和计数。不同进程或 Worker 线程需要由上层另行协调。

所有本机路径标识都统一 Unicode 组合形式并转为大写，防止大小写不敏感或忽略 Unicode 组合形式的磁盘为尚未创建的同一目标分配不同队列。大小写敏感的文件系统中，仅大小写或 Unicode 组合形式不同的两个真实文件会额外排队；实际读写始终使用原始执行路径，不会改名或写错文件。Windows 路径段末尾带点或空格、备用数据流、保留设备名和不支持的设备路径直接返回 `ENOTSUP`，不为它们分配可能错误的标识。悬空符号链接也返回 `ENOTSUP`。本模块不承诺识别硬链接、不同网络服务器名称或并发更换的链接；调用方无法确认宿主路径身份时应使用独占入口。

## 新增代码与检查

文件修改的排队、路径标识和跨入口协调逻辑放在本目录；文件内容转换、权限判断和具体读写仍由各调用入口负责。新增模块的测试放在本目录 `__test__/`，公开函数由包根入口显式导出，不增加只供测试调用的生产接口。

```bash
pnpm --filter @vykor/execution-node test src/files/__test__/file-mutation-coordinator.test.ts
pnpm --filter @vykor/execution-node check-types
```
