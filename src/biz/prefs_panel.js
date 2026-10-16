/**
 * 「插件偏好」设置卡片（section-28）的界面逻辑。
 *
 * 三组：
 *   ① Salesforce API 版本 —— 下拉选常用版本 + 文本框填自定义版本，存 chrome.storage.local
 *   ② 侧边栏位置        —— **只能读、不能设**，原因见 `detectPanelSide()` 上方注释
 *   ③ 搜索快捷键        —— 两条：任意网页（只能读 + 跳 Chrome 设置页）/ 插件页面内（可录制）
 *
 * 与 `common/prefs.js` 的分工：那边只管读写与跨宿主同步，这边只管 DOM。
 * 偏好值真正"生效"（改到 sf_service 的 defaultApiVersion 与已建连接上）由 `app.js` /
 * `background.js` 订阅 `onPrefsChanged` 统一处理，所以本模块保存后只刷新自己的展示。
 *
 * ①③ 的写路径一律走泛化的 `setPref(key, value)`：这里**不做任何值校验**，
 * 合法性由 prefs.js 的解析器负责（取值范围也只有那一份）。
 * 界面上多写一处校验，就会在改规则时漏改一处。
 * ③ 的"任意网页那条"是例外：它由 Chrome 保管，本模块只能读 + 跳转（见该组注释）。
 */
