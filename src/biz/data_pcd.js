/**
 * PCD 相关取数（每日 / 过期 / PID Fallout / QC Issue）
 *
 * PCD 四个业务域的取数，结构同 data_query.js（同样是取完即导出）。
 *
 * ── 为什么单独一个文件（2026-10-15）──
 * 这些代码原先都在 `biz/logic.js` 里 —— 一个 2239 行、45 个导出的巨型模块，把取数、导入、
 * 导出、Bulk、定时任务、午餐抽签全塞在一起，改一处要在两千行里翻。按功能域拆成 10 个文件后，
 * 每个 60~400 行，文件名即功能域。**只做了搬运，没有改任何函数体**。
 */

import { createLogger } from "../common/logger.js";

const log = createLogger("PCD");
import { sfConn } from "./sf_service.js";
import { appState } from "./state.js";
import { showNotification } from "../common/utils.js";
import { updateUIState, updateStats, renderPCDDailyData, renderPCDPIDFalloutData, renderPCDQCIssueData, renderPCDExpiredData } from "./ui.js";
import { exportPCDDailyData, exportPCDExpiredData, exportPCDPIDFalloutData, exportPCDQCIssueData } from "./data_export.js";

export async function getPCDDailyData() {
  try {
    log.info("开始获取 PCD 当日数据");

    // 获取自定义 SOQL 查询
    let customQuery = null;
    const customQueryInput = document.getElementById("pcd-daily-soql-query");
    
    if (customQueryInput && customQueryInput.value && customQueryInput.value.trim()) {
      customQuery = customQueryInput.value.trim();
      log.info(`使用自定义 SOQL 查询: ${customQuery}`);
    } else {
      log.debug("使用默认查询");
    }

    // 使用sfConn对象获取 PCD 当日数据
    const result = await sfConn.getPCDDailyData(customQuery);
    log.debug("获取 PCD 当日数据结果:", result);

    if (result.success) {
        // 更新应用状态
        appState.has_pcd_daily_data = true;
        // 保存数据到应用状态，以便后续导出
        appState.pcd_daily_data = result.data;
        // 更新统计数据
        appState.stats.pcdDailyOrders = result.data.length;
        // 不再强制跳转步骤，保持在当前步骤
        log.debug("应用状态已更新");

        // 隐藏loading mask
        const loadingMask = document.getElementById("loading-mask");
        if (loadingMask) {
          loadingMask.style.display = "none";
          loadingMask.querySelector("h3").textContent =
            "正在从Salesforce获取数据...";
        }

        // 显示数据
        renderPCDDailyData(result.data);
        
        // 显示导出按钮
        const exportActions = document.getElementById("pcd-daily-data-actions");
        if (exportActions) {
          exportActions.style.display = "block";
        }
        const exportBtn = document.getElementById("export-pcd-daily-data");
        if (exportBtn) {
          exportBtn.style.display = "inline-block";
        }
        
        // 更新UI状态
        updateUIState();
        // 更新统计数据
        updateStats();
        
        showNotification(`PCD 当日数据获取成功，共 ${result.data.length} 个订单`, "success");
        log.info("PCD 当日数据获取成功");

        // 获取成功后直接导出文件，用户无需再点「导出Excel」
        await exportPCDDailyData();
    } else {
      showNotification(`获取 PCD 当日数据失败: ${result.error}`, "error");
      // 隐藏loading mask
      const loadingMask = document.getElementById("loading-mask");
      if (loadingMask) {
        loadingMask.style.display = "none";
      }
    }
  } catch (error) {
    log.error("获取 PCD 当日数据失败:", error);
    showNotification("获取 PCD 当日数据失败，请稍后重试", "error");

    // 隐藏loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "none";
      loadingMask.querySelector("h3").textContent =
        "正在从Salesforce获取数据...";
    }
    log.info("获取 PCD 当日数据失败，已显示错误通知");
  }
}

export async function getPCDPIDFalloutData() {
  try {
    log.info("开始获取 PCD PID Fallout 数据");

    // 显示loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "flex";
      loadingMask.querySelector("h3").textContent = "正在获取 PCD PID Fallout 数据...";
    }

    // 使用sfConn对象获取 PCD PID Fallout 数据
    const result = await sfConn.getPCDPIDFalloutData();
    log.debug("获取 PCD PID Fallout 数据结果:", result);

    if (result.success) {
        // 更新应用状态
        appState.has_pcd_pid_fallout_data = true;
        // 保存数据到应用状态，以便后续导出
        appState.pcd_pid_fallout_data = result.data;
        // 更新统计数据
        appState.stats.pcdPidFalloutOrders = result.data.length;
        log.debug("应用状态已更新");

        // 隐藏loading mask
        if (loadingMask) {
          loadingMask.style.display = "none";
        }

        // 显示数据
        renderPCDPIDFalloutData(result.data);
        
        // 显示导出按钮
        const exportActions = document.getElementById("pcd-pid-fallout-data-actions");
        if (exportActions) {
          exportActions.style.display = "block";
        }
        const exportBtn = document.getElementById("export-pcd-pid-fallout-data");
        if (exportBtn) {
          exportBtn.style.display = "inline-block";
        }
        
        // 更新UI状态
        updateUIState();
        // 更新统计数据
        updateStats();
        
        showNotification(`PCD PID Fallout 数据获取成功，共 ${result.data.length} 条记录`, "success");
        log.info("PCD PID Fallout 数据获取成功");

        // 获取成功后直接导出文件，用户无需再点「下载CSV」
        exportPCDPIDFalloutData();
    } else {
      showNotification(`获取 PCD PID Fallout 数据失败: ${result.error}`, "error");
      // 隐藏loading mask
      if (loadingMask) {
        loadingMask.style.display = "none";
      }
    }
  } catch (error) {
    log.error("获取 PCD PID Fallout 数据失败:", error);
    showNotification("获取 PCD PID Fallout 数据失败，请稍后重试", "error");

    // 隐藏loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "none";
    }
    log.info("获取 PCD PID Fallout 数据失败，已显示错误通知");
  }
}

