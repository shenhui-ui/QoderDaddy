"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { createServiceMethods, pruneBackups } = require("../dist/node/main.cjs");
const { QODER_HOME } = require("../dist/node/lib/paths.cjs");

const SECRET_KEY = "sk-SUPERSECRET-0123456789abcdef";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix || "qd-service-"));
}

function writeSettings(dir, content) {
  const file = path.join(dir, "settings.json");
  fs.writeFileSync(file, typeof content === "string" ? content : JSON.stringify(content), "utf8");
  return file;
}

function makeCtx(options) {
  const config = options || {};
  const api = { node: { registerService: () => () => {} } };
  if (config.auth) api.auth = config.auth;
  return {
    plugin: { id: "qoderdaddy.enhance", version: "0.1.0" },
    storagePath: config.storagePath,
    api,
    subscriptions: [],
    diagnostics: { emit() {} }
  };
}

function methodsFor(config) {
  return createServiceMethods(makeCtx(config), {
    settingsPath: config.settingsPath,
    appStatusPath: config.appStatusPath,
    maxBackups: config.maxBackups
  });
}

test("status：返回插件信息与能力位", async () => {
  const methods = methodsFor({});
  const status = await methods.status();
  assert.equal(status.pluginId, "qoderdaddy.enhance");
  assert.equal(status.pluginVersion, "0.1.0");
  assert.equal(status.capabilities.auth, false, "未注入 auth 时应报告能力缺失");
  assert.equal(status.capabilities.nodeService, true);
});

test("status：settingsPath 与运行状态一并返回，供诊断面板按需展示", async () => {
  const dir = tempDir();
  const settingsPath = path.join(dir, "settings.json");
  const status = await methodsFor({ settingsPath }).status();
  assert.equal(status.settingsPath, settingsPath);
  assert.equal(status.qoderHome, QODER_HOME, "配置根目录应来自窄适配层常量");
});

test("providers：正常路径返回脱敏后的列表", async () => {
  const dir = tempDir();
  const settingsPath = writeSettings(dir, {
    providers: {
      demo: {
        baseUrl: "https://host/v1?api-key=" + SECRET_KEY,
        apiKey: SECRET_KEY,
        type: "openai-compatible",
        model: "demo-model",
        models: [{ model: "demo-model" }],
        unknownFutureSecret: SECRET_KEY
      }
    }
  });

  const result = await methodsFor({ settingsPath }).providers();
  assert.equal(result.state, "ok");
  assert.equal(result.count, 1);
  assert.equal(result.list[0].baseUrl, "https://host/v1", "查询串中的密钥必须被剥离");
  assert.ok(!result.list[0].apiKey.includes(SECRET_KEY));
  assert.ok(!JSON.stringify(result).includes(SECRET_KEY), "返回值中不得出现密钥原文");
  assert.equal(result.list[0].unknownFutureSecret, undefined, "未经白名单的字段不得外露");
});

test("providers：文件缺失与解析失败必须报出不同状态（回归：不得伪装成空配置）", async () => {
  const dir = tempDir();

  const missing = await methodsFor({ settingsPath: path.join(dir, "absent.json") }).providers();
  assert.equal(missing.state, "missing");
  assert.equal(missing.count, 0);

  const corruptPath = writeSettings(dir, '{"providers":{"a":,,}}');
  const corrupt = await methodsFor({ settingsPath: corruptPath }).providers();
  assert.equal(corrupt.state, "parse-error");
  assert.notEqual(corrupt.state, "ok", "损坏的配置不得表现为正常空态");
  assert.equal(typeof corrupt.error, "string");
});

