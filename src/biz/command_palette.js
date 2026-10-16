/**
 * 全局搜索面板（Spotlight 式命令面板）
 *
 * ── 它解决什么 ──
 * 插件现在有 29 个功能，首页磁贴要滚好几屏才能找全；名字还大量是英文缩写
 * （T-4 / VVIP / PCD / CVP7），记不住就找不到。这里给一个「敲两个字就跳过去」
 * 的入口：模糊匹配功能名 / 描述 / 分组 / id / 别名关键词，回车直达。
 *
 * ── 唤起方式（四条，任一即可）──
 *   ① 首页顶部「搜索功能…」入口；
 *   ② 页面内快捷键（默认 `Ctrl/Cmd + K`，**可在「设置 → 插件偏好」里改**）、
 *      `/`（在非输入框里按下时打开）；
 *   ③ 全局快捷键（默认 `Alt+Shift+S`，同样可在插件偏好里改）—— 由 `background.js` 处理，
 *      它会**把浮层注入到当前网页**（见 `src/search_overlay.js`），只有注入不了
 *      （chrome:// 等受限页面、或当前页面本来就是插件自己）时才回退到让本面板出现；
 *   ④ 深链 `index.html?search=关键词`（静态预览与书签用）。
 *
 * ── 与首页的关系 ──
 * 条目全部来自 `biz/ui_layout.js` 的 `getSearchEntries()`（含锁定判定），
 * 加上几个「内置页面」条目（设置 / 布局配置 / 插件偏好 / Org 用量）。
 * 跳转派发 `nforce:goto` 事件交给 `app.js` 的 `gotoSection()` —— **不自己判连接、
 * 不自己判白名单**：那条路已连接时等价于 `showSection()`（门禁仍由它说了算），
 * 未连接时会先自动连一次 Salesforce 再跳。
 *
 * ── 三个踩过就必须记住的点 ──
 *   ① 结果行的 HTML 由 `common/cmdk_view.js` 产出，**里面直接是内联 SVG**。
 *      这是刻意的：注入到网页里的浮层是内容脚本、拿不到 `icons.js`，
 *      若渲染 `<i class="fas fa-*">` 等着 `replaceIcons()` 去替换，在那边永远是空白方块。
 *      顺带也免掉了"每次重渲染后必须再调一次 replaceIcons()"这个隐形约定。
 *   ② 键盘处理注册在 `document` 的**捕获阶段** —— 打开面板时 `Esc` 必须比
 *      `biz/ui.js` 里那条「Esc 返回首页」先拿到事件，否则按 Esc 会同时关面板又退首页。
 *   ③ 搜索框里的中文输入法组合期间不要重渲染列表（会打断 IME 候选框）。
 */
import { createLogger } from "../common/logger.js";

const log = createLogger("CMDK");
import { $, on } from "../common/dom.js";
import { renderList, shellHtml } from "../common/cmdk_view.js";
import { matchesAccelerator } from "../common/shortcut.js";
import { getPref, PREF_KEYS } from "../common/prefs.js";
import { getSearchEntries } from "./ui_layout.js";
import { goHome } from "./ui.js";
import {
  UI_MESSAGE,
  UI_STORAGE,
  SEARCH_TOKEN_TTL_MS
} from "../common/ui_events.js";

/* ------------------------------------------------------------------ *
 * 模块状态
 * ------------------------------------------------------------------ */

let bound = false;
let opened = false;
let overlay = null;
let inputEl = null;
let listEl = null;
let countEl = null;

/** 全量条目（每次打开面板时重建，这样布局改了 / 连上会话解锁了都能立刻反映） */
let entries = [];
/** 当前命中列表（`renderList()` 返回的 rows，点击/方向键按它的下标取值） */
let hits = [];
let activeIndex = 0;
/** 输入法组合中：组合期间不重渲染结果列表 */
let composing = false;

/* ------------------------------------------------------------------ *
 * 条目与字段
 * ------------------------------------------------------------------ */

/**
 * 全量条目（每次打开面板时重建，这样布局改了 / 连上会话解锁了都能立刻反映）。
 * 来源见 `biz/ui_layout.js` 的 `getSearchEntries()` —— 磁贴 + 内置页面条目，
 * 与注入到网页的浮层用的是**同一个构建函数**（`common/command_index.js`）。
 */
