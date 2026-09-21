# 溯源记录（PROVENANCE）

本文件记录本项目每一处代码的来源，用于履行 AGPL-3.0 的归属义务，并使"哪些是移植、哪些是独立实现"成为可审计的事实，而不是判断。

**维护约定（强制）**：新增或修改代码时，若其实现思路来自 WorkDaddy 或任何第三方，必须在下表登记后方可合并。未登记的代码视为来源不明，不得进入发布分支。

---

## 1. 许可证结论

| 项 | 值 |
|---|---|
| 本项目许可证 | `AGPL-3.0-or-later`（全文见 `LICENSE`） |
| 认定依据 | 本项目建立在对 WorkDaddy 的设计分析之上，并移植/参照了其部分实现。依 AGPL-3.0 的传染性条款，衍生作品须以同一许可证发布 |
| SPDX 标识 | `AGPL-3.0-or-later` |
| 上游项目 | WorkDaddy，Copyright (C) 2024-2026 WorkDaddy Contributors，AGPL-3.0-or-later，<https://github.com/babygoton/WorkDaddy> |
| 归属信息核对 | 上游 `LICENSE` 首部即为 `Copyright (C) 2024-2026 WorkDaddy Contributors`，与 `NOTICE` / `README.md` 的表述一致 |

> 若未来需要以非 AGPL 条款分发（例如闭源商业版本），必须先将下表所有"移植 / 参照重写"的条目替换为完全独立实现，并重新审定本文件。仅重命名、仅改文案不构成独立实现。

---

## 2. 来源类型定义

| 类型 | 含义 | AGPL 义务 |
|---|---|---|
| **移植** | 代码结构或实现直接来自上游 | 必须保留归属；本项目整体受 AGPL 约束 |
| **参照重写** | 借鉴上游的实现思路/防御设计，代码由本项目独立编写 | 同上（方案本身即上游分析的产物） |
| **独立实现** | 与上游无关，依宿主接口或通用实践编写 | 无额外义务 |
| **接口契约** | 来自 Qoder CN 官方 App Plugin API 或随包插件，与 WorkDaddy 无关 | 无 |

> 判定从严：**只要实现思路能在上游找到对应物，就按"参照重写"登记**，不按"独立实现"。
> 登记不全比登记过度的代价高得多——前者是归属义务的漏洞，后者只是多写一行。

---

## 3. 当前代码溯源

### 3.1 `qoderdaddy/dist/node/lib/security.cjs`

| 符号 | 类型 | 上游参照位置 | 说明 |
|---|---|---|---|
| `maskSecret` | 参照重写 | `scripts/lib.js:256-264`（`maskApiKey`） | 同为"保留首尾、掩去中段"的展示脱敏。本项目改为仅保留末 4 位（上游保留 3+4 位），且长度不足 16 位时整体遮蔽；阈值与实现均重新编写 |
| `atomicWrite` | 移植 | `scripts/lib.js:309-315`（`writeModelsFile` 内的 `tmp + rename + chmod`）、`scripts/atomic-file-write.js` | `tmp + rename` 原子写模式。本项目补入 fsync、异常路径清理临时文件；临时名带随机段（上游 `defaultSuffix()` 同处置） |
| `renameWithRetry`、`RENAME_ATTEMPTS`、`RENAME_BACKOFF_MAX_MS`、`TRANSIENT_RENAME_CODES` | 参照重写 | `scripts/atomic-file-write.js:6`（`WINDOWS_TRANSIENT_CODES`）、`:18-53`（`replaceFileWithRetry`） | 沿用两点：① 把 Windows 上的瞬时 rename 失败归为可重试；② 留出可注入 `fs`/`sleep` 的测试缝。重试预算（6 次 / 约 0.8s）与退避曲线系本项目依宿主 RPC 超时预算独立确定 |
| `sleepSync` | 参照重写 | `scripts/atomic-file-write.js:8-12`（`defaultSleep`） | `SharedArrayBuffer` + `Atomics.wait` 的同步睡眠 |
| `sanitizeSettingsForBackup` | 参照重写 | `scripts/lib.js:267-280`（`sanitizeModel`） | 借鉴"脱敏后再外露"的防御设计。本项目把对象从"单个模型"扩大到整份 settings，并改为白名单裁剪 |
| `stripUrlCredentials` | 参照重写 | `scripts/lib.js:275`（`sanitizeModel` 内对 `url` 去 query/hash） | 同思路；本项目另补 userinfo（`user:pass@`）剥离 |
| `redactLikelySecret`、`describeError` | 参照重写 | `scripts/sentry-report.js:158-183` | 借鉴其"外露前先脱敏"的处置。**上游该实现存在 Basic 认证场景的脱敏遗漏，本项目已修正**：`basic`/`bearer` 两种载荷均整体遮蔽（见 §4 备注） |
| `readJsonSafe`、`isPlainObject`、`toSafeString`、`findSensitiveKeys` | 独立实现 | — | 上游无对应物；本项目为区分"缺失 / 解析失败 / IO 失败 / 结构非法"而编写 |

### 3.2 `qoderdaddy/dist/node/lib/paths.cjs`

