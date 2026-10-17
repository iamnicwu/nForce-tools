/**
 * SOQL 查询框的编辑器（CodeMirror 6）—— 让写 SOQL 的手感接近 VS Code。
 *
 * 为什么换掉 textarea：
 *   textarea 只有"白板一块"——没有行号、没有语法着色、括号不配对也看不出来。
 *   CodeMirror 6 是纯 ESM、不依赖 worker，打进扩展只有一个 0.4MB 的单文件
 *   （`lib/js/codemirror.bundle.js`，见 `tools/build-codemirror.mjs`），
 *   且能在 MV3 的 `script-src 'self'` 下正常工作（Monaco 要 worker + 1~5MB，不合适）。
 *
 * 与既有代码的关系：
 *   · `#soql-query-input` 这个 textarea **保留在 DOM 里**（隐藏），编辑器每次变更都同步回去 ——
 *     于是 inspector_tools / 历史面板那些 `input.value` 的老代码一行都不用改；
 *   · 补全候选仍然来自 `common/soql_completions.js`（和 Apex 提示共用同一套纯逻辑），
 *     只是渲染容器从自绘浮层换成 CodeMirror 的 autocomplete；
 *   · 库加载失败时**什么也不做**：textarea 原样可用（扩展在离线/被裁剪的包里也不会残废）。
 */

import { createLogger } from "../common/logger.js";
import { ensureCodeMirror } from "../common/lib_loader.js";
import {
  soqlCompletionsFor,
  effectiveObject
} from "../common/soql_completions.js";
import { STANDARD_OBJECTS } from "../common/apex_symbols.js";
import { sfConn } from "./sf_service.js";
import { appState } from "./state.js";

const log = createLogger("SOQLEDIT");

const HOST_ID = "soql-editor-host";
const TEXTAREA_ID = "soql-query-input";

/** org 数据镜像（补全同步读它，enrich 负责填；与 soql_complete 各自缓存，命中 sf_service 的会话级缓存） */
const schema = { objects: [], objectsLoaded: false, fields: new Map() };

/** 挂载后的运行时句柄（未挂载 = null） */
let editor = null;

/* ------------------------------------------------------------------ *
 * SOQL 方言：lang-sql 认的是标准 SQL 关键字，这里换成 SOQL 那一套
 * ------------------------------------------------------------------ */

const SOQL_KEYWORDS =
  "select from where and or not in like includes excludes order by group having limit offset " +
  "asc desc nulls first last typeof rollup cube for view reference update tracking all rows " +
  "with security_enforced data category above below at or above at or below distinct " +
  "using scope count count_distinct sum avg min max calendar_month calendar_year " +
  "calendar_quarter day_only day_in_month day_in_week day_in_year hour_in_day week_in_month " +
  "week_in_year fiscal_month fiscal_quarter fiscal_year convertcurrency tolabel format " +
  "tolabel last_n_days last_n_weeks last_n_months last_n_years next_n_days today yesterday " +
  "tomorrow this_week this_month this_quarter this_year last_week last_month last_quarter " +
  "last_year next_week next_month next_quarter next_year";

const SOQL_FUNCTIONS =
  "count count_distinct sum avg min max calendar_month calendar_year calendar_quarter " +
  "day_only day_in_month day_in_week day_in_year hour_in_day week_in_month week_in_year " +
  "fiscal_month fiscal_quarter fiscal_year convertcurrency tolabel format";

const soqlDialect = (cm) =>
  cm.SQLDialect.define({
    keywords: SOQL_KEYWORDS,
    builtin: SOQL_FUNCTIONS,
    // SOQL 没有 DDL/事务，types 留空即可（字段类型由 org 提供，不走语法层）
    types: "",
    identifierQuotes: "'",
    caseInsensitive: true
  });

/* ------------------------------------------------------------------ *
 * 外观：浅色 VSCode 风格（配色全部走 main.css 的 --code-* 令牌）
 * ------------------------------------------------------------------ */

