/**
 * 首页布局模块
 * - 图标式首页由 rules/ui_layout.json 驱动，可调整顺序 / 文案 / 配色
 * - 「常用功能」是一份**由用户自己维护的有序列表**，不再按使用频率自动排序：
 *     · 鼠标移到任意功能卡片上，点右下角的 ☆ 加入 / 移出常用功能
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
  isEntryLocked as isEntryLockedBase
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
  return {
    version: layout.version || 1,
    _readme: layout._readme,
    favorites: normalizeFavorites(layout.favorites),
    groups: groups
      .filter((g) => g && Array.isArray(g.tiles) && g.tiles.length > 0)
      .map((g, gi) => ({
        id: g.id || `group-${gi}`,
        title: g.title || g.id || `分组 ${gi + 1}`,
        icon: g.icon || "fa-cubes",
        color: PALETTE[g.color] ? g.color : "blue",
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
      })),
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
      // 整个分组都是新增的
      const freshGroups = normalizeLayout({ groups: [baseGroup] }).groups;
      if (freshGroups.length) merged.groups.push(freshGroups[0]);
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
      return mergeWithDefault(storedLayout, baseLayout);
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
 * @param {object} group 所属分组
 * @param {object} opts  { mode: "group" | "favorite", favorited, editing, index, total }
 */
function tileHtml(tile, group, opts = {}) {
  const { mode = "group", favorited = false, editing = false, index = 0, total = 0 } = opts;
  const { tint, accent, soft } = palette(group.color);
  const locked = isEntryLocked(tile.step, tile.requiresConnection);

  // 常用功能处于编辑态时，磁贴不响应跳转（避免手滑点走）
  const navigable = !(mode === "favorite" && editing);

  const classes = ["tile"];
  if (navigable) classes.push("step-link");
  if (locked) classes.push("locked");
  if (mode === "favorite") {
    classes.push("favorite");
    if (editing) classes.push("is-editing");
  }

  let overlay = "";
  if (mode === "favorite" && editing) {
    overlay = `<span class="tile-edit-actions">
                    <span class="tile-edit-btn${index === 0 ? " is-disabled" : ""}" role="button" tabindex="0"
                          data-action="move" data-dir="-1" data-tile-id="${escapeHtml(tile.id)}" title="左移">←</span>
                    <span class="tile-edit-btn${index === total - 1 ? " is-disabled" : ""}" role="button" tabindex="0"
                          data-action="move" data-dir="1" data-tile-id="${escapeHtml(tile.id)}" title="右移">→</span>
                    <span class="tile-edit-btn tile-edit-remove" role="button" tabindex="0"
                          data-action="remove" data-tile-id="${escapeHtml(tile.id)}" title="移出常用功能">×</span>
                </span>`;
  } else if (mode === "group") {
    // aria-pressed 是 role="button" 表达"可切换"的标准方式，sighted 用户看 ★ / ☆，
    // 读屏用户只能靠它。aria-label 同理 —— 不加的话读屏会念出 "★" 这个字符本身。
    overlay = `<span class="tile-fav-btn${favorited ? " is-on" : ""}" role="button" tabindex="0"
                    aria-pressed="${favorited ? "true" : "false"}"
                    aria-label="${favorited ? "从常用功能移除" : "加入常用功能"}"
                    data-action="toggle-fav" data-tile-id="${escapeHtml(tile.id)}"
                    title="${favorited ? "从常用功能移除" : "加入常用功能"}">${favorited ? "★" : "☆"}</span>`;
  }

  return `<div class="tile-cell">
                <a href="#" class="${classes.join(" ")}"
                   data-step="${tile.step}"
                   data-tile-id="${escapeHtml(tile.id)}"
                   style="--tile-tint: ${tint}; --tile-accent: ${accent}; --tile-soft: ${soft};">
                    <span class="tile-icon"><i class="fas ${escapeHtml(tile.icon)}"></i></span>
                    <span class="tile-text">
                        <span class="tile-label">${escapeHtml(tile.label)}</span>
                        <span class="tile-desc">${escapeHtml(tile.desc)}</span>
                    </span>
                    <span class="tile-lock-wrap"><i class="fas fa-lock tile-lock"></i></span>
                </a>
                ${overlay}
            </div>`;
}

