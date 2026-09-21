# QoderDaddy

面向 **Qoder CN 桌面端**的本地增强层，以 **Qoder CN 官方 App Plugin 形态**实现。

> 状态：**pre-release（P0 骨架）**。插件尚未在真实客户端上完成加载验证，当前能力仅覆盖状态查询、登录态读取与本地状态快照。功能路线见 [设计文档](WorkDaddy-QoderCN-转换方案.md)。

---

## 这是什么

QoderDaddy 把 [WorkDaddy](https://github.com/babygoton/WorkDaddy) 的能力与工程方法，转换为符合 Qoder CN 官方插件体系的原生插件。它跑在宿主的 pluginHost 提供的独立 Node 进程里，通过官方 RPC 向工作台视图提供数据。

**它是什么**

- 一个官方插件形态的增强层：跟随宿主升级存活，不需要 CDP 注入；除首次加载插件外不需要重启客户端
- 一个只服务本机已登录用户的数据视图：模型提供方、登录态、本地状态快照
- 一个把安全约束写进代码的项目：见下方「安全姿态」

**它不是什么**

- 不修改、不重签名、不重新打包 Qoder CN 官方安装包
- 不绕过任何认证机制，不读取或上传 Qoder CN 的私有服务器协议
- 不迁移他人凭证；不收集、不外传任何数据
- 与 Qoder 官方无隶属关系，未获其背书或授权

---

## 仓库结构

```
.
├── LICENSE                         AGPL-3.0 全文
├── NOTICE                          版权、上游归属与边界声明
├── PROVENANCE.md                   逐项代码溯源记录
├── SECURITY.md                     安全政策与漏洞报告方式
├── WorkDaddy-QoderCN-转换方案.md    设计文档（架构分析与分阶段路线）
├── qoderdaddy/                     插件本体
│   ├── .qoder-app-plugin/plugin.json   插件清单
│   ├── dist/node/main.cjs              插件 Node 侧（服务注册 + RPC 方法）
│   ├── dist/node/lib/security.cjs      安全原语（脱敏 / 原子写 / 凭据检查）
│   ├── dist/node/lib/paths.cjs         宿主路径常量（窄适配层）
│   ├── dist/browser/view.cjs           工作台视图
│   ├── assets/qoderdaddy.svg           侧边栏图标
│   ├── package.json                    插件元数据与检查脚本（`npm test` / `npm run check`）
│   ├── test/                           单元测试
│   │   ├── manifest.test.cjs           清单不变量（宿主校验规则的 CI 前置）
│   │   ├── security.test.cjs           脱敏 / 原子写 / 凭据扫描
│   │   ├── service.test.cjs            RPC 方法的返回契约与备份语义
│   │   └── view.test.cjs               视图渲染（最小 DOM 替身）
│   └── README.md                       插件开发与加载验证说明
└── .github/workflows/test.yml          CI：语法自检 + 单元测试
```

---

## 快速开始

需要 Node.js ≥ 20（用于跑测试与语法自检）。插件本身运行在 Qoder CN 宿主进程内。

```bash
cd qoderdaddy
npm test        # 单元测试
npm run check   # 语法自检
```

**加载到 Qoder CN**（需要重启客户端，会中断正在跑的任务，请自行确认时机）见 [`qoderdaddy/README.md`](qoderdaddy/README.md)。

---

## 安全姿态

这个项目会读写包含凭据的本机文件，因此把约束写进了实现而不是文档：

| 约束 | 实现方式 |
|---|---|
| **零凭证外流** | 传给视图的数据一律经白名单挑选。`authState` 只回传白名单标量字段与键名清单，**不回传宿主原始对象** |
| **凭据不落盘** | 本地状态快照**不复制配置文件原文**。`settings.json` 经白名单裁剪后写入，并在写盘前递归扫描疑似凭据键 —— 命中即放弃该文件，宁可备份失败也不写下去 |
| **最小暴露** | API Key 最多显露末 4 位，长度不足 16 时整体遮蔽；`baseUrl` 剥离 userinfo、查询串与片段后才回显 |
| **失败不伪装** | 配置文件的"缺失 / 解析失败 / 结构非法 / 确实为空"是四种可区分状态，不会把损坏报成空配置 |
| **持久化正确** | 原子写包含 fsync、异常路径清理临时文件，并对 Windows 的瞬时 rename 失败做退避重试 |

**已知局限**：`mode: 0o600` 与 `chmod` 只对 POSIX 生效。**Windows 上 Node 不设置 ACL，该参数是空操作**，因此备份目录的保护实际取决于父目录的 DACL。这是"凭据绝不写入备份"被设为硬约束、而非依赖文件权限的原因。详见 [SECURITY.md](SECURITY.md)。

---

## 许可证与上游关系

本项目是 **WorkDaddy 的衍生作品**，依 **AGPL-3.0-or-later** 发布。

- WorkDaddy — Copyright (C) 2024-2026 WorkDaddy Contributors，AGPL-3.0-or-later，<https://github.com/babygoton/WorkDaddy>
- 逐项溯源（哪些是移植、哪些是参照重写、哪些是独立实现）见 [PROVENANCE.md](PROVENANCE.md)
- 版权与边界声明见 [NOTICE](NOTICE)

Qoder CN 及其商标、官方资源归其权利人所有。
