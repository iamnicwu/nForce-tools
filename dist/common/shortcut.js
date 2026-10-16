/**
 * 快捷键的解析 / 规范化 / 显示 / 匹配（纯函数，零依赖）。
 *
 * ── 为什么要单独一个模块 ──
 * 同一条快捷键要在三处被理解，而它们的"语言"各不相同：
 *   ① `chrome.commands`（全局快捷键）—— 只认字符串，如 `"Alt+Shift+S"` / `"⌥⇧S"`（macOS 上
 *      `getAll()` 返回的是**符号形式**，`update()` 要的是**英文形式**）；
 *   ② 浏览器里的 `KeyboardEvent` —— 一堆布尔位（ctrlKey / metaKey / altKey / shiftKey + key）；
 *   ③ 界面上给用户看的字（macOS 上显示 ⌘⇧K 才符合直觉，Windows 上要显示 Ctrl+Shift+K）。
 * 三处各自写一遍 `if` 拼字符串，改一处就会漏一处（"设置里显示的是 A、按下去要 B"）。
 *
 * ── 存储格式（本模块定义的规范形式）──
 *   `"<修饰键>+<按键>"`，修饰键按 `Mod / Command / Ctrl / Alt / Shift` 规范化后拼接，
 *   按键是单个字母（大写）、数字或 `F1`–`F12`。例如 `"Mod+K"`、`"Alt+Shift+S"`、`"Command+Shift+K"`。
 *
 *   `Mod` 是**跨平台别名**：macOS 上等于 ⌘、其它平台等于 Ctrl。默认值用它，
 *   这样同一个默认值在两边都是用户顺手的那一个（与 Chrome 自己推荐 `Command`/`Ctrl` 的方式一致）。
 *
 * ⚠️ 本模块会被 `common/prefs.js` 引用，而 prefs.js 又被逐字复制的 service worker
 * 静态 import —— 所以这里**不能碰 DOM / navigator（只能在函数里用）**，也不能引别的模块。
 */

/** 单个按键允许的集合：字母 / 数字 / F1–F12。别的键（方向键、逗号…）Chrome 也支持，
 *  但界面上要为此写一整张映射表，收益很小 —— 先只收这三类，用户按下别的会给明确提示。 */
const FUNCTION_KEY_RE = /^F([1-9]|1[0-2])$/;
const LETTER_KEY_RE = /^[A-Z]$/;
const DIGIT_KEY_RE = /^[0-9]$/;

const MOD_ORDER = ["Mod", "Command", "Ctrl", "Alt", "Shift"];

/** 面板内那条搜索快捷键的默认值（全局那条的默认值写在 manifest 的 commands 里） */
export const SEARCH_PANEL_SHORTCUT_DEFAULT = "Mod+K";

/**
 * 是否 macOS。
 * 只在**函数里**读 navigator —— 本模块会被 service worker import（那里没有 navigator）。
 * 判据优先用 `userAgentData.platform`（不受语言影响），退回 `navigator.platform`。
 */
export function isMacLike() {
  try {
    const nav = typeof navigator === "undefined" ? null : navigator;
    if (!nav) return false;
    const uaData = nav.userAgentData;
    const p = (uaData && uaData.platform) || nav.platform || "";
    return /mac/i.test(String(p));
  } catch (e) {
    return false;
  }
}

/** 把 `event.key` 规范化成存储格式里的按键名；不支持的键返回 null */
export function normalizeKey(key) {
  const raw = String(key ?? "");
  if (!raw) return null;
  const upper = raw.length === 1 ? raw.toUpperCase() : raw;
  if (LETTER_KEY_RE.test(upper) || DIGIT_KEY_RE.test(upper)) return upper;
  const fn = upper.toUpperCase();
  if (FUNCTION_KEY_RE.test(fn)) return fn;
  return null;
}

/** 比较一次按键事件与规范按键名是否同一个键（字母大小写、CapsLock、Shift 化的符号都要容错） */
function keyMatches(event, expectedKey) {
  const got = normalizeKey(event && event.key);
  return !!got && got === expectedKey;
}

/**
 * 从一次 keydown 事件得到规范形式的快捷键字符串。
 *
 * @param {KeyboardEvent} event
 * @param {{mac?: boolean}} [opts] 便于测试注入平台
 * @returns {{ok: true, value: string} | {ok: false, error: string}}
 *          失败时 `error` 是**可以直接显示给用户**的一句话。
 */
