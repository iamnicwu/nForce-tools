/**
 * 搜索索引：把布局配置变成「可搜索条目」的唯一实现。
 *
 * ── 为什么单独一个模块、而且必须零依赖 ──
 * 有两处要构建同一份索引：
 *   ① 插件自己的搜索面板（`biz/ui_layout.js` → `getSearchEntries()`，浏览器里渲染）；
 *   ② service worker 里的 `search:index` 处理（把条目下发给注入到**网页**里的浮层）。
 * 后者是 `background.js`（逐字复制的 ESM service worker）**静态 import** 的模块，
 * 所以它不能拖任何依赖进来：只许纯数据与纯函数。
 * 只要两边各写一份，迟早会出现"面板里搜得到、网页浮层里搜不到"这种只在特定入口复现的差异。
 *
 * 于是这里也是 `PALETTE`（磁贴配色映射）与 `CONNECTION_REQUIRED_STEPS`（连接门禁集合）
 * 的**唯一来源** —— 它们原先在 `biz/ui_layout.js` 里，但 SW 不可能去 import 那个模块
 * （它拖着 ui.js / org_limits.js 一整棵树）。
 *
 * ⚠️ `CONNECTION_REQUIRED_STEPS` 这个常量名被 `tools/check-ui.mjs` 的 D 组盯着
 * （它要拿这份集合去和布局 JSON / index.html 的 `needs-connection` 三方对齐）。
 * 搬迁时同步改了守卫的读取位置，**别再挪**。
 */

/**
 * 配色表：tint 用于图标底色，accent 用于强调色，soft 用于磁贴悬浮底色。
 * 色值统一指向 main.css :root 的 `--accent-*` 令牌（自定义属性可以链式代入，
 * 所以这里写 `var(--accent-blue)` 会解析成 :root 里的实际色值）。
 * 以前这是独立于 main.css `.theme-*` 与 index.html `--row-accent` 的第三份重复色板，
 * 现在搜索条目也复用它 —— 所以整张表搬到了这个零依赖模块里。
 */
export const PALETTE = Object.freeze({
  blue:   { tint: "var(--accent-blue-tint)", accent: "var(--accent-blue)", soft: "var(--accent-blue-soft)" },
  purple: { tint: "var(--accent-purple-tint)", accent: "var(--accent-purple)", soft: "var(--accent-purple-soft)" },
  orange: { tint: "var(--accent-volcano-tint)", accent: "var(--accent-volcano)", soft: "var(--accent-volcano-soft)" },
  pink:   { tint: "var(--accent-pink-tint)", accent: "var(--accent-pink)", soft: "var(--accent-pink-soft)" },
  amber:  { tint: "var(--accent-amber-tint)", accent: "var(--accent-amber)", soft: "var(--accent-amber-soft)" },
  green:  { tint: "var(--accent-green-tint)", accent: "var(--accent-green)", soft: "var(--accent-green-soft)" },
  teal:   { tint: "var(--accent-teal-tint)", accent: "var(--accent-teal)", soft: "var(--accent-teal-soft)" },
  // indigo / gray 只被「内置页面条目」用（见 STATIC_ENTRIES），布局 JSON 里没用到
  indigo: { tint: "var(--accent-indigo-tint)", accent: "var(--accent-indigo)", soft: "var(--accent-indigo-soft)" },
  gray:   { tint: "var(--accent-gray-tint)", accent: "var(--accent-gray)", soft: "var(--accent-gray-soft)" }
});

/**
 * 「内置页面」条目：它们不占首页磁贴（见 `tools/check-ui.mjs` 的 INTERNAL_SECTIONS），
 * 但正是最需要搜索的那一类 —— 用户知道"有个地方能改 API 版本"，却记不住在哪。
 *
 * 放在这里而不是面板模块里：**注入到网页的浮层也要能搜到它们**，
 * 而那个浮层的条目是 service worker 用同一个函数组装的。
 */
export const STATIC_ENTRIES = Object.freeze([
  {
    id: "page:settings", step: 21, label: "设置", desc: "连接 · 布局 · 插件偏好",
    icon: "fa-cog", color: "gray", groupTitle: "设置",
    keywords: ["settings", "shezhi", "配置"]
  },
  {
    id: "page:prefs", step: 28, label: "插件偏好", desc: "API 版本 · 侧边栏 · 贴边浮窗",
    icon: "fa-cog", color: "teal", groupTitle: "设置",
    keywords: ["prefs", "pianhao", "api", "偏好", "side panel"]
  },
  {
    id: "page:layout", step: 20, label: "布局配置", desc: "首页图标排列 · 常用功能",
    icon: "fa-th-large", color: "purple", groupTitle: "设置",
    keywords: ["layout", "buju", "布局", "磁贴"]
  },
  {
    id: "page:limits", step: 27, label: "Org 用量详情", desc: "Salesforce Limits 完整列表",
    icon: "fa-tachometer-alt", color: "indigo", groupTitle: "Org 状态",
    keywords: ["limits", "yongliang", "用量", "配额", "org"]
  },
  {
    id: "page:home", step: null, action: "home", label: "返回首页", desc: "回到功能中心",
    icon: "fa-home", color: "blue", groupTitle: "快捷操作",
    keywords: ["home", "shouye", "首页", "fanhui", "返回"]
  }
]);

