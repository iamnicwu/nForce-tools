/**
 * View Log —— 独立的「日志分析」功能页（section-31）
 *
 * ── 它解决什么 ──
 * Execute Anonymous 跑完会带回一份日志，但一份 Apex 日志动辄几千行、全是
 * `09:18:22.6 (7100000)|SOQL_EXECUTE_BEGIN|…` 这种行 —— 人眼扫不出"慢在哪一步、
 * 查了几次 SOQL、哪次查爆了行数、有没有抛异常"。这一页把日志**解析成结构**：
 * 概览数字、最慢的节点（按自身耗时）、可折叠的调用树、SOQL / DML 明细、异常清单。
 *
 * 解析用 `@apexdevtools/apex-log-parser`（BSD-3-Clause，零依赖，171 种事件类型；
 * 就是 Apex Log Analyzer 那个 VS Code 扩展背后的解析器），**按需动态加载** ——
 * 它约 300KB，不该进首屏（见 `common/lib_loader.js` 的 `ensureApexLogParser`）。
 *
 * ── 两个入口 ──
 *   ① Log ID（07L…）：从 org 取正文再分析 —— 需要连接；Execute Anonymous 结果里
 *      那个 Log ID 点一下就落到这里并自动分析（见 `app.js` 的 `applyGotoPayload`）。
 *   ② 粘贴日志正文：纯本地解析，**不需要连接**（所以这个 section 没进连接门禁）。
 */

import { createLogger } from "../common/logger.js";

const log = createLogger("VIEWLOG");
import { sfConn } from "./sf_service.js";
import { showNotification, copyText } from "../common/utils.js";
import { $ } from "../common/dom.js";
import { setLogViewerText } from "./code_editor.js";
import { renderTable } from "../common/table_utils.js";
import { ensureApexLogParser } from "../common/lib_loader.js";
import * as view from "../common/apex_log_view.js";

/** 本页的 section 编号（`app.js` 的跳转载荷与 `index.html` 的 #section-31 必须一致） */
export const VIEW_LOG_STEP = 31;

/** 当前这份日志（复制 / 下载用；`text` 是**完整**正文，不是界面上截断的那份） */
let currentLog = { id: "", text: "", bytes: 0 };

/** 状态行：loading / error / 空 */
function setStatus(text, kind = "info") {
    const el = $("view-log-status");
    if (!el) return;
    if (!text) {
        el.textContent = "";
        el.classList.add("u-hidden");
        return;
    }
    el.textContent = text;
    el.className = `u-mb-16 u-fs-sm u-text-${kind === "error" ? "error" : kind === "success" ? "success" : "secondary"}`;
    el.classList.remove("u-hidden");
}

function setBusy(busy) {
    for (const id of ["view-log-load", "view-log-analyze"]) {
        const btn = $(id);
        if (btn) btn.disabled = busy;
    }
}

/**
 * 隐藏整个结果区，并清掉上一次留下的内容。
 *
 * ⚠️ **只清「内容元素」，绝不要清「结构性容器」** —— 这里踩过：
 * `view-log-raw` 是个 `<details>`，它的 `textContent` 里包含 `<summary>`、两个按钮
 * 与 `#view-log-raw-text`。清一次就等于把这三样从 DOM 里**删掉**，
 * 之后 `$("view-log-raw-text")` 恒为 null，正文再也写不进去 ——
 * 表现是「原始日志永远显示不出来」，而且**一个报错都没有**
 * （2026-10-16 用户反馈；复现时看到 `id="view-log-raw-text"` 已不在 DOM 里）。
 */
function resetResult() {
    const result = $("view-log-result");
    if (result) result.classList.add("u-hidden");
    for (const id of [
        "view-log-summary",
        "view-log-tree",
        "view-log-issues",
        "view-log-raw-text",
        "view-log-source"
    ]) {
        const el = $(id);
        if (el) el.textContent = "";
    }
    // summary 的文案里带着上一条日志的体积与行数，也要还原
    const rawSummary = rawDetails() && rawDetails().querySelector("summary");
    if (rawSummary) rawSummary.textContent = "原始日志";
    // 顺手把"当前这份日志"清空：否则复制/下载会拿到上一条的内容
    currentLog = { id: "", text: "", bytes: 0 };
}

/** `#view-log-raw` 这个 `<details>` 容器（多处用，取不到就返回 null） */
function rawDetails() {
    return $("view-log-raw");
}

/**
 * 分析一份日志（唯一的落地函数：两个入口都走它）。
 * @param {{logId?: string, text?: string, source: string}} opts
 */
