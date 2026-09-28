/**
 * 「插件偏好」设置卡片（section-28）的界面逻辑。
 *
 * 四组：
 *   ① Salesforce API 版本 —— 下拉选常用版本 + 文本框填自定义版本，存 chrome.storage.local
 *   ② 侧边栏位置        —— **只能读、不能设**，原因见 `detectPanelSide()` 上方注释
 *   ③ 侧边栏自动隐藏    —— 开关 + 延迟
 *   ④ 贴边浮窗          —— 开关 + 贴哪边 + 收回延迟
 *
 * 与 `common/prefs.js` 的分工：那边只管读写与跨宿主同步，这边只管 DOM。
 * 偏好值真正"生效"（改到 sf_service 的 defaultApiVersion 与已建连接上、
 * 或推给内容脚本）由 `app.js` / `background.js` 订阅 `onPrefsChanged` 统一处理，
 * 所以本模块保存后只刷新自己的展示。
 *
 * ③④ 的写路径一律走泛化的 `setPref(key, value)`：这里**不做任何值校验**，
 * 合法性由 prefs.js 的解析器负责（档位清单也只有那一份）。
 * 界面上多写一处校验，就会在改档位时漏改一处。
 */
import { createLogger } from "../common/logger.js";
import { $, on } from "../common/dom.js";
import { showNotification } from "../common/utils.js";
import { API_VERSION_MIN, API_VERSION_MAX } from "../common/api_version.js";
import {
  getPref,
  setPref,
  getApiVersion,
  setApiVersion,
  resetApiVersion,
  onPrefsChanged,
  PREF_KEYS,
  HIDE_DELAYS,
  DOCK_SIDES
} from "../common/prefs.js";

const log = createLogger("PREFS");

/** 首次进入时把 HTML 里的提示文案记下来，报错/成功提示几秒后回滚到它。 */
const HINT_RESTORE_MS = 6000;
const hintTimers = new Map();

/* ------------------------------------------------------------------ *
 * ① API 版本
 * ------------------------------------------------------------------ */

/** 常用版本下拉：从高到低（多数人是"降版本"，从最新往下找更顺手）。 */
function buildVersionOptions() {
  const select = $("api-version-select");
  if (!select) return;
  const minMajor = Number(API_VERSION_MIN.split(".")[0]);
  const maxMajor = Number(API_VERSION_MAX.split(".")[0]);
  if (!Number.isFinite(minMajor) || !Number.isFinite(maxMajor) || maxMajor < minMajor) return;

  const opts = [];
  for (let major = maxMajor; major >= minMajor; major -= 1) {
    const v = `${major}.0`;
    opts.push(`<option value="${v}">${v}</option>`);
  }
  select.innerHTML = opts.join("");
}

/** 把当前生效的版本显示到徽标、下拉与输入框。 */
function renderVersion() {
  const current = getApiVersion();

  const badge = $("api-version-current");
  if (badge) badge.textContent = `v${current}`;

  const select = $("api-version-select");
  if (select) {
    // 当前值不在下拉里就补一个选项 —— 否则 select.value 赋值会被浏览器静默忽略，
    // 界面会显示成另一个版本，而看不出任何异常。
    const exists = Array.prototype.some.call(select.options, (o) => o.value === current);
    if (!exists) {
      select.insertAdjacentHTML("afterbegin", `<option value="${current}">${current}</option>`);
    }
    select.value = current;
  }

  const custom = $("api-version-custom");
  // 用户正在输入时不要清空他打了一半的内容
  if (custom && custom !== document.activeElement) custom.value = "";
}

/**
 * 更新某一行提示并显示一段时间。
 * 每个 hint 元素各自一份计时器 —— 共用一个的话，连改两个设置会让前一行
 * 的回滚计时被后一行取消，那一行就永远停在"已保存"上了。
 * @param {string} id 提示元素的 id
 * @param {string} text
 * @param {boolean} isError
 */
function setHint(id, text, isError) {
  const el = $(id);
  if (!el) return;
  if (el.dataset.defaultHint === undefined) {
    el.dataset.defaultHint = el.textContent.trim();
  }
  el.textContent = text;
  el.classList.toggle("is-error", !!isError);

  const existing = hintTimers.get(id);
  if (existing) clearTimeout(existing);
  hintTimers.set(
    id,
    setTimeout(() => {
      el.textContent = el.dataset.defaultHint;
      el.classList.remove("is-error");
      hintTimers.delete(id);
    }, HINT_RESTORE_MS)
  );
}

