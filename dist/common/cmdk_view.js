/**
 * 搜索结果的**唯一渲染实现**（纯字符串，不碰 DOM）。
 *
 * ── 为什么是纯函数 ──
 * 同一份结果要出现在两个地方：
 *   ① 插件自己的搜索面板（`biz/command_palette.js`，浏览器里 `innerHTML` 塞进 `#cmdk-list`）；
 *   ② 注入到**网页**里的搜索浮层（`background.js` 把渲染好的 HTML 通过消息下发，
 *      因为浮层是复制型的经典脚本、不能 import 任何模块，见 `src/search_overlay.js`）。
 * 两处渲染逻辑各写一遍的话，"面板里高亮是对的、网页浮层里不对"这类差异只能靠人眼发现。
 *
 * ── 两个关键决定 ──
 *   ① **直接产出内联 SVG**（而不是 `<i class="fas fa-xxx">` 等着 `replaceIcons()` 去替换）：
 *      网页浮层是内容脚本、**拿不到 icons.js**，`<i>` 在那里永远是空白方块。
 *      顺带把面板侧那个"每次重渲染后必须再调 replaceIcons()"的隐形约定也去掉了。
 *   ② 空查询**只出常用功能**（`resolveScope`），没有常用功能才回落到全量 ——
 *      这个面板是"敲两个字跳过去"用的，一打开就铺满一屏等于把首页的滚动搬进来。
 */
import { escapeHtml } from "./utils.js";
import { Icons, IconMap } from "./icons.js";
import { rankByFuzzy, fuzzyScore } from "./fuzzy.js";
// 零依赖模块：它同时被 service worker（逐字复制、不经打包器）拿来渲染浮层结果，
// 所以只能 import 这种不拖 sf_service / ui.js 的文件。
import { detectOrderQuery } from "./order_query.js";
import { PALETTE } from "./command_index.js";

/** 结果最多渲染这么多行 —— 再多的命中用户也不会往下翻，徒增 DOM 与滚动成本 */
export const MAX_RESULTS = 40;

/**
 * 图标类名 → 内联 SVG。
 * 拿不到映射时返回空串（宁可缺一个图标，也不要漏出一个永远不会被替换的 `<i>`）。
 * 布局里用到的每个 `fa-*` 都有单测保证能解析出来（`test/cmdk_view.test.js`）。
 */
export function svgFor(iconClass) {
  const key = IconMap[String(iconClass || "")];
  return key && Icons[key] ? Icons[key] : "";
}

/** 一个条目的可匹配字段与权重。标题权重最高，别名关键词次之（拼音/缩写主要靠它）。 */
export function fieldsOf(entry) {
  const fields = [
    { text: entry.label, weight: 1, kind: "label" },
    { text: entry.desc, weight: 0.45, kind: "desc" },
    { text: entry.groupTitle, weight: 0.5, kind: "group" },
    // id 去掉 `tile:` / `page:` 前缀：用户在配置里看到的就是 `t4-list` 这种写法
    { text: String(entry.id).split(":").pop(), weight: 0.6, kind: "id" }
  ];
  for (const kw of entry.keywords || []) {
    fields.push({ text: kw, weight: 0.92, kind: "keywords" });
  }
  return fields;
}

/**
 * 输入看起来像 Order 标识时，合成一条「查询 Order 历史」的条目。
 *
 * 为什么在这里（渲染层）而不是条目索引里：条目索引是**打开面板时构建一次**的，
 * 而「这行字要不要出现」取决于**当前输入**。放在渲染层还有一个好处 ——
 * 面板与网页浮层共用 `renderList`，两边同时就有了，不用各接一次。
 *
 * 判据（`detectOrderQuery`）刻意保守：只认 15/18 位 Id、纯数字、
 * 带 -/_ 且含数字的业务号 —— 否则正常的功能搜索（t4list、wucan）会被顶掉。
 *
 * @param {string} query
 * @returns {object|null} 与 `rankByFuzzy` 同形状的一行（item 是合成条目）
 */
