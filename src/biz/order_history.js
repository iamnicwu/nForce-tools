/**
 * Order 历史查询（`OrderHistory` —— 标准字段历史追踪）。
 *
 * ── 干什么 ──
 * 用户给出一个 Order 的 **Name / Id / OrderNumber**，我们：
 *   ① 先按值把这个 Order 找出来（`Order` 上按 Id / OrderNumber / Name 三选一匹配）；
 *   ② 再查它的字段历史（`OrderHistory`，按 `ParentId`）；
 *   ③ 以表格列出：时间 · 字段 · 旧值 → 新值 · 操作人。
 *
 * ── 两条入口 ──
 *   · 首页磁贴「Order 历史」→ 手工填值查询；
 *   · **全局搜索**：在搜索框里输入一个像 Order 标识的值（见 `common/order_query.js`
 *     的 `detectOrderQuery`），结果第一条会变成「查询 Order 历史：<值>」，
 *     回车后由 `openOrderHistoryWith()` 把值带进这一页并自动查一次。
 *
 * ── 查不到时的三种情况要分开提示 ──
 *   · 没找到这个 Order（值写错 / 不是本 org 的单）；
 *   · 找到了 Order 但**一条历史都没有** —— 最常见的原因是该 org 没给 Order 开字段历史追踪
 *     （Salesforce 默认不开，要在对象的「字段历史追踪」里勾）；
 *   · `OrderHistory` 对象本身不存在（同样的根因，Salesforce 会回 `INVALID_TYPE`）。
 *   含糊地说一句"查询失败"会让用户以为是插件坏了 —— 这三种文案必须分开。
 */
import { createLogger } from "../common/logger.js";
import { $, on } from "../common/dom.js";
import { showNotification, formatDateTime, escapeHtml, copyText } from "../common/utils.js";
import { renderTable, DEFAULT_PAGE_SIZE } from "../common/table_utils.js";
import { exportSheetsToExcel } from "../common/excel_utils.js";
import { sfConn } from "./sf_service.js";
import { appState } from "./state.js";
import {
  classifyOrderValue,
  buildOrderSoql,
  buildHistorySoql,
  buildOrderFieldsSoql,
  orderFieldGrid,
  orderFieldColumnWidths,
  historyRows,
  HISTORY_COLUMNS,
  FIELD_LABEL_COLUMN,
  HISTORY_COLUMN_WIDTHS,
  oneLineSoql,
  soqlErrorHint
} from "../common/order_query.js";

const log = createLogger("ORDHIST");

/** 这一页的 section 编号（`index.html` 的 `#section-30`；布局里的磁贴也指向它） */
export const ORDER_HISTORY_STEP = 30;

/**
 * 一次最多拉多少条历史。
 *
 * 2026-10-16 从 200 提到 1000：分页渲染（`pageSize`）之后，**首屏成本与总量无关**
 * （只画 200 行），所以没必要为了性能把上限压得很低 —— 上限低反而让用户查不到久远的变更。
 * 1000 行 ≈ 导出 1 个 sheet，仍然是「看一眼就够」的量级。
 */
const HISTORY_LIMIT = 1000;

/** 当前两张表的行（导出用），以及当前查的是哪个 Order（状态文案用） */
let currentRows = [];
/** 字段网格：`{ columns, rows }`（一条记录一行 → 列是动态的，导出与渲染都用它） */
let currentFieldGrid = { columns: [], rows: [] };
let currentOrder = null;

/* ------------------------------------------------------------------ *
 * 诊断轨迹（「查询日志」）
 *
 * 一次查询的每一步都记一条：值被识别成什么 → 找 Order 的 SOQL 与结果 → 字段 / 历史各自的
 * SOQL 与条数 → 渲染了几行；失败的那一步带上 errorCode、服务端原文与**一句可执行的建议**。
 *
 * 为什么要它：这个功能的失败模式几乎都在「查得对不对」上（值形状、org 有没有开字段历史、
 * 字段/对象权限、API 版本），而界面上只有一句人话提示 —— 用户没法自己判断是值写错了
 * 还是 SOQL 的问题。把 SOQL 原样摆出来，用户可以直接粘到 Developer Console 复核。
 *
 * 两个出口（同一份数据，不各写一遍）：
 *   · 页面底部「查询日志」（展开可见、出错自动展开、可一键复制）；
 *   · console 的 `[nForce][ORDHIST]`（走 logger，K 组要求；便于贴给开发者）。
 * ------------------------------------------------------------------ */
