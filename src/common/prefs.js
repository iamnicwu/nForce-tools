/**
 * 用户偏好（设置页里那些跟 Salesforce 连接无关的选项）。
 *
 * 与 `biz/state.js` 的 `appState` 分工不同：
 *   - `appState` 是**本次会话的内存状态**，刷新即丢，且不写入 storage；
 *   - 本模块是**要跨会话记住**的偏好，落在 `chrome.storage.local`。
 *
 * 为什么不直接塞进 `appState`：`appState` 的 Proxy 只做变更通知、不做持久化，
 * 把偏好混进去会让人误以为"改了就会存下来"。
 *
 * 跨宿主同步：侧边栏、标签页、以及**注入到 Salesforce 页面的贴边浮窗**可以同时存在，
 * 共享同一份 storage。若不监听变化，就会出现"在标签页改了设置，浮窗还在用旧值"。
 * 这里的监听**只读 storage、从不回写**，所以不存在互相触发的死循环
 * （与 `app.js` 的 `watchSessionStorage` 同模式）。
 *
 * ── 结构 ──
 * 表驱动：新增一个偏好 = 在 PREF_KEYS / PREF_DEFAULTS / SPECS 各加一行。
 * 之所以不再像最初那样为每个键手写一个 getter/setter：一次性多了 5 个键时，
 * 手写会变成 5 份互相抄的样板，且"漏了一个写入点"这种 bug 静态检查抓不到。
 *
 * ⚠️ **本模块被 service worker（`background.js`）与内容脚本注入的浮层引用** ——
 * 后者跑在客户页面上。所以这里只依赖 `logger.js` / `api_version.js` / `shortcut.js`
 * 这三个零依赖模块，千万不要 import `sf_rest_client.js` 之类会把整个客户端打进页面的东西。
 */
import { createLogger } from "./logger.js";
import { DEFAULT_API_VERSION, parseApiVersion } from "./api_version.js";
// 快捷键的规范化 / 校验（纯函数）。本模块被逐字复制的 SW 静态 import，
// 所以 shortcut.js 也必须零依赖、且只在函数里读 navigator（见该文件头部）。
import { normalizeAccelerator, SEARCH_PANEL_SHORTCUT_DEFAULT } from "./shortcut.js";

const log = createLogger("PREFS");

/** storage 里的键名。键名带 `sf_` 前缀，与 `sf_session_id` / `sf_instance_url` 保持一致。 */
export const PREF_KEYS = Object.freeze({
  apiVersion: "sf_api_version",
  /**
   * 全局搜索：**插件页面内**那条快捷键。
   *
   * 注意与"全局快捷键"（任意网页都能唤起的那条）的区别：那条由 Chrome 自己保存，
   * 只能通过 `chrome://extensions/shortcuts` 改（MV3 没有 `commands.update()`，见
   * `biz/prefs_panel.js` 的说明），**不在本模块里**。
   * 这里存的是插件自己页面里的 DOM 监听用的那条。
   */
  searchShortcut: "sf_search_shortcut"
});

/** 缺省值。**只在这里写一次**，供 `loadPrefs()` 填充缺失项与「恢复默认」使用。 */
export const PREF_DEFAULTS = Object.freeze({
  [PREF_KEYS.apiVersion]: DEFAULT_API_VERSION,
  // 搜索快捷键：跨平台别名 Mod = mac 上的 ⌘、其它平台的 Ctrl
  [PREF_KEYS.searchShortcut]: SEARCH_PANEL_SHORTCUT_DEFAULT
});

/* ------------------------------------------------------------------ *
 * 各键的解析器：合法则返回规范化后的值，非法返回 null
 * ------------------------------------------------------------------ */

/**
 * 每个键的解析器 + 出错时给用户看的话。
 */
const SPECS = Object.freeze({
  [PREF_KEYS.apiVersion]: {
    parse: parseApiVersion,
    where: "API 版本",
    howto: "请填 20.0 ~ 70.9 之间的数字（如 67.0）"
  },
  [PREF_KEYS.searchShortcut]: {
    parse: normalizeAccelerator,
    where: "搜索快捷键",
    howto: "形如 Mod+K / Alt+Shift+S，且必须包含 Ctrl / ⌘ / Alt 之一（主键支持字母、数字、F1–F12）"
  }
});

const ALL_KEYS = Object.keys(PREF_DEFAULTS);

let _cache = { ...PREF_DEFAULTS };
const _listeners = new Set();

/* ------------------------------------------------------------------ *
 * 读
 * ------------------------------------------------------------------ */

/** 读一个偏好（未 loadPrefs 时返回默认值）。 */
export function getPref(key) {
  return _cache[key];
}

export function getAllPrefs() {
  return { ..._cache };
}

/** 当前生效的 API 版本（规范化的 `"NN.N"`）。 */
export function getApiVersion() {
  return getPref(PREF_KEYS.apiVersion);
}

