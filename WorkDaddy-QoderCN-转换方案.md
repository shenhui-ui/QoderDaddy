# WorkDaddy → Qoder CN 转换方案

> 目标：把 [babygoton/WorkDaddy](https://github.com/babygoton/WorkDaddy)（WorkBuddy 桌面端增强工具）的**能力与工程方法**，转换成面向 **Qoder CN 桌面端（v0.3.4，Electron 43.1.1）** 的专门适配层，代号暂定 **QoderDaddy**。
>
> 勘查方式：WorkDaddy 源码浅克隆全量分析（`_analysis/WorkDaddy`，约 39,800 行脚本）；Qoder CN 侧采用**静态分析 + 已装插件接口对齐**，未启动/重启任何客户端。
>
> 本文件为开源发布版本，已做脱敏：宿主二进制的字节偏移与打包内部路径不在公开版本中；插件 API 契约（写插件所必需）保留。

---

## 0. 结论摘要（TL;DR）

1. **WorkDaddy 的本质**是三层：`launcher（带 --remote-debugging-port 拉起宿主）` + `daemon（本地 HTTP API + CDP 客户端 + 注入器）` + `inject.js（在宿主渲染进程里跑的面板 UI）`，全部零侵入、不改宿主二进制。
2. **Qoder CN 不是 WorkBuddy 的同类物**：它是自定义 Electron 应用（React 19 + i18next + framer-motion），**自带一套官方 App Plugin 宿主**（独立进程、RPC、权限、视图挂载点、完整性校验），并有自己的 CLI、本地回环服务、SQLite 会话库。
3. 因此转换的正确形态**不是"照抄注入器"**，而是**双引擎**：
   - **引擎 A（主体，推荐）＝ 官方插件**：面板、后台常驻服务、模型/会话/用量/自动化/防休眠等一切"数据与逻辑"功能。官方 pluginHost 已经提供了 WorkDaddy 需要自己造的 daemon、watchdog、进程隔离、RPC、存储、更新承载面。
   - **引擎 B（可选增强包）＝ CDP 注入**：只做官方插件 API 覆盖不到的**宿主 UI 改造**（主题/毛玻璃、输入框旁按钮、免打扰自动点击、异常续接）。
4. WorkDaddy 里 **60%+ 的基础设施（daemon/watchdog/进程身份校验/端口令牌/打包）在 Qoder CN 上可以不要**；真正需要移植的是**功能逻辑与安全工程习惯**（备份原子写、AES-GCM 导出、只读 SQLite 适配、脱敏遥测、幂等注入、选择器兼容层）。
5. 主要风险：官方插件对第三方 `auth.readUserToken` 有按渠道分级的策略限制；Qoder CN 版本化安装目录（`.qoder-versions\<ver>`）导致路径漂移；CDP 开关必须出现在**首次启动参数**里（单实例锁），意味着启用注入增强必然重启客户端。

---

## 1. WorkDaddy 深度解析

### 1.1 定位

一款基于 Chrome DevTools Protocol 的 WorkBuddy / WorkBuddy AI 桌面端增强工具：多账号独立备份与点切、免打扰、跨账号会话迁移、异常续接、自动化任务、提示词暂存、毛玻璃主题等。AGPL-3.0-or-later，纯 Node.js（无构建流水线），Windows/macOS/Linux 三端发布。

### 1.2 总架构

```
┌─────────────┐  --remote-debugging-port=9222   ┌──────────────────┐
│  WorkBuddy  │ <────────────────────────────> │  WorkDaddy daemon │
│ (Electron)  │   CDP: Runtime.evaluate        │  node scripts/    │
│  渲染进程    │   Network/Page/Input 域          │  daemon.js        │
│  .wbs-root  │ <── 注入 inject.js ──           │  HTTP 127.0.0.1:47832 │
└─────────────┘                                └──────────────────┘
        ▲                                                ▲
        │ launcher(win-launcher/watchdog/relaunch-with-cdp)│
        └────────── 带调试参数拉起 + 端口就绪后 /api/inject ┘
```

### 1.3 启动链路（5 步）

| 步 | 动作 | 关键文件 |
|---|---|---|
| 1 | 定位宿主可执行文件并**带 `--remote-debugging-port` 重启**（Win 由 `win-launcher.js` 拉起 `.exe`；macOS `osascript`/`pkill` + `nohup`；Linux `setsid nohup env HOME=` 支持隔离 HOME） | `win-launcher.js:1112-1203`、`relaunch-with-cdp.sh` |
| 2 | 守护进程轮询 `http://127.0.0.1:<cdp>/json/version` + `/json/list`，做**目标归属判定**（拒绝兄弟客户端页面） | `daemon.js:1796-1930`、`cdp-targets.js:41-122` |
| 3 | 建立目标页 WebSocket，`Page.enable` / `Network.enable` / `Runtime.enable` | `daemon.js:2002-2016` |
| 4 | 注入：拼接 `toast-runtime.js + workbuddy-compat.js + inject.js`，替换占位符后 `Runtime.evaluate` 一发入魂，随后读回 `.wbs-root` 校验（重试 + 去重） | `daemon.js:3718-3856` |
| 5 | 面板通过 `fetch` 调本地 API（`X-WorkDaddy-Token` 头）；daemon 持续监听 Network 事件 → 登录/刷新令牌即备份账号 | `daemon.js:7346`(handleApi)、`inject.js:1783`(api 助手) |

### 1.4 模块地图（规模 / 职责）

| 模块 | 行数 | 职责 |
|---|---|---|
| `inject.js` | 15,535 | 注入到宿主的全部 UI + 宿主 DOM/React 适配（含 1k 行内联 CSS） |
| `daemon.js` | 10,047 | 本地 HTTP API、CDP 客户端、注入器、账号/主题/会话/模型/自动化业务 |
| `win-launcher.js` | 1,791 | Windows 启动器：找 Node、找宿主、版本校验、重启到 CDP 模式、触发注入 |
| `lib.js` | 1,656 | 账号文件解析/备份/切换、数据目录迁移 |
| `automation*.js`（10 个） | ~2,900 | 声明式任务引擎（触发器 + op 目录）、发现仓库、ZIP/JSON 导入导出 |
| `session-*.js`（4 个） | ~1,500 | 会话 SQLite 只读适配、跨账号文件集同步、AES-GCM 传输包、分支计算 |
| `theme-*.js`（3 个） | ~660 | 宿主 DOM 的 CSS 热补丁数组（60+ patch）、主题变量重映射 |
| `credit-*/growth-*/token-*` | ~2,000 | 官方 API 用量/积分/成长/签到（Bearer + token 刷新） |
| `watchdog.js` / `windows-process-boundary.js` / `linux-daemon-process.js` | ~570 | 单实例锁、指数退避守护、**PID/路径/属主三重校验后才 kill** |
| `profiles.js` / `workbuddy-target.js` / `cdp-targets.js` / `ui-port.js` | ~920 | 客户端 profile 表、能力位（capabilities）、自定义客户端发现与 `--configure` 契约、端口阶梯 |

### 1.5 核心机制（转换时最值得继承的部分）

**(a) 注入流水线**（`daemon.js:3813-3856`）
拼接脚本 → 占位符替换（`__WBS_API__`、`__WBS_VERSION__`、`__WBS_API_TOKEN__`、`__WBS_PROFILE__`、`__WBS_CAPS__`、`__WBS_PLATFORM__`）→ `Runtime.evaluate` 整体注入 → 读回 `window.__wbsWidget` 校验 → 失败延迟重试一次；1.5s 节流 + 手动注入 promise 去重。**不用 `addScriptToEvaluateOnNewDocument`**，而是显式在 `Runtime.executionContextCreated`（或 `Page.loadEventFired`）后重注入，并用手臂式 `pendingReloadInjection` 覆盖重载窗口期。

**(b) 注入幂等**（`inject.js:775-803`）
每次注入先"暴力清理"：删 `.wbs-root`/`#wbs-style`、对 `window.__wbsBuilds` 逐个 `destroy()`、清 6 个全局缓存（其中 `delete window.__wbsAdapter` 是踩过坑的**必须项**）；清理函数由 `createBuildLifecycle` 统一注册。

**(c) 目标归属判定**（`cdp-targets.js`）
不允许"连上第一个 CDP 端口就算数"：按 app bundle 路径 + 登录域做正/负向双重匹配，绑定 profile 前拒绝裸标题匹配——这是多客户端共存时的安全基石。

**(d) 本地 API 安全模型**（`daemon.js:5029-5071`）
loopback 绑定 + Origin 白名单（含 `null`）+ `x-workdaddy-token` 共享密钥 `timingSafeEqual`；`/api/inject` 对 launcher 开放但不校验 Origin；token 持久化在 `<dataDir>/.api-token` 并注入面板。

**(e) 账号备份/切换**（`lib.js:1297-1575`、`daemon.js:9613-9703`）
以官方 auth 文件（`<support>/CodeBuddyExtension/Data/Public/auth/workbuddy-desktop.info`）为唯一真源；`Network.requestWillBeSent` 命中 `auth|realms|login|token` 即去抖 1.5s 备份（另有 `fs.watch` + `fs.watchFile` 3s 兜底）；切换 = 校验 uid → 原子写（tmp + rename + chmod 600）→ CDP 重载页面（**绝不 quit/relaunch**）→ 等待 `pageReady` → 同标题会话自动聚焦 → 幂等自动复制任务。

**(f) 宿主 DOM/React 适配层**
`workbuddy-compat.js` 用"元素 DFS(≤300) + fiber return 上溯(≤400)"找 `props.adapter` 原型链上的队列方法，包成 shim 暴露 9 个队列方法 + `currentActiveSessionId`，并缓存到 `window.__wbsAdapter`（缓存失效陷阱有明确注释）。这套"适配层隔离官方 DOM 变化"的分层，是把 WorkBuddy 60+ 补丁堆到一个文件却仍可维护的原因。

**(g) 其它**：定时/事件/手动三类触发器 + op 能力目录的自动化引擎（`automation.js:94`，schema-v3，存 `<dataDir>/automations.json`）；AES-256-GCM + scrypt + gzip 的导出信封（`secure-transfer.js:67-108`，magic/version 自描述）；`node:sqlite` 只读适配 + CLI 兜底（`session-db.js:390-472`）；默认开启且可一键关闭的**脱敏** Sentry + 本地诊断（`sentry-report.js:158-183`）。

### 1.6 工程约束（AGENTS.md 的不可谈判项，转换时同样适用）

诊断先于修改；变更保持窄；**永不修改宿主安装包/签名**；永不打印/上传 token、cookies、账号备份内容；切换不走 quit/relaunch；daemon 行为变化必须 bump `DAEMON_VERSION`+`DAEMON_BUILD_ID`；遥测必须脱敏；面板 UI 必须"像原生长在那里"（复用宿主 CSS 变量、亮/暗双主题、稳定尺寸、幂等、避免全量 MutationObserver）。

### 1.7 可复用 vs 产品耦合

| 可直接复用（重命名/小改） | 必须重写（产品耦合） |
|---|---|
| AES-GCM 导出信封、SQLite 只读适配、原子写 | auth 文件路径与账号 JSON 形状 |
| 注入流水线骨架（拼接/占位符/校验/重试/幂等） | 全部 DOM 选择器、CSS 变量、React 内部方法名 |
| 目标归属判定**模式**、端口阶梯 + PID 身份校验 | CDP 端口表、profile 名、注册表键、exe 名 |
| 自动化引擎（触发器/调度/日志/导入导出） | 全部 op 实现（`dom.*`/`session.*`/`account.*`） |
| 脱敏遥测、幂等注入、亮暗双主题纪律 | 官方 API 域名与 `/v2/plugin`、`/billing/meter` 等端点 |
| 打包流水线骨架（Inno/dmg/deb/图标生成） | 品牌、安装目录、更新源、`catalog` 身份 |

---

## 2. Qoder CN 目标面勘查（本机 v0.3.4 实测）

### 2.1 运行时事实

| 项 | 值 | 来源 |
|---|---|---|
| 产品 | `productId=qoder-cn`，`appId=com.qodercn.app`，协议 `qoder-cn://`，更新源 `static.qoder.com.cn/qoder-app/releases` | `resources/product.json` |
| 内核 | **Electron 43.1.1**（Chromium 13x），win32 x64，user 级安装 | `resources/build-manifest.json` |
| 主进程 | 单包主进程，内含**插件宿主（pluginHost）**与远程控制进程模块 | 随包资源 |
| 渲染层 | React 19.2 + i18next + framer-motion + xterm + shiki；CSP 已放行 `frame-src http://127.0.0.1:*`（决定视图能否内嵌回环资源） | 随包资源 |
| 关键依赖 | `@qoder/plugin-api`、`@qoder-space/*`、`@ali/qoder-agent-sdk*`、`node-pty`、`sharp`、`node:sqlite` | 随包依赖清单 |
| 安装布局 | `<安装目录>`，实际程序在 **`.qoder-versions\<版本>\`**（版本化目录！），另有 `.qoder-update\`、`Qoder CN Launcher\`（含 `state.ini`/`install.ini`，含启动器互斥量） | 磁盘 |
| 单实例 | 请求单实例锁，并提供 `second-instance` 回调 → **命令行开关必须出现在首启 argv** | 运行行为观察 |

### 2.2 数据布局

| 路径 | 内容 |
|---|---|
| `%APPDATA%\com.qodercn.app.stable\` | 用户数据根：`main.sqlite`（主库）、`chat-session-turn-payload-buffer.sqlite`（对话 turn 缓冲）、`auth.v1.dat` + `auth.machine-id`、`DIPS`、`Partitions\qoder-browser\`（agent 浏览器分区）、`app-plugin-data\<pluginId>\`（插件存储根） |
| `~/.qoder-cn\` | 配置与工程数据：`settings.json`（`enabledPlugins` + **`providers` 第三方模型配置**）、`plugins\{installed_plugins_v2.json, cache, data}`、`projects\`、`tasks\<sessionId>\`、`logs\{sessions,runs}\`、`.models\<accountId>\`、`file-history\`、`memory\`、`entry\qodercn.cmd`（CLI 入口）、`mcp-router.json`（**回环 HTTP + apiKey，端口每次启动变化**）、`.qoder-app-status.json`（main 写的登录态/昵称/头像/版本快照） |
| `resources\extensions\` | 官方随包插件目录：`catalog.v1.json`（含每文件 sha256）+ `qoder.canvas / computer-control / desktop-pet-skill / find-extensions / knowledge.center / office / security / sites` |

### 2.3 官方 App Plugin 体系（**转换的核心承载面**）

**Manifest 允许字段（宿主强校验）**：`contributes` 只接受 `views | filePreviewers | sidebarNavItems | configuration | qoderAgentSdk | nativeModules`；`main` 必须在 `dist/node/` 下；`activationEvents` 必须包含 `onView:<viewId>`；`sidebarNavItems[].slot` 只允许 `workbench.sidebar.secondary`，且其 `viewId` 必须指向 `location === "workbench"` 的视图。视图 `location` 枚举：`workbench` / `file.preview` / `settings`。

**权限清单（白名单制）**：
`auth.readState`、`auth.readUserToken`、`auth.reportUserTokenRejected`、`chat.createSession`、`chat.createDetachedSession`、`chat.continueSession`、`chat.interruptTurn`、`chat.observeTurn`、`chat.readSessionResult`、`chat.revealSession`、`chat.sendToSourceSession`、`chat.attachAnnotation`、`workspace.read`、`workspace.readProjects`、`workspace.readSessionLocation`、`files.stageLocal`、`files.readSessionResource`、`files.writeSessionResource`、`node.callService`、`mcp.registerInProcess`、`views.registerFilePreviewer`、`configuration.write`、`telemetry.write`。

**Node 侧运行时（`activate(ctx)`）**：
```js
ctx = {
  plugin: { id, name, version }, extensionPath, storagePath, product: { id },
  diagnostics: { emit() },
  subscriptions: [],                       // 把 dispose 推进来即可
  api: {
    telemetry, auth{getState, subscribeUserToken, reportUserTokenRejected},
    chat{createSession, createDetachedSession, continueSession, interruptTurn, observeTurn},
    mcp{registerInProcessServer}, node{registerService},
    views{registerFilePreviewer},
    workspace{getSessionLocation, list, listProjects, getConfiguration, onDidChangeConfiguration}
  }
}
```
- `node.registerService({name, methods, streams})`：向视图暴露 RPC，支持 **异步生成器流式**（`openServiceStream`/`readServiceStream`）；每个方法名/服务名受正则约束，最多 64 个。
- 宿主侧每次调用带 **15s 超时**、按 `generation` 判活、崩溃/卸载自动回滚订阅与 MCP 注册；插件跑在独立 utility process（`pluginHost.js`）里，`process.exit` 被劫持为 `APP_PLUGIN_PROCESS_EXIT` 事件。
- `chat.observeTurn` 提供 turn 状态订阅（`sessionId/revision/active/turnId/terminalOutcome`），适合做"异常中断自动续接"这类触发。

**加载与安装三条通道**：
1. **随包**：`resources\extensions\catalog.v1.json`，逐文件 sha256 校验；stable 频道禁 `debug.*` 权限。
2. **开发目录**：环境变量 `QODER_APP_PLUGIN_DEV_DIRS`（外加约定目录），打包版本下需 `QODER_APP_PLUGIN_ALLOW_UNVERIFIED` 才加载未验证源码 → **这就是插件的本地开发回路**。
3. **本地/市场安装**：`~/.qoder-cn/plugins/installed_plugins_v2.json` 注册 + `~/.qoder-cn/settings.json` 的 `enabledPlugins` 启用（官方 UI 文案明确教用户这样注册本地插件）。

**已知策略限制（转换必须先实测的两点）**：
- 宿主会按 `catalogKind`（packaged / installed / development）过滤 `auth.readUserToken` 权限：非随包插件请求该权限**可能被拒绝**。→ 账号 token 类功能需按"降级路径"设计（先只读状态 + 文件级备份）。
- 完整性校验只对随包目录强校验；安装/开发通道不做 sha256 白名单，但也因此**没有官方信任背书**。

### 2.4 其它集成面

- **会话数据模型**：`chat_session_messages(message_id, turn_id, sequence, payload_json, status, feedback, source, created_at)`（`remoteControlProcess.js` 内的 SQL 实证），会话与 CLI 共用（`cliSessionReady`、`localOnly`、`cwd`、`directory` 字段）。→ 只读统计/导出与 WorkDaddy 的 `session-db.js` 思路完全同构。
- **本地回环服务**：`mcp-router.json`（`baseUrl: http://127.0.0.1:<随机端口>` + `apiKey`，pid 归属主进程）。说明应用本身已接受"回环 HTTP + API Key"的集成范式。
- **CLI / entry**：`~/.qoder-cn/entry/qodercn.cmd`、`qoder-cn.cmd`、`qodercn-dispatcher.ps1` —— 增强层可作为 CLI 插件或独立入口共存。
- **CDP 可行性**：应用对 `CDP_PORT` 环境变量的适配**仅在 Linux 平台生效**；Windows 上需依赖 Chromium 命令行开关 `--remote-debugging-port=<port>`，因单实例锁必须**首启即带参**（= 需要退出并重启客户端；端口建议避开 9222/9223 以免与 WorkDaddy 冲突）。

---

## 3. QoderDaddy 转换方案

### 3.1 设计原则

1. **插件优先**：能用官方 App Plugin API 表达的，一律走插件（无注入、无重启、随官方升级存活）。
2. **注入兜底**：只有"改造官方界面本身"的需求才启用 CDP 增强包，且必须可独立开关、可一键卸载。
3. **零凭证外流**：账号/凭证只在本机文件层读写；插件 Node 侧不打印、不外传；导出必须加密。
4. **窄适配层**：所有与官方 DOM/DB/配置格式耦合的逻辑集中到 `qodercn-compat` 单模块，版本漂移只改这一处（对应 WorkDaddy 的 `workbuddy-compat.js` 角色）。
5. **许可自觉**：直接复用 WorkDaddy 代码 = 衍生作品，必须 AGPL-3.0-or-later 开源；若要闭源/商业分发，只能按本文档的**设计**重写实现。

### 3.2 路线分工

| 能力 | 引擎 A：官方插件 | 引擎 B：CDP 注入 | 说明 |
|---|---|---|---|
| 侧边栏面板 / 工作台视图 / 设置页扩展 | ✅ `sidebarNavItems` + `views(location: workbench/settings)` | — | 官方正道 |
| 后台常驻逻辑（调度、备份、统计） | ✅ 插件 Node 进程（`onStartup` 常驻） | — | 替代 WorkDaddy daemon+watchdog |
| 视图 ↔ 后台 RPC / 流式 | ✅ `node.registerService` + 流 | — | 替代本地 HTTP API + token |
| 模型配置管理（providers） | ✅ 直接读写 `~/.qoder-cn/settings.json` + 视图 | — | 低风险高价值 |
| 用量/会话统计与导出 | ✅ 只读 `main.sqlite` + 随包 AES 导出信封 | — | 需 WAL 只读注意事项 |
| 自动化（定时/事件） | ✅ 引擎移植，op 改写为 `chat.*`/`workspace.*` | 部分 op 需 DOM | `chat.observeTurn` 天然适合事件触发 |
| 防休眠 | ✅ Node 侧系统调用 | — | 需用户显式开启 |
| 账号多开/备份 | 🟡 文件级备份可行；切换需重启 | — | `auth.readUserToken` 策略需实测 |
| 输入框旁按钮（暂存/快捷短语） | ❌ 无法插入官方 composer | ✅ | 只能注入 |
| 免打扰自动决策 / 异常续接点击 | ❌ | ✅ | 只能注入（观察 turn 状态 + 模拟点击） |
| 主题/毛玻璃/背景 | ❌（插件视图内可自定义） | ✅ | 全局主题只能注入 CSS |
| 宿主界面级适配补丁 | ❌ | ✅ | `qodercn-compat` + patch 数组 |

### 3.3 目标架构

```
┌──────────── Qoder CN（Electron 43.1.1）────────────┐
│  main(pluginHost 宿主)                             │
│   └── QoderDaddy 插件（utility process, Node）      │
│        ├─ backend: 备份/统计/调度/模型/会话         │
│        ├─ node service RPC ←→ workbench view       │
│        └─ chat.observeTurn / workspace.* 订阅       │
│   └── [可选] QoderDaddy Injector（CDP, 9333）       │
│        └─ inject.js: 主题/输入框按钮/免打扰          │
└────────────────────────────────────────────────────┘
        ▲ 安装：installed_plugins_v2.json + enabledPlugins
        ▲ 开发：QODER_APP_PLUGIN_DEV_DIRS
        ▲ 注入增强：外部 launcher 带 --remote-debugging-port 重启
```

### 3.4 功能映射表（WorkDaddy 功能 → Qoder CN 落点）

| WorkDaddy 功能 | Qoder CN 落点 | 权限/机制 | 难度 |
|---|---|---|---|
| 多账号备份/导出导入 | 插件 Node：备份 `auth.v1.dat`/`.auth` + `.qoder-app-status.json` 快照；导出沿用 AES-256-GCM 信封 | 文件系统 + `auth.readState` | 中 |
| 点切账号 | **受控重启**（单实例锁）→ 队列化"切完即拉起"，或引导用户在插件面板确认 | 文件替换 + 应用重启 | 中高 |
| 免退出登录新账号 | 无对等官方能力 → 降级为"浏览器扫码 + 手工导入" | — | 高（可能不可行） |
| 积分/成长/签到 | **无对应概念** → 删除；替换为"本地用量总览" | — | — |
| Token/用量统计 | 只读 `main.sqlite`（session/turn）+ 按模型聚合 | SQLite 只读 | 中 |
| 模型管理（多同名模型等） | 直接治理 `settings.json.providers`（备份/复制/连通测试） | 文件 + 网络 | 低 |
| 会话列表/筛选/批量复制/删除 | 只读 SQLite + 视图表格；删除走官方 API 或文件层（谨慎） | SQLite / `chat.*` | 中 |
| 跨账号会话迁移 | 文件集（`tasks/<sessionId>`、`logs/sessions`、file-history）+ DB 行复制 | 文件 + SQLite 写 | 高（P3，需回归） |
| 会话分支（fork） | 复制消息前缀建新会话 | `chat.createSession` + DB | 中 |
| 暂存提示词 / 快捷短语 | 注入增强包（composer 工具栏） | CDP | 中 |
| 免打扰（自动决策） / 异常续接 | 注入增强包 + `chat.observeTurn` 判定 | CDP + 插件 | 中高 |
| 主题/壁纸/毛玻璃 | 注入增强包（CSS patch 数组 + 变量重映射） | CDP | 中 |
| 自动化任务引擎 | 引擎移植；op 改写为 `chat.*`/`workspace.*`/`node.*` | 插件 | 中 |
| 防休眠 | Node 系统调用（`powercfg`/`caffeinate` 等平台分支） | 插件 | 低 |
| 自更新 | 下载到 `~/.qoder-cn/plugins/cache/<id>/<ver>` + 更新 `installed_plugins_v2.json` 后提示重启插件宿主 | 文件 | 中（或走官方市场，最优） |
| 脱敏诊断 | 复用 redaction 思路，写入插件 `diagnostics` | 插件 | 低 |

### 3.5 关键设计细节

**(1) 插件清单骨架**（对齐 `qoder.knowledge.center` 的实际格式）

```json
{
  "id": "qoderdaddy.enhance",
  "name": "QoderDaddy",
  "version": "0.1.0",
  "engines": { "qoder": ">=0.0.1" },
  "main": "dist/node/main.cjs",
  "activationEvents": ["onStartup", "onView:qoderdaddy-panel"],
  "permissions": [
    "auth.readState", "node.callService", "configuration.write",
    "workspace.read", "workspace.readProjects", "files.readSessionResource",
    "chat.createSession", "chat.observeTurn"
  ],
  "contributes": {
    "views": [
      {
        "id": "qoderdaddy-panel",
        "title": { "default": "QoderDaddy", "translations": { "zh-CN": "QoderDaddy" } },
        "location": "workbench",
        "hostHeader": "hidden",
        "entry": "dist/browser/view.cjs"
      }
    ],
    "sidebarNavItems": [
      {
        "id": "qoderdaddy-sidebar",
        "title": { "default": "QoderDaddy", "translations": { "zh-CN": "QoderDaddy" } },
        "icon": "assets/qoderdaddy.svg",
        "viewId": "qoderdaddy-panel",
        "slot": "workbench.sidebar.secondary"
      }
    ]
  }
}
```
> 注意：`contributes.configuration` 键虽在允许列表内，但**格式未验证**；P0 应从一个随包插件（`qoder.sites`/`qoder.knowledge.center`）对齐真实用法后再用。

**(2) 插件进程骨架（后台服务 = 原 daemon 的替代物）**

```js
// dist/node/main.cjs
function activate(ctx) {
  ctx.subscriptions.push(
    ctx.api.node.registerService({
      name: "qoderdaddy.backend",
      methods: {
        status:      async () => ({ version: "0.1.0", storage: ctx.storagePath }),
        providers:   async () => /* 读 ~/.qoder-cn/settings.json 的 providers，脱敏返回 */ null,
        usage:       async ({ days }) => /* 只读 main.sqlite 聚合 */ null,
        backupNow:   async () => /* 原子备份 auth 文件到 ctx.storagePath */ null,
        exportVault: async ({ passphrase }) => /* AES-256-GCM 信封 */ null
      },
      streams: {
        automationRun: async function* (input) { /* 长任务流式进度 */ }
      }
    })
  );
  ctx.api.chat.observeTurn({ /* 需要时订阅 turn 状态，做异常续接判定 */ }, () => {});
}
module.exports = { activate, deactivate: () => {} };
```
> **视图契约（已确证，逆向自随包插件 `qoder.canvas` / `qoder.sites` / `qoder.knowledge.center` 的 `dist/browser/view.cjs`）**：
>
> ```js
> // dist/browser/view.cjs —— 零依赖手写 DOM 或自带 React 均可
> globalThis.qoderPluginView.register({
>   async mount(container, context) {
>     // container: 宿主挂载点；context.api.* 命名空间与清单权限一一对应
>     const r = await context.api.node.callService("qoderdaddy.backend", "status", {});
>     //    → { ok: true, data } | { ok: false, error }
>     const s = context.api.node.callServiceStream("qoderdaddy.backend", "taskRun", input, { timeoutMs: 60000 });
>     context.api.chat.sendToSourceSession({ /* ... */ });
>     return { dispose() { /* 断开观察器、移除 DOM */ } };
>   }
> });
> ```
>
> `mount` 返回值需含 `dispose`；主题跟随 `document.documentElement[data-theme]`；面板样式建议 `color-mix` + `currentColor` 保证亮/暗自适应（宿主 CSS 变量名是混淆的 `--q******`，不要直接依赖）。

**(3) 为什么不再需要 daemon/watchdog/launcher/token**
pluginHost 已提供：进程隔离与崩溃事件、`generation` 生命周期与自动回滚、15s RPC 超时、按插件隔离的 `storagePath`、订阅清理。WorkDaddy 的 `watchdog`（端口锁单实例 + 退避重启）、`ui-port` 阶梯、`.api-token` 共享密钥、`windows-process-boundary` 的进程身份校验，**在插件路径上全部不需要**——这是本方案最大的工程节省。
仅引擎 B（注入）仍需要一个小 launcher：它的唯一职责是"解析当前 `.qoder-versions\<ver>\Qoder CN.exe` → 带 `--remote-debugging-port=9333` 重启 → 等端口就绪 → 注入"。

**(4) 凭证与账号层（最敏感）**
- 只读优先：`auth.getState` 拿登录态；`auth.readUserToken` 走**降级路径**（P0 实测是否被渠道策略拒绝）。
- 备份：复制 `%APPDATA%\com.qodercn.app.stable\auth.v1.dat`(+`auth.machine-id`) 与 `~/.qoder-cn/.qoder-app-status.json` 到 `<storagePath>/accounts/<accountId>/`，采用 WorkDaddy 的"tmp + rename + 0600"原子写。
- 切换：单实例锁 + 凭证文件不可热替换 ⇒ 设计为「**备份/导出随时可用，切换=用户确认后的受控重启**」，绝不静默重启客户端（会打断用户正在跑的任务）。
- 令牌缓存：`{token, apiKey}` 类凭据禁止进入日志/诊断；导出必须 AES-256-GCM + scrypt（可整包复用 `secure-transfer.js` 的信封设计）。

**(5) 会话/统计层**
- 只读打开 `main.sqlite`（`node:sqlite` `readOnly`；注意 WAL 需要能读到 `-wal`/`-shm`，避免在宿主写入高峰做长事务），沿用 `session-db.js` 的适配器模式。
- 表结构：`chat_session_messages(message_id, turn_id, sequence, payload_json, status, feedback, source, created_at)`；`payload_json` 中解析模型与用量字段（字段名待 P1 用真实数据确认）。
- 导出/迁移沿用"文件集快照 + 指纹缓存 + 加密信封"的三件套（`session-sync.js` + `session-transfer.js` 的设计）。

**(6) UI 设计契约（直接继承 WorkDaddy 的 UI 硬约束）**
面板 460–720px、紧凑信息密度、复用宿主 CSS 变量（Qoder CN 用 `--q...` 形如 `--qeee3f3` 的混淆变量，**需要一层 `--qd-*` 语义别名映射**）、亮/暗双主题、稳定尺寸无跳动、弹层遮罩阻断穿透、图标按钮带 tooltip、长中文自然换行、键盘可达。

**(7) 注入增强包（引擎 B）的最小可行集**
- 只注入三类补丁：`composer 工具栏按钮`、`全局主题 CSS`、`决策弹窗自动处理`。
- 复用 WorkDaddy 的流水线骨架（拼接/占位符/读回校验/重试/幂等清理），但**选择器全部重写**：Qoder CN 是 React 19 + Tailwind 风（`#root`、混淆类名）——P2 需先做一次"选择器发现"（DOM 快照 + 类名聚类），产出 `qodercn-compat.js` 与 patch 数组。
- 端口用 9333（避开 WorkDaddy 的 9222/9223）；注入前做宿主归属校验（进程路径含 `.qoder-versions` 且产品为 `qoder-cn`）。

### 3.6 分阶段路线图

| 阶段 | 目标 | 验收标准 | 是否重启客户端 |
|---|---|---|---|
| **P0 骨架验证** | 插件可被加载、面板可见、RPC 通 | `QODER_APP_PLUGIN_DEV_DIRS` 指向插件源码 → 侧边栏出现 QoderDaddy → 面板调用 `status` 返回版本与存储路径；交付物 `QD\qoderdaddy\` | 是（一次） |
| **P1 数据能力** | 模型管理 + 用量/会话只读统计 | 面板列出 providers（脱敏）、列出近 N 天会话与用量；AES 导出可用 | 否 |
| **P2 注入增强包** | 主题 + 输入框按钮 + 免打扰 | 注入成功且幂等；宿主重载后自动恢复；亮/暗双主题无跳动 | 是（启用时） |
| **P3 账号与会话治理** | 账号备份/导出/受控切换；会话迁移/分支 | 切换有二次确认与进度反馈；迁移有 dry-run 与回滚 | 切换时 |
| **P4 自动化与分发** | 自动化引擎 + 自更新/市场发布 | 定时与 turn 事件触发可跑通；更新可回滚 | 否 |

> 每阶段沿用 WorkDaddy 的验证纪律：`node --check` + 单测（引擎/信封/适配层）+ 真实客户端实操（含亮暗主题与窄窗）。
>
> **P0 骨架已生成**：`QD\qoderdaddy\`（`.qoder-app-plugin/plugin.json` + `dist/node/main.cjs` + `dist/browser/view.cjs` + 图标 + README），三件套已通过 `node --check` 与 JSON 解析；加载验证步骤（含重启客户端的风险提示）见其 README。当前能力：状态、登录态、providers 脱敏列表、本地状态快照备份。

### 3.7 风险与合规

| 风险 | 说明 | 处置 |
|---|---|---|
| **AGPL 传染** | 直接拷贝 WorkDaddy 代码 → 衍生作品须 AGPL-3.0-or-later 开源 | 复用代码则整包 AGPL；闭源则按本文档设计重写（常量/文案/选择器不得照搬） |
| **官方权限策略** | 第三方插件 `auth.readUserToken` 可能被拒；stable 禁 `debug.*` | P0 实测；设计降级路径（只读状态 + 文件级备份） |
| **版本漂移** | 版本化安装目录 + 官方升级改 DOM/DB/清单校验 | 所有路径运行时解析；耦合集中到 `qodercn-compat`；DB 只读 + 版本探测 |
| **重启代价** | 单实例锁 ⇒ 注入增强与账号切换都要重启客户端 | 显式用户确认 + 队列化 + 恢复现场（记录会话/工作区） |
| **稳定性** | 宿主是 React 19，宽 MutationObserver 有崩溃史（WorkDaddy 有前车之鉴） | 只用窄观察 + 事件委托 + rAF 节流；注入失败必须可退化为"无增强" |
| **合规** | 不修改 `app.asar`、不绕过认证、不迁移他人凭证 | 只服务本机已登录用户；导出加密；提供一键卸载与数据清除 |

---

## 附录 A：证据索引（本次勘查定位）

- WorkDaddy：`daemon.js:384-385`(版本)、`:3718-3856`(注入)、`:5029-5071`(API 鉴权)、`:9613-9703`(切换)、`:1796-1930`(CDP 发现)；`lib.js:1297-1575`(备份/切换)、`cdp-targets.js:41-122`、`workbuddy-compat.js:312-340`(fiber DFS)、`inject.js:775-803`(幂等清理)、`:4623-4675`(adapter shim)、`theme-patches.js:1-9`、`automation.js:94`、`secure-transfer.js:67-108`、`session-db.js:390-472`、`profiles.js:44-93`、`AGENTS.md`(工程约束)。
- Qoder CN（随包资源）：`<安装目录>\.qoder-versions\<版本>\resources\{product.json, build-manifest.json, extensions\catalog.v1.json}`；随包插件 `extensions\qoder.knowledge.center\.qoder-app-plugin\plugin.json`（清单字段约束）与 `extensions\qoder.*\dist\browser\view.cjs`（视图契约：`qoderPluginView.register` + `api.node.callService/callServiceStream` + `api.chat.sendToSourceSession`）。插件宿主能力（RPC 超时、权限按渠道过滤、manifest 强校验）由随包插件接口与运行行为对齐得出。
- 本机数据：`%APPDATA%\com.qodercn.app.stable\`（`main.sqlite`、`chat-session-turn-payload-buffer.sqlite`、`app-plugin-data\`）、`~/.qoder-cn\{settings.json, plugins\installed_plugins_v2.json, tasks\, .qoder-app-status.json, mcp-router.json}`。

## 附录 B：待实测清单（需用户确认后执行，勿在会话中自动跑）

1. **插件开发回路**：以 `QODER_APP_PLUGIN_DEV_DIRS=<插件目录>` 启动 Qoder CN（打包版可能还需 `QODER_APP_PLUGIN_ALLOW_UNVERIFIED=1`），确认侧边栏出现插件入口。
2. **`auth.readUserToken` 策略**：对 dev/installed 插件的该权限是否放行（P0 关键结论）。
3. **Windows CDP**：完全退出客户端后 `& "<安装目录>\.qoder-versions\<当前版本>\Qoder CN.exe" --remote-debugging-port=9333`，再 `curl http://127.0.0.1:9333/json/list` 验证；确认是否与 WorkDaddy 的注入互不干扰。
4. **只读统计口径**：`main.sqlite` 的 `payload_json` 是否含模型/token 用量字段（决定 P1 是否需要补 `-wal` 读取策略）。
5. **视图桥接 API**：✅ 已确证（`globalThis.qoderPluginView.register({mount})` + `context.api.node.callService/callServiceStream`，见 3.5(2)）；仍待实测的是 `context` 的全字段——挂载时打印一次 `Object.keys(context)` 即可闭环。
6. **开发目录解析层级**：`QODER_APP_PLUGIN_DEV_DIRS` 指向"插件父目录"还是"插件根目录"（含 `.qoder-app-plugin/plugin.json` 的那一层），需一次实测确定。

## 附录 C：术语对照

| WorkDaddy 概念 | QoderDaddy 对应物 |
|---|---|
| daemon + watchdog + ui-port + .api-token | 官方 pluginHost（进程/生命周期/RPC/存储） |
| inject.js 面板 | `contributes.views`（workbench） + `sidebarNavItems` |
| workbuddy-compat.js | `qodercn-compat`（DOM/DB/配置格式集中适配） |
| theme-patches.js | Qoder CN 补丁数组（P2 选择器发现后生成） |
| profiles.js / capabilities | 插件清单权限 + 运行时能力探测 |
