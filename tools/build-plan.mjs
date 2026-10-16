/**
 * 构建计划：**打包入口** + **逐字复制清单**（单一来源）
 *
 * ── 为什么单独抽一个文件 ──
 * 这份信息同时被两处需要，而且过去只活在 webpack.config.js 里：
 *   ① `vite.config.mjs` —— 决定打包入口（Rolldown input），以及把哪些文件原样搬进 dist
 *   ② `tools/check-ui.mjs` 的 J 组 —— 判断「HTML / manifest 里的相对引用在 dist 里到底
 *      存不存在」、以及「被逐字复制的 JS 里 import 的目标有没有一起复制过去」
 * 以前守卫只能靠正则去啃 webpack 配置，换个打包器就整体失效（甚至退化成一条 WARN）。
 * 现在两边 import 同一份数据：配置一改，守卫立刻跟着变，不会再漂移。
 *
 * ── 核心约定（换打包器也不能丢）──
 * `src/` 目录本身就是**可以直接加载进 Chrome 的扩展目录**，所以它必须保持
 * 「原生 ESM + 手写 HTML」的形态。dist/ 只是同一份东西加上两个打包产物：
 *   · 只有 `app.js` / `login_app.js` 两个入口需要打包（它们 import 了整棵依赖树）
 *   · 其余文件（手写 HTML、manifest、service worker、内容脚本、页面外壳脚本、
 *     静态资源、按需注入的第三方库）**一律逐字复制**，不做任何转换
 * 复制型文件里的相对 import 会在运行时按 dist 的实际布局解析，因此
 * 「它 import 的东西也必须被复制」——这条由 check-ui 的 J 组强制。
 */

/**
 * Rollup/Rolldown 入口：`key` 就是 dist 里的文件名（`<key>.js`）。
 * ⚠️ 键名不可改：`index.html` / `login.html` 是**手写并逐字复制**的 HTML，
 * 里面写死了 `./app.js` / `login_app.js`，没有 html 插件来改写引用。
 * 一旦让打包器插手文件名（例如加 content hash），页面会静默变成空壳。
 * check-ui 的 J2 守这条。
 */
export const ENTRIES = {
  app: "src/app.js",
  login_app: "src/login_app.js",
};

/**
 * 逐字复制清单。`from` 可以是单个文件，也可以是目录（递归）。
 *
 * · `exclude`          相对 `from` 的路径，支持精确匹配与 `dir/**` 前缀匹配
 * · `excludeBasenames` 任意层级下按文件名排除
 *
 * 每条规则都对应一个真实踩过的坑，见下面的注释 —— 删之前先读一遍。
 */
