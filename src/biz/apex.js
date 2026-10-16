/**
 * Execute Anonymous（匿名 Apex）
 *
 * 「Execute Anonymous」页的**执行与结果展示**，执行完自动把**本次执行**的日志一起带回来。
 *
 * ── 为什么单独一个文件（2026-10-15）──
 * 这些代码原先都在 `biz/logic.js` 里 —— 一个 2239 行、45 个导出的巨型模块，把取数、导入、
 * 导出、Bulk、定时任务、午餐抽签全塞在一起，改一处要在两千行里翻。按功能域拆成 10 个文件后，
 * 每个 60~400 行，文件名即功能域。**只做了搬运，没有改任何函数体**。
 *
 * ── 自动取日志（2026-10-16）──
 * 取日志的链路（确保 TraceFlag → 认准本次那条 → 取正文）全在 `biz/sf_service.js` 的
 * `executeAnonymous()` 里，**判定规则**在 `common/apex_log.js`（可单测）。
 * 这里只负责"把它显示出来 + 让用户拿得走"：
 *   · 日志块（Log ID + 摘要行 + 正文），支持复制日志 / 复制 ID / 下载 .log
 *   · TraceFlag 那一步的结论（复用了现有的 / 新开的 / 开不起来的原因）单独一行 ——
 *     取不到日志时，用户第一件想知道的就是"是跟踪没开，还是这次真没输出"。
 */

import { createLogger } from "../common/logger.js";

const log = createLogger("APEX");
import { sfConn } from "./sf_service.js";
import { showNotification, copyText } from "../common/utils.js";
import { $ } from "../common/dom.js";
import { replaceIcons } from "../common/icons.js";
// 纯逻辑（SOQL 拼装 / 日志挑选 / 文案），与 sf_service 的分工见上面说明
import * as apexLog from "../common/apex_log.js";

/** 最近一次执行拿到的日志 —— 「复制 / 下载」用它，避免再从 DOM 里把文本读回来 */
let lastLog = { id: "", text: "" };

/** 按钮忙碌态（图标 + 文案 + 禁用），执行期间防重复点击 */
function setBusy(btn, busy) {
    if (!btn) return;
    btn.disabled = busy;
    btn.innerHTML = busy
        ? '<i class="fas fa-spinner fa-spin"></i> 执行中…'
        : '<i class="fas fa-play"></i> 执行代码';
    // ⚠️ 动态写进去的 `<i class="fas …">` 必须**再替换一次**：启动时那次 replaceIcons()
    // 扫的是当时的 DOM，新插入的元素不会被处理，表现是按钮上多出一个**空白方块**。
    // （2026-10-16 由 panel-shot 的 unfixed 计数抓到：旧实现一直有这个问题，
    //   只是以前没有用例点过「执行代码」，所以从没暴露。）
    replaceIcons();
}

/** 执行结果文字（编译 / 执行两行 + 编译错误定位 + 运行时异常） */
function formatExecuteResult(res) {
    if (!res) return "（服务端没有返回结果）";
    let out = "";
    if (res.compiled === true) {
        out += "✓ 代码编译成功\n";
    } else {
        out += `✗ 编译错误${res.line ? `：第 ${res.line} 行，第 ${res.column} 列` : ""}\n`;
        out += `  ${res.compileProblem || "未知编译错误"}\n`;
    }
    out += res.success === true ? "✓ 代码执行成功\n" : "✗ 执行失败\n";
    if (res.exceptionMessage) out += `\n异常：${res.exceptionMessage}\n`;
    if (res.exceptionStackTrace) out += `\n${res.exceptionStackTrace}\n`;
    return out;
}

/** 清掉上一轮的日志与提示（每次执行前调用） */
function resetApexLog() {
    lastLog = { id: "", text: "" };
    const block = $("apex-log-block");
    const hint = $("apex-log-hint");
    if (block) block.classList.add("u-hidden");
    if (hint) {
        hint.classList.add("u-hidden");
        hint.textContent = "";
    }
    for (const id of ["apex-log-meta", "apex-log-id", "apex-log-body"]) {
        const el = $(id);
        if (el) el.textContent = "";
    }
}

/**
 * 显示日志块与诊断提示。
 *
 * 三种情况分开处理：拿到正文 / 只拿到记录（正文取失败）/ 什么都没拿到。
 * 无论哪种，TraceFlag 那一步的结论都会显示 —— 那正是"为什么没有日志"的答案。
 */