/** 下拉有变化就把自定义输入清掉，否则它会把下拉的选择"盖住"。 */
function handleSelectChange() {
  const custom = $("api-version-custom");
  if (custom) custom.value = "";
}

async function handleSave() {
  const custom = $("api-version-custom");
  const select = $("api-version-select");
  const typed = custom ? custom.value.trim() : "";
  const raw = typed || (select ? select.value : "");

  const result = await setApiVersion(raw);
  if (!result.ok) {
    log.warn("保存 API 版本被拒绝:", result.error);
    setHint("api-version-hint", result.error || "保存失败", true);
    showNotification(result.error || "API 版本保存失败", "error");
    return;
  }

  renderVersion();
  setHint("api-version-hint", `已保存为 v${result.value}，立即对后续所有请求生效。`, false);
  showNotification(`API 版本已切换为 v${result.value}`, "success");
}

async function handleReset() {
  const result = await resetApiVersion();
  renderVersion();
  if (!result.ok) {
    setHint("api-version-hint", result.error || "恢复默认失败", true);
    showNotification(result.error || "恢复默认失败", "error");
    return;
  }
  setHint("api-version-hint", `已恢复默认版本 v${result.value}。`, false);
  showNotification(`已恢复默认 API 版本 v${result.value}`, "success");
}

/* ------------------------------------------------------------------ *
 * ③④ 开关 + 延迟（表驱动，加一组设置只需要往 GROUPS 里加一项）
 * ------------------------------------------------------------------ */

/** 延迟档位的中文标签。`0` 说成"立即"，比"0 毫秒"好读。 */
function delayLabel(ms) {
  return ms <= 0 ? "立即收起" : `${ms} 毫秒`;
}

/** 边侧的中文标签 */
const SIDE_LABELS = { right: "靠右侧", left: "靠左侧" };

/**
 * 一组「开关 + 若干下拉」的界面定义。
 *
 * `stateId/valueId` 是 HTML 里的元素 id；`badgeState` 由是否启用推导，
 * 用来给右侧徽标上色（data-state 属性，样式见 main.css）。
 */
const GROUPS = [
  {
    key: PREF_KEYS.panelAutoHide,
    delayKey: PREF_KEYS.panelHideDelay,
    toggleId: "panel-auto-hide-toggle",
    stateId: "panel-auto-hide-state",
    delayId: "panel-hide-delay-select",
    hintId: "panel-auto-hide-hint",
    label: "侧边栏自动隐藏"
  },
  {
    key: PREF_KEYS.dockEnabled,
    delayKey: PREF_KEYS.dockHideDelay,
    sideKey: PREF_KEYS.dockSide,
    toggleId: "dock-enable-toggle",
    stateId: "dock-state",
    delayId: "dock-hide-delay-select",
    sideId: "dock-side-select",
    hintId: "dock-hint",
    label: "贴边浮窗"
  }
];

/** 用 HIDE_DELAYS / DOCK_SIDES 渲染下拉，界面上不重复写档位清单。 */
function buildOptionLists() {
  const delayOpts = HIDE_DELAYS.map(
    (ms) => `<option value="${ms}">${delayLabel(ms)}</option>`
  ).join("");
  const sideOpts = DOCK_SIDES.map(
    (s) => `<option value="${s}">${SIDE_LABELS[s] || s}</option>`
  ).join("");

  for (const g of GROUPS) {
    const delay = $(g.delayId);
    if (delay) delay.innerHTML = delayOpts;
    if (g.sideId) {
      const side = $(g.sideId);
      if (side) side.innerHTML = sideOpts;
    }
  }
}

/** 把某组偏好的当前值刷到界面上（含"关掉时置灰延迟"的联动）。 */
function renderGroup(g) {
  const enabled = !!getPref(g.key);

  const toggle = $(g.toggleId);
  if (toggle) toggle.checked = enabled;

  const delay = $(g.delayId);
  if (delay) {
    delay.value = String(getPref(g.delayKey));
    delay.disabled = !enabled;
  }

  if (g.sideId) {
    const side = $(g.sideId);
    if (side) {
      side.value = getPref(g.sideKey);
      side.disabled = !enabled;
    }
  }

  const state = $(g.stateId);
  if (state) {
    state.dataset.state = enabled ? "on" : "off";
    state.textContent = enabled
      ? `已开启 · ${delayLabel(Number(getPref(g.delayKey)))}`
      : "已关闭";
  }
}

