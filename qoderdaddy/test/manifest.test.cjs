"use strict";

/**
 * 插件清单不变量。
 *
 * 宿主对 manifest 的校验是强校验，失败时只留下一个错误码（APP_PLUGIN_MANIFEST_INVALID /
 * APP_PLUGIN_SIDEBAR_VIEW_INVALID），在没有加载验证回路时很难归因。
 * 这些断言把宿主已知的校验规则前移到 CI，避免"改了一行 json，重启客户端才发现打不开"。
 *
 * 规则来源：设计文档 §2.3（Manifest 允许字段、location 枚举、slot 取值、onView 要求）。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PLUGIN_ROOT = path.join(__dirname, "..");
const MANIFEST_PATH = path.join(PLUGIN_ROOT, ".qoder-app-plugin", "plugin.json");

const VIEW_LOCATIONS = ["workbench", "file.preview", "settings"];
const ALLOWED_SLOTS = ["workbench.sidebar.secondary"];

function readManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

test("plugin.json 可解析且必需字段齐备", () => {
  const manifest = readManifest();
  for (const field of ["id", "name", "version", "engines", "main", "activationEvents", "contributes"]) {
    assert.ok(manifest[field] !== undefined, `缺少必需字段：${field}`);
  }
  assert.match(manifest.id, /^[a-z0-9]+(\.[a-z0-9-]+)+$/, "id 应为点分小写标识");
  assert.match(manifest.version, /^\d+\.\d+\.\d+/, "version 应形如 x.y.z");
});

test("main 指向 dist/node/ 下的现存文件", () => {
  const manifest = readManifest();
  assert.ok(manifest.main.startsWith("dist/node/"), `main 必须位于 dist/node/ 下，实际为 ${manifest.main}`);
  assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, manifest.main)), `main 指向的文件不存在：${manifest.main}`);
});

test("plugin.json 与 package.json 的版本号一致", () => {
  const manifest = readManifest();
  const pkg = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, "package.json"), "utf8"));
  // 两处版本号无人核对时会静默漂移：宿主按 manifest 上报版本，面板读的是同一份，
  // 但 package.json 决定了将来打包/发布的版本，不一致会让"面板显示 0.1.0、包是 0.1.1"成立
  assert.equal(manifest.version, pkg.version, `plugin.json=${manifest.version} / package.json=${pkg.version}`);
});

test("activationEvents 为每个视图声明 onView", () => {
  const manifest = readManifest();
  const viewIds = manifest.contributes.views.map((view) => view.id);
  assert.ok(viewIds.length > 0, "至少需要声明一个视图");
  for (const viewId of viewIds) {
    assert.ok(
      manifest.activationEvents.includes(`onView:${viewId}`),
      `activationEvents 缺少 onView:${viewId}`
    );
  }
  assert.ok(manifest.activationEvents.includes("onStartup"), "缺少 onStartup 激活事件");
});

test("每个视图的 location 取值合法，且 entry 文件存在", () => {
  const manifest = readManifest();
  for (const view of manifest.contributes.views) {
    assert.ok(VIEW_LOCATIONS.includes(view.location), `视图 ${view.id} 的 location 非法：${view.location}`);
    assert.ok(view.entry, `视图 ${view.id} 缺少 entry`);
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, view.entry)), `视图 ${view.id} 的 entry 不存在：${view.entry}`);
  }
});

test("sidebarNavItems 的 viewId 指向 workbench 视图，slot 取值合法", () => {
  const manifest = readManifest();
  const viewsById = new Map(manifest.contributes.views.map((view) => [view.id, view]));
  assert.ok(manifest.contributes.sidebarNavItems.length > 0, "至少需要一个侧边栏项");

  for (const item of manifest.contributes.sidebarNavItems) {
    const target = viewsById.get(item.viewId);
    assert.ok(target, `侧边栏项 ${item.id} 的 viewId 悬空：${item.viewId}`);
    assert.equal(target.location, "workbench", `侧边栏项 ${item.id} 必须指向 location=workbench 的视图`);
    assert.ok(ALLOWED_SLOTS.includes(item.slot), `侧边栏项 ${item.id} 的 slot 非法：${item.slot}`);
    assert.ok(item.icon, `侧边栏项 ${item.id} 缺少 icon`);
    assert.ok(fs.existsSync(path.join(PLUGIN_ROOT, item.icon)), `侧边栏项 ${item.id} 的 icon 不存在：${item.icon}`);
  }
});

test("contributes 只使用宿主允许的键", () => {
  const allowed = ["views", "filePreviewers", "sidebarNavItems", "configuration", "qoderAgentSdk", "nativeModules"];
  const manifest = readManifest();
  for (const key of Object.keys(manifest.contributes)) {
    assert.ok(allowed.includes(key), `contributes 含未允许的键：${key}`);
  }
});

test("engines 声明的版本下限可举证", () => {
  const manifest = readManifest();
  // 设计要求：声明范围必须落在实测过的宿主版本上，不能笼统写 >=0.0.1
  assert.match(manifest.engines.qoder, /^>=\d+\.\d+\.\d+$/, "engines.qoder 应为 >=x.y.z 形式");
  const minVersion = manifest.engines.qoder.slice(2).split(".").map(Number);
  assert.ok(
    minVersion[0] > 0 || minVersion[1] >= 3,
    "版本下限过低：本插件依赖 pluginHost / node.registerService 等 v0.3.4 实测能力"
  );
});

test("申请的权限保持在最小集合", () => {
  const manifest = readManifest();
  assert.ok(Array.isArray(manifest.permissions), "permissions 应为数组");
  // 明确禁止项：当前实现不读取用户令牌，若被加入需同时更新 PROVENANCE 与 SECURITY
  assert.ok(!manifest.permissions.includes("auth.readUserToken"), "当前实现不应申请 auth.readUserToken");
  for (const permission of manifest.permissions) {
    assert.ok(!permission.startsWith("debug."), "stable 渠道禁用 debug.* 权限");
  }
});