function buildEntries() {
  return getSearchEntries();
}

/* ------------------------------------------------------------------ *
 * 渲染（结果列表的 HTML 由 common/cmdk_view.js 产出，两处入口共用）
 * ------------------------------------------------------------------ */

function renderResults() {
  if (!overlay || !listEl) return;
  const query = inputEl ? inputEl.value : "";

  // 空查询只出常用功能、有输入就搜全量、命中高亮、无常用时的回落与提示 ——
  // 这些策略全在 cmdk_view 里，网页浮层走的是同一个函数（见 common/cmdk_view.js）。
  const view = renderList({ query, entries, activeIndex });
  hits = view.rows;
  activeIndex = hits.length ? Math.min(activeIndex, hits.length - 1) : 0;
  listEl.innerHTML = view.html;

  if (countEl) {
    // 计数刻意分成两种文案：只出常用时说明"还有多少没显示"，否则用户会以为
    // 插件只剩下 4 个功能（这正是这次改动最容易被误解的地方）。
    countEl.textContent =
      view.scope === "favorites"
        ? `常用 ${view.count} / 全部 ${view.total}`
        : `${view.count} / ${view.total}`;
  }
  if (inputEl) {
    inputEl.setAttribute(
      "aria-activedescendant",
      hits.length ? `cmdk-item-${activeIndex}` : ""
    );
    inputEl.setAttribute("aria-expanded", "true");
  }

  // 给自动化验证与排查用（对用户无副作用）：把面板状态挂到 DOM 上
  overlay.dataset.state = "open";
  overlay.dataset.query = query;
  overlay.dataset.scope = view.scope;
  overlay.dataset.entries = String(view.total);
  overlay.dataset.favorites = String(view.favorites);
  overlay.dataset.hits = String(view.count);
  overlay.dataset.firstLabel = view.firstLabel;
  overlay.dataset.firstLocked = String(view.firstLocked);
  overlay.dataset.activeLabel = view.activeLabel;
  overlay.dataset.lockedCount = String(view.lockedCount);

  scrollActiveIntoView();
}

function scrollActiveIntoView() {
  const el = listEl && listEl.querySelector(".cmdk-item.is-active");
  if (el && typeof el.scrollIntoView === "function") {
    el.scrollIntoView({ block: "nearest" });
  }
}

/** 只切换高亮，不整块重渲染（重渲染会打断输入法组合状态） */
function setActive(index) {
  if (!hits.length) return;
  activeIndex = Math.max(0, Math.min(index, hits.length - 1));
  if (listEl) {
    Array.from(listEl.querySelectorAll(".cmdk-item")).forEach((el, i) => {
      const active = i === activeIndex;
      el.classList.toggle("is-active", active);
      el.setAttribute("aria-selected", active ? "true" : "false");
    });
  }
  if (inputEl) inputEl.setAttribute("aria-activedescendant", `cmdk-item-${activeIndex}`);
  if (overlay) {
    overlay.dataset.activeLabel = hits[activeIndex] ? hits[activeIndex].item.label : "";
  }
  scrollActiveIntoView();
}

function moveActive(delta) {
  if (!hits.length) return;
  const next = (activeIndex + delta + hits.length) % hits.length;
  setActive(next);
}

/* ------------------------------------------------------------------ *
 * 打开 / 关闭
 * ------------------------------------------------------------------ */

function openPalette(prefill = "") {
  if (!overlay) return;
  opened = true;
  overlay.classList.add("is-open");
  entries = buildEntries();
  activeIndex = 0;
  if (inputEl) {
    inputEl.value = prefill;
    inputEl.setAttribute("aria-expanded", "true");
  }
  renderResults();
  if (inputEl) {
    inputEl.focus();
    // 深链（?search=xxx）带进来的关键词直接选中，接着敲字即可替换
    if (prefill && typeof inputEl.select === "function") inputEl.select();
  }
  log.debug(`搜索面板已打开（条目 ${entries.length} 个${prefill ? `，预填「${prefill}」` : ""}）`);
}

