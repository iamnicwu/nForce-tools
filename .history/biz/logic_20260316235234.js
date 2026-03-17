import { sfConn } from "./sf_service.js";
import { appState } from "./state.js";
import { showNotification } from "../common/utils.js";
import { processExcelFile as processExcelFileUtil, processVVIPExcelFile as processVVIPExcelFileUtil, processAnalysisExcelFile as processAnalysisExcelFileUtil, analyzeData as analyzeDataUtil, analyzeT2Data as analyzeT2DataUtil, exportToExcel, getUniqueOrderCount, readExcelFile, parseSheetData } from "../common/excel_utils.js";
import { showSection, updateUIState, updateStats, renderReportData, renderT2Data, renderT2AnalysisData, renderLatestData, renderDailyData, renderPCDDailyData, renderVVIPData, renderAnalysisData, updateFileUploadUI, updateVVIPFileUploadUI, updateAnalysisFileUploadUI, updateT2AnalysisFileUploadUI, updateT2RulesFileUploadUI, renderT2RulesList, renderT2SheetSelector, updateLunchFileUploadUI, showLunchResult, updateLunchUIState } from "./ui.js";
import {applyT2Rules} from "../common/t2rules.js"
// 默认午餐地点
const DEFAULT_LUNCH_PLACES = [
  {"name": "万达兰州拉面"},
  {"name": "京华胜记"},
  {"name": "京华牛杂面"},
  {"name": "荣耀国际"},
  {"name": "负一楼"},
  {"name": "万达木桶饭"}
];

// 初始化午餐功能
export function initLunch() {
  if (!appState.lunch_places || appState.lunch_places.length === 0) {
    appState.lunch_places = DEFAULT_LUNCH_PLACES;
    console.log("已加载默认午餐地点");
  }
  updateLunchUIState();
}

// 加载默认 T-2 规则
async function loadDefaultT2Rules() {
  try {
    const response = await fetch(chrome.runtime.getURL('rules/t2_rules_default.json'));
    if (response.ok) {
      const rules = await response.json();
      appState.t2_default_rules = rules;
      console.log('默认 T-2 规则加载成功:', rules);
    } else {
      console.error('加载默认 T-2 规则失败:', response.statusText);
    }
  } catch (error) {
    console.error('加载默认 T-2 规则出错:', error);
  }
}


export function getDomain(currentTabUrl){
  
    if (currentTabUrl) {
      if (currentTabUrl.includes(".lightning.force.com")) {
        return currentTabUrl.split(".lightning.force.com")[0] + ".my.salesforce.com"
      } else if (currentTabUrl.includes(".my.salesforce.com")) {
        return currentTabUrl.split(".my.salesforce.com")[0] + ".my.salesforce.com"
      }
    }
}