/**
 * 「设置类」section：入口统一在顶栏齿轮（设置总览页 section-21 里各有一行 data-goto），
 * **不作为首页功能磁贴、也不作为搜索里的磁贴条目**出现。
 *
 * 为什么需要这个集合：首页磁贴与搜索条目都是「出厂布局 + 用户本地保存的那份布局」
 * 合并出来的，而用户那份会**永久覆盖**出厂配置（见 `biz/ui_layout.js` 的 `mergeWithDefault`：
 * 它的语义是"用户配置决定顺序 / 文案，默认配置决定功能是否存在"，但早期只实现了"补新增"，
 * 没实现"删废弃"）。「项目说明」在早期版本里是首页磁贴，用户保存过之后，**后面即使从出厂
 * 配置里删掉，他的首页上照样还在** —— 2026-10-16 用户反馈的「右上角已经有设置了，
 * 功能区里不该再有一个」正是这条路径：他首页上那个「设置」分组里只有「项目说明」一个磁贴。
 *
 * 过滤必须落在**两个消费点**上，漏一个就会出现"首页没了、搜索里还搜得到"的自相矛盾：
 *   · `entriesFromLayout`（搜索索引 —— 插件面板与注入到网页的浮层共用同一个函数）
 *   · `biz/ui_layout.js` 的 `mergeWithDefault`（首页磁贴渲染）
 * 这几项在搜索里的入口由 `STATIC_ENTRIES`（page:settings / page:layout / page:prefs）
 * 提供，走的是另一条通道，不受本集合影响（设置入口不会因此消失）。
 *
 * ⚠️ 与 `CONNECTION_REQUIRED_STEPS` 一样，改动要同步 `tools/check-ui.mjs`（Q 组：
 * 出厂布局里不得出现这些 step 的磁贴，且本常量必须能被解析到）。
 */
export const SETTINGS_ONLY_STEPS = new Set([
  6, // 项目说明（设置页里的一行 data-goto=6）
  20, // 布局配置（设置页 item）
  21, // 设置总览（顶栏齿轮）
  28 // 插件偏好（设置页 item）
]);

/**
 * 需要连接 Salesforce 才能使用的功能（section 编号）。
 *
 * 与布局 JSON 里磁贴自己的 `requiresConnection` 声明**缺一不可**：
 * 只声明不登记 → 未连接时看着能点、点进去被弹回连接设置；只登记不声明同理。
 * `tools/check-ui.mjs` 的 D 组把这三处（本集合 / 布局 JSON / index.html 的
 * `needs-connection` 类）对齐检查。
 */
export const CONNECTION_REQUIRED_STEPS = new Set([
  2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 22, 23, 24, 25, 26, 27, 29,
  // 30 = Order 历史（要先连上才能查）
  30
]);

/**
 * 某个功能此刻是否处于「未连接 → 锁定」状态。
 * @param {number} step
 * @param {boolean} [requiresConnection] 磁贴自己的声明（默认视为需要连接）
 * @param {boolean} isConnected 当前连接状态（**由调用方传入**，本模块不碰 appState）
 */
export function isEntryLocked(step, requiresConnection, isConnected) {
  return (
    requiresConnection !== false &&
    CONNECTION_REQUIRED_STEPS.has(Number(step)) &&
    !isConnected
  );
}

function asColorName(raw) {
  return PALETTE[raw] ? raw : "blue";
}

function normalizeKeywords(raw) {
  return Array.isArray(raw) ? raw.filter((k) => typeof k === "string" && k.trim()) : [];
}

/**
 * 布局候选里挑一个能用的（按优先级）。
 *
 * 入参既可以是**已规范化的布局对象**（页面侧传 `currentLayout`），
 * 也可以是**原始 JSON 文本**（SW 侧从 `rules/ui_layout.json` 读到的）——
 * 两种情况都容错处理，省得调用方各自写一遍解析与校验。
 * 返回 null 表示一个都用不了（调用方至少还有内置页面条目，不会白屏）。
 */
function pickLayout(candidates) {
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (!candidate) continue;
    let layout = candidate;
    if (typeof candidate === "string") {
      try {
        layout = JSON.parse(candidate);
      } catch (e) {
        continue;
      }
    }
    if (layout && Array.isArray(layout.groups) && layout.groups.some((g) => g && Array.isArray(g.tiles) && g.tiles.length)) {
      return layout;
    }
  }
  return null;
}

/** 布局里的「默认常用列表」（`favorites.ids`），供 SW 侧在没有 storage 记录时兜底 */
export function defaultFavoriteIds(candidates) {
  const layout = pickLayout(candidates);
  const ids = layout && layout.favorites && Array.isArray(layout.favorites.ids) ? layout.favorites.ids : [];
  return ids.filter((x) => typeof x === "string");
}