let trace = [];

/** 值的形状 → 人话（解释「为什么 SOQL 里带/不带 Id 条件」） */
const KIND_LABEL = Object.freeze({
  id: "18/15 位 Id（SOQL 会带 Id 条件）",
  number: "纯数字单号（按 OrderNumber / Name 查）",
  code: "业务号（按 OrderNumber / Name 查）",
  any: "自由文本（按 OrderNumber / Name 查）"
});

function tracePush(level, step, message, extra = {}) {
  const ms = typeof extra.ms === "number" ? Math.round(extra.ms) : undefined;
  const soql = extra.soql ? oneLineSoql(extra.soql) : "";
  trace.push({
    level,
    step,
    message,
    soql,
    ms,
    time: new Date().toLocaleTimeString("zh-CN", { hour12: false })
  });

  // console 同步：SOQL 与失败原因都要能在 DevTools 里看到（K 组：一律走 logger）
  const line = `[${step}] ${message}${ms !== undefined ? ` (${ms}ms)` : ""}`;
  const args = soql ? [line, `SOQL: ${soql}`] : [line];
  if (level === "error") log.error(...args);
  else if (level === "warning") log.warn(...args);
  else log.info(...args);

  renderTrace();
}

function resetTrace() {
  trace = [];
  renderTrace();
}

/** 把轨迹画到页面上。每次 push 都重画 —— 一共十来行，代价可忽略，换来「永远同步」 */
function renderTrace() {
  const wrap = $("order-history-log-wrap");
  const body = $("order-history-log");
  const summary = $("order-history-log-summary");
  if (!wrap || !body) return;

  if (!trace.length) {
    wrap.classList.add("u-hidden");
    body.innerHTML = "";
    return;
  }

  wrap.classList.remove("u-hidden");
  const errors = trace.filter((t) => t.level === "error").length;
  const warns = trace.filter((t) => t.level === "warning").length;
  if (summary) {
    const tags = [errors ? `${errors} 个错误` : "", warns ? `${warns} 个警告` : ""].filter(Boolean);
    summary.textContent = `查询日志（${trace.length} 条${tags.length ? ` · ${tags.join(" · ")}` : ""}）`;
  }

  body.innerHTML = trace
    .map((t) => {
      const head =
        `<div class="log-entry ${t.level}">[${escapeHtml(t.time)}] ` +
        `<b>${escapeHtml(t.step)}</b> ${escapeHtml(t.message)}` +
        `${t.ms !== undefined ? ` <span class="u-text-light">(${t.ms}ms)</span>` : ""}</div>`;
      const soqlLine = t.soql ? `<div class="log-entry log-soql">SOQL: ${escapeHtml(t.soql)}</div>` : "";
      return head + soqlLine;
    })
    .join("");

  // 有错误就自动展开 —— 「失败了但日志折叠着」等于没有日志
  if (errors) wrap.open = true;
}

/** 复制整份日志（纯文本，带时间与 SOQL，方便贴给他人或存档） */
async function copyTrace() {
  if (!trace.length) {
    showNotification("还没有日志可复制", "warning");
    return;
  }
  const value = currentOrder ? currentOrder.OrderNumber || currentOrder.Id : "";
  const head = `Order 历史查询日志  ${new Date().toLocaleString("zh-CN", { hour12: false })}` +
    `${value ? `  值: ${value}` : ""}`;
  const body = trace
    .map((t) => {
      const line = `[${t.time}] ${t.step} · ${t.message}${t.ms !== undefined ? ` (${t.ms}ms)` : ""}`;
      return t.soql ? `${line}\n    SOQL: ${t.soql}` : line;
    })
    .join("\n");
  await copyText(`${head}\n\n${body}`, "查询日志已复制");
}

/* ------------------------------------------------------------------ *
 * 取数
 * ------------------------------------------------------------------ */