/** 渲染一个功能分组（磁贴统一带「加入常用」星标） */
function groupHtml(group, favoriteSet) {
  const { accent, tint } = palette(group.color);
  const tiles = group.tiles
    .map((t) => tileHtml(t, group, { mode: "group", favorited: favoriteSet.has(t.id) }))
    .join("\n");
  // --tile-count 给 CSS 的 --span 用（棋盘上占几格）：1 项的分组只占 1 格，
  // 两个 1 项的分组就能并排站一行，不再各自霸占一整行。
  return `<section class="launcher-group" data-tile-count="${group.tiles.length}"
                style="--group-accent: ${accent}; --group-tint: ${tint}; --tile-count: ${group.tiles.length};">
                <div class="launcher-group-head">
                    <span class="launcher-group-chip">
                        <i class="fas ${escapeHtml(group.icon)}"></i>
                        ${escapeHtml(group.title)}
                    </span>
                    <span class="launcher-group-count">${group.tiles.length} 项</span>
                </div>
                <div class="tile-grid">
${tiles}
                </div>
            </section>`;
}

function favoritesHtml(favoriteIds) {
  const { title, max } = currentLayout.favorites;
  const headActions = favoritesEditing
    ? `<button type="button" class="fav-head-btn" id="favorites-reset-btn">恢复默认</button>
       <button type="button" class="fav-head-btn fav-head-btn-primary" id="favorites-done-btn">完成</button>`
    : `<span class="fav-count">${favoriteIds.length} / ${max}</span>
       <button type="button" class="fav-head-btn" id="favorites-edit-btn">编辑</button>`;

  const body = favoriteIds.length
    ? `<div class="tile-grid favorites-grid">
${favoriteIds.map((id, i) => {
      const hit = tileIndex.get(id);
      if (!hit) return "";
      return tileHtml(hit.tile, hit.group, {
        mode: "favorite",
        editing: favoritesEditing,
        index: i,
        total: favoriteIds.length
      });
    }).join("\n")}
                </div>`
    : `<div class="favorites-empty">
                    还没有常用功能。把鼠标移到下面任意功能卡片上，点右下角的 <span class="favorites-empty-star">☆</span> 即可加入。
                </div>`;

  const hint = favoritesEditing
    ? `<p class="favorites-hint">拖动不了？用 <b>←</b> <b>→</b> 调整顺序，用 <b>×</b> 把功能移出常用。</p>`
    : "";

  // 头部结构刻意与 groupHtml 的 .launcher-group-head 保持一致（同一套 chip 胶囊 +
  // 右侧次要信息），这样「常用功能」和下面的功能分组在视觉上是同一类卡片。
  // 见 main.css 的 .favorites-section 注释。
  return `<section class="favorites-section${favoritesEditing ? " is-editing" : ""}">
                <div class="launcher-group-head favorites-head">
                    <span class="launcher-group-chip favorites-chip"><i class="fas fa-star"></i>${escapeHtml(title)}</span>
                    <span class="favorites-head-actions">${headActions}</span>
                </div>
                ${hint}
                ${body}
            </section>`;
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
    groupsHost.innerHTML = currentLayout.groups.map((g) => groupHtml(g, favoriteSet)).join("\n");
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
  await loadUserFavoriteIds();
  await renderLauncher();

  // 首页交互（内容动态渲染，统一使用事件委托）
  document.addEventListener("click", (e) => {
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

  // 进入该功能页时刷新编辑器内容
  window.addEventListener("nforce:section", (e) => {
    if (e.detail && e.detail.section === LAYOUT_SECTION) {
      refreshLayoutEditor();
    }
  });

  // 回到首页时退出常用功能编辑态，避免磁贴一直处于「不可点击」状态
  window.addEventListener("nforce:home", () => {
    if (favoritesEditing) {
      favoritesEditing = false;
      renderLauncher();
    }
  });
}