function renderApexLog(res) {
    const block = $("apex-log-block");
    const hint = $("apex-log-hint");
    const meta = $("apex-log-meta");
    const idEl = $("apex-log-id");
    const bodyEl = $("apex-log-body");

    const lines = [];
    const traceLine = apexLog.traceFlagHint(res.trace);
    if (traceLine) lines.push(traceLine);
    if (res.logError) lines.push(`取日志内容出错：${res.logError}`);

    if (res.logRecord && res.logBody) {
        // 复制 / 下载用**完整**正文（`sfConn.getApexLogBody` 不再截断），
        // 界面只显示头部若干 KB —— 单条日志上限 5MB，整段塞进 DOM 会把页面拖死
        lastLog = { id: res.logRecord.Id || "", text: res.logBody.text || "" };
        const shown = apexLog.normalizeLogBody(lastLog.text, apexLog.LOG_BODY_DISPLAY_LIMIT);
        if (meta) meta.textContent = apexLog.logMetaText(res.logRecord);
        // Log ID 本身就是「查看详细分析」的入口（点击 → section-31）
        if (idEl) idEl.textContent = lastLog.id;
        if (bodyEl) bodyEl.textContent = shown.text;
        if (block) block.classList.remove("u-hidden");
    } else if (res.logRecord && !res.logBody) {
        // 记录查到了但正文没取到：Log ID 仍然有用 —— 用户能自己去 Setup → Debug Logs 里看
        lastLog = { id: res.logRecord.Id || "", text: "" };
        if (meta) meta.textContent = apexLog.logMetaText(res.logRecord);
        if (idEl) idEl.textContent = lastLog.id;
        if (bodyEl) bodyEl.textContent = "（日志正文获取失败，可凭上面的 Log ID 到 Setup → Debug Logs 里查看）";
        if (block) block.classList.remove("u-hidden");
    } else if (!res.logError) {
        lines.push(apexLog.noLogHint({ traceOk: !!(res.trace && res.trace.ok) }));
    }

    if (hint && lines.length) {
        // 逐行建元素而不是拼 innerHTML：这些文案将来可能带上 Apex 片段（`<apex:page>` 之类），
        // 拼 HTML 会被解析成标签吃掉
        hint.textContent = "";
        lines.forEach((line) => {
            const row = document.createElement("div");
            row.textContent = line;
            hint.appendChild(row);
        });
        hint.classList.remove("u-hidden");
    }
}

export async function executeAnonymousCode() {
    const apexCodeInput = $("apex-code-input");
    const resultContainer = $("anonymous-result-container");
    const resultContent = $("anonymous-result-content");

    if (!apexCodeInput || !resultContainer || !resultContent) {
        showNotification("找不到 Apex 代码输入框", "error");
        return;
    }

    const apexCode = apexCodeInput.value.trim();
    if (!apexCode) {
        showNotification("请输入 Apex 代码", "error");
        return;
    }

    const executeBtn = $("execute-anonymous-btn");
    setBusy(executeBtn, true);
    resetApexLog();

    try {
        const result = await sfConn.executeAnonymous(apexCode);

        if (!result.success) {
            const errorMsg = result.error || "未知错误";
            resultContent.textContent = `✗ 执行失败\n\n错误：${errorMsg}`;
            resultContainer.style.display = "block";
            showNotification(`执行失败：${errorMsg}`, "error");
            return;
        }

        const res = result.result || {};
        log.debug("Execute Anonymous 结果:", res);
        resultContent.textContent = formatExecuteResult(res);
        resultContainer.style.display = "block";
        renderApexLog(result);

        if (res.success === true) {
            showNotification("代码执行成功", "success");
        } else {
            // 编译错误 / 运行时异常都走这里：日志往往才是真正的线索，所以提示里带上它
            showNotification(
                res.compiled === false ? "编译未通过（见结果与日志）" : "执行失败（见结果与日志）",
                "warning"
            );
        }
    } catch (error) {
        log.error("Execute Anonymous 出错:", error);
        resultContent.textContent = `✗ 执行出错\n\n错误：${error.message || error}`;
        resultContainer.style.display = "block";
        showNotification("执行出错：" + (error.message || error), "error");
    } finally {
        setBusy(executeBtn, false);
    }
}

/** 「复制日志」—— 复制完整正文（不是界面上被截断的那份） */
export function copyApexLog() {
    if (!lastLog.text) {
        showNotification("还没有日志可复制", "warning");
        return;
    }
    copyText(lastLog.text, "日志已复制到剪贴板");
}

/** 「复制」Log ID */
export function copyApexLogId() {
    if (!lastLog.id) {
        showNotification("还没有 Log ID 可复制", "warning");
        return;
    }
    copyText(lastLog.id, "Log ID 已复制到剪贴板");
}

/** 「下载 .log」—— 文件名用 Log ID，与 Setup → Debug Logs 里的一致，便于对照 */
export function downloadApexLogFile() {
    if (!lastLog.text) {
        showNotification("还没有日志可下载", "warning");
        return;
    }
    const blob = new Blob([lastLog.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.setAttribute("href", url);
    link.setAttribute("download", `${lastLog.id || "apex"}.log`);
    link.style.visibility = "hidden";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
    showNotification("日志已下载", "success");
}
