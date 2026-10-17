/**
 * 历史面板（SOQL 查询历史 / Apex 执行历史共用）
 *
 * 一个折叠面板，装着一份可勾选的历史列表 + 一排批量操作：
 *   载入 / 删除所选 / 导出 JSON / 导入文件 / 同步到 ima 知识库
 *
 * ── 为什么做成"挂到宿主 div 上"的组件 ──
 * 两条历史的交互完全一样，只有「点一条之后干什么」不同（填进 SOQL 输入框 / 填进 Apex 输入框）。
 * 所以界面全部由本模块生成，`index.html` 里只留一个空的壳：
 *   `<div id="soql-history-host"></div>`
 * 这样新增第三条历史（比如将来的 Bulk 查询）不用再复制一遍 HTML 与事件绑定。
 *
 * ── 事件绑定 ──
 * 列表每次刷新都会重建 DOM，所以事件一律**委托在宿主节点上**，按 `data-hist-action` 分发。
 * 不用 `on(id, …)` 逐元素绑定：那些元素在刷新后就没了，绑上去的监听也跟着丢。
 *
 * ── 与 storage 的关系 ──
 * 读写全在 `common/history_store.js`（含旧 string[] 迁移与去重合并），
 * 这里只维护"勾了哪几条"这种一次性的界面状态。
 */
import { createLogger } from "../common/logger.js";
import { $ } from "../common/dom.js";
import { showNotification, escapeHtml } from "../common/utils.js";
import { replaceIcons } from "../common/icons.js";
import {
  HISTORY_KINDS,
  loadHistory,
  removeHistoryEntries,
  renameHistoryEntry,
  importHistory,
  buildExportPayload,
  exportFileName,
  parseHistoryFileContent,
  onHistoryChanged
} from "../common/history_store.js";
import { describeImaBlocker, syncHistoryToIma } from "../common/ima_service.js";

const log = createLogger("HISTUI");

/** 顶部导航齿轮里的「插件偏好」——「去设置」跳这里 */
const PREFS_STEP = 28;

/** 已挂载的面板：kind → 面板状态 */
const panels = new Map();

let watching = false;

/**
 * 挂载（幂等：同一个 kind 重复挂载只会重新渲染一次）。
 *
 * @param {string} hostId 宿主元素 id（`index.html` 里的空 div）
 * @param {{
 *   kind: "soql"|"apex",
 *   onPick: (item: object) => void,
 *   hint?: string,
 *   syncLabel?: string
 * }} options
 */
export function mountHistoryPanel(hostId, options) {
  const host = $(hostId);
  if (!host) {
    log.warn(`找不到历史面板宿主 #${hostId}，跳过挂载`);
    return;
  }
  const kind = options.kind;
  if (!HISTORY_KINDS[kind]) {
    log.warn(`未知的历史类型：${kind}`);
    return;
  }

  const state = {
    kind,
    host,
    onPick: options.onPick,
    hint: options.hint || "",
    items: [],
    selected: new Set(),
    /** 正在改名的条目 id（null = 没在改名）。就地编辑，不弹窗 */
    editing: null,
    /** 筛选关键词（名字或正文命中） */
    filter: ""
  };
  panels.set(kind, state);
  renderShell(state);

  // 委托：一个监听管住整块面板（列表刷新不会丢）
  host.addEventListener("click", (e) => onHostClick(state, e));
  host.addEventListener("change", (e) => onHostChange(state, e));
  host.addEventListener("input", (e) => onHostInput(state, e));
  // 改名时 Enter 保存 / Esc 取消。**必须自己接管这两个键**：
  // document 上有一个 "Esc 返回首页" 的全局监听（biz/ui.js），不拦就会把人弹回首页。
  host.addEventListener("keydown", (e) => onHostKeydown(state, e));

  refreshHistoryPanel(kind);

  if (!watching) {
    watching = true;
    // 跨宿主同步：侧边栏与标签页可以同时开着，一处删了另一处要跟着变
    onHistoryChanged((changedKind) => {
      if (panels.has(changedKind)) refreshHistoryPanel(changedKind);
    });
  }
}

