/**
 * 上传 Excel → 解析 → 套规则（含 T-4 / VVIP / 数据分析）
 *
 * 四类 Excel 导入（通用 / VVIP / 数据分析 / T-4 分析）+ T-4 规则文件 + 两个分析函数。真正的解析与规则在 common/excel_utils.js 与 common/t2rules.js，这里负责 UI 编排。
 *
 * ── 为什么单独一个文件（2026-10-15）──
 * 这些代码原先都在 `biz/logic.js` 里 —— 一个 2239 行、45 个导出的巨型模块，把取数、导入、
 * 导出、Bulk、定时任务、午餐抽签全塞在一起，改一处要在两千行里翻。按功能域拆成 10 个文件后，
 * 每个 60~400 行，文件名即功能域。**只做了搬运，没有改任何函数体**。
 */

import { createLogger } from "../common/logger.js";

const log = createLogger("EXCEL");
import { appState } from "./state.js";
import { showNotification, loadingLog } from "../common/utils.js";
import { processExcelFile as processExcelFileUtil, processVVIPExcelFile as processVVIPExcelFileUtil, processAnalysisExcelFile as processAnalysisExcelFileUtil, analyzeData as analyzeDataUtil, getUniqueOrderCount, readExcelFile, parseSheetData } from "../common/excel_utils.js";
import { updateUIState, updateStats, renderT2AnalysisData, renderAnalysisData, updateFileUploadUI, updateVVIPFileUploadUI, updateAnalysisFileUploadUI, updateT2AnalysisFileUploadUI, updateT2RulesFileUploadUI, renderT2RulesList, renderT2SheetSelector } from "./ui.js";
import { applyT2Rules } from "../common/t2rules.js";

export function processExcelFile(file) {
  if (!file) return;
  
  // 更新UI
  updateFileUploadUI(file);

  // 显示loading mask
  const loadingMask = document.getElementById("loading-mask");
  const recordCountSpan = document.getElementById("record-count");
  const loadingLogElement = document.getElementById("loading-log");

  if (loadingMask && recordCountSpan) {
    loadingMask.style.display = "flex";
    loadingMask.querySelector("h3").textContent = "正在处理Excel文件...";
    recordCountSpan.textContent = "0";
  }

  // 确保日志区域显示
  if (loadingLogElement) {
    loadingLogElement.style.display = "block";
    const logContent = document.getElementById("loading-log-content");
    if (logContent) {
      logContent.innerHTML = ""; // 清空之前的日志
    }
  }

  // 初始化日志
  loadingLog("准备处理文件...", "info");

  processExcelFileUtil(
    file,
    (orderNumbers) => {
      // 成功回调
      // 隐藏loading mask
      if (loadingMask) {
        loadingMask.style.display = "none";
      }

      // 更新应用状态
      appState.order_numbers = orderNumbers;
      appState.has_file = true;
      // 更新统计数据
      appState.stats.uploadedOrders = orderNumbers.length;
      // 不再强制跳转步骤，保持在当前步骤
      log.debug("应用状态已更新");
      loadingLog(`已保存 ${orderNumbers.length} 个订单号到应用状态`, "success");

      updateUIState();
      // 更新统计数据
      updateStats();
      // 不再强制跳转到步骤4，保持在当前步骤
      showNotification(
        `文件已成功上传，共读取到 ${orderNumbers.length} 个唯一的订单号`
      , "success");
      
      // 显示"显示最新数据"按钮
      const getLatestDataBtn = document.getElementById("get-latest-data-btn");
      if (getLatestDataBtn) {
        getLatestDataBtn.style.display = "inline-block";
      }

      log.info("文件上传处理完成");
      loadingLog("文件上传处理完成", "success");
    },
    (error) => {
      // 失败回调
      // 隐藏loading mask
      if (loadingMask) {
        loadingMask.style.display = "none";
      }
      log.error("处理Excel文件失败:", error);
      loadingLog(`处理Excel文件失败: ${error}`, "error");
    }
  );
}