export async function getPCDQCIssueData() {
  try {
    log.info("开始获取 PCD QC Issue 数据");

    // 显示loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "flex";
      loadingMask.querySelector("h3").textContent = "正在获取 PCD QC Issue 数据...";
    }

    // 使用sfConn对象获取 PCD QC Issue 数据
    const result = await sfConn.getPCDQCIssueData();
    log.debug("获取 PCD QC Issue 数据结果:", result);

    if (result.success) {
        // 更新应用状态
        appState.has_pcd_qc_issue_data = true;
        // 保存数据到应用状态，以便后续导出
        appState.pcd_qc_issue_data = result.data;
        // 更新统计数据
        appState.stats.pcdQCIssueOrders = result.data.length;
        log.debug("应用状态已更新");

        // 隐藏loading mask
        if (loadingMask) {
          loadingMask.style.display = "none";
        }

        // 显示数据
        renderPCDQCIssueData(result.data);
        
        // 显示导出按钮
        const exportActions = document.getElementById("pcd-qc-issue-data-actions");
        if (exportActions) {
          exportActions.style.display = "block";
        }
        const exportBtn = document.getElementById("export-pcd-qc-issue-data");
        if (exportBtn) {
          exportBtn.style.display = "inline-block";
        }
        
        // 更新UI状态
        updateUIState();
        // 更新统计数据
        updateStats();
        
        showNotification(`PCD QC Issue 数据获取成功，共 ${result.data.length} 条记录`, "success");
        log.info("PCD QC Issue 数据获取成功");

        // 获取成功后直接导出文件，用户无需再点「下载CSV」
        exportPCDQCIssueData();
    } else {
      showNotification(`获取 PCD QC Issue 数据失败: ${result.error}`, "error");
      // 隐藏loading mask
      if (loadingMask) {
        loadingMask.style.display = "none";
      }
    }
  } catch (error) {
    log.error("获取 PCD QC Issue 数据失败:", error);
    showNotification("获取 PCD QC Issue 数据失败，请稍后重试", "error");

    // 隐藏loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "none";
    }
    log.info("获取 PCD QC Issue 数据失败，已显示错误通知");
  }
}

export async function getPCDExpiredData() {
  try {
    log.info("开始获取 PCD 过期数据");

    // 显示loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "flex";
      loadingMask.querySelector("h3").textContent = "正在获取 PCD 过期数据...";
    }

    const result = await sfConn.getPCDExpiredData();
    log.debug("获取 PCD 过期数据结果:", result);

    if (result.success) {
      // 更新应用状态
      appState.has_pcd_expired_data = true;
      // 保存数据到应用状态，以便后续导出
      appState.pcd_expired_data = result.data;
      // 更新统计数据
      appState.stats.pcdExpiredOrders = result.data.length;

      // 隐藏loading mask
      if (loadingMask) {
        loadingMask.style.display = "none";
      }

      // 显示数据
      renderPCDExpiredData(result.data);

      // 显示导出按钮
      const exportActions = document.getElementById("pcd-expired-data-actions");
      if (exportActions) {
        exportActions.style.display = "block";
      }
      const exportBtn = document.getElementById("export-pcd-expired-data");
      if (exportBtn) {
        exportBtn.style.display = "inline-block";
      }

      // 更新UI状态
      updateUIState();
      // 更新统计数据
      updateStats();

      showNotification(`PCD 过期数据获取成功，共 ${result.data.length} 条记录`, "success");
      log.info("PCD 过期数据获取成功");

      // 获取成功后直接导出文件，用户无需再点「导出Excel」
      await exportPCDExpiredData();
    } else {
      showNotification(`获取 PCD 过期数据失败: ${result.error}`, "error");
      // 隐藏loading mask
      if (loadingMask) {
        loadingMask.style.display = "none";
      }
    }
  } catch (error) {
    log.error("获取 PCD 过期数据失败:", error);
    showNotification("获取 PCD 过期数据失败，请稍后重试", "error");

    // 隐藏loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "none";
    }
    log.info("获取 PCD 过期数据失败，已显示错误通知");
  }
}
