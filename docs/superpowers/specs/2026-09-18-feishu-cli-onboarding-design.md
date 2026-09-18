# 飞书 CLI 扫码接入设计

## 1. 背景与问题

目前接入飞书机器人只有一条路：用户手改 `~/.openharness-ts/settings.json`，手写 `channels.feishu`
的 `appId/appSecret/allowFrom`，`appSecret` 还是明文，`allowFrom` 需要用户自己想办法找到
`ou_xxx`/`oc_xxx`。没有向导、没有校验、没有密钥保护，`ohs config set` 也写不了嵌套字段。

参考仓库 `dsh-im` 证明了飞书有官方“**扫码创建应用**”能力（Node SDK 的 `registerApp`）：
用户用飞书 App 扫码并确认，SDK 直接返回新应用的 `app_id/app_secret`。这是“方便快捷接入”的关键。

本设计把这条能力落到 OpenHarness 的 CLI 上：`ohs channels add feishu`，**扫码优先、手填兜底**。
本仓库已完成一次 spike（附录 A），确认扫码建应用与长连接收消息均可行。

## 2. 目标与非目标

### 2.1 目标

- 新增 CLI 向导 `ohs channels add feishu`：扫码创建应用（默认）或手填 App ID/Secret。
- 拿到凭据后**当场校验**（换 tenant access token + 查机器人信息），失败给人话错误。
- 密钥写**独立凭据文件**，不再明文进 `settings.json`。
- 默认把**扫码者本人**加入白名单，接入后即可私聊验证。
- 新增 `ohs channels allow <id>` 把会话/用户加入白名单，并在消息被白名单拒绝时提示该命令。
- 抽一个可复用的“飞书接入核心”，CLI 先用，未来桌面复用。

### 2.2 非目标

- 桌面 UI（下一阶段复用同一核心）。
- 多机器人（本阶段单机器人，沿用现有 `channels.feishu` 单对象）。
- 对已有应用“增量补权限”（`/repair` 类能力）。
- Webhook 模式与 `encryptKey`/`verificationToken`（本阶段只用长连接）。
- Telegram / Slack / Discord / 微信 / 企业微信 / 钉钉。
- 旧 `settings.json` 里明文 `appSecret` 的迁移/兼容（**明确不做**，见 §5.4）。

## 3. 关键决策

| 决策 | 结论 |
|---|---|
| 落地位置 | 共享核心 + CLI 向导；桌面后续复用 |
| 密钥存储 | 独立凭据文件 `~/.openharness-ts/channel-credentials.json`（原子写 + POSIX 0600 + 文件锁） |
| 接入与运行 | 分开：`add` 只接入，运行仍用 `ohs channels serve` |
| 默认白名单 | 只放扫码者本人（`user_info.open_id`）；手填路径默认空并提示 |
| 手填字段 | `App ID` + `App Secret` + 地区（feishu/lark），当场校验 |
| 机器人数量 | 单机器人 |
| 旧明文密钥 | 不迁移、不兼容 |
| `allow` 小命令与“被拒提示” | 进本版 |

## 4. 架构与文件落点

### 4.1 依赖升级

- `packages/channels/package.json`：`@larksuiteoapi/node-sdk` 由 `^1.60.0` 升到 `^1.73.0`
  （`registerApp` 只有新版有）。升级后必须跑通 `packages/channels` 全量测试与类型检查。
- `apps/cli/package.json`：加 `qrcode-terminal`（终端里画二维码；只做渲染，不参与逻辑）。

### 4.2 飞书接入核心（`packages/channels`）

- `packages/channels/src/impl/feishu-registration.ts`
  - `class FeishuRegistration`：包一层 SDK `registerApp`，暴露 `start(options)` / `status()` / `cancel()`。
  - 状态：`starting` | `qr_ready` | `polling` | `slow_down` | `domain_switched` | `saving` | `succeeded` | `expired` | `cancelled` | `error`。
  - `status()` 产出：`state`、二维码 `url`、`expiresAt`、`pollIntervalMs`、`attempt`、`error`。
  - `start` 预填清单：`createOnly: true`；`appPreset`（名称/描述）；`addons` 预填收消息事件
    `im.message.receive_v1` 与必要 scope（发消息、读私聊/群 @ 消息、资源）；`callbacks` 预填
    `card.action.trigger`。
  - `registerApp` 支持注入，便于测试。