export function processVVIPExcelFile(file) {
  if (!file) return;
  
  // 更新UI
  updateVVIPFileUploadUI(file);

  // 显示loading mask
  const loadingMask = document.getElementById("loading-mask");
  const recordCountSpan = document.getElementById("record-count");

  if (loadingMask && recordCountSpan) {
    loadingMask.style.display = "flex";
    loadingMask.querySelector("h3").textContent = "正在处理VVIP Excel文件...";
    recordCountSpan.textContent = "0";
  }

  processVVIPExcelFileUtil(
    file,
    (result) => {
      // 成功回调
      // 隐藏loading mask
      if (loadingMask) {
        loadingMask.style.display = "none";
      }

      const { pcdIds, ltsIds } = result;
      const allAccountIds = [...pcdIds, ...ltsIds];

      // 更新应用状态
      appState.account_ids = allAccountIds;
      appState.pcd_account_ids = pcdIds;
      appState.lts_account_ids = ltsIds;
      appState.has_vvip_file = true;
      
      // 更新统计数据
      appState.stats.uploadedAccounts = allAccountIds.length;
      appState.stats.uploadedPcdAccounts = pcdIds.length;
      appState.stats.uploadedLtsAccounts = ltsIds.length;
      
      log.debug("应用状态已更新");

      updateUIState();
      // 更新统计数据
      updateStats();
      
      showNotification(
        `文件已成功上传，共读取到 ${pcdIds.length} 个 PCD ID 和 ${ltsIds.length} 个 LTS ID`
      , "success");
      
      // 显示"获取 PCD/LTS 状态"按钮
      const getVVIPDataBtn = document.getElementById("get-vvip-data-btn");
      if (getVVIPDataBtn) {
        getVVIPDataBtn.style.display = "inline-block";
      }

      log.info("VVIP文件上传处理完成");
    },
    (error) => {
      // 失败回调
      // 隐藏loading mask
      if (loadingMask) {
        loadingMask.style.display = "none";
      }
      log.error("处理VVIP Excel文件失败:", error);
    }
  );
}

export function processAnalysisExcelFile(file) {
  if (!file) return;
  
  // 更新UI
  updateAnalysisFileUploadUI(file);

  // 显示loading mask
  const loadingMask = document.getElementById("loading-mask");
  const recordCountSpan = document.getElementById("record-count");

  if (loadingMask && recordCountSpan) {
    loadingMask.style.display = "flex";
    loadingMask.querySelector("h3").textContent = "正在处理数据分析文件...";
    recordCountSpan.textContent = "0";
  }

  processAnalysisExcelFileUtil(
    file,
    (data) => {
      // 成功回调
      // 隐藏loading mask
      if (loadingMask) {
        loadingMask.style.display = "none";
      }

      // 更新应用状态
      appState.analysis_data = data;
      appState.has_analysis_file = true;
      
      // 更新统计数据
      appState.stats.analysisRecords = data.length;
      
      log.debug("应用状态已更新");

      updateUIState();
      // 更新统计数据
      updateStats();
      
      showNotification(
        `文件已成功上传，共读取到 ${data.length} 条记录`
      , "success");
      
      // 自动渲染数据
      renderAnalysisData(data);

      log.info("数据分析文件上传处理完成");
    },
    (error) => {
      // 失败回调
      // 隐藏loading mask
      if (loadingMask) {
        loadingMask.style.display = "none";
      }
      log.error("处理数据分析 Excel 文件失败:", error);
    }
  );
}

export function processT2AnalysisExcelFile(file) {
  if (!file) return;
  
  // 更新UI
  updateT2AnalysisFileUploadUI(file);

  // 显示loading mask
  const loadingMask = document.getElementById("loading-mask");
  const recordCountSpan = document.getElementById("record-count");

  if (loadingMask && recordCountSpan) {
    loadingMask.style.display = "flex";
    loadingMask.querySelector("h3").textContent = "正在读取 T-4 分析文件...";
    recordCountSpan.textContent = "0";
  }

  // 使用新的 readExcelFile 函数读取文件
  readExcelFile(file)
    .then((workbook) => {
      // 隐藏loading mask
      if (loadingMask) {
        loadingMask.style.display = "none";
      }

      // 保存 workbook 到 appState，以便后续切换 Sheet
      appState.t2_workbook = workbook;
      appState.has_t2_analysis_file = true;

      // 获取所有 Sheet 名称
      const sheetNames = workbook.SheetNames;
      
      // 渲染 Sheet 选择器
      renderT2SheetSelector(sheetNames, (selectedSheetName) => {
        // 当用户选择 Sheet 时，解析该 Sheet 的数据
        handleT2SheetSelection(selectedSheetName);
      });

      showNotification("文件读取成功，请选择要分析的工作表", "success");
    })
    .catch((error) => {
      // 失败回调
      // 隐藏loading mask
      if (loadingMask) {
        loadingMask.style.display = "none";
      }
      log.error("处理 T-4 分析 Excel 文件失败:", error);
      showNotification("处理文件失败: " + error, "error");
    });
}

