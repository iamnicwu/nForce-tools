/**
 * Apex 日志分析：把 `@apexdevtools/apex-log-parser` 的解析结果转成**视图模型**。
 *
 * ── 为什么单独一层 ──
 * 解析器给出来的是一棵带父/子链接的事件树（节点上有 `duration`、行数、行号等十几个字段），
 * 而界面要的是"这几个数字 + 几张表 + 一棵能折叠的树"。把「挑字段 / 排序 / 取前 N / 转文本」
 * 这些**纯计算**放在这里，就能在 node 里单测 —— 真页面的渲染反过来只能靠截图。
 * （定位同 `common/order_query.js` / `common/apex_log.js`。）
 *
 * ⚠️ 两条这个库的硬事实（踩过就会写出错的东西）：
 *   ① **指标字段是 `{self, total}` 形状**（`duration` / `soqlRows` / `dmlRows` / 根上的
 *      `soqlCount` 全都如此），直接 `Number(x)` 会得到 `NaN` —— 一律走 `metric()`。
 *   ② **解析结果是循环结构**（节点上带 `logParser`，`logParser.eventsById` 又指回节点），
 *      所以**绝不能 `JSON.stringify(root)`**，取字段只能逐个挑标量。
 */

import { escapeHtml } from "./utils.js";

/** 明细表默认最多列这么多行（日志可能有几千次查询，DOM 撑不住也没人看） */
export const DETAIL_ROW_LIMIT = 200;

/** 调用树默认最多渲染这么多节点（超出提示"完整内容请下载日志"） */
export const TREE_NODE_LIMIT = 600;

/** 把库里 `{self, total}` 形状（或裸数字）统一成 total 数值 */
export function metric(value) {
  if (value && typeof value === "object") return Number(value.total) || 0;
  return Number(value) || 0;
}

/** 节点耗时（毫秒）。库里单位是纳秒 */
export function durationMs(node) {
  return metric(node && node.duration) / 1e6;
}

/** 节点**自身**耗时（毫秒）：`duration.self`；库没给就自己减（total − 子节点 total） */
export function selfMs(node) {
  const raw = node && node.duration;
  if (raw && typeof raw === "object" && Number.isFinite(Number(raw.self))) {
    return (Number(raw.self) || 0) / 1e6;
  }
  const kids = ((node && node.children) || []).reduce((acc, c) => acc + metric(c && c.duration), 0);
  return Math.max(0, metric(raw) - kids) / 1e6;
}

export function typeOf(node) {
  return String((node && node.type) || "");
}

/** 节点的一行摘要文本（库把参数拼进了 `text`） */
export function labelOf(node) {
  const text = node && node.text;
  if (typeof text === "string" && text) return text;
  return typeOf(node);
}

/**
 * 深度优先展平事件树。
 * 起点是解析结果的 `children`（根节点自己是个 `type: null` 的虚拟容器）。
 * @returns {Array<{node: object, depth: number}>}
 */
export function walkEvents(root) {
  const out = [];
  const visit = (node, depth) => {
    if (!node) return;
    out.push({ node, depth });
    const children = Array.isArray(node.children) ? node.children : [];
    children.forEach((child) => visit(child, depth + 1));
  };
  const tops = (root && Array.isArray(root.children) && root.children) || [];
  tops.forEach((node) => visit(node, 0));
  return out;
}

/** 概览数字（界面顶部那几个格子）。全部走 `metric()`，缺字段就是 0，不抛错。 */
export function summarize(root) {
  const events = walkEvents(root);
  const r = root || {};
  const issues = (v) => (Array.isArray(v) ? v.length : 0);
  return {
    eventCount: events.length,
    durationMs: durationMs(root),
    soql: { count: metric(r.soqlCount), rows: metric(r.soqlRowCount) },
    dml: { count: metric(r.dmlCount), rows: metric(r.dmlRowCount) },
    sosl: { count: metric(r.soslCount), rows: metric(r.soslRowCount) },
    thrownCount: metric(r.thrownCount),
    heapPeakBytes: metric(r.heapPeak),
    startTime: typeof r.startTime === "string" ? r.startTime : "",
    // 事务入口类型（Anonymous Apex / Trigger / Batch…）：数组里可能是字符串或对象
    entryPoints: (Array.isArray(r.entryPoints) ? r.entryPoints : []).map(issueText).filter(Boolean),
    parsingErrorCount: issues(r.parsingErrors),
    logIssueCount: issues(r.logIssues),
    // 日志大小（库报的字节数；和 LogLength 对不上时以它为准）
    sizeBytes: metric(r.size),
    truncated: isTruncated(r)
  };
}

/**
 * 这份日志是不是被截断了。
 *
 * ⚠️ 不能写 `!!r.truncation`：库的 `truncation` **永远是个对象**
 * （没截断时是 `{ regions: [], totalSkippedBytes: 0 }`），真值判断会让**每一份正常日志**
 * 都被标成"被截断、统计偏小" —— 2026-10-16 的第一版就是这么误报的，截图里一眼看到。
 * 判据要落到具体字段上：跳过过字节、有跳过区间、或真有被截断的事件。
 */
