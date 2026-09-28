/**
 * 侧边栏：鼠标移出后自动隐藏。
 *
 * ── 为什么这个能做，而「鼠标靠边弹出」不能 ──
 * Chrome 官方文档对 `sidePanel.open()` 的措辞是 "may only be called in response to a
 * user action"，且明确的合法触发只有四种：点工具栏图标、键盘快捷键、右键菜单、
 * 扩展页/内容脚本里的手势，**鼠标移动不是用户动作**。
 * 反观 `close()`（Chrome 141+）没有任何手势限制，文档只说「已经关掉时是 no-op」。
 * 所以：自动隐藏可以做，靠边弹出不行 —— 后者只能靠页面内的贴边浮窗
 * （见 `src/dock.js`）。
 *
 * ── 时序上的两个坑（改这里之前先看）──
 * 1. **原生下拉会误触**：`<select>` 的选项弹窗属于浏览器 chrome，指针一进去就
 *    `pointerleave`，面板会在用户正挑选项的时候关掉。所以焦点停在表单控件上时
 *    不排期，并在 `focusout` 时补一次判断 —— 否则「点了下拉再点到别处」
 *    会永远不再隐藏（指针已经出去了，但没有新事件来重新排期）。
 * 2. **初始状态当成「指针在里面」**：用快捷键打开面板时指针在页面上，
 *    不会产生 pointerleave。若初始当 "false" 就会立刻关掉刚打开的面板。
 *
 * 本模块只在**侧边栏宿主**下工作（`app.js` 里 `host === HOST_PANEL` 才调用）。
 * 注意 `body.host-panel` 这个 class 侧边栏与贴边浮窗**都有**（两者都是窄栏排版），
 * 所以不能拿它当开关 —— 浮窗里误调会关掉浏览器侧边栏，用户看到的是"什么都没发生"。
 */
import { createLogger } from "../common/logger.js";
import { getPref, onPrefsChanged, PREF_KEYS } from "../common/prefs.js";

const log = createLogger("UI");

/** 指针是否在本文档内。初始 true 的理由见文件头「坑 2」。 */
let pointerInside = true;
let timer = null;
let bound = false;

function isEnabled() {
  return !!getPref(PREF_KEYS.panelAutoHide);
}

function hideDelay() {
  const v = Number(getPref(PREF_KEYS.panelHideDelay));
  return Number.isFinite(v) ? v : 600;
}

/** 焦点停在表单控件上时不隐藏：原生下拉/输入法候选框都在浏览器 chrome 里，指针必然离开文档。 */
function hasFormFocus() {
  const el = document.activeElement;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "SELECT" || tag === "INPUT" || tag === "TEXTAREA";
}

function cancel() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}

async function hidePanel() {
  timer = null;
  if (!isEnabled()) return;
  try {
    // 侧边栏是「全局面板」，按 windowId 关闭；用窗内任一标签页都不对。
    let win = null;
    try {
      win = await chrome.windows.getCurrent();
    } catch (e) {
      win = await chrome.windows.getLastFocused();
    }
    if (!win || win.id === undefined) return;
    await chrome.sidePanel.close({ windowId: win.id });
    log.info("鼠标已移出侧边栏，自动隐藏");
  } catch (e) {
    // 面板已经关掉时是 no-op，正常不会走到这里；真出错也只是没隐藏，不影响使用
    log.warn("自动隐藏侧边栏失败:", e);
  }
}

/** 条件满足才排期；不满足时静默返回（等下一次事件再判断）。 */
function maybeSchedule() {
  if (!isEnabled() || document.hidden || hasFormFocus()) return;
  if (pointerInside) return;
  cancel();
  const delay = hideDelay();
  if (delay <= 0) {
    hidePanel();
    return;
  }
  timer = setTimeout(hidePanel, delay);
}

/**
 * 初始化（幂等）。由 `app.js` 在宿主判定之后、且仅当宿主是侧边栏时调用。
 */
export function initPanelAutoHide() {
  if (bound) return;
  bound = true;

  const root = document.documentElement;
  // 直接用 documentElement 而不是 window：pointerleave 不冒泡，
  // 挂在根元素上才能准确表示「指针离开了这个文档」。
  root.addEventListener("pointerleave", () => {
    pointerInside = false;
    maybeSchedule();
  });
  root.addEventListener("pointerenter", () => {
    pointerInside = true;
    cancel();
  });
  // 焦点移出表单控件时补判一次（见文件头「坑 1」）
  document.addEventListener("focusout", () => {
    // 延到下一帧：focusout 触发时 activeElement 可能还没更新
    setTimeout(maybeSchedule, 0);
  });

  // 设置页改了开关/延迟立即生效，不用重开面板
  onPrefsChanged(() => {
    if (!isEnabled()) {
      cancel();
      return;
    }
    maybeSchedule();
  });

  log.debug(`侧边栏自动隐藏：${isEnabled() ? "已启用" : "未启用"}（移出后 ${hideDelay()}ms）`);
}