/**
 * 统一的查询出口：**每一句 SOQL、耗时、失败原因都在这里进日志**。
 * 三个取数步骤（找 Order / Order 字段 / 字段历史）都走它，所以日志格式天然一致。
 *
 * @param {string} soql
 * @param {string} step 日志里的步骤名
 */
async function querySoql(soql, step) {
  const t0 = performance.now();
  tracePush("info", step, "开始查询", { soql });

  const conn = sfConn.connection;
  if (!conn) {
    const err = new Error("Salesforce connection not established");
    err.errorCode = "NO_CONNECTION";
    tracePush("error", step, "没有可用的 Salesforce 连接", { ms: performance.now() - t0 });
    throw err;
  }

  try {
    const result = await conn.query(soql, { autoFetch: true, maxFetch: HISTORY_LIMIT });
    const records = (result && result.records) || [];
    tracePush("success", step, `返回 ${records.length} 条`, { ms: performance.now() - t0 });
    return records;
  } catch (e) {
    // 关键：把 errorCode + 服务端原文 + 「下一步该做什么」一起记进日志。
    // 只写「查询失败」的日志等于没写 —— 用户还是不知道该改哪里。
    const code = (e && e.errorCode) || "ERROR";
    const hint = soqlErrorHint(e && e.errorCode, e && e.message);
    tracePush("error", step, `${code}: ${(e && e.message) || e} → ${hint}`, {
      ms: performance.now() - t0
    });
    throw e;
  }
}

/**
 * 按值找 Order。
 * `Name` 字段的降级重试见 `buildOrderSoql` 的注释 —— 这是防御性的：
 * 本项目在生产的 SOQL 里一直用 `order.Name`，所以正常路径不会走到降级分支。
 */
export async function findOrder(value) {
  const picked = typeof value === "string" ? classifyOrderValue(value) : value;
  try {
    return await querySoql(buildOrderSoql(picked, { limit: 5 }), "找 Order");
  } catch (e) {
    if (e && e.errorCode === "INVALID_FIELD") {
      // 降级这件事本身也要留痕：否则用户看到「第二条 SOQL 少了 Name」会以为代码写错了
      tracePush("warning", "找 Order", "org 上没有 Order.Name 字段（或该 API 版本不支持）→ 已自动去掉 Name 条件重试");
      return querySoql(buildOrderSoql(picked, { includeName: false, limit: 5 }), "找 Order（降级重试）");
    }
    throw e;
  }
}

/** 查某个 Order 的字段历史（服务端已按 CreatedDate DESC 排好，见 buildHistorySoql） */
export async function fetchOrderHistory(orderId) {
  return querySoql(buildHistorySoql(orderId, HISTORY_LIMIT), "字段历史");
}

/**
 * 查某个 Order 的**全部字段**（`SELECT FIELDS(ALL) FROM Order WHERE Id = … LIMIT 1`）。
 * 返回摊平后的字段行；查询失败（老 API 版本 / 无权限）时返回 []，不影响历史表的展示。
 */
export async function fetchOrderFields(orderId) {
  const records = await querySoql(buildOrderFieldsSoql(orderId), "Order 字段");
  // 一条记录一行：`columns` 是这条记录的字段名（含第一列行标识），`rows` 是 1 行。
  // 返回整个网格而不是预摊平的行 —— 列是动态的，渲染与导出都得知道列是什么。
  return orderFieldGrid(records, { label: FIELD_LABEL_COLUMN });
}

/* ------------------------------------------------------------------ *
 * 渲染
 * ------------------------------------------------------------------ */

/** 状态行文案（成功/空/失败都走这里，保证样式与位置一致） */
function setStatus(text, state = "info") {
  const el = $("order-history-status");
  if (!el) return;
  el.textContent = text || "";
  el.dataset.state = state; // 配色见 main.css 的 [data-state]
  el.classList.toggle("u-hidden", !text);
}