async function analyze({ logId = "", text = "", source }) {
    setBusy(true);
    resetResult();
    setStatus(`正在加载日志分析器…（首次使用要取一次解析库）`);

    try {
        // ① 解析器（约 300KB，按需）
        const parse = await ensureApexLogParser();

        // ② 正文：粘贴的直接用；Log ID 的去 org 取
        let body = text;
        let bytes = text.length;
        if (!body && logId) {
            if (!sfConn.connection) {
                // 这个页面的另一条路（粘贴正文）不需要连接，所以提示要指过去，
                // 而不是只说一句"请先连接"
                throw new Error("尚未连接 Salesforce —— 想分析手头的日志，可以直接把正文粘到下面的框里");
            }
            setStatus(`正在从 Salesforce 取日志 ${logId}…`);
            const res = await sfConn.getApexLogBody(logId);
            body = (res && res.text) || "";
            bytes = (res && res.bytes) || body.length;
            if (!body) throw new Error("这条日志的正文是空的（可能已被 org 的保留策略清理）");
        }
        if (!body) throw new Error("没有可分析的日志内容");

        // ③ 解析 + 渲染
        setStatus("正在解析…");
        const parsed = parse(body);
        currentLog = { id: logId, text: body, bytes };
        renderResult({ logId, source, bytes, parsed });

        const s = view.summarize(parsed);
        setStatus(
            `已分析 ${logId || "粘贴的日志"}：${s.eventCount} 个事件 · 总耗时 ${view.formatMs(s.durationMs)}` +
                (s.parsingErrorCount ? ` · ${s.parsingErrorCount} 行未识别` : ""),
            "success"
        );
        showNotification("日志分析完成", "success");
    } catch (error) {
        log.error("日志分析失败:", error);
        setStatus(`分析失败：${error.message || error}`, "error");
        showNotification("日志分析失败：" + (error.message || error), "error");
    } finally {
        setBusy(false);
    }
}

/** 「加载并分析」：读 Log ID 输入框 */
export function loadLogById() {
    const input = $("view-log-id");
    const logId = (input && input.value.trim()) || "";
    if (!logId) {
        showNotification("请先填入 Log ID", "warning");
        return;
    }
    analyze({ logId, source: "id" }).catch((e) => log.error(e));
}

/** 「分析这段日志」：读粘贴框（不需要连接） */
export function analyzePastedLog() {
    const ta = $("view-log-text");
    const text = (ta && ta.value.trim()) || "";
    if (!text) {
        showNotification("请先粘贴日志正文", "warning");
        return;
    }
    analyze({ text, source: "paste" }).catch((e) => log.error(e));
}

/**
 * 分析指定 Log ID（供 `app.js` 的 `applyGotoPayload` 从 Execute Anonymous 那边调）。
 * 会先把 Log ID 回填到输入框 —— 用户看到的是"这一页正在看这条日志"。
 */
export function analyzeLogFromElsewhere(logId) {
    const input = $("view-log-id");
    if (input) input.value = logId;
    return analyze({ logId, source: "id" });
}

// ---------- 渲染 ----------

const SLOWEST_COLUMNS = ["类型", "内容", "自身耗时", "行号"];
const SLOWEST_WIDTHS = ["180px", "auto", "90px", "70px"];
const STATEMENT_COLUMNS = ["语句 / 操作", "影响行数", "耗时", "行号"];
const STATEMENT_WIDTHS = ["auto", "90px", "90px", "70px"];

/** 概览：一行格子（label 在上、值在下） */
function summaryHtml(s) {
    const cells = [
        ["总耗时", view.formatMs(s.durationMs)],
        ["事件数", String(s.eventCount)],
        ["SOQL", `${s.soql.count} 次 · ${s.soql.rows} 行`],
        ["DML", `${s.dml.count} 次 · ${s.dml.rows} 行`],
        ["异常", String(s.thrownCount)],
        // 堆峰值：日志里没有 HEAP_ALLOCATE 行时是 0 —— 显示 0 B 会被读成"没占内存"，
        // 实际是"日志没记录"，两者必须区分
        ["堆峰值", s.heapPeakBytes > 0 ? view.formatBytes(s.heapPeakBytes) : "未记录"],
        ["日志大小", view.formatBytes(s.sizeBytes)],
        ["事务类型", s.entryPoints.join(" / ") || "—"]
    ];
    if (s.sosl.count) cells.push(["SOSL", `${s.sosl.count} 次 · ${s.sosl.rows} 行`]);
    if (s.truncated) cells.push(["日志完整性", "被截断（统计可能偏小）"]);
    return cells
        .map(
            ([label, value]) =>
                `<div class="view-log-cell">` +
                `<div class="u-fs-xs u-text-secondary">${label}</div>` +
                `<div class="u-fs-base u-fw-600 u-break-all">${value}</div>` +
                `</div>`
        )
        .join("");
}