test("providers：providers 结构非法时报 shape-invalid，不得产出伪记录", async () => {
  const dir = tempDir();

  // 字符串输入：Object.entries("ab") 会产出 [["0","a"],["1","b"]]，
  // 早期实现由此生成两条字段全空的伪 provider 记录。
  const asString = await methodsFor({ settingsPath: writeSettings(dir, { providers: "ab" }) }).providers();
  assert.equal(asString.state, "shape-invalid");
  assert.deepEqual(asString.list, []);

  // 数组输入：同样不得被当作 provider 表
  const asArray = await methodsFor({ settingsPath: writeSettings(dir, { providers: [{ apiKey: SECRET_KEY }] }) }).providers();
  assert.equal(asArray.state, "shape-invalid");

  // 顶层不是对象
  const asScalar = await methodsFor({ settingsPath: writeSettings(dir, "42") }).providers();
  assert.equal(asScalar.state, "shape-invalid");
});

test("providers：providers 键缺失是合法空态，不得报成结构非法", async () => {
  const dir = tempDir();

  // 新装客户端的 settings.json 只有 enabledPlugins，没有 providers 键
  const fresh = await methodsFor({ settingsPath: writeSettings(dir, { enabledPlugins: { "a@b": true } }) }).providers();
  assert.equal(fresh.state, "ok", "缺键不等于结构损坏 —— 反向错报会把排障引向错误方向");
  assert.equal(fresh.count, 0);
  assert.deepEqual(fresh.list, []);
  assert.equal(fresh.error, null);

  // 空对象同理
  const empty = await methodsFor({ settingsPath: writeSettings(dir, {}) }).providers();
  assert.equal(empty.state, "ok");
  assert.equal(empty.count, 0);
});

test("providers：类型非法时错误信息点明实际类型", async () => {
  const dir = tempDir();
  const asArray = await methodsFor({ settingsPath: writeSettings(dir, { providers: [] }) }).providers();
  assert.equal(asArray.state, "shape-invalid");
  assert.match(asArray.error, /数组/);

  const asString = await methodsFor({ settingsPath: writeSettings(dir, { providers: "ab" }) }).providers();
  assert.match(asString.error, /string/);

  // 顶层不是对象要与"providers 字段有问题"区分开
  const asScalar = await methodsFor({ settingsPath: writeSettings(dir, "42") }).providers();
  assert.match(asScalar.error, /顶层结构/);
});

test("providers：结构非法的单条记录被跳过并计数", async () => {
  const dir = tempDir();
  const settingsPath = writeSettings(dir, {
    providers: { good: { model: "m", type: "openai-compatible" }, bad: "not-an-object" }
  });
  const result = await methodsFor({ settingsPath }).providers();
  assert.equal(result.state, "ok");
  assert.equal(result.count, 1);
  assert.equal(result.skipped, 1);
});

test("authState：缺少 auth 能力时降级而非抛错", async () => {
  const result = await methodsFor({}).authState();
  assert.equal(result.available, false);
  assert.equal(result.reason, "permission-denied");
  assert.equal(result.loggedIn, false);
});

test("authState：能力调用失败时结构化返回原因", async () => {
  const methods = methodsFor({
    auth: {
      getState: async () => {
        throw new Error("permission denied by policy");
      }
    }
  });
  const result = await methods.authState();
  assert.equal(result.available, false);
  assert.equal(result.reason, "call-failed");
  assert.equal(result.error, "permission denied by policy");
});

test("authState：不得回传宿主原始对象，只回传白名单标量", async () => {
  const methods = methodsFor({
    auth: {
      getState: async () => ({
        loggedIn: true,
        nickname: "测试用户",
        accessToken: SECRET_KEY,
        refreshToken: "refresh-" + SECRET_KEY,
        nested: { cookie: "session=abc" }
      })
    }
  });

  const result = await methods.authState();
  assert.equal(result.available, true);
  assert.equal(result.loggedIn, true);
  assert.equal(result.fields.nickname, "测试用户");

  const serialized = JSON.stringify(result);
  assert.ok(!serialized.includes(SECRET_KEY), "不得外泄 accessToken");
  assert.ok(!serialized.includes("refresh-"), "不得外泄 refreshToken");
  assert.ok(!serialized.includes("session=abc"), "不得外泄嵌套结构");
  assert.equal(result.raw, undefined, "不得回传 raw 原始对象");
  // 键名清单用于探明宿主契约，不含值，属预期行为
  assert.ok(result.stateKeys.includes("accessToken"));
});