/** 把 Order 卡片（单号 / 名称 / 状态）刷到界面上 */
function renderOrderCard(order) {
  const el = $("order-history-order");
  if (!el) return;
  if (!order) {
    el.innerHTML = "";
    el.classList.add("u-hidden");
    return;
  }
  const rows = [
    ["Order Number", order.OrderNumber],
    ["Name", order.Name],
    ["状态", order.Custom_OrderStatus__c],
    ["Id", order.Id]
  ];
  el.innerHTML =
    '<div class="u-flex u-flex-wrap u-gap-16">' +
    rows
      .filter(([, v]) => v !== undefined && v !== null && String(v) !== "")
      .map(
        ([k, v]) =>
          `<div><span class="u-text-secondary u-fs-xs">${k}</span>` +
          `<div class="u-fs-sm u-fw-500 u-break-all">${String(v)}</div></div>`
      )
      .join("") +
    "</div>";
  el.classList.remove("u-hidden");
}

/**
 * 两张表都用**固定布局 + 列宽**（等价 Tailwind 的 table-fixed + w-*）：
 * auto 布局要为了定列宽去量每个单元格，几千行时是百毫秒级；fixed 与行数无关。
 * 见 common/table_utils.js 的 layout / columnWidths 选项与 MODULES L.4。
 */
function renderHistoryTable(rows) {
  renderTable("order-history-table-wrap", "order-history-table", rows, {
    columns: HISTORY_COLUMNS,
    columnWidths: HISTORY_COLUMN_WIDTHS,
    layout: "fixed",
    maxRows: HISTORY_LIMIT,
    pageSize: DEFAULT_PAGE_SIZE,
    rawHeader: true
  });
  const count = $("order-history-count");
  if (count) count.textContent = rows.length ? `${rows.length} 条 · 按时间倒序` : "";
}