export function isTruncated(root) {
  const r = root || {};
  const t = r.truncation;
  if (t && typeof t === "object") {
    if (Number(t.totalSkippedBytes) > 0) return true;
    if (Array.isArray(t.regions) && t.regions.length > 0) return true;
  }
  return Array.isArray(r.truncatedEvents) && r.truncatedEvents.length > 0;
}

/**
 * 最"重"的节点：按**自身耗时**排序。
 *
 * 为什么用 self 而不是 total：容器节点（CODE_UNIT / EXECUTION_STARTED）的 total 永远是
 * 最大的那几个 —— 那只能告诉用户"整个事务花了 3 秒"，回答不了"慢在哪一步"。
 */
export function topSlowest(root, limit = 8) {
  return walkEvents(root)
    .map(({ node, depth }) => ({ node, depth, ms: selfMs(node) }))
    .filter((row) => row.ms > 0 && !row.node.isExit)
    .sort((a, b) => b.ms - a.ms)
    .slice(0, limit);
}

/**
 * SOQL / DML 明细行。
 * @param {object} root 解析结果
 * @param {string} prefix "SOQL" / "DML" / "SOSL"
 */
export function statementRows(root, prefix, limit = DETAIL_ROW_LIMIT) {
  return walkEvents(root)
    .map(({ node }) => node)
    .filter((node) => typeOf(node).startsWith(`${prefix}_`))
    .filter((node) => !/_END$/.test(typeOf(node))) // 只留 BEGIN，END 是它的出口事件
    .map((node) => ({
      text: labelOf(node),
      // 行数/耗时都挂在 BEGIN 上（库把 END 的 Rows:N 归到了这里）
      rows: metric(prefix === "DML" ? node.dmlRows : node.soqlRows),
      ms: durationMs(node),
      line: node.lineNumber == null ? "" : String(node.lineNumber)
    }))
    .slice(0, limit);
}

/** 事务里的异常与解析问题（合并成一列给界面用） */
export function issuesList(root) {
  const r = root || {};
  const out = [];
  const push = (kind, list) => {
    (Array.isArray(list) ? list : []).forEach((item) => {
      const text = issueText(item);
      if (text) out.push({ kind, text });
    });
  };
  push("异常", r.exceptions);
  push("事务问题", r.logIssues);
  push("未解析的行", r.parsingErrors);
  return out;
}

/**
 * 把一个"问题"对象转成一行文本。
 * ⚠️ 不能 `JSON.stringify`（解析结果里有循环引用，会直接抛 TypeError）。
 */
function issueText(item) {
  if (item == null) return "";
  if (typeof item === "string") return item;
  if (typeof item !== "object") return String(item);
  for (const key of ["summary", "message", "description", "text", "issueType", "name", "type"]) {
    const v = item[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * 调用树 HTML（嵌套 `<details>`，原生可折叠 —— 不需要一行 JS）。
 * 节点数超过 `maxNodes` 时截断并提示（日志可能有几万个事件）。
 */
export function treeHtml(root, { maxNodes = TREE_NODE_LIMIT } = {}) {
  let rendered = 0;
  let truncated = false;

  const render = (node) => {
    if (!node) return "";
    if (rendered >= maxNodes) {
      truncated = true;
      return "";
    }
    rendered += 1;
    // ⚠️ 必须在**渲染子节点之前**把序号记下来：下面 `children.map(render)` 会把
    // `rendered` 一路推大，最后再判断"这是第几个"就永远不是前 3 个 ——
    // 表现是调用树整棵都是折叠的（2026-10-16 截图里看到的），而断言不会红。
    const isOpen = rendered <= 3;
    const children = Array.isArray(node.children) ? node.children : [];
    const inner = children.map(render).join("");
    const ms = selfMs(node) > 0 ? selfMs(node) : durationMs(node);
    return (
      `<details class="view-log-tree-node"${isOpen ? " open" : ""}>` +
      `<summary>` +
      `<span class="u-fs-xs u-fw-600">${escapeHtml(typeOf(node))}</span> ` +
      `<span class="u-break-all">${escapeHtml(labelOf(node)).slice(0, 300)}</span> ` +
      `<span class="u-fs-xs u-text-secondary">${escapeHtml(formatMs(ms))}</span>` +
      `</summary>${inner}</details>`
    );
  };

  const html = ((root && root.children) || []).map(render).join("");
  const note = truncated
    ? `<p class="u-fs-xs u-text-secondary u-mt-8">只画了前 ${maxNodes} 个节点，其余省略（完整内容请看下面的原始日志）。</p>`
    : "";
  return html + note;
}

/** `12.3 ms` / `1.25 s` */
export function formatMs(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "0 ms";
  if (n < 1000) return `${n.toFixed(n < 10 ? 2 : 1)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

/** `1.2 MB` / `340 KB` */
export function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n <= 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}