// 自动检测Session
export async function autoDetectSession() {
  // 加载默认规则
  loadDefaultT2Rules();

  if (appState.is_connected) return;

  try {
    console.log("开始自动检测Salesforce Session...");
    const tabs = await chrome.tabs.query({
      url: [
        "https://*.salesforce.com/*",
        "https://*.force.com/*",
        "https://*.salesforce-setup.com/*",
      ],
    });
    
    if (tabs.length > 0) {
      console.log(`找到 ${tabs.length} 个Salesforce标签页`);
      
      const processedDomains = new Set();

      for (const tab of tabs) {
        try {
          // 获取 instanceUrl
          const url = new URL(tab.url);
          const instanceUrl = url.origin;
          const hostname = url.hostname;

          // 提取核心域名标识
          // 例如: here2serve--vlocity-cmt.vf.force.com -> here2serve
          //       here2serve.my.salesforce.com -> here2serve
          let domainKey = hostname;
          if (hostname.includes('--')) {
            domainKey = hostname.split('--')[0];
          } else {
            domainKey = hostname.split('.')[0];
          }

          // 如果该域名已经检测过，则跳过
          if (processedDomains.has(domainKey)) {
            console.log(`Domain Key ${domainKey} (from ${instanceUrl}) 已经检测过，跳过`);
            continue;
          }
          processedDomains.add(domainKey);

          // 尝试从cookie获取session id
          const cookies = await chrome.cookies.getAll({ url: getDomain(tab.url), name: "sid" });
          console.log("Cookies:", cookies);
          if (cookies.length > 0) {
            const sid = cookies[0].value.split("!")[1];
            console.log("从Cookie中找到Session ID");
            console.log("Session ID:", sid);
            console.log("Instance URL:", instanceUrl);

            // 尝试连接
            const isConnected = await sfConn.testConnection(sid, instanceUrl);
            
            if (isConnected) {
              console.log("自动连接成功");
              appState.session_id = sid;
              appState.is_connected = true;
              localStorage.setItem("sf_session_id", sid);
              
              // 获取用户信息和组织信息
              await fetchUserInfo();
              await fetchOrgInfo();
              // await fetchLTSAccountCount();
              
              updateUIState();
              showSection(5);
              showNotification("已自动连接到Salesforce");
              return;
            }
          }
        } catch (err) {
          console.error("处理标签页时出错:", err);
        }
      }
    } else {
      console.log("未找到Salesforce标签页");
    }

    // 如果上面的逻辑没有成功连接，且有保存的 Session ID，尝试使用保存的 Session ID
    if (!appState.is_connected && appState.session_id) {
      console.log("尝试使用保存的 Session ID 连接...");
      const isConnected = await sfConn.testConnection(appState.session_id);
      
      if (isConnected) {
        console.log("使用保存的 Session ID 连接成功");
        appState.is_connected = true;
        
        // 获取用户信息和组织信息
        await fetchUserInfo();
        await fetchOrgInfo();
        
        updateUIState();
        showSection(5);
        showNotification("已自动连接到Salesforce (使用保存的Session)");
        return;
      } else {
        console.log("使用保存的 Session ID 连接失败");
      }
    }
  } catch (error) {
    console.error("自动检测Session失败:", error);
  }
}

// 获取用户信息
export async function fetchUserInfo() {
  try {
    if (appState.is_connected && sfConn.connection) {
      const result = await sfConn.getUserInfo();
      console.log('获取用户信息成功:', result);
      if (result.success) {
        const userInfo = result.userInfo;
        // 更新应用状态
        appState.userInfo = {
          username: userInfo.username || userInfo.user_id || '',
          email: userInfo.email || '',
          fullName: userInfo.display_name || userInfo.name || ''
        };
        // 更新UI
        // updateUserInfo(); // updateUIState 会调用
      }
    }
  } catch (error) {
    console.error('获取用户信息失败:', error);
  }
}

// 获取组织信息
export async function fetchOrgInfo() {
  try {
    if (appState.is_connected && sfConn.connection) {
      const result = await sfConn.getOrgInfo();
      console.log('获取组织信息成功:', result);
      if (result.success) {
        appState.orgInfo = result.orgInfo;
        // updateUserInfo(); // updateUIState 会调用
      }
    }
  } catch (error) {
    console.error('获取组织信息失败:', error);
  }
}

export async function getReportData() {
  try {
    console.log("开始获取报表数据");

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
        console.log("应用状态已更新");

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
        // 不再强制跳转到步骤5，保持在当前步骤
        showNotification(`报表数据获取成功，共 ${appState.stats.reportRecords} 条记录`);
        console.log("报表数据获取成功");
    }
  } catch (error) {
    console.error("获取报表数据失败:", error);
    showNotification("获取报表数据失败，请稍后重试", "error");

    // 隐藏loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "none";
      loadingMask.querySelector("h3").textContent = "正在从Salesforce获取数据...";
    }
    console.log("获取报表数据失败，已显示错误通知");
  }
}

