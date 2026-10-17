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
 * 三个库都是 UMD / 全局脚本（挂 window.X），不是 ESM，因此不能用 import()，
 * 改为「首次需要时注入 <script> 并等待 onload」，用 Promise 记忆化保证只注入一次。
 * 扩展页面是同源的，注入自己包内的脚本不违反 MV3 的 script-src 'self'。
 *
 * ⚠️ **例外**：`marked` 是 ESM（不挂 window），走 `ensureMarked()` 里的动态 `import()` ——
 * 见那个函数上方的说明（它原本被 app.js 静态 import，40KB 无条件进首屏）。
 *
 * ── Salesforce 客户端不在这里 ──
 * jsforce（1.37MB）已于 2026-09-28 被自研的 `common/sf_rest_client.js`（约 8KB）取代，
 * 它是普通 ESM，**直接 import 即可**，不需要惰性注入，也不需要 ensureXxx()。
 *
 * ── 用法 ──
 *   await ensureECharts();          // 拿到之后即可直接用全局 echarts
 *   await ensureMarked();           // 返回 marked 模块对象（不是全局）
 *   warmupLibs();                   // 空闲时预取（app.js 启动后调用）
 *
 * ── 注意 ──
 * 新增依赖库时：
 *   1. 这里加一个 ensureXxx()（UMD 库进 GLOBAL_NAME / LIB_PATH 两张表；ESM 库照 ensureMarked 写）
 *   2. 从 index.html 移除对应的 <script>（否则等于没省）
 *   3. tools/check-ui.mjs 的 L 组会检查「用过但没加载」的全局库
 */

import { createLogger } from "./logger.js";
import { showNotification } from "./utils.js";

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

/**
 * 原生 ESM 的第三方库：用动态 `import()` 加载（`<script>` 那个口子拿不到导出）。
 *
 * 目前只有 CodeMirror 走这条路 —— 它上游就是纯 ESM，用 esbuild 打成**单文件**放进
 * `lib/js/codemirror.bundle.js`（见 `tools/build-codemirror.mjs`）。
 * 缓存与失败重试的语义和 `loadScript` 一致：同一个库只加载一次，失败后允许重试。
 */
const esmPending = new Map();

export function loadModule(relPath) {
  const key = relPath;
  if (esmPending.has(key)) return esmPending.get(key);

  const promise = import(resolveUrl(relPath)).catch((error) => {
    esmPending.delete(key);
    log.error(`加载 ${key} 失败:`, error);
    throw error;
  });

  esmPending.set(key, promise);
  return promise;
}

/** CodeMirror 6（SOQL 编辑器的语法高亮 / 行号 / 补全） */
export const ensureCodeMirror = () => loadModule("lib/js/codemirror.bundle.js");

/** ECharts（数据分析图表 + Org 状态仪表盘） */
export const ensureECharts = () => loadScript("echarts");

/** SheetJS（Excel 导入 / 导出） */
export const ensureXLSX = () => loadScript("xlsx");

/** JSZip（Bulk 结果 / Metadata 打包） */
export const ensureJSZip = () => loadScript("jszip");

/**
 * 「按需加载 SheetJS，并给用户一句人话」的统一包装。
 *
 * 迁移自 `common/excel_utils.js` 与 `biz/inspector_tools.js` —— 那两份**逐字相同**
 * （只有 logger 的 TAG 不同），留着两份就会在改文案/改加载方式时漏改一处。
 * 调用方只需 `if (!(await requireXLSX())) return;`。
 *
 * @returns {Promise<boolean>} 是否可用
 */
export async function requireXLSX() {
  try {
    await ensureXLSX();
    return true;
  } catch (error) {
    log.error("加载 XLSX 库失败:", error);
    showNotification("加载 Excel 处理库失败：" + (error.message || error), "error");
    return false;
  }
}

/**
 * marked（Markdown 渲染：版本信息里的 README、LTS 概览）
 *
 * ⚠️ 它**不在上面那两张表里**，因为机制不同：marked 发布的是 **ESM**（`export { marked }`），
 * 不挂 `window`，所以不能用「注入 <script> 等 onload」那一套 —— 用 `import()`。
 *
 * 为什么值得单独拿出来懒加载（2026-10-15）：它原本被 `app.js` **静态 import**，
 * 于是 40KB 无条件进主包；而它只在两处用到（进「版本信息」看 README、进「LTS 概览」）。
 * 改成动态 import 后，V8 会把它切成独立 chunk：不进首屏，只在真要渲染文档时才取。
 * （这正是 `INEFFECTIVE_DYNAMIC_IMPORT` 警告的反面 —— 那个模块没被别处静态引用，所以切得开。）
 *
 * @returns {Promise<{parse: Function, setOptions: Function}>}
 */
let markedPending = null;
export function ensureMarked() {
  if (!markedPending) {
    markedPending = import("../lib/js/marked.min.js")
      .then((m) => m.marked)
      .catch((error) => {
        // 失败要清缓存，否则一次失败会永久卡住后续重试（同 loadScript 的约定）
        markedPending = null;
        log.error("加载 marked 失败:", error);
        throw error;
      });
  }
  return markedPending;
}

/**
 * 按需加载 Apex 日志解析器（`@apexdevtools/apex-log-parser` 的 vendor 副本）。
 *
 * 为什么走动态 `import()` 而不是上面那套 `loadScript`：
 *   ① 它是 **ESM only**（包内没有 CJS 构建），而 `loadScript` 注入的是经典 `<script>`；
 *   ② 它约 115KB，只在「View Log」页真的要分析一份日志时才该被取下来 ——
 *      动态 import 会让打包器把它切成独立 chunk（同 `ensureMarked` 的道理）。
 *
 * ⚠️ 路径是**包内的相对路径**（`../lib/js/...`）而不是裸模块名 —— `src/` 本身就是可直接
 * 加载的扩展目录，裸说明符在浏览器里解析不了（详见该文件头的说明）。
 *
 * @returns {Promise<Function>} 库的 `parse(logText)` 函数
 */
let apexLogParserPending = null;
export function ensureApexLogParser() {
  if (!apexLogParserPending) {
    apexLogParserPending = import("../lib/js/apex-log-parser.js")
      .then((m) => {
        if (typeof m.parse !== "function") {
          throw new Error("apex-log-parser 没有导出 parse()");
        }
        return m.parse;
      })
      .catch((error) => {
        // 同 ensureMarked：失败必须清缓存，否则一次失败会永久卡住后续重试
        apexLogParserPending = null;
        log.error("加载 apex-log-parser 失败:", error);
        throw error;
      });
  }
  return apexLogParserPending;
}

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