test("backupLocalState：落盘快照必须不含凭据", async () => {
  const store = tempDir("qd-store-");
  const source = tempDir("qd-src-");
  const settingsPath = writeSettings(source, {
    enabledPlugins: { "qoder-context@qoderapp-bundler": true },
    providers: { demo: { baseUrl: "https://host/v1?api-key=" + SECRET_KEY, apiKey: SECRET_KEY, type: "openai-compatible", model: "demo-model" } }
  });
  const appStatusPath = path.join(source, ".qoder-app-status.json");
  fs.writeFileSync(appStatusPath, JSON.stringify({ logged_in: true, name: "测试用户" }), "utf8");

  const result = await methodsFor({ storagePath: store, settingsPath, appStatusPath }).backupLocalState();
  assert.equal(result.ok, true);
  assert.ok(result.saved.includes("settings.sanitized.json"));
  assert.ok(result.saved.includes("app-status.json"));

  // 逐字节检查落盘内容：这是 P0-2 的回归防线
  const snapshotPath = path.join(result.targetDir, "settings.sanitized.json");
  const written = fs.readFileSync(snapshotPath, "utf8");
  assert.ok(!written.includes(SECRET_KEY), "备份文件中出现了明文密钥");
  assert.ok(!written.includes("api-key="), "备份文件中出现了内嵌凭据的 URL");

  const snapshot = JSON.parse(written);
  assert.equal(snapshot.providers.demo.baseUrl, "https://host/v1");
  assert.equal(snapshot.providers.demo.apiKey, undefined);

  // 整个备份目录都不得含密钥
  const allFiles = fs.readdirSync(result.targetDir);
  for (const name of allFiles) {
    const content = fs.readFileSync(path.join(result.targetDir, name), "utf8");
    assert.ok(!content.includes(SECRET_KEY), `${name} 中出现了明文密钥`);
  }

  const manifest = JSON.parse(fs.readFileSync(path.join(result.targetDir, "manifest.json"), "utf8"));
  assert.equal(manifest.containsCredentials, false);
  assert.deepEqual(manifest.saved, result.saved);
});

test("backupLocalState：源文件缺失时不创建空快照，并如实报出原因", async () => {
  const store = tempDir("qd-store-");
  const result = await methodsFor({
    storagePath: store,
    settingsPath: path.join(store, "absent.json"),
    appStatusPath: path.join(store, "absent-status.json")
  }).backupLocalState();

  assert.equal(result.ok, false);
  assert.equal(result.reason, "nothing-to-backup", "没有任何可备份内容时不得报成功");
  assert.deepEqual(result.saved, []);
  assert.equal(result.skipped.length, 2);
  assert.ok(result.skipped.every((entry) => entry.reason === "missing"));
  // 关键：不得留下只含 manifest 的空快照目录 —— 它会占掉一个保留位并淘汰真实备份
  assert.equal(fs.existsSync(path.join(store, "backup")), false, "无可备份内容时不应创建 backup 目录");
});

test("backupLocalState：无可备份内容不得占用保留位、不得挤掉真实备份", async () => {
  const store = tempDir("qd-store-");
  const source = tempDir("qd-src-");
  const settingsPath = writeSettings(source, { providers: { demo: { model: "m" } } });
  const methods = methodsFor({
    storagePath: store,
    settingsPath,
    appStatusPath: path.join(source, "none.json"),
    maxBackups: 1
  });

  await methods.backupLocalState();
  const afterReal = fs.readdirSync(path.join(store, "backup"));
  assert.equal(afterReal.length, 1);

  // 让两个来源都消失，构造"无可备份内容"；保留窗口为 1，空快照若计数就会把真实备份挤掉
  fs.rmSync(settingsPath);
  for (let index = 0; index < 3; index += 1) {
    const failed = await methods.backupLocalState();
    assert.equal(failed.reason, "nothing-to-backup");
  }

  const remaining = fs.readdirSync(path.join(store, "backup"));
  assert.deepEqual(remaining, afterReal, "空快照不得挤掉真实备份");
});

