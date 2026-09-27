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
 * @returns {number} 实际渲染的行数（0 表示未渲染）
 */
export function renderDataTable(container, table, data, options = {}) {
  const containerEl =
    typeof container === "string" ? document.getElementById(container) : container;
  const tableEl = typeof table === "string" ? document.getElementById(table) : table;

  if (!tableEl) return 0;

  const {
    columns = null,
    maxRows = DEFAULT_MAX_ROWS,
    rawHeader = false,
  } = options;

  // 空数据：清空并隐藏容器
  if (!Array.isArray(data) || data.length === 0) {
    tableEl.innerHTML = "";
    if (containerEl) containerEl.style.display = "none";
    return 0;
  }

  const cols = Array.isArray(columns) && columns.length > 0
    ? columns
    : Object.keys(data[0]);

  if (cols.length === 0) {
    tableEl.innerHTML = "";
    if (containerEl) containerEl.style.display = "none";
    return 0;
  }

  const displayData = data.slice(0, maxRows);

  // ── 表头 ──
  const headCells = cols
    .map((col) => `<th class="ut-th">${escapeHtml(rawHeader ? col : formatHeader(col))}</th>`)
    .join("");

  // ── 表体（一次性拼接，走单次 innerHTML）──
  const rows = new Array(displayData.length);
  for (let r = 0; r < displayData.length; r++) {
    const row = displayData[r];
    let cells = "";
    for (let c = 0; c < cols.length; c++) {
      const value = row[cols[c]];
      // 空值不加 title，避免为空格子生成无意义的属性
      if (value === null || value === undefined || value === "") {
        cells += `<td class="ut-td"></td>`;
      } else {
        const text = escapeHtml(cellText(value));
        cells += `<td class="ut-td" title="${text}">${text}</td>`;
      }
    }
    rows[r] = `<tr class="ut-tr">${cells}</tr>`;
  }

  tableEl.className = "ant-table ant-table-bordered ant-table-default";
  tableEl.innerHTML =
    `<thead class="ant-table-thead"><tr>${headCells}</tr></thead>` +
    `<tbody class="ant-table-tbody ut-tbody">${rows.join("")}</tbody>`;

  // 容器滚动设置
  if (containerEl) {
    containerEl.style.display = "block";
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
