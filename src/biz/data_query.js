/**
 * 各业务域的取数（每日 / 报表 / 文件 / VVIP / T-4）
 *
 * SOQL 取数 + 渲染 + 自动导出。注意每个 get*Data 末尾都会调 data_export.js 里的导出函数（「取完就落盘」是既有行为），所以本模块依赖 data_export.js，方向是单向的、不成环。
 *
 * ── 为什么单独一个文件（2026-10-15）──
 * 这些代码原先都在 `biz/logic.js` 里 —— 一个 2239 行、45 个导出的巨型模块，把取数、导入、
 * 导出、Bulk、定时任务、午餐抽签全塞在一起，改一处要在两千行里翻。按功能域拆成 10 个文件后，
 * 每个 60~400 行，文件名即功能域。**只做了搬运，没有改任何函数体**。
 */

import { createLogger } from "../common/logger.js";

const log = createLogger("QUERY");
import { sfConn } from "./sf_service.js";
import { appState } from "./state.js";
import { showNotification, loadingLog } from "../common/utils.js";
import { updateUIState, updateStats, renderReportData, renderT2Data, renderLatestData, renderDailyData, renderVVIPData } from "./ui.js";
import { exportDailyData, exportLatestData, exportReportData, exportT2Data, exportVVIPData } from "./data_export.js";
import { syncReportDataToOneDrive } from "./onedrive_sync.js";

export async function getSalesforceData() {
  try {
    log.info("开始获取最新Salesforce数据");
    loadingLog("开始获取Salesforce数据...", "info");

    // 显示日志区域
    const loadingLogEl = document.getElementById("loading-log");
    if (loadingLogEl) {
      loadingLogEl.style.display = "block";
      const logContent = document.getElementById("loading-log-content");
      if (logContent) logContent.innerHTML = "";
    }
    log.debug("appState.order_numbers: ", appState.order_numbers);
    // 使用sfConn对象获取Salesforce数据
    const result = await sfConn.getSFData(appState.order_numbers, (count) => {
      // 更新记录数显示
      const recordCountSpan = document.getElementById("record-count");
      if (recordCountSpan) {
        recordCountSpan.textContent = count;
      }
      loadingLog(`正在获取数据，已匹配 ${count} 条记录...`, "info");
    });
    log.debug("result1: " + result.data);
    if (result.success) {
        log.debug("result: " + result.data);
        // 更新记录数显示
        const recordCountSpan = document.getElementById("record-count");
        if (recordCountSpan) {
          recordCountSpan.textContent = result.data.length;
          log.debug("已更新UI记录数显示");
        }

        // 更新统计数据
        appState.stats.fetchedData = result.data.length;
        updateStats();

        // 保存数据到应用状态
        appState.latest_data = result.data;

        // 隐藏loading mask
        const loadingMask = document.getElementById("loading-mask");
        if (loadingMask) {
          loadingMask.style.display = "none";
          log.debug("已隐藏loading mask");
        }
        loadingLog(`数据获取完成，共 ${result.data.length} 条记录`, "success");

        // 显示数据
        renderLatestData(result.data);

        // 显示导出按钮
        const exportBtn = document.getElementById("export-latest-data");
        if (exportBtn) {
          exportBtn.style.display = "inline-block";
        }

        showNotification(`最新数据获取成功，共 ${result.data.length} 条记录`, "success");

        // 获取成功后直接导出文件，用户无需再点「导出数据」
        await exportLatestData();
    }
  } catch (error) {
    log.error("获取Salesforce数据失败:", error);
    loadingLog(`获取Salesforce数据失败: ${error.message}`, "error");
    showNotification(
      "获取Salesforce数据失败，请检查Session ID和网络连接",
      "error"
    );

    // 隐藏loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "none";
    }
    log.info("获取数据失败，已显示错误通知");
  }
}