export async function getT2Data() {
  try {
    console.log("开始获取T-2数据");

    // 获取用户输入的天数
    const daysInput = document.getElementById("t2-days-input");
    const customDays = daysInput ? daysInput.value : null;

    // 使用sfConn对象获取T-2数据
    const result = await sfConn.getT2Data(customDays);
    
    if (result.success) {
        // 更新应用状态
        appState.has_t2_data = true;
        // 保存数据到应用状态，以便后续导出
        appState.t2_data = result.data;
        // 更新统计数据
        appState.stats.t2Records = result.data?.length || 0;
        // 不再强制跳转步骤，保持在当前步骤
        console.log("应用状态已更新");

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
        showNotification(`T-2数据获取成功，共 ${appState.stats.t2Records} 条记录`);
        console.log("T-2数据获取成功");
    }
  } catch (error) {
    console.error("获取T-2数据失败:", error);
    showNotification("获取T-2数据失败，请稍后重试", "error");

    // 隐藏loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "none";
      loadingMask.querySelector("h3").textContent = "正在从Salesforce获取数据...";
    }
    console.log("获取T-2数据失败，已显示错误通知");
  }
}

export async function getSalesforceData() {
  try {
    console.log("开始获取最新Salesforce数据");

    // 使用sfConn对象获取Salesforce数据
    const result = await sfConn.getSFData(appState.order_numbers, (count) => {
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
          recordCountSpan.textContent = result.salesforceData.length;
          console.log("已更新UI记录数显示");
        }

        // 更新统计数据
        appState.stats.fetchedData = result.salesforceData.length;
        updateStats();

        // 保存数据到应用状态
        appState.latest_data = result.salesforceData;

        // 隐藏loading mask
        const loadingMask = document.getElementById("loading-mask");
        if (loadingMask) {
          loadingMask.style.display = "none";
          console.log("已隐藏loading mask");
        }

        // 显示数据
        renderLatestData(result.salesforceData);

        // 显示导出按钮
        const exportBtn = document.getElementById("export-latest-data");
        if (exportBtn) {
          exportBtn.style.display = "inline-block";
        }

        showNotification(`最新数据获取成功，共 ${result.salesforceData.length} 条记录`);
    }
  } catch (error) {
    console.error("获取Salesforce数据失败:", error);
    showNotification(
      "获取Salesforce数据失败，请检查Session ID和网络连接",
      "error"
    );

    // 隐藏loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "none";
    }
    console.log("获取数据失败，已显示错误通知");
  }
}

export async function getDailyData() {
  try {
    console.log("开始获取当日数据");

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
      
      console.log(`使用自定义日期范围: ${startDate} 到 ${endDate}`);
    }

    // 使用sfConn对象获取当日数据
    const result = await sfConn.getDailyData(startDate, endDate);
    console.log("获取当日数据结果:", result);

    if (result.success) {
        // 更新应用状态
        appState.has_daily_data = true;
        // 保存数据到应用状态，以便后续导出
        appState.daily_data = result.data;
        // 更新统计数据
        appState.stats.dailyOrders = result.data.length;
        // 不再强制跳转步骤，保持在当前步骤
        console.log("应用状态已更新");

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
        showNotification(`当日数据获取成功，共 ${result.data.length} 个订单`);
        console.log("当日数据获取成功");
    } else {
      showNotification(`获取当日数据失败: ${result.error}`, "error");
    }
  } catch (error) {
    console.error("获取当日数据失败:", error);
    showNotification("获取当日数据失败，请稍后重试", "error");

    // 隐藏loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "none";
      loadingMask.querySelector("h3").textContent =
        "正在从Salesforce获取数据...";
    }
    console.log("获取当日数据失败，已显示错误通知");
  }
}

