/**
 * 首页布局模块
 * - 图标式首页由 rules/ui_layout.json 驱动，可调整顺序 / 文案 / 配色
 * - **手机桌面式的文件夹**（2026-10-17）：布局里 `groups[]` 就是文件夹 ——
 *     · 一个分组 ≥ 2 项 → 首页上折成一个文件夹图标（2×2 迷你预览 + 名称），点开才展开
 *     · 一个分组只有 1 项 → 直接摆成应用图标（不套一个"只装一个 app"的空文件夹）
 *   想把功能并进同一个文件夹，只要在布局里把它们放进同一个 group。
 * - 「常用功能」是一份**由用户自己维护的有序列表**，不再按使用频率自动排序：
 *     · 鼠标移到任意功能图标上，点右上角的 ☆ 加入 / 移出常用功能（文件夹面板里也能加）
 *     · 点常用功能区右上角「编辑」，用 ← → 调整顺序、× 移出
 *     · 用户在界面上的改动存在 chrome.storage.local 的 ui_favorites
 *   rules/ui_layout.json 里的 favorites.ids 只是「默认列表」（首次使用或点「恢复默认」时采用）
 * - 支持在界面内直接编辑并保存布局 JSON（存 chrome.storage.local）
 */
import { createLogger } from "../common/logger.js";

const log = createLogger("LAYOUT");
import { appState } from "./state.js";
import { showSection } from "./ui.js";
import { showNotification, escapeHtml } from "../common/utils.js";
import { replaceIcons } from "../common/icons.js";
// 配色表 / 连接门禁集合 / 条目构建的唯一来源（service worker 也要用同一份，
// 所以它们住在零依赖的 common/command_index.js 里，见该文件头部说明）
import {
  PALETTE,
  SETTINGS_ONLY_STEPS,
  buildSearchEntries,
  isEntryLocked as isEntryLockedBase,
  setFullPageSteps
} from "../common/command_index.js";
// 首页「Org 状态」面板：与首页一起渲染（连接成功后 renderLauncher 会被再次调用，面板随之刷新）
import { refreshHomeDashboard } from "./org_limits.js";
// 注意：不能用 `import DEFAULT_LAYOUT from "../rules/ui_layout.json"`，
// 浏览器/扩展不支持 JSON 模块导入（会报 MIME 类型 application/json 的错误），
// 直接运行 src/ 源码或不做打包时会导致整个 app.js 加载失败、首页空白。
// 默认布局以 JS 模块形式内置，运行时优先读取 rules/ui_layout.json。
import DEFAULT_LAYOUT from "./ui_layout_default.js";

const STORAGE_KEY_LAYOUT = "ui_layout";
// 常用功能（有序 id 列表）单独存一个 key：它属于「个人偏好」，
// 与布局 JSON 解耦，编辑布局配置不会误伤用户挑出来的常用功能
const STORAGE_KEY_FAVORITES = "ui_favorites";
const LAYOUT_FILE = "rules/ui_layout.json";
// 「布局配置」功能页所属的 section 编号（在 index.html 中是 #section-20）
const LAYOUT_SECTION = 20;
// 首页布局里「公用功能」那一组的 id —— 这组点开时要整页打开（见 common/command_index.js）
const FULL_PAGE_GROUP = "tools";

/**
 * 把「公用功能」组的 step 同步给 `common/command_index.js`。
 *
 * 为什么从这里推：分组信息只在布局里有一份（rules/ui_layout.json），
 * `biz/ui.js` 的 `showSection` 又不能反过来依赖布局模块（那会形成循环依赖）。
 * 所以由布局在**生效时**推一次，`showSection` 只查一个 Set。布局一变（加载完成 /
 * 界面里应用新布局）都要再推一次，否则新旧布局会各说各话。
 */
function syncFullPageSteps() {
  const groups = (currentLayout && currentLayout.groups) || [];
  const group = groups.find((g) => g && g.id === FULL_PAGE_GROUP);
  const steps = ((group && group.tiles) || [])
    .map((tile) => Number(tile && tile.step))
    .filter((n) => Number.isFinite(n) && n > 0);
  setFullPageSteps(steps);
  log.debug(`公用功能（侧边栏里点开时整页打开）：${steps.join(", ") || "无"}`);

  // 顺手给这些 section 打上 `full-page` 类 —— 样式（整页宿主下"一屏锁"）只认这个类。
  // 为什么不直接在 index.html 上写死：那会变成第二份"哪些功能属于工具组"的清单，
  // 而唯一数据源是布局 JSON；`theme-tools` 也不行（它多罩了 OTT / CVP7 / Dashboard，
  // 又漏了 Schedule Jobs —— 那是配色主题，不是分组）。
  const wanted = new Set(steps);
  document.querySelectorAll(".step-section").forEach((section) => {
    const step = Number(String(section.id || "").replace("section-", ""));
    section.classList.toggle("full-page", wanted.has(step));
  });
}

/**
 * 某个功能此刻是否处于「未连接 → 锁定」状态。
 *
 * 实现在 `common/command_index.js`（零依赖，SW 侧也要用同一份判定）；
 * 这里只是把 `appState.is_connected` 补进去的薄包装 —— 调用方（首页磁贴、搜索面板）
 * 因此不必各自去读 appState。
 *
 * @param {number} step section 编号
 * @param {boolean} [requiresConnection] 磁贴自己的声明（默认视为需要连接）
 */
export function isEntryLocked(step, requiresConnection = true) {
  return isEntryLockedBase(step, requiresConnection, appState.is_connected);
}

let currentLayout = null;
let tileIndex = new Map();       // tileId -> { tile, group }
// 用户在界面上维护的常用功能列表；null = 从未自定义过（用配置里的默认列表）
let userFavoriteIds = null;
// 常用功能区是否处于「编辑」状态（调整顺序 / 移出）
let favoritesEditing = false;

function palette(color) {
  return PALETTE[color] || PALETTE.blue;
}

// ---------- 配置加载 ----------

function normalizeFavorites(raw) {
  const f = raw && typeof raw === "object" ? raw : {};
  // 默认常用列表：优先 ids，兼容旧配置里的 fixed / fallback 字段
  let ids = [];
  if (Array.isArray(f.ids)) ids = f.ids;
  else if (Array.isArray(f.fixed) && f.fixed.length) ids = f.fixed;
  else if (Array.isArray(f.fallback)) ids = f.fallback;

  return {
    title: f.title || "常用功能",
    max: Number(f.max) > 0 ? Number(f.max) : 8,
    ids: [...new Set(ids.filter((x) => typeof x === "string"))]
  };
}

