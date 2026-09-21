"use strict";

/**
 * 安全原语：脱敏、结构化读取、原子写、以及写入前的凭据检查。
 *
 * 设计原则（对应设计文档 §3.1「零凭证外流」）：
 *  1. 任何要离开 Node 侧的数据，一律先过白名单，而不是先过黑名单。
 *     白名单的好处是"未来新增的凭据字段默认被丢弃"，黑名单做不到这一点。
 *  2. 任何要落盘的数据，写入前先做一次凭据字段扫描；发现疑似凭据就拒绝写入，
 *     而不是"先写下去再说"。宁可备份失败，也不把凭据落到无 ACL 保护的目录。
 */

const fs = require("node:fs");
const { randomBytes } = require("node:crypto");

/** 脱敏占位串。固定宽度，不携带原值长度信息（长度本身也是信息）。 */
const REDACTED = "••••••";

/** 低于此长度的密钥整体遮蔽：任何片段暴露都会显著缩小搜索空间。 */
const MIN_LENGTH_FOR_SUFFIX = 16;

/** 疑似凭据的键名模式。用于写入前的最后一道检查。 */
const SENSITIVE_KEY_PATTERN =
  /(api[_-]?key|access[_-]?key|secret|token|password|passwd|credential|private[_-]?key|authorization|cookie|session[_-]?id)/i;

/** providers 中允许进入备份的非敏感字段白名单。 */
const PROVIDER_SAFE_FIELDS = ["baseUrl", "type", "protocol", "authType", "model"];

/**
 * 判断是否为普通对象（排除 null 与数组）。
 * 之所以需要它：`Object.entries` 对字符串和数组都不报错，会静默产出伪记录。
 */
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** 安全的字符串化：非字符串/空值统一返回空串，并限制长度。 */
function toSafeString(value, maxLength) {
  if (value === null || value === undefined) return "";
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).slice(0, maxLength === undefined ? 200 : maxLength);
}

/**
 * 展示用密钥脱敏：最多显露末 4 位，长度不足则整体遮蔽。
 *
 * 注意与上游 WorkDaddy `maskApiKey`（scripts/lib.js:256-264）的区别：上游显露 3 + 4 位，
 * 本实现只显露末 4 位，且对短密钥整体遮蔽。原因：固定显露 8 个字符时，
 * 9 字符密钥的暴露比例高达 89%，视觉上却"像已脱敏"。
 */
function maskSecret(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  if (value.length < MIN_LENGTH_FOR_SUFFIX) return REDACTED;
  return REDACTED + value.slice(-4);
}

/**
 * 剥离 URL 中可能承载凭据的部分：userinfo（`https://user:pass@host`）、
 * 查询串（`?api-key=...`）与片段（`#token=...`）。
 *
 * providers 的 baseUrl 常把密钥放在查询参数里，直接回显等于明文泄漏。
 */
function stripUrlCredentials(value) {
  if (typeof value !== "string" || value.length === 0) return "";
  let result = value;
  const hashAt = result.indexOf("#");
  if (hashAt !== -1) result = result.slice(0, hashAt);
  const queryAt = result.indexOf("?");
  if (queryAt !== -1) result = result.slice(0, queryAt);
  // 去掉 URL 内嵌的 userinfo
  const match = /^([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^/@]*@)(.*)$/.exec(result);
  if (match) result = match[1] + match[3];
  return result.slice(0, 500);
}

