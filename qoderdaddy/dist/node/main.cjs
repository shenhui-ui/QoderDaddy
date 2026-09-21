"use strict";

/**
 * QoderDaddy — 插件 Node 侧（原 WorkDaddy daemon 的替代物）。
 *
 * 职责：向工作台视图暴露 RPC。宿主 pluginHost 已提供进程隔离、生命周期与 15s RPC 超时，
 * 因此这里不再需要 daemon / watchdog / 端口阶梯 / 共享密钥那一整套基础设施。
 *
 * 设计约束（方案 §3.1「零凭证外流」）：
 *  - 传给视图的数据一律经过白名单挑选，不回传宿主或本地文件的原始对象；
 *  - 落盘的数据在写入前做凭据扫描，发现疑似凭据即放弃写入。
 */

const fs = require("node:fs");
const path = require("node:path");
const { randomBytes } = require("node:crypto");

const { QODER_HOME, SETTINGS_PATH, APP_STATUS_PATH } = require("./lib/paths.cjs");
const {
  isPlainObject,
  toSafeString,
  maskSecret,
  stripUrlCredentials,
  describeError,
  readJsonSafe,
  atomicWrite,
  findSensitiveKeys,
  sanitizeSettingsForBackup,
  PROVIDER_SAFE_FIELDS
} = require("./lib/security.cjs");

const SERVICE_NAME = "qoderdaddy.backend";
const BACKUP_DIR_NAME = "backup";
const MAX_BACKUPS = 10;

/**
 * 允许外露给视图的登录态字段白名单。
 * 刻意只接受标量：任何对象或数组都不外露，避免无意间把嵌套的凭据结构带出去。
 */
const AUTH_SAFE_FIELDS = [
  "loggedIn",
  "logged_in",
  "name",
  "nickname",
  "displayName",
  "uid",
  "userId",
  "accountId",
  "plan",
  "product",
  "version"
];

function emitDiagnostic(ctx, level, message) {
  // diagnostics 的确切签名尚未实测（方案附录 B）。失败不得影响主流程，因此整体包住。
  try {
    if (ctx && ctx.diagnostics && typeof ctx.diagnostics.emit === "function") {
      ctx.diagnostics.emit({ level, message: String(message).slice(0, 500) });
    }
  } catch (_) {
    /* 诊断通道不可用时静默降级 */
  }
}

/** 能力探测。宿主按渠道过滤权限，直接调用是不可靠的。 */
function detectCapabilities(ctx) {
  const api = (ctx && ctx.api) || {};
  return {
    auth: Boolean(api.auth && typeof api.auth.getState === "function"),
    nodeService: Boolean(api.node && typeof api.node.registerService === "function")
  };
}

function resolveLoggedIn(state) {
  if (!isPlainObject(state)) return false;
  return Boolean(state.loggedIn ?? state.logged_in ?? state.session);
}

/** 只挑白名单内的标量字段。 */
function pickAuthFields(state) {
  const picked = {};
  if (!isPlainObject(state)) return picked;
  for (const field of AUTH_SAFE_FIELDS) {
    const value = state[field];
    if (typeof value === "boolean" || typeof value === "number") {
      picked[field] = value;
    } else if (typeof value === "string") {
      picked[field] = value.slice(0, 120);
    }
  }
  return picked;
}

/**
 * 按时间戳保留最近 N 份备份，其余删除。
 *
 * 目录名形如 `<ISO 时间戳>-<pid36>-<随机>`,时间戳为定宽，故**毫秒不同**时字典序即时间序。
 * 同一毫秒内创建的多个目录，其字典序由末尾的随机段决定、不代表先后——这种并列本身
 * 无法区分新旧，因此不为它设计额外规则，只保证不越界删除。
 */
function pruneBackups(backupRoot, limit) {
  const keep = Number.isInteger(limit) && limit >= 0 ? limit : MAX_BACKUPS;
  let entries;
  try {
    entries = fs.readdirSync(backupRoot, { withFileTypes: true });
  } catch (_) {
    return 0;
  }
  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
    .reverse();
  let removed = 0;
  for (const name of directories.slice(keep)) {
    // 仅删除 backup 根目录下的直接子目录，不做递归，避免误伤
    try {
      fs.rmSync(path.join(backupRoot, name), { recursive: true, force: true });
      removed += 1;
    } catch (_) {
      /* 单个目录删除失败不影响其余 */
    }
  }
  return removed;
}

/**
 * 构造服务方法。
 *
 * @param ctx 宿主注入的插件上下文。
 * @param overrides 可选。仅供测试注入替身路径 —— 刻意不用环境变量做路径覆盖，
 *                  否则任何能设置宿主进程环境变量的本地进程都能让插件去读任意文件。
 */
