# 终端输出

短时合并终端输出并保留有上限的内存记录，供终端和 Jobs 按游标读取。

## 主要文件

- [output-buffer.ts](output-buffer.ts)：按短计时窗口合并片段，drain/dispose 时立即排空。
- [terminal-output-store.ts](terminal-output-store.ts)：按 sequence 保存片段、截断过旧内容并按 after 读取。

## 调用与状态

包根公开 `OutputBuffer` 和 `TerminalOutputStore`；通常由 `LocalTerminalProvider` 为每个终端创建实例。

PTY 数据进入 OutputBuffer，默认每 16 毫秒排出一批；排出回调追加到 TerminalOutputStore，获得递增 sequence 后通知订阅者。读取可传 after 和 maxChars，并返回是否截断。

OutputBuffer 保存待排出的字符串和计时器；TerminalOutputStore 默认只保留最近 200,000 个字符。二者只在内存中保存状态，释放 provider 后丢弃，不写磁盘文件。

## 新增代码与测试

同一职责的新代码放在本目录。测试放同层 [__test__/](__test__/)，跨分类场景放它们共同上层的 `__test__/`。
