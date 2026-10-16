/**
 * 网页内的搜索浮层 —— 在任何网页上按 `Alt+Shift+S` 时，由 service worker 用
 * `chrome.scripting.executeScript` 注入到当前标签页的那一层界面。
 *
 * ── 为什么是「经典脚本 + 零依赖」──
 * `executeScript({ files })` 注入的文件按**经典脚本**求值，里面不能有 import/export
 * （会在注入时直接 SyntaxError，而报错只出现在 SW 的日志里，页面上毫无痕迹）。
 * 所以本文件不 import 任何模块、也不打包，只逐字复制进 dist
 * （`tools/build-plan.mjs` 的 COPY_RULES 里有它一条；check-ui 的 Q 组会核对这件事）。
 *
 * ── 与 SW 的分工 ──
 *   · 本文件只做 DOM 与键盘：开/关、输入、上下键、高亮、遮罩、回执。
 *   · 模糊匹配（common/fuzzy.js）、条目构建（common/command_index.js）、
 *     结果渲染（common/cmdk_view.js）**全在 SW 里**（那些是 ESM 模块），
 *     本文件通过消息拿现成的 HTML。这样两处入口（插件面板 / 网页浮层）共用同一份实现，
 *     代价是每次按键一次消息往返（同进程，1~5ms 量级）。
 *   · 样式同样是 SW 把 `lib/css/cmdk.css` 的文本发下来的 —— 浮层跑在 shadow DOM 里，
 *     拿不到宿主页面的任何令牌，也没有别的办法共享那份 CSS。
 *
 * ── 三条不能忘的约束 ──
 *   ① 宿主节点必须 `pointer-events: none`（只在打开时临时打开），否则会在客户页面上
 *      盖出一层隐形遮罩 —— 用户点哪儿都没反应，且完全看不出原因。
 *   ② 界面全在 **Shadow DOM** 里：不泄漏样式、也不被宿主页面的 CSS 干扰。
 *   ③ `composing` / `e.isComposing` 期间放行一切按键：敲中文时回车是"确认候选词"，
 *      拦下来就变成"打开当前高亮的条目"了。
 */
