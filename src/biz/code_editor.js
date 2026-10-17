/**
 * 代码编辑器（CodeMirror 6）—— 三处复用同一套挂载逻辑：
 *
 *   · SOQL 查询框（section-23，`#soql-query-input`）：可编辑 + SOQL 高亮 + org 补全
 *   · Execute Anonymous（section-18，`#apex-code-input`）：可编辑 + Apex 高亮 + Apex 补全
 *   · View Log 的原始日志（section-31，`#view-log-raw-text`）：**只读**查看器
 *
 * 三个设计前提（改动前先读）：
 *
 * 1. **原控件一律保留、只是隐藏**。textarea 继续当"值的中枢"（每次 docChanged 同步回
 *    `.value`），日志那个 div 也留着（它是 `view_log.js` 的写入目标）。这样执行查询、
 *    导出、历史面板、日志复制/下载这些既有代码一行都不用改。
 * 2. **库加载失败就静默退化**：textarea 还是 textarea，日志还是那段等宽文本 ——
 *    编辑器只是体验升级，不能变成硬依赖。
 * 3. **外观令牌化**：字体走 `--font-mono`，语法色走 `:root` 的 `--code-*`
 *    （check-ui 的「非令牌字体 / 硬编码色」两道守卫都盯着这条）。
 */

import { createLogger } from "../common/logger.js";
import { ensureCodeMirror } from "../common/lib_loader.js";
import { soqlCompletionsFor, effectiveObject } from "../common/soql_completions.js";
import { completionsFor as apexCompletionsFor } from "../common/apex_completions.js";
import { STANDARD_OBJECTS } from "../common/apex_symbols.js";
import { sfConn } from "./sf_service.js";
import { appState } from "./state.js";

const log = createLogger("CODEED");

const SOQL_HOST = "soql-editor-host";
const SOQL_TEXTAREA = "soql-query-input";
const APEX_HOST = "apex-editor-host";
const APEX_TEXTAREA = "apex-code-input";
const LOG_HOST = "view-log-raw-editor";
const LOG_SOURCE = "view-log-raw-text";

/** 已挂载的编辑器（key → { view, cm }） */
const mounted = new Map();

/* ------------------------------------------------------------------ *
 * 语言
 * ------------------------------------------------------------------ */

const SOQL_KEYWORDS =
  "select from where and or not in like includes excludes order by group having limit offset " +
  "asc desc nulls first last typeof rollup cube for view reference update tracking all rows " +
  "with security_enforced data category above below at or above at or below distinct " +
  "using scope count count_distinct sum avg min max calendar_month calendar_year " +
  "calendar_quarter day_only day_in_month day_in_week day_in_year hour_in_day week_in_month " +
  "week_in_year fiscal_month fiscal_quarter fiscal_year convertcurrency tolabel format " +
  "last_n_days last_n_weeks last_n_months last_n_years next_n_days today yesterday " +
  "tomorrow this_week this_month this_quarter this_year last_week last_month last_quarter " +
  "last_year next_week next_month next_quarter next_year";

const SOQL_FUNCTIONS =
  "count count_distinct sum avg min max calendar_month calendar_year calendar_quarter " +
  "day_only day_in_month day_in_week day_in_year hour_in_day week_in_month week_in_year " +
  "fiscal_month fiscal_quarter fiscal_year convertcurrency tolabel format";

function soqlLanguage(cm) {
  return cm.sql({
    dialect: cm.SQLDialect.define({
      keywords: SOQL_KEYWORDS,
      builtin: SOQL_FUNCTIONS,
      types: "",
      identifierQuotes: "'",
      caseInsensitive: true
    }),
    upperCaseKeywords: true
  });
}

/* --- Apex：StreamLanguage + 手写 tokenizer ---------------------------------
   CodeMirror 6 没有官方 Apex 语言包（`@codemirror/legacy-modes` 里也只有 java/clike），
   而 Apex 语法和 Java 高度相似但关键字不同（trigger / SOQL 里的 [SELECT] 等）。
   这段 tokenizer 只做"读得懂的着色"：关键字、类型、字符串、数字、注释、注解、括号。
   不追求语义准确（不做语法树），但足够让 Execute Anonymous 的输入框看起来像 IDE。 */

const APEX_KEYWORDS = new Set(
  ("abstract break catch class continue delete do else enum extends final finally for if implements " +
    "insert instanceof interface new override private protected public return static super switch testmethod " +
    "this throw transient trigger try undelete update virtual void while global webservice future with sharing " +
    "without inherited after before select from where limit order by group nulls and or not in like " +
    "insert upsert merge desc asc").split(" ")
);