export async function getDailyData() {
  try {
    log.info("开始获取当日数据");

    // 获取自定义日期参数
    let startDate = null;
    let endDate = null;
    const customDateCheckbox = document.getElementById("daily-custom-date-checkbox");
    
    if (customDateCheckbox && customDateCheckbox.checked) {
      const startDateInput = document.getElementById("daily-start-date");
      const endDateInput = document.getElementById("daily-end-date");
      
      if (startDateInput && startDateInput.value) {
        startDate = startDateInput.value;
      }
      
      if (endDateInput && endDateInput.value) {
        endDate = endDateInput.value;
      }
      
      if (!startDate && !endDate) {
        showNotification("请至少选择一个日期", "warning");
        // 隐藏loading mask
        const loadingMask = document.getElementById("loading-mask");
        if (loadingMask) {
          loadingMask.style.display = "none";
        }
        return;
      }
      
      log.info(`使用自定义日期范围: ${startDate} 到 ${endDate}`);
    }

    // 使用sfConn对象获取当日数据
    const result = await sfConn.getDailyData(startDate, endDate);
    log.debug("获取当日数据结果:", result);

    if (result.success) {
        // 更新应用状态
        appState.has_daily_data = true;
        // 保存数据到应用状态，以便后续导出
        appState.daily_data = result.data;
        // 更新统计数据
        appState.stats.dailyOrders = result.data.length;
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
        renderDailyData(result.data);
        
        // 显示导出按钮
        const exportActions = document.getElementById("daily-data-actions");
        if (exportActions) {
          exportActions.style.display = "block";
        }
        const exportBtn = document.getElementById("export-daily-data");
        if (exportBtn) {
          exportBtn.style.display = "inline-block";
        }
        
        // 更新UI状态
        updateUIState();
        // 更新统计数据
        updateStats();
        // 不再强制跳转到步骤4，保持在当前步骤
        showNotification(`当日数据获取成功，共 ${result.data.length} 个订单`, "success");
        log.info("当日数据获取成功");

        // 获取成功后直接导出文件，用户无需再点「导出Excel」
        await exportDailyData();
    } else {
      showNotification(`获取当日数据失败: ${result.error}`, "error");
    }
  } catch (error) {
    log.error("获取当日数据失败:", error);
    showNotification("获取当日数据失败，请稍后重试", "error");

    // 隐藏loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "none";
      loadingMask.querySelector("h3").textContent =
        "正在从Salesforce获取数据...";
    }
    log.info("获取当日数据失败，已显示错误通知");
  }
}

export async function getReportData() {
  try {
    log.info("开始获取报表数据");

    // 使用sfConn对象获取报表数据
    const result = await sfConn.getReportData();
    
    if (result.success) {
        // 更新应用状态
        appState.has_report_data = true;
        // 保存数据到应用状态，以便后续导出
        appState.report_data = result.data;
        // 更新统计数据
        appState.stats.reportRecords = result.data?.length || 0;
        // 不再强制跳转步骤，保持在当前步骤
        log.debug("应用状态已更新");

        // 隐藏loading mask
        const loadingMask = document.getElementById("loading-mask");
        if (loadingMask) {
          loadingMask.style.display = "none";
          loadingMask.querySelector("h3").textContent = "正在从Salesforce获取数据...";
        }

        // 显示数据
        renderReportData(result.data);
        
        // 显示导出按钮
        const exportActions = document.getElementById("report-data-actions");
        if (exportActions) {
          exportActions.style.display = "block";
        }
        const exportBtn = document.getElementById("export-report-data");
        if (exportBtn) {
          exportBtn.style.display = "inline-block";
        }

        // 更新UI状态
        updateUIState();
        // 更新统计数据
        updateStats();

        log.info("报表数据获取成功");

        // 获取成功后直接导出文件，用户无需再点「导出Excel」
        // （exportToExcel 内部自带 try/catch，不会产生未处理的 rejection）
        await exportReportData();

        // OneDrive 同步是可选行为（默认关闭，见 section-3 的勾选框）。
        // 这里刻意不 await：分批写入的固定延迟会拖慢用户看到文件的时机，
        // 同步结果由 syncReportDataToOneDrive 自己用通知汇报。
        void syncReportDataToOneDrive(result.data);
    }
  } catch (error) {
    log.error("获取报表数据失败:", error);
    showNotification("获取报表数据失败，请稍后重试", "error");

    // 隐藏loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "none";
      loadingMask.querySelector("h3").textContent = "正在从Salesforce获取数据...";
    }
    log.info("获取报表数据失败，已显示错误通知");
  }
}

