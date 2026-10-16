/**
 * 「在搜索框里输入 Order 的 Name / Id / OrderNumber → 查它的历史」这条链路的**纯逻辑**：
 * 值识别 + SOQL 拼装。
 *
 * ── 为什么单独一个零依赖模块 ──
 * 有两处要用同一份判断：
 *   ① 插件自己的搜索面板（`biz/command_palette.js` / `common/cmdk_view.js`）；
 *   ② **service worker**：注入到网页的浮层要显示「查询 Order 历史」这一条，
 *      而它的结果 HTML 是 SW 用 `cmdk_view.renderList()` 渲染的。
 * SW 是逐字复制、不经打包器的，**不能** import 任何拖着 sf_service / ui.js 的模块 ——
 * 所以识别与拼 SOQL 这两件事必须住在一个零依赖文件里（同 `command_index.js` 的理由）。
 *
 * 只做纯字符串/纯数据的事，不碰 chrome.* / DOM / 网络 —— 这样 `test/*.test.js` 能直接测。
 */

/** Salesforce 记录 Id：15 位或 18 位字母数字（大小写敏感，但 Salesforce 两者都接受） */
const SF_ID_RE = /^[a-zA-Z0-9]{15}$|^[a-zA-Z0-9]{18}$/;
/** 纯数字：OrderNumber 是自动编号，实际就是 00012345 这种 */
const PURE_NUMBER_RE = /^\d{4,}$/;
/** 带连字符/下划线的业务号（ORD-2024-0001 / PCCW_0001）：长度 ≥6 且含数字 */
const DASHED_CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{5,}$/;

