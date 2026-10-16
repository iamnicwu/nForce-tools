/**
 * SOQL 查询框的**代码提示纯逻辑**。
 *
 * ── 与 Apex 提示最大的不同 ──
 * Apex 是"顺着打"的（`System.` → 成员），而 SOQL 的提示**依赖整条语句**：
 * 用户常常先写 `SELECT ` 再回头选字段，而 `FROM Account` 还在光标**后面** ——
 * 只看光标之前的文本是拿不到对象名的，那张字段表就永远是空的。
 * 所以这里解析上下文时**扫整条语句**（`findFromTarget`），只把"当前在哪个子句"
 * （`findClause`）限定在光标之前。
 *
 * 复用了 `common/apex_completions.js` 的通用部分：`parseContext`（token / 前缀 / 字符串判定）、
 * `rankCompletions`（排序）、`applyCompletion`（插回文本）—— 那三件事两种语言完全一样。
 */

import { parseContext, rankCompletions as rankBase, applyCompletion } from "./apex_completions.js";
import { STANDARD_OBJECTS } from "./apex_symbols.js";

/** 子句关键字（用来判断"光标现在处在哪个子句里"） */
const CLAUSE_PATTERN =
  /\b(SELECT|FROM|WHERE|GROUP\s+BY|ORDER\s+BY|HAVING|LIMIT|OFFSET|WITH\s+DATA\s+CATEGORY|TYPEOF|WHEN|ELSE|END)\b/gi;

/** 这些词出现在 `FROM X <词>` 的那个位置时，说明它不是别名 */
const NOT_ALIAS = new Set([
  "WHERE", "ORDER", "GROUP", "HAVING", "LIMIT", "OFFSET", "WITH", "USING", "SCOPE",
  "FOR", "UPDATE", "VIEW", "TRACKING", "TYPEOF", "WHEN", "ELSE", "END", "AND", "OR"
]);

/** 通用关键字（各子句都可能用到） */
const SOQL_KEYWORDS = [
  "AND", "OR", "NOT", "IN", "LIKE", "INCLUDES", "EXCLUDES", "ASC", "DESC",
  "NULLS FIRST", "NULLS LAST", "LIMIT", "OFFSET", "FOR UPDATE", "FOR VIEW",
  "WITH DATA CATEGORY", "WITH SECURITY_ENFORCED", "ALL ROWS"
];

/** 常用函数（`SELECT COUNT(Id)`、`WHERE CALENDAR_MONTH(CreatedDate) = 12`） */
const SOQL_FUNCTIONS = [
  { name: "COUNT()", detail: "行数（聚合）" },
  { name: "COUNT_DISTINCT()", detail: "去重行数" },
  { name: "SUM()", detail: "求和" },
  { name: "AVG()", detail: "平均" },
  { name: "MIN()", detail: "最小值" },
  { name: "MAX()", detail: "最大值" },
  { name: "CALENDAR_MONTH()", detail: "月份（1-12）" },
  { name: "CALENDAR_YEAR()", detail: "年份" },
  { name: "CALENDAR_QUARTER()", detail: "季度" },
  { name: "DAY_ONLY()", detail: "只取日期部分" },
  { name: "FORMAT()", detail: "格式化（本地化显示）" },
  { name: "toLabel()", detail: "取选项字段的标签" },
  { name: "convertCurrency()", detail: "多币种换算" }
];

/** 日期字面量（WHERE 里最常用的一组） */
const SOQL_DATE_LITERALS = [
  "TODAY", "YESTERDAY", "TOMORROW", "THIS_WEEK", "LAST_WEEK", "NEXT_WEEK",
  "THIS_MONTH", "LAST_MONTH", "NEXT_MONTH", "THIS_QUARTER", "LAST_QUARTER",
  "NEXT_QUARTER", "THIS_YEAR", "LAST_YEAR", "NEXT_YEAR",
  "LAST_N_DAYS:n", "NEXT_N_DAYS:n", "LAST_N_WEEKS:n", "LAST_N_MONTHS:n"
];

/** 把字符串字面量挖成空串再解析 —— 否则 `WHERE Name = 'from x'` 会把 from 当子句 */
function stripStrings(text) {
  return String(text == null ? "" : text).replace(/'([^'\\]|\\.)*'/g, "''");
}

/**
 * 从**整条语句**里找主查询的 `FROM <对象>`（顺带识别别名）。
 * 只看主查询：SOQL 的子查询写在括号里，这里的正则取第一个 FROM，够用且可预测。
 */
export function findFromTarget(text) {
  const clean = stripStrings(text);
  const match = /\bFROM\s+([A-Za-z0-9_]+)(?:\s+([A-Za-z0-9_]+))?/i.exec(clean);
  if (!match) return { objectName: null, alias: null };
  const objectName = match[1];
  const next = match[2];
  const alias = next && !NOT_ALIAS.has(next.toUpperCase()) ? next : null;
  return { objectName, alias };
}