function closePalette() {
  if (!overlay || !opened) return;
  opened = false;
  overlay.classList.remove("is-open");
  overlay.dataset.state = "closed";
  overlay.dataset.query = "";
  if (inputEl) {
    inputEl.value = "";
    inputEl.setAttribute("aria-expanded", "false");
    // 焦点不能留在被藏起来的输入框上：否则 Esc 之后按 Esc 什么都没有，
    // 而且读屏软件会把焦点读在一个不可见元素上。
    inputEl.blur();
  }
}

/** 执行当前高亮的条目 */
function runActive() {
  const hit = hits[activeIndex];
  if (!hit) return;
  const entry = hit.item;
  closePalette();

  if (entry.action === "home") {
    goHome();
    return;
  }
  if (!entry.step) return;

  // 跳转一律交给 app.js 的 `nforce:goto`：已连接时它等价于 showSection（连接门禁与
  // 白名单判定仍由 showSection 说了算）；**未连接时它会先自动连一次再跳**
  // —— 用户要求"点了就自动连接 Salesforce"，不再是"提示 + 弹回连接设置"。
  //
  // `orderValue` 是给 section-30（Order 历史）的参数：搜索框里输入单号时，
  // 这一条会带着值过去，进去就自动查（见 common/cmdk_view.js 的 orderLookupRow）。
  window.dispatchEvent(
    new CustomEvent("nforce:goto", {
      detail: { step: entry.step, orderValue: entry.orderValue, source: "搜索面板" }
    })
  );
}

/* ------------------------------------------------------------------ *
 * 事件
 * ------------------------------------------------------------------ */

function isTypingTarget(el) {
  if (!el || !el.tagName) return false;
  const tag = el.tagName.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable === true;
}

/**
 * 面板内那条快捷键是否命中。
 *
 * 值来自偏好（「设置 → 插件偏好 → 搜索快捷键」，默认 `Mod+K` = macOS 的 ⌘K / 其它平台的 Ctrl+K），
 * **每次按键现读**：改完立即生效，不需要重开页面。
 * 判定交给 `common/shortcut.js` —— 四个修饰键必须精确一致（多按一个 Shift 就不该触发，
 * 否则用户想打大写的 K 时面板会跳出来）。
 */
function isToggleShortcut(e) {
  return matchesAccelerator(e, getPref(PREF_KEYS.searchShortcut));
}

function onKeydown(e) {
  if (opened) {
    // 输入法组合期间一律放行：敲中文时按回车/空格是"确认候选词"，
    // 不拦的话回车会被当成"打开当前高亮的条目"（Esc 在 IME 里也有含义）。
    // isComposing 与自维护的 composing 都要判：前者在部分浏览器/输入法下不置位。
    if (e.isComposing || composing) return;

    switch (e.key) {
      case "Escape":
        e.preventDefault();
        e.stopPropagation();
        closePalette();
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
        setActive(hits.length - 1);
        return;
      case "Enter":
        e.preventDefault();
        runActive();
        return;
      case "Tab":
        // 焦点必须留在输入框里，否则方向键就失去作用目标了
        e.preventDefault();
        return;
      default:
        return;
    }
  }

  if (isToggleShortcut(e)) {
    e.preventDefault();
    openPalette();
    return;
  }
  // `/` 唤起：只在没有焦点在输入控件上时生效，否则用户没法在表单里打斜杠
  if (e.key === "/" && !isTypingTarget(e.target)) {
    e.preventDefault();
    openPalette();
  }
}

function bindDom() {
  on("search-nav-btn", "click", () => {
    if (opened) closePalette();
    else openPalette();
  });

  // 点击遮罩关闭。用 mousedown（而不是 click）：从面板里按下、拖到面板外松开时，
  // click 会落在共同祖先上，看起来像"点了遮罩"而被误关。
  if (overlay) {
    overlay.addEventListener("mousedown", (e) => {
      if (e.target === overlay) closePalette();
    });
  }

  if (inputEl) {
    inputEl.addEventListener("input", () => {
      if (composing) return;
      activeIndex = 0;
      renderResults();
    });
    inputEl.addEventListener("compositionstart", () => {
      composing = true;
    });
    inputEl.addEventListener("compositionend", () => {
      composing = false;
      activeIndex = 0;
      renderResults();
    });
  }

  if (listEl) {
    // 鼠标点击 / 悬停都走同一份 data-index，不额外维护第二套索引
    listEl.addEventListener("click", (e) => {
      const item = e.target instanceof Element ? e.target.closest(".cmdk-item") : null;
      if (!item) return;
      const index = Number(item.getAttribute("data-index"));
      if (!Number.isInteger(index) || index < 0 || index >= hits.length) return;
      activeIndex = index;
      runActive();
    });
    listEl.addEventListener("mousemove", (e) => {
      const item = e.target instanceof Element ? e.target.closest(".cmdk-item") : null;
      if (!item) return;
      const index = Number(item.getAttribute("data-index"));
      if (Number.isInteger(index) && index !== activeIndex) setActive(index);
    });
  }

  // 捕获阶段：必须比 biz/ui.js 的「Esc 返回首页」先拿到事件
  document.addEventListener("keydown", onKeydown, true);
}