function renderFieldsTable(grid) {
  const { columns, rows } = grid || { columns: [], rows: [] };
  renderTable("order-fields-table-wrap", "order-fields-table", rows, {
    // 列是**动态**的（一条记录一行 → 一列一个字段），必须显式传：对象键顺序不保证
    columns,
    columnWidths: orderFieldColumnWidths(columns, { label: FIELD_LABEL_COLUMN }),
    layout: "fixed",
    // 行数=记录数（通常 1），`maxRows` 只是兜底；也**不需要分页**了 ——
    // 分页是为「几千行」准备的，而这个表一行一条记录（见 table_utils 的 pageSize 说明）。
    maxRows: 2000,
    rawHeader: true
  });
  const count = $("order-fields-count");
  if (count) {
    count.textContent = rows.length
      ? `${rows.length} 条记录 · ${grid.fieldCount} 个字段（${grid.emptyCount} 个为空）`
      : "";
  }
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

/**
 * 按一个值跑完整流程：找 Order → 查历史 → 渲染。
 * @param {string} raw 用户在搜索框或输入框里给的值
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function runOrderHistory(raw) {
  const value = String(raw ?? "").trim();
  const btn = $("order-history-query-btn");
  if (!value) {
    setStatus("请输入 Order Name / Id / Order Number", "warn");
    return { ok: false, reason: "empty" };
  }

  if (btn) btn.disabled = true;
  setStatus(`正在查询 ${value} …`, "info");
  renderOrderCard(null);
  currentRows = [];
  currentFieldGrid = { columns: [], rows: [] };
  currentOrder = null;
  renderFieldsTable(currentFieldGrid);
  renderHistoryTable([]);
  const exportBtn = $("order-history-export-btn");
  if (exportBtn) exportBtn.disabled = true;

  // 每一次查询都从空的轨迹开始（上一次的日志留在那儿只会误导）
  resetTrace();
  const picked = classifyOrderValue(value);
  // 这一步是「值形状判断」的可见化：SOQL 里带不带 Id 条件、按什么查，都取决于它。
  // 用户看到「识别为 number」就能立刻意识到「我输的其实是 Id，但被当单号查了」。
  tracePush("info", "输入", `值「${value}」→ 识别为 ${picked.kind}（${KIND_LABEL[picked.kind] || "未知"}）`);

  try {
    const orders = await findOrder(picked);
    if (!orders.length) {
      tracePush(
        "error",
        "找 Order",
        `没有匹配的 Order —— 请确认这个值属于当前 org（已按 ${KIND_LABEL[picked.kind] || picked.kind} 查过）`
      );
      setStatus(`没有找到匹配「${value}」的 Order —— 请确认这个值属于当前 org`, "error");
      return { ok: false, reason: "order-not-found" };
    }
    tracePush(
      "success",
      "找 Order",
      `命中 ${orders.length} 条：${orders[0].OrderNumber || "(无单号)"} / ${orders[0].Name || "(无名称)"} / ${orders[0].Id}`
    );

    // 命中多条（同一个值同时像 OrderNumber 和 Name）时取第一条并把情况说清楚，
    // 别静默挑一条 —— 用户会以为查的是另一张单。
    const order = orders[0];
    currentOrder = order;
    renderOrderCard(order);

    // 字段表与历史表**并行**取：两个请求互不依赖，串行只是白等一个 RTT。
    // 字段表失败不影响历史表（老 API 版本不支持 FIELDS(ALL) 时降级为"不显示字段表"）。
    const [records, fieldGrid] = await Promise.all([
      fetchOrderHistory(order.Id),
      fetchOrderFields(order.Id).catch((e) => {
        // 字段表失败只影响它自己 —— 但**必须留痕**：用户看到「字段表是空的」要知道是
        // 查询失败还是这个 Order 真的没有字段（两者界面表现一样）。
        tracePush(
          "warning",
          "Order 字段",
          `查询失败（只影响字段表，历史表不受影响）：${(e && e.message) || e} → ${soqlErrorHint(
            e && e.errorCode,
            e && e.message
          )}`
        );
        return orderFieldGrid([], { label: FIELD_LABEL_COLUMN });
      })
    ]);
    const rows = historyRows(records, formatDateTime);
    currentRows = rows;
    currentFieldGrid = fieldGrid;

    const tRender = performance.now();
    renderFieldsTable(fieldGrid);
    renderHistoryTable(rows);
    tracePush(
      "info",
      "渲染",
      `字段表 ${fieldGrid.rows.length} 行 × ${fieldGrid.columns.length} 列 · ` +
        `历史表 ${rows.length} 行（历史表首屏 ${DEFAULT_PAGE_SIZE} 行，其余按需追加）`,
      { ms: performance.now() - tRender }
    );
    if (fieldGrid.fieldCount && !fieldGrid.rows.length) {
      tracePush("warning", "Order 字段", "没有取到该 Order 的字段");
    } else if (fieldGrid.fieldCount) {
      tracePush(
        "success",
        "Order 字段",
        `${fieldGrid.rows.length} 条记录 × ${fieldGrid.columns.length} 列（${fieldGrid.fieldCount} 个字段，${fieldGrid.emptyCount} 个为空）`
      );
    }
    if (rows.length) {
      tracePush(
        "success",
        "字段历史",
        `${rows.length} 条，已按 CreatedDate 倒序` +
          (records.length >= HISTORY_LIMIT ? `（服务端只回了 ${HISTORY_LIMIT} 条上限内）` : "")
      );
    }
    if (exportBtn) exportBtn.disabled = rows.length === 0 && fieldGrid.rows.length === 0;

    const more = records.length >= HISTORY_LIMIT ? `（只显示最近 ${HISTORY_LIMIT} 条）` : "";
    const parts = [order.OrderNumber || order.Id];
    if (fieldGrid.fieldCount) parts.push(`字段 ${fieldGrid.fieldCount} 个`);
    if (rows.length) parts.push(`历史 ${rows.length} 条（按时间倒序）${more}`);
    if (orders.length > 1) parts.push(`有 ${orders.length} 个 Order 匹配该值，当前显示第一个`);

    if (rows.length === 0) {
      tracePush(
        "warning",
        "字段历史",
        "这个 Order 一条历史都没有 —— 该 org 可能没有对 Order 开启「字段历史追踪」（Salesforce 默认不开），" +
          "或这张单确实没发生过变更"
      );
      parts.push(
        "没有任何字段历史 —— 该 org 可能没有对 Order 开启「字段历史追踪」（Salesforce 默认不开）"
      );
      setStatus(parts.join(" · "), "warn");
      return { ok: true, reason: "no-history" };
    }

    setStatus(parts.join(" · "), "ok");
    return { ok: true };
  } catch (e) {
    const code = e && e.errorCode ? e.errorCode : "";
    // 失败再补一条「总览」：前面（querySoql）已经记了失败的那一步与 SOQL，
    // 这里只补一句「这次查询到此为止」，省得用户盯着日志猜有没有继续往下跑。
    tracePush("error", "结束", `本次查询中止：${code || "ERROR"} —— 上面带 SOQL 的那一步就是失败点`);
    if (code === "INVALID_TYPE" || /OrderHistory/i.test(String(e && e.message))) {
      // 对象不存在 = 这个 org 从没给 Order 开过字段历史追踪
      setStatus(
        "当前 org 没有 OrderHistory 对象 —— 需要在 Salesforce 里对 Order 开启「字段历史追踪」后才能查历史",
        "error"
      );
    } else if (code === "NO_CONNECTION") {
      // 启动期（会话还在恢复）与真的没连上都走到这里 —— 文案要给出可执行的下一步，
      // 而不是让用户盯着「尚未连接」猜。
      setStatus("Salesforce 连接还没就绪：连上后再点一次「查询历史」即可", "warn");
    } else {
      setStatus(`查询失败：${(e && e.message) || e}`, "error");
    }
    log.warn("Order 历史查询失败:", e);
    showNotification("Order 历史查询失败", "error");
    return { ok: false, reason: code || "error" };
  } finally {
    if (btn) btn.disabled = false;
  }
}

/**
 * 从搜索（面板或网页浮层）带着一个值进来：填进输入框 + 自动查一次。
 * `step` 的跳转由调用方负责（这里只处理值与查询）。
 */
export function openOrderHistoryWith(value) {
  const input = $("order-history-query-input");
  if (input && value) input.value = value;
  return runOrderHistory(value);
}

/**
 * 导出**一个文件两个 sheet**：字段表 + 历史表（列序与界面完全一致）。
 * 为什么不是一个 sheet：字段是「当前快照」、历史是「变更流水」，语义不同，
 * 混在一张表里既不好筛也不好排序。
 */
export async function exportOrderHistory() {
  if (!currentRows.length && !currentFieldGrid.rows.length) {
    showNotification("没有可导出的数据", "info");
    return;
  }
  const tag = currentOrder && currentOrder.OrderNumber ? currentOrder.OrderNumber : "order";
  await exportSheetsToExcel(
    [
      // 字段表：一条记录一行（列 = 字段），与界面完全同形 —— 在 Excel 里也是一行看完整张单
      { name: "Order 字段", data: currentFieldGrid.rows },
      { name: "OrderHistory", data: currentRows }
    ],
    `OrderHistory_${tag}`
  );
}

/** 清空输入与结果 */
function clearOrderHistory() {
  const input = $("order-history-query-input");
  if (input) {
    input.value = "";
    input.focus();
  }
  currentRows = [];
  currentFieldGrid = { columns: [], rows: [] };
  currentOrder = null;
  renderOrderCard(null);
  renderFieldsTable(currentFieldGrid);
  renderHistoryTable([]);
  const exportBtn = $("order-history-export-btn");
  if (exportBtn) exportBtn.disabled = true;
  setStatus("", "info");
  resetTrace(); // 「清空」连日志一起清，否则下次查询前还挂着上一次的痕迹
}

/* ------------------------------------------------------------------ *
 * 事件绑定（幂等，由 app.js 的 bindEvents 调用一次）
 * ------------------------------------------------------------------ */

let bound = false;

export function initOrderHistory() {
  if (bound) return;
  bound = true;

  const run = () => {
    const input = $("order-history-query-input");
    runOrderHistory(input ? input.value : "");
  };

  on("order-history-query-btn", "click", run);
  on("order-history-clear-btn", "click", clearOrderHistory);
  on("order-history-log-copy", "click", copyTrace);
  on("order-history-export-btn", "click", exportOrderHistory);
  on("order-history-query-input", "keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      run();
    }
  });

  // 初始提示只说**怎么用**，不说连接状态：绑事件发生在 `initApp()` 中段，那时会话
  // 通常还没恢复完 —— 写「尚未连接」会在几百毫秒后变成假话（面板用例里能看到它
  // 一直挂在那儿）。真未连接时的提示由 `runOrderHistory()` 的 NO_CONNECTION 分支给。
  if (!currentRows.length) setStatus("输入 Order 的 Name / Id / Order Number 后点「查询历史」", "info");
  // 「查询日志」块默认隐藏（首次查询后才出现），空的时候不占位置
  renderTrace();
}