/**
 * 从 storage 载入全部偏好。
 * 单个键只要解析不出来就用默认值兜底**并顺手写回** ——
 * 一是设置项读失败不该让整个页面起不来，二是避免每次启动都报同一句警告。
 * 这也是这里不把错误往上抛的原因。
 */
export async function loadPrefs() {
  const next = { ...PREF_DEFAULTS };
  let toRepair = null;

  try {
    const stored = await chrome.storage.local.get(ALL_KEYS);
    for (const key of ALL_KEYS) {
      const raw = stored[key];
      if (raw === undefined) continue; // 没存过 → 用默认值
      const parsed = SPECS[key].parse(raw);
      if (parsed === null) {
        log.warn(`storage 里的「${SPECS[key].where}」${JSON.stringify(raw)} 不合法，回落到默认值`);
        toRepair = toRepair || {};
        toRepair[key] = PREF_DEFAULTS[key];
        next[key] = PREF_DEFAULTS[key];
      } else {
        next[key] = parsed;
      }
    }
  } catch (e) {
    log.warn("读取偏好失败，本次使用默认值:", e);
  }

  const changed = ALL_KEYS.some((k) => next[k] !== _cache[k]);
  _cache = next;

  if (toRepair) {
    try {
      await chrome.storage.local.set(toRepair);
    } catch (e) {
      log.warn("回写非法偏好失败（不影响本次使用）:", e);
    }
  }

  log.info(`偏好已载入：API 版本 v${getApiVersion()}`);
  if (changed) _emit();
  return getAllPrefs();
}

/* ------------------------------------------------------------------ *
 * 写
 * ------------------------------------------------------------------ */

/**
 * 设置一个偏好并持久化。
 * @param {string} key PREF_KEYS 里的键名
 * @param {*} raw 用户输入
 * @returns {Promise<{ok: boolean, value: *, error?: string}>}
 *          非法输入**不写入**，由调用方把 error 显示给用户 ——
 *          静默回落到默认值会让用户以为自己填的值生效了。
 */
export async function setPref(key, raw) {
  const spec = SPECS[key];
  if (!spec) return { ok: false, value: undefined, error: `未知的偏好项：${key}` };

  const parsed = spec.parse(raw);
  if (parsed === null) {
    return {
      ok: false,
      value: _cache[key],
      error: `「${String(raw)}」不是合法的${spec.where}，${spec.howto}`
    };
  }

  _cache[key] = parsed;
  try {
    await chrome.storage.local.set({ [key]: parsed });
  } catch (e) {
    log.warn(`写入「${spec.where}」失败（本次会话仍生效，但重启后会丢）:`, e);
    _emit();
    return { ok: false, value: parsed, error: "已应用到本次会话，但保存到本地失败：" + (e.message || e) };
  }
  log.info(`${spec.where}已保存为 ${JSON.stringify(parsed)}`);
  _emit();
  return { ok: true, value: parsed };
}

/** 恢复某个偏好的默认值。 */
export async function resetPref(key) {
  return setPref(key, PREF_DEFAULTS[key]);
}

/* 兼容既有调用方的薄包装（API 版本是第一个偏好项，用得最多） */
export function setApiVersion(raw) {
  return setPref(PREF_KEYS.apiVersion, raw);
}
export function resetApiVersion() {
  return resetPref(PREF_KEYS.apiVersion);
}

/* ------------------------------------------------------------------ *
 * 变更通知 + 跨宿主同步
 * ------------------------------------------------------------------ */

/** 订阅偏好变更，返回取消订阅函数。回调收到完整偏好对象。 */
export function onPrefsChanged(callback) {
  _listeners.add(callback);
  return () => _listeners.delete(callback);
}

function _emit() {
  const snapshot = getAllPrefs();
  for (const cb of _listeners) {
    try {
      cb(snapshot);
    } catch (e) {
      log.error("偏好监听器执行失败:", e);
    }
  }
}

let _watchBound = false;

/**
 * 监听 storage 变化，把另一处（侧边栏 / 标签页 / 贴边浮窗）的改动同步到本处。
 * 幂等：重复调用只会绑定一次。**只读 storage、绝不回写**，否则两边会互相触发。
 */
export function watchPrefsStorage() {
  if (_watchBound) return;
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;

      const applied = [];
      for (const key of ALL_KEYS) {
        if (!(key in changes)) continue;
        const parsed = SPECS[key].parse(changes[key].newValue);
        if (parsed === null) continue; // 非法值交给下一次 loadPrefs 处理
        if (parsed === _cache[key]) continue; // 自己写入时也会走到这里，直接忽略
        _cache[key] = parsed;
        applied.push(`${SPECS[key].where}=${JSON.stringify(parsed)}`);
      }

      if (applied.length) {
        log.info(`另一处（标签页/侧边栏/浮窗）改了偏好，同步到本处：${applied.join("、")}`);
        _emit();
      }
    });
    _watchBound = true;
  } catch (e) {
    log.warn("无法监听偏好变化（跨宿主同步失效）:", e);
  }
}
