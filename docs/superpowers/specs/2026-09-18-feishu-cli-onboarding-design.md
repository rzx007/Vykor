# 飞书 CLI 扫码接入设计

## 1. 背景与问题

目前接入飞书机器人只有一条路：用户手改 `~/.vykor/settings.json`，手写 `channels.feishu`
的 `appId/appSecret/allowFrom`，`appSecret` 还是明文，`allowFrom` 需要用户自己想办法找到
`ou_xxx`/`oc_xxx`。没有向导、没有校验、没有密钥保护。

`vk config set` 也帮不上：它只支持一层嵌套，遇到 `channels.feishu.appId` 这种三段 key 时
会把整个 `channels.feishu` 覆盖成裸值（`apps/cli/src/config-coerce.ts`），不是报错拒绝。

参考仓库 `dsh-im` 证明了飞书有官方“**扫码创建应用**”能力（Node SDK 的 `registerApp`）：
用户用飞书 App 扫码并确认，SDK 直接返回新应用的 `app_id/app_secret`。本设计把这条能力落到
Vykor 的 CLI 上：`vk channels add feishu`，**扫码优先、手填兜底**。本仓库已完成一次
spike（附录 A），确认扫码建应用与长连接收消息均可行。

## 2. 目标与非目标

### 2.1 目标

- 新增 CLI 向导 `vk channels add feishu`：扫码创建应用（默认）或手填 App ID/Secret。
- 拿到凭据后**当场校验**（必做：换 tenant access token；尽力：查机器人名称）。
- 密钥写**独立凭据文件**，不再明文进 `settings.json`。
- 默认把**扫码者本人**加入白名单，接入后即可私聊验证。
- 新增 `vk channels allow <id>` 把用户/群加入白名单；被拒时给可执行提示。
- 让白名单支持“按群放行”（ACL 同时匹配发送者和会话）。
- 抽一个可复用的“飞书接入核心”，CLI 先用，未来桌面复用。

### 2.2 非目标

- 桌面 UI（下一阶段复用同一核心）。
- 多机器人（本阶段单机器人，沿用现有 `channels.feishu` 单对象）。
- 对已有应用“增量补权限”（`/repair` 类能力）。
- Webhook 模式与 `encryptKey`/`verificationToken`（本阶段只用长连接）。
- Telegram / Slack / Discord / 微信 / 企业微信 / 钉钉。
- **不迁移、不读取**旧的明文 `appSecret`（见 §4.4、§5.4）。
- `apps/mcp-feishu`（无 `package.json`、不参与构建的历史目录）本阶段不改造，列在 §9 风险中。

## 3. 关键决策

| 决策 | 结论 |
|---|---|
| 落地位置 | 共享核心 + CLI 向导；桌面后续复用 |
| 密钥存储 | 独立凭据文件 `~/.vykor/channel-credentials.json`（异步 API + 原子写 + POSIX 0600） |
| 接入与运行 | 分开：`add` 只接入，运行仍用 `vk channels serve` |
| 默认白名单 | 只放扫码者本人（`user_info.open_id`）；手填路径默认空并提示 |
| 手填字段 | `App ID` + `App Secret` + 地区（feishu/lark，默认 feishu），当场校验 |
| 机器人数量 | 单机器人 |
| 旧明文密钥 | 不迁移、运行时忽略；但**白名单仍接受旧键**，避免旧配置加载直接崩（§4.4） |
| 群白名单 | ACL 扩展为“发送者或会话任一命中即放行”，使 `allow oc_...` 生效 |
| 连带消费方 | `FeishuPush` 工具同步改造为读凭据文件；`apps/mcp-feishu` 不改造（不构建） |
| `allow` 小命令与“被拒提示” | 进本版 |

## 4. 架构与文件落点

### 4.1 依赖升级

- `packages/channels/package.json`：`@larksuiteoapi/node-sdk` 由 `^1.60.0` 升到 `^1.73.0`
  （`registerApp` 只有新版有）。升级后必须跑通 `packages/channels` 全量测试与类型检查。
- `apps/cli/package.json`：`qrcode-terminal` 加到 **dependencies**（CLI 构建会把
  `dependencies` 设为 external 运行时安装，`devDependencies` 会被打进 bundle），
  `@types/qrcode-terminal` 加到 devDependencies。

