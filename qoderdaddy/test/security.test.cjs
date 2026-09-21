"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  REDACTED,
  RENAME_ATTEMPTS,
  maskSecret,
  stripUrlCredentials,
  redactLikelySecret,
  readJsonSafe,
  atomicWrite,
  renameWithRetry,
  findSensitiveKeys,
  sanitizeSettingsForBackup,
  isPlainObject
} = require("../dist/node/lib/security.cjs");

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "qd-security-"));
}

test("isPlainObject 排除 null 与数组", () => {
  assert.equal(isPlainObject({}), true);
  assert.equal(isPlainObject(null), false);
  assert.equal(isPlainObject([]), false);
  assert.equal(isPlainObject("ab"), false);
  assert.equal(isPlainObject(3), false);
});

test("maskSecret：短密钥整体遮蔽，长密钥最多显露末 4 位", () => {
  assert.equal(maskSecret(""), "");
  assert.equal(maskSecret(null), "");
  assert.equal(maskSecret(undefined), "");
  assert.equal(maskSecret(12345), "");

  // 8 字符：原来会返回 "***"，现在应整体遮蔽
  assert.equal(maskSecret("12345678"), REDACTED);
  // 9 字符：原实现显露 8/9 字符（89%）。必须整体遮蔽。
  assert.equal(maskSecret("123456789"), REDACTED);
  assert.ok(!maskSecret("123456789").includes("1234"));
  // 15 字符仍整体遮蔽
  assert.equal(maskSecret("123456789012345"), REDACTED);
  // 16 字符起显露末 4 位
  const masked = maskSecret("1234567890123456");
  assert.equal(masked, `${REDACTED}3456`);
  assert.ok(!masked.includes("1234"), "前缀不得出现在脱敏结果中");
  assert.ok(!masked.includes("5678"), "中段不得出现在脱敏结果中");
});

test("maskSecret 的暴露比例不随长度失控", () => {
  // 回归防线：无论多长，最多只显露 4 个明文字符
  for (const length of [16, 20, 32, 51, 64]) {
    const secret = "A".repeat(length - 4) + "ZZZZ";
    const masked = maskSecret(secret);
    const revealed = masked.replaceAll(REDACTED, "");
    assert.equal(revealed.length, 4, `长度 ${length} 时显露了 ${revealed.length} 个字符`);
  }
});

test("stripUrlCredentials：剥离查询串、片段与 userinfo", () => {
  assert.equal(stripUrlCredentials("https://h/v1?api-key=SECRET"), "https://h/v1");
  assert.equal(stripUrlCredentials("https://h/v1#token=SECRET"), "https://h/v1");
  assert.equal(stripUrlCredentials("https://user:pass@h/v1"), "https://h/v1");
  assert.equal(stripUrlCredentials("https://h/v1?k=1#f=2"), "https://h/v1");
  assert.equal(stripUrlCredentials("https://h/v1"), "https://h/v1");
  assert.equal(stripUrlCredentials(""), "");
  assert.equal(stripUrlCredentials(null), "");
  assert.ok(!stripUrlCredentials("https://user:pw@h/v1?api-key=SECRET").includes("SECRET"));
  assert.ok(!stripUrlCredentials("https://user:pw@h/v1").includes("pw"));
});

test("redactLikelySecret：Basic/Bearer 与键值形式的凭据都要遮蔽", () => {
  const basic = "Authorization: Basic dXNlcjpwYXNzd29yZA==";
  assert.ok(!redactLikelySecret(basic).includes("dXNlcjpwYXNzd29yZA=="), "Basic 载荷必须被遮蔽");

  const bearer = "authorization: Bearer eyJhbGciOi.JIUzI1NiJ9";
  assert.ok(!redactLikelySecret(bearer).includes("eyJhbGciOi"));

  assert.ok(!redactLikelySecret('{"apiKey":"sk-abcdef0123456789"}').includes("sk-abcdef0123456789"));
  assert.ok(!redactLikelySecret("password=hunter2").includes("hunter2"));
});