- `packages/channels/src/impl/feishu-verify.ts`
  - `verifyFeishuCredentials({ appId, appSecret, domain, fetchImpl? })`：
    1) `POST /open-apis/auth/v3/tenant_access_token/internal` 换 token；
    2) `GET /open-apis/bot/v3/info/` 取机器人 `name/open_id/activate_status`。
  - 返回 `{ appId, name, openId, activated }`；任一步失败抛明确错误（不回显密钥）。
- 复用 `packages/channels/src/impl/feishu.ts` 现有 adapter，不改消息收发语义。

### 4.3 凭据存储（`packages/auth`）

- 新增 `packages/auth/src/channel-credential-store.ts`：`ChannelCredentialStore`
  - `get(appId): string | undefined`
  - `set(appId, secret): void` / `delete(appId): void`
  - 文件：`$OPENHARNESS_CONFIG_DIR/channel-credentials.json`（默认 `~/.openharness-ts`），
    结构按 `appId` 存 `appSecret`。
  - 实现照 `packages/auth/src/mcp-oauth-credential-store.ts`：同目录临时文件 + rename 原子写、
    POSIX `0600`、跨进程文件锁、坏文件容错（读失败当空）。

### 4.4 配置结构变化（`packages/core`）

- `FeishuChannelSettings` 调整为非敏感字段：
  `enabled`、`appId`、`domain`（`"feishu" | "lark"`）、`allowFrom`、`replyAtBotNames`。
- **移除** `appSecret` / `encryptKey` / `verificationToken`（不再由 settings 承载）。
- 同步 `packages/core/src/config/settings.ts` 的字段白名单。
- 这是配置格式的**破坏性变更**：旧配置里的 `appSecret` 不再被读取，用户需重新 `add`（见 §5.4）。

### 4.5 CLI（`apps/cli`）

- `apps/cli/src/commands/channels.ts` 增加子命令：
  - `channels add feishu`：接入向导（§5）。
  - `channels allow <id> [--name <备注>]`：写 `allowFrom`。
  - `channels serve`：组装 adapter 时非敏感项读 settings、`appSecret` 读凭据文件；
    读不到则报错提示先 `add`，不做猜测。
- 向导交互沿用 `node:readline`（与 `apps/cli/src/commands/setup.ts` 一致），不引入新交互库。
- 终端二维码用 `qrcode-terminal`；同时打印授权链接作为兜底。

## 5. 交互流程：`ohs channels add feishu`

### 5.1 选择方式

提示二选一：**扫码接入**（默认）或**手动填写**。

### 5.2 扫码路径

1. 调 `FeishuRegistration.start()`（`createOnly: true`）。
2. 终端画二维码 + 打印授权链接与有效期；期间显示轮询状态。
3. 二维码过期 → 提示可刷新重新生成；支持 Ctrl+C 取消。
4. 用户扫码确认 → 得到 `appId/appSecret/user_info.open_id`。
5. 校验（§5.5）→ 写配置与凭据（§5.6）→ 用扫码者 `open_id` 作为默认白名单。

### 5.3 手填路径

1. 输入 `App ID`、`App Secret`、地区（feishu / lark）。
2. 校验（§5.5）→ 写配置与凭据（§5.6）。
3. 没有扫码者身份，白名单默认空，并提示用 `ohs channels allow <id>` 添加。

### 5.4 旧明文密钥

不做迁移、不做兼容读取：若 `settings.json` 仍有 `appSecret`，会被忽略（新配置类型里不存在）。
用户需重新运行 `ohs channels add feishu`。

### 5.5 校验

- 扫码与手填都会调用 `verifyFeishuCredentials`。
- 通过：打印机器人名称，继续。
- 失败：打印人话错误（区分凭据错误 / 网络 / 地区不符），不写任何配置，退出非 0。

### 5.6 写入内容

- 凭据文件：`{ appId → appSecret }`。
- `settings.json` 的 `channels.feishu`：`enabled: true`、`appId`、`domain`，
  白名单（扫码者 `open_id`，手填为空），保留已有 `replyAtBotNames`。
- 收尾提示：
  - 运行 `ohs channels serve` 开始收发；
  - 提醒在飞书开发者后台确认事件订阅方式为“使用长连接接收事件”。

## 6. `allow` 命令与被拒提示