/**
 * 构建可搜索条目。
 *
 * 三条约定（与 `biz/ui_layout.js` 的 `getSearchEntries()` 完全一致，因为就是它调的本函数）：
 *   ① **返回顺序即"空查询时的展示顺序"** —— 常用功能在前（按用户自己的顺序），
 *      其余磁贴按布局顺序。模糊匹配算法对空查询不重排，靠的就是这一点。
 *   ② 配色已解析成 CSS 变量字符串（`var(--accent-xxx-tint)`），调用方直接塞进 style。
 *   ③ `locked` 直接算好，避免"磁贴灰着、搜索结果里却点得进去"这种自相矛盾。
 *
 * @param {Array<object|string>} candidates 布局候选（按优先级），见 `pickLayout`
 * @param {{favoriteIds?: string[], isConnected?: boolean}} opts
 */
export function entriesFromLayout(candidates, opts = {}) {
  const layout = pickLayout(candidates);
  if (!layout) return [];

  const isConnected = !!opts.isConnected;
  const all = [];

  layout.groups.forEach((group) => {
    if (!group || !Array.isArray(group.tiles)) return;
    const color = asColorName(group.color);
    const { tint, accent } = PALETTE[color];
    group.tiles.forEach((tile, index) => {
      if (!tile || !tile.step) return;
      const step = Number(tile.step);
      // 「设置类」section 不进功能区：用户本地保存的那份布局里可能还留着这些磁贴
      // （早期版本当过首页入口），所以过滤要落在这里，而不是只在出厂配置里删掉。
      if (SETTINGS_ONLY_STEPS.has(step)) return;
      const id = tile.id || `tile-${group.id || "g"}-${index}`;
      all.push({
        id: `tile:${id}`,
        tileId: id,
        step,
        label: tile.label || id,
        desc: tile.desc || "",
        icon: tile.icon || "fa-cubes",
        tint,
        accent,
        groupTitle: group.title || group.id || "",
        keywords: normalizeKeywords(tile.keywords),
        requiresConnection: tile.requiresConnection !== false,
        locked: isEntryLocked(step, tile.requiresConnection, isConnected),
        favorite: false
      });
    });
  });

  // 常用功能前置：搜索框一打开（还没输入）时，用户最想看到的顺序就是他自己的常用顺序。
  // ⚠️ 这里用的是**用户存的那份**（storage 的 ui_favorites），不是布局里的默认列表 ——
  // `biz/ui_layout.js` 已经做过"用户优先、其次默认"的挑选，它传进来的就是生效值。
  const favoriteIds = Array.isArray(opts.favoriteIds) ? opts.favoriteIds : [];
  const byTileId = new Map(all.map((e) => [e.tileId, e]));
  const ordered = [];
  favoriteIds.forEach((id) => {
    const entry = byTileId.get(id);
    if (entry && !entry.favorite) {
      entry.favorite = true;
      ordered.push(entry);
    }
  });
  all.forEach((entry) => {
    if (!entry.favorite) ordered.push(entry);
  });
  return ordered;
}

/** 把 STATIC_ENTRIES 变成与磁贴条目同形状的对象（补上配色与锁定态） */
function staticEntries(isConnected) {
  return STATIC_ENTRIES.map((raw) => {
    const { tint, accent } = PALETTE[raw.color] || PALETTE.blue;
    const step = typeof raw.step === "number" ? raw.step : null;
    return {
      id: raw.id,
      tileId: null,
      step,
      action: raw.action || null,
      label: raw.label,
      desc: raw.desc,
      icon: raw.icon,
      tint,
      accent,
      groupTitle: raw.groupTitle,
      keywords: normalizeKeywords(raw.keywords),
      requiresConnection: true,
      // 内置页面里只有 section-27（Org 用量详情）真需要连接 —— 它不在 showSection
      // 的未连接白名单里，未连接时点它会被弹回连接设置，所以要和磁贴一样显示锁定态。
      locked: step === null ? false : isEntryLocked(step, true, isConnected),
      favorite: false
    };
  });
}

/**
 * 完整的搜索条目列表（磁贴 + 内置页面）。
 *
 * **这是两处入口（插件内的面板 / 注入到网页的浮层）唯一的条目来源** ——
 * 面板侧传已规范化的布局，SW 侧传「storage 里那份 + 出厂 JSON 文本」两个候选，
 * 由 `pickLayout` 按优先级挑一个。
 *
 * @param {{candidates: Array<object|string>, favoriteIds?: string[], isConnected?: boolean}} opts
 * @returns {Array<object>} 顺序即"空查询时的展示顺序"：常用功能在前
 */
export function buildSearchEntries(opts = {}) {
  return [
    ...entriesFromLayout(opts.candidates, opts),
    ...staticEntries(!!opts.isConnected)
  ];
}
