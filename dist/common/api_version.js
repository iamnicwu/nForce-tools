/**
 * Salesforce API 版本的**唯一定义处**（常量 + 解析/规范化）。
 *
 * 为什么单独成一个模块，而不是留在 `sf_rest_client.js` 里：
 * service worker（`background.js`，逐字复制进 dist）也要读偏好，而它绝不能顺带把
 * 整个 REST 客户端（~10KB）拖进模块图；偏好层要校验版本号，故常量必须独立。
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
 * 2026-09-28：`"65.0"` → `"68.0"`（Winter '27）。
 * 2026-10-15：`"68.0"` → `"67.0"`（Summer '26）。**往回退了一版**，理由：
 *   Winter '27 的生产升级窗口是分批走的（09-04 / 10-02 / 10-09 / GA 10-12），
 *   走完之前有大量 org 仍停在 67 —— 对它们请求 `/services/data/v68.0/` 一律 404。
 *   我们的自动降级能兜住（先 404 再协商），但那是**建连接的第一步**，
 *   表现成「一直未连接」，且与「路径写错」在日志上难以分辨。
 *   默认取 67.0 = 绝大多数 org 一次就成功，不再依赖降级兜底。
 */
export const DEFAULT_API_VERSION = "67.0";

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
 * 接受 `"67"` / `"67.0"` / `" 67.0 "` / `67`（数字）；越界或无法识别一律返回 `null`
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

// ==========================================================================
// 实例版本发现
//
// 为什么必须有：Salesforce 每年发 3 个版本（Spring / Summer / Winter），
// 但**各 org 的升级窗口是分批走的** —— 同一个企业里的两个 org 完全可能差一版，
// 新版本的 GA 也可能晚于我们的默认值（v68.0 就是这样被退回 67.0 的）。
//
// 对一个还没升上来的 org 请求 `/services/data/v<默认>/...`，Salesforce 返回
// **404 Not Found**。这条 404 的文案与「路径写错了」一模一样，从日志上几乎
// 分辨不出来；而在本插件里它的表现是**整个连接测试失败**（`identity()` 是建连接的
// 第一步），用户看到的是「昨天还好好的，今天一直未连接」。
//
// 所以：不要假设「默认值 = 对方支持」。先问一次实例到底有哪些版本。
// ==========================================================================

/**
 * `instanceUrl -> Promise<number[]>`。同一个 org 只探测一次。
 *
 * 为什么要缓存：`login_app.js` 与会话恢复（`biz/session_recovery.js`）都是
 * 「按候选逐个建连接」，而多个候选常常属于同一个 org —— 不缓存就会对着
 * 同一个端点反复发一模一样的请求。
 */
const versionsProbeCache = new Map();

/**
 * 版本探测的超时。
 * ⚠️ 这个请求在**建连接的关键路径**上（`testConnection` 会 await 它），
 * 所以宁可探测不出来，也绝不能挂着 —— 对方接受连接却不响应时，
 * 没有超时的 fetch 会一直 pending，整个连接流程就卡死在那里，
 * 而那比「探测失败 → 沿用配置值」糟糕得多。
 */
const PROBE_TIMEOUT_MS = 4000;

/**
 * 查实例**实际支持**的 REST API 版本号，升序返回（如 `[20, 21, …, 67]`）；
 * 探测失败返回 `[]`。
 *
 * `GET {instanceUrl}/services/data/` 是 Salesforce 的**版本发现端点**，
 * 官方文档明确说明它**不需要认证** —— 因此可以在建立会话之前调用，
 * 用来回答「这个 org 到底认哪个版本」。
 *
 * ⚠️ 刻意**不引 logger**：本模块是「零 import」的，会被逐字复制进
 * `dist/common/`（`background.js` 也引用它）。日志由调用方负责。
 *
 * @param {string} instanceUrl
 * @returns {Promise<number[]>}
 */
export function probeInstanceApiVersions(instanceUrl) {
  const key = String(instanceUrl || "").replace(/\/+$/, "");
  if (!key) return Promise.resolve([]);
  if (versionsProbeCache.has(key)) return versionsProbeCache.get(key);

  const p = (async () => {
    const res = await fetch(`${key}/services/data/`, {
      headers: { Accept: "application/json" },
      // 见 PROBE_TIMEOUT_MS 的说明：超时后抛 AbortError，走下面的 catch 当作"探测不出来"
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return [];
    const list = await res.json();
    return (Array.isArray(list) ? list : [])
      .map((v) => Number(v && v.version))
      .filter((n) => Number.isFinite(n) && n > 0)
      .sort((a, b) => a - b);
  })().catch(() => {
    // 失败**不缓存**：一次网络抖动 / CSP 拦截不该变成永久结论，下次还要再试
    versionsProbeCache.delete(key);
    return [];
  });

  versionsProbeCache.set(key, p);
  return p;
}

/**
 * 把偏好版本夹进实例可用范围内。
 *
 * 三种结果：
 *   · 偏好可用        → 原样返回（尊重用户/默认值的选择，什么都不做）
 *   · 偏好不可用      → 退到**可用版本中最高的那个**，`fellBack: true`
 *   · 探测不出来（`available` 为空）→ 原样返回，`fellBack: false`
 *     （探测失败的原因可能是离线 / CSP / 域名根本不是 Salesforce，
 *      这些都不该被伪装成「版本不对」，后续请求该抛什么就抛什么）
 *
 * @param {string|number} preferred
 * @param {number[]} available `probeInstanceApiVersions()` 的结果
 * @returns {{version: string, fellBack: boolean, available: number[]}}
 */
export function pickUsableApiVersion(preferred, available) {
  const want = String(preferred || DEFAULT_API_VERSION);
  if (!Array.isArray(available) || available.length === 0) {
    return { version: want, fellBack: false, available: [] };
  }
  if (available.includes(Number(want))) {
    return { version: want, fellBack: false, available };
  }
  return { version: available[available.length - 1].toFixed(1), fellBack: true, available };
}
