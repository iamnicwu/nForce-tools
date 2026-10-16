/**
 * **通用代码提示浮层**：给任意 `<textarea>` 挂一个候选浮层。
 *
 * 这一层只管"界面与交互"（防抖触发、浮层定位、键盘、插入），**不知道提示什么** ——
 * 候选从哪来由调用方传进来的 `compute` / `enrich` 决定：
 *   · `biz/apex_complete.js` → `common/apex_completions.js`（Apex 匿名代码）
 *   · `biz/soql_complete.js` → `common/soql_completions.js`（SOQL 查询）
 * 两边的纯逻辑各自单测，这一层则由渲染验证覆盖（浮层真的弹出来了、Enter 真的插进去了）。
 *
 * ── 为什么不引 Monaco / CodeMirror ──
 * 需求要的是**提示**而不是语法高亮，而候选词表**无论如何都得自己写**（Apex 没有可用的 JS
 * 语言服务）。换编辑器只会多背几百 KB 与一套要适配设计令牌的皮肤。所以保持原生 textarea 不动。
 *
 * ── 三个必须记住的实现点（都踩过）──
 *   ① 浮层挂 `body`：textarea 的祖先链里有 `overflow` 容器，挂在里面会被裁掉；
 *   ② 光标坐标要用"镜子 div"量：textarea 只给字符下标、不给像素坐标，量完还要减去它自己的
 *      `scrollTop` / `scrollLeft`；
 *   ③ `input` 事件里 `event.data` 是"刚打进去的那个字符" —— 判断要不要弹提示靠它，
 *      所以**直接赋值 `el.value` 不会触发提示**（写验证夹具时务必逐字派发 InputEvent）。
 */

/** 输入后多久弹（防抖）：太快会在连续打字时反复重排浮层 */
const TRIGGER_DELAY_MS = 120;

/**
 * @param {HTMLTextAreaElement} textarea
 * @param {{
 *   popupId: string,
 *   compute: (text: string, caret: number) => {ctx: object, items: Array},
 *   applyCompletion: (text: string, ctx: object, entry: object) => {text: string, caret: number},
 *   enrich?: (ctx: object) => Promise<boolean>,   // 按需补数据；返回 true 表示有新数据 → 刷新浮层
 *   log?: (msg: string, ...rest: any[]) => void
 * }} options
 */
