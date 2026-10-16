/**
 * Bulk API 2.0（建 Job / 查状态 / 下结果 / 列表）
 *
 * Bulk 操作那页的全部后端动作。`bulkJobsLoaded` 是「列表只自动拉一次」的模块级门闩。
 *
 * ── 为什么单独一个文件（2026-10-15）──
 * 这些代码原先都在 `biz/logic.js` 里 —— 一个 2239 行、45 个导出的巨型模块，把取数、导入、
 * 导出、Bulk、定时任务、午餐抽签全塞在一起，改一处要在两千行里翻。按功能域拆成 10 个文件后，
 * 每个 60~400 行，文件名即功能域。**只做了搬运，没有改任何函数体**。
 */

import { createLogger } from "../common/logger.js";

const log = createLogger("BULK");
import { sfConn } from "./sf_service.js";
import { showNotification } from "../common/utils.js";
import { renderBulkJobsTable, showBulkJobsLoading } from "./ui.js";
import { ensureJSZip } from "../common/lib_loader.js";

let bulkJobsLoaded = false;

export async function handleCreateBulkJob() {
  const soqlInput = document.getElementById("bulk-soql-input");
  const soql = soqlInput ? soqlInput.value.trim() : "";
  
  if (!soql) {
    showNotification("请输入 SOQL 查询语句", "warning");
    return;
  }

  const loadingMask = document.getElementById("loading-mask");
  if (loadingMask) {
    loadingMask.style.display = "flex";
    loadingMask.querySelector("h3").textContent = "正在创建 Bulk 任务...";
  }

  try {
    const result = await sfConn.createBulkQueryJob(soql);
    if (result.success) {
      showNotification("Bulk 任务创建成功", "success");
      const jobIdInput = document.getElementById("bulk-job-id-input");
      if (jobIdInput && result.jobInfo && result.jobInfo.id) {
        jobIdInput.value = result.jobInfo.id;
      }
      
      const statusContainer = document.getElementById("bulk-job-status-container");
      const statusContent = document.getElementById("bulk-job-status-content");
      if (statusContainer && statusContent) {
        statusContainer.style.display = "block";
        statusContent.textContent = JSON.stringify(result.jobInfo, null, 2);
      }
    } else {
      showNotification(`创建 Bulk 任务失败: ${result.error}`, "error");
    }
  } catch (error) {
    log.error("创建 Bulk 任务出错:", error);
    showNotification("创建 Bulk 任务出错", "error");
  } finally {
    if (loadingMask) {
      loadingMask.style.display = "none";
    }
  }
}

export async function handleCheckBulkJob() {
  const jobIdInput = document.getElementById("bulk-job-id-input");
  const jobId = jobIdInput ? jobIdInput.value.trim() : "";
  
  if (!jobId) {
    showNotification("请输入 Job ID", "warning");
    return;
  }

  const loadingMask = document.getElementById("loading-mask");
  if (loadingMask) {
    loadingMask.style.display = "flex";
    loadingMask.querySelector("h3").textContent = "正在查询任务状态...";
  }

  try {
    const result = await sfConn.checkBulkJobStatus(jobId);
    if (result.success) {
      showNotification("查询状态成功", "success");
      
      const statusContainer = document.getElementById("bulk-job-status-container");
      const statusContent = document.getElementById("bulk-job-status-content");
      if (statusContainer && statusContent) {
        statusContainer.style.display = "block";
        statusContent.textContent = JSON.stringify(result.jobInfo, null, 2);
      }

      const downloadActions = document.getElementById("download-bulk-actions");
      if (downloadActions) {
        if (result.jobInfo && result.jobInfo.state === "JobComplete") {
          downloadActions.style.display = "flex";
        } else {
          downloadActions.style.display = "none";
        }
      }
    } else {
      showNotification(`查询状态失败: ${result.error}`, "error");
    }
  } catch (error) {
    log.error("查询状态出错:", error);
    showNotification("查询状态出错", "error");
  } finally {
    if (loadingMask) {
      loadingMask.style.display = "none";
    }
  }
}

