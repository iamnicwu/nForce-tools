/**
 * Apex 代码提示的**纯逻辑**：从「文本 + 光标位置」算出该提示什么。
 *
 * 这里不做任何 DOM 与网络的事（那些在 `biz/apex_complete.js`），只有三件事：
 *   ① `parseContext()` —— 光标处正在输入什么？（前缀、`. 前面的接收者`、是不是在字符串/注释里）
 *   ② `collectCompletions()` —— 根据上下文组装候选（关键字 / 内置类 / 成员 / sObject / 字段）
 *   ③ `rankCompletions()` —— 过滤 + 排序（前缀匹配优先、短名优先、按类型分档）
 *
 * 单独一层是为了**能测**：补全这种东西"看着能弹出来"和"弹得对不对"是两件事，
 * 而后者只有把上下文解析与排序规则钉在单测里才守得住（渲染验证只能证明浮层出现过）。
 */

import {
  APEX_KEYWORDS,
  APEX_PRIMITIVES,
  APEX_COLLECTIONS,
  BUILTIN_CLASSES,
  BUILTIN_INTERFACES,
  STANDARD_OBJECTS,
  SNIPPETS,
  LOGGING_LEVELS
} from "./apex_symbols.js";

/** 各类候选的排序权重（数字小的排前面） */
const KIND_WEIGHT = {
  class: 0,
  sObject: 1,
  keyword: 2,
  primitive: 3,
  snippet: 4,
  // SOQL 的聚合函数（COUNT/SUM…）与片段同级：都是"点一下就好"的整块插入
  function: 4,
  member: 5,
  field: 6,
  interface: 7
};

/** 标识符里允许的字符（Apex 标识符 + `$`） */
const IDENT_CHAR = /[A-Za-z0-9_$]/;

/**
 * 判断光标是否落在字符串字面量或注释里 —— 那种位置不该弹提示。
 *
 * 用一次从文本开头到光标的扫描（不是只看当前行）：`/* … *​/` 跨行、以及
 * 字符串里的 `//` 都会让"只看本行"的简化版判断出错。
 *
 * @param {string} text 光标之前的全部文本
 * @returns {{ inString: boolean, inComment: boolean }}
 */
export function scanState(text) {
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;
  let quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLineComment) {
      if (ch === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      if (ch === "\\") {
        i += 1; // 跳过转义字符
        continue;
      }
      if (ch === quote) inString = false;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = true;
      quote = ch;
    }
  }
  return { inString, inComment: inLineComment || inBlockComment };
}

/**
 * 解析光标处的补全上下文。
 *
 * @param {string} text 输入框全文
 * @param {number} caret 光标位置（`textarea.selectionStart`）
 * @returns {{
 *   token: string,          // 正在输入的标识符前缀（可能为空串，如 `Account.` 之后）
 *   receiver: string|null,  // `.` 前面的接收者（`System.debug` → "System"）
 *   replaceFrom: number,    // 接受候选时要替换的起点
 *   replaceTo: number,      // 接受候选时要替换的终点（= caret）
 *   blocked: boolean,       // 在字符串/注释里 —— 不提示
 *   line: string            // 光标所在行（到光标为止），给上下文判断用
 * }}
 */
export function parseContext(text, caret) {
  const src = typeof text === "string" ? text : "";
  const pos = Math.max(0, Math.min(Number(caret) || 0, src.length));
  const before = src.slice(0, pos);
  const { inString, inComment } = scanState(before);
  const lineStart = before.lastIndexOf("\n") + 1;
  const line = before.slice(lineStart);

  // 正在输入的标识符
  let start = pos;
  while (start > 0 && IDENT_CHAR.test(src[start - 1])) start -= 1;
  const token = src.slice(start, pos);

  // `. 前面的接收者`：点号紧邻 token 起点，再往前取一个标识符（支持 a.b.c 里的最后一个）
  let receiver = null;
  if (start > 0 && src[start - 1] === ".") {
    let rEnd = start - 1;
    let rStart = rEnd;
    while (rStart > 0 && IDENT_CHAR.test(src[rStart - 1])) rStart -= 1;
    receiver = src.slice(rStart, rEnd) || null;
  }

  return {
    token,
    receiver,
    replaceFrom: start,
    replaceTo: pos,
    blocked: inString || inComment,
    line
  };
}

/** 把 sObject 字段名列表变成候选（`fields` 来自 org 的 describe 或静态兜底） */
function fieldEntries(objectName, fields) {
  return (fields || []).map((name) => ({
    label: name,
    kind: "field",
    detail: `${objectName} 字段`,
    insert: name
  }));
}

/**
 * 组装候选。
 *
 * @param {object} ctx `parseContext()` 的结果
 * @param {{
 *   text?: string,                    // 全文（判断 `.` 前面是不是 SELECT 语句里的对象名等）
 *   sObjects?: string[],              // 运行时从 org 拿到的对象名（会与静态表合并）
 *   objectFields?: Record<string, string[]>, // 已知对象的字段（运行时或静态）
 *   includeSnippets?: boolean
 * }} [extra]
 * @returns {Array<{label:string, kind:string, detail:string, insert:string}>}
 */