/** 光标现在处在哪个子句里（只看光标**之前**） */
export function findClause(text, caret) {
  const before = stripStrings(String(text == null ? "" : text).slice(0, caret));
  let last = null;
  CLAUSE_PATTERN.lastIndex = 0;
  let match;
  while ((match = CLAUSE_PATTERN.exec(before)) !== null) {
    last = match[1].toUpperCase().replace(/\s+/g, " ");
  }
  if (!last) return "NONE";
  if (last === "GROUP BY" || last === "ORDER BY") return last;
  return last;
}

/**
 * 解析补全上下文。
 * @param {string} text 整条 SOQL
 * @param {number} caret
 */
export function parseSoqlContext(text, caret) {
  const base = parseContext(text, caret);
  const { objectName, alias } = findFromTarget(text);
  return {
    ...base,
    clause: findClause(text, caret),
    objectName,
    alias,
    // `Account.Na` 里的对象前缀（parseContext 已经把它当 receiver 取出来了）
    qualifier: base.receiver || null
  };
}

/** 当前语句"对应的对象名"：优先用 `X.` 前缀（用户明确指定的那个） */
export function effectiveObject(ctx) {
  if (!ctx) return null;
  const qualifier = ctx.qualifier;
  if (qualifier) {
    // 前缀可能是语句里的别名（`FROM Account a` → `a.Name`），换成真对象名
    if (ctx.alias && ctx.alias.toLowerCase() === qualifier.toLowerCase()) return ctx.objectName;
    return qualifier;
  }
  return ctx.objectName;
}

function sobjectEntry(name, fromOrg) {
  return {
    label: name,
    kind: "sObject",
    detail: fromOrg ? "对象（来自当前 org）" : "常用标准对象",
    insert: name
  };
}

/**
 * 组装候选（按子句分流）。
 *
 * @param {object} ctx `parseSoqlContext()` 的结果
 * @param {{sObjects?: string[], objectFields?: Record<string,string[]>}} [extra]
 */
export function collectSoqlCompletions(ctx, extra = {}) {
  if (!ctx || ctx.blocked) return [];

  const runtimeObjects = Array.isArray(extra.sObjects) ? extra.sObjects : [];
  const staticObjects = Object.keys(STANDARD_OBJECTS);
  const allObjects = [...new Set([...runtimeObjects, ...staticObjects])];
  const isRuntime = (name) => runtimeObjects.includes(name);

  const keywordEntries = SOQL_KEYWORDS.map((k) => ({
    label: k,
    kind: "keyword",
    detail: "SOQL 关键字",
    insert: k
  }));
  const functionEntries = SOQL_FUNCTIONS.map((f) => ({
    label: f.name,
    kind: "function",
    detail: `函数 · ${f.detail}`,
    insert: f.name.endsWith("()") ? f.name : `${f.name}()`,
    caretInside: f.name.endsWith("()")
  }));

  // ---- `Account.` 或 `别名.`：只给字段 ----
  if (ctx.qualifier) {
    const target = effectiveObject(ctx);
    const known =
      allObjects.some((o) => o.toLowerCase() === String(target).toLowerCase()) ||
      (ctx.alias && ctx.alias.toLowerCase() === ctx.qualifier.toLowerCase());
    if (!known) return []; // SOQL 里没有"局部变量成员"这回事，不硬凑
    const fields = (extra.objectFields && target && extra.objectFields[target]) ||
      (target && STANDARD_OBJECTS[target]) || [];
    return fields.map((name) => ({
      label: name,
      kind: "field",
      detail: `${target} 字段`,
      insert: name
    }));
  }

  // ---- `FROM ` 之后：只给对象名 ----
  if (ctx.clause === "FROM") {
    return allObjects.map((name) => sobjectEntry(name, isRuntime(name)));
  }

  // ---- 其它子句：字段 + 关键字（+ 按子句追加专用候选） ----
  const target = effectiveObject(ctx);
  const fields =
    (extra.objectFields && target && extra.objectFields[target]) ||
    (target && STANDARD_OBJECTS[target]) ||
    [];

  const fieldEntries = fields.map((name) => ({
    label: name,
    kind: "field",
    detail: `${target} 字段`,
    insert: name
  }));

  const pool = [...fieldEntries];

  if (ctx.clause === "SELECT" || ctx.clause === "NONE") {
    // 还没写 FROM，或者正在 SELECT 里挑字段 → 给字段 + 聚合函数
    pool.push(...functionEntries);
  }
  if (ctx.clause === "WHERE" || ctx.clause === "HAVING") {
    pool.push(
      ...SOQL_DATE_LITERALS.map((d) => ({
        label: d,
        kind: "keyword",
        detail: "SOQL 日期字面量",
        insert: d
      }))
    );
  }
  pool.push(...keywordEntries);

  // FROM 也该能补（写完字段要接着写 FROM）
  if (ctx.clause === "SELECT") {
    pool.push({ label: "FROM", kind: "keyword", detail: "下一个子句", insert: "FROM " });
  }

  return pool;
}

/** 一步到位：解析 → 组装 → 排序（UI 层只调这个） */
export function soqlCompletionsFor(text, caret, extra = {}) {
  const ctx = parseSoqlContext(text, caret);
  if (ctx.blocked) return { ctx, items: [] };
  return { ctx, items: rankBase(collectSoqlCompletions(ctx, extra), ctx.token) };
}

export { applyCompletion };
