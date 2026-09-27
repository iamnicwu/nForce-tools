/**
 * 全局库按需加载器
 *
 * ── 为什么 ──
 * index.html 的 <head> 里原本有 5 个同步阻塞脚本，合计约 3.3MB：
 *   echarts 1.00MB · xlsx 0.85MB · jszip 95KB · dayjs 7KB（+ 已移除的 jsforce 1.37MB）
 * 这些库都只在特定交互（出图 / 导入导出 / 打 zip）时才需要，却拖慢每一次启动。
 * 而**侧边栏每点一次工具栏图标就会重新加载并解析一次 index.html**，
 * 所以这笔成本是反复付出的固定成本。
 *
 * ── 做法 ──
 * 这三个库都是 UMD / 全局脚本（挂 window.X），不是 ESM，因此不能用 import()，
 * 改为「首次需要时注入 <script> 并等待 onload」，用 Promise 记忆化保证只注入一次。
 * 扩展页面是同源的，注入自己包内的脚本不违反 MV3 的 script-src 'self'。
 *
 * ── Salesforce 客户端不在这里 ──
 * jsforce（1.37MB）已于 2026-09-28 被自研的 `common/sf_rest_client.js`（约 8KB）取代，
 * 它是普通 ESM，**直接 import 即可**，不需要惰性注入，也不需要 ensureXxx()。
 *
 * ── 用法 ──
 *   await ensureECharts();          // 拿到之后即可直接用全局 echarts
 *   warmupLibs();                   // 空闲时预取（app.js 启动后调用）
 *
 * ── 注意 ──
 * 新增依赖库时：
 *   1. 这里加一个 ensureXxx()
 *   2. 从 index.html 移除对应的 <script>（否则等于没省）
 *   3. tools/check-ui.mjs 的 L 组会检查「用过但没加载」的全局库
 */

import { createLogger } from "./logger.js";

const log = createLogger("LIB");

/** key -> Promise<void>，保证同一个库只注入一次 */
const pending = new Map();

/** 各库在 window 上的全局名，用于判断是否已经可用 */
const GLOBAL_NAME = {
  echarts: "echarts",
  xlsx: "XLSX",
  jszip: "JSZip",
};

/** 各库在扩展包内的相对路径 */
const LIB_PATH = {
  echarts: "lib/js/echarts.min.js",
  xlsx: "lib/js/xlsx.full.min.js",
  jszip: "lib/js/jszip.min.js",
};

/**
 * 把包内相对路径解析成可加载的 URL
 * 扩展环境下用 chrome.runtime.getURL（绝对且不受 base 影响）；
 * 静态预览（无 chrome）下退回相对路径。
 * @param {string} relPath
 * @returns {string}
 */
function resolveUrl(relPath) {
  if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getURL) {
    return chrome.runtime.getURL(relPath);
  }
  return relPath;
}

/**
 * 注入一个全局脚本并等待其执行完成
 * @param {string} key - 库标识
 * @returns {Promise<void>}
 */
function loadScript(key) {
  const globalName = GLOBAL_NAME[key];
  // 已经可用（或本页 HTML 里还留着 <script>）→ 直接成功
  if (typeof window !== "undefined" && window[globalName] !== undefined) {
    return Promise.resolve();
  }

  if (pending.has(key)) return pending.get(key);

  const relPath = LIB_PATH[key];
  const promise = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = resolveUrl(relPath);
    script.async = true;
    script.dataset.nforceLib = key;

    script.onload = () => {
      if (window[globalName] === undefined) {
        reject(new Error(`脚本已加载但未挂载全局 ${globalName}（${relPath}）`));
        return;
      }
      log.info(`已按需加载 ${key}（${relPath}）`);
      resolve();
    };
    script.onerror = () => {
      reject(new Error(`加载 ${relPath} 失败，请确认该文件存在于扩展包内`));
    };

    (document.head || document.documentElement).appendChild(script);
  }).catch((error) => {
    // 失败要清掉缓存，否则一次失败会永久卡住后续重试
    pending.delete(key);
    log.error(`加载 ${key} 失败:`, error);
    throw error;
  });

  pending.set(key, promise);
  return promise;
}

/** ECharts（数据分析图表 + Org 状态仪表盘） */
export const ensureECharts = () => loadScript("echarts");

/** SheetJS（Excel 导入 / 导出） */
export const ensureXLSX = () => loadScript("xlsx");

/** JSZip（Bulk 结果 / Metadata 打包） */
export const ensureJSZip = () => loadScript("jszip");

/**
 * 空闲时预取「紧接着就会用到」的库，避免用户点击时还要等解析
 *
 * 默认只预热 echarts（首页 Org 状态面板要用）。
 * xlsx / jszip 只在明确的导入导出动作里用，不预热，免得白白拖慢启动。
 * （Salesforce 客户端已不再是惰性加载的全局库，见文件头。）
 *
 * @param {string[]} [keys] - 要预热的库
 */
export function warmupLibs(keys = ["echarts"]) {
  const loaders = {
    echarts: ensureECharts,
    xlsx: ensureXLSX,
    jszip: ensureJSZip,
  };
  const run = () => {
    for (const key of keys) {
      const load = loaders[key];
      if (load) load().catch(() => {});
    }
  };
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(run, { timeout: 3000 });
  } else {
    setTimeout(run, 1200);
  }
}

/** 仅供测试/调试：当前已缓存的库 */
export function _debugPendingKeys() {
  return [...pending.keys()];
}