function normalizeLayout(raw) {
  // hero 区块（渐变主视觉）已移除，布局里不再保留 hero 字段
  const layout = raw && typeof raw === "object" ? raw : {};
  const groups = Array.isArray(layout.groups) ? layout.groups : [];
  const normalizedGroups = groups
      .filter((g) => g && Array.isArray(g.tiles) && g.tiles.length > 0)
      .map((g, gi) => ({
        id: g.id || `group-${gi}`,
        title: g.title || g.id || `分组 ${gi + 1}`,
        icon: g.icon || "fa-cubes",
        color: PALETTE[g.color] ? g.color : "blue",
        // 是否折叠成文件夹：true/false = 用户整理时的显式决定，缺省则按条目数推断
        // （见 isFolderGroup）。不写进 normalize 的话，一次"应用并保存"就会把这个
        // 标记洗掉，用户从文件夹里拖走几个功能后它会突然变回独立图标。
        ...(g.folder === true || g.folder === false ? { folder: g.folder } : {}),
        tiles: g.tiles
          .filter((t) => t && t.step)
          .map((t, ti) => ({
            id: t.id || `tile-${g.id || gi}-${ti}`,
            step: Number(t.step),
            label: t.label || t.id || `功能 ${t.step}`,
            icon: t.icon || "fa-cubes",
            desc: t.desc || "",
            // 搜索别名：全局搜索额外匹配的词（拼音、缩写、英文名…）。
            // 中文标签没法用子序列匹配（"wucan" 找不到"中午食乜"），别名是唯一解；
            // 顺带让用户能在布局配置里自定义自己的叫法。
            keywords: Array.isArray(t.keywords)
              ? t.keywords.filter((k) => typeof k === "string" && k.trim())
              : [],
            requiresConnection: t.requiresConnection !== false
          }))
      }));

  /**
   * 同一个磁贴只能属于一个分组 —— 这是"拖拽整理"的前提（一个功能两处显示，
   * 用户会以为拖动没生效）。历史版本合并默认布局时可能写下过重复项，
   * 这里按"先出现的那份为准"清掉后面的，并且顺带丢掉被清空的分组。
   */
  const seen = new Set();
  const deduped = normalizedGroups
    .map((g) => ({
      ...g,
      tiles: g.tiles.filter((t) => {
        if (seen.has(t.id)) return false;
        seen.add(t.id);
        return true;
      })
    }))
    .filter((g) => g.tiles.length > 0);

  return {
    version: layout.version || 1,
    _readme: layout._readme,
    favorites: normalizeFavorites(layout.favorites),
    groups: deduped,
    // 想在首页永久隐藏某些磁贴时，把它们的 id 写在这里（删除 tile 会在下次加载时被默认配置补回）
    hidden: Array.isArray(layout.hidden) ? layout.hidden.filter((x) => typeof x === "string") : []
  };
}

function parseLayoutText(text) {
  const parsed = JSON.parse(text);
  const layout = normalizeLayout(parsed);
  if (layout.groups.length === 0) {
    throw new Error("配置中没有有效的功能分组");
  }
  return layout;
}

function readStored(key) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.get([key], (res) => resolve(res ? res[key] : undefined));
    } catch (e) {
      resolve(undefined);
    }
  });
}

function writeStored(obj) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(obj, () => resolve());
    } catch (e) {
      resolve();
    }
  });
}

/**
 * 把内置默认布局里「新增」的分组 / 磁贴合并进用户已保存的配置。
 *
 * 为什么需要：用户的配置一旦保存到 chrome.storage，就会永久覆盖默认配置，
 * 之后版本里新增的功能入口就再也看不到（曾出现「设置里找不到布局配置」）。
 * 这里的语义是：**用户配置决定顺序 / 文案 / 配色，默认配置决定功能是否存在**。
 * 想真正隐藏某个磁贴，请把它写进 hidden 数组；**整个 section 都不该再作为首页入口**
 * （比如设置类）时，把编号加进 `common/command_index.js` 的 SETTINGS_ONLY_STEPS ——
 * 那条路对"已经保存过旧配置"的用户同样生效，hidden 只存在于配置里、帮不上他们。
 *
 * favorites 同样遵循这个语义：标题 / 上限沿用用户配置，**默认常用列表始终取自
 * 默认布局**（否则新版调整的默认常用项会被旧配置吃掉）；用户自己挑的常用功能
 * 存在 ui_favorites 里，不受这里影响。
 */
function mergeWithDefault(storedLayout, baseLayout) {
  const merged = normalizeLayout(storedLayout);
  const hidden = new Set(merged.hidden);

  const groupById = new Map(merged.groups.map((g) => [g.id, g]));
  const existingTileIds = new Set();
  merged.groups.forEach((g) => g.tiles.forEach((t) => existingTileIds.add(t.id)));

  baseLayout.groups.forEach((baseGroup) => {
    const target = groupById.get(baseGroup.id);
    if (!target) {
      /**
       * 这个分组不在用户配置里了。两种可能：
       *   ① 版本新增的分组 —— 整个补进来
       *   ② **用户把里面的磁贴全搬走了**（搬空的分组会被删掉，比如拖进文件夹）
       * 只判断 ① 会在 ② 的情况下把整组连磁贴一起补回来，于是同一个功能既在文件夹里、
       * 又在首页上多出一个副本（2026-10-17 用户报「拖进 folder 后 app 依然显示在外面」，
       * 根因就是这里；刷新一次才显现，因为合并只在加载时跑）。
       * 所以这里只补「哪儿都没有」的磁贴；一个都没有就整组跳过。
       */
      const missing = baseGroup.tiles.filter((tile) => !existingTileIds.has(tile.id));
      if (!missing.length) return;
      const freshGroups = normalizeLayout({ groups: [{ ...baseGroup, tiles: missing }] }).groups;
      if (freshGroups.length) {
        merged.groups.push(freshGroups[0]);
        missing.forEach((tile) => existingTileIds.add(tile.id));
      }
      return;
    }
    // 分组已存在：把其中缺失的磁贴补到该分组末尾
    baseGroup.tiles.forEach((tile) => {
      if (existingTileIds.has(tile.id)) return;
      existingTileIds.add(tile.id);
      target.tiles.push({ ...tile });
    });
  });

  if (hidden.size) {
    merged.groups.forEach((g) => {
      g.tiles = g.tiles.filter((t) => !hidden.has(t.id));
    });
  }

  // 「设置类」section 一律不进功能区 —— 它们的入口只在顶栏齿轮里（见
  // `common/command_index.js` 的 SETTINGS_ONLY_STEPS，那里写了完整的来龙去脉）。
  // 这一步专治"出厂配置里删了、用户配置里还留着"：用户那份配置会把删掉的磁贴原样带回来，
  // 只有在这里过滤才能真的从首页消失。用户那个分组的标题叫「设置」、里面只有一个
  // 「项目说明」磁贴，剔除后整组会被下面的空组过滤一并删掉。
  merged.groups.forEach((g) => {
    g.tiles = g.tiles.filter((t) => !SETTINGS_ONLY_STEPS.has(t.step));
  });
  // 磁贴被剔空的分组就此消失（顺序：先补新增磁贴、再按 hidden / 退役集合剔除、最后删空组）
  merged.groups = merged.groups.filter((g) => g.tiles.length > 0);

  merged.hidden = [...hidden];

  merged.favorites = {
    title: merged.favorites.title,
    max: merged.favorites.max,
    ids: [...baseLayout.favorites.ids]
  };

  return merged;
}

/**
 * 数一下**原始**存储里有多少个磁贴。
 * 必须直接读原始 JSON：`normalizeLayout` 已经做过去重，拿它的结果去比永远相等，
 * 于是"storage 里存着重复项"这件事会被永远掩盖（2026-10-17 实测）。
 */