export function processT2RulesFile(file) {
  if (!file) return;
  
  if (!file.name.endsWith(".json")) {
    showNotification("请上传 JSON 格式的规则文件", "error");
    return;
  }

  // 更新UI
  updateT2RulesFileUploadUI(file);

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const rules = JSON.parse(e.target.result);
      if (Array.isArray(rules)) {
        appState.t2_custom_rules = rules;
        renderT2RulesList(rules);
        showNotification(`成功加载 ${rules.length} 条规则`, "success");
      } else {
        showNotification("规则文件格式错误：应为规则数组", "error");
      }
    } catch (error) {
      log.error("解析规则文件失败:", error);
      showNotification("解析规则文件失败: " + error.message, "error");
    }
  };
  reader.readAsText(file);
}

export function analyzeData() {
    // 显示loading mask
    const loadingMask = document.getElementById("loading-mask");
    const recordCountSpan = document.getElementById("record-count");

    if (loadingMask && recordCountSpan) {
    loadingMask.style.display = "flex";
    loadingMask.querySelector("h3").textContent = "正在分析数据...";
    recordCountSpan.textContent = appState.analysis_data ? appState.analysis_data.length : "0";
    }

    // 使用 setTimeout 让 UI 有机会渲染 loading mask
    setTimeout(() => {
    try {
        // 执行分析
        const analyzedData = analyzeDataUtil(appState.analysis_data, appState.custom_rules);
        
        // 更新应用状态
        appState.analysis_data = analyzedData;
        
        // 重新渲染表格
        renderAnalysisData(analyzedData);
        
        showNotification("数据分析完成", "success");
    } catch (error) {
        log.error("数据分析失败:", error);
        showNotification("数据分析失败: " + error.message, "error");
    } finally {
        // 隐藏 loading mask
        if (loadingMask) {
        loadingMask.style.display = "none";
        }
    }
    }, 100);
}

export function analyzeT2Data() {
    // 检查是否有T-4数据 (来自文件或Salesforce)
    let dataToAnalyze = null;
    
    if (appState.has_t2_analysis_file && appState.t2_analysis_data && appState.t2_analysis_data.length > 0) {
        // 优先使用上传的文件数据
        dataToAnalyze = appState.t2_analysis_data;
    } else if (appState.has_t2_data && appState.t2_data && appState.t2_data.length > 0) {
        // 其次使用从Salesforce获取的数据
        dataToAnalyze = appState.t2_data;
    }

    if (!dataToAnalyze) {
        showNotification("请先上传 Excel 文件或获取 T-4 Outstanding 数据", "warning");
        return;
    }

    // 显示loading mask
    const loadingMask = document.getElementById("loading-mask");
    const recordCountSpan = document.getElementById("record-count");

    if (loadingMask && recordCountSpan) {
        loadingMask.style.display = "flex";
        loadingMask.querySelector("h3").textContent = "正在分析 T-4 数据...";
        recordCountSpan.textContent = dataToAnalyze.length;
    }

    // 使用 setTimeout 让 UI 有机会渲染 loading mask
    setTimeout(async () => {
        try {
            // 执行分析
            // 使用硬编码的 T-4 规则 (applyT2Rules)
            log.debug("使用 applyT2Rules 进行分析...");
            const analyzedData = applyT2Rules(dataToAnalyze);
            
            // 更新应用状态
            appState.t2_analysis_data = analyzedData;
            
            // 重新渲染表格和图表
            renderT2AnalysisData(analyzedData);
            
            // 更新UI状态 (显示导出按钮等)
            updateUIState();
            
            showNotification("T-4 数据分析完成", "success");
        } catch (error) {
            log.error("T-4 数据分析失败:", error);
            showNotification("T-4 数据分析失败: " + error.message, "error");
        } finally {
            // 隐藏 loading mask
            if (loadingMask) {
                loadingMask.style.display = "none";
            }
        }
    }, 100);
}

async function handleT2SheetSelection(sheetName) {
  if (!appState.t2_workbook) return;

  log.info(`正在切换到工作表: ${sheetName}`);
  
  // 解析选中 Sheet 的数据（XLSX 按需加载 → parseSheetData 是异步的）
  const data = await parseSheetData(appState.t2_workbook, sheetName);
  
  // 更新应用状态
  appState.t2_analysis_data = data;
  
  // 更新统计数据
  appState.stats.t2AnalysisRecords = data.length;
  
  updateUIState();
  updateStats();
  
  // 计算唯一订单号数量
  const uniqueOrderCount = getUniqueOrderCount(data);
  
  showNotification(
    `已加载工作表 "${sheetName}"，共 ${data.length} 条记录，包含 ${uniqueOrderCount} 个唯一订单`
  , "success");
  
  // 自动渲染数据
  renderT2AnalysisData(data);
}