export const COPY_RULES = [
  { from: "src/manifest.json", to: "manifest.json" },
  // 三个页面都是手写 HTML：只引用各自的入口 bundle，或 lib/ 下的静态脚本。
  // 交给打包器处理反而会被塞进 assets/ 并改写路径，故原样复制。
  { from: "src/index.html", to: "index.html" },
  { from: "src/login.html", to: "login.html" },
  { from: "src/popup.html", to: "popup.html" },
  // ESM service worker（manifest 里 `type: "module"`）。它 import ./common/logger.js
  // 与 ./common/prefs.js，所以下面这三条复制规则是配套的，不是冗余。
  { from: "src/background.js", to: "background.js" },
  // popup 的页面外壳脚本（图标替换 / 版本号 / 绑定按钮）。
  // 不能写成 popup.html 的内联 <script>：CSP `script-src 'self'` 会把内联脚本
  // 整段拒绝执行，且不产生任何页面可见异常。
  { from: "src/popup_app.js", to: "popup_app.js" },
  // login.html / popup.html 页面外壳的 <script type="module"> 直接
  // `import ... from "./common/icons.js"` —— 不复制就是 404 → replaceIcons()
  // 从不执行 → 页面上的 <i class="fa-*"> 全退化成空白方块。
  // icons.js 自身零 import，可作原生 ESM 直接使用。
  { from: "src/common/icons.js", to: "common/icons.js" },
  // background.js（ESM service worker）与 ui.js 都依赖它。
  { from: "src/common/logger.js", to: "common/logger.js" },
  // prefs.js     ← 依赖 logger.js 与 api_version.js
  // api_version.js ← 零依赖，纯常量与解析器
  { from: "src/common/prefs.js", to: "common/prefs.js" },
  { from: "src/common/api_version.js", to: "common/api_version.js" },
  // ui_events.js ← 零依赖。**必须复制**：它是 background.js（逐字复制的 ESM
  // service worker）与 app.js（打包入口）之间共享的消息名 / storage 键。
  // 少这一条 → dist/background.js 的 import 404 → SW 整条模块图加载失败，
  // 而表现只是"快捷键没反应"（check-ui 的 J 组会拦这条）。
  { from: "src/common/ui_events.js", to: "common/ui_events.js" },
  // shortcut.js ← 零依赖纯函数。prefs.js 引用它做快捷键校验，而 prefs.js 又被 SW
  // 静态 import（loadPrefs）→ 必须复制，否则 SW 的模块图在求值前就整体失败。
  { from: "src/common/shortcut.js", to: "common/shortcut.js" },
  // 下面四个是**全局搜索**那条链路的共享模块（2026-10-15 起）：
  //   fuzzy.js         模糊匹配（纯函数，配 test/fuzzy.test.js）
  //   command_index.js 条目构建 + 配色表 + 连接门禁集合（SW 与页面共用的唯一来源）
  //   cmdk_view.js     结果 HTML / 面板骨架渲染（同上）
  //   utils.js         cmdk_view 只要它里面的 escapeHtml
  // background.js 是逐字复制的 ESM service worker，它 import 的上游在 dist 里
  // 必须真实存在 —— 少一条就是"网页里搜不出来"，而页面上不会有任何报错。
  { from: "src/common/fuzzy.js", to: "common/fuzzy.js" },
  { from: "src/common/command_index.js", to: "common/command_index.js" },
  { from: "src/common/cmdk_view.js", to: "common/cmdk_view.js" },
  { from: "src/common/utils.js", to: "common/utils.js" },
  // order_query.js：cmdk_view 用它判断"这段输入像不像 Order 标识"（合成搜索条目），
  // 而 cmdk_view 又被打包进 app.js 且被 background.js 静态 import —— 少这一条，
  // SW 加载整条模块图时就会 404（表现是"浮层打不开"，页面上毫无痕迹）。
  // 它本身零依赖（纯字符串/SOQL 拼装），符合"被 SW import 就必须零依赖"的约定。
  { from: "src/common/order_query.js", to: "common/order_query.js" },
  // 网页内的搜索浮层：**经典脚本、零依赖**，由 service worker 用
  // chrome.scripting.executeScript 注入到当前标签页（文件名在 background.js 里写死为
  // SEARCH_OVERLAY_FILE）。既不打包也不改写成 ESM，只逐字复制 ——
  // 里面一旦出现 import/export，注入时会直接 SyntaxError，且只在 SW 日志里能看到。
  { from: "src/search_overlay.js", to: "search_overlay.js" },
  {
    from: "src/icons",
    to: "icons",
    // 开发期文件，不该随包发布（2026-10-15 清出）：
    //   logo_generator.html —— 图标生成器（本地打开用，README 里写的就是它）；
    //   README.md           —— 给维护者看的图标说明。
    // 运行时只用到四个 icon-NN.png + nforce-tools.svg（后者被 index.html 引用）。
    excludeBasenames: ["logo_generator.html", "README.md", "excel-16.png", ".DS_Store"],
  },
  {
    from: "src/rules",
    to: "rules",
    // 运行时只 fetch ui_layout.json（磁贴布局）；两个 *_sample.json 是**示例数据**，
    // 全仓没有任何代码读它们（2026-10-15 核对），打进包里只会让人以为"这是配置"。
    excludeBasenames: ["lunch_places_sample.json", "rules_sample.json", ".DS_Store"],
  },
  { from: "src/docs", to: "docs" },
  {
    from: "src/lib/css",
    to: "lib/css",
    // antd.full.css 是 vendored 源头（545KB 完整版）。tools/purge-antd-css.mjs 会把
    // 它裁剪成 antd.min.css 再发布，源头打进扩展只是白占体积。
    exclude: ["antd.full.css"],
    // macOS 元数据，曾被原样复制进 dist。
    excludeBasenames: [".DS_Store"],
  },
  {
    from: "src/lib/js",
    to: "lib/js",
    // cometd 是**原生 ESM**，biz/inspector_tools.js 用
    // `import("../lib/js/cometd/cometd.js")` 按需加载 —— 这是个静态字符串字面量，
    // 打包器会把它解析进懒加载 chunk（只有进「事件监听」才请求）。
    // 再复制 15 个源文件进 dist 纯属死重量：产物走 chunk，永远不读这些文件。
    //
    // ⚠️ 这条排除成立的前提是那个 import 保持**静态字符串字面量**。
    // 若改成 chrome.runtime.getURL("lib/js/cometd/cometd.js") 之类绕过打包器的写法，
    // 必须同时删掉这条排除，否则运行时会 404。
    exclude: ["cometd/**"],
    excludeBasenames: [".DS_Store"],
  },
];

/**
 * 判断目录复制时某个相对路径是否应被跳过。被 vite.config.mjs 的复制插件与
 * check-ui 共同引用（守卫要靠它算出「排除之后 dist 里到底该有什么」）。
 * @param {string} relPosix 相对 `from` 的 POSIX 路径，如 "cometd/cometd.js"
 * @param {{exclude?: string[], excludeBasenames?: string[]}} rule
 * @returns {boolean}
 */
export function isExcluded(relPosix, rule) {
  const base = relPosix.split("/").pop();
  if ((rule.excludeBasenames || []).includes(base)) return true;
  return (rule.exclude || []).some((pattern) => {
    if (pattern.endsWith("/**")) return relPosix === pattern.slice(0, -3) || relPosix.startsWith(pattern.slice(0, -2));
    return relPosix === pattern;
  });
}