function countRawTiles(stored) {
  try {
    const raw = typeof stored === "string" ? JSON.parse(stored) : stored;
    if (!raw || !Array.isArray(raw.groups)) return -1;
    return raw.groups.reduce((n, g) => n + (Array.isArray(g && g.tiles) ? g.tiles.length : 0), 0);
  } catch (e) {
    return -1;
  }
}

export async function loadUiLayout() {
  // 默认布局（优先扩展目录下的 rules/ui_layout.json，其次 bundle 内置的 JS 默认值）
  const baseLayout = await getDefaultLayout();

  // 界面内保存的自定义配置：与默认布局合并后再使用，
  // 保证新版本新增的功能入口不会被旧的自定义配置「吃掉」
  const stored = await readStored(STORAGE_KEY_LAYOUT);
  if (stored) {
    try {
      const storedLayout = parseLayoutText(
        typeof stored === "string" ? stored : JSON.stringify(stored)
      );
      const merged = mergeWithDefault(storedLayout, baseLayout);

      /**
       * 自愈：合并过程可能**改动了**用户存的那份（清掉重复磁贴、补上新版本功能、
       * 剔除退役的 section）。这时把它写回 storage，让"存进去的"与"看到的"始终一致 ——
       * 否则每次加载都要重算一遍，而且用户下次整理时会把旧的重复项一起写回去。
       * 只在真的有差异时写（`normalizeLayout` 是确定性的，同一份输入必然同样的字符串）。
       */
      const rawTileCount = countRawTiles(stored);
      const mergedTileCount = merged.groups.reduce((n, g) => n + g.tiles.length, 0);
      if (rawTileCount !== mergedTileCount || JSON.stringify(merged) !== JSON.stringify(storedLayout)) {
        log.info(
          `已保存的布局与默认配置合并后有变化（磁贴 ${rawTileCount} → ${mergedTileCount}），写回 storage（自愈一次）`
        );
        await writeStored({ [STORAGE_KEY_LAYOUT]: JSON.stringify(merged) });
      }
      return merged;
    } catch (e) {
      log.warn("已保存的布局配置无效，回退到默认配置", e);
    }
  }

  return baseLayout;
}

export async function getDefaultLayout() {
  try {
    const res = await fetch(chrome.runtime.getURL(LAYOUT_FILE));
    if (res.ok) return parseLayoutText(await res.text());
  } catch (e) {
    /* ignore */
  }
  return normalizeLayout(DEFAULT_LAYOUT);
}

// ---------- 常用功能（有序列表，完全由用户决定） ----------

function buildTileIndex() {
  tileIndex = new Map();
  if (!currentLayout) return;
  currentLayout.groups.forEach((group) => {
    group.tiles.forEach((tile) => tileIndex.set(tile.id, { tile, group }));
  });
}

/** 丢掉不存在的 id、去重、并限制在 max 以内 */
function sanitizeFavoriteIds(ids) {
  const max = currentLayout ? currentLayout.favorites.max : 8;
  const seen = new Set();
  const out = [];
  (Array.isArray(ids) ? ids : []).forEach((id) => {
    if (typeof id !== "string" || seen.has(id) || !tileIndex.has(id)) return;
    seen.add(id);
    if (out.length < max) out.push(id);
  });
  return out;
}

/** 当前生效的常用功能列表（用户自定义优先，其次配置里的默认列表） */
function effectiveFavoriteIds() {
  return sanitizeFavoriteIds(userFavoriteIds || (currentLayout ? currentLayout.favorites.ids : []));
}

/**
 * 供**全局搜索**使用的条目列表（磁贴 + 内置页面条目）。
 *
 * 实现全部在 `common/command_index.js` 的 `buildSearchEntries()` ——
 * 注入到网页里的搜索浮层由 service worker 用**同一个函数**构建条目
 * （数据从布局 JSON 与 storage 来），所以两边不会出现"面板里搜得到、浮层里搜不到"。
 * 这里只负责把「当前布局 + 生效的常用列表 + 连接状态」喂给它。
 *
 * 布局还没加载出来（首屏失败 / 配置全坏）时磁贴那部分为空；调用方（搜索面板）
 * 仍能靠内置页面条目工作，不至于整个搜索框是空的。
 */
export function getSearchEntries() {
  return buildSearchEntries({
    // 页面侧只有一份权威布局：已经过 mergeWithDefault 处理（注入了新版新增的磁贴）
    candidates: [currentLayout],
    favoriteIds: effectiveFavoriteIds(),
    isConnected: appState.is_connected
  });
}

async function loadUserFavoriteIds() {
  const stored = await readStored(STORAGE_KEY_FAVORITES);
  const list = Array.isArray(stored)
    ? stored
    : (stored && Array.isArray(stored.ids) ? stored.ids : null);
  userFavoriteIds = list ? list.filter((x) => typeof x === "string") : null;
}

async function persistFavorites(ids) {
  userFavoriteIds = sanitizeFavoriteIds(ids);
  await writeStored({ [STORAGE_KEY_FAVORITES]: userFavoriteIds });
  await renderLauncher();
}

async function toggleFavorite(tileId) {
  if (!tileId) return;
  const list = [...effectiveFavoriteIds()];
  const at = list.indexOf(tileId);
  if (at >= 0) {
    list.splice(at, 1);
  } else {
    const max = currentLayout.favorites.max;
    if (list.length >= max) {
      showNotification(`常用功能最多 ${max} 个，请先移出一个`, "warning");
      return;
    }
    list.push(tileId);
  }
  await persistFavorites(list);
  refreshLayoutEditor();
}

async function moveFavorite(tileId, dir) {
  const list = [...effectiveFavoriteIds()];
  const from = list.indexOf(tileId);
  const to = from + dir;
  if (from < 0 || to < 0 || to >= list.length) return;
  [list[from], list[to]] = [list[to], list[from]];
  await persistFavorites(list);
  refreshLayoutEditor();
}

async function resetFavorites() {
  try {
    chrome.storage.local.remove([STORAGE_KEY_FAVORITES], () => {});
  } catch (e) {
    /* ignore */
  }
  userFavoriteIds = null;
  await renderLauncher();
  refreshLayoutEditor();
  showNotification("常用功能已恢复默认", "success");
}

// ---------- 渲染 ----------

/**
 * @param {object} tile  磁贴定义
 * @param {object} group 所属分组（决定配色）
 * @param {object} opts  { mode: "home" | "dock" | "folder", favorited, editing, index, total }
 *
 * 三种形态（2026-10-17 起首页改成「手机桌面」式方格）：
 *   home    首页方格里的应用图标：竖排（图标在上、名字在下），描述收进 tooltip
 *   dock    「常用功能」：与 home 同一套外观；编辑态换成 ← → ×
 *   folder  文件夹面板里的应用：横排（图标 + 名字 + 描述），星标常驻
 */