/** SOQL 里单引号是最外层的字符串定界符 —— 值里的单引号必须转义，否则就是语法错 */
function escapeSoqlString(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/**
 * 判断一个文本「像不像一个 Order 标识」。**判据刻意保守** ——
 * 它决定"要不要把『查询 Order 历史』塞进搜索结果的第一条"，
 * 判宽了会把正常的功能搜索（如 `t4list`、`wucan`）顶掉。
 *
 * @param {string} raw
 * @returns {{value: string, kind: "id"|"number"|"code"} | null}
 */
export function detectOrderQuery(raw) {
  const value = String(raw ?? "").trim();
  if (!value) return null;

  // 显式前缀：`#ORD-123` 表示"我知道这不是功能名，就当订单值查"
  if (value.startsWith("#")) {
    const forced = value.slice(1).trim();
    if (!forced) return null;
    const kind = SF_ID_RE.test(forced) ? "id" : PURE_NUMBER_RE.test(forced) ? "number" : "code";
    return { value: forced, kind };
  }

  if (SF_ID_RE.test(value)) return { value, kind: "id" };
  if (PURE_NUMBER_RE.test(value)) return { value, kind: "number" };
  // 必须**同时**含连字符/下划线、含数字、且够长 —— `t4list`（只有数字没有分隔符）不会被误判
  if (/[-_]/.test(value) && /\d/.test(value) && DASHED_CODE_RE.test(value)) {
    return { value, kind: "code" };
  }
  return null;
}

/**
 * 表单里用户是"明确要查这个值"，所以不做形状限制；但 `Id` 那一支只在
 * **长得像 Id** 时才拼进 WHERE —— 否则 Salesforce 会对非法 Id 直接报 `MALFORMED_ID`。
 *
 * @param {string} raw
 * @returns {{value: string, kind: "id"|"number"|"code"|"any"}}
 */
export function classifyOrderValue(raw) {
  const value = String(raw ?? "").trim();
  const detected = detectOrderQuery(value);
  if (detected) return detected;
  return { value, kind: "any" };
}

/** 值 → WHERE 子句（不含 `WHERE` 关键字）。kind=id 时才带 Id 条件 */
export function buildOrderWhere({ value, kind }, { includeName = true } = {}) {
  const v = escapeSoqlString(value);
  const clauses = [];
  if (kind === "id") clauses.push(`Id = '${v}'`);
  clauses.push(`OrderNumber = '${v}'`);
  if (includeName) clauses.push(`Name = '${v}'`);
  return clauses.join(" OR ");
}

/**
 * 按值找 Order。
 * @param {{value: string, kind: string}} value
 * @param {{includeName?: boolean, limit?: number}} [opts]
 *        `includeName: false` 是降级开关 —— `Name` 虽是 Order 的标准字段，
 *        但个别 org / API 版本上没有它，查询会以 `INVALID_FIELD` 失败。
 */
export function buildOrderSoql(value, { includeName = true, limit = 5 } = {}) {
  return (
    `SELECT Id, OrderNumber, ${includeName ? "Name, " : ""}Custom_OrderStatus__c FROM Order ` +
    `WHERE ${buildOrderWhere(value, { includeName })} LIMIT ${Number(limit) || 5}`
  );
}

/**
 * 某个 Order 的**全部字段**值。
 *
 * 用 SOQL 的 `FIELDS(ALL)` 函数（API 51+）：它让服务端把该对象的字段全给我，
 * 不用先 describe 再拼一长串字段名（Order 在 Vlocity org 里动辄两三百个字段）。
 * ⚠️ 用 `FIELDS()` 时 SOQL **必须带 LIMIT ≤ 200** —— 这里按 Id 精确取一条，天然满足。
 *
 * @param {string} orderId
 */
export function buildOrderFieldsSoql(orderId) {
  // FIELDS(ALL) 不能与 WHERE 里的关系字段过滤混用，但按 Id 等值过滤是允许的
  return `SELECT FIELDS(ALL) FROM Order WHERE Id = '${escapeSoqlString(orderId)}' LIMIT 1`;
}

/**
 * 把 Order 记录摊成**网格**：**一行一条记录、一列一个字段** —— 也就是 SOQL 结果的形状。
 *
 * 为什么不是「一个字段一行」（2026-10-16 改）：用户在看的**是这条单**，不是在读字段清单。
 * 一字段一行时，列只有两列、信息密度极低，两三百个字段要滚很久；摊成一行之后字段名变成列头
 * （横向滚动 + 固定列宽），一眼就是「这单的全部属性」。
 * 顺带的好处：DOM 从 **2N 个单元格**降到 **N+1 个**（N = 字段数，几百字段时是实打实的差别）。
 *
 * 关系字段（`Foo__r: {Name, Id}`）取 `Name` 或 `Id` 显示，其余对象类型 JSON 化 ——
 * 直接 `String(对象)` 会得到 `[object Object]`，那是最没用的显示。
 *
 * @param {Array<object>|object} records SOQL 记录（通常 1 条；也支持多条 → 多行）
 * @param {{label?: string, labelOf?: (r: object) => string}} [opts]
 *        `label` 是第一列（行标识）的列名，默认 `Order`；`labelOf` 决定它的值（默认单号，退回 Id）
 * @returns {{columns: string[], rows: Array<object>, fieldCount: number, emptyCount: number}} *          `columns` 给 `renderTable` 用（对象键顺序不保证，必须显式传）
 */
export function orderFieldGrid(records, opts = {}) {
  const list = (Array.isArray(records) ? records : [records]).filter(
    (r) => r && typeof r === "object"
  );
  if (!list.length) return { columns: [], rows: [], fieldCount: 0, emptyCount: 0 };

  const label = opts.label || "Order";
  const labelOf =
    typeof opts.labelOf === "function" ? opts.labelOf : (r) => r.OrderNumber || r.Id || "";

  // 列 = 各记录字段名的**并集**，按 API 名排序（稳定、好找；多条记录时也不会错位）
  const keys = [
    ...new Set(
      list.flatMap((r) => Object.keys(r).filter((k) => k !== "attributes")) // attributes 是 SOQL 的类型元信息
    )
  ].sort((a, b) => a.localeCompare(b));

  let fieldCount = 0;
  let emptyCount = 0;
  const rows = list.map((record) => {
    const row = { [label]: String(labelOf(record) || "") };
    keys.forEach((key) => {
      const value = formatFieldValue(record[key]);
      // 只统计**这条记录真的有这个字段**的那些（多条记录时并集里可能有别人没有的列）
      if (Object.prototype.hasOwnProperty.call(record, key)) {
        fieldCount++;
        if (value === "") emptyCount++;
      }
      row[key] = value;
    });
    return row;
  });

  return { columns: [label, ...keys], rows, fieldCount, emptyCount };
}

/**
 * 网格的列宽（给 `renderTable` 的 `columnWidths`）。
 *
 * ⚠️ 固定布局下**每列都必须给宽度**：没给的列平分剩余宽度，几百列时会挤成 0 宽。
 */
export function orderFieldColumnWidths(
  columns,
  { label = "Order", labelWidth = "10rem", fieldWidth = "12rem" } = {}
) {
  const widths = {};
  (Array.isArray(columns) ? columns : []).forEach((col) => {
    widths[col] = col === label ? labelWidth : fieldWidth;
  });
  return widths;
}

function formatFieldValue(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") {
    // 关系字段：优先挑人看得懂的那个属性
    if (typeof value.Name === "string") return value.Name;
    if (typeof value.Id === "string") return value.Id;
    try {
      return JSON.stringify(value);
    } catch (e) {
      return String(value);
    }
  }
  return String(value);
}