/* ------------------------------------------------------------------ *
 * 来自全局快捷键的唤起
 * ------------------------------------------------------------------ */

/**
 * SW 直接发消息让我们打开面板（页面已经在跑的情况）。
 * 只有"用户正看着的这个页面"响应：后台标签页也收到广播，但不该跳出来。
 */
function registerGlobalOpen() {
  try {
    chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
      if (!msg || msg.type !== UI_MESSAGE.OPEN_SEARCH) return undefined;
      if (document.visibilityState !== "visible") {
        sendResponse({ ok: false, reason: "hidden" });
        return undefined;
      }
      openPalette();
      sendResponse({ ok: true });
      return undefined;
    });
  } catch (e) {
    log.warn("注册全局搜索消息监听失败（全局快捷键唤起将不可用）:", e);
  }
}

/**
 * SW 在页面还没起来时留下的 token（按快捷键 → 打开侧边栏 → 本页刚加载完）。
 * 任何宿主都消费（token 只会在"没有任何可见页面接单"时才被写下来，
 * 此时 SW 会打开侧边栏；消费它的就是那个刚加载的页面）。
 */
async function consumePendingOpen() {
  if (!chrome.storage || !chrome.storage.session) return;
  try {
    const stored = await chrome.storage.session.get([UI_STORAGE.OPEN_SEARCH_TOKEN]);
    const at = Number(stored && stored[UI_STORAGE.OPEN_SEARCH_TOKEN]);
    if (!at) return;
    await chrome.storage.session.remove([UI_STORAGE.OPEN_SEARCH_TOKEN]);
    if (Date.now() - at > SEARCH_TOKEN_TTL_MS) {
      log.debug("全局搜索请求已过期，忽略");
      return;
    }
    openPalette();
  } catch (e) {
    log.debug("读取全局搜索请求失败:", e);
  }
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

/**
 * 初始化（幂等）。由 `app.js` 的 `initApp()` 在**布局加载完成之后**调用。
 *
 * 不再需要宿主参数：以前传宿主是为了让贴边浮窗（已移除）不响应全局快捷键的广播，
 * 那条分支随浮窗一起删掉了 —— 现在"是不是用户正看着的页面"由
 * `document.visibilityState` 判定。
 */
export function initCommandPalette() {
  overlay = $("cmdk-overlay");

  if (!overlay) {
    log.error("未找到 #cmdk-overlay，全局搜索不可用（检查 index.html）");
    return;
  }

  // 骨架由共用模板渲染（与注入到网页的浮层用同一份，见 common/cmdk_view.js）
  if (!overlay.querySelector(".cmdk-panel")) overlay.innerHTML = shellHtml();
  inputEl = $("cmdk-input");
  listEl = $("cmdk-list");
  countEl = $("cmdk-count");

  if (!inputEl || !listEl) {
    log.error("搜索面板的 DOM 不完整，全局搜索不可用（shellHtml 的 id 与 initCommandPalette 对不上了）");
    return;
  }

  if (!bound) {
    bound = true;
    bindDom();
    registerGlobalOpen();
    log.info("全局搜索已就绪（Ctrl/Cmd+K 唤起）");
  }

  // `?search=xxx`：静态预览与深链用（与 app.js 的 `?host=` 同一类参数）。
  // 带这个参数打开页面时直接展开面板并预填关键词。
  let prefill = "";
  try {
    prefill = new URLSearchParams(location.search).get("search") || "";
  } catch (e) {
    prefill = "";
  }
  if (prefill) openPalette(prefill);

  consumePendingOpen();
}