| 符号 | 类型 | 上游参照位置 | 说明 |
|---|---|---|---|
| 路径与格式常量 | 独立实现 | — | 常量来自对 Qoder CN 本机数据布局的勘查（设计文档 §2.2），与 WorkDaddy 无关 |

### 3.3 `qoderdaddy/dist/node/main.cjs`

| 符号 | 类型 | 上游参照位置 | 说明 |
|---|---|---|---|
| `activate`、`deactivate`、`createServiceMethods`、服务方法、`pruneBackups` | 独立实现 | — | 依 Qoder CN `pluginHost` 的 `node.registerService` 契约编写。上游的 daemon / watchdog / 端口阶梯 / 共享密钥等基础设施在插件路径上不需要（设计文档 §3.5(3)），故无对应移植物 |

### 3.4 `qoderdaddy/dist/browser/view.cjs`

| 符号 | 类型 | 上游参照位置 | 说明 |
|---|---|---|---|
| `qoderPluginView.register`、`context.api.node.callService` 的用法 | 接口契约 | — | 契约来自 Qoder CN 随包插件，与 WorkDaddy 无关 |
| 渲染层整体（`el` 白名单赋值、`renderProviders`、主题同步） | 参照重写 | 设计文档 §1.5、§3.5(2)(6) 所转述的上游工程约束 | "窄 MutationObserver 观察 + 幂等清理 + 失败可退化为无增强"三条取向源自上游 `inject.js` 的工程约束（宽观察在上游有崩溃前车之鉴）。DOM 结构与样式为本项目独立编写 |

### 3.5 其余文件

| 文件 | 符号 | 类型 | 上游参照位置 | 说明 |
|---|---|---|---|---|
| `qoderdaddy/.qoder-app-plugin/plugin.json` | 插件清单 | 接口契约 | — | 字段约束来自 Qoder CN manifest 校验规则 |
| `qoderdaddy/assets/qoderdaddy.svg` | 图标 | 独立实现 | — | 纯手写矢量 |
| `qoderdaddy/test/*.test.cjs` | 单元测试 | 独立实现 | — | `node:test` 零依赖；断言口径来自 `SECURITY.md` 的硬约束与设计文档 §3.6 的验收标准 |
| `qoderdaddy/package.json`、`README.md`、仓库根文档 | 工程与文档 | 独立实现 | — | — |
| `WorkDaddy-QoderCN-转换方案.md` | 设计文档 | 参照重写 | 全文 | 本文件是对 WorkDaddy 源码（39,798 行脚本）的系统性分析产物，其中的架构判断、机制摘要、行号引用均源自上游代码。**因此本文件同样受 AGPL 约束** |

---

## 4. 后续计划的移植项

设计文档 §1.7 列出了「可直接复用」清单。以下模块尚未落地，落地时**必须**按类型登记：

| 计划模块 | 预期类型 | 上游参照位置 |
|---|---|---|
| AES-256-GCM 导出信封 | 移植 | `scripts/secure-transfer.js:67-108` |
| SQLite 只读适配 | 移植 | `scripts/session-db.js:390-472` |
| 脱敏遥测 | 参照重写 | `scripts/sentry-report.js:158-183`（**注意**：上游该实现在 Basic 认证场景存在脱敏遗漏；`redactLikelySecret` 已按修正后的口径实现，复用时不得回退） |
| 注入流水线骨架 | 移植 | `scripts/daemon.js:3718-3856` |
| 目标归属判定 | 参照重写 | `scripts/cdp-targets.js:41-122` |
| 自动化引擎 | 移植 | `scripts/automation.js` |
| 原子写规范实现 | 移植 | `scripts/atomic-file-write.js`（`renameWithRetry` 已先行参照落地，见 §3.1） |
| DOM/React 适配层 | 参照重写 | `scripts/workbuddy-compat.js` |

---

## 5. 不随本仓库分发的内容

| 内容 | 处置 |
|---|---|
| WorkDaddy 源码克隆（`_analysis/WorkDaddy/`） | 已列入 `.gitignore`，不随仓库分发。需要时请自行从上游 clone |
| 上游代码的逆向分析细节（宿主二进制偏移等） | 存放于 `.internal/`，已列入 `.gitignore`，不随仓库分发 |
| 内部代码审查报告（`CODE-REVIEW-*.md`） | 已列入 `.gitignore`。含对本项目与上游的可利用性分析，如需公开审计结论应另出一份移除利用细节的版本。**因此本仓库内的文档不得引用该文件的内容作为依据** |

---

## 6. 变更历史

| 日期 | 变更 |
|---|---|
| 2026-09-20 | 初版建立。依据当时代码审查的许可证结论补全 `LICENSE` 与溯源，并据此确定许可证为 `AGPL-3.0-or-later` |
| 2026-09-20 | 第二轮全量审计后的订正：① 修正一处符号名错误（原记为 `sanitizeProvidersForBackup`，实际为 `sanitizeSettingsForBackup`）；② 补齐此前漏登记的符号（`stripUrlCredentials`、`redactLikelySecret`、`describeError`、`findSensitiveKeys`、`toSafeString`、`sleepSync`、`renameWithRetry` 及视图渲染）；③ 视图渲染由"接口契约"改判为"参照重写"；④ 移除对未入库的 `CODE-REVIEW-*.md` 的引用（见 §5）；⑤ 补记上游版权行核对结论 |