export function orderLookupRow(query) {
  const hit = detectOrderQuery(query);
  if (!hit) return null;
  const { tint, accent } = PALETTE.amber;
  return {
    item: {
      id: `order:${hit.value}`,
      tileId: null,
      step: 30, // Order 历史（见 biz/order_history.js 的 ORDER_HISTORY_STEP）
      action: "order-history",
      orderValue: hit.value,
      label: `查询 Order 历史：${hit.value}`,
      desc: "按 Name / Id / Order Number 查字段变更记录",
      icon: "fa-clock",
      tint,
      accent,
      groupTitle: "Order 查询",
      keywords: [],
      // 锁定态交给落地那一侧判（app.js 的 gotoSection 会先自动连一次再跳）——
      // 这里若显示成灰锁定，用户会以为「未连接就不能搜」。
      locked: false,
      favorite: false
    },
    index: -1,
    score: Number.MAX_SAFE_INTEGER,
    field: null,
    positions: [],
    text: ""
  };
}

/**
 * 决定本次展示的范围。
 * @returns {{scope: "favorites"|"all", pool: Array}}
 */
export function resolveScope(query, entries) {
  const needle = String(query ?? "").trim();
  const favorites = entries.filter((e) => e.favorite);
  // 有输入就搜全量；没输入且确实有常用功能时只出常用；一个新装/清空过的用户回落到全量
  if (needle || !favorites.length) return { scope: "all", pool: entries };
  return { scope: "favorites", pool: favorites };
}

/**
 * 逐字符转义并在命中处插入 `<mark>`。
 * 逐字符（而不是先转义整串再按下标插）是因为转义会改变长度，
 * 一旦某个字符被转成 `&amp;` 之类，预先算好的下标就全部错位。
 */
export function markAt(text, positions) {
  const marked = new Set(positions || []);
  let out = "";
  let open = false;
  const value = String(text ?? "");
  for (let i = 0; i < value.length; i++) {
    const hit = marked.has(i);
    if (hit && !open) {
      out += "<mark>";
      open = true;
    } else if (!hit && open) {
      out += "</mark>";
      open = false;
    }
    out += escapeHtml(value[i]);
  }
  return open ? `${out}</mark>` : out;
}

/** 列表末尾的非可选提示行（不属于结果集，因此不参与点击与方向键） */
export function hintHtml(text) {
  return `<div class="cmdk-hint">${escapeHtml(text)}</div>`;
}

/**
 * 面板骨架（标题行 + 结果列表 + 键位提示）。
 *
 * 两个入口共用：插件内的 `#cmdk-overlay` 与注入到网页的浮层 shadow root，
 * 都是 `root.innerHTML = shellHtml()`。**不要再在 HTML 里手写一份** ——
 * 两份骨架最容易出的问题是 id 对不上（`#cmdk-input` 改名后一半坏掉），
 * 而那在截图上完全看不出来。
 *
 * 图标一律用 `svgFor()` 内联 SVG：浮层是内容脚本、拿不到 `icons.js`，
 * 写 `<i class="fas fa-*">` 等着 `replaceIcons()` 在那边永远是空白方块。
 */
export function shellHtml() {
  return `<div class="cmdk-panel" role="dialog" aria-modal="true" aria-label="搜索功能">
                <div class="cmdk-search">
                    <span class="cmdk-search-icon">${svgFor("fa-search")}</span>
                    <input type="text" id="cmdk-input" class="cmdk-input"
                           placeholder="搜索功能…（支持模糊匹配，如 t4 / vvip / 午餐）"
                           autocomplete="off" spellcheck="false" role="combobox"
                           aria-autocomplete="list" aria-expanded="false"
                           aria-controls="cmdk-list" aria-label="搜索功能">
                    <span class="cmdk-esc-hint">Esc</span>
                </div>
                <div class="cmdk-list" id="cmdk-list" role="listbox" aria-label="搜索结果"></div>
                <div class="cmdk-foot">
                    <span class="cmdk-foot-item cmdk-foot-nav"><b>↑</b><b>↓</b> 选择</span>
                    <span class="cmdk-foot-item cmdk-foot-open"><b>↵</b> 打开</span>
                    <span class="cmdk-foot-item cmdk-foot-esc"><b>Esc</b> 关闭</span>
                    <span class="cmdk-foot-count" id="cmdk-count"></span>
                </div>
            </div>`;
}

/**
 * 按「这一行自己的匹配」渲染某个字段。
 *
 * ⚠️ 高亮**不能只跟"得分最高的那个字段"走**：条目的别名关键词（`tile.keywords`）
 * 常常才是最高分 —— 例如搜 `t4`，条目 t4-list 的 keywords 里有 "t4"（完全相同，
 * 1000×0.92 胜出），于是"命中字段"是关键词，而可见的标题「T-4 Outstanding」
 * 本身也明确命中了却不显示高亮，看起来像"搜了没命中"。
 * 所以每个可见字段各自算一次自己的匹配位置（纯函数，几微秒）。
 */
