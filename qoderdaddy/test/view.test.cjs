"use strict";

/**
 * 工作台视图的回归测试（最小 DOM 替身）。
 *
 * 为什么需要它：视图侧的缺陷大多是**语义**缺陷 —— 属性挂到了哪个元素上、默认可见区域里
 * 有没有本机绝对路径、节点上有没有写入注入通道。`node --check` 只做语法解析，测不出这些。
 * 这里用一个最小 DOM 替身把 `mount` 真正跑起来，断言可观察的结果。
 *
 * 替身的能力边界（明确声明，避免高估结论）：不实现布局、级联、事件冒泡与真实的
 * MutationObserver 语义；`dataset` 与 `data-*` 属性按 HTML 的双向映射实现。
 * 因此本文件的断言只覆盖"DOM 结构与被写入的属性/文本"，不覆盖视觉效果。
 */

const test = require("node:test");
const assert = require("node:assert/strict");

const DATA_PREFIX = "data-";

function camelCase(name) {
  return name.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

class FakeNode {
  constructor(tag) {
    this.tagName = tag;
    this.childNodes = [];
    this.attrs = new Map();
    this.dataset = {};
    this.listeners = new Map();
    this.parent = null;
    this.hidden = false;
    this.disabled = false;
    this.textContent = "";
    this.className = "";
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parent = this;
      this.childNodes.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.childNodes = [];
    this.append(...nodes);
  }

  addEventListener(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(handler);
  }

  dispatch(type) {
    for (const handler of this.listeners.get(type) || []) handler();
  }

  remove() {
    if (!this.parent) return;
    this.parent.childNodes = this.parent.childNodes.filter((node) => node !== this);
    this.parent = null;
  }

  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    if (name.startsWith(DATA_PREFIX)) {
      this.dataset[camelCase(name.slice(DATA_PREFIX.length))] = String(value);
    }
  }

  getAttribute(name) {
    if (name.startsWith(DATA_PREFIX)) {
      const key = camelCase(name.slice(DATA_PREFIX.length));
      return Object.prototype.hasOwnProperty.call(this.dataset, key) ? this.dataset[key] : null;
    }
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }

  /** 子树内全部节点（含自身），供遍历断言使用。 */
  walk() {
    const all = [this];
    for (const child of this.childNodes) all.push(...child.walk());
    return all;
  }

  /** 子树内的可见文本，按 DOM 顺序拼接 —— 用来回答"面板上到底显示了什么"。 */
  text() {
    return this.walk()
      .filter((node) => node.tagName === "#text" || (node.childNodes.length === 0 && node.textContent))
      .map((node) => node.textContent)
      .join(" ");
  }
}

// ── 宿主环境替身（必须在 require 视图之前装好）──
const observers = [];

globalThis.Node = FakeNode;
globalThis.document = {
  documentElement: new FakeNode("html"),
  createElement: (tag) => new FakeNode(tag),
  createTextNode: (text) => {
    const node = new FakeNode("#text");
    node.textContent = String(text);
    return node;
  }
};
globalThis.MutationObserver = class {
  constructor(callback) {
    this.callback = callback;
    this.connected = false;
    observers.push(this);
  }
  observe() {
    this.connected = true;
  }
  disconnect() {
    this.connected = false;
  }
};

let view = null;
globalThis.qoderPluginView = {
  register(registered) {
    view = registered;
  }
};
require("../dist/browser/view.cjs");

function liveObserver() {
  return observers.filter((observer) => observer.connected).pop();
}

function setHostTheme(theme) {
  if (theme === undefined) delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
}