function tileHtml(tile, group, opts = {}) {
  const { mode = "home", favorited = false, editing = false, index = 0, total = 0 } = opts;
  const { tint, accent, soft } = palette(group.color);
  const locked = isEntryLocked(tile.step, tile.requiresConnection);

  // 常用功能处于编辑态时，磁贴不响应跳转（避免手滑点走）
  const navigable = !(mode === "dock" && editing);

  const classes = ["tile"];
  if (navigable) classes.push("step-link");
  if (locked) classes.push("locked");
  if (mode === "dock") classes.push("favorite");
  if (mode === "dock" && editing) classes.push("is-editing");
  if (mode === "folder") classes.push("in-folder");

  let overlay = "";
  if (mode === "dock" && editing) {
    overlay = `<span class="tile-edit-actions">
                    <span class="tile-edit-btn${index === 0 ? " is-disabled" : ""}" role="button" tabindex="0"
                          data-action="move" data-dir="-1" data-tile-id="${escapeHtml(tile.id)}" title="左移">←</span>
                    <span class="tile-edit-btn${index === total - 1 ? " is-disabled" : ""}" role="button" tabindex="0"
                          data-action="move" data-dir="1" data-tile-id="${escapeHtml(tile.id)}" title="右移">→</span>
                    <span class="tile-edit-btn tile-edit-remove" role="button" tabindex="0"
                          data-action="remove" data-tile-id="${escapeHtml(tile.id)}" title="移出常用功能">×</span>
                </span>`;
  } else if (mode !== "dock") {
    // aria-pressed 是 role="button" 表达"可切换"的标准方式，sighted 用户看 ★ / ☆，
    // 读屏用户只能靠它。aria-label 同理 —— 不加的话读屏会念出 "★" 这个字符本身。
    overlay = `<span class="tile-fav-btn${favorited ? " is-on" : ""}" role="button" tabindex="0"
                    aria-pressed="${favorited ? "true" : "false"}"
                    aria-label="${favorited ? "从常用功能移除" : "加入常用功能"}"
                    data-action="toggle-fav" data-tile-id="${escapeHtml(tile.id)}"
                    title="${favorited ? "从常用功能移除" : "加入常用功能"}">${favorited ? "★" : "☆"}</span>`;
  }

  // 首页方格不显示描述（一列只有 ~90px，描述会全被省略号吃掉），
  // 折进 title 里：鼠标悬停仍能读到，读屏念的是 label + 描述。
  const hint = tile.desc ? `${tile.label} · ${tile.desc}` : tile.label;

  return `<div class="tile-cell">
                <a href="#" class="${classes.join(" ")}"
                   ${mode === "dock" ? "" : 'draggable="true"'}
                   data-step="${tile.step}"
                   data-tile-id="${escapeHtml(tile.id)}"
                   title="${escapeHtml(hint)}"
                   style="--tile-tint: ${tint}; --tile-accent: ${accent}; --tile-soft: ${soft};">
                    <span class="tile-icon"><i class="fas ${escapeHtml(tile.icon)}"></i><span class="tile-lock-wrap"><i class="fas fa-lock tile-lock"></i></span></span>
                    <span class="tile-text">
                        <span class="tile-label">${escapeHtml(tile.label)}</span>
                        <span class="tile-desc">${escapeHtml(tile.desc)}</span>
                    </span>
                </a>
                ${overlay}
            </div>`;
}

/**
 * 一个分组在首页上的目标尺寸：
 *   ≥ 2 项 → 折成**文件夹**（手机桌面那种方块，里面 2×2 预览）
 *   1 项   → 直接摆成应用图标（"文件夹里只装一个 app"没有意义）
 */
const FOLDER_MIN_TILES = 2;

/**
 * 这个分组在首页上是不是「文件夹」。
 *
 * 三种情况：
 *   · `folder === true`  → 一定是文件夹（哪怕只剩 1 项 —— 那是用户自己整理成这样的，
 *                          不能因为"只剩一个"就把它变回独立图标，否则东西会越拖越乱）
 *   · `folder === false` → 一定不是（用户把一个应用"移出文件夹"后建的独立分组）
 *   · 没写（出厂布局）    → 按条目数推断：≥2 项折叠成文件夹
 * 整理动作（拖拽）会把结论写死在分组上，见 moveTileIntoFolder / moveTileOutOfFolder。
 */
function isFolderGroup(group) {
  if (!group) return false;
  const tiles = (group.tiles || []).filter(Boolean);
  if (!tiles.length) return false;
  if (group.folder === true) return true;
  if (group.folder === false) return false;
  return tiles.length >= FOLDER_MIN_TILES;
}

/**
 * 文件夹磁贴。
 *
 * 视觉参照手机桌面：一个和图标同宽同高的圆角方块，里面 2×2 迷你图标预览，
 * 名字在方块下方（与普通应用图标对齐）。超过 4 项时右下角挂一个 +N 徽标 ——
 * 不写"N 项"文字是因为 90px 宽的格子里放不下，而 +N 一眼就知道"还有更多"。
 */
function folderHtml(group) {
  const { tint, accent, soft } = palette(group.color);
  const tiles = (group.tiles || []).filter(Boolean);
  const preview = tiles
    .slice(0, 4)
    .map((t) => `<span class="folder-mini"><i class="fas ${escapeHtml(t.icon)}"></i></span>`)
    .join("");
  const extra = tiles.length > 4 ? `<span class="folder-extra">+${tiles.length - 4}</span>` : "";
  // 整组都需要连接、且当前未连接 → 与单个磁贴一致的"锁定"观感
  const allLocked = tiles.length > 0 && tiles.every((t) => isEntryLocked(t.step, t.requiresConnection));
  const lockedBadge = allLocked ? `<span class="folder-lock"><i class="fas fa-lock"></i></span>` : "";

  return `<div class="tile-cell">
                <button type="button" class="folder-tile${allLocked ? " is-locked" : ""}"
                        data-folder-id="${escapeHtml(group.id)}"
                        aria-label="打开文件夹：${escapeHtml(group.title)}，共 ${tiles.length} 个功能"
                        title="${escapeHtml(group.title)} · ${tiles.length} 个功能"
                        style="--tile-tint: ${tint}; --tile-accent: ${accent}; --tile-soft: ${soft};">
                    <span class="folder-preview" data-count="${tiles.length}">${preview}${extra}${lockedBadge}</span>
                    <span class="folder-label">${escapeHtml(group.title)}</span>
                </button>
            </div>`;
}

/**
 * 首页方格内容。
 *
 * 顺序沿用布局里 `groups[]` 的先后；每个分组要么变成一个文件夹、要么变成一枚
 * 独立图标 —— **不再有"分组卡片 + 标题 + 星标"那层壳**，这是首页变清爽的关键：
 * 8 个分组头、26 个星标、26 段描述全部退出首屏。
 */
function homeGridHtml(favoriteSet) {
  const cells = [];
  for (const group of currentLayout.groups || []) {
    const tiles = (group.tiles || []).filter(Boolean);
    if (!tiles.length) continue;
    if (isFolderGroup(group)) {
      cells.push(folderHtml(group));
    } else {
      cells.push(tileHtml(tiles[0], group, { mode: "home", favorited: favoriteSet.has(tiles[0].id) }));
    }
  }
  return cells.join("\n");
}

