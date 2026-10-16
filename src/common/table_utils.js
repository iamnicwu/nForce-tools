/**
 * 原生 HTML table 渲染工具
 *
 * 性能说明（重要）：
 * 早期实现是「逐单元格 createElement + appendChild + 每格 4 次内联样式写」，
 * 1000 行 × 13 列 ≈ 1.3 万次 createElement、1.3 万次 appendChild、5.2 万次样式写，
 * 每次都触发布局计算。
 *
 * 现在改为「拼接 HTML 字符串 + 一次 innerHTML 赋值」，并把单元格样式提到 CSS 类
 * （见 main.css 的 .ut-* 规则），斑马纹用 :nth-child(odd) 而非逐行写内联背景色。
 * 预期 3~10× 提升，且不再因内联样式阻碍 CSS 缓存。
 *
 * 注意：因为走 innerHTML，所有来自数据的文本必须经 escapeHtml() 转义。
 */

import { escapeHtml } from "./utils.js";

/** 默认最多渲染的行数（防止一次插入十几万行把页面卡死） */
const DEFAULT_MAX_ROWS = 1000;

/** 单元格文本短于这个长度就不加 `title` 属性（短值不可能被截断，省属性 = 省解析时间） */
const TITLE_ATTR_MIN = 20;

/**
 * 「显示更多」一次追加多少行。取值是权衡：太小 → 点很多次；太大 → 每次追加都卡一下。
 * 200 行在实测里约 7ms（同一批数据 1000 行 ≈ 37ms），点下去没有可感知的停顿。
 */
const DEFAULT_PAGE_SIZE = 200;

export { DEFAULT_PAGE_SIZE };

/**
 * 把单元格原始值转成用于显示的字符串
 * @param {*} value
 * @returns {string}
 */
