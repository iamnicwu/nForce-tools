/**
 * 贴边浮窗 —— 内容脚本（content script）。
 *
 * 为什么需要它：浏览器侧边栏（chrome.sidePanel）**没法做到「鼠标靠边就出现」**。
 * `sidePanel.open()` 官方要求必须由用户动作触发（点击 / 快捷键 / 右键菜单 / 手势），
 * 而 `mousemove` 不算用户动作；`setLayout` 之类控制位置的接口也不存在。
 * 所以真正的 hover 体验只能在**页面里**实现：内容脚本贴一条感应边，
 * 指针靠过去就把一个内嵌扩展页的 iframe 滑出来。
 *
 * ── 三条硬约束（改这个文件前必读）──
 * 1. **必须是经典脚本**：`content_scripts` 不是 module，文件里不能出现 import/export。
 *    而 `src/` 目录本身也要能直接「加载已解压的扩展程序」运行，所以它零依赖 ——
 *    需要配置就问 service worker（`dock:get-config`），要记日志也转给 service worker
 *    （`dock:log`），这样 `tools/check-ui.mjs` 的「禁止裸 console.*」守卫不必开口子。
 * 2. **不碰宿主页面**：所有节点都挂在 shadow root 里，页面 CSS 进不来、我们的样式也出不去；
 *    只在 `documentElement` 上挂一个宿主节点。
 * 3. **iframe 惰性创建**：只有第一次真正滑出时才创建并加载 `index.html`。
 *    在客户 org 的每个页面上都预加载一整个应用是不可接受的。
 *
 * ── 为什么 iframe 能在 Salesforce Lightning 上工作 ──
 * Lightning 的 CSP 默认 `frame-src 'self'`，看起来会拦掉 `chrome-extension://` 的 frame。
 * 实测（Chrome 153，带同样 CSP 头的页面 + 真实加载扩展）：**不拦**，
 * 浏览器对扩展源有豁免。实验脚本与结论见 `.workbuddy/skills/nforce-ui-verify/SKILL.md`。
 */