function favoritesHtml(favoriteIds) {
  const { title, max } = currentLayout.favorites;
  const headActions = favoritesEditing
    ? `<button type="button" class="fav-head-btn" id="favorites-reset-btn">恢复默认</button>
       <button type="button" class="fav-head-btn fav-head-btn-primary" id="favorites-done-btn">完成</button>`
    : `<span class="fav-count">${favoriteIds.length} / ${max}</span>
       <button type="button" class="fav-head-btn" id="favorites-edit-btn">编辑</button>`;

  const body = favoriteIds.length
    ? `<div class="app-grid favorites-grid">
${favoriteIds.map((id, i) => {
      const hit = tileIndex.get(id);
      if (!hit) return "";
      return tileHtml(hit.tile, hit.group, {
        mode: "dock",
        editing: favoritesEditing,
        index: i,
        total: favoriteIds.length
      });
    }).join("\n")}
                </div>`
    : `<div class="favorites-empty">
                    还没有常用功能：把鼠标移到下面任意功能图标上，点右上角的 <span class="favorites-empty-star">☆</span> 就能加进来（打开文件夹后也能加）。
                </div>`;

  const hint = favoritesEditing
    ? `<p class="favorites-hint">拖动不了？用 <b>←</b> <b>→</b> 调整顺序，用 <b>×</b> 把功能移出常用。</p>`
    : "";

  // 头部结构刻意与 groupHtml 的 .launcher-group-head 保持一致（同一套 chip 胶囊 +
  // 右侧次要信息），这样「常用功能」和下面的功能分组在视觉上是同一类卡片。
  // 见 main.css 的 .favorites-section 注释。
  return `<section class="favorites-section${favoritesEditing ? " is-editing" : ""}">
                <div class="favorites-head">
                    <span class="favorites-chip"><i class="fas fa-star"></i>${escapeHtml(title)}</span>
                    <span class="favorites-head-actions">${headActions}</span>
                </div>
                ${hint}
                ${body}
            </section>`;
}

/* ------------------------------------------------------------------ *
 * 文件夹面板（点文件夹图标 → 展开其中的功能）
 * ------------------------------------------------------------------ */

/** 当前打开的文件夹 id（null = 没开） */
let folderOpenId = null;
/** 打开前的焦点元素 —— 关闭时要还回去，否则键盘用户会丢失位置（焦点掉到 body） */
let folderReturnFocus = null;

/** 面板骨架只建一次，之后复用（避免每次开关都重建 DOM 与监听） */
function ensureFolderSheet() {
  let root = document.getElementById("folder-sheet-root");
  if (root) return root;

  root = document.createElement("div");
  root.id = "folder-sheet-root";
  root.className = "folder-sheet-root";
  root.hidden = true;
  root.innerHTML = `
    <div class="folder-sheet-backdrop" data-folder-action="close"></div>
    <div class="folder-sheet" role="dialog" aria-modal="true" aria-labelledby="folder-sheet-title">
        <div class="folder-sheet-head">
            <span class="folder-sheet-chip" id="folder-sheet-chip"></span>
            <button type="button" class="folder-sheet-title" id="folder-sheet-title"
                    data-folder-action="rename" title="点击改名"></button>
            <span class="folder-sheet-count" id="folder-sheet-count"></span>
            <button type="button" class="folder-sheet-close" data-folder-action="close" aria-label="关闭文件夹">
                <i class="fas fa-times"></i>
            </button>
        </div>
        <div class="folder-app-grid" id="folder-sheet-grid"></div>
        <!-- 只在拖动时出现：把图标拖到这里 = 移出文件夹（面板是模态的，很多屏幕尺寸下
             遮罩只剩上下一条缝，"拖到面板外"不够好点） -->
        <div class="folder-sheet-dropout" data-folder-action="move-out">拖到这里移出文件夹</div>
        <p class="folder-sheet-hint">
            <b>拖动图标可以整理</b>：拖到文件夹上加入 · 拖到另一个图标上新建文件夹 · 拖到面板外的空白处移出。
            点 <b>☆</b> 加入「常用功能」，点标题可给文件夹改名。
        </p>
    </div>`;
  document.body.appendChild(root);
  root.addEventListener("keydown", onFolderSheetKeydown);
  return root;
}

/**
 * 面板内的键盘行为：
 *   · Esc 关闭（**必须 stopPropagation**：biz/ui.js 在 document 上有「Esc 返回首页」）
 *   · Tab 在面板内循环，不让焦点跑到背后的首页
 */