(function () {
  "use strict";

  var HOST_ID = "nf-cmdk-host";
  var Z_MAX = "2147483647";
  var MSG = {
    OPEN: "search:open",
    QUERY: "search:query",
    SELECT: "search:select",
    LOG: "search:log"
  };

  // 同一个页面被反复注入（每次都按快捷键）：复用已有浮层，只做"再按一次"的开关。
  // 不加这道判断的话，每按一次就叠一层 shadow host 在 <body> 上。
  if (window.__nfSearchOverlay) {
    window.__nfSearchOverlay.toggle();
    return;
  }

  var host = null;
  var shadow = null;
  var styleEl = null;
  var listEl = null;
  var inputEl = null;
  var countEl = null;
  var opened = false;
  var composing = false;
  var rows = 0;
  var activeIndex = 0;
  var seq = 0;

  /** 日志一律转给 SW（本文件里不许出现裸 console：日志规范由 common/logger.js 统一） */
  function log(level, message) {
    try {
      chrome.runtime.sendMessage({ type: MSG.LOG, level: level, message: message });
    } catch (e) {
      /* 扩展上下文已失效（被重载/卸载）：无处可报，直接丢掉 */
    }
  }

  /** 给 SW 发消息并等回执；拿到 null 表示这条路走不通（上下文失效 / SW 出错） */
  function send(message) {
    return new Promise(function (resolve) {
      try {
        chrome.runtime.sendMessage(message, function (res) {
          if (chrome.runtime.lastError) {
            log("warn", "消息失败：" + chrome.runtime.lastError.message);
            resolve(null);
            return;
          }
          resolve(res || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function ensureHost() {
    if (host && host.isConnected && shadow) return true;
    try {
      host = document.createElement("div");
      host.id = HOST_ID;
      // 只做定位与层级；**不吃事件**（打开时再临时打开）—— 见文件头约束①
      host.style.cssText =
        "position:fixed;inset:0;z-index:" + Z_MAX + ";pointer-events:none;";
      (document.body || document.documentElement).appendChild(host);
      shadow = host.attachShadow({ mode: "open" });
      styleEl = document.createElement("style");
      shadow.appendChild(styleEl);
      return true;
    } catch (e) {
      log("error", "无法创建浮层宿主：" + (e && e.message ? e.message : e));
      return false;
    }
  }

  function close() {
    if (!opened || !shadow) return;
    opened = false;
    var root = shadow.getElementById("cmdk-overlay");
    if (root) {
      root.classList.remove("is-open");
      root.dataset.state = "closed";
    }
    if (host) host.style.pointerEvents = "none";
    if (inputEl) {
      inputEl.value = "";
      inputEl.setAttribute("aria-expanded", "false");
      inputEl.blur();
    }
    window.removeEventListener("keydown", onKeydown, true);
    log("debug", "搜索浮层已关闭");
  }

  function open() {
    if (!ensureHost()) return;
    if (!opened) {
      send({ type: MSG.OPEN }).then(function (res) {
        if (!res || !res.ok) {
          log("warn", "打开搜索浮层失败：" + (res && res.error ? res.error : "无响应"));
          return;
        }
        // 首次打开时把 CSS 与骨架一起装进去（之后每次打开复用同一份 DOM）
        if (!shadow.getElementById("cmdk-overlay")) {
          styleEl.textContent = res.css || "";
          var root = document.createElement("div");
          root.className = "cmdk";
          root.id = "cmdk-overlay";
          root.dataset.state = "closed";
          root.innerHTML = res.html || "";
          shadow.appendChild(root);
          listEl = shadow.getElementById("cmdk-list");
          inputEl = shadow.getElementById("cmdk-input");
          countEl = shadow.getElementById("cmdk-count");
          bindShadowEvents(root);
        }
        show(res);
      });
      return;
    }
    // 已经开着再按一次 = 收起（与插件面板里 Ctrl+K 的行为一致）
    close();
  }

  function show(payload) {
    var root = shadow.getElementById("cmdk-overlay");
    if (!root) return;
    opened = true;
    root.classList.add("is-open");
    root.dataset.state = "open";
    host.style.pointerEvents = "auto";
    applyList(payload);
    if (inputEl) {
      inputEl.focus();
      if (typeof inputEl.select === "function") inputEl.select();
    }
    window.addEventListener("keydown", onKeydown, true);
    log("info", "网页内搜索浮层已打开");
  }

  /** 用 SW 下发的 HTML 刷新结果区，并同步本地计数与高亮下标 */
  function applyList(payload) {
    if (!payload || !listEl) return;
    rows = Number(payload.rows) || 0;
    activeIndex = 0;
    listEl.innerHTML = payload.listHtml || "";
    if (countEl) countEl.textContent = payload.countText || "";
    if (inputEl) {
      inputEl.setAttribute("aria-activedescendant", rows ? "cmdk-item-0" : "");
      inputEl.setAttribute("aria-expanded", "true");
    }
    scrollActive();
  }

  function scrollActive() {
    if (!listEl) return;
    var el = listEl.querySelector(".cmdk-item.is-active");
    if (el && typeof el.scrollIntoView === "function") el.scrollIntoView({ block: "nearest" });
  }

  function setActive(index) {
    if (!rows || !listEl) return;
    activeIndex = Math.max(0, Math.min(index, rows - 1));
    var items = listEl.querySelectorAll(".cmdk-item");
    for (var i = 0; i < items.length; i++) {
      var active = i === activeIndex;
      items[i].classList.toggle("is-active", active);
      items[i].setAttribute("aria-selected", active ? "true" : "false");
    }
    if (inputEl) inputEl.setAttribute("aria-activedescendant", "cmdk-item-" + activeIndex);
    scrollActive();
  }

  function moveActive(delta) {
    if (!rows) return;
    setActive((activeIndex + delta + rows) % rows);
  }

  /**
   * 重新查询。
   * `seq` 是必须的：每次按键都发一条消息，而回复顺序没有保证 ——
   * 慢了半拍的旧回复会把新结果盖回去（表现是"打字时结果乱跳"）。
   */
  function requery() {
    if (!inputEl) return;
    seq += 1;
    var mine = seq;
    var q = inputEl.value;
    send({ type: MSG.QUERY, q: q, seq: mine }).then(function (res) {
      if (!res || res.seq !== mine || !opened) return;
      applyList(res);
    });
  }

  function select() {
    if (!rows || !inputEl) return;
    var index = activeIndex;
    var q = inputEl.value;
    close();
    // 由 SW 决定落到哪个宿主（侧边栏 / 标签页），并且未连接时先自动连一次
    send({ type: MSG.SELECT, q: q, index: index });
  }

  function bindShadowEvents(root) {
    // 点击遮罩关闭：用 mousedown，从面板里按下、拖到外面松开时不会误关
    root.addEventListener("mousedown", function (e) {
      if (e.target === root) close();
    });

    if (listEl) {
      listEl.addEventListener("click", function (e) {
        var item = e.target && e.target.closest ? e.target.closest(".cmdk-item") : null;
        if (!item) return;
        var index = Number(item.getAttribute("data-index"));
        if (!isFinite(index) || index < 0 || index >= rows) return;
        activeIndex = index;
        select();
      });
      listEl.addEventListener("mousemove", function (e) {
        var item = e.target && e.target.closest ? e.target.closest(".cmdk-item") : null;
        if (!item) return;
        var index = Number(item.getAttribute("data-index"));
        if (isFinite(index) && index !== activeIndex) setActive(index);
      });
    }

    if (inputEl) {
      inputEl.addEventListener("input", function () {
        if (composing) return;
        requery();
      });
      inputEl.addEventListener("compositionstart", function () {
        composing = true;
      });
      inputEl.addEventListener("compositionend", function () {
        composing = false;
        requery();
      });
    }
  }

  function onKeydown(e) {
    if (!opened) return;
    if (e.isComposing || composing) return;
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        close();
        return;
      case "ArrowDown":
        e.preventDefault();
        moveActive(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        moveActive(-1);
        return;
      case "Home":
        e.preventDefault();
        setActive(0);
        return;
      case "End":
        e.preventDefault();
        setActive(rows - 1);
        return;
      case "Enter":
        e.preventDefault();
        select();
        return;
      case "Tab":
        // 焦点必须留在输入框里，否则方向键失去作用目标
        e.preventDefault();
        return;
      default:
    }
  }

  window.__nfSearchOverlay = {
    toggle: function () {
      open();
    },
    close: close
  };

  open();
})();
