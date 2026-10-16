/**
 * 扩展页面 ⇄ Service Worker 之间的 UI 消息名与共享 storage 键。
 *
 * ── 为什么单独一个文件 ──
 * 「按快捷键唤起搜索框」这条链路的两端**不在同一个模块图里**：
 *   · 发送端是 `background.js` —— ESM service worker，被逐字复制进 dist，不经打包器；
 *   · 接收端是 `biz/command_palette.js` —— 被打包进 app.js 的扩展页面模块。
 * 如果两边各写一个字面量，改一边就会变成「快捷键没反应、且控制台一片安静」，
 * 而且这种不一致**任何静态检查都抓不到**（两边各自都合法）。所以键名收在这里。
 *
 * ⚠️ 本文件是 `background.js` 的**静态 import**，因此必须：
 *   ① 零依赖（别 import logger / prefs，否则整条依赖树被打进 SW）；
 *   ② 出现在 `tools/build-plan.mjs` 的 COPY_RULES 里 —— 复制型 JS 的相对 import
 *      在 dist 里是浏览器按真实布局解析的，少复制一个文件就是 ESM 加载失败。
 *      check-ui 的 J 组会拦这条。
 */

/** runtime 消息类型（扩展页面 ⇄ SW ⇄ 注入到网页的浮层） */
export const UI_MESSAGE = Object.freeze({
  /** SW → 扩展页面：唤起全局搜索面板。页面收到后**同步**回执 { ok: true } 表示已接单 */
  OPEN_SEARCH: "ui:open-search",
  /**
   * SW → 扩展页面：请跳到某个功能（`{ step, orderValue? }`；不带 step 表示"只把插件打开"）。
   * 与 `OPEN_SEARCH` 同一套路：可见的页面先接单，没人接才由 SW 打开侧边栏。
   *
   * `orderValue` 是可选参数：搜索框里输入 Order 的 Name / Id / OrderNumber 时，
   * 目标页（section-30 Order 历史）要拿它自动查一次。带参数的两条路径
   * （消息直达 / `PENDING_SECTION` 待办）必须保持一致 —— 少带一处，
   * 表现就是"有时带得进去、有时进去是空页"。
   */
  GOTO_SECTION: "ui:goto-section",
  /**
   * 网页里的搜索浮层（`src/search_overlay.js`）→ SW 的四个消息。
   *
   * ⚠️ 浮层是**复制型的经典脚本**，连 import 都不能有，所以那四个名字在它文件里
   * 只能写成字面量。为避免两边改名后"消息没人应答"这种静默故障，
   * `tools/check-ui.mjs` 的 P 组会逐字对比这两处的字面量 —— **改名的唯一入口是这里**。
   */
  SEARCH_OPEN: "search:open",
  SEARCH_QUERY: "search:query",
  SEARCH_SELECT: "search:select",
  SEARCH_LOG: "search:log"
});

/** `chrome.storage.session` 里的键（session 区随浏览器关闭清空，不落盘） */
export const UI_STORAGE = Object.freeze({
  /**
   * 「请把搜索面板打开」的一次性请求时间戳。
   *
   * 为什么不能只靠 runtime 消息：侧边栏**没打开时页面上没有任何监听者**，
   * 消息发出去必然石沉大海。所以这条路是「先 open 侧边栏 → 写时间戳 →
   * 新页面在启动时读到它 → 自己把面板打开」。反过来，页面已经在跑的时候
   * 消息就能直达，此时**不写**时间戳，免得下一个刚打开的页面莫名其妙地弹面板。
   */
  OPEN_SEARCH_TOKEN: "ui_search_token",
  /**
   * 「请进入某个功能」的一次性请求（`{ step, orderValue?, at }`）。与上面同一套路：
   * 侧边栏是在**没有页面接单**时才被打开的，那时只有靠这枚标记把意图带进去。
   * `orderValue` 见 `GOTO_SECTION` 的说明。
   */
  PENDING_SECTION: "ui_pending_section"
});

/**
 * 上面那个时间戳的保鲜期（毫秒）。
 *
 * 超过它就认为这枚请求已经过期（例如侧边栏打开失败、用户很久以后才手动点开面板），
 * 不再自动弹搜索框 —— 避免"我什么都没按，它自己跳出来"。
 *
 * 取值要留出余量：新页面要跑完 initApp 前半段（载入偏好、渲染首页、拉布局 JSON）
 * 才会读到这枚 token。给到 10s 既覆盖慢机器，又不至于让"很久以后"误触发。
 */
export const SEARCH_TOKEN_TTL_MS = 10000;

/**
 * 「进入某个功能」请求的保鲜期（毫秒）。比搜索那条宽松得多，因为这条路径上
 * 页面可能还要先**自动连一次 Salesforce**（网络往返 + 可能的重试）才轮到读它，
 * 而读它是在启动流程的末尾。给到 30s 仍远小于"用户手动打开面板"的时间尺度，
 * 不会出现"过很久突然自己跳页"。
 */
export const PENDING_SECTION_TTL_MS = 30000;