function onFolderSheetKeydown(e) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeFolder();
    return;
  }
  if (e.key !== "Tab") return;

  const root = e.currentTarget;
  const list = Array.from(
    root.querySelectorAll('.folder-sheet button, .folder-sheet a[href], .folder-sheet [tabindex="0"]')
  ).filter((el) => el.offsetParent !== null);
  if (!list.length) return;

  const first = list[0];
  const last = list[list.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

/** 打开某个分组（文件夹） */
export function openFolder(groupId) {
  const group = (currentLayout.groups || []).find((g) => g && g.id === groupId);
  if (!group || !(group.tiles || []).length) return;

  const root = ensureFolderSheet();
  const favoriteSet = new Set(effectiveFavoriteIds());
  const { accent, tint } = palette(group.color);

  const chip = document.getElementById("folder-sheet-chip");
  const title = document.getElementById("folder-sheet-title");
  const count = document.getElementById("folder-sheet-count");
  const grid = document.getElementById("folder-sheet-grid");

  if (chip) {
    chip.style.setProperty("--group-accent", accent);
    chip.style.setProperty("--group-tint", tint);
    chip.innerHTML = `<i class="fas ${escapeHtml(group.icon)}"></i>`;
  }
  if (title) title.textContent = group.title;
  if (count) count.textContent = `${group.tiles.length} 个功能`;
  if (grid) {
    grid.innerHTML = group.tiles
      .map((t) => tileHtml(t, group, { mode: "folder", favorited: favoriteSet.has(t.id) }))
      .join("");
  }
  replaceIcons();

  // 把面板标题挂到 aria-labelledby 之外还需要的状态上（供自动化断言与调试）
  root.dataset.folderId = group.id;

  folderOpenId = group.id;
  folderReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;

  root.hidden = false;
  document.body.classList.add("folder-sheet-open");
  // 下一帧再上 is-open，过渡才有起点（同一帧加 class 浏览器会合并掉）
  requestAnimationFrame(() => root.classList.add("is-open"));

  const closeBtn = root.querySelector(".folder-sheet-close");
  if (closeBtn) closeBtn.focus();
}

/**
 * 关闭文件夹面板。
 * @param {{restoreFocus?: boolean}} [options] 导航走开时不必还焦点（新页面会自己安排）
 */
export function closeFolder(options = {}) {
  const restoreFocus = options.restoreFocus !== false;
  const root = document.getElementById("folder-sheet-root");
  if (!root || root.hidden) return;

  folderOpenId = null;
  root.classList.remove("is-open");
  root.removeAttribute("data-folder-id");
  document.body.classList.remove("folder-sheet-open");

  // 与 CSS 的过渡时长对齐；hidden 晚一步再上，避免"刚点完就消失"
  setTimeout(() => {
    if (!root.classList.contains("is-open")) root.hidden = true;
  }, 160);

  if (restoreFocus && folderReturnFocus && document.contains(folderReturnFocus)) {
    folderReturnFocus.focus();
  }
  folderReturnFocus = null;
}

/** 当前打开的文件夹 id（自动化断言 / 调试用） */
export function getOpenFolderId() {
  return folderOpenId;
}

/* ------------------------------------------------------------------ *
 * 整理（拖动图标）—— 2026-10-17
 *
 * 三个动作，对齐手机桌面的直觉：
 *   ① 应用 → 文件夹：拖到文件夹方块上松手 = 放进那个文件夹
 *   ② 应用 → 应用：拖到另一个独立图标上松手 = 和他一起**新建一个文件夹**
 *   ③ 从文件夹里拖到面板外（遮罩上）/ 拖到首页空白处 = 移出，变回独立图标
 *
 * 数据就是 `currentLayout.groups` 本身（没有第二份"整理结果"要同步）：
 * 一次拖动 = 改两个分组的 tiles 数组 + 写回 `ui_layout`。
 *
 * 为什么用原生 HTML5 拖放而不是自己写 pointer 事件：桌面 Chrome（侧边栏 / 标签页）
 * 的 `dragstart` + `dragover` + `drop` 已经处理好了拖影、自动滚动和"跨窗口不误触"，
 * 自己实现一套只会多出几十行容易出错的坐标计算。代价是触屏不支持 —— 触屏用户仍可
 * 用「设置 → 布局配置」改分组（这也是一条完整的整理路径）。
 * ------------------------------------------------------------------ */

/** 正在拖的磁贴 id。`dataTransfer` 在 dragover 阶段读不到数据，只能自己记一份 */
let dragTileId = null;
/** 拖动时底部那条提示条（只在拖动期间出现在页面上） */
let dragHintEl = null;

/** 某个磁贴现在属于哪个分组 */
function groupOfTile(tileId) {
  return (currentLayout.groups || []).find((g) => (g.tiles || []).some((t) => t.id === tileId)) || null;
}

/** 从分组里摘掉一个磁贴，返回它本身（找不到返回 null） */
function removeTileFrom(group, tileId) {
  const index = group.tiles.findIndex((t) => t.id === tileId);
  if (index < 0) return null;
  return group.tiles.splice(index, 1)[0];
}

/**
 * 写回布局并重绘。
 * 与「布局配置」页的「应用并保存」走同一条存储路径（`ui_layout` 存的是 JSON 字符串），
 * 所以整理完再去布局配置页，看到的就是整理后的结构 —— 两处不会各说各话。
 */
async function persistLayout(message) {
  // 磁贴被搬空的分组顺手删掉（否则首页会留下一个 0 项的空组，虽然不渲染，但配置里很脏）
  currentLayout.groups = currentLayout.groups.filter((g) => (g.tiles || []).length > 0);
  await writeStored({ [STORAGE_KEY_LAYOUT]: JSON.stringify(currentLayout) });
  syncFullPageSteps();
  await renderLauncher();
  refreshLayoutEditor();
  if (message) showNotification(message, "success");
}

/** ① 拖进文件夹 */
async function moveTileIntoFolder(tileId, targetGroupId) {
  const src = groupOfTile(tileId);
  const target = (currentLayout.groups || []).find((g) => g.id === targetGroupId);
  if (!src || !target || src.id === target.id) return;

  const tile = removeTileFrom(src, tileId);
  if (!tile) return;

  // 源分组原本是文件夹 → 写死 folder:true。否则搬走几项后它会掉到"1 项 = 独立图标"
  // 的推断分支上，用户眼看着文件夹突然变成单个应用（这很吓人，而且难以撤销）。
  if (src.folder === undefined) src.folder = true;
  target.folder = true;
  target.tiles.push(tile);

  await persistLayout(`已把「${tile.label}」放进「${target.title}」`);
}

/** ③ 移出文件夹 → 变成一个独立的单图标分组 */
async function moveTileOutOfFolder(tileId) {
  const src = groupOfTile(tileId);
  if (!src) return;

  // 文件夹里只剩它一个：不是"已经在首页"，而是**这个文件夹该解散了**。
  // 直接把分组降级成独立图标（folder:false），而不是再建一个 solo 分组 ——
  // 否则配置里会同时留下"空文件夹壳 + 单图标组"两份记录。
  if ((src.tiles || []).length <= 1) {
    if (!isFolderGroup(src)) {
      showNotification("它已经在首页上了", "info");
      return;
    }
    src.folder = false;
    await persistLayout(`「${src.title}」里只剩一个功能，已解散成独立图标`);
    return;
  }

  const tile = removeTileFrom(src, tileId);
  if (!tile) return;
  if (src.folder === undefined) src.folder = true;

  const solo = {
    id: `solo-${tile.id}`,
    title: tile.label,
    icon: tile.icon,
    color: src.color,
    // 显式 false：单图标分组永远不折成文件夹（否则以后加了一项会被自动折叠）
    folder: false,
    tiles: [tile]
  };
  const at = currentLayout.groups.indexOf(src);
  currentLayout.groups.splice(at + 1, 0, solo);

  await persistLayout(`已把「${tile.label}」移出文件夹`);
}

/** ② 拖到另一个独立图标上 → 新建文件夹（以目标那枚图标为壳，保留它的配色） */
async function createFolderFromDrop(draggedId, targetTileId) {
  if (!draggedId || !targetTileId || draggedId === targetTileId) return;
  const srcGroup = groupOfTile(draggedId);
  const targetGroup = groupOfTile(targetTileId);
  if (!srcGroup || !targetGroup || srcGroup.id === targetGroup.id) return;
  // 目标本身是文件夹的话，走的是 ①，这里只处理"图标叠图标"
  if (isFolderGroup(targetGroup)) return;

  const dragged = removeTileFrom(srcGroup, draggedId);
  const target = removeTileFrom(targetGroup, targetTileId);
  if (!dragged || !target) return;

  const shell = {
    id: `folder-${Date.now().toString(36)}`,
    title: "新建文件夹",
    icon: "fa-cubes",
    color: targetGroup.color,
    folder: true,
    tiles: [target, dragged]
  };
  // 插在**目标原来的位置**（用户会预期新文件夹出现在他松手的那个格子上）
  const at = Math.max(0, currentLayout.groups.indexOf(targetGroup));
  currentLayout.groups.splice(at, 0, shell);

  await persistLayout(`已新建文件夹，里面是「${target.label}」和「${dragged.label}」`);
  // 顺手打开并进入改名状态：新建文件夹的第一件事几乎一定是起名
  openFolder(shell.id);
  beginTitleEdit();
}

/** 文件夹改名（点面板标题就地编辑） */
async function renameGroup(groupId, title) {
  const group = (currentLayout.groups || []).find((g) => g.id === groupId);
  const name = String(title || "").trim();
  if (!group || !name || group.title === name) return;
  group.title = name;
  await persistLayout(`文件夹已改名为「${name}」`);
}

/**
 * 把面板标题切成输入框（就地改名）。
 * 用 input 而不是 window.prompt：prompt 会遮住面板，还拿不到输入法候选框的位置。
 */
function beginTitleEdit() {
  const root = document.getElementById("folder-sheet-root");
  const btn = document.getElementById("folder-sheet-title");
  const groupId = root && root.dataset.folderId;
  if (!btn || !groupId) return;
  const group = (currentLayout.groups || []).find((g) => g.id === groupId);
  if (!group) return;

  const input = document.createElement("input");
  input.type = "text";
  input.className = "ant-input folder-sheet-title-input";
  input.value = group.title;
  input.maxLength = 24;
  input.setAttribute("aria-label", "文件夹名称");
  btn.replaceWith(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async (save) => {
    if (finished) return;
    finished = true;
    if (save) await renameGroup(groupId, input.value);

    const restored = document.createElement("button");
    restored.type = "button";
    restored.id = "folder-sheet-title";
    restored.className = "folder-sheet-title";
    restored.setAttribute("data-folder-action", "rename");
    restored.title = "点击改名";
    restored.textContent = group.title;
    input.replaceWith(restored);
  };

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      // 拦住 document 上那条「Esc 返回首页」
      e.stopPropagation();
      finish(false);
    }
  });
  input.addEventListener("blur", () => finish(true));
}

