# Git Source Resolver v1 设计

日期：2026-09-14

## 目标

让 Desktop 插件页可以从 Git 地址安装一个 Native Plugin。Git 只是一种来源；clone 后仍然进入现有 Native Plugin 校验、权限确认、不可变快照和 Runtime 诊断链路。

## 范围

包含：

- 输入 Git URL，可选 branch、tag 或 commit；
- 后台调用系统 `git` 获取源码，不自己实现 Git 协议；
- 安装前固定到实际 commit；
- 移除 `.git` 元数据后再交给 Native Installer；
- 复用现有权限确认和成功/失败反馈。

不包含：

- 自动更新；
- npm 来源；
- archive URL；
- Marketplace；
- 自动依赖安装；
- Agent 对话内安装。

## 用户交互

插件页不放常驻安装表单，避免管理页被安装入口挤占。入口放在右上角“添加”菜单：

```text
添加
├─ 导入插件包
└─ 从 Git 安装
```

点击“从 Git 安装”后打开一个小弹窗，只包含 Git 地址、可选 ref 和“安装”按钮。校验仍由后台完成，用户只看到成功、权限确认或失败反馈。

结果仍然只有三类：

- 成功：已安装或更新，下一次对话生效；
- 需要权限：展示一次权限确认；
- 失败：显示失败原因和重试建议。

## 技术边界

`@openharness/plugin-sources` 增加 `resolveGitPluginSource()`：

```text
validate url/ref
→ git init
→ git remote add origin <url>
→ git fetch --depth=1 origin <ref|HEAD>
→ git checkout --detach FETCH_HEAD
→ rev-parse HEAD
→ remove .git
→ return candidateRoot + commit + sourceDigest + cleanup
```

`sourceDigest` 绑定 URL、ref 和实际 commit。安装时重新 resolve，如果 digest 改变，要求重新预览。