/** 对文本做保守脱敏：遮蔽 bearer/basic 凭据与 `key=value` 形式的凭据字段。 */
function redactLikelySecret(text) {
  return String(text === null || text === undefined ? "" : text)
    .replace(/((?:proxy-)?authorization\s*[:=]\s*)(?:basic|bearer)\s+\S+/gi, "$1[redacted]")
    .replace(
      /(["']?(?:api[_-]?key|access[_-]?key|secret|token|password|passwd|credential|private[_-]?key|authorization|cookie)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi,
      "$1[redacted]"
    )
    .replace(/\b(?:sk|key|ghp|gho|xox[baprs])-[A-Za-z0-9_-]{8,}\b/g, "[redacted]");
}

/** 把异常折叠成可安全外露的单行描述（长度受限、疑似凭据已遮蔽）。 */
function describeError(error) {
  const message = error && error.message ? error.message : String(error);
  return redactLikelySecret(message).slice(0, 200);
}

/**
 * 结构化读取 JSON。
 *
 * 与"catch 后返回 null"的区别：调用方必须能区分 **缺失 / 解析失败 / IO 失败**。
 * 否则配置文件损坏会被上层的空态逻辑伪装成"尚未配置"，把排障引向错误方向。
 */
function readJsonSafe(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { ok: false, reason: "missing" };
    return { ok: false, reason: "io-error", error: describeError(error) };
  }
  try {
    return { ok: true, data: JSON.parse(raw) };
  } catch (error) {
    return { ok: false, reason: "parse-error", error: describeError(error) };
  }
}

function sleepSync(milliseconds) {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, milliseconds);
}

/**
 * rename 的退避重试参数。
 *
 * 参照上游 `scripts/atomic-file-write.js`（`replaceFileWithRetry` + `WINDOWS_TRANSIENT_CODES`）：
 * 它把"Windows 上 rename 的瞬时失败"归为可重试，并给出可注入的 fs/sleep 测试缝 —— 本项目沿用这两点。
 *
 * Windows 上目标文件被占用或正被安全软件扫描时，rename 会瞬时失败（EPERM/EACCES/EBUSY），
 * 这类失败不是逻辑错误，重试即可；其余错误直接放弃。
 *
 * 预算：6 次尝试，退避 25/50/100/200/400ms，合计约 0.8s。上限刻意远低于宿主 15s 的 RPC 超时
 * （此处是同步阻塞），又足以覆盖一次典型的安全软件扫描占用。
 */
const RENAME_ATTEMPTS = 6;
const RENAME_BACKOFF_MAX_MS = 400;
const TRANSIENT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

/**
 * rename 带退避重试。失败时清理来源临时文件后抛出原始错误。
 *
 * @param options 可选：`{ attempts, fs, sleep }`。仅测试注入替身用 —— 生产路径一律走默认值。
 */
function renameWithRetry(from, to, options) {
  const config = options || {};
  const fileSystem = config.fs || fs;
  const sleep = config.sleep || sleepSync;
  const attempts =
    Number.isInteger(config.attempts) && config.attempts > 0 ? config.attempts : RENAME_ATTEMPTS;

  let lastError;
  for (let index = 0; index < attempts; index += 1) {
    try {
      fileSystem.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (!TRANSIENT_RENAME_CODES.has(error && error.code)) break;
      // 最后一次尝试之后不再退避：那次睡眠换不来任何重试机会，只会白占插件线程
      if (index === attempts - 1) break;
      sleep(Math.min(RENAME_BACKOFF_MAX_MS, 25 * 2 ** index));
    }
  }
  try {
    fileSystem.unlinkSync(from);
  } catch (_) {
    /* 清理失败不覆盖原始错误 */
  }
  throw lastError;
}

/**
 * 原子写：同目录临时文件 + fsync + rename。
 *
 * 三处相对朴素实现的修正：
 *  1. rename 只保证目录项替换的原子性，**不保证数据落盘** —— 所以写入后必须 fsync，
 *     否则崩溃后可能留下"文件名正确、内容被截断"的文件。
 *  2. 异常路径必须清理临时文件。临时文件里可能含凭据，残留即泄漏。
 *  3. `mode` 只对 POSIX 生效；Windows 上 Node 不设置 ACL，此参数是空操作。
 *     因此**不得**依赖 mode 保护敏感内容 —— 敏感内容根本不应写到这里。
 */