export function attachCodeHint(textarea, options) {
  const { popupId, compute, enrich, log, applyCompletion } = options;
  let popup = null;
  let items = [];
  let activeIndex = 0;
  let ctx = null;
  let timer = null;
  /** 上次"尝试弹提示"的时间：org 数据回来时用它判断还该不该补弹一次 */
  let lastShowAttempt = 0;
  /** 接受候选后短暂静默 —— 否则紧接着的 input 事件会把浮层又弹回来 */
  let suppressUntil = 0;

  // 浏览器的拼写检查会在代码上画红波浪线，关掉
  textarea.setAttribute("spellcheck", "false");
  textarea.setAttribute("autocomplete", "off");
  textarea.addEventListener("input", onInput);
  // capture：Enter / Tab 要在浏览器把它们当换行 / 切焦点之前拦下来
  textarea.addEventListener("keydown", onKeyDown, true);
  textarea.addEventListener("blur", () => setTimeout(hide, 120)); // 点浮层时别先关掉
  textarea.addEventListener("scroll", hide);

  function onInput(event) {
    // 只在"刚打了一个标识符字符"之后提示；空格、括号、分号之类先收起来
    const data = event && event.data;
    if (data && !/[A-Za-z0-9_$.]/.test(data)) {
      hide();
      return;
    }
    clearTimeout(timer);
    timer = setTimeout(() => show(false), TRIGGER_DELAY_MS);
  }

  function onKeyDown(event) {
    const open = popup && !popup.classList.contains("u-hidden") && items.length > 0;

    // Ctrl+Space：手动唤出（IDE 里的老习惯）
    if (event.ctrlKey && (event.code === "Space" || event.key === " ")) {
      event.preventDefault();
      show(true);
      return;
    }
    if (!open) return;

    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        move(1);
        break;
      case "ArrowUp":
        event.preventDefault();
        move(-1);
        break;
      case "Enter":
      case "Tab":
        event.preventDefault();
        accept();
        break;
      case "Escape":
        event.preventDefault();
        hide();
        break;
      default:
        break;
    }
  }

  function show(force) {
    if (document.activeElement !== textarea) return;
    if (Date.now() < suppressUntil) return;
    lastShowAttempt = Date.now();

    const result = compute(textarea.value, textarea.selectionStart);
    ctx = result.ctx;
    items = result.items;

    // ⚠️ 补数据要在「候选为空就收起来」**之前**发起：静态词表里没有的候选
    //（例如 org 里的自定义字段 `MyField__c`）恰恰是本地表给不出来的 —— 先 return 的话
    // org 数据永远不会被拉，用户打自定义字段名时一辈子看不到提示（2026-10-17 踩到）。
    if (enrich) {
      enrich(ctx)
        .then((changed) => {
          if (changed) refreshAfterEnrich();
        })
        .catch(() => {});
    }

    if (!items.length) {
      hide();
      if (force && log) log("此处没有可提示的内容（字符串/注释里，或接收者未知）");
      return;
    }
    activeIndex = 0;
    render();
  }

  /**
   * 数据回来后的刷新。
   * 两种情形都要照顾：
   *   · 浮层开着 → 就地刷新（不重新定位，避免跳动）；
   *   · 浮层当时被关掉了（静态候选为空）→ 只要还在"刚才那次输入"的时间窗内就补弹一次。
   */
  function refreshAfterEnrich() {
    if (document.activeElement !== textarea) return;
    const open = popup && !popup.classList.contains("u-hidden");
    if (!open && Date.now() - lastShowAttempt > 3000) return;
    show(false);
  }

  function createPopup() {
    let el = document.getElementById(popupId);
    if (!el) {
      el = document.createElement("div");
      el.id = popupId;
      el.className = "apex-hint u-hidden"; // 两个输入框共用同一套样式
      document.body.appendChild(el);
    }
    return el;
  }

  function render() {
    if (!popup) popup = createPopup();
    popup.innerHTML = items
      .map(
        (entry, index) =>
          `<div class="apex-hint-item${index === activeIndex ? " is-active" : ""}" data-index="${index}">` +
          `<span class="apex-hint-label">${escapeText(entry.label)}</span>` +
          `<span class="apex-hint-detail">${escapeText(entry.detail || "")}</span>` +
          `</div>`
      )
      .join("");
    popup.classList.remove("u-hidden");
    position();
    for (const el of popup.querySelectorAll(".apex-hint-item")) {
      // mousedown + preventDefault：click 之前 textarea 会先失焦，浮层就没了
      el.addEventListener("mousedown", (e) => {
        e.preventDefault();
        activeIndex = Number(el.dataset.index) || 0;
        accept();
      });
    }
    const active = popup.querySelector(".is-active");
    if (active && typeof active.scrollIntoView === "function") {
      active.scrollIntoView({ block: "nearest" });
    }
  }

  /**
   * 把浮层放到光标正下方。
   * "镜子 div"：复制 textarea 的字体与内边距到隐藏 div，插入光标前的文本 + 一个零宽标记，
   * 量那个标记的位置 —— textarea 自己不提供光标的像素坐标。
   */
  function position() {
    if (!popup) return;
    const coords = caretCoordinates(textarea, textarea.selectionStart);
    const rect = textarea.getBoundingClientRect();
    const left = rect.left + window.scrollX + coords.left - textarea.scrollLeft;
    const top = rect.top + window.scrollY + coords.top - textarea.scrollTop + coords.height;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - popup.offsetWidth - 8;
    popup.style.left = `${Math.max(window.scrollX + 4, Math.min(left, maxLeft))}px`;
    popup.style.top = `${top}px`;
  }

  function move(delta) {
    if (!items.length) return;
    activeIndex = (activeIndex + delta + items.length) % items.length;
    render();
  }

  /** 接受当前候选：只替换"正在输入的那一段"，前后文不动 */
  function accept() {
    const entry = items[activeIndex];
    if (!entry || !ctx) return;
    const { text, caret } = applyCompletion(textarea.value, ctx, entry);
    textarea.value = text;
    textarea.selectionStart = caret;
    textarea.selectionEnd = caret;
    hide();
    suppressUntil = Date.now() + 250;
    textarea.focus();
  }

  function hide() {
    if (popup) popup.classList.add("u-hidden");
    items = [];
    activeIndex = 0;
  }

  return {
    refresh: refreshAfterEnrich,
    hide,
    /** 供调试/观测：当前浮层状态（渲染验证也能直接读 DOM，这里给日志用） */
    state: () => ({
      open: !!(popup && !popup.classList.contains("u-hidden")),
      count: items.length,
      labels: items.map((i) => i.label),
      active: items[activeIndex] ? items[activeIndex].label : ""
    })
  };
}

/** 极简转义（候选来自词表或 org 元数据，理论上安全，但拼 HTML 就一律转义） */
function escapeText(text) {
  return String(text == null ? "" : text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 量光标在 textarea 里的像素坐标（见 position 的说明） */
export function caretCoordinates(ta, pos) {
  const style = window.getComputedStyle(ta);
  const mirror = document.createElement("div");
  const props = [
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight",
    "textTransform", "whiteSpace", "wordBreak", "wordSpacing", "tabSize",
    "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth", "boxSizing"
  ];
  for (const prop of props) mirror.style[prop] = style[prop];
  mirror.style.position = "absolute";
  mirror.style.visibility = "hidden";
  mirror.style.top = "0";
  mirror.style.left = "-9999px";
  mirror.style.whiteSpace = "pre-wrap";
  mirror.style.overflowWrap = "break-word";
  mirror.style.width = `${ta.clientWidth}px`;
  mirror.textContent = ta.value.slice(0, pos);

  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const coords = {
    left: marker.offsetLeft,
    top: marker.offsetTop,
    height: marker.offsetHeight || parseFloat(style.lineHeight) || 18
  };
  document.body.removeChild(mirror);
  return coords;
}