const APEX_TYPES = new Set(
  ("String Integer Long Double Decimal Boolean Date Datetime Time Blob Id Object SObject List Set Map " +
    "Exception Database Schema System Math JSON Http Request Response Trigger").split(" ")
);

const APEX_CONSTANTS = new Set(["true", "false", "null"]);

function apexLanguage(cm) {
  return cm.StreamLanguage.define({
    name: "apex",
    startState: () => ({ block: false }),
    token(stream, state) {
      if (state.block) {
        if (stream.skipTo("*/")) {
          stream.match("*/");
          state.block = false;
        } else {
          stream.skipToEnd();
        }
        return "comment";
      }
      if (stream.eatSpace()) return null;

      if (stream.match("//")) {
        stream.skipToEnd();
        return "comment";
      }
      if (stream.match("/*")) {
        state.block = true;
        if (stream.skipTo("*/")) {
          stream.match("*/");
          state.block = false;
        } else {
          stream.skipToEnd();
        }
        return "comment";
      }
      if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return "string";
      if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
      if (stream.match(/^@[A-Za-z_]\w*/)) return "meta";
      if (stream.match(/^\d+(?:\.\d+)?[LlDd]?/)) return "number";
      if (stream.match(/^[A-Za-z_]\w*/)) {
        const word = stream.current();
        const lower = word.toLowerCase();
        if (APEX_CONSTANTS.has(lower)) return "atom";
        if (APEX_KEYWORDS.has(lower)) return "keyword";
        if (APEX_TYPES.has(word)) return "typeName";
        return "variableName";
      }
      if (stream.match(/^[{}[\]();,.?:]/)) return "punctuation";
      if (stream.match(/^[+\-*/%=<>!&|^~]+/)) return "operator";
      stream.next();
      return null;
    }
  });
}

/* ------------------------------------------------------------------ *
 * 主题 / 高亮
 * ------------------------------------------------------------------ */

function buildTheme(cm, { minHeight, maxHeight }) {
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
        minHeight,
        maxHeight,
        overflow: "auto"
      },
      ".cm-content": { padding: "10px 0" },
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
      ".cm-tooltip-autocomplete > ul": { fontFamily: "var(--font-sans)", fontSize: "var(--fs-sm)" },
      ".cm-tooltip-autocomplete > ul > li": { padding: "4px 10px" },
      ".cm-tooltip-autocomplete > ul > li[aria-selected]": {
        backgroundColor: "var(--primary-bg)",
        color: "var(--text-primary)"
      },
      ".cm-completionDetail": { color: "var(--text-secondary)", fontStyle: "normal" },
      ".cm-placeholder": { color: "var(--text-light)" },
      ".cm-panels": { backgroundColor: "var(--bg-tertiary)" },
      // 只读查看器：不要光标与当前行高亮，视觉上像"文档"而不是"输入框"
      "&.cm-readonly .cm-cursor, &.cm-readonly .cm-activeLine, &.cm-readonly .cm-activeLineGutter": {
        display: "none"
      }
    },
    { dark: false }
  );
}

function buildHighlight(cm) {
  const t = cm.tags;
  return cm.HighlightStyle.define([
    { tag: t.keyword, color: "var(--code-keyword)", fontWeight: "600" },
    { tag: [t.string, t.special(t.string)], color: "var(--code-string)" },
    { tag: [t.number, t.atom, t.bool, t.null], color: "var(--code-number)" },
    { tag: [t.lineComment, t.blockComment], color: "var(--code-comment)", fontStyle: "italic" },
    { tag: [t.operator, t.punctuation, t.bracket], color: "var(--text-secondary)" },
    { tag: [t.typeName, t.className], color: "var(--code-type)" },
    { tag: t.meta, color: "var(--code-func)", fontStyle: "italic" },
    { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "var(--code-func)" },
    { tag: t.variableName, color: "var(--text-primary)" },
    { tag: t.invalid, color: "var(--error-color)" }
  ]);
}

/* ------------------------------------------------------------------ *
 * 补全：SOQL（org 对象/字段）与 Apex（common/apex_completions.js）
 * ------------------------------------------------------------------ */

const KIND_TO_CM = {
  sObject: "type",
  field: "property",
  keyword: "keyword",
  function: "function",
  literal: "constant",
  type: "type",
  method: "method",
  member: "property",
  variable: "variable"
};

const soqlSchema = { objects: [], objectsLoaded: false, fields: new Map() };