function atomicWrite(file, data, options) {
  const mode = options && typeof options.mode === "number" ? options.mode : 0o600;
  // 临时名带 pid + 时间 + 随机段：随机段与上游 `defaultSuffix()` 的处置一致，
  // 用于排除"进程号被复用 + 同一毫秒"这种残留文件与新建文件同名的边角情形。
  const tmp = `${file}.tmp-${process.pid}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
  let fd;
  try {
    fd = fs.openSync(tmp, "wx", mode);
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
  } catch (error) {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch (_) {
        /* 忽略关闭失败 */
      }
    }
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* 忽略清理失败 */
    }
    throw error;
  }
  renameWithRetry(tmp, file);
  try {
    fs.chmodSync(file, mode);
  } catch (_) {
    /* Windows 上不支持，忽略 */
  }
}

/**
 * 递归查找疑似凭据键。返回命中的键路径列表（不含值）。
 * 用作写盘前的最后一道闸门。
 */
function findSensitiveKeys(value, prefix, found) {
  const pathPrefix = prefix === undefined ? "" : prefix;
  const hits = found === undefined ? [] : found;
  if (hits.length >= 20) return hits;
  if (Array.isArray(value)) {
    value.slice(0, 200).forEach((item, index) => findSensitiveKeys(item, `${pathPrefix}[${index}]`, hits));
    return hits;
  }
  if (!isPlainObject(value)) return hits;
  for (const [key, item] of Object.entries(value)) {
    const keyPath = pathPrefix ? `${pathPrefix}.${key}` : key;
    if (SENSITIVE_KEY_PATTERN.test(key)) {
      hits.push(keyPath);
      continue;
    }
    findSensitiveKeys(item, keyPath, hits);
  }
  return hits;
}

/**
 * 生成可安全落盘的 settings 快照。
 *
 * 采用白名单：只保留已知的非敏感字段，其余一律丢弃。
 * 这样即使宿主未来在 providers 里新增凭据字段，也不会被自动带进备份。
 */
function sanitizeSettingsForBackup(settings) {
  if (!isPlainObject(settings)) return { ok: false, reason: "shape-invalid" };
  const snapshot = {};

  if (isPlainObject(settings.enabledPlugins)) {
    snapshot.enabledPlugins = {};
    for (const [pluginId, enabled] of Object.entries(settings.enabledPlugins)) {
      if (typeof enabled === "boolean") snapshot.enabledPlugins[toSafeString(pluginId, 200)] = enabled;
    }
  }

  if (isPlainObject(settings.providers)) {
    snapshot.providers = {};
    for (const [providerId, provider] of Object.entries(settings.providers)) {
      if (!isPlainObject(provider)) continue;
      const safeProvider = {};
      for (const field of PROVIDER_SAFE_FIELDS) {
        if (provider[field] !== undefined) safeProvider[field] = toSafeString(provider[field], 500);
      }
      if (safeProvider.baseUrl) safeProvider.baseUrl = stripUrlCredentials(safeProvider.baseUrl);
      if (Array.isArray(provider.models)) {
        safeProvider.models = provider.models
          .slice(0, 50)
          .map((model) => (isPlainObject(model) ? { model: toSafeString(model.model, 200) } : null))
          .filter((model) => model && model.model);
      }
      snapshot.providers[toSafeString(providerId, 200)] = safeProvider;
    }
  }

  return { ok: true, data: snapshot };
}

// renameWithRetry 单独导出仅为让退避预算与"末次不空等"可被确定性测试
module.exports = {
  REDACTED,
  PROVIDER_SAFE_FIELDS,
  RENAME_ATTEMPTS,
  isPlainObject,
  toSafeString,
  maskSecret,
  stripUrlCredentials,
  redactLikelySecret,
  describeError,
  readJsonSafe,
  atomicWrite,
  renameWithRetry,
  findSensitiveKeys,
  sanitizeSettingsForBackup
};