test("readJsonSafe：区分缺失、解析失败与成功", () => {
  const dir = tempDir();
  const missing = readJsonSafe(path.join(dir, "nope.json"));
  assert.deepEqual(missing, { ok: false, reason: "missing" });

  const badPath = path.join(dir, "bad.json");
  // 故意让损坏内容里带一个密钥：JSON.parse 的错误信息可能内嵌原文片段，不得把它带出去
  fs.writeFileSync(badPath, '{"apiKey":"sk-LEAKME-0123456789",,}', "utf8");
  const bad = readJsonSafe(badPath);
  assert.equal(bad.ok, false);
  assert.equal(bad.reason, "parse-error");
  assert.equal(typeof bad.error, "string");
  assert.ok(!bad.error.includes("sk-LEAKME-0123456789"), "解析错误信息不得泄漏原文中的密钥");

  const goodPath = path.join(dir, "good.json");
  fs.writeFileSync(goodPath, '{"a":1}', "utf8");
  assert.deepEqual(readJsonSafe(goodPath), { ok: true, data: { a: 1 } });
});

test("atomicWrite：写入成功、可覆盖、不残留临时文件", () => {
  const dir = tempDir();
  const file = path.join(dir, "out.json");

  atomicWrite(file, "first");
  assert.equal(fs.readFileSync(file, "utf8"), "first");
  assert.deepEqual(fs.readdirSync(dir), ["out.json"], "不得残留 .tmp 文件");

  atomicWrite(file, "second");
  assert.equal(fs.readFileSync(file, "utf8"), "second");
  assert.deepEqual(fs.readdirSync(dir), ["out.json"]);
});

test("atomicWrite：写入失败时必须清理临时文件", () => {
  const dir = tempDir();
  const file = path.join(dir, "out.json");

  // 以 Symbol 作为数据会让 writeFileSync 抛错，但临时文件已经创建 —— 必须被清理
  assert.throws(() => atomicWrite(file, Symbol("boom")));
  assert.deepEqual(fs.readdirSync(dir), [], "失败路径不得残留临时文件");
  assert.equal(fs.existsSync(file), false);
});

test("renameWithRetry：瞬时错误退避重试，成功即返回", () => {
  const codes = ["EPERM", "EBUSY", undefined];
  const sleeps = [];
  let calls = 0;
  const fakeFs = {
    renameSync() {
      calls += 1;
      const code = codes.shift();
      if (code) {
        const error = new Error(code);
        error.code = code;
        throw error;
      }
    },
    unlinkSync() {
      throw new Error("不应清理一个成功的 rename");
    }
  };

  renameWithRetry("from", "to", { fs: fakeFs, sleep: (ms) => sleeps.push(ms) });
  assert.equal(calls, 3, "前两次失败后应重试，第三次成功");
  assert.deepEqual(sleeps, [25, 50], "退避应指数增长，且成功那次不再退避");
});

test("renameWithRetry：穷尽尝试后不再空等，清理临时文件并抛出原始错误", () => {
  const sleeps = [];
  let unlinked = null;
  const error = new Error("file is locked");
  error.code = "EPERM";
  const fakeFs = {
    renameSync() {
      throw error;
    },
    unlinkSync(file) {
      unlinked = file;
    }
  };

  assert.throws(() => renameWithRetry("from", "to", { fs: fakeFs, sleep: (ms) => sleeps.push(ms) }), /file is locked/);
  // 回归：早期实现会先睡再退出循环，最后一次失败后白等 400ms（同步阻塞插件线程）
  assert.equal(sleeps.length, RENAME_ATTEMPTS - 1, "最后一行尝试之后不应再退避");
  assert.deepEqual(sleeps, [25, 50, 100, 200, 400]);
  assert.equal(unlinked, "from", "放弃前必须清理临时文件");
});