/** 重新从 storage 读并渲染（外部在写入历史后也可以主动调用） */
export async function refreshHistoryPanel(kind) {
  const state = panels.get(kind);
  if (!state) return;
  state.items = await loadHistory(kind);
  // 被删掉/被挤掉的条目要从勾选集合里清掉，否则"已选 3"点删除只删了 2 条
  const alive = new Set(state.items.map((it) => it.id));
  for (const id of [...state.selected]) if (!alive.has(id)) state.selected.delete(id);
  renderList(state);
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/**
 * 面板骨架。
 *
 * ⚠️ 折叠箭头必须**包一层 span 再旋转**：`replaceIcons()` 会把 `<i class="fas …">`
 * 整个换成 `<svg class="svg-icon">`，挂在 `<i>` 上的修饰类（`hist-caret`）会一起消失，
 * 于是"展开时箭头朝下"永远不生效（2026-10-17 实测：展开后箭头仍朝右）。
 * 另外这段是模板字面量 —— 注释里**不能出现反引号**，否则模板提前结束（同一个坑）。
 */
function renderShell(state) {
  const spec = HISTORY_KINDS[state.kind];
  state.host.innerHTML = `
    <div class="hist-head">
      <button type="button" class="hist-toggle" data-hist-action="toggle" aria-expanded="false">
        <span class="hist-caret"><i class="fas fa-chevron-right"></i></span>
        <span class="hist-title">${escapeHtml(spec.label)}</span>
        <span class="hist-count" data-hist-count>0</span>
      </button>
      <button type="button" class="ant-btn ant-btn-sm" data-hist-action="sync">
        <i class="fas fa-cloud-upload-alt"></i> 同步到 ima
      </button>
    </div>
    <div class="hist-body u-hidden" data-hist-body>
      <div class="hist-toolbar">
        <label class="hist-check">
          <input type="checkbox" data-hist-action="select-all"> 全选
        </label>
        <span class="hist-selected" data-hist-selected>已选 0</span>
        <input type="text" class="ant-input hist-filter" data-hist-filter
               placeholder="筛选名字 / 语句" autocomplete="off" spellcheck="false"
               aria-label="筛选历史">
      </div>
      <!-- 三个批量操作单独一行、等分宽度：400px 侧边栏里挤在"全选"旁边会折成三行 -->
      <div class="hist-actions">
        <button type="button" class="ant-btn ant-btn-sm" data-hist-action="export">
          <i class="fas fa-download"></i> 导出
        </button>
        <button type="button" class="ant-btn ant-btn-sm" data-hist-action="import">
          <i class="fas fa-upload"></i> 导入
        </button>
        <button type="button" class="ant-btn ant-btn-sm hist-danger" data-hist-action="delete">
          <i class="fas fa-trash"></i> 删除
        </button>
      </div>
      <div class="hist-list" data-hist-list></div>
      <input type="file" class="u-hidden" data-hist-file accept=".json,.txt,.sql,.soql,.apex,.cls">
      <p class="hist-hint">${escapeHtml(state.hint || "点「命名」可以给每一条起个名字（之后按名字筛选 / 挑着用）；勾选后可批量导出 / 删除；不勾选时导出与同步都按当前筛选结果处理。")}</p>
    </div>`;
  replaceIcons();
}

/** 当前筛选关键词命中的条目（名字或正文任一命中即可） */
function visibleItems(state) {
  const q = (state.filter || "").trim().toLowerCase();
  if (!q) return state.items;
  return state.items.filter(
    (it) => (it.name || "").toLowerCase().includes(q) || it.text.toLowerCase().includes(q)
  );
}

function renderList(state) {
  const host = state.host;
  const countEl = host.querySelector("[data-hist-count]");
  const selectedEl = host.querySelector("[data-hist-selected]");
  const listEl = host.querySelector("[data-hist-list]");
  const allCheck = host.querySelector('[data-hist-action="select-all"]');
  if (!listEl) return;

  // 改名输入框的内容不能被"刷新"冲掉：storage 变化（哪怕是别的宿主改名）也会走到这里
  const renameInput = host.querySelector("[data-hist-rename-input]");
  const pendingName = renameInput ? renameInput.value : null;

  const visible = visibleItems(state);
  const selectedVisible = visible.filter((it) => state.selected.has(it.id)).length;

  if (countEl) {
    // 有筛选时显示"命中/总数"，否则只看总数
    countEl.textContent = state.filter
      ? `${visible.length}/${state.items.length}`
      : String(state.items.length);
  }
  if (selectedEl) selectedEl.textContent = `已选 ${state.selected.size}`;

  if (!state.items.length) {
    listEl.innerHTML = `<div class="hist-empty">还没有记录。跑一次${state.kind === "soql" ? "查询" : "执行"}后会自动存到这里；之后可以给它起个名字。</div>`;
    if (allCheck) {
      allCheck.checked = false;
      allCheck.disabled = true;
    }
    replaceIcons();
    return;
  }

  if (allCheck) {
    allCheck.disabled = !visible.length;
    allCheck.checked = visible.length > 0 && selectedVisible === visible.length;
    allCheck.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
  }

  if (!visible.length) {
    listEl.innerHTML = `<div class="hist-empty">没有匹配「${escapeHtml(state.filter)}」的历史</div>`;
    replaceIcons();
    return;
  }

  listEl.innerHTML = visible.map((item) => itemHtml(state, item)).join("");
  replaceIcons();

  if (pendingName !== null && state.editing) {
    const input = host.querySelector("[data-hist-rename-input]");
    if (input) {
      input.value = pendingName;
      input.focus();
      input.setSelectionRange(pendingName.length, pendingName.length);
    }
  }
}

/**
 * 一行的 HTML。
 *
 * 两种形态：
 *   · 普通行 —— [勾选框] [名字（没名字就用正文首行） + 元信息] [改名]
 *   · 改名中 —— [输入框] [保存] [取消]（就地编辑，不弹窗：弹窗在侧边栏里会遮住上下文）
 */
function itemHtml(state, item) {
  const id = escapeHtml(item.id);

  if (state.editing === item.id) {
    return `
    <div class="hist-item is-editing" data-id="${id}">
      <input type="text" class="ant-input hist-rename-input" data-hist-rename-input
             maxlength="60" value="${escapeHtml(item.name || "")}"
             placeholder="起个名字（留空 = 不命名）" aria-label="历史名称">
      <button type="button" class="ant-btn ant-btn-sm" data-hist-action="rename-save">保存</button>
      <button type="button" class="ant-btn ant-btn-sm" data-hist-action="rename-cancel">取消</button>
    </div>`;
  }

  const firstLine = (item.text.split("\n").find((l) => l.trim()) || item.text).trim();
  const preview = firstLine.length > 90 ? firstLine.slice(0, 90) + "…" : firstLine;
  const title = item.name || preview;
  const meta = itemMetaText(state.kind, item);
  // 有名字时把正文预览并进第二行：光看名字不一定想得起"这条到底查的是什么"
  const metaLine = item.name && preview ? `${preview} · ${meta}` : meta;
  const checked = state.selected.has(item.id) ? "checked" : "";

  return `
    <div class="hist-item${item.name ? " is-named" : ""}" data-id="${id}">
      <input type="checkbox" class="hist-item-check" data-hist-action="check" data-id="${id}" ${checked}>
      <button type="button" class="hist-item-main" data-hist-action="pick" data-id="${id}"
              title="点击载入到编辑器">
        <span class="hist-item-text">${escapeHtml(title)}</span>
        <span class="hist-item-meta">${escapeHtml(metaLine)}</span>
      </button>
      <button type="button" class="hist-rename-btn" data-hist-action="rename" data-id="${id}"
              title="${item.name ? "改名" : "给这条起个名字"}">${item.name ? "改名" : "命名"}</button>
    </div>`;
}

/** `10-17 13:31`：列表里一行放得下的时间（完整时间放 title 里没必要，日期不跨年的场景够用） */
function shortStamp(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  const p = (n) => String(n).padStart(2, "0");
  const sameYear = d.getFullYear() === new Date().getFullYear();
  const date = sameYear ? `${p(d.getMonth() + 1)}-${p(d.getDate())}` : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return `${date} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 一行的附加信息：条数 / 结果 / 时间（各功能语义不同，所以分情况拼） */
function itemMetaText(kind, item) {
  const bits = [];
  if (item.uses > 1) bits.push(`${item.uses} 次`);
  const meta = item.meta || {};
  if (kind === "soql") {
    if (Number.isFinite(meta.rows)) bits.push(`${meta.rows} 行`);
  } else if (kind === "apex") {
    if (meta.ok === true) bits.push("成功");
    else if (meta.ok === false) bits.push(meta.compiled === false ? "编译失败" : "失败");
  }
  bits.push(shortStamp(item.lastUsedAt));
  return bits.join(" · ");
}

/* ------------------------------------------------------------------ *
 * 交互
 * ------------------------------------------------------------------ */

/**
 * 勾选了就用勾选的，没勾选就按**当前筛选结果里的全部**（导出/删除/同步都遵循这一条）。
 * 注意是 visibleItems 而不是 items —— 筛到 3 条时点删除，只该删这 3 条看得见的。
 */
function targetItems(state) {
  const visible = visibleItems(state);
  if (!state.selected.size) return visible;
  return visible.filter((it) => state.selected.has(it.id));
}

function onHostClick(state, e) {
  const trigger = e.target.closest("[data-hist-action]");
  if (!trigger) return;
  const action = trigger.getAttribute("data-hist-action");

  if (action === "toggle") {
    const body = state.host.querySelector("[data-hist-body]");
    const expanded = trigger.getAttribute("aria-expanded") === "true";
    trigger.setAttribute("aria-expanded", expanded ? "false" : "true");
    trigger.classList.toggle("is-open", !expanded);
    if (body) body.classList.toggle("u-hidden", expanded);
    return;
  }

  if (action === "pick") {
    const item = state.items.find((it) => it.id === trigger.getAttribute("data-id"));
    if (!item) return;
    try {
      state.onPick(item);
      // 载入后自动收起：紧接着就是要改代码/跑查询，面板占着地方没用
      const toggle = state.host.querySelector('[data-hist-action="toggle"]');
      toggle.click();
    } catch (err) {
      log.error("载入历史失败:", err);
      showNotification("载入失败：" + (err.message || err), "error");
    }
    return;
  }

  if (action === "rename") {
    state.editing = trigger.getAttribute("data-id");
    renderList(state);
    const input = state.host.querySelector("[data-hist-rename-input]");
    if (input) {
      input.focus();
      input.select();
    }
    return;
  }
  if (action === "rename-save") return saveRename(state);
  if (action === "rename-cancel") {
    state.editing = null;
    renderList(state);
    return;
  }

  if (action === "export") return doExport(state);
  if (action === "import") {
    const file = state.host.querySelector("[data-hist-file]");
    if (file) file.click();
    return;
  }
  if (action === "delete") return doDelete(state);
  if (action === "sync") return doSync(state);
}

/**
 * 保存改名。空名 = 取消命名（列表退回显示正文首行）。
 * 只写这一个字段，正文 / id / 使用次数都不动 —— 改个名字不该被当成一次"使用"。
 */
async function saveRename(state) {
  const input = state.host.querySelector("[data-hist-rename-input]");
  const id = state.editing;
  const value = input ? input.value : "";
  state.editing = null;
  if (id) {
    try {
      await renameHistoryEntry(state.kind, id, value);
    } catch (e) {
      log.warn("改名失败:", e);
      showNotification("改名失败：" + (e.message || e), "error");
    }
  }
  // 名字没变时 storage 不会触发变更事件，所以这里主动重绘一次
  await refreshHistoryPanel(state.kind);
}

/** 筛选框：输入即过滤（历史最多 100 条，不需要防抖） */
function onHostInput(state, e) {
  const target = e.target;
  if (!target.hasAttribute || !target.hasAttribute("data-hist-filter")) return;
  state.filter = target.value;
  // renderList 只替换列表区，筛选框本身不会被重建 → 焦点与光标位置都不受影响
  renderList(state);
}

function onHostKeydown(state, e) {
  if (!state.editing) return;
  const target = e.target;
  if (!target.hasAttribute || !target.hasAttribute("data-hist-rename-input")) return;

  if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    saveRename(state);
  } else if (e.key === "Escape") {
    e.preventDefault();
    // 拦住 document 上那个"Esc 返回首页"（biz/ui.js）—— 否则取消改名会把人弹回首页
    e.stopPropagation();
    state.editing = null;
    renderList(state);
  }
}

function onHostChange(state, e) {
  const target = e.target;
  const action = target.getAttribute && target.getAttribute("data-hist-action");

  if (action === "select-all") {
    const visible = visibleItems(state);
    if (target.checked) visible.forEach((it) => state.selected.add(it.id));
    else visible.forEach((it) => state.selected.delete(it.id));
    renderList(state);
    return;
  }
  if (action === "check") {
    const id = target.getAttribute("data-id");
    if (!id) return;
    if (target.checked) state.selected.add(id);
    else state.selected.delete(id);
    // 只更新计数与全选框，不重建列表（重建会让刚点的复选框失焦）
    const host = state.host;
    const visible = visibleItems(state);
    const selectedVisible = visible.filter((it) => state.selected.has(it.id)).length;
    const selectedEl = host.querySelector("[data-hist-selected]");
    const allCheck = host.querySelector('[data-hist-action="select-all"]');
    if (selectedEl) selectedEl.textContent = `已选 ${state.selected.size}`;
    if (allCheck) {
      allCheck.checked = visible.length > 0 && selectedVisible === visible.length;
      allCheck.indeterminate = selectedVisible > 0 && selectedVisible < visible.length;
    }
    return;
  }
  if (target.hasAttribute("data-hist-file")) {
    importFromFile(state, target);
  }
}

/* ------------------------------------------------------------------ *
 * 三个批量操作
 * ------------------------------------------------------------------ */

function downloadJson(fileName, payload) {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  a.style.visibility = "hidden";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function doExport(state) {
  const items = targetItems(state);
  if (!items.length) {
    showNotification("没有可导出的历史", "warning");
    return;
  }
  const payload = buildExportPayload(state.kind, items);
  downloadJson(exportFileName(state.kind), payload);
  showNotification(`已导出 ${items.length} 条历史（JSON，可再导入）`, "success");
}

async function doDelete(state) {
  const items = targetItems(state);
  if (!items.length) {
    showNotification("没有可删除的历史", "warning");
    return;
  }
  const what = state.selected.size ? `所选 ${items.length} 条` : `全部 ${items.length} 条`;
  if (!window.confirm(`删除${what}历史？删除后无法恢复（可先导出备份）。`)) return;

  state.selected = new Set();
  await removeHistoryEntries(state.kind, items.map((it) => it.id));
  await refreshHistoryPanel(state.kind);
  showNotification(`已删除 ${items.length} 条历史`, "success");
}

async function importFromFile(state, input) {
  const file = input.files && input.files[0];
  // 同一个文件连选两次也要能触发 change
  input.value = "";
  if (!file) return;

  try {
    const content = await file.text();
    const incoming = parseHistoryFileContent(content, { kind: state.kind, fileName: file.name });
    if (!incoming.length) {
      showNotification("文件里没有可导入的历史条目", "warning");
      return;
    }
    const result = await importHistory(state.kind, incoming);
    await refreshHistoryPanel(state.kind);
    showNotification(
      `导入完成：新增 ${result.added} 条，已存在 ${result.duplicates} 条`,
      result.added ? "success" : "info"
    );
  } catch (e) {
    log.warn("导入历史失败:", e);
    showNotification("导入失败：" + (e.message || e), "error");
  }
}

async function doSync(state) {
  const items = targetItems(state);
  if (!items.length) {
    showNotification("没有可同步的历史", "warning");
    return;
  }

  const blocker = describeImaBlocker();
  if (blocker) {
    showNotification(blocker + " —— 已跳到设置页", "warning");
    // 与搜索跳转同一套解耦方式：app.js 是入口，本模块 import 不到它的 gotoSection
    window.dispatchEvent(new CustomEvent("nforce:goto", { detail: { step: PREFS_STEP } }));
    return;
  }

  const btn = state.host.querySelector('[data-hist-action="sync"]');
  const original = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 同步中…';
    replaceIcons();
  }

  try {
    const res = await syncHistoryToIma(state.kind, items);
    showNotification(`已把 ${res.count} 条历史存进 ima 知识库（${res.notes.length} 份笔记）`, "success");
  } catch (e) {
    log.error("同步到 ima 失败:", e);
    showNotification("同步到 ima 失败：" + (e.message || e), "error");
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = original;
      replaceIcons();
    }
  }
}
