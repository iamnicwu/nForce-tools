/**
 * Execute Anonymous（匿名 Apex）
 *
 * 「Execute Anonymous」页的执行与结果展示。
 *
 * ── 为什么单独一个文件（2026-10-15）──
 * 这些代码原先都在 `biz/logic.js` 里 —— 一个 2239 行、45 个导出的巨型模块，把取数、导入、
 * 导出、Bulk、定时任务、午餐抽签全塞在一起，改一处要在两千行里翻。按功能域拆成 10 个文件后，
 * 每个 60~400 行，文件名即功能域。**只做了搬运，没有改任何函数体**。
 */

import { createLogger } from "../common/logger.js";

const log = createLogger("APEX");
import { sfConn } from "./sf_service.js";
import { showNotification } from "../common/utils.js";

export async function executeAnonymousCode() {
    const apexCodeInput = document.getElementById("apex-code-input");
    const resultContainer = document.getElementById("anonymous-result-container");
    const resultContent = document.getElementById("anonymous-result-content");
    
    if (!apexCodeInput) {
        showNotification("找不到 Apex 代码输入框", "error");
        return;
    }
    
    const apexCode = apexCodeInput.value.trim();
    
    if (!apexCode) {
        showNotification("请输入 Apex 代码", "error");
        return;
    }
    
    // 显示 loading
    const executeBtn = document.getElementById("execute-anonymous-btn");
    if (executeBtn) {
        executeBtn.disabled = true;
        executeBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 执行中...';
    }
    
    try {
        const result = await sfConn.executeAnonymous(apexCode);
        
        if (result.success) {
            const res = result.result;
            log.debug("Execute Anonymous 结果:", res);
            
            // 格式化输出结果
            let output = "";
            if (res.compiled === true) {
                output += "✓ 代码编译成功\n";
            } else {
                output += `✗ 编译错误: ${res.line ? `第 ${res.line} 行, ${res.column} 列` : ''}\n`;
                output += `  ${res.compileProblem || '未知编译错误'}\n`;
            }
            
            if (res.success === true) {
                output += "✓ 代码执行成功\n";
            } else {
                output += "✗ 执行失败\n";
            }
            
            if (res.debugLog) {
                output += "\n--- Debug Log ---\n";
                output += res.debugLog;
            }
            
            // 显示详细日志信息
            if (result.logDetails && result.logDetails.log) {
                output += "\n--- Log Details ---\n";
                output += result.logDetails.log;
            }
            
            resultContent.textContent = output;
            resultContainer.style.display = "block";
            showNotification("代码执行完成", "success");
        } else {
            const errorMsg = result.error || "未知错误";
            resultContent.textContent = `✗ 执行失败\n\n错误: ${errorMsg}`;
            resultContainer.style.display = "block";
            showNotification(`执行失败: ${errorMsg}`, "error");
        }
    } catch (error) {
        log.error("Execute Anonymous 出错:", error);
        resultContent.textContent = `✗ 执行出错\n\n错误: ${error.message || error}`;
        resultContainer.style.display = "block";
        showNotification("执行出错: " + (error.message || error), "error");
    } finally {
        // 恢复按钮状态
        if (executeBtn) {
            executeBtn.disabled = false;
            executeBtn.innerHTML = '<i class="fas fa-play"></i> 执行代码';
        }
    }
}