/**
 * 某个 Order 的字段历史（标准 `OrderHistory`，需要该 org 对 Order 开了字段历史追踪）。
 * @param {string} orderId 18 位 Id
 * @param {number} [limit]
 */
export function buildHistorySoql(orderId, limit = 200) {
  return (
    "SELECT Id, Field, OldValue, NewValue, CreatedDate, CreatedById, CreatedBy.Name " +
    "FROM OrderHistory " +
    // ⚠️ 父字段是 **OrderId**，不是 `ParentId`。标准对象的字段历史对象用「对象名 + Id」命名 ——
    //    `AccountHistory.AccountId`、`ContactHistory.ContactId`、`OrderHistory.OrderId`……
    //    （Salesforce 的 OrderHistory 对象参考里写的就是 OrderId。）
    //    而 `ParentId` 是**自定义对象**历史（`Foo__History`）用的那套命名。
    //    2026-10-16 的教训：我按「通用命名」猜这里该是 ParentId，还把它「改回」过一次 —— 那是错的，
    //    本 org 用 OrderId 是用户在真 org 上确认过的。单测与假 Org 现在都按 OrderId 盯着，
    //    **别再按猜测动这一行**。
    `WHERE OrderId = '${escapeSoqlString(orderId)}' ` +
    `ORDER BY CreatedDate DESC LIMIT ${Number(limit) || 200}`
  );
}

/**
 * 把查询结果整理成表格行（中文列名，`renderTable` 直接吃）。
 *
 * **在这里自己按 CreatedDate 倒序**，不依赖服务端顺序：
 * SOQL 里确实写了 `ORDER BY CreatedDate DESC`，但「服务端会不会守规矩」不该由界面来假设 ——
 * 客户端排一次是 O(n log n)、几百行可忽略，却让「最新在最上面」这个承诺**可断言、可测**。
 * （这条是被 panel-shot 抓出来的：假 Org 当时没实现 ORDER BY，界面顺序就错了。）
 *
 * 时间格式化交给调用方传进来的函数，本模块保持零依赖。
 *
 * @param {Array<object>} records OrderHistory 记录
 * @param {(v:*) => string} formatTime 时间格式化函数（页面侧传 utils 的 formatDateTime）
 */
export function historyRows(records, formatTime) {
  const sorted = (Array.isArray(records) ? records : []).slice().sort((a, b) => {
    const ta = Date.parse((a && a.CreatedDate) || "");
    const tb = Date.parse((b && b.CreatedDate) || "");
    // 解析不出来（缺字段 / 非 ISO）就退回字符串比较 —— 至少顺序是确定的
    if (Number.isNaN(ta) || Number.isNaN(tb)) {
      return String((b && b.CreatedDate) || "").localeCompare(String((a && a.CreatedDate) || ""));
    }
    return tb - ta;
  });

  return sorted.map((r) => ({
    时间: formatTime(r && r.CreatedDate),
    字段: (r && r.Field) || "",
    旧值: r && r.OldValue !== null && r.OldValue !== undefined ? String(r.OldValue) : "",
    新值: r && r.NewValue !== null && r.NewValue !== undefined ? String(r.NewValue) : "",
    操作人: (r && r.CreatedBy && r.CreatedBy.Name) || ""
  }));
}