function buildTheme(cm) {
  return cm.EditorView.theme(
    {
      "&": {
        fontFamily: "var(--font-mono)",
        fontSize: "var(--fs-sm)",
        color: "var(--text-primary)",
        backgroundColor: "var(--bg-primary)",
        border: "1px solid var(--border-color)",
        borderRadius: "10px",
        overflow: "hidden"
      },
      "&.cm-focused": {
        outline: "none",
        borderColor: "var(--primary-color)",
        boxShadow: "0 0 0 3px var(--primary-bg)"
      },
      ".cm-scroller": {
        fontFamily: "inherit",
        lineHeight: "var(--lh-normal)",
        minHeight: "132px",
        maxHeight: "320px",
        overflow: "auto"
      },
      ".cm-content": { padding: "8px 0" },
      ".cm-line": { padding: "0 12px" },
      ".cm-gutters": {
        backgroundColor: "var(--bg-tertiary)",
        color: "var(--text-light)",
        border: "none",
        borderRight: "1px solid var(--border-light)",
        paddingLeft: "4px"
      },
      ".cm-activeLine": { backgroundColor: "var(--bg-secondary)" },
      ".cm-activeLineGutter": {
        backgroundColor: "var(--bg-secondary)",
        color: "var(--text-secondary)"
      },
      ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection": {
        backgroundColor: "var(--primary-bg)"
      },
      ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text-primary)" },
      ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
        backgroundColor: "var(--primary-bg)",
        outline: "1px solid var(--primary-color)"
      },
      ".cm-tooltip": {
        border: "1px solid var(--border-color)",
        borderRadius: "8px",
        boxShadow: "var(--shadow-md)",
        backgroundColor: "var(--bg-primary)",
        overflow: "hidden"
      },
      ".cm-tooltip-autocomplete > ul": {
        fontFamily: "var(--font-sans)",
        fontSize: "var(--fs-sm)"
      },
      ".cm-tooltip-autocomplete > ul > li": { padding: "4px 10px" },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--primary-bg)",
        color: "var(--text-primary)"
      },
      ".cm-completionDetail": { color: "var(--text-secondary)", fontStyle: "normal" },
      ".cm-placeholder": { color: "var(--text-light)" },
      ".cm-panels": { backgroundColor: "var(--bg-tertiary)" }
    },
    { dark: false }
  );
}

function buildHighlight(cm) {
  const t = cm.tags;
  return cm.HighlightStyle.define([
    { tag: t.keyword, color: "var(--code-keyword)", fontWeight: "600" },
    { tag: [t.string, t.special(t.string)], color: "var(--code-string)" },
    { tag: t.number, color: "var(--code-number)" },
    { tag: [t.lineComment, t.blockComment], color: "var(--code-comment)", fontStyle: "italic" },
    { tag: [t.operator, t.punctuation, t.bracket], color: "var(--text-secondary)" },
    { tag: [t.typeName, t.className], color: "var(--code-type)" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--code-func)" },
    { tag: t.variableName, color: "var(--text-primary)" },
    { tag: t.invalid, color: "var(--error-color)" }
  ]);
}

/* ------------------------------------------------------------------ *
 * 补全：候选来自 common/soql_completions.js，数据按需从 org 补
 * ------------------------------------------------------------------ */

const KIND_TO_CM = {
  sObject: "type",
  field: "property",
  keyword: "keyword",
  function: "function",
  literal: "constant"
};

/** 归一成真实对象名（`FROM Account a` 里的别名要映射回 Account） */
function resolveTarget(ctx) {
  const name = effectiveObject(ctx);
  if (!name) return null;
  const lower = String(name).toLowerCase();
  return (
    schema.objects.find((n) => n.toLowerCase() === lower) ||
    Object.keys(STANDARD_OBJECTS).find((n) => n.toLowerCase() === lower) ||
    (ctx && ctx.alias && String(ctx.alias).toLowerCase() === lower ? ctx.objectName : null)
  );
}

/** 按需把 org 的对象名 / 字段补进 schema（失败不影响已有候选） */
async function enrich(ctx) {
  if (!appState.is_connected) return false;
  let changed = false;

  if (!schema.objectsLoaded) {
    schema.objectsLoaded = true;
    try {
      const { names } = await sfConn.listSObjectNames();
      if (names && names.length) {
        schema.objects = names;
        changed = true;
      }
    } catch (e) {
      schema.objectsLoaded = false; // 允许下次重试
      log.debug("拉取对象名失败（不影响本地候选）:", e);
    }
  }

  const target = resolveTarget(ctx);
  if (target && !schema.fields.has(target)) {
    try {
      const fields = await sfConn.listObjectFields(target);
      if (fields && fields.length) {
        schema.fields.set(target, fields);
        changed = true;
      }
    } catch (e) {
      log.debug(`拉取 ${target} 字段失败:`, e);
    }
  }
  return changed;
}