- `ohs channels allow <id> [--name <备注>]`：
  - `<id>` 为 `ou_...`（个人）或 `oc_...`（群聊）；
  - `--name` 缺省时用 id 本身做 key；
  - 写入 `settings.channels.feishu.allowFrom`，幂等覆盖同名 key；
  - 未接入（无 `appId`）时报错提示先 `add`。
- 被拒提示：`ChannelManager` 现有 `onWarning` 已经打印“拒绝来自 <sender> 的消息”。
  CLI 把它转成更明确的一行提示，附“可运行 `ohs channels allow <sender>` 加入白名单”。

## 7. 严格性与安全

- 扫码一律 `createOnly: true`，只建新应用，绝不覆盖已有应用。
- 密钥只落独立凭据文件；日志、状态、错误信息、`status` 输出都不回显 `appSecret`。
- 校验失败即失败，不静默降级；读不到凭据直接报错，不用其它来源猜测。
- 地区映射固定：`feishu` → `accounts.feishu.cn`（扫码）/ `open.feishu.cn`（API）；
  `lark` → `accounts.larksuite.com` / `open.larksuite.com`。
- 不做任何兼容性 fallback。

## 8. 测试计划

- `feishu-registration`：注入假 `registerApp`，覆盖 `qr_ready/polling/slow_down/expired/cancelled/error/succeeded`、
  过期刷新、重复 start、cancel。
- `feishu-verify`：注入假 HTTP，覆盖成功、凭据错误、网络错误、缺少 token。
- `channel-credential-store`：读写/删除、原子写、`0600`、坏文件容错、并发写锁。
- settings：新字段类型与白名单校验（`appSecret` 被拒）。
- CLI 编排：注入假 registration / verify / 输入，覆盖扫码路径、手填路径、校验失败不写配置、
  `allow` 命令写白名单、`serve` 从凭据文件读 secret、缺凭据报错。
- 回归：升级 SDK 后 `packages/channels`/`packages/auth`/`packages/core`/`apps/cli` 测试与类型检查全绿。

## 9. 风险

| 风险 | 缓解 |
|---|---|
| SDK `1.60→1.73` 有破坏性变化 | 单独一步升级并跑全量 channels 测试；不通过就先解决再继续 |
| 终端二维码在部分字体/终端难扫 | 始终同时打印授权链接兜底 |
| 配置破坏性变更（移除 `appSecret`） | 明确不兼容、需重新 `add`；文档与错误提示写清楚 |
| 扫码前用户没有开发者权限 | 明确错误提示“需要能访问飞书开放平台的账号扫码” |
| 长连接要求后台事件订阅方式正确 | 接入收尾明确提示检查该项 |

## 10. 自检

- 是否聚焦“接入体验”单一目标？是，运行与消息语义不变。
- 是否保持严格性、不引入 fallback？是，密钥与配置不互相猜测。
- 是否可被桌面复用？是，核心与渲染分离，核心只出数据。
- 是否有明确测试与验收？是，第 8 节。
- 是否标注破坏性变更？是，§4.4、§5.4、§9。

---

## 附录 A：spike 结论（已实测）

- **能力来源**：飞书官方 Node SDK `registerApp`（`@larksuiteoapi/node-sdk`）。仓库现有 `1.60.0` 没有；
  实测 `1.73.0` 有。`1.73.0` 导出了 `registerApp`、`WSClient`、`EventDispatcher` 等。
- **签名**（摘自 `1.73.0` 类型）：
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
  interface RegisterAppResult { client_id: string; client_secret: string; user_info?: { open_id?: string } }
  ```
- **坑**：`domain` 是主机名，不是 `"feishu"`。传 `"feishu"` 会 `getaddrinfo ENOTFOUND feishu`。
- **实测结果**：本地跑通“生成二维码 + 轮询 → 扫码确认 → 返回 `appId/appSecret/user_info`”；
  再用返回的凭据起 `WSClient` 长连接，成功收到 `im.message.receive_v1` 消息。
- **长连接提示**：SDK 日志提醒事件订阅方式需在开发者后台设为“使用长连接接收事件”；
  实测扫码新建的应用默认可收到消息。
- **校验参考**：换 `tenant_access_token`（`POST /open-apis/auth/v3/tenant_access_token/internal`），
  再查机器人信息（`GET /open-apis/bot/v3/info/`）。
- spike 工程位于系统临时目录，不在本仓库；相关脚本与测试凭据不属于交付物。