// ── 固定的服务返回样本。路径刻意含本机用户名，用于验证"默认不回显" ──
const STATUS = {
  pluginId: "qoderdaddy.enhance",
  pluginVersion: "0.1.0",
  storagePath: "C:\\Users\\tester\\AppData\\Roaming\\qoderdaddy",
  settingsPath: "C:\\Users\\tester\\.qoder-cn\\settings.json",
  platform: "win32",
  node: "22.0.0",
  qoderHome: "C:\\Users\\tester\\.qoder-cn",
  capabilities: { auth: true, nodeService: true }
};
const AUTH = {
  available: true,
  loggedIn: true,
  fields: { nickname: "测试用户" },
  stateKeys: ["loggedIn", "nickname", "accessToken"]
};
const PROVIDERS_OK = {
  settingsPath: STATUS.settingsPath,
  state: "ok",
  error: null,
  count: 1,
  skipped: 0,
  list: [
    {
      id: "demo",
      baseUrl: "https://host/v1",
      type: "openai-compatible",
      model: "demo-model",
      apiKey: "••••••cdef",
      models: ["demo-model"]
    }
  ]
};
const PROVIDERS_MISSING = {
  settingsPath: STATUS.settingsPath,
  state: "missing",
  error: null,
  count: 0,
  skipped: 0,
  list: []
};

function mountView(payloads) {
  const container = new FakeNode("div");
  const calls = [];
  const context = {
    api: {
      node: {
        callService: async (service, method) => {
          calls.push(method);
          if (!Object.prototype.hasOwnProperty.call(payloads, method)) {
            return { ok: false, error: "unknown-method" };
          }
          return { ok: true, data: payloads[method] };
        }
      }
    }
  };
  const instance = view.mount(container, context);
  return { container, instance, calls };
}

/** refresh() 是 async：等一个宏任务，三段 RPC 链会在那之前全部完成。 */
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function rootOf(container) {
  return container.childNodes.find((node) => node.className === "qd-root");
}

function cardTitled(container, title) {
  return container.walk().find((node) => node.className === "qd-card" && node.text().includes(title));
}

function buttonTitled(container, title) {
  return container.walk().find((node) => node.tagName === "button" && node.textContent === title);
}

test("主题同步把 data-theme 写在 .qd-root 上，并跟随宿主主题变化", async () => {
  setHostTheme("dark");
  const { container, instance } = mountView({ status: STATUS, authState: AUTH, providers: PROVIDERS_OK });
  await flush();

  const root = rootOf(container);
  assert.ok(root, "应存在 .qd-root 节点");
  // 回归：早期实现写在 container 上，而 container 没有 .qd-root 类，
  // 导致 `.qd-root[data-theme="dark"]` 永不命中、暗色下文字不可读
  assert.equal(root.getAttribute("data-theme"), "dark");
  assert.equal(container.getAttribute("data-theme"), null, "不得改写宿主挂载点上的属性");

  document.documentElement.dataset.theme = "light";
  liveObserver().callback();
  assert.equal(root.getAttribute("data-theme"), "light", "主题变化应经 MutationObserver 同步");

  instance.dispose();
  assert.equal(root.getAttribute("data-theme"), null, "dispose 后不得留下状态");
});

test("宿主未声明主题时不得臆造 data-theme", async () => {
  setHostTheme(undefined);
  const { container, instance } = mountView({ status: STATUS, authState: AUTH, providers: PROVIDERS_OK });
  await flush();
  assert.equal(rootOf(container).getAttribute("data-theme"), null);
  instance.dispose();
});

test("providers 缺失态不得回显含本机用户名的绝对路径", async () => {
  const { container, instance } = mountView({ status: STATUS, authState: AUTH, providers: PROVIDERS_MISSING });
  await flush();

  const text = container.text();
  assert.ok(text.includes("未找到 settings.json"), "应给出可读的缺失说明");
  assert.ok(!text.includes("tester"), `默认可见区域出现了本机用户名：${text}`);
  assert.ok(!text.includes(STATUS.settingsPath), "不得回显完整路径");
  // 文案与调用点必须对齐：形参错位会渲染出 "undefined"，比不显示更糟
  assert.ok(!text.includes("undefined"), `说明文案出现未替换的占位符：${text}`);
  instance.dispose();
});

