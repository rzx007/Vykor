# 插件市场

> 状态：当前实现与使用说明。

插件页的“浏览市场”从登记的 HTTPS 来源读取目录，用户选择插件后，宿主下载固定版本的 ZIP、校验内容，再进入现有 Native Plugin 安装流程。

## 官方来源

- [源码与发布规则](https://github.com/rzx007/vykor-plugins)。
- [市场目录](https://rzx007.github.io/vykor-plugins/marketplace.json)。
- [版本安装包](https://github.com/rzx007/vykor-plugins/releases)。

首批插件为 Excalidraw 1.0.0、Text Inspector 1.2.2、Notes 1.0.2。普通用户不需要 GitHub 登录、Git 或 npm；Excalidraw 运行服务需要 Node.js 24 或更新版本。

在插件页搜索、查看详情后点击安装。已有本地或其他来源的同 ID 插件会显示关联或更换来源入口，并明确确认替换。安装完成后可新建对话使用；不会自动向聊天发送消息。

## 自定义来源

通过插件页“添加 → 添加插件源”输入 HTTPS 目录地址，也可在市场的“插件源”中管理已有来源。来源停用或移除会撤销待确认安装，但保留已安装插件及其数据。内置来源可以停用，不能移除。

自定义源的 ZIP 必须与目录同源，不能重定向到陌生域名。目录格式来自 [市场契约源码](../packages/plugin-contracts/src/marketplace.ts)：插件 ID、名称、版本必须与实际包一致；安装包需要明确的 SHA-256、大小及宿主最低版本，Node 和平台要求按需声明。官方源的 GitHub Release 跳转只允许固定仓库与正常资源域名。

来源身份绑定规范化目录地址，不相信远端清单自称官方，也不因市场名称相同而合并。目录缓存 15 分钟，手动刷新跳过缓存；离线展示缓存和更新时间，不能用过期的不可用来源开始新安装。

## 安装和更新

1. 服务端读取目录，从来源、插件 ID 和版本选择条目，流式下载并核对大小、摘要和归档安全。
2. 从实际清单读取权限，固定候选包与内容摘要。Main 保管权限、操作 ID 和窗口/工作区关联，页面只得到短期确认凭据。
3. 新权限或换源需要明确确认。同源更新可复用仍有效的原授权，在安装锁内再次检查是否已撤销。
4. 原 Installer 创建不可变代码快照；提交前再次检查来源、取消和过期状态，来源记录与成功回执一起原子写入 `installed.json`。
5. 安装失败保留原安装。连接中断后查询原 `operationId`，不自动重新安装；未知结果明确显示未知，可刷新安装列表核对。

安装回执保留 7 天、最多 1000 条。未知或过期回执不能作为重复执行的依据。市场没有自动安装更新、自动依赖安装或代码热替换。

## 权限、应用和草稿

市场的分类、展示信息和能力标记不授予权限。`pluginData:write` 继续只授权已声明的应用专用工具保存自身数据，模型调用不能借用这份授权；工作区导出、覆盖文件仍按原流程确认。工具执行的原操作回执不改变。

更新不关闭会话、不强制重载应用、不删除插件数据。已打开面板继续使用捕获的代码快照与草稿，新版本在新运行实例中生效。立即使用新版前，请先处理旧面板的草稿，再手动重新打开。原草稿边界保持不变：页面内存草稿不承诺跨应用退出持久化。

普通 ZIP、Git 和本地安装也识别已绑定的来源，不能绕过换源确认。受管理插件不能被市场替换。SHA-256 用于确认下载内容与目录相同，不是独立的作者签名。

网络下载保持 HTTPS 证书和主机名验证，拒绝回环、内网及不安全重定向。内置固定来源允许本机 TUN 代理将域名映射到 `198.18/15`，此例外不允许回环或 RFC 1918 地址，也不扩展自定义源的访问范围。

## 代码职责

- [目录格式与数据类型](../packages/plugin-contracts/src/marketplace.ts)：校验分发数据。
- [来源读取和下载](../packages/plugin-sources/src/marketplace.ts)：来源配置、缓存、网络边界及下载校验。
- [安装协调](../packages/server/src/application/default-services/marketplace-service.ts)：候选包、兼容要求、权限、来源和安装回执。
- [原 Installer](../packages/plugins/src/installation/installer.ts)：代码快照与安装记录提交。
- [HTTP 入口](../packages/server/src/http/routes/marketplace.ts)和[客户端资源](../packages/client/src/resources/plugin-resource.ts)：共享请求与响应。
- [Protocol](../packages/protocol/src/index.ts)统一公开市场通信类型；Client 仍只直接依赖 Protocol。来源包复用插件契约的分发格式校验，不依赖安装器、Agent 或 Server。
- [桌面确认](../apps/desktop/src/main/features/plugin/marketplace-service.ts)和[市场界面](../apps/desktop/src/renderer/src/components/desktop/plugin-page/plugins/marketplace.tsx)：窗口绑定、用户确认和展示。

发布仓库按固定 Vykor 提交构建首批三个插件，采用全新临时检出和确定性 ZIP。先发布不可变 Release，后更新 Pages 目录；同版本摘要变化会拒绝发布，旧版本保留。