### 4.2 飞书接入核心（`packages/channels`）

- `packages/channels/src/impl/feishu-registration.ts`
  - `class FeishuRegistration`：包一层 SDK `registerApp`（可注入，便于测试），
    暴露 `start(options)` / `status()` / `cancel()`。
  - 状态：`starting` | `qr_ready` | `polling` | `slow_down` | `domain_switched` |
    `succeeded` | `expired` | `cancelled` | `error`。
    - SDK 的 `onStatusChange` 只发 `polling/slow_down/domain_switched`；
      `qr_ready` 由 `onQRCodeReady` 触发，`expired` 由包装层定时器按 `expireIn` 判定，
      `cancelled`/`succeeded`/`error` 由包装层按结果置位。
  - `status()` 产出：`state`、二维码 `url`、`expiresAt`、`pollIntervalMs`、`attempt`、
    最终 `domain`、`error`。
  - `start` 预填（`createOnly: true`）：
    - `appPreset`：应用名/描述。
    - `addons.scopes.tenant`：精确常量列表，见下。
    - `addons.events.items.tenant`：`["im.message.receive_v1"]`。
    - `addons.callbacks.items`：`["card.action.trigger"]`。
  - **预填 scope 常量**（与 `dsh-im` 对齐，按需裁剪）：
    `im:message.p2p_msg:readonly`、`im:message.group_at_msg:readonly`、
    `im:message:send_as_bot`、`im:resource`。
  - 扫码成功结果里的 `user_info.tenant_brand`（`"feishu" | "lark"`）用于推导 `domain`；
    缺失时回退到用户选择（默认 `feishu`）。
  - 经 `packages/channels/src/index.ts` 导出，供 CLI 使用。
- `packages/channels/src/impl/feishu-verify.ts`
  - `verifyFeishuCredentials({ appId, appSecret, domain, fetchImpl? })`：
    1) **必做**：`POST /open-apis/auth/v3/tenant_access_token/internal` 换 token；失败即校验失败。
    2) **尽力**：`GET /open-apis/bot/v3/info/` 取机器人信息；该 legacy 接口响应是顶层
       `bot` 对象，字段名为 `app_name`/`open_id`/`activate_status`（**不是** `data.name`）。
       取不到只影响展示，不影响“接入成功”。
  - 返回 `{ appId, name?, openId?, activated? }`；错误分类：凭据错误 / 网络错误 / 地区不符，
    错误信息不回显密钥。
- `FeishuConfig`（`packages/channels/src/impl/feishu.ts`）增加 `domain?: "feishu" | "lark"`，
  并在 `connect()` 里传给 `lark.Client` 与 `lark.WSClient`（具体取值形式以实现时 SDK 类型为准，
  计划里安排一次真实验证：Lark 与 Feishu 各连一次）。

### 4.3 凭据存储（`packages/auth` + `packages/core`）

- 新增 `packages/core/src/config/paths.ts` 的 `getChannelCredentialsFilePath()`，
  并在 `packages/core/src/index.ts` 导出（对齐 `getMcpOAuthFilePath`）。
- 新增 `packages/auth/src/channel-credential-store.ts`：`ChannelCredentialStore`
  - **异步** API：`get(appId): Promise<string | undefined>`、
    `set(appId, secret): Promise<void>`、`delete(appId): Promise<void>`。
  - 文件结构：`{ version: 1, credentials: { [appId]: { appSecret } } }`，逐字段校验。
  - 实现照 `packages/auth/src/mcp-oauth-credential-store.ts`：同目录临时文件 + rename 原子写、
    POSIX `0600`（Windows 跳过 chmod，依赖用户目录 ACL）、跨进程文件锁。
  - **坏文件处理**：文件不存在（ENOENT）当空；结构非法/JSON 解析失败 **抛明确错误**
    （不回显内容），与 §7 “不做兼容 fallback” 一致。测试名按此定。

### 4.4 配置结构变化（`packages/core`）

- `FeishuChannelSettings` 调整为：`enabled`、`appId`、`domain`（`"feishu" | "lark"`）、
  `allowFrom`、`replyAtBotNames`。