export async function getPCDDailyData() {
  try {
    console.log("开始获取 PCD 当日数据");

    // 获取自定义日期参数
    let startDate = null;
    let endDate = null;
    const customDateCheckbox = document.getElementById("pcd-daily-custom-date-checkbox");
    
    if (customDateCheckbox && customDateCheckbox.checked) {
      const startDateInput = document.getElementById("pcd-daily-start-date");
      const endDateInput = document.getElementById("pcd-daily-end-date");
      
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
      
      console.log(`使用自定义日期范围: ${startDate} 到 ${endDate}`);
    }

    // 使用sfConn对象获取 PCD 当日数据
    const result = await sfConn.getPCDDailyData(startDate, endDate);
    console.log("获取 PCD 当日数据结果:", result);

    if (result.success) {
        // 更新应用状态
        appState.has_pcd_daily_data = true;
        // 保存数据到应用状态，以便后续导出
        appState.pcd_daily_data = result.data;
        // 更新统计数据
        appState.stats.pcdDailyOrders = result.data.length;
        // 不再强制跳转步骤，保持在当前步骤
        console.log("应用状态已更新");

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
        
        showNotification(`PCD 当日数据获取成功，共 ${result.data.length} 个订单`);
        console.log("PCD 当日数据获取成功");
    } else {
      showNotification(`获取 PCD 当日数据失败: ${result.error}`, "error");
      // 隐藏loading mask
      const loadingMask = document.getElementById("loading-mask");
      if (loadingMask) {
        loadingMask.style.display = "none";
      }
    }
  } catch (error) {
    console.error("获取 PCD 当日数据失败:", error);
    showNotification("获取 PCD 当日数据失败，请稍后重试", "error");

    // 隐藏loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "none";
      loadingMask.querySelector("h3").textContent =
        "正在从Salesforce获取数据...";
    }
    console.log("获取 PCD 当日数据失败，已显示错误通知");
  }
}

// 导出当日数据
export function exportDailyData() {
  exportToExcel(appState.daily_data, "当日数据", "当日数据");
}

// 导出 PCD 当日数据
export function exportPCDDailyData() {
  exportToExcel(appState.pcd_daily_data, "PCD当日数据", "PCD当日数据");
}

// 导出报表数据
export function exportReportData() {
  exportToExcel(appState.report_data, "报表数据", "报表数据");
}

// 导出T-2数据
export function exportT2Data() {
  exportToExcel(appState.t2_data, "T-2数据", "T-2数据");
}

// 导出最新数据
export function exportLatestData() {
  exportToExcel(appState.latest_data, "最新数据", "最新数据");
}

// 导出VVIP数据
export function exportVVIPData() {
  exportToExcel(appState.vvip_data, "VVIP数据", "VVIP数据");
}

// 导出数据分析数据
export function exportAnalysisData() {
  exportToExcel(appState.analysis_data, "数据分析结果", "数据分析");
}

// 导出T-2分析数据
export function exportT2AnalysisData() {
  exportToExcel(appState.t2_analysis_data, "T-2分析结果", "T-2分析");
}

// 处理Excel文件
export function processExcelFile(file) {
  if (!file) return;
  
  // 更新UI
  updateFileUploadUI(file);

  // 显示loading mask
  const loadingMask = document.getElementById("loading-mask");
  const recordCountSpan = document.getElementById("record-count");

  if (loadingMask && recordCountSpan) {
    loadingMask.style.display = "flex";
    loadingMask.querySelector("h3").textContent = "正在处理Excel文件...";
    recordCountSpan.textContent = "0";
  }

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
      console.log("应用状态已更新");

      updateUIState();
      // 更新统计数据
      updateStats();
      // 不再强制跳转到步骤4，保持在当前步骤
      showNotification(
        `文件已成功上传，共读取到 ${orderNumbers.length} 个唯一的订单号`
      );
      
      // 显示"显示最新数据"按钮
      const getLatestDataBtn = document.getElementById("get-latest-data-btn");
      if (getLatestDataBtn) {
        getLatestDataBtn.style.display = "inline-block";
      }

      console.log("文件上传处理完成");
    },
    (error) => {
      // 失败回调
      // 隐藏loading mask
      if (loadingMask) {
        loadingMask.style.display = "none";
      }
      console.error("处理Excel文件失败:", error);
    }
  );
}