test("解析失败与缺失必须显示为不同文案，不得混为一谈", async () => {
  const { container, instance } = mountView({
    status: STATUS,
    authState: AUTH,
    providers: { ...PROVIDERS_MISSING, state: "parse-error", error: "Unexpected token" }
  });
  await flush();

  const text = container.text();
  assert.ok(text.includes("解析失败"), "损坏的配置必须报成损坏");
  assert.ok(!text.includes("未找到 settings.json"));
  assert.ok(text.includes("Unexpected token"), "具体原因应上屏，便于归因");
  instance.dispose();
});

test("诊断信息默认隐藏，展开后才显示绝对路径与宿主契约键名", async () => {
  const { container, instance } = mountView({ status: STATUS, authState: AUTH, providers: PROVIDERS_OK });
  await flush();

  const card = cardTitled(container, "诊断信息");
  assert.ok(card.hidden, "诊断卡片默认必须隐藏");
  assert.ok(!container.text().includes("tester"), "默认不渲染绝对路径");

  buttonTitled(container, "诊断信息").dispatch("click");
  assert.equal(card.hidden, false);
  const text = container.text();
  assert.ok(text.includes("tester"), "展开后应能看到路径");
  // 方案附录 B 第 5 项：靠键名清单核对宿主契约，值不在其中
  assert.ok(text.includes("accessToken"), "展开后应能看到登录态字段名");
  assert.ok(!text.includes("sk-"), "键名清单不得夹带任何值");

  buttonTitled(container, "隐藏诊断信息").dispatch("click");
  assert.equal(card.hidden, true);
  instance.dispose();
});

test("渲染结果不含 innerHTML 等注入通道，可疑内容一律作为文本显示", async () => {
  const hostile = "<img src=x onerror=alert(1)>";
  const { container, instance } = mountView({
    status: STATUS,
    authState: AUTH,
    providers: { ...PROVIDERS_OK, list: [{ ...PROVIDERS_OK.list[0], model: hostile }] }
  });
  await flush();

  for (const node of container.walk()) {
    for (const key of ["innerHTML", "outerHTML", "onerror", "onclick", "src", "href"]) {
      assert.equal(
        Object.prototype.hasOwnProperty.call(node, key),
        false,
        `节点 ${node.tagName} 上出现了注入通道 ${key}`
      );
    }
  }
  assert.ok(container.text().includes(hostile), "可疑内容必须原样作为文本呈现");
  instance.dispose();
});

test("RPC 失败时把原因写在错误行，不抛未捕获异常", async () => {
  const { container, instance } = mountView({ status: STATUS });
  await flush();

  const text = container.text();
  assert.ok(text.includes("authState"), `错误行应点明失败的方法：${text}`);
  instance.dispose();
});

test("同一挂载点重复 mount 时先释放上一个实例，不叠加 DOM", async () => {
  setHostTheme("dark");
  const { container, instance } = mountView({ status: STATUS, authState: AUTH, providers: PROVIDERS_OK });
  await flush();
  const before = container.childNodes.length;

  const second = view.mount(container, {
    api: { node: { callService: async () => ({ ok: true, data: STATUS }) } }
  });
  await flush();

  assert.equal(container.childNodes.length, before, "重复挂载不得叠加节点");
  assert.equal(container.walk().filter((node) => node.className === "qd-root").length, 1);

  second.dispose();
  instance.dispose();
});

test("dispose 移除注入的 DOM，重复调用不抛错", async () => {
  const { container, instance } = mountView({ status: STATUS, authState: AUTH, providers: PROVIDERS_OK });
  await flush();
  assert.ok(container.childNodes.length > 0);
  const connectedBefore = observers.filter((observer) => observer.connected).length;

  instance.dispose();
  assert.equal(container.childNodes.length, 0, "dispose 后不得残留 style 或面板节点");
  assert.equal(
    observers.filter((observer) => observer.connected).length,
    connectedBefore - 1,
    "MutationObserver 必须断开"
  );
  assert.doesNotThrow(() => instance.dispose());
});