- 运行时**不再读取** `appSecret`/`encryptKey`/`verificationToken`。
- **但字段白名单仍保留这三个旧键**（`packages/core/src/config/settings.ts`）：
  否则 `assertKnownFields` 会对旧 `settings.json` 直接抛 `SettingsFileError`，
  导致 CLI/TUI/daemon 启动即挂。保留即“接受但忽略”，运行时得不到、也不使用旧密钥。
- 这是行为上的破坏性变更：旧 `appSecret` 不再生效，用户需重新 `vk channels add feishu`。

### 4.5 白名单 ACL 扩展（`packages/channels`）

- 现状：ACL 只比对 `msg.sender`（`manager.ts` → `isAllowed`），而 Feishu 的 `sender`
  永远是发送者 `open_id/user_id`，群 `oc_...` 从不出现，所以 `allow oc_...` 目前无效。
- 改为：`isAllowed` 接收 `{ sender, chatId }`，**发送者或会话任一命中即放行**；
  `manager.handleInbound` 传入 `msg.chatId`。
- 效果：`allow ou_...` 放行某人；`allow oc_...` 放行某群内所有（已通过 allowFrom 的）成员。
- 保持 fail-closed：名单为空仍全拒。

### 4.6 CLI（`apps/cli`）

- `apps/cli/src/commands/channels.ts` 增加子命令：
  - `channels add feishu`：接入向导（§5）。
  - `channels allow <id> [--name <备注>]`：写 `allowFrom`；校验前缀 `ou_`/`oc_`。
  - `channels serve`：组装 adapter 时非敏感项读 settings、`appSecret` 读凭据文件、
    `domain` 透传 adapter；读不到凭据则报错提示先 `add`，不做猜测。
- 向导交互沿用 `node:readline`（与 `apps/cli/src/commands/setup.ts` 一致），不引入新交互库。
- 终端二维码用 `qrcode-terminal`；始终同时打印授权链接兜底（非 TTY/CI 下只打印链接）。
- **被拒提示**：给 `ChannelManager` 增加结构化回调 `onDenied?({ channel, sender, chatId })`
  （不改现有 `onWarning` 字符串签名）。CLI 在 `serve` 里接上，打印
  `拒绝来自 <sender> 的消息；如需放行：vk channels allow <sender>（改完需重启 channels serve）`。
- **连带改造**：`packages/tools/src/channels/feishu-push.ts` 改为
  `settings` 取 `appId/domain`、`ChannelCredentialStore` 取 `appSecret`；
  `packages/tools/package.json` 增加 `@vykor/auth` 依赖。

## 5. 交互流程：`vk channels add feishu`

### 5.1 选择方式

提示二选一：**扫码接入**（默认）或**手动填写**。

### 5.2 扫码路径

1. 调 `FeishuRegistration.start()`（`createOnly: true`）。
2. 终端画二维码 + 打印授权链接与有效期；期间显示轮询状态。
3. 用户在飞书 App 扫码确认 → 得到 `appId/appSecret/user_info.open_id`、`tenant_brand`。
4. 用 `tenant_brand` 推导 `domain`；校验（§5.5）→ 写配置与凭据（§5.6）。
5. 过期 → 询问“刷新二维码 / 取消”；取消或 Ctrl+C → `cancel()`，不写任何配置。

### 5.3 手填路径

1. 输入 `App ID`、`App Secret`、地区（默认 `feishu`；非法输入重新询问）。
2. 校验（§5.5）→ 写配置与凭据（§5.6）。
3. 没有扫码者身份，白名单保持用户已有的（不新增），提示用
   `vk channels allow <id>` 添加。

### 5.4 旧明文密钥

运行时忽略；白名单保留旧键以免旧配置加载失败（§4.4）。用户需重新 `add` 才有密钥。

### 5.5 校验

- 扫码与手填都调用 `verifyFeishuCredentials`。
- 通过：打印机器人名称（若取到），继续。
- 失败：打印人话错误（区分凭据错误 / 网络 / 地区不符），**不写任何配置**，退出非 0。

### 5.6 写入内容与顺序

- 凭据文件：`{ [appId]: appSecret }`（同 `appId` 已存在则覆盖）。
- `settings.json` 的 `channels.feishu`：
  - `enabled: true`、`appId`、`domain`；
  - `allowFrom`：**合并**（保留已有条目），扫码路径额外加入扫码者
    `{ [openId]: openId }`；
  - 保留已有 `replyAtBotNames`。
