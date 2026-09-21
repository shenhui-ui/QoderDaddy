# QoderDaddy 插件（P0 骨架）

Qoder CN 官方 App Plugin 形态的增强层，对应设计文档：[WorkDaddy-QoderCN-转换方案.md](../WorkDaddy-QoderCN-转换方案.md)。
许可证与上游归属见仓库根目录 [LICENSE](../LICENSE) / [NOTICE](../NOTICE) / [PROVENANCE.md](../PROVENANCE.md)。

## 结构

```
qoderdaddy/
  .qoder-app-plugin/plugin.json      # 插件清单（id/权限/视图/侧边栏项）
  assets/qoderdaddy.svg              # 侧边栏图标
  dist/node/main.cjs                 # 插件 Node 侧：activate + node service（原 daemon 的替代物）
  dist/node/lib/paths.cjs            # 宿主路径常量（版本漂移只改这一处）
  dist/node/lib/security.cjs         # 安全原语：脱敏 / 原子写 / 凭据检查
  dist/browser/view.cjs              # 工作台视图：qoderPluginView.register + 调用 node service
  test/                              # 单元测试（node:test，零依赖；view.test.cjs 用最小 DOM 替身）
  package.json
```

## 当前能力

| 能力 | 说明 |
|---|---|
| 状态查询 | 插件版本、宿主平台与 Node 版本、能力位 |
| 登录态 | `auth.readState`。只回传白名单标量字段，**不回传宿主原始对象**；权限被拒时降级上报而非报错 |
| 模型提供方列表 | 读 `~/.qoder-cn/settings.json`。API Key 最多显露末 4 位（长度不足 16 整体遮蔽），`baseUrl` 剥离 userinfo/查询串/片段 |
| 本地状态快照 | 写入插件存储目录。**不复制配置文件原文** —— `settings.json` 含明文 API Key，故经白名单裁剪并做凭据扫描后才落盘。快照不可作为恢复源（`manifest.json` 中 `restorable: false`，恢复会丢失 API Key） |

> 关于"不含凭证"的准确含义：快照中**确实不含任何凭据字段**（由 `test/service.test.cjs` 逐字节断言保证）。
> 但请注意 `mode: 0o600` 在 Windows 上是空操作（Node 不设置 ACL），因此保护来自"凭据根本不写入"，
> 而不是来自文件权限。理由与已知局限见 [SECURITY.md](../SECURITY.md)。

## 本地验证（不接触客户端）

```bash
npm test        # 单元测试，含清单不变量与凭据不外泄的回归断言
npm run check   # 语法自检
```

## 加载验证（**需要重启 Qoder CN，会中断正在跑的任务，请自行确认时机**）

1. 完全退出 Qoder CN（含托盘/后台进程）。
2. 以开发目录方式启动（路径指向**本插件的父目录**；若宿主不接受该层，改为直接指向本插件根目录）：

   ```powershell
   # 指向本插件的【父目录】（即本仓库根目录）的绝对路径，按你自己的克隆位置替换
   $env:QODER_APP_PLUGIN_DEV_DIRS = "C:\path\to\this-repo"
   # 打包版加载未验证本地源码需要。这会关闭宿主对未签名源码的校验，仅用于本地开发。
   # 验证完成后请务必清除：Remove-Item Env:\QODER_APP_PLUGIN_ALLOW_UNVERIFIED
   $env:QODER_APP_PLUGIN_ALLOW_UNVERIFIED = "1"
   & "<Qoder CN 安装目录>\.qoder-versions\<当前版本>\Qoder CN.exe"
   ```

3. 预期：侧边栏二级导航出现 **QoderDaddy** 入口 → 打开面板 → "运行状态"卡片显示插件版本与登录态；"模型提供方"卡片列出 `settings.json` 中的 providers（Key 已脱敏）；"诊断信息"按钮可展开本机路径。
4. 若未出现入口，按顺序排查：dev 目录解析语义（父目录 vs 插件根）→ `ALLOW_UNVERIFIED` 是否生效 → 宿主日志中的 `APP_PLUGIN_MANIFEST_INVALID:*` / `APP_PLUGIN_SIDEBAR_VIEW_INVALID:*` 错误码。

## P0 必须回答的问题

1. 开发目录的解析层级（父目录扫描 vs 插件根直指）。
2. `auth.readState` 对 development/installed 渠道是否放行（`authState` 已按"可能被拒"设计降级路径；实测后确认走的是哪条分支）。
3. 视图 `context` 的完整字段 —— 展开面板上的**「诊断信息」**卡片可看到登录态字段名清单（`stateKeys`，只含键名不含值），据此核对宿主契约。
4. 宿主是否定义 `--q<...>` 形式的 CSS 变量及其亮/暗取值。当前视图**不依赖**任何未实测的宿主变量，只用语义关键字自适应主题；确认后可在 `view.cjs` 的别名层接入。