test("renameWithRetry：非瞬时错误立即放弃，不退避", () => {
  const sleeps = [];
  let calls = 0;
  const error = new Error("no such file");
  error.code = "ENOENT";
  const fakeFs = {
    renameSync() {
      calls += 1;
      throw error;
    },
    unlinkSync() {}
  };

  assert.throws(() => renameWithRetry("from", "to", { fs: fakeFs, sleep: (ms) => sleeps.push(ms) }), /no such file/);
  assert.equal(calls, 1, "非瞬时错误不得重试");
  assert.deepEqual(sleeps, []);
});

test("renameWithRetry：失败时抛出的仍是原始错误，不被清理异常覆盖", () => {
  const error = new Error("original");
  error.code = "EACCES";
  const fakeFs = {
    renameSync() {
      throw error;
    },
    unlinkSync() {
      throw new Error("cleanup failed");
    }
  };

  assert.throws(() => renameWithRetry("from", "to", { fs: fakeFs, sleep: () => {} }), (thrown) => thrown === error);
});

test("findSensitiveKeys：递归命中疑似凭据键，且只返回路径不返回值", () => {
  assert.deepEqual(findSensitiveKeys({}), []);
  assert.deepEqual(findSensitiveKeys({ providers: { a: { apiKey: "x" } } }), ["providers.a.apiKey"]);
  assert.deepEqual(findSensitiveKeys({ a: { b: { refreshToken: "x" } } }), ["a.b.refreshToken"]);
  assert.deepEqual(findSensitiveKeys({ list: [{ password: "p" }] }), ["list[0].password"]);
  // 命中键后不再向下钻取，避免把整个凭据子树路径全列出来
  assert.deepEqual(findSensitiveKeys({ token: { nested: "x" } }), ["token"]);
  // 正常字段不应误报
  assert.deepEqual(findSensitiveKeys({ baseUrl: "https://h", type: "openai", models: [{ model: "m" }] }), []);
});

test("sanitizeSettingsForBackup：白名单裁剪，丢弃凭据与未知字段", () => {
  const input = {
    enabledPlugins: { "qoder-context@qoderapp-bundler": true },
    providers: {
      demo: {
        baseUrl: "https://host/v1?api-key=SECRET",
        apiKey: "sk-SUPERSECRET-0123456789abcdef",
        type: "openai-compatible",
        protocol: "openai",
        authType: "bearer",
        model: "demo-model",
        models: [{ model: "demo-model", apiKey: "nested-SECRET" }],
        // 模拟宿主未来新增的凭据字段：白名单应当把它丢掉
        futureCredential: "should-be-dropped"
      }
    }
  };

  const result = sanitizeSettingsForBackup(input);
  assert.equal(result.ok, true);
  assert.equal(result.data.enabledPlugins["qoder-context@qoderapp-bundler"], true);

  const provider = result.data.providers.demo;
  assert.equal(provider.apiKey, undefined, "apiKey 必须被丢弃");
  assert.equal(provider.futureCredential, undefined, "未知字段必须被丢弃");
  assert.equal(provider.baseUrl, "https://host/v1", "baseUrl 的查询串必须被剥离");
  assert.equal(provider.type, "openai-compatible");
  assert.equal(provider.model, "demo-model");
  assert.deepEqual(provider.models, [{ model: "demo-model" }], "models 只保留 model 字段");

  const serialized = JSON.stringify(result.data);
  assert.ok(!serialized.includes("SECRET"), "快照中不得出现任何凭据片段");
  assert.deepEqual(findSensitiveKeys(result.data), [], "裁剪后的快照不应再含疑似凭据键");
});

test("sanitizeSettingsForBackup：非对象输入返回结构化失败而非静默空结果", () => {
  assert.deepEqual(sanitizeSettingsForBackup(null), { ok: false, reason: "shape-invalid" });
  assert.deepEqual(sanitizeSettingsForBackup("ab"), { ok: false, reason: "shape-invalid" });
  assert.deepEqual(sanitizeSettingsForBackup([1, 2]), { ok: false, reason: "shape-invalid" });
  // providers 不是对象时应被静默忽略（由调用方的 shape 校验负责报错），但不能产出伪记录
  const result = sanitizeSettingsForBackup({ providers: "ab" });
  assert.equal(result.ok, true);
  assert.equal(result.data.providers, undefined);
});