- **写入顺序与回滚**：先写凭据文件；写失败直接报错退出（未动 settings）。
  再写 settings；若 settings 写失败，尽力删除刚写入的凭据条目作为回滚，并报错。
- **重复 `add`**：若已是 `enabled` 且有凭据，先提示“将覆盖现有接入配置”，确认后才继续；
  拒绝则不做任何修改。
- 收尾提示：
  - 运行 `vk channels serve` 开始收发；
  - 提醒在飞书开发者后台确认事件订阅方式为“使用长连接接收事件”。

## 6. `allow` 命令与被拒提示

- `vk channels allow <id> [--name <备注>]`：
  - `<id>` 必须是 `ou_...`（个人）或 `oc_...`（群聊），否则报错；
  - `--name` 缺省时用 id 本身做 key；
  - 写入 `settings.channels.feishu.allowFrom`，同名 key 幂等覆盖；
  - 未接入（无 `appId`）时报错提示先 `add`；
  - 命令末尾提示“已写入，重启 `vk channels serve` 生效”（运行中不热重载）。
- 被拒提示：见 §4.6，由 `onDenied` 结构化回调驱动，附 `vk channels allow <sender>` 与重启提示。

## 7. 严格性与安全

- 扫码一律 `createOnly: true`，只建新应用，绝不覆盖已有应用。
- 密钥只落独立凭据文件；日志、状态、错误信息、`status` 输出都不回显 `appSecret`。
- 校验失败即失败，不静默降级；读不到凭据直接报错，不用其它来源猜测。
- 旧密钥不迁移、不读取；但允许旧键存在以避免旧配置整体加载失败（§4.4）。
- 地区映射：`feishu` → 扫码 `accounts.feishu.cn`、API `open.feishu.cn`；
  `lark` → `accounts.larksuite.com`、`open.larksuite.com`。
- 凭据文件权限：POSIX `0600`；Windows 无 chmod 保证，依赖用户目录 ACL（已知限制）。
- 不做任何兼容性 fallback。

## 8. 测试计划

- `feishu-registration`：注入假 `registerApp`，覆盖 `qr_ready/polling/slow_down/domain_switched/
  expired/cancelled/error/succeeded`、过期刷新、重复 start、cancel；`tenant_brand` 推导 domain。
- `feishu-verify`：注入假 HTTP，覆盖成功、凭据错误、网络错误、缺 token；bot info 失败不影响通过。
- `channel-credential-store`：读写/删除、原子写、`0600`（POSIX）、并发写锁、
  ENOENT 当空、坏 JSON/非法结构抛明确错误。
- ACL：`isAllowed({sender, chatId})` 的 发送者命中 / 会话命中 / 都不命中 / 空名单全拒。
- settings：新字段类型与白名单校验（旧键被接受但运行时取不到）。
- CLI 编排：注入假 registration / verify / 输入 / 凭据存储，覆盖扫码路径、手填路径、
  校验失败不写配置、重复 `add` 的确认、写 settings 失败回滚、`allow` 命令前缀校验与写白名单、
  `serve` 从凭据文件读 secret、缺凭据报错、`onDenied` 打印提示。
- `FeishuPush`：改为从凭据文件取 secret 后的行为（缺凭据给明确错误）。
- 回归：SDK 升级后 `packages/channels` / `packages/auth` / `packages/core` / `packages/tools` /
  `apps/cli` 测试与类型检查全绿。

## 9. 验收标准

- 以下测试全绿：
  - `pnpm --filter @vykor/channels test -- --run`
  - `pnpm --filter @vykor/auth test -- --run`
  - `pnpm --filter @vykor/core test -- --run`
  - `pnpm --filter @vykor/tools test -- --run`
  - `pnpm --filter @rzx/ohs test -- --run`
- 相关包 `check-types` 退出码 0。
- `pnpm exec turbo build --output-logs=full` 全部成功。
- `git diff --check` 无格式错误。
- 手工验收（人工执行一次，记录结果）：`vk channels add feishu` 扫码 → 校验通过 →
  写入配置与凭据 → `vk channels serve` 能收发一条私聊消息。

## 10. 风险