/* ---------- 拖放事件（全部委托在 document 上，列表每次重建也不用重绑） ---------- */

function clearDropTargets() {
  document.querySelectorAll(".is-drop-target").forEach((el) => el.classList.remove("is-drop-target"));
  document.body.classList.remove("is-drop-on-grid");
}

function ensureDragHint() {
  if (dragHintEl && document.body.contains(dragHintEl)) return dragHintEl;
  dragHintEl = document.createElement("div");
  dragHintEl.className = "drag-hint";
  dragHintEl.textContent = "拖到文件夹上加入 · 拖到另一个图标上新建文件夹 · 拖到空白处移出";
  document.body.appendChild(dragHintEl);
  return dragHintEl;
}

function onDragStart(e) {
  const tile = e.target.closest && e.target.closest(".tile");
  if (!tile || tile.classList.contains("is-editing")) return;
  // 常用功能区不参与整理（那是有序列表，用「编辑」里的 ← → 管）
  if (tile.closest(".favorites-grid")) return;

  const id = tile.getAttribute("data-tile-id");
  if (!id) return;
  dragTileId = id;
  tile.classList.add("is-dragging");
  document.body.classList.add("is-dragging-tile");
  ensureDragHint();
  try {
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", id);
  } catch (err) {
    log.warn("设置拖放数据失败（不影响拖动本身）:", err);
  }
}

function onDragEnd() {
  dragTileId = null;
  document.body.classList.remove("is-dragging-tile");
  document.querySelectorAll(".is-dragging").forEach((el) => el.classList.remove("is-dragging"));
  clearDropTargets();
}

function onDragOver(e) {
  if (!dragTileId) return;
  const folderEl = e.target.closest && e.target.closest(".folder-tile");
  const tileEl = e.target.closest && e.target.closest(".tile");
  const backdrop = e.target.closest && e.target.closest(".folder-sheet-backdrop");
  const dropout = e.target.closest && e.target.closest('[data-folder-action="move-out"]');

  // 目标不合法（拖到自己身上）就什么都不做，让光标显示"不可放置"
  if (tileEl && tileEl.getAttribute("data-tile-id") === dragTileId) return;

  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";

  clearDropTargets();
  if (folderEl) folderEl.classList.add("is-drop-target");
  else if (tileEl) tileEl.closest(".tile-cell").classList.add("is-drop-target");
  else if (dropout || backdrop) (dropout || backdrop).classList.add("is-drop-target");
  else if (e.target.closest && e.target.closest("#launcher-view")) {
    document.body.classList.add("is-drop-on-grid");
  }
}

function onDrop(e) {
  if (!dragTileId) return;
  const dragged = dragTileId;
  const folderEl = e.target.closest && e.target.closest(".folder-tile");
  const tileEl = e.target.closest && e.target.closest(".tile");
  const backdrop = e.target.closest && e.target.closest(".folder-sheet-backdrop");
  const dropout = e.target.closest && e.target.closest('[data-folder-action="move-out"]');

  if (!folderEl && !tileEl && !backdrop && !dropout && !(e.target.closest && e.target.closest("#launcher-view"))) return;
  e.preventDefault();

  // 先把手势状态清干净再动数据：动完会重绘首页，残留的 class 会挂到新 DOM 上
  const draggedId = dragged;
  onDragEnd();

  if (folderEl) {
    moveTileIntoFolder(draggedId, folderEl.getAttribute("data-folder-id"));
    return;
  }
  if (dropout || backdrop) {
    // 拖到投放区 / 面板外的遮罩 = 移出（面板随即关闭，能看到它落到首页）
    closeFolder({ restoreFocus: false });
    moveTileOutOfFolder(draggedId);
    return;
  }
  if (tileEl) {
    const targetId = tileEl.getAttribute("data-tile-id");
    const targetGroup = groupOfTile(targetId);
    if (targetGroup && isFolderGroup(targetGroup)) {
      // 面板里拖到同组的另一条：等于没动
      if (groupOfTile(draggedId) === targetGroup) return;
      moveTileIntoFolder(draggedId, targetGroup.id);
      return;
    }
    createFolderFromDrop(draggedId, targetId);
    return;
  }
  // 拖到首页空白处 = 移出文件夹
  moveTileOutOfFolder(draggedId);
}

export async function renderLauncher() {
  if (!currentLayout) return;
  buildTileIndex();

  const favoriteIds = effectiveFavoriteIds();
  const favoriteSet = new Set(favoriteIds);

  const favHost = document.getElementById("favorites-host");
  if (favHost) favHost.innerHTML = favoritesHtml(favoriteIds);

  const groupsHost = document.getElementById("launcher-groups");
  if (groupsHost) {
    groupsHost.innerHTML = `<div class="app-grid">${homeGridHtml(favoriteSet)}</div>`;
  }

  replaceIcons();

  // 首页「Org 状态」面板：未连接显示占位、已连接显示 Limits 摘要
  // （放 replaceIcons 之后，面板内部会自己再调一次 replaceIcons）
  try {
    refreshHomeDashboard();
  } catch (e) {
    log.warn("渲染首页 Org 状态面板失败:", e);
  }

  // 给自动化验证用：把当前状态挂到 DOM 上（对用户无副作用）
  const section = document.getElementById("launcher-view");
  if (section) {
    section.dataset.favoriteIds = JSON.stringify(favoriteIds);
    section.dataset.favoritesEditing = favoritesEditing ? "true" : "false";
    section.dataset.favoritesCustomized = userFavoriteIds ? "true" : "false";
    section.dataset.favoritesMax = String(currentLayout.favorites.max);
  }
}

// ---------- 布局配置（「设置 → 布局配置」功能页，section-20） ----------

function layoutToJsonText(layout) {
  const clean = {
    _readme: layout._readme || "调整 groups[].tiles 顺序即可改变图标排列；想永久隐藏某个磁贴请把它的 id 写进 hidden 数组；tile.keywords 是「全局搜索」额外匹配的别名（拼音 / 缩写 / 英文名），中文标签不写别名就只能用汉字搜到；favorites.ids 是「常用功能」的默认列表 —— 界面上的改动（卡片右下角 ☆ / 常用功能区「编辑」）会自动保存在本地，改这里只会影响恢复默认后的结果。",
    version: layout.version,
    favorites: {
      title: layout.favorites.title,
      max: layout.favorites.max,
      ids: effectiveFavoriteIds()
    },
    hidden: layout.hidden || [],
    groups: layout.groups
  };
  return JSON.stringify(clean, null, 2);
}