function renderGroups() {
  for (const g of GROUPS) renderGroup(g);
}

/** 保存一组偏好的某个键，并把 prefs.js 的校验错误显示出来。 */
async function saveGroupPref(g, key, value) {
  const result = await setPref(key, value);
  renderGroups();
  if (!result.ok) {
    log.warn(`保存「${g.label}」被拒绝:`, result.error);
    setHint(g.hintId, result.error || "保存失败", true);
    showNotification(result.error || "设置保存失败", "error");
    return;
  }
  log.info(`「${g.label}」已更新：${key}=${JSON.stringify(result.value)}`);
}

function bindGroups() {
  for (const g of GROUPS) {
    on(g.toggleId, "change", (e) => {
      saveGroupPref(g, g.key, e.target.checked === true);
    });
    on(g.delayId, "change", (e) => {
      // select 的 value 是字符串，prefs.js 会转成数字并核对档位
      saveGroupPref(g, g.delayKey, e.target.value);
    });
    if (g.sideId) {
      on(g.sideId, "change", (e) => {
        saveGroupPref(g, g.sideKey, e.target.value);
      });
    }
  }
}

/* ------------------------------------------------------------------ *
 * ② 侧边栏位置（只读）
 * ------------------------------------------------------------------ */

/**
 * 读取侧边栏当前在哪一侧。
 *
 * ⚠️ 这里**只能读**。Chrome 的 `chrome.sidePanel` 命名空间提供
 * `getLayout()`（Chrome 140+，返回 `{ side: "left" | "right" }`），
 * 但**没有 `setLayout()`** —— 也就是说扩展在技术上无法决定自己的面板显示在左侧还是右侧，
 * 这个位置是 Chrome 的全局设置（设置 → 外观 → 侧边栏），对所有侧边栏内容统一生效。
 *
 * 所以这里不做"开关"，只做"告诉你现在在哪一侧 + 告诉你怎么改"。
 * 若将来 Chrome 补上 setLayout，只要把本函数扩展成可写即可，
 * HTML 里的按钮位置已经预留好了（.pref-controls 那一行）。
 */
async function detectPanelSide() {
  const valueEl = $("panel-side-value");
  if (!valueEl) return;

  const api = typeof chrome !== "undefined" ? chrome.sidePanel : null;
  if (!api || typeof api.getLayout !== "function") {
    valueEl.textContent = "无法检测";
    valueEl.dataset.side = "unknown";
    valueEl.title = "需要 Chrome 140 或更高版本";
    return;
  }

  try {
    const layout = await api.getLayout();
    const side = layout && layout.side;
    if (side === "left" || side === "right") {
      valueEl.textContent = side === "left" ? "左侧" : "右侧";
      valueEl.dataset.side = side;
      valueEl.removeAttribute("title");
    } else {
      valueEl.textContent = "未知";
      valueEl.dataset.side = "unknown";
    }
  } catch (e) {
    log.warn("读取侧边栏布局失败:", e);
    valueEl.textContent = "读取失败";
    valueEl.dataset.side = "unknown";
  }
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

let bound = false;

/**
 * 初始化（幂等）：首次调用绑定事件，之后每次调用只刷新展示。
 * 由 `app.js` 的 `bindEvents()` 调用一次；重复调用是安全的。
 */
export function initPrefsPanel() {
  if (!bound) {
    bound = true;
    buildVersionOptions();
    buildOptionLists();
    bindGroups();

    on("api-version-save", "click", handleSave);
    on("api-version-reset", "click", handleReset);
    on("api-version-select", "change", handleSelectChange);
    on("api-version-custom", "keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleSave();
      }
    });
    on("panel-side-refresh", "click", () => {
      detectPanelSide();
      showNotification("已重新检测侧边栏位置", "info");
    });

    // 另一处（标签页 / 侧边栏 / 贴边浮窗）改了偏好时同步展示值。
    // 只刷界面、不写回 —— prefs.js 的 storage 监听已经写过了（见其头部注释）。
    onPrefsChanged(() => {
      renderVersion();
      renderGroups();
    });

    // 用户切回本页时重测侧边栏位置：他可能刚去 Chrome 设置里把面板挪到另一侧。
    // 这个只读调用很便宜，且没有更精确的"位置变化"事件可用。
    window.addEventListener("focus", detectPanelSide);
  }

  renderVersion();
  renderGroups();
  detectPanelSide();
}