function fieldHtmlByQuery(text, query) {
  const value = String(text ?? "");
  const needle = String(query ?? "").trim();
  if (!needle) return escapeHtml(value);
  const hit = fuzzyScore(needle, value);
  return hit && hit.positions.length ? markAt(value, hit.positions) : escapeHtml(value);
}

export function itemHtml(hit, index, activeIndex, query = "") {
  const entry = hit.item;
  const active = index === activeIndex;
  const classes = ["cmdk-item"];
  if (active) classes.push("is-active");
  if (entry.locked) classes.push("is-locked");

  const badge = entry.favorite ? "常用" : entry.groupTitle;
  const lock = entry.locked
    ? `<span class="cmdk-item-lock" title="需要先连接 Salesforce">${svgFor("fa-lock")}</span>`
    : "";

  return `<div class="${classes.join(" ")}" id="cmdk-item-${index}" role="option"
               aria-selected="${active ? "true" : "false"}" data-index="${index}">
                <span class="cmdk-item-icon" style="--cmdk-tint: ${entry.tint}; --cmdk-accent: ${entry.accent};">
                    ${svgFor(entry.icon)}
                </span>
                <span class="cmdk-item-text">
                    <span class="cmdk-item-label">${fieldHtmlByQuery(entry.label, query)}</span>
                    <span class="cmdk-item-desc">${fieldHtmlByQuery(entry.desc, query)}</span>
                </span>
                <span class="cmdk-item-meta">
                    ${lock}
                    <span class="cmdk-item-group">${escapeHtml(badge)}</span>
                </span>
            </div>`;
}

/**
 * 渲染整份结果列表。
 *
 * @param {{query?: string, entries: Array, activeIndex?: number}} params
 * @returns {{html: string, rows: Array, count: number, total: number, scope: string,
 *            favorites: number, firstLabel: string, firstLocked: boolean,
 *            activeLabel: string, lockedCount: number}}
 *          `rows` 是 `rankByFuzzy` 的输出（点击/方向键按它的下标取值）。
 *          html 已含空态与提示行，调用方直接 `innerHTML =` 即可。
 */
export function renderList({ query = "", entries = [], activeIndex = 0 } = {}) {
  const { scope, pool } = resolveScope(query, entries);
  const ranked = rankByFuzzy(query, pool, fieldsOf);
  // 合成的「查询 Order 历史」**固定占第一条**：用户输入的是一串单号时，
  // 这才是他想要的；功能条目照常排在后面（按 ↓ 或继续打字即可）。
  const lookup = orderLookupRow(query);
  const rows = (lookup ? [lookup, ...ranked] : ranked).slice(0, MAX_RESULTS);
  const index = Math.max(0, Math.min(Number(activeIndex) || 0, Math.max(0, rows.length - 1)));

  let html;
  if (!rows.length) {
    const needle = String(query).trim();
    html = `<div class="cmdk-empty">${
      needle
        ? `没有找到与「${escapeHtml(needle)}」匹配的功能`
        : "暂无可用的功能，请检查「设置 → 布局配置」"
    }</div>`;
  } else {
    let hint = "";
    if (scope === "favorites") {
      hint = hintHtml("输入关键词可搜索全部功能");
    } else if (!String(query).trim() && !entries.some((e) => e.favorite)) {
      // 没有常用功能才会走到这里（回落成全量）：顺手告诉用户怎么把常用挑出来
      hint = hintHtml("还没有常用功能：在首页把鼠标移到功能卡片上，点右下角 ☆ 即可加入");
    }
    html = rows.map((hit, i) => itemHtml(hit, i, index, query)).join("") + hint;
  }

  const first = rows[0] ? rows[0].item : null;
  const active = rows[index] ? rows[index].item : null;
  return {
    html,
    rows,
    count: rows.length,
    total: entries.length,
    scope,
    favorites: entries.filter((e) => e.favorite).length,
    firstLabel: first ? first.label : "",
    firstLocked: !!first && !!first.locked,
    activeLabel: active ? active.label : "",
    lockedCount: rows.filter((h) => h.item.locked).length
  };
}