// 处理VVIP Excel文件
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
      
      console.log("应用状态已更新");

      updateUIState();
      // 更新统计数据
      updateStats();
      
      showNotification(
        `文件已成功上传，共读取到 ${pcdIds.length} 个 PCD ID 和 ${ltsIds.length} 个 LTS ID`
      );
      
      // 显示"获取 PCD/LTS 状态"按钮
      const getVVIPDataBtn = document.getElementById("get-vvip-data-btn");
      if (getVVIPDataBtn) {
        getVVIPDataBtn.style.display = "inline-block";
      }

      console.log("VVIP文件上传处理完成");
    },
    (error) => {
      // 失败回调
      // 隐藏loading mask
      if (loadingMask) {
        loadingMask.style.display = "none";
      }
      console.error("处理VVIP Excel文件失败:", error);
    }
  );
}

// 处理数据分析 Excel 文件
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
      
      console.log("应用状态已更新");

      updateUIState();
      // 更新统计数据
      updateStats();
      
      showNotification(
        `文件已成功上传，共读取到 ${data.length} 条记录`
      );
      
      // 自动渲染数据
      renderAnalysisData(data);

      console.log("数据分析文件上传处理完成");
    },
    (error) => {
      // 失败回调
      // 隐藏loading mask
      if (loadingMask) {
        loadingMask.style.display = "none";
      }
      console.error("处理数据分析 Excel 文件失败:", error);
    }
  );
}

export async function getVVIPData() {
  try {
    console.log("开始获取VVIP数据");

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
          console.log("已更新UI记录数显示");
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
          console.log("已隐藏loading mask");
        }

        // 显示数据
        renderVVIPData(result.data);

        // 显示导出按钮
        const exportBtn = document.getElementById("export-vvip-data");
        if (exportBtn) {
          exportBtn.style.display = "inline-block";
        }

        showNotification(`VVIP数据获取成功，共 ${result.data.length} 条记录`);
    }
  } catch (error) {
    console.error("获取VVIP数据失败:", error);
    showNotification(
      "获取VVIP数据失败，请检查Session ID和网络连接",
      "error"
    );

    // 隐藏loading mask
    const loadingMask = document.getElementById("loading-mask");
    if (loadingMask) {
      loadingMask.style.display = "none";
    }
    console.log("获取VVIP数据失败，已显示错误通知");
  }
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
        console.error("数据分析失败:", error);
        showNotification("数据分析失败: " + error.message, "error");
    } finally {
        // 隐藏 loading mask
        if (loadingMask) {
        loadingMask.style.display = "none";
        }
    }
    }, 100);
}

// 处理 T-2 分析 Excel 文件
export function processT2AnalysisExcelFile(file) {
  if (!file) return;
  
  // 更新UI
  updateT2AnalysisFileUploadUI(file);

  // 显示loading mask
  const loadingMask = document.getElementById("loading-mask");
  const recordCountSpan = document.getElementById("record-count");

  if (loadingMask && recordCountSpan) {
    loadingMask.style.display = "flex";
    loadingMask.querySelector("h3").textContent = "正在读取 T-2 分析文件...";
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
      console.error("处理 T-2 分析 Excel 文件失败:", error);
      showNotification("处理文件失败: " + error, "error");
    });
}

// 处理 T-2 Sheet 选择
function handleT2SheetSelection(sheetName) {
  if (!appState.t2_workbook) return;

  console.log(`正在切换到工作表: ${sheetName}`);
  
  // 解析选中 Sheet 的数据
  const data = parseSheetData(appState.t2_workbook, sheetName);
  
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
  );
  
  // 自动渲染数据
  renderT2AnalysisData(data);
}