import { createLogger } from "../common/logger.js";
import { $, on } from "../common/dom.js";
import { showNotification } from "../common/utils.js";
import { API_VERSION_MIN, API_VERSION_MAX } from "../common/api_version.js";
import {
  acceleratorFromEvent,
  displayAccelerator,
  manifestDefaultShortcut
} from "../common/shortcut.js";
import {
  getPref,
  setPref,
  resetPref,
  getApiVersion,
  setApiVersion,
  resetApiVersion,
  onPrefsChanged,
  PREF_KEYS
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
 * ③ 搜索快捷键（两条：任意网页 / 插件页面内）
 *
 * ── 为什么"任意网页"那条**只能读、不能设** ──
 * 在别的网页上能不能唤起，取决于**浏览器**里对 `manifest.commands` 的绑定。
 * 改它唯一的 API 是 `chrome.commands.update()`，而**它在 MV3 里不存在** ——
 * 2026-10-15 在 Chrome 155 上实测：`Object.keys(chrome.commands)` 只有
 * `["onCommand","getAll"]`，`typeof update === "undefined"`（service worker 与扩展页面
 * 两个上下文都如此）。Chrome 有意把"改扩展快捷键"留给用户自己，扩展不该能抢任意组合键。
 *
 * 所以这一条与「侧边栏位置」是同一类平台限制（那边是 `sidePanel` 只有 `getLayout()`
 * 没有 `setLayout()`）：**如实告诉用户当前值 + 给一条直达 Chrome 设置页的路**。
 * 实测 `chrome.tabs.create({ url: "chrome://extensions/shortcuts" })` 是允许的
 * （不像多数 chrome:// 页面那样被拦），所以按钮能一步把人送过去。
 *
 * ── 那条"读"仍然很有用 ──
 * Chrome 对"与别的扩展 / 系统快捷键冲突"的绑定**不报错、不警告，只是留空**。
 * 设置页把空值显示成红色的「未设置 / 未生效」，这是全项目唯一能看出
 * "按了没反应"的地方（`ext-verify.mjs` 的真机断言也守着这一条）。
 *
 * ── 面板内那条 ──
 * 完全是插件自己的 DOM 监听，存本地偏好（`PREF_KEYS.searchShortcut`），
 * 由 `biz/command_palette.js` 实时读取 → 这一条可以自由录制修改。
 * ------------------------------------------------------------------ */

/** manifest 里那条搜索命令的名字（与 `manifest.json` 的 `commands` 逐字一致） */
const COMMAND_OPEN_SEARCH = "open-search";

/** Chrome 自带的扩展快捷键设置页（唯一能改全局快捷键的地方） */
const CHROME_SHORTCUTS_URL = "chrome://extensions/shortcuts";

/** 正在录制哪一条：`"panel"` | null（null = 没在录）。全局那条不可录制，见上方说明 */
let recording = null;

/** 录制按钮的原始文案，取消/失败后要还原 */
const RECORD_BUTTONS = {
  panel: { id: "search-shortcut-panel-record", text: "修改" }
};

/** 读 Chrome 里那条全局快捷键的真实状态（`shortcut` 为空 = 没绑上） */
async function readGlobalShortcut() {
  const api = typeof chrome !== "undefined" ? chrome.commands : null;
  if (!api || typeof api.getAll !== "function") return { supported: false, shortcut: "" };
  try {
    const all = await api.getAll();
    const cmd = (all || []).find((c) => c.name === COMMAND_OPEN_SEARCH);
    return { supported: true, shortcut: (cmd && cmd.shortcut) || "" };
  } catch (e) {
    log.warn("读取全局快捷键失败:", e);
    return { supported: false, shortcut: "" };
  }
}

/** 把两条快捷键的当前值刷到界面上（全局那条以 Chrome 为准） */
async function renderSearchShortcut() {
  const panelEl = $("search-shortcut-panel");
  if (panelEl) {
    panelEl.textContent = displayAccelerator(getPref(PREF_KEYS.searchShortcut));
    panelEl.dataset.state = "set";
  }

  const globalEl = $("search-shortcut-global");
  const stateEl = $("search-shortcut-state");
  const { supported, shortcut } = await readGlobalShortcut();

  if (globalEl) {
    globalEl.textContent = !supported ? "不可用" : shortcut || "未设置";
    globalEl.dataset.state = !supported ? "unknown" : shortcut ? "set" : "empty";
    // 出厂默认值从 manifest 读（**不硬编码**），放在 tooltip 里：
    // 用户去 Chrome 那边"清空/重设"时，需要知道原本是什么
    const factory = manifestDefaultShortcut(
      typeof chrome !== "undefined" && chrome.runtime ? chrome.runtime.getManifest() : null,
      COMMAND_OPEN_SEARCH
    );
    if (factory) {
      globalEl.title = `出厂默认 ${displayAccelerator(factory)}；在 Chrome 的扩展快捷键页可以改，也可以清空`;
    }
  }
  if (stateEl) {
    stateEl.textContent = !supported ? "当前环境不支持" : shortcut || "未生效";
    stateEl.dataset.state = !supported ? "unknown" : shortcut ? "set" : "empty";
  }
  return { supported, shortcut };
}

/**
 * 打开 Chrome 自带的扩展快捷键设置页。
 * 实测这是少数允许扩展打开的 `chrome://` 页面（多数会被拦成无声失败），
 * 但它终究是跨版本行为 → 失败时给出可照抄的手动路径，不留白。
 */
async function openChromeShortcutsPage() {
  const tabsApi = typeof chrome !== "undefined" ? chrome.tabs : null;
  if (!tabsApi || typeof tabsApi.create !== "function") {
    setHint("search-shortcut-hint", "当前环境打不开 Chrome 设置页，请手动打开：扩展程序 → 键盘快捷键", true);
    return;
  }
  try {
    await tabsApi.create({ url: CHROME_SHORTCUTS_URL });
  } catch (e) {
    log.warn("打开 chrome://extensions/shortcuts 失败:", e);
    setHint(
      "search-shortcut-hint",
      "这条版本打不开设置页，请手动进入：Chrome 菜单 → 扩展程序 → 管理扩展程序 → 左侧「键盘快捷键」",
      true
    );
  }
}

function startRecording(which) {
  const btn = $(RECORD_BUTTONS[which].id);
  if (!btn) return;
  recording = which;
  btn.textContent = "请按组合键…";
  btn.dataset.state = "recording";
  setHint(
    "search-shortcut-hint",
    "现在按下想用的组合键（必须含 Ctrl / ⌘ / Alt 之一，主键支持字母、数字、F1–F12）；Esc 取消。",
    false
  );
}

/** 退出录制状态并还原按钮；message 会写进提示行 */
function stopRecording(message, isError) {
  for (const which of Object.keys(RECORD_BUTTONS)) {
    const btn = $(RECORD_BUTTONS[which].id);
    if (btn) {
      btn.textContent = RECORD_BUTTONS[which].text;
      delete btn.dataset.state;
    }
  }
  recording = null;
  if (message) setHint("search-shortcut-hint", message, !!isError);
}

/**
 * 录制期间接管键盘。
 * ⚠️ 注册在 **capture** 阶段：既要抢在 `biz/ui.js` 的「Esc 返回首页」之前，
 * 也要保证焦点在哪儿都能收到（录制时用户可能刚点完按钮就松手）。
 */
function onRecordKeydown(e) {
  if (!recording) return;
  e.preventDefault();
  e.stopPropagation();

  if (e.key === "Escape") {
    stopRecording("已取消，快捷键未改动", false);
    return;
  }
  // 只按住修饰键时先等着 —— 否则"按下 Ctrl"的瞬间就会被当成一次输入
  if (["Control", "Meta", "Alt", "Shift"].includes(e.key)) return;

  const result = acceleratorFromEvent(e);
  if (!result.ok) {
    // 保持录制状态，让用户直接重按一个合法的
    setHint("search-shortcut-hint", result.error + "，请重新按一次。", true);
    return;
  }
  applyRecordedPanelShortcut(result.value);
}

async function applyRecordedPanelShortcut(spec) {
  const result = await setPref(PREF_KEYS.searchShortcut, spec);
  if (!result.ok) {
    stopRecording(result.error, true);
    return;
  }
  stopRecording(`插件页面内的快捷键已改为 ${displayAccelerator(result.value)}`, false);
  await renderSearchShortcut();
  showNotification(`搜索快捷键已改为 ${displayAccelerator(result.value)}`, "success");
}

async function resetPanelShortcut() {
  const result = await resetPref(PREF_KEYS.searchShortcut);
  if (!result.ok) {
    setHint("search-shortcut-hint", result.error, true);
    return;
  }
  await renderSearchShortcut();
  setHint(
    "search-shortcut-hint",
    `已恢复默认：${displayAccelerator(result.value)}（搜索框里按 Esc 之外，还可以在非输入框处按 / 唤起）`,
    false
  );
}

function bindSearchShortcut() {
  on("search-shortcut-panel-record", "click", () => startRecording("panel"));
  on("search-shortcut-panel-reset", "click", resetPanelShortcut);
  on("search-shortcut-global-open", "click", openChromeShortcutsPage);

  window.addEventListener("keydown", onRecordKeydown, true);
  // 全局那条只能在 Chrome 的设置页改，而那里改了不会通知我们
  // → 每次回到本页都重读一次，避免显示的是过期值
  window.addEventListener("focus", () => {
    renderSearchShortcut();
  });
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
    bindSearchShortcut();

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

    // 另一处（标签页 / 侧边栏）改了偏好时同步展示值。
    // 只刷界面、不写回 —— prefs.js 的 storage 监听已经写过了（见其头部注释）。
    onPrefsChanged(() => {
      renderVersion();
      renderSearchShortcut();
    });

    // 用户切回本页时重测侧边栏位置：他可能刚去 Chrome 设置里把面板挪到另一侧。
    // 这个只读调用很便宜，且没有更精确的"位置变化"事件可用。
    window.addEventListener("focus", detectPanelSide);
  }

  renderVersion();
  renderSearchShortcut();
  detectPanelSide();
}