export function collectCompletions(ctx, extra = {}) {
  if (!ctx || ctx.blocked) return [];

  const staticObjects = Object.keys(STANDARD_OBJECTS);
  const runtimeObjects = Array.isArray(extra.sObjects) ? extra.sObjects : [];
  const allObjects = [...new Set([...runtimeObjects, ...staticObjects])];
  const fields = { ...STANDARD_OBJECTS, ...(extra.objectFields || {}) };

  // ---- 情况一：`X.` —— 提示 X 的成员 ----
  if (ctx.receiver) {
    const builtin = BUILTIN_CLASSES[ctx.receiver];
    if (builtin) {
      return builtin.members.map((m) => ({
        label: m.name,
        kind: "member",
        detail: m.signature ? `${ctx.receiver}.${m.signature}` : m.detail || ctx.receiver,
        // 方法补 `()` 并把光标放进括号，属性/常量不补
        insert: m.signature && m.signature.includes("(") ? `${m.name}()` : m.name,
        caretInside: !!(m.signature && m.signature.includes("("))
      }));
    }
    // `LoggingLevel.` 这种枚举
    if (/^LoggingLevel$/i.test(ctx.receiver)) {
      return LOGGING_LEVELS.map((l) => ({ label: l, kind: "member", detail: "LoggingLevel", insert: l }));
    }
    const objName = allObjects.find((o) => o.toLowerCase() === ctx.receiver.toLowerCase());
    if (objName) {
      return fieldEntries(objName, fields[objName]);
    }
    return [];
  }

  // ---- 情况二：普通位置 —— 关键字 + 类型 + 类 + sObject（+ 片段） ----
  const out = [];
  for (const kw of APEX_KEYWORDS) {
    out.push({ label: kw, kind: "keyword", detail: "关键字", insert: kw });
  }
  for (const name of [...APEX_PRIMITIVES, ...APEX_COLLECTIONS]) {
    out.push({ label: name, kind: "primitive", detail: "类型", insert: name });
  }
  for (const name of Object.keys(BUILTIN_CLASSES)) {
    out.push({ label: name, kind: "class", detail: BUILTIN_CLASSES[name].detail || "内置类", insert: name });
  }
  for (const name of BUILTIN_INTERFACES) {
    out.push({ label: name, kind: "interface", detail: "接口", insert: name });
  }
  for (const name of allObjects) {
    out.push({
      label: name,
      kind: "sObject",
      detail: runtimeObjects.includes(name) ? "对象（来自当前 org）" : "常用标准对象",
      insert: name
    });
  }
  if (extra.includeSnippets) {
    for (const s of SNIPPETS) out.push(s);
  }

  // ---- 情况三：SOQL 里 `FROM ` 之后 —— 只给对象名（关键字在这里是噪音） ----
  if (/\b(FROM|UPDATE|INSERT|UPSERT|DELETE)\s+[A-Za-z_]*$/i.test(ctx.line)) {
    return allObjects
      .map((name) => ({
        label: name,
        kind: "sObject",
        detail: runtimeObjects.includes(name) ? "对象（来自当前 org）" : "常用标准对象",
        insert: name
      }))
      .concat(
        runtimeObjects
          .filter((n) => !staticObjects.includes(n))
          .map((name) => ({ label: name, kind: "sObject", detail: "对象（来自当前 org）", insert: name }))
      );
  }

  return out;
}

/**
 * 过滤 + 排序。
 *
 * 排序规则（都是"用起来顺不顺"的问题）：
 *   · **前缀匹配优先于包含匹配** —— 打 `acc` 时 `Account` 要在 `Campaign` 前面；
 *   · 再按**类型权重**（类 / sObject / 关键字 … 字段最后）：打 `List` 想找的是那个类，
 *     而不是恰好更短的标准对象；
 *   · 同类型里**短名优先**（`System` 在 `SystemModstamp` 前）。
 * 空前缀（刚打完 `.` 或按 Ctrl+Space）时给全部候选，只做类型与长度排序。
 */
export function rankCompletions(entries, token, limit = 12) {
  const prefix = String(token || "").toLowerCase();
  const scored = [];
  for (const entry of entries) {
    const label = String(entry.label || "");
    if (!label) continue;
    const lower = label.toLowerCase();
    let score;
    if (!prefix) {
      score = 0;
    } else if (lower.startsWith(prefix)) {
      score = 0;
    } else if (lower.includes(prefix)) {
      score = 1;
    } else {
      continue;
    }
    // ⚠️ 顺序有意：**类型权重在长度之前**。反过来的话，一个恰好更短的标准对象
    // （如 `Lead`）会插到内置类前面，而用户打 `Lis` 想要的显然是 `List`。
    scored.push({ entry, rank: [score, KIND_WEIGHT[entry.kind] ?? 9, label.length, lower] });
  }
  scored.sort((a, b) => {
    for (let i = 0; i < a.rank.length; i++) {
      if (a.rank[i] < b.rank[i]) return -1;
      if (a.rank[i] > b.rank[i]) return 1;
    }
    return 0;
  });
  return scored.slice(0, limit).map((s) => s.entry);
}

/** 一步到位：解析上下文 → 组装 → 排序（UI 层只调这个） */
export function completionsFor(text, caret, extra = {}) {
  const ctx = parseContext(text, caret);
  if (ctx.blocked) return { ctx, items: [] };
  const items = rankCompletions(collectCompletions(ctx, extra), ctx.token);
  return { ctx, items };
}

/** 把候选应用回文本（返回新文本与新光标位置） */
export function applyCompletion(text, ctx, entry) {
  const before = text.slice(0, ctx.replaceFrom);
  const after = text.slice(ctx.replaceTo);
  const insert = entry && entry.insert ? entry.insert : entry && entry.label ? entry.label : "";
  // `()`：光标落在括号里面（`System.debug(|)`）
  if (entry && entry.caretInside && insert.endsWith("()")) {
    const nextCaret = before.length + insert.length - 1;
    return { text: before + insert + after, caret: nextCaret };
  }
  return { text: before + insert + after, caret: before.length + insert.length };
}