export function acceleratorFromEvent(event, opts = {}) {
  const mac = typeof opts.mac === "boolean" ? opts.mac : isMacLike();
  const key = normalizeKey(event && event.key);
  if (!key) {
    return { ok: false, error: "只支持字母、数字或 F1–F12 作为主键" };
  }

  const mods = [];
  // macOS 上 ⌘ 就是大家期待的那个"主修饰键"；其它平台上 metaKey（Win 键）不参与
  if (event.metaKey && mac) mods.push("Command");
  if (event.ctrlKey) mods.push(mac ? "Ctrl" : "Mod");
  if (event.altKey) mods.push("Alt");
  if (event.shiftKey) mods.push("Shift");

  // Chrome 的硬性要求：快捷键必须包含 Ctrl / Alt / ⌘ 之一，只按 Shift+字母 是无效的
  const hasStrong = mods.some((m) => m === "Mod" || m === "Ctrl" || m === "Command" || m === "Alt");
  if (!hasStrong) {
    return { ok: false, error: "快捷键必须包含 Ctrl / ⌘ / Alt 中的至少一个" };
  }

  return { ok: true, value: `${orderMods(mods).join("+")}+${key}` };
}

function orderMods(mods) {
  return [...new Set(mods)].sort(
    (a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b)
  );
}

/**
 * 规范化（并校验）一个存储值。非法返回 null —— 与 `common/prefs.js` 的解析器约定一致
 * （解析器返回 null 表示"这个值不合法"，由 prefs 层回落到默认值并提示）。
 */
export function normalizeAccelerator(spec) {
  const raw = String(spec ?? "").trim();
  if (!raw) return null;
  const parts = raw.split("+").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return null;

  const keyPart = parts[parts.length - 1];
  const key = normalizeKey(keyPart);
  if (!key) return null;

  const mods = [];
  for (const part of parts.slice(0, -1)) {
    const name = MOD_ORDER.find((m) => m.toLowerCase() === part.toLowerCase());
    if (!name) return null;
    mods.push(name);
  }
  const hasStrong = mods.some((m) => m === "Mod" || m === "Ctrl" || m === "Command" || m === "Alt");
  if (!hasStrong) return null;

  return `${orderMods(mods).join("+")}+${key}`;
}

/** 解析成便于匹配的结构（`{mods: Set<string>, key}`）；非法返回 null */
export function parseAccelerator(spec) {
  const normalized = normalizeAccelerator(spec);
  if (!normalized) return null;
  const parts = normalized.split("+");
  return { mods: new Set(parts.slice(0, -1)), key: parts[parts.length - 1] };
}

/**
 * 这一次按键是否命中该快捷键。
 * 四个修饰键必须**精确一致**（多按一个 Shift 就不该触发）—— 否则 `Mod+K` 会连
 * `Mod+Shift+K` 一起吃掉，用户想打大写的 K 时面板会跳出来。
 */
export function matchesAccelerator(event, spec, opts = {}) {
  const parsed = parseAccelerator(spec);
  if (!parsed || !event) return false;
  const mac = typeof opts.mac === "boolean" ? opts.mac : isMacLike();

  const wantMeta = parsed.mods.has("Command") || (parsed.mods.has("Mod") && mac);
  const wantCtrl = parsed.mods.has("Ctrl") || (parsed.mods.has("Mod") && !mac);

  return (
    !!event.metaKey === wantMeta &&
    !!event.ctrlKey === wantCtrl &&
    !!event.altKey === parsed.mods.has("Alt") &&
    !!event.shiftKey === parsed.mods.has("Shift") &&
    keyMatches(event, parsed.key)
  );
}

/** 界面上显示用的写法：macOS 用符号（与 Chrome 扩展快捷键页的自己那一套一致） */
export function displayAccelerator(spec, opts = {}) {
  const parsed = parseAccelerator(spec);
  if (!parsed) return String(spec ?? "");
  const mac = typeof opts.mac === "boolean" ? opts.mac : isMacLike();

  if (!mac) {
    const mods = [...parsed.mods].map((m) => (m === "Mod" ? "Ctrl" : m));
    return [...orderMods(mods), parsed.key].join("+");
  }
  const SYMBOL = { Mod: "⌘", Command: "⌘", Ctrl: "⌃", Alt: "⌥", Shift: "⇧" };
  // mac 上的显示顺序固定为 ⌃⌥⇧⌘ + 键（与系统菜单一致）
  const order = ["Ctrl", "Alt", "Shift", "Mod", "Command"];
  const mods = [...parsed.mods].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return mods.map((m) => SYMBOL[m] || m).join("") + parsed.key;
}

/**
 * manifest 里那条命令的出厂默认值（macOS 优先取 `suggested_key.mac`）。
 * **不硬编码**：改 manifest 就该自动跟着变，否则"恢复默认"会恢复到一个过期值。
 */
export function manifestDefaultShortcut(manifest, commandName) {
  const cmd = manifest && manifest.commands ? manifest.commands[commandName] : null;
  if (!cmd || !cmd.suggested_key) return "";
  const mac = isMacLike();
  return (mac && cmd.suggested_key.mac) || cmd.suggested_key.default || "";
}