function completionSource(cm) {
  return (context) => {
    const text = context.state.doc.toString();
    const pos = context.pos;
    const { ctx, items } = soqlCompletionsFor(text, pos, {
      sObjects: schema.objects,
      objectFields: Object.fromEntries(schema.fields)
    });
    if (ctx.blocked || !items.length) return null;

    // 后台补数据：这次先给本地候选，下一次输入时候选就变全了
    enrich(ctx)
      .then((changed) => {
        if (changed && editor && cm.completionStatus(editor.view.state) === "pending") {
          cm.startCompletion(editor.view);
        }
      })
      .catch(() => {});

    return {
      from: ctx.replaceFrom,
      to: ctx.replaceTo,
      options: items.map((it) => ({
        label: it.insert || it.label,
        detail: it.detail || "",
        type: KIND_TO_CM[it.kind] || "text",
        apply: it.insert || it.label
      })),
      // 同一个"词"内继续输入时复用这批候选，避免每个字符都重算一遍
      validFor: /^[\w.$]*$/
    };
  };
}

/* ------------------------------------------------------------------ *
 * 挂载
 * ------------------------------------------------------------------ */

/** 把 textarea 的值同步进编辑器（历史面板点「载入」时用） */
export function setSoqlText(text) {
  if (!editor) {
    const ta = document.getElementById(TEXTAREA_ID);
    if (ta) ta.value = text;
    return;
  }
  editor.view.dispatch({
    changes: { from: 0, to: editor.view.state.doc.length, insert: text },
    selection: { anchor: text.length }
  });
  editor.view.focus();
}

/** 当前查询语句（编辑器优先，退回 textarea） */
export function getSoqlText() {
  if (editor) return editor.view.state.doc.toString();
  const ta = document.getElementById(TEXTAREA_ID);
  return ta ? ta.value : "";
}

export function isSoqlEditorActive() {
  return !!editor;
}

/**
 * 初始化（app.js 启动时调一次；幂等）。
 * 库加载失败时静默退回原生 textarea —— 编辑器是"体验升级"，不该成为硬依赖。
 */
export async function initSoqlEditor() {
  if (editor) return editor;
  const host = document.getElementById(HOST_ID);
  const textarea = document.getElementById(TEXTAREA_ID);
  if (!host || !textarea) return null;

  let cm;
  try {
    cm = await ensureCodeMirror();
  } catch (e) {
    log.warn("CodeMirror 加载失败，SOQL 框退回原生 textarea:", e);
    return null;
  }

  const initial = textarea.value || "";
  const view = new cm.EditorView({
    doc: initial,
    parent: host,
    extensions: [
      // 侧边栏只有 ~400px：长 SOQL 不折行就会横向滚动，行号与开头全看不见
      cm.EditorView.lineWrapping,
      cm.lineNumbers(),
      cm.highlightActiveLineGutter(),
      cm.highlightActiveLine(),
      cm.highlightSpecialChars(),
      cm.history(),
      cm.drawSelection(),
      cm.dropCursor(),
      cm.indentOnInput(),
      cm.bracketMatching(),
      cm.highlightSelectionMatches(),
      cm.autocompletion({
        override: [completionSource(cm)],
        activateOnTyping: true,
        defaultKeymap: true,
        icons: true
      }),
      cm.keymap.of([
        ...cm.completionKeymap,
        ...cm.searchKeymap,
        ...cm.historyKeymap,
        ...cm.foldKeymap,
        ...cm.defaultKeymap,
        cm.indentWithTab
      ]),
      cm.sql({ dialect: soqlDialect(cm), upperCaseKeywords: true }),
      cm.syntaxHighlighting(buildHighlight(cm)),
      buildTheme(cm),
      cm.placeholder("SELECT Id, Name FROM Account LIMIT 100"),
      // 每次改动同步回隐藏的 textarea：历史面板 / 执行按钮等老代码读的仍是 .value
      cm.EditorView.updateListener.of((update) => {
        if (update.docChanged) textarea.value = update.state.doc.toString();
      })
    ]
  });

  // 隐藏原生输入框（保留在 DOM 里，值始终与编辑器一致）
  textarea.classList.add("u-hidden");
  textarea.setAttribute("aria-hidden", "true");
  textarea.setAttribute("tabindex", "-1");

  editor = { view, cm };
  log.debug("SOQL 编辑器已就绪（CodeMirror）");
  return editor;
}