// 把当前布局写回 JSON 编辑器（布局配置页 section-20 打开时调用）
export function refreshLayoutEditor() {
  const input = document.getElementById("layout-json-input");
  if (!input || !currentLayout) return;
  input.value = layoutToJsonText(currentLayout);
}

async function applyLayoutFromPanel() {
  const input = document.getElementById("layout-json-input");
  if (!input) return;
  try {
    const layout = parseLayoutText(input.value);
    currentLayout = layout;
    syncFullPageSteps(); // 新布局里的「工具」组可能变了，整页打开的集合要跟着变
    await writeStored({ [STORAGE_KEY_LAYOUT]: JSON.stringify(layout) });

    // JSON 里显式写了 favorites.ids 时，视为用户重新指定了常用功能
    const jsonIds = layout.favorites.ids;
    if (jsonIds && jsonIds.length) {
      buildTileIndex();
      userFavoriteIds = sanitizeFavoriteIds(jsonIds);
      await writeStored({ [STORAGE_KEY_FAVORITES]: userFavoriteIds });
    }

    await renderLauncher();
    // 回写规范化后的配置（补齐默认值 / 统一缩进），方便用户继续微调
    refreshLayoutEditor();
    showNotification("布局已应用并保存", "success");
  } catch (e) {
    log.error("配置解析失败", e);
    showNotification(`布局配置有误：${e.message}`, "error");
  }
}

async function resetLayout() {
  try {
    chrome.storage.local.remove([STORAGE_KEY_LAYOUT], () => {});
  } catch (e) {
    /* ignore */
  }
  currentLayout = await getDefaultLayout();
  buildTileIndex();
  await renderLauncher();
  refreshLayoutEditor();
  showNotification("已恢复默认布局", "success");
}

function exportLayout() {
  const blob = new Blob([layoutToJsonText(currentLayout)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "ui_layout.json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  showNotification("布局 JSON 已导出", "success");
}

// ---------- 初始化 ----------

export async function initUiLayout() {
  currentLayout = await loadUiLayout();
  syncFullPageSteps();
  await loadUserFavoriteIds();
  await renderLauncher();

  // 首页交互（内容动态渲染，统一使用事件委托）
  document.addEventListener("click", (e) => {
    // 0) 文件夹图标：展开其中的功能；面板的关闭按钮 / 背景遮罩：收起
    const folderTile = e.target.closest(".folder-tile");
    if (folderTile) {
      e.preventDefault();
      openFolder(folderTile.getAttribute("data-folder-id"));
      return;
    }
    if (e.target.closest('[data-folder-action="close"]')) {
      e.preventDefault();
      closeFolder();
      return;
    }
    if (e.target.closest('[data-folder-action="rename"]')) {
      e.preventDefault();
      beginTitleEdit();
      return;
    }

    // 1) 卡片右下角 ☆ / ★：加入或移出常用功能
    const favBtn = e.target.closest(".tile-fav-btn");
    if (favBtn) {
      e.preventDefault();
      e.stopPropagation();
      toggleFavorite(favBtn.getAttribute("data-tile-id"));
      return;
    }

    // 2) 常用功能区「编辑态」的 ← → ×
    const editBtn = e.target.closest(".tile-edit-btn");
    if (editBtn) {
      e.preventDefault();
      e.stopPropagation();
      if (editBtn.classList.contains("is-disabled")) return;
      const tileId = editBtn.getAttribute("data-tile-id");
      const action = editBtn.getAttribute("data-action");
      if (action === "remove") {
        persistFavorites(effectiveFavoriteIds().filter((id) => id !== tileId));
      } else {
        moveFavorite(tileId, parseInt(editBtn.getAttribute("data-dir"), 10));
      }
      return;
    }

    // 3) 常用功能区头部：编辑 / 完成 / 恢复默认
    if (e.target.closest("#favorites-edit-btn")) {
      favoritesEditing = true;
      renderLauncher();
      return;
    }
    if (e.target.closest("#favorites-done-btn")) {
      favoritesEditing = false;
      renderLauncher();
      return;
    }
    if (e.target.closest("#favorites-reset-btn")) {
      resetFavorites();
      return;
    }

    // 4) 普通磁贴：进入对应功能
    const link = e.target.closest(".step-link");
    if (!link || !link.classList.contains("tile")) return;
    e.preventDefault();
    const step = parseInt(link.getAttribute("data-step"), 10);
    if (!step) return;
    showSection(step);
  });

  /* 整理：拖动图标（见上方"整理（拖动图标）"一节）。
     四个事件都委托在 document 上 —— 首页每次重绘都会换掉全部磁贴节点，
     绑在节点上的监听会跟着丢。 */
  document.addEventListener("dragstart", onDragStart);
  document.addEventListener("dragend", onDragEnd);
  document.addEventListener("dragover", onDragOver);
  document.addEventListener("drop", onDrop);

  /* 星标（☆ / ★）与编辑态按钮（← → ×）是 <span role="button" tabindex="0">。
     role + tabindex 只承诺了"能被 Tab 聚焦、被读屏念成按钮"，**不附带任何键盘行为**
     —— 浏览器只对真正的 <button> 自动把 Enter/Space 转成 click。原来这里只有 click
     委托，于是键盘用户 Tab 到星标、按回车，什么都不会发生（实测 className 不变）。
     统一在这里把两个键翻译成 click，走同一条委托逻辑，不复制一份动作代码。
     Space 必须 preventDefault，否则会顺带把页面往下滚。 */
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar") return;
    const target = e.target instanceof Element ? e.target.closest(".tile-fav-btn, .tile-edit-btn") : null;
    if (!target) return;
    e.preventDefault();
    target.click();
  });

  // 配置面板（现在是「设置 → 布局配置」里的一个功能页 section-20）
  const applyBtn = document.getElementById("layout-apply-btn");
  if (applyBtn) applyBtn.addEventListener("click", applyLayoutFromPanel);
  const exportBtn = document.getElementById("layout-export-btn");
  if (exportBtn) exportBtn.addEventListener("click", exportLayout);
  const resetBtn = document.getElementById("layout-reset-btn");
  if (resetBtn) resetBtn.addEventListener("click", resetLayout);

  // 进入该功能页时刷新编辑器内容；同时收起文件夹面板（点面板里的功能会走这里）
  window.addEventListener("nforce:section", (e) => {
    closeFolder({ restoreFocus: false });
    if (e.detail && e.detail.section === LAYOUT_SECTION) {
      refreshLayoutEditor();
    }
  });

  // 回到首页时退出常用功能编辑态，避免磁贴一直处于「不可点击」状态；文件夹面板一并收起
  window.addEventListener("nforce:home", () => {
    closeFolder({ restoreFocus: false });
    if (favoritesEditing) {
      favoritesEditing = false;
      renderLauncher();
    }
  });
}