function createServiceMethods(ctx, overrides) {
  const capabilities = detectCapabilities(ctx);
  const settingsPath = overrides && overrides.settingsPath ? overrides.settingsPath : SETTINGS_PATH;
  const appStatusPath = overrides && overrides.appStatusPath ? overrides.appStatusPath : APP_STATUS_PATH;
  const pruneLimit =
    overrides && Number.isInteger(overrides.maxBackups) && overrides.maxBackups >= 0
      ? overrides.maxBackups
      : MAX_BACKUPS;

  return {
    status: async () => ({
      pluginId: ctx && ctx.plugin ? ctx.plugin.id : "",
      pluginVersion: ctx && ctx.plugin ? ctx.plugin.version : "",
      storagePath: toSafeString(ctx && ctx.storagePath, 500),
      // settingsPath 属"含本机用户名的绝对路径"，仅供诊断面板按需展示
      settingsPath,
      platform: process.platform,
      node: process.versions.node,
      qoderHome: QODER_HOME,
      capabilities
    }),

    /**
     * 登录态。不返回宿主原始对象 —— 只返回白名单字段与键名清单。
     * stateKeys 足以探明宿主契约（方案附录 B 第 5 项），且不泄漏任何值。
     */
    authState: async () => {
      if (!capabilities.auth) {
        return { available: false, reason: "permission-denied", loggedIn: false, fields: {}, stateKeys: [] };
      }
      try {
        const state = await ctx.api.auth.getState();
        return {
          available: true,
          loggedIn: resolveLoggedIn(state),
          fields: pickAuthFields(state),
          stateKeys: isPlainObject(state) ? Object.keys(state).slice(0, 50) : []
        };
      } catch (error) {
        return {
          available: false,
          reason: "call-failed",
          error: describeError(error),
          loggedIn: false,
          fields: {},
          stateKeys: []
        };
      }
    },

    /**
     * providers 列表。返回 state 字段以区分不同情况，避免把"配置损坏"显示成"尚未配置"，
     * 也避免反向错报——**`providers` 键整体缺失是合法状态**（新装客户端尚未配置第三方模型），
     * 只有"键存在但类型非法"才是 shape-invalid。
     * state: ok | missing | parse-error | io-error | shape-invalid
     */
    providers: async () => {
      const read = readJsonSafe(settingsPath);
      if (!read.ok) {
        return {
          settingsPath,
          state: read.reason,
          error: read.error ?? null,
          count: 0,
          skipped: 0,
          list: []
        };
      }
      if (!isPlainObject(read.data)) {
        return {
          settingsPath,
          state: "shape-invalid",
          error: `顶层结构不是对象（实际为 ${read.data === null ? "null" : typeof read.data}）`,
          count: 0,
          skipped: 0,
          list: []
        };
      }

      const providers = read.data.providers;
      if (providers === undefined) {
        // 键缺失 = 尚未配置任何 provider，属正常空态，不是结构错误
        return { settingsPath, state: "ok", error: null, count: 0, skipped: 0, list: [] };
      }
      if (!isPlainObject(providers)) {
        const actual = Array.isArray(providers) ? "数组" : typeof providers;
        return {
          settingsPath,
          state: "shape-invalid",
          error: `providers 字段存在但不是对象（实际为 ${actual}）`,
          count: 0,
          skipped: 0,
          list: []
        };
      }

      const list = [];
      let skipped = 0;
      for (const [id, provider] of Object.entries(providers)) {
        if (!isPlainObject(provider)) {
          skipped += 1;
          continue;
        }
        list.push({
          id: toSafeString(id, 200),
          baseUrl: stripUrlCredentials(provider.baseUrl),
          type: toSafeString(provider.type),
          model: toSafeString(provider.model),
          apiKey: maskSecret(provider.apiKey),
          models: Array.isArray(provider.models)
            ? provider.models
                .slice(0, 50)
                .map((model) => (isPlainObject(model) ? toSafeString(model.model) : ""))
                .filter(Boolean)
            : []
        });
      }

      return { settingsPath, state: "ok", error: null, count: list.length, skipped, list };
    },

    /**
     * 本地状态快照。
     *
     * 与 WorkDaddy 的备份语义不同：**不复制配置文件原文**。
     * settings.json 含明文 API Key，原样复制等于把凭据写到 mode 在 Windows 上无效的目录里。
     * 这里改为写入经白名单裁剪的快照，并在写入前扫描疑似凭据字段，命中即放弃该文件。
     *
     * 可用内容为空时**不创建快照目录**：只含 manifest 的空快照会占掉一个保留位，
     * 连续失败十次后就会把真实备份逐个淘汰出保留窗口。
     */
    backupLocalState: async () => {
      const storagePath = toSafeString(ctx && ctx.storagePath, 500);
      if (!storagePath) {
        return { ok: false, reason: "storage-unavailable", targetDir: null, saved: [], skipped: [], pruned: 0 };
      }

      const skipped = [];
      /** 待写入项：先全部收集（含凭据扫描），确认有内容后再落盘。 */
      const pending = [];

      // 1) settings.json —— 白名单裁剪后写入
      const settingsRead = readJsonSafe(settingsPath);
      if (!settingsRead.ok) {
        skipped.push({ file: "settings.json", reason: settingsRead.reason });
      } else {
        const sanitized = sanitizeSettingsForBackup(settingsRead.data);
        if (!sanitized.ok) {
          skipped.push({ file: "settings.json", reason: sanitized.reason });
        } else {
          const leaks = findSensitiveKeys(sanitized.data);
          if (leaks.length > 0) {
            // 白名单理论上不可能留下凭据字段。走到这里说明白名单有漏，宁可放弃备份。
            skipped.push({ file: "settings.json", reason: "sensitive-field-remains", fields: leaks });
          } else {
            pending.push({ name: "settings.sanitized.json", data: sanitized.data });
          }
        }
      }

      // 2) .qoder-app-status.json —— 同样先做凭据扫描（当前结构不含凭据，作为防御）
      const statusRead = readJsonSafe(appStatusPath);
      if (!statusRead.ok) {
        skipped.push({ file: ".qoder-app-status.json", reason: statusRead.reason });
      } else {
        const leaks = findSensitiveKeys(statusRead.data);
        if (leaks.length > 0) {
          skipped.push({ file: ".qoder-app-status.json", reason: "sensitive-field-remains", fields: leaks });
        } else {
          pending.push({ name: "app-status.json", data: statusRead.data });
        }
      }

      if (pending.length === 0) {
        return { ok: false, reason: "nothing-to-backup", targetDir: null, saved: [], skipped, pruned: 0 };
      }

      // 目录名需唯一：仅用毫秒时间戳时，同毫秒内的两次调用会落到同一目录并互相覆盖。
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const unique = `${process.pid.toString(36)}-${randomBytes(3).toString("hex")}`;
      const targetDir = path.join(storagePath, BACKUP_DIR_NAME, `${stamp}-${unique}`);
      const saved = [];

      fs.mkdirSync(targetDir, { recursive: true, mode: 0o700 });
      for (const entry of pending) {
        atomicWrite(path.join(targetDir, entry.name), `${JSON.stringify(entry.data, null, 2)}\n`);
        saved.push(entry.name);
      }

      const manifest = {
        schema: 1,
        createdAt: new Date().toISOString(),
        pluginVersion: toSafeString(ctx && ctx.plugin ? ctx.plugin.version : "", 40),
        containsCredentials: false,
        // 快照是白名单裁剪的产物（凭据字段、未知字段、URL 查询串均已丢弃），
        // 因此**不能**当作 settings.json 的恢复源；恢复会丢失 API Key。
        restorable: false,
        providerFieldsKept: PROVIDER_SAFE_FIELDS,
        saved,
        skipped
      };
      atomicWrite(path.join(targetDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

      const pruned = pruneBackups(path.join(storagePath, BACKUP_DIR_NAME), pruneLimit);

      return { ok: true, targetDir, saved, skipped, pruned };
    }
  };
}

function activate(ctx) {
  try {
    if (!ctx || typeof ctx !== "object") {
      return;
    }
    const capabilities = detectCapabilities(ctx);
    if (!capabilities.nodeService) {
      emitDiagnostic(ctx, "error", "node.registerService 不可用；QoderDaddy 以降级模式启动（面板将无法获取数据）");
      return;
    }

    const disposeService = ctx.api.node.registerService({
      name: SERVICE_NAME,
      methods: createServiceMethods(ctx),
      streams: {}
    });

    if (typeof disposeService === "function") {
      if (Array.isArray(ctx.subscriptions)) {
        ctx.subscriptions.push(disposeService);
      } else {
        emitDiagnostic(ctx, "warn", "ctx.subscriptions 不是数组，服务 dispose 未登记，插件卸载时可能泄漏");
      }
    } else {
      emitDiagnostic(ctx, "warn", "registerService 未返回 dispose 函数，服务生命周期不受控");
    }
  } catch (error) {
    // activate 向宿主抛裸异常会导致插件加载失败并只留下难以归因的错误码
    emitDiagnostic(ctx, "error", `activate 失败：${describeError(error)}`);
  }
}

function deactivate() {
  // 清理交由 ctx.subscriptions 中登记的 dispose 完成，此处无需额外动作。
}

// pruneBackups 单独导出仅为让保留策略可被确定性测试（构造受控目录名比依赖真实时钟可靠）
module.exports = { activate, deactivate, createServiceMethods, pruneBackups, SERVICE_NAME };