| 风险 | 缓解 |
|---|---|
| SDK `1.60→1.73` 有破坏性变化 | 单独一步升级并跑全量 channels 测试；不通过先解决再继续 |
| `domain` 传给 SDK 的取值形式不确定 | 计划中安排 Lark/Feishu 各真实连一次验证；以 SDK 类型为准 |
| bot info legacy 端点字段/包层特殊 | 只作尽力展示；主校验用 tenant token；计划中真实调用验证 |
| 终端二维码在部分字体/终端难扫 | 始终同时打印授权链接 |
| 配置破坏性变更（旧 appSecret 失效） | 白名单保留旧键避免加载崩溃；错误与文档写清需重新 `add` |
| `FeishuPush` 依赖被连带修改 | 纳入本设计改动清单并加依赖 |
| `apps/mcp-feishu` 读不到旧密钥 | 该目录无 `package.json`、不参与构建；本阶段不改造，列此备忘 |
| 企业安全策略禁用扫码建应用 / 需审批 | 错误分类与提示明确；文档说明可能需管理员审批 |
| 网络/代理导致 registerApp 或校验失败 | 错误信息区分网络问题；沿用 SDK 代理感知 HTTP 客户端 |
| Windows 无 0600 | 明确为已知限制，依赖用户目录 ACL |

## 11. 自检

- 是否聚焦“接入体验”单一目标？是，运行与消息语义不变（唯一例外是必要的 ACL 扩展）。
- 是否保持严格性、不引入 fallback？是；旧键仅“接受但不读取”，不是行为回退。
- 是否可被桌面复用？是，核心与渲染分离，核心只出数据。
- 是否覆盖连带消费方？是，`FeishuPush` 纳入改造，`mcp-feishu` 列风险备忘。
- 是否有明确验收？是，§9。
- 是否标注破坏性变更？是，§4.4、§5.4、§10。

---

## 附录 A：spike 结论

### A.1 已实测（本次 spike 真跑过）

- 飞书官方 Node SDK `registerApp` 存在：仓库现有 `1.60.0` 没有；实测 `1.73.0` 有，
  并导出 `registerApp`、`WSClient`、`EventDispatcher` 等。
- 本地跑通“生成二维码 + 轮询 → 扫码确认 → 返回 `appId/appSecret/user_info`”。
- 用返回凭据起 `WSClient` 长连接，成功收到 `im.message.receive_v1` 消息。
- 坑：`domain` 是主机名，不是 `"feishu"`；传 `"feishu"` 会 `getaddrinfo ENOTFOUND feishu`。
- SDK 日志提醒：事件订阅方式需在开发者后台设为“使用长连接接收事件”；实测扫码新建的应用默认可收。

### A.2 未实测（实现时必须验证）

- `appPreset` / `addons`（scope/events/callbacks 预填）与 `createOnly` 在扫码确认页的真实效果。
- **发送**消息（spike 只验证了**接收**）。
- `GET /open-apis/bot/v3/info/` 的真实响应包层与字段。
- `domain` 传给 `Client`/`WSClient` 的取值形式（字符串 host 还是 SDK `Domain`）。
- `user_info.tenant_brand` 在 Lark 租户下的取值。

### A.3 签名

```ts
interface RegisterAppOptions {
  domain?: string;          // accounts.feishu.cn / accounts.larksuite.com
  larkDomain?: string;
  source?: string;
  signal?: AbortSignal;
  onQRCodeReady: (info: { url: string; expireIn: number }) => void;
  onStatusChange?: (info: { status: "polling" | "slow_down" | "domain_switched"; interval?: number }) => void;
  appPreset?: { avatar?: string | string[]; name?: string; desc?: string };
  addons?: {
    preset?: boolean;
    scopes?: { tenant?: string[]; user?: string[] };
    events?: { items?: { tenant?: string[]; user?: string[] } };
    callbacks?: { items?: string[] };
  };
  appId?: string;           // 传了就是更新已有应用
  createOnly?: boolean;     // 只允许新建
}
interface RegisterAppResult {
  client_id: string;
  client_secret: string;
  user_info?: { open_id?: string; tenant_brand?: "feishu" | "lark" };
}
```

spike 工程位于系统临时目录，不属于本仓库交付物。