/**
 * SOQL 收成一行。
 *
 * 代码里的 SOQL 是多行写的（便于阅读），但日志与剪贴板里**一行**更好用：
 * 直接粘进 Salesforce Developer Console 的 Query Editor 就能跑，不会把缩进也带进去。
 */
export function oneLineSoql(soql) {
  return String(soql || "").replace(/\s+/g, " ").trim();
}

/**
 * 把 Salesforce 的 errorCode / 报错文案翻成「**下一步该做什么**」。
 *
 * 这是诊断日志最重要的一半：日志只说明「失败了」，用户要的是「那我改什么」。
 * 判据用 errorCode 优先、文案兜底 —— 不同 org / API 版本给的文案不一定一样，
 * 但 errorCode 是稳定的。
 *
 * @param {string} errorCode 如 `INVALID_TYPE`（`sf_rest_client` 会把它挂在 Error 上）
 * @param {string} [message] 服务端原文
 * @returns {string} 一句可执行的建议；认不出来时给通用建议（贴到 Developer Console 跑）
 */
export function soqlErrorHint(errorCode, message) {
  const code = String(errorCode || "").toUpperCase();
  const msg = String(message || "");

  if (code === "NO_CONNECTION") {
    return "还没有可用的 Salesforce 连接：连上之后再点一次「查询历史」";
  }
  if (code === "INVALID_TYPE" || /is not supported|no such object/i.test(msg)) {
    return "该 org 里没有这个对象：OrderHistory 只在**对 Order 开启字段历史追踪**之后才存在";
  }
  if (code === "INVALID_FIELD" || /no such column/i.test(msg)) {
    return "SOQL 用到了该 org 上没有的字段（本功能已自动降级重试过一次，仍失败就是这个字段真的不存在）";
  }
  if (code === "MALFORMED_QUERY" || /unexpected token|expecting/i.test(msg)) {
    return "SOQL 语法/用法问题：常见是 FIELDS() 没带 LIMIT（必须 ≤ 200）、或写了不能查的复合字段";
  }
  if (code === "INSUFFICIENT_ACCESS" || code === "INSUFFICIENT_ACCESS_OR_READONLY") {
    return "当前用户对 Order / OrderHistory 没有读权限（找管理员开一下对象的读权限）";
  }
  if (code === "INVALID_SESSION_ID" || code === "INVALID_SESSION") {
    return "会话失效：插件会自动重连，连上后再点一次「查询历史」";
  }
  if (code === "NOT_FOUND") {
    return "请求路径不对（多为 API 版本）或对象不存在：对照日志里的 SOQL 与「设置 → 插件偏好」的 API 版本";
  }
  if (/Failed to fetch|NetworkError|Load failed|CSP/i.test(msg)) {
    return "请求根本没发出去（网络 / CSP / 被拦）：看 DevTools 的 Network 面板与 console";
  }
  return "把上面那行 SOQL 贴到 Salesforce 的 Developer Console 里跑一次，服务端会给出更具体的报错";
}

/** 表格列顺序（`renderTable` 的 columns 选项用；也决定导出 Excel 的列序） */
export const HISTORY_COLUMNS = Object.freeze(["时间", "字段", "旧值", "新值", "操作人"]);

/**
 * Order 字段表的列**不再固定**（一条记录一行之后，列 = 该记录的字段名，由
 * `orderFieldGrid()` 现算）—— 这里只留第一列（行标识）的列名。
 */
export const FIELD_LABEL_COLUMN = "Order";

/**
 * 两张表的列宽（`renderTable` 的 `columnWidths`）—— 配 `layout: "fixed"` 用。
 * 数值是「内容大概需要多宽」，不是精确测量：fixed 布局下浏览器不再量内容，
 * 给不准也只是出现省略号，不会重排整表。
 */
export const HISTORY_COLUMN_WIDTHS = Object.freeze({
  时间: "10rem",
  字段: "13rem",
  旧值: "10rem",
  新值: "10rem",
  操作人: "8rem"
});

// 字段表的列宽不再是常量：列是动态的，见 orderFieldColumnWidths()