(() => {
  "use strict";

  const HOST_ID = "__nforce_dock__";
  const DOCK_WIDTH = 380;
  /** 感应边宽度（px）。够窄才不会干扰正常点击，够宽才好命中。 */
  const STRIP_WIDTH = 6;

  // 只注入顶层文档：Lightning 的 Visualforce / 组件里有大量子 iframe，
  // all_frames:false 已经挡了一层，这里再兜一层（比如页面自己嵌套同源 iframe）。
  if (window.top !== window) return;
  if (document.getElementById(HOST_ID)) return; // 幂等

  /* ---------------------------------------------------------------- *
   * 与 service worker 的通信
   * ---------------------------------------------------------------- */

  /** 记日志：转给 SW，由它走统一的 logger（内容脚本里拿不到 logger.js）。 */
  function logTo(level, message) {
    try {
      chrome.runtime.sendMessage({ type: "dock:log", level, message: String(message) });
    } catch (e) {
      /* 扩展刚更新/卸载时上下文会失效，静默即可 —— 不能因为记日志把页面搞崩 */
    }
  }

  function requestConfig() {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage({ type: "dock:get-config" }, (res) => {
          // 读 lastError 抑制「Unchecked runtime.lastError」噪音
          if (chrome.runtime.lastError) {
            resolve(null);
            return;
          }
          resolve(res && res.ok ? res.config : null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  /* ---------------------------------------------------------------- *
   * 界面
   * ---------------------------------------------------------------- */

  let host = null;
  let strip = null;
  let panel = null;
  let frame = null;
  let frameLoaded = false;
  let closeTimer = null;

  function build(config) {
    host = document.createElement("div");
    host.id = HOST_ID;
    // 宿主节点本身不吃事件，只有感应边与面板吃 —— 否则会在页面上盖出一个隐形遮罩
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
    const root = host.attachShadow({ mode: "open" });

    const side = config.side === "left" ? "left" : "right";
    const offscreen = side === "left" ? "translateX(-100%)" : "translateX(100%)";

    root.innerHTML = `
      <style>
        :host { all: initial; }
        .wrap { position: fixed; inset: 0; pointer-events: none;
                font: 13px/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        .strip { position: absolute; top: 0; bottom: 0; width: ${STRIP_WIDTH}px;
                 pointer-events: auto; cursor: pointer; background: transparent;
                 transition: background 160ms ease; }
        .strip:hover { background: rgba(24, 144, 255, 0.55); }
        .strip.right { right: 0; }
        .strip.left { left: 0; }
        .panel { position: absolute; top: 0; bottom: 0; width: ${DOCK_WIDTH}px;
                 pointer-events: none; background: #fff;
                 box-shadow: 0 0 20px rgba(0, 0, 0, 0.18);
                 transition: transform 180ms ease; }
        .panel.right { right: 0; transform: ${offscreen}; }
        .panel.left { left: 0; transform: ${offscreen}; }
        .panel.open { transform: translateX(0); pointer-events: auto; }
        iframe { display: block; width: 100%; height: 100%; border: 0; }
      </style>
      <div class="wrap">
        <div class="strip ${side}" part="strip" role="button" tabindex="-1"
             aria-label="打开 nForce Tools"></div>
        <div class="panel ${side}"></div>
      </div>
    `;

    strip = root.querySelector(".strip");
    panel = root.querySelector(".panel");

    strip.addEventListener("mouseenter", open);
    strip.addEventListener("click", () => (isOpen() ? close() : open()));
    panel.addEventListener("mouseenter", cancelClose);
    // 指针离开面板 → 延迟收回。用 mouseleave 而不是 mouseout：
    // mouseout 会在面板内部元素之间移动时反复触发。
    panel.addEventListener("mouseleave", scheduleClose);

    (document.documentElement || document.body).appendChild(host);
    logTo("debug", `贴边浮窗已就绪（${side} 侧，收回延迟 ${config.hideDelay}ms）`);
  }

  function isOpen() {
    return !!panel && panel.classList.contains("open");
  }

  function ensureFrame() {
    if (frameLoaded || !panel) return;
    frame = document.createElement("iframe");
    // ?dock=1 让 app.js 把宿主判成「贴边浮窗」：这里的 tab 上下文会让
    // chrome.tabs.getCurrent() 返回宿主标签页，不用参数就会被误判成普通标签页。
    frame.src = chrome.runtime.getURL("index.html?dock=1");
    frame.setAttribute("title", "nForce Tools");
    panel.appendChild(frame);
    frameLoaded = true;
    logTo("debug", "已按需加载浮窗内的应用");
  }

  function open() {
    cancelClose();
    ensureFrame();
    panel.classList.add("open");
  }

  function close() {
    cancelClose();
    if (panel) panel.classList.remove("open");
  }

  function cancelClose() {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  }

  function scheduleClose() {
    cancelClose();
    const delay = currentHideDelay;
    if (delay <= 0) {
      close();
      return;
    }
    closeTimer = setTimeout(close, delay);
  }

  function destroy() {
    cancelClose();
    if (host && host.parentNode) host.parentNode.removeChild(host);
    host = strip = panel = frame = null;
    frameLoaded = false;
  }

  /* ---------------------------------------------------------------- *
   * 生命周期
   * ---------------------------------------------------------------- */

  /* 运行期状态。**只在这里声明一次** —— 上面 build/destroy 那段曾经也声明过一遍，
     同名 `let` 重复声明是 SyntaxError，会让整个内容脚本一行都不执行（且只在
     真实的 Salesforce 页面上才暴露，本地预览永远正常）。 */
  /** 当前生效的收回延迟（ms），由 service worker 推来的配置维护 */
  let currentHideDelay = 600;
  /** 当前贴的边（"left" | "right"） */
  let currentSide = "right";
  /** 是否已经建好界面。用来区分「第一次应用配置」与「运行中改配置」。 */
  let applied = false;

  function apply(config) {
    if (!config) return;
    currentHideDelay = Number(config.hideDelay);

    if (!config.enabled) {
      if (applied) {
        destroy();
        applied = false;
        logTo("info", "贴边浮窗已关闭");
      }
      return;
    }

    // 运行中改配置：左右侧变了要重建（重建代价很小），其余情况什么都不用做 ——
    // 收回延迟每次 scheduleClose 都会重新读 currentHideDelay，天然即时生效。
    if (applied) {
      if (config.side !== currentSide) {
        currentSide = config.side === "left" ? "left" : "right";
        destroy();
        applied = false;
        build({ side: currentSide, hideDelay: currentHideDelay });
        applied = true;
      }
      return;
    }

    currentSide = config.side === "left" ? "left" : "right";
    build({ side: currentSide, hideDelay: currentHideDelay });
    applied = true;
    logTo("info", "贴边浮窗已启用（鼠标移到窗口边缘即滑出）");
  }

  // service worker 推来的配置变更（设置页改了立即生效，无需刷新页面）
  try {
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "dock:config") apply(msg.config);
    });
  } catch (e) {
    /* 忽略：上下文失效 */
  }

  requestConfig().then(apply);
})();
