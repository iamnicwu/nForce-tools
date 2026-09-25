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

// 需要连接 Salesforce 才能使用的功能
const CONNECTION_REQUIRED_STEPS = new Set([
  2, 3, 4, 5, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 22, 23, 24, 25, 26, 27
]);

// 配色表：tint 用于图标底色，accent 用于强调色，soft 用于磁贴悬浮底色。
// 色值统一指向 main.css :root 里的 --accent-* 令牌（自定义属性可以链式代入，
// 所以这里写 var(--accent-blue) 会解析成 :root 里的实际色值）。
// 以前这是独立于 main.css .theme-* 与 index.html --row-accent 的第三份重复色板。
const PALETTE = {
  blue:   { tint: "var(--accent-blue-tint)", accent: "var(--accent-blue)", soft: "var(--accent-blue-soft)" },
  purple: { tint: "var(--accent-purple-tint)", accent: "var(--accent-purple)", soft: "var(--accent-purple-soft)" },
  orange: { tint: "var(--accent-volcano-tint)", accent: "var(--accent-volcano)", soft: "var(--accent-volcano-soft)" },
  pink:   { tint: "var(--accent-pink-tint)", accent: "var(--accent-pink)", soft: "var(--accent-pink-soft)" },
  amber:  { tint: "var(--accent-amber-tint)", accent: "var(--accent-amber)", soft: "var(--accent-amber-soft)" },
  green:  { tint: "var(--accent-green-tint)", accent: "var(--accent-green)", soft: "var(--accent-green-soft)" },
  teal:   { tint: "var(--accent-teal-tint)", accent: "var(--accent-teal)", soft: "var(--accent-teal-soft)" },
  gray:   { tint: "var(--accent-gray-tint)", accent: "var(--accent-gray)", soft: "var(--accent-gray-soft)" }
};

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
 * 想真正隐藏某个磁贴，请把它写进 hidden 数组。
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
    merged.groups = merged.groups.filter((g) => g.tiles.length > 0);
  }
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
  const locked = tile.requiresConnection && CONNECTION_REQUIRED_STEPS.has(tile.step) && !appState.is_connected;

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
    overlay = `<span class="tile-fav-btn${favorited ? " is-on" : ""}" role="button" tabindex="0"
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
  return `<section class="launcher-group" style="--group-accent: ${accent}; --group-tint: ${tint};">
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

  return `<section class="favorites-section${favoritesEditing ? " is-editing" : ""}">
                <div class="favorites-head">
                    <span class="favorites-title"><i class="fas fa-star"></i>${escapeHtml(title)}</span>
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
    _readme: layout._readme || "调整 groups[].tiles 顺序即可改变图标排列；想永久隐藏某个磁贴请把它的 id 写进 hidden 数组；favorites.ids 是「常用功能」的默认列表 —— 界面上的改动（卡片右下角 ☆ / 常用功能区「编辑」）会自动保存在本地，改这里只会影响恢复默认后的结果。",
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
