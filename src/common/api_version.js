/**
 * Salesforce API 版本的**唯一定义处**（常量 + 解析/规范化）。
 *
 * 为什么单独成一个模块，而不是留在 `sf_rest_client.js` 里：
 * 内容的**脚本**（`biz/dock.js`）也要读偏好，而它跑在客户页面上；
 * 若偏好层直接依赖 REST 客户端，整个 `sf_rest_client.js`（~10KB）
 * 就会被一起打进内容脚本 —— 为一个版本号字符串付这个代价不值得。
 * 这里没有任何 import，谁都能引用。
 *
 * 调用方：
 *   · `sf_rest_client.js`  —— 连接对象的版本兜底
 *   · `common/prefs.js`    —— 设置页的持久化与校验
 *   · `biz/sf_service.js`  —— 运行时把设置应用到已建连接
 *   · `biz/prefs_panel.js` —— 生成下拉选项（用 MIN / MAX）
 */

/**
 * 默认值。**改这一个常量 = 改全插件的默认 API 版本**（设置页「恢复默认」也回到这里）。
 *
 * 历史上的坑：`biz/inspector_tools.js` 曾经写死过一个 `59.0`，
 * 和这里的默认值长期不一致；`login_app.js` 也自己存过一份。
 * 现在只有这一处，别再往别处写死。
 *
 * 2026-09-28：`"65.0"` → `"68.0"`（Winter '27，即当时平台最新）。
 */
export const DEFAULT_API_VERSION = "68.0";

/**
 * 允许在设置页里配置的版本范围。
 * Salesforce 每年发 3 个版本（Spring / Summer / Winter），版本号每年 +3；
 * 这里留出比当前默认值更宽的范围，方便 org 落后或提前于默认值时也能用。
 */
export const API_VERSION_MIN = "20.0";
export const API_VERSION_MAX = "70.0";

/**
 * 把用户输入 / storage 里的版本号解析成规范的 `"NN.N"` 形式。
 *
 * 接受 `"68"` / `"68.0"` / `" 68.0 "` / `68`（数字）；越界或无法识别一律返回 `null`
 * —— 由调用方决定是报错还是回落到默认值（`normalizeApiVersion`）。
 * 之所以要容忍 `"68"`，是因为输入框里手打版本号时很少有人会补 `.0`。
 *
 * @param {string|number|null|undefined} raw
 * @returns {string|null}
 */
export function parseApiVersion(raw) {
  if (raw === null || raw === undefined) return null;
  const m = /^(\d{1,2})(?:\.(\d))?$/.exec(String(raw).trim());
  if (!m) return null;
  const major = Number(m[1]);
  const minor = m[2] === undefined ? 0 : Number(m[2]);
  if (major < 1) return null;
  const value = major * 10 + minor; // 20.0 -> 200，用于范围比较
  const min = Number(API_VERSION_MIN.split(".")[0]) * 10;
  const max = Number(API_VERSION_MAX.split(".")[0]) * 10 + 9;
  if (value < min || value > max) return null;
  return `${major}.${minor}`;
}

/** 同 `parseApiVersion`，但不合法时回落到默认值（用于读 storage 这类防御性场景）。 */
export function normalizeApiVersion(raw) {
  return parseApiVersion(raw) ?? DEFAULT_API_VERSION;
}