export async function getT2Data() {
  try {
    log.info("开始获取T-4数据");

    // 获取用户输入的天数
    const daysInput = document.getElementById("t2-days-input");
    const customDays = daysInput ? daysInput.value : null;

    // 使用sfConn对象获取T-4数据
    const result = await sfConn.getT2Data(customDays);
    
    if (result.success) {
        // 更新应用状态
        appState.has_t2_data = true;
        // 保存数据到应用状态，以便后续导出
        appState.t2_data = result.data;
        // 更新统计数据
        appState.stats.t2Records = result.data?.length || 0;
        // 不再强制跳转步骤，保持在当前步骤
        log.debug("应用状态已更新");

        // 隐藏loading mask
        const loadingMask = document.getElementById("loading-mask");
        if (loadingMask) {
          loadingMask.style.display = "none";
          loadingMask.querySelector("h3").textContent = "正在从Salesforce获取数据...";
        }

        // 显示数据
        renderT2Data(result.data);
        
        // 显示导出按钮
        const exportActions = document.getElementById("t2-data-actions");
        if (exportActions) {
          exportActions.style.display = "block";
        }
        const exportBtn = document.getElementById("export-t2-data");
        if (exportBtn) {
          exportBtn.style.display = "inline-block";
        }

        // 更新UI状态
        updateUIState();
        // 更新统计数据
        updateStats();
        // 不再强制跳转到步骤5，保持在当前步骤
        showNotification(`T-4数据获取成功，共 ${appState.stats.t2Records} 条记录`, "success");
        log.info("T-4数据获取成功");

        // 获取成功后直接导出文件，用户无需再点「导出Excel」
        await exportT2Data();
    }
  } catch (error) {
    log.error("获取T-4数据失败:", error);
    showNotification("获取T-4数据失败，请稍后重试", "error");

    // 隐藏loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "none";
      loadingMask.querySelector("h3").textContent = "正在从Salesforce获取数据...";
    }
    log.info("获取T-4数据失败，已显示错误通知");
  }
}

export async function getVVIPData() {
  try {
    log.info("开始获取VVIP数据");

    // 使用sfConn对象获取VVIP数据
    const result = await sfConn.getVVIPData(appState.pcd_account_ids, appState.lts_account_ids, (count) => {
      // 更新记录数显示
      const recordCountSpan = document.getElementById("record-count");
      if (recordCountSpan) {
        recordCountSpan.textContent = count;
      }
    });
    
    if (result.success) {
        // 更新记录数显示
        const recordCountSpan = document.getElementById("record-count");
        if (recordCountSpan) {
          recordCountSpan.textContent = result.data.length;
          log.debug("已更新UI记录数显示");
        }

        // 保存数据到应用状态
        appState.vvip_data = result.data;
        
        // 更新统计数据
        appState.stats.vvipOrders = result.data.length;
        updateStats();

        // 隐藏loading mask
        const loadingMask = document.getElementById("loading-mask");
        if (loadingMask) {
          loadingMask.style.display = "none";
          log.debug("已隐藏loading mask");
        }

        // 显示数据
        renderVVIPData(result.data);

        // 显示导出按钮
        const exportBtn = document.getElementById("export-vvip-data");
        if (exportBtn) {
          exportBtn.style.display = "inline-block";
        }

        showNotification(`VVIP数据获取成功，共 ${result.data.length} 条记录`, "success");

        // 获取成功后直接导出文件，用户无需再点「导出数据」
        await exportVVIPData();
    }
  } catch (error) {
    log.error("获取VVIP数据失败:", error);
    showNotification(
      "获取VVIP数据失败，请检查Session ID和网络连接",
      "error"
    );

    // 隐藏loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "none";
    }
    log.info("获取VVIP数据失败，已显示错误通知");
  }
}
