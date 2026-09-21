"use strict";

/**
 * QoderDaddy — 工作台视图。
 *
 * 约束来源（方案 §3.5(6)）：跟随宿主亮/暗主题、尺寸稳定无跳动、紧凑信息密度、键盘可达；
 * 加上 §3.5(2) 的 `mount`/`dispose` 契约。宿主 CSS 变量名是混淆的，不要直接依赖。
 *
 * 关于主题：方案 §3.5(2) 明令「宿主 CSS 变量名是混淆的，不要直接依赖」。
 * 早期实现直接写了 `var(--q83a88e, #1f2329)`，而方案举例的是 `--qeee3f3` ——
 * 两个名字互相矛盾，本身就说明该变量名不可靠。因此这里改用语义关键字
 * （canvastext / light-dark()）配合 color-scheme，不依赖任何未实测的宿主变量；
 * 接入点保留在下方 CSS 注释中。
 */

(function () {
  const SERVICE = "qoderdaddy.backend";
  const MAX_CELL = 200;

  const CSS = `
.qd-root {
  /* ── 语义别名层：视图内所有颜色只引用 --qd-*，宿主改版时只改这一段 ──
     接入宿主变量前请先实测变量名与取值（方案附录 B）：本不必依赖它也能自适应主题。
     接入方式：--qd-fg: var(--q<实测值>, canvastext); */
  --qd-fg: canvastext;
  --qd-line: color-mix(in srgb, currentColor 14%, transparent);
  --qd-line-soft: color-mix(in srgb, currentColor 10%, transparent);
  --qd-hover: color-mix(in srgb, currentColor 8%, transparent);
  --qd-muted-fg: color-mix(in srgb, currentColor 62%, transparent);
  --qd-danger: light-dark(#cf1322, #ff7875);
  color-scheme: light dark;
  color: var(--qd-fg);
  font: 12px/1.6 system-ui, "Segoe UI", "Microsoft YaHei", sans-serif;
  box-sizing: border-box;
  padding: 16px;
  height: 100%;
  overflow: auto;
}
/* 由挂载逻辑从 document.documentElement[data-theme] 同步而来。
   这两条是必需的：light-dark() 依据 color-scheme 解析，而 color-scheme
   必须显式跟随宿主主题，否则主题同步写了也没人消费。 */
.qd-root[data-theme="dark"] { color-scheme: dark; }
.qd-root[data-theme="light"] { color-scheme: light; }

.qd-title { font-size: 14px; font-weight: 600; margin: 0 0 4px; }
.qd-sub { color: var(--qd-muted-fg); margin: 0 0 12px; }
.qd-card { border: 1px solid var(--qd-line); border-radius: 10px; padding: 12px; margin-bottom: 10px; }
.qd-card h3 { font-size: 12px; font-weight: 600; margin: 0 0 8px; color: var(--qd-muted-fg); }
.qd-row { display: flex; justify-content: space-between; gap: 12px; padding: 2px 0; }
.qd-row > span:first-child { color: var(--qd-muted-fg); flex: 0 0 auto; }
.qd-row > span:last-child { text-align: right; overflow-wrap: anywhere; }
.qd-mono { font-family: ui-monospace, Consolas, monospace; }
.qd-table { width: 100%; border-collapse: collapse; table-layout: fixed; }
.qd-table td, .qd-table th { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--qd-line-soft); vertical-align: top; overflow-wrap: anywhere; }
.qd-btn { border: 1px solid var(--qd-line); background: transparent; color: inherit; border-radius: 6px; padding: 3px 10px; cursor: pointer; font: inherit; }
.qd-btn:hover:not(:disabled) { background: var(--qd-hover); }
.qd-btn:disabled { opacity: .5; cursor: default; }
.qd-actions { display: flex; gap: 8px; align-items: center; margin-top: 4px; }
.qd-state { color: var(--qd-muted-fg); }
.qd-bad { color: var(--qd-danger); }
.qd-err { color: var(--qd-danger); margin-top: 8px; overflow-wrap: anywhere; }
`;

  /**
   * 属性白名单。刻意不含 innerHTML / on* / src / href：
   * 本模块只把已知标量放进已知位置，不需要通用赋值能力。
   * 早期实现用 Object.assign(node, props)，一旦 props 变成数据驱动，
   * 传入 innerHTML 或 onerror 即构成注入。
   */
  const SAFE_PROPS = new Set(["className", "textContent", "title", "id", "type", "role", "disabled"]);

  function el(tag, props, children) {
    const node = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        if (!SAFE_PROPS.has(key)) continue;
        if (key === "disabled") node.disabled = Boolean(props[key]);
        else if (key === "textContent") node.textContent = String(props[key]);
        else node[key] = String(props[key]);
      }
    }
    for (const child of children || []) {
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  function shorten(value) {
    if (value === null || value === undefined || value === "") return "-";
    const text = String(value);
    return text.length > MAX_CELL ? `${text.slice(0, MAX_CELL)}…` : text;
  }

  function row(label, value) {
    return el("div", { className: "qd-row" }, [
      el("span", {}, [label]),
      el("span", { className: "qd-mono" }, [shorten(value)])
    ]);
  }

  /**
   * providers 的四种非正常状态各自的说明文案。
   *
   * 刻意**不回显 settingsPath**：该路径形如 `C:\Users\<本机用户名>\.qoder-cn\settings.json`，
   * 面板默认可见，截屏或共享即随之外泄。诊断信息卡片由用户主动展开，路径放在那里。
   */
  const PROVIDER_STATE_TEXT = {
    missing: () => "未找到 settings.json —— 该账号尚未配置第三方模型 provider",
    "parse-error": () => "settings.json 解析失败 —— 文件可能已损坏，请检查内容或从备份恢复",
    "io-error": () => "读取 settings.json 失败（权限不足或文件被占用）",
    "shape-invalid": () => "settings.json 的 providers 字段结构非法，已跳过"
  };

  function loginStateText(auth) {
    if (!auth || auth.available === false) {
      const reason = auth && auth.reason ? auth.reason : "unknown";
      return `不可用（${reason}）`;
    }
    const name = auth.fields && (auth.fields.nickname || auth.fields.name);
    if (auth.loggedIn) return name ? `已登录 · ${name}` : "已登录";
    return "未登录";
  }

  /**
   * 同一挂载点被重复 mount 时的保护。
   *
   * 契约上宿主是 mount ↔ dispose 配对使用，但重载视图时若宿主先挂新的再卸旧的，
   * 同一个 container 上就会留下两套 DOM 与两个仍在监听的 MutationObserver，
   * 且旧的那套再无句柄可回收。这里按 container 记名，重复挂载前先释放上一个实例。
   * 用 WeakMap 是为了不给挂载点加引用、也不依赖 DOM 上的标记属性（避免与其他插件撞名）。
   */
  const mountedInstances = new WeakMap();

  globalThis.qoderPluginView.register({
    mount(container, context) {
      const previous = mountedInstances.get(container);
      if (previous) {
        try {
          previous.dispose();
        } catch (_) {
          /* 上个实例自清理失败不应阻断新实例挂载 */
        }
      }

      const style = document.createElement("style");
      style.textContent = CSS;
      const root = el("div", { className: "qd-root" });
      container.append(style, root);

      const statusCard = el("div", { className: "qd-card" }, [el("h3", {}, ["运行状态"])]);
      const providersCard = el("div", { className: "qd-card" }, [el("h3", {}, ["模型提供方"])]);
      const diagnosticsCard = el("div", { className: "qd-card" }, [el("h3", {}, ["诊断信息"])]);
      diagnosticsCard.hidden = true;
      const errorLine = el("div", { className: "qd-err" });

      const refreshBtn = el("button", { className: "qd-btn", textContent: "刷新" });
      const diagnosticsBtn = el("button", { className: "qd-btn", textContent: "诊断信息" });

      root.append(
        el("h2", { className: "qd-title", textContent: "QoderDaddy" }),
        el("p", { className: "qd-sub", textContent: "Qoder CN 增强层 · 官方插件形态" }),
        statusCard,
        providersCard,
        el("div", { className: "qd-actions" }, [refreshBtn, diagnosticsBtn]),
        diagnosticsCard,
        errorLine
      );

      let disposed = false;
      let refreshSeq = 0;
      let latestStatus = null;
      let latestAuth = null;
      let diagnosticsVisible = false;

      // ── 主题同步：窄观察，只盯一个属性 ──
      // 注意 `data-theme` 必须写在 root（带 .qd-root 类）上：CSS 的
      // `.qd-root[data-theme="dark"] { color-scheme: dark }` 依赖这个类选择器。
      // 早期实现写在 container 上，而 container 是宿主自己的挂载点、没有 .qd-root 类，
      // 于是该规则永不命中，color-scheme 只随操作系统而非宿主主题 —— 暗色下文字不可读。
      // 同理，dispose 只清理 root 上的属性：container 的属性可能由宿主自己维护，不能代为删除。
      const syncTheme = () => {
        const theme = document.documentElement.getAttribute("data-theme");
        if (theme === "dark" || theme === "light") root.dataset.theme = theme;
        else delete root.dataset.theme;
      };
      syncTheme();
      const themeObserver = new MutationObserver(syncTheme);
      themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

      function renderStatus(status, auth) {
        statusCard.replaceChildren(
          el("h3", {}, ["运行状态"]),
          row("插件版本", status.pluginVersion || "-"),
          row("登录态", loginStateText(auth))
        );
      }

      function renderDiagnostics(status, auth) {
        if (!diagnosticsVisible) return;
        // 绝对路径含本机用户名，默认不渲染：面板截屏/共享时会随之外泄。
        // stateKeys 只含宿主契约的键名、不含值，用于核对宿主 API 形状（方案附录 B 第 5 项）。
        const stateKeys = auth && Array.isArray(auth.stateKeys) ? auth.stateKeys : [];
        diagnosticsCard.replaceChildren(
          el("h3", {}, ["诊断信息"]),
          row("存储目录", status.storagePath),
          row("provider 配置", status.settingsPath),
          row("Qoder 配置", status.qoderHome),
          row("登录态字段", stateKeys.length > 0 ? stateKeys.join(", ") : "-"),
          row("宿主 Node", status.node),
          row("平台", status.platform)
        );
      }

      function renderProviders(payload) {
        if (payload.state !== "ok") {
          const describe = PROVIDER_STATE_TEXT[payload.state];
          const lines = [
            el("div", { className: "qd-state" }, [describe ? describe() : `未知状态：${payload.state}`])
          ];
          if (payload.error) lines.push(el("div", { className: "qd-err" }, [shorten(payload.error)]));
          providersCard.replaceChildren(el("h3", {}, ["模型提供方"]), ...lines);
          return;
        }

        const head = el("tr", {}, [
          el("th", {}, ["模型"]),
          el("th", {}, ["类型"]),
          el("th", {}, ["接口"]),
          el("th", {}, ["API Key"])
        ]);
        const table = el("table", { className: "qd-table" }, [head]);
        for (const item of payload.list) {
          table.append(
            el("tr", {}, [
              el("td", {}, [shorten(item.model)]),
              el("td", {}, [shorten(item.type)]),
              el("td", { className: "qd-mono" }, [shorten(item.baseUrl)]),
              el("td", { className: "qd-mono" }, [shorten(item.apiKey)])
            ])
          );
        }

        const children = [el("h3", {}, [`模型提供方 · ${payload.count}`])];
        if (payload.count === 0) {
          children.push(el("div", { className: "qd-state" }, ["settings.json 中确实没有配置任何 provider"]));
        } else {
          children.push(table);
        }
        if (payload.skipped > 0) {
          children.push(el("div", { className: "qd-state" }, [`已跳过 ${payload.skipped} 条结构非法的记录`]));
        }
        providersCard.replaceChildren(...children);
      }

      async function call(method) {
        const result = await context.api.node.callService(SERVICE, method, {});
        if (!result || result.ok === false) {
          const detail = result && result.error ? result.error : "qoderdaddy_unavailable";
          throw new Error(`${method}: ${detail}`);
        }
        if (!result.data || typeof result.data !== "object") {
          throw new Error(`${method}: 返回数据为空或类型异常`);
        }
        return result.data;
      }

      async function refresh() {
        // 递增序号：连点刷新时，迟到的旧响应必须被丢弃，否则会用陈旧数据覆盖新数据。
        const seq = ++refreshSeq;
        refreshBtn.disabled = true;
        errorLine.textContent = "";
        try {
          const status = await call("status");
          if (disposed || seq !== refreshSeq) return;
          latestStatus = status;

          const auth = await call("authState");
          if (disposed || seq !== refreshSeq) return;
          latestAuth = auth;

          renderStatus(status, auth);
          renderDiagnostics(status, auth);

          const providers = await call("providers");
          if (disposed || seq !== refreshSeq) return;
          renderProviders(providers);
        } catch (error) {
          if (!disposed && seq === refreshSeq) {
            errorLine.textContent = shorten(error && error.message ? error.message : error);
          }
        } finally {
          if (!disposed && seq === refreshSeq) refreshBtn.disabled = false;
        }
      }

      refreshBtn.addEventListener("click", () => refresh());
      diagnosticsBtn.addEventListener("click", () => {
        diagnosticsVisible = !diagnosticsVisible;
        diagnosticsCard.hidden = !diagnosticsVisible;
        diagnosticsBtn.textContent = diagnosticsVisible ? "隐藏诊断信息" : "诊断信息";
        if (latestStatus) renderDiagnostics(latestStatus, latestAuth);
      });

      refresh();

      const instance = {
        dispose() {
          disposed = true;
          themeObserver.disconnect();
          style.remove();
          root.remove();
          // root 已随 DOM 移除，这里再显式清一次，避免调用方保留了 root 引用时留下状态
          delete root.dataset.theme;
          mountedInstances.delete(container);
        }
      };
      mountedInstances.set(container, instance);
      return instance;
    }
  });
})();