export async function handleDownloadBulkResult(format = 'csv') {
  const jobIdInput = document.getElementById("bulk-job-id-input");
  const jobId = jobIdInput ? jobIdInput.value.trim() : "";
  
  if (!jobId) {
    showNotification("请输入 Job ID", "warning");
    return;
  }

  const loadingMask = document.getElementById("loading-mask");
  if (loadingMask) {
    loadingMask.style.display = "flex";
    loadingMask.querySelector("h3").textContent = `正在下载并处理结果 (${format.toUpperCase()})...`;
  }

  try {
    const result = await sfConn.getBulkJobResults(jobId);
    if (result.success) {
      showNotification("获取数据成功，正在生成文件...", "success");
      
      if (format === 'zip') {
        // 使用 JSZip 压缩数据（按需加载，只有选 ZIP 时才拉这 95KB）
        await ensureJSZip();
        const zip = new JSZip();
        zip.file(`bulk_result_${jobId}.csv`, result.csvData);
        
        const content = await zip.generateAsync({ type: "blob", compression: "DEFLATE" });
        
        const link = document.createElement("a");
        const url = URL.createObjectURL(content);
        link.setAttribute("href", url);
        link.setAttribute("download", `bulk_result_${jobId}.zip`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        
        showNotification("ZIP 文件下载成功", "success");
      } else {
        // 直接下载 CSV
        const blob = new Blob([result.csvData], { type: 'text/csv;charset=utf-8;' });
        const link = document.createElement("a");
        const url = URL.createObjectURL(blob);
        link.setAttribute("href", url);
        link.setAttribute("download", `bulk_result_${jobId}.csv`);
        link.style.visibility = 'hidden';
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
        URL.revokeObjectURL(url);
        
        showNotification("CSV 文件下载成功", "success");
      }
    } else {
      showNotification(`下载结果失败: ${result.error}`, "error");
    }
  } catch (error) {
    log.error("下载结果出错:", error);
    showNotification("下载结果出错", "error");
  } finally {
    if (loadingMask) {
      loadingMask.style.display = "none";
    }
  }
}

export async function fetchBulkJobs() {
    try {
        log.info("开始获取 Bulk Jobs...");

        // 显示加载态（表格/空态由 renderBulkJobsTable 收起）
        showBulkJobsLoading();

        const result = await sfConn.getAllBulkQueryJobs();
        
        if (result.success) {
            const jobs = result.jobs || [];
            bulkJobsLoaded = true;
            log.info(`获取到 ${jobs.length} 个 Bulk Job`);
            
            // 渲染表格
            renderBulkJobsTable(jobs);
            
            if (jobs.length > 0) {
                showNotification(`共 ${jobs.length} 个 Bulk Job`, "success");
            }
        } else {
            log.error("获取 Bulk Jobs 失败:", result.error);
            showNotification(`获取 Bulk Jobs 失败: ${result.error}`, "error");
            
            // 显示空状态
            const emptyEl = document.getElementById("bulk-jobs-empty");
            const loadingEl = document.getElementById("bulk-jobs-loading");
            const container = document.getElementById("bulk-jobs-container");
            
            if (loadingEl) loadingEl.style.display = "none";
            if (container) container.style.display = "none";
            if (emptyEl) {
                emptyEl.style.display = "block";
                emptyEl.innerHTML = '';
                const icon = document.createElement('i');
                icon.className = 'fas fa-exclamation-circle';
                icon.style.cssText = 'font-size: var(--fs-3xl); color: var(--error-color); margin-bottom: 0.5rem;';
                const p = document.createElement('p');
                p.textContent = `获取失败: ${result.error}`;
                emptyEl.appendChild(icon);
                emptyEl.appendChild(p);
            }
        }
    } catch (error) {
        log.error("获取 Bulk Jobs 出错:", error);
        showNotification("获取 Bulk Jobs 出错", "error");
    }
}

export function loadBulkJobsOnce() {
    if (bulkJobsLoaded) return;
    bulkJobsLoaded = true;
    fetchBulkJobs();
}