function slowestRows(parsed) {
    return view.topSlowest(parsed, 10).map(({ node, ms }) => ({
        类型: view.typeOf(node),
        内容: view.labelOf(node).slice(0, 200),
        自身耗时: view.formatMs(ms),
        行号: node.lineNumber == null ? "" : String(node.lineNumber)
    }));
}

function statementRows(parsed, prefix) {
    return view.statementRows(parsed, prefix).map((row) => ({
        "语句 / 操作": row.text.slice(0, 400),
        影响行数: String(row.rows),
        耗时: view.formatMs(row.ms),
        行号: row.line
    }));
}

function renderResult({ logId, source, bytes, parsed }) {
    const s = view.summarize(parsed);

    const summary = $("view-log-summary");
    if (summary) summary.innerHTML = summaryHtml(s);

    renderTable("view-log-slowest-wrap", "view-log-slowest-table", slowestRows(parsed), {
        columns: SLOWEST_COLUMNS,
        columnWidths: SLOWEST_WIDTHS,
        layout: "fixed",
        rawHeader: true
    });

    const tree = $("view-log-tree");
    if (tree) {
        tree.innerHTML = view.treeHtml(parsed);
        if (!tree.innerHTML.trim()) {
            tree.innerHTML = '<p class="u-fs-sm u-text-secondary">这份日志里没有可展示的事件（可能是空日志或被截断了）。</p>';
        }
    }

    renderTable("view-log-soql-wrap", "view-log-soql-table", statementRows(parsed, "SOQL"), {
        columns: STATEMENT_COLUMNS,
        columnWidths: STATEMENT_WIDTHS,
        layout: "fixed",
        pageSize: 100,
        rawHeader: true
    });
    renderTable("view-log-dml-wrap", "view-log-dml-table", statementRows(parsed, "DML"), {
        columns: STATEMENT_COLUMNS,
        columnWidths: STATEMENT_WIDTHS,
        layout: "fixed",
        pageSize: 100,
        rawHeader: true
    });

    const issues = $("view-log-issues");
    if (issues) {
        const list = view.issuesList(parsed);
        issues.innerHTML = list.length
            ? list
                  .slice(0, 50)
                  .map(
                      (row) =>
                          `<div class="u-fs-sm u-mb-8"><span class="u-fs-xs u-text-secondary">${row.kind}</span> ` +
                          `<span class="u-break-all">${escapeText(row.text)}</span></div>`
                  )
                  .join("")
            : '<p class="u-fs-sm u-text-secondary">没有异常，也没有会被解析器标记为可疑的地方。</p>';
    }

    // 原始日志：默认折叠（几千行，展开会很长）
    const raw = rawDetails();
    const rawText = $("view-log-raw-text");
    if (rawText) rawText.textContent = currentLog.text;
    // 有 CodeMirror 就用只读查看器（行号 + 查找）；加载失败时它自己返回 false，
    // 上面那个等宽 div 照常显示 —— 复制 / 下载按钮读的也是 currentLog.text，不受影响。
    setLogViewerText(currentLog.text).then((ok) => {
      if (ok && rawText) rawText.classList.add("u-hidden");
    }).catch(() => {});
    if (raw) {
        const title = raw.querySelector("summary");
        if (title) {
            title.textContent = `原始日志（${view.formatBytes(bytes)}，${currentLog.text.split("\n").length} 行）`;
        }
    }
    const sourceLine = $("view-log-source");
    if (sourceLine) {
        sourceLine.textContent =
            source === "paste"
                ? "来源：粘贴的日志正文（未经过 Salesforce）"
                : `来源：Salesforce · Log ID ${logId}`;
    }

    const result = $("view-log-result");
    if (result) result.classList.remove("u-hidden");
}

/** 小工具：把文本转义（只用于我自己拼的 HTML；表格渲染器内部已转义） */
function escapeText(text) {
    return String(text == null ? "" : text)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

/** 「复制原始日志」 */
export function copyRawLog() {
    if (!currentLog.text) {
        showNotification("还没有日志可复制", "warning");
        return;
    }
    copyText(currentLog.text, "日志已复制到剪贴板");
}

/** 「下载原始日志」（文件名用 Log ID，与 Setup → Debug Logs 里一致） */
export function downloadRawLog() {
    if (!currentLog.text) {
        showNotification("还没有日志可下载", "warning");
        return;
    }
    const blob = new Blob([currentLog.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `${currentLog.id || "apex"}.log`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showNotification("日志已下载", "success");
}