// 处理 T-2 规则 JSON 文件
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
      console.error("解析规则文件失败:", error);
      showNotification("解析规则文件失败: " + error.message, "error");
    }
  };
  reader.readAsText(file);
}

export function analyzeT2Data() {
    // 检查是否有T-2数据 (来自文件或Salesforce)
    let dataToAnalyze = null;
    
    if (appState.has_t2_analysis_file && appState.t2_analysis_data && appState.t2_analysis_data.length > 0) {
        // 优先使用上传的文件数据
        dataToAnalyze = appState.t2_analysis_data;
    } else if (appState.has_t2_data && appState.t2_data && appState.t2_data.length > 0) {
        // 其次使用从Salesforce获取的数据
        dataToAnalyze = appState.t2_data;
    }

    if (!dataToAnalyze) {
        showNotification("请先上传 Excel 文件或获取 T-2 Outstanding 数据", "warning");
        return;
    }

    // 显示loading mask
    const loadingMask = document.getElementById("loading-mask");
    const recordCountSpan = document.getElementById("record-count");

    if (loadingMask && recordCountSpan) {
        loadingMask.style.display = "flex";
        loadingMask.querySelector("h3").textContent = "正在分析 T-2 数据...";
        recordCountSpan.textContent = dataToAnalyze.length;
    }

    // 使用 setTimeout 让 UI 有机会渲染 loading mask
    setTimeout(async () => {
        try {
            // 执行分析
            // 使用硬编码的 T-2 规则 (applyT2Rules)
            console.log("使用 applyT2Rules 进行分析...");
            const analyzedData = applyT2Rules(dataToAnalyze);
            
            // 更新应用状态
            appState.t2_analysis_data = analyzedData;
            
            // 重新渲染表格和图表
            renderT2AnalysisData(analyzedData);
            
            // 更新UI状态 (显示导出按钮等)
            updateUIState();
            
            showNotification("T-2 数据分析完成", "success");
        } catch (error) {
            console.error("T-2 数据分析失败:", error);
            showNotification("T-2 数据分析失败: " + error.message, "error");
        } finally {
            // 隐藏 loading mask
            if (loadingMask) {
                loadingMask.style.display = "none";
            }
        }
    }, 100);
}

// 处理午餐地点文件
export function processLunchFile(file) {
  if (!file) return;

  if (!file.name.endsWith(".json")) {
    showNotification("请上传 JSON 格式的文件", "error");
    return;
  }

  updateLunchFileUploadUI(file);

  const reader = new FileReader();
  reader.onload = function(e) {
    try {
      const places = JSON.parse(e.target.result);
      if (Array.isArray(places)) {
        appState.lunch_places = places;
        appState.has_lunch_file = true;
        showNotification(`成功加载 ${places.length} 个地点`, "success");
        
        // 更新UI
        updateLunchUIState();
      } else {
        showNotification("文件格式错误：应为地点数组", "error");
      }
    } catch (error) {
      console.error("解析午餐文件失败:", error);
      showNotification("解析文件失败: " + error.message, "error");
    }
  };
  reader.readAsText(file);
}

// 摇一摇选择午餐
export function shakeLunch() {
    // 确保有数据
    if (!appState.lunch_places || appState.lunch_places.length === 0) {
        initLunch();
    }

    // 简单的随机选择动画效果
    const container = document.getElementById("lunch-result-container");
    if (container) {
        container.innerHTML = '<div style="text-align: center; font-size: 24px; color: #faad14;"><i class="fas fa-spinner fa-spin"></i> 正在选...</div>';
        container.style.display = 'block';
    }

    setTimeout(() => {
        const randomIndex = Math.floor(Math.random() * appState.lunch_places.length);
        const selectedPlace = appState.lunch_places[randomIndex];
        showLunchResult(selectedPlace);
    }, 800);
}