function cellText(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/**
 * 把列名格式化成表头文案
 * 移除 Salesforce 字段后缀 __c，去掉 Order_ 前缀，下划线转空格
 * @param {string} col
 * @returns {string}
 */
function formatHeader(col) {
  return String(col).replace(/__c/g, "").replace(/Order_/g, "").replace(/_/g, " ");
}

/**
 * 渲染数据表（内部统一实现）
 *
 * @param {HTMLElement|string} container - 容器元素或 ID
 * @param {HTMLElement|string} table - table 元素或 ID
 * @param {Array<Object>} data - 数据行
 * @param {Object} [options]
 * @param {string[]|null} [options.columns] - 只渲染指定列（默认取首行的全部键）
 * @param {number} [options.maxRows] - 最多渲染行数
 * @param {boolean} [options.rawHeader] - 为 true 时表头不过滤 __c / Order_ / 下划线
 * @param {boolean|string} [options.layout] - `"fixed"` 时用 `table-layout: fixed`（等价 Tailwind 的
 *        `table-fixed`）+ `<colgroup>` 列宽。**大数据量下这是主要的性能开关**：
 *        auto 布局要求浏览器为了定列宽去量每个单元格的内容，几千行时那一步是百毫秒级；
 *        fixed 布局只看 colgroup 的宽度，与行数无关。
 * @param {Object<string,string>} [options.columnWidths] - 列名 → CSS 宽度（如 `"9.5rem"`）。
 *        没给的列平分剩余宽度。只在 layout=fixed 时有意义。
 * @param {number} [options.pageSize] - **分页渲染**：先只画这么多行，表尾给一个
 *        「显示更多（还有 N 行）」按钮，点一次追加一页。0 = 一次性全画（老行为）。
 *        这是「多数据」下唯一真正有效的优化（见文件头/常量处的实测）：布局成本随**行数**增长，
 *        首屏只画 200 行就与总行数无关。
 * @returns {number} 实际渲染的行数（0 表示未渲染）
 */
export /**
 * 结果容器的显隐。
 *
 * 除了内联 display，还要同步 u-hidden 类 —— 「结果区空状态」（.result-empty）
 * 是靠 CSS 的 `:has(.unified-table-wrapper:not(.u-hidden))` 自动让位的；
 * 只写内联样式的话 :has() 判不出来，占位会一直挂在表格下面。
 * 内联样式仍然要留着：它优先级最高，才盖得住 .u-hidden 的 display:none。
 */
function showContainer(el) {
  if (!el) return;
  el.style.display = "block";
  el.classList.remove("u-hidden");
}

function hideContainer(el) {
  if (!el) return;
  el.style.display = "none";
  el.classList.add("u-hidden");
}

function renderDataTable(container, table, data, options = {}) {
  const containerEl =
    typeof container === "string" ? document.getElementById(container) : container;
  const tableEl = typeof table === "string" ? document.getElementById(table) : table;

  if (!tableEl) return 0;

  const {
    columns = null,
    maxRows = DEFAULT_MAX_ROWS,
    rawHeader = false,
    layout = "auto",
    columnWidths = null,
    pageSize = 0,
  } = options;
  const fixedLayout = layout === "fixed";
  const pageRows = Number(pageSize) > 0 ? Math.floor(Number(pageSize)) : 0;

  // 空数据：清空并隐藏容器
  if (!Array.isArray(data) || data.length === 0) {
    tableEl.innerHTML = "";
    hideContainer(containerEl);
    return 0;
  }

  const cols = Array.isArray(columns) && columns.length > 0
    ? columns
    : Object.keys(data[0]);

  if (cols.length === 0) {
    tableEl.innerHTML = "";
    hideContainer(containerEl);
    return 0;
  }

  const displayData = data.slice(0, maxRows);

  // ── 表头 ──
  const headCells = cols
    .map((col) => `<th class="ut-th">${escapeHtml(rawHeader ? col : formatHeader(col))}</th>`)
    .join("");

  // ── 表体：拼装抽成函数，「首屏」与「显示更多」用同一段（两个实现迟早会不一致）──
  // 单次 innerHTML / 单次 insertAdjacentHTML，避免逐行 append 触发多次重排。
  const buildRowsHtml = (slice) => {
    const out = new Array(slice.length);
    for (let r = 0; r < slice.length; r++) {
      const row = slice[r];
      let cells = "";
      for (let c = 0; c < cols.length; c++) {
        const value = row[cols[c]];
        // 空值不加 title，避免为空格子生成无意义的属性
        if (value === null || value === undefined || value === "") {
          cells += `<td class="ut-td"></td>`;
        } else {
          const text = escapeHtml(cellText(value));
          // title 只在**可能被截断**时才加：它是给「悬停看全文」用的，而短值永远不会被截。
          // 一行 5 列、1000 行就是 5000 个属性，省掉一大半对建 DOM 是实打实的
          // （实测 3000 行 15000 格：建 DOM ~16ms）。
          const titleAttr = text.length > TITLE_ATTR_MIN ? ` title="${text}"` : "";
          cells += `<td class="ut-td"${titleAttr}>${text}</td>`;
        }
      }
      out[r] = `<tr class="ut-tr">${cells}</tr>`;
    }
    return out.join("");
  };

  const firstPage = pageRows > 0 ? displayData.slice(0, pageRows) : displayData;
  const bodyHtml = buildRowsHtml(firstPage);

  // ⚠️ 必须保证真正承载表格的是一个 **<table>** 元素（2026-10-16 修）。
  //
  // 各功能页的标记都写成 `<div id="xxx-table" class="data-table">`，而
  // `<thead>/<tbody>/<tr>/<td>` 塞进 <div> 会被 HTML 解析器**整段丢掉**（这些标签在 div
  // 里非法，解析规则是"忽略标签、保留文字"）→ 表格渲染成**一长串没有分行分列的文本**，
  // 且 `querySelectorAll("tbody tr")` 恒为 0（任何基于 DOM 的断言都抓不到问题）。
  // 实测：`renderTable(..., [{时间:'a'}])` 之后 `innerHTML` 是 `"时间a"` 而不是 `<tr><td>`。
  //
  // 所以这里对"容器不是 table"的调用方补一层：在容器里放一个真 <table>，
  // 后续所有渲染都写在它身上。传真 <table> 的调用点行为完全不变（向后兼容）。
  // ⚠️ 变量名别叫 `table`：那个名字是**形参**（`renderDataTable(container, table, ...)`），
  // 再 `let table` 就是"同一作用域重复声明" → 整个模块 SyntaxError（页面白屏）。
  let tableNode = tableEl;
  if (tableNode.tagName !== "TABLE") {
    const existing = tableEl.querySelector(":scope > table");
    if (existing) {
      tableNode = existing;
    } else {
      tableNode = document.createElement("table");
      tableEl.innerHTML = "";
      tableEl.appendChild(tableNode);
    }
  }

  // 固定布局要显式列宽（没给的列平分剩余）—— 这就是 Tailwind `table-fixed` + `w-*` 的那套做法，
  // 只是写在本项目的 `ut-` 类 + 内联宽度上（项目没有 Tailwind，见 MODULES L.4 的说明）。
  const colgroup = fixedLayout
    ? `<colgroup>${cols
        .map((col) => {
          const w = columnWidths && columnWidths[col];
          return `<col${w ? ` style="width:${escapeHtml(String(w))}"` : ""}>`;
        })
        .join("")}</colgroup>`
    : "";

  tableNode.className =
    "ant-table ant-table-bordered ant-table-default" + (fixedLayout ? " ut-tbl-fixed" : "");
  tableNode.innerHTML =
    colgroup +
    `<thead class="ant-table-thead"><tr>${headCells}</tr></thead>` +
    `<tbody class="ant-table-tbody ut-tbody">${bodyHtml}</tbody>`;

  // 「显示更多」：首屏之外的行按需追加。
  // 监听器挂在**按钮元素**上，而按钮随每次渲染被重建 —— 所以不需要手动解绑，
  // 也不会因为多次 renderTable 叠上同一个回调。
  if (containerEl) {
    const oldMore = containerEl.querySelector(":scope > .ut-more");
    if (oldMore) oldMore.remove();
    if (pageRows > 0 && displayData.length > firstPage.length) {
      const more = document.createElement("button");
      more.type = "button";
      more.className = "ant-btn ant-btn-default ut-more";
      let shown = firstPage.length;
      const paint = () => {
        const remain = displayData.length - shown;
        more.textContent = `显示更多（还有 ${remain} 行 / 共 ${displayData.length} 行）`;
      };
      more.addEventListener("click", () => {
        const next = displayData.slice(shown, shown + pageRows);
        const tbody = tableNode.querySelector("tbody");
        if (tbody) tbody.insertAdjacentHTML("beforeend", buildRowsHtml(next));
        shown += next.length;
        if (shown >= displayData.length) more.remove();
        else paint();
      });
      paint();
      containerEl.appendChild(more);
    }

    showContainer(containerEl);
    containerEl.style.overflowX = "auto";
    containerEl.style.overflowY = "auto";
    containerEl.style.maxHeight = "500px";
    containerEl.style.position = "relative";
  }

  return displayData.length;
}

/**
 * 渲染数据表格（业务侧主入口）
 *
 * 注意：签名为 (containerId, tableId, data, options)。
 * 历史上第 4 个参数被当成 "Handsontable 实例" 传入并被静默忽略，
 * 现已改为 options 对象 —— 如果看到旧代码传实例，那是残留，删掉即可。
 *
 * @param {string} containerId - 容器元素 ID
 * @param {string} tableId - 表格元素 ID
 * @param {Array<Object>} data - 要显示的数据
 * @param {Object} [options] - { columns, maxRows, rawHeader }
 * @returns {number} 实际渲染行数
 */
export function renderTable(containerId, tableId, data, options = {}) {
  return renderDataTable(containerId, tableId, data, options);
}

/**
 * 通用版本：容器/表格可传元素或 ID，且表头不做字段名美化
 * （保留此导出是为了兼容既有调用方；新代码建议直接用 renderDataTable）
 *
 * @param {HTMLElement|string} container
 * @param {HTMLElement|string} table
 * @param {Array<Object>} data
 * @param {Object} [options]
 * @returns {number} 实际渲染行数
 */
export function renderHtmlTable(container, table, data, options = {}) {
  return renderDataTable(container, table, data, { rawHeader: true, ...options });
}

export default renderTable;