function resolveSoqlTarget(ctx) {
  const name = effectiveObject(ctx);
  if (!name) return null;
  const lower = String(name).toLowerCase();
  return (
    soqlSchema.objects.find((n) => n.toLowerCase() === lower) ||
    Object.keys(STANDARD_OBJECTS).find((n) => n.toLowerCase() === lower) ||
    (ctx && ctx.alias && String(ctx.alias).toLowerCase() === lower ? ctx.objectName : null)
  );
}

async function enrichSoql(ctx) {
  if (!appState.is_connected) return false;
  let changed = false;

  if (!soqlSchema.objectsLoaded) {
    soqlSchema.objectsLoaded = true;
    try {
      const { names } = await sfConn.listSObjectNames();
      if (names && names.length) {
        soqlSchema.objects = names;
        changed = true;
      }
    } catch (e) {
      soqlSchema.objectsLoaded = false;
      log.debug("拉取对象名失败（不影响本地候选）:", e);
    }
  }

  const target = resolveSoqlTarget(ctx);
  if (target && !soqlSchema.fields.has(target)) {
    try {
      const fields = await sfConn.listObjectFields(target);
      if (fields && fields.length) {
        soqlSchema.fields.set(target, fields);
        changed = true;
      }
    } catch (e) {
      log.debug(`拉取 ${target} 字段失败:`, e);
    }
  }
  return changed;
}

/** 把 common 里的补全结果转成 CodeMirror 的 CompletionResult */
function toCompletionResult(ctx, items) {
  if (ctx.blocked || !items.length) return null;
  return {
    from: ctx.replaceFrom,
    to: ctx.replaceTo,
    options: items.map((it) => ({
      label: it.insert || it.label,
      detail: it.detail || "",
      type: KIND_TO_CM[it.kind] || "text",
      apply: it.insert || it.label
    })),
    // 同一个"词"内继续输入时复用这批候选，避免每个字符都重算
    validFor: /^[\w.$]*$/
  };
}

function soqlCompletionSource(cm) {
  return (context) => {
    const text = context.state.doc.toString();
    const { ctx, items } = soqlCompletionsFor(text, context.pos, {
      sObjects: soqlSchema.objects,
      objectFields: Object.fromEntries(soqlSchema.fields)
    });
    const result = toCompletionResult(ctx, items);
    if (!result) return null;

    enrichSoql(ctx)
      .then((changed) => {
        const live = mounted.get("soql");
        if (changed && live && cm.completionStatus(live.view.state) === "pending") {
          cm.startCompletion(live.view);
        }
      })
      .catch(() => {});
    return result;
  };
}

function apexCompletionSource(cm) {
  return (context) => {
    const text = context.state.doc.toString();
    const { ctx, items } = apexCompletionsFor(text, context.pos, {
      sObjects: soqlSchema.objects,
      objectFields: Object.fromEntries(soqlSchema.fields)
    });
    const result = toCompletionResult(ctx, items);
    // Apex 的候选里对象名 / 字段同样来自 org —— 复用 SOQL 那份缓存
    if (result && ctx && ctx.objectName) {
      enrichSoql({ objectName: ctx.objectName, alias: ctx.alias }).catch(() => {});
    }
    return result;
  };
}

/* ------------------------------------------------------------------ *
 * 挂载
 * ------------------------------------------------------------------ */

/**
 * @param {object} cm   CodeMirror 模块（ensureCodeMirror() 的返回值）
 * @param {object} opts
 *   hostId / textareaId、language（cm 扩展数组）、completions（source 数组）、
 *   readOnly、minHeight/maxHeight、placeholder、key（mounted 的键）
 */