test("backupLocalState：快照声明自己不可作为恢复源", async () => {
  const store = tempDir("qd-store-");
  const source = tempDir("qd-src-");
  const settingsPath = writeSettings(source, {
    providers: { demo: { baseUrl: "https://host/v1?api-key=" + SECRET_KEY, apiKey: SECRET_KEY, model: "demo-model" } }
  });

  const result = await methodsFor({ storagePath: store, settingsPath, appStatusPath: path.join(source, "none.json") }).backupLocalState();
  const manifest = JSON.parse(fs.readFileSync(path.join(result.targetDir, "manifest.json"), "utf8"));
  // 快照丢弃了 apiKey，直接拿它覆盖 settings.json 会丢凭据 —— 必须显式声明
  assert.equal(manifest.restorable, false);
});

test("pruneBackups：按目录名时间戳保留最新的 N 份", () => {
  const store = tempDir("qd-prune-");
  const backupRoot = path.join(store, "backup");
  // 目录名由 <ISO 时间戳>-<pid36>-<随机> 构成；这里构造受控名字，避免依赖真实时钟
  const names = [
    "2026-09-20T10-00-00-000Z-aaa",
    "2026-09-20T11-00-00-000Z-bbb",
    "2026-09-20T12-00-00-000Z-ccc",
    "2026-09-20T13-00-00-000Z-ddd"
  ];
  for (const name of names) fs.mkdirSync(path.join(backupRoot, name), { recursive: true });

  assert.equal(pruneBackups(backupRoot, 2), 2, "应删除 2 份");
  assert.deepEqual(fs.readdirSync(backupRoot).sort(), names.slice(2).sort(), "应保留最新 2 份");

  // 保留数为 0 是合法输入，表示不留历史（此处共 3 份，全部删除）
  fs.mkdirSync(path.join(backupRoot, "2026-09-20T14-00-00-000Z-eee"), { recursive: true });
  assert.equal(pruneBackups(backupRoot, 0), 3);
  assert.deepEqual(fs.readdirSync(backupRoot), []);

  // 非法 limit 退回默认上限，不得被解释为"全删"
  fs.mkdirSync(path.join(backupRoot, "2026-09-20T15-00-00-000Z-fff"), { recursive: true });
  assert.equal(pruneBackups(backupRoot, -1), 0, "负数不得触发删除");
  assert.deepEqual(fs.readdirSync(backupRoot), ["2026-09-20T15-00-00-000Z-fff"]);

  // 目录缺失时静默返回 0，不抛错
  assert.equal(pruneBackups(path.join(store, "absent"), 2), 0);
});

test("backupLocalState：storagePath 不可用时不得尝试写入", async () => {
  const result = await methodsFor({ storagePath: "" }).backupLocalState();
  assert.equal(result.ok, false);
  assert.equal(result.reason, "storage-unavailable");
});

test("backupLocalState：按 maxBackups 裁剪历史备份", async () => {
  const store = tempDir("qd-store-");
  const source = tempDir("qd-src-");
  const settingsPath = writeSettings(source, { providers: { demo: { model: "m" } } });
  const methods = methodsFor({ storagePath: store, settingsPath, appStatusPath: path.join(source, "none.json"), maxBackups: 2 });

  for (let index = 0; index < 5; index += 1) {
    await methods.backupLocalState();
  }

  const remaining = fs.readdirSync(path.join(store, "backup"));
  assert.equal(remaining.length, 2, `期望保留 2 份，实际 ${remaining.length} 份`);
});