function mountEditor(cm, opts) {
  const { hostId, textareaId, key, language = [], completions = [], readOnly = false, minHeight, maxHeight, placeholder } = opts;
  const host = document.getElementById(hostId);
  if (!host) return null;
  const textarea = textareaId ? document.getElementById(textareaId) : null;

  const extensions = [
    cm.EditorView.lineWrapping, // 侧边栏只有 ~400px：不折行就得横向拖
    cm.lineNumbers(),
    cm.highlightSpecialChars(),
    cm.history(),
    cm.drawSelection(),
    cm.dropCursor(),
    cm.bracketMatching(),
    cm.searchKeymap ? cm.keymap.of([...cm.searchKeymap, ...cm.defaultKeymap]) : cm.keymap.of([])
  ];

  if (readOnly) {
    extensions.push(cm.EditorState.readOnly.of(true), cm.EditorView.editable.of(false));
  } else {
    extensions.push(
      cm.highlightActiveLineGutter(),
      cm.highlightActiveLine(),
      cm.indentOnInput(),
      cm.highlightSelectionMatches(),
      cm.autocompletion({
        override: completions,
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
      ])
    );
  }

  if (placeholder) extensions.push(cm.placeholder(placeholder));
  if (language.length) extensions.push(language);
  extensions.push(cm.syntaxHighlighting(buildHighlight(cm)), buildTheme(cm, { minHeight, maxHeight }));

  // 编辑 → 同步回原 textarea（历史面板 / 执行按钮读的仍是 .value）
  if (textarea && !readOnly) {
    extensions.push(
      cm.EditorView.updateListener.of((update) => {
        if (update.docChanged) textarea.value = update.state.doc.toString();
      })
    );
  }

  const view = new cm.EditorView({
    doc: textarea ? textarea.value || "" : "",
    parent: host,
    extensions
  });
  if (readOnly) host.classList.add("cm-readonly");

  if (textarea) {
    textarea.classList.add("u-hidden");
    textarea.setAttribute("aria-hidden", "true");
    textarea.setAttribute("tabindex", "-1");
  }

  const handle = { view, cm };
  mounted.set(key, handle);
  return handle;
}

/** 初始化 SOQL 与 Execute Anonymous 两个输入框（app.js 启动时调一次；幂等） */
export async function initCodeEditors() {
  if (mounted.has("soql") && mounted.has("apex")) return mounted;
  let cm;
  try {
    cm = await ensureCodeMirror();
  } catch (e) {
    log.warn("CodeMirror 加载失败，输入框退回 textarea:", e);
    return null;
  }

  mountEditor(cm, {
    key: "soql",
    hostId: SOQL_HOST,
    textareaId: SOQL_TEXTAREA,
    language: [soqlLanguage(cm)],
    completions: [soqlCompletionSource(cm)],
    minHeight: "180px",
    maxHeight: "380px",
    placeholder: "SELECT Id, Name FROM Account LIMIT 100"
  });

  mountEditor(cm, {
    key: "apex",
    hostId: APEX_HOST,
    textareaId: APEX_TEXTAREA,
    language: [apexLanguage(cm)],
    completions: [apexCompletionSource(cm)],
    minHeight: "280px",
    maxHeight: "560px",
    placeholder: "// 输入您的 Apex 代码\nSystem.debug('Hello');"
  });

  log.debug("代码编辑器已就绪（SOQL / Apex）");
  return mounted;
}

/** View Log 的原始日志：只读查看器（懒加载，进到该页且真有日志时才挂） */
export async function setLogViewerText(text) {
  const content = String(text == null ? "" : text);
  let cm;
  try {
    cm = await ensureCodeMirror();
  } catch (e) {
    log.warn("CodeMirror 加载失败，原始日志退回纯文本:", e);
    return false;
  }

  let handle = mounted.get("log");
  if (!handle) {
    handle = mountEditor(cm, {
      key: "log",
      hostId: LOG_HOST,
      readOnly: true,
      minHeight: "320px",
      maxHeight: "520px"
    });
    if (!handle) return false;
    // 只读查看器不抢焦点，但允许键盘滚动 / 选中 / Ctrl+F
    handle.view.dom.classList.add("cm-readonly");
  }

  const doc = handle.view.state.doc;
  handle.view.dispatch({
    changes: { from: 0, to: doc.length, insert: content },
    selection: { anchor: 0 },
    scrollIntoView: false
  });
  return true;
}

/* ------------------------------------------------------------------ *
 * 值读写（供 app.js / 历史面板使用）
 * ------------------------------------------------------------------ */

function readValue(key, textareaId) {
  const handle = mounted.get(key);
  if (handle) return handle.view.state.doc.toString();
  const ta = document.getElementById(textareaId);
  return ta ? ta.value : "";
}

function writeValue(key, textareaId, text) {
  const handle = mounted.get(key);
  const value = String(text == null ? "" : text);
  if (!handle) {
    const ta = document.getElementById(textareaId);
    if (ta) ta.value = value;
    return;
  }
  handle.view.dispatch({
    changes: { from: 0, to: handle.view.state.doc.length, insert: value },
    selection: { anchor: value.length }
  });
  handle.view.focus();
}

export const getSoqlText = () => readValue("soql", SOQL_TEXTAREA);
export const setSoqlText = (text) => writeValue("soql", SOQL_TEXTAREA, text);
export const getApexText = () => readValue("apex", APEX_TEXTAREA);
export const setApexText = (text) => writeValue("apex", APEX_TEXTAREA, text);
export const isEditorActive = (key) => mounted.has(key);
