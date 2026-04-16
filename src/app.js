import { sfConn } from "./biz/sf_service.js";
import { showNotification } from "./common/utils.js";
import { replaceIcons, Icons } from "./common/icons.js";
import { appState } from "./biz/state.js";
import {
  showSection,
  updateUIState,
  renderRulesList,
  moveRule,
  moveRuleTo,
  renderMarkdownContent,
  showBulkJobsLoading,
  updateHorizontalTabs,
  initHorizontalTabsEvents,
  submenuConfig,
  renderScheduleJobsData
} from "./biz/ui.js";
import { 
  fetchUserInfo,
  fetchOrgInfo,
  getReportData,
  getSalesforceData,
  getDailyData,
  getPCDDailyData,
  getPCDPIDFalloutData,
  getPCDQCIssueData,
  getT2Data,
  exportDailyData,
  exportPCDDailyData,
  exportPCDPIDFalloutData,
  exportPCDQCIssueData,
  exportReportData,
  exportT2Data,
  exportLatestData,
  exportVVIPData,
  exportAnalysisData,
  processExcelFile,
  processVVIPExcelFile,
  processAnalysisExcelFile,
  getVVIPData,
  analyzeData,
  analyzeT2Data,
  exportT2AnalysisData,
  processT2AnalysisExcelFile,
  processT2RulesFile,
  processLunchFile,
  shakeLunch,
  initLunch,
  handleCreateBulkJob,
  handleCheckBulkJob,
  handleDownloadBulkResult,
  executeAnonymousCode,
  loadScheduleJobs,
  createScheduleJob,
  deleteScheduleJob,
  pauseScheduleJob,
  resumeScheduleJob,
  clearAllScheduleJobs
} from "./biz/logic.js";

// 验证保存的 session 是否仍然有效
async function validateStoredSession() {
  if (!appState.session_id || !appState.instance_url) {
    return false;
  }
  
  try {
    const isConnected = await sfConn.testConnection(appState.session_id, appState.instance_url);
    return isConnected;
  } catch (e) {
    console.warn('Session 验证失败:', e);
    return false;
  }
}

// 初始化应用
async function initApp() {
  // 从 chrome.storage.local 读取登录状态
  try {
    const stored = await chrome.storage.local.get([
      'sf_session_id',
      'sf_instance_url',
      'is_connected',
      'userInfo',
      'orgInfo'
    ]);
    
    // 如果有保存的登录状态，初始化 appState
    if (stored.sf_session_id) {
      appState.session_id = stored.sf_session_id;
      localStorage.setItem('sf_session_id', stored.sf_session_id);
    }
    if (stored.sf_instance_url) {
      appState.instance_url = stored.sf_instance_url;
      localStorage.setItem('sf_instance_url', stored.sf_instance_url);
    }
    if (stored.is_connected === true) {
      appState.is_connected = true;
    }
    if (stored.userInfo) {
      appState.userInfo = stored.userInfo;
    }
    if (stored.orgInfo) {
      appState.orgInfo = stored.orgInfo;
    }
  } catch (e) {
    console.warn('从 chrome.storage.local 读取登录状态失败:', e);
  }

  // 如果之前已连接，验证 session 是否仍然有效
  if (appState.is_connected && appState.session_id && appState.instance_url) {
    const isValid = await validateStoredSession();
    if (!isValid) {
      console.log('保存的 session 已过期或无效，打开登录页面...');
      // 清除过期的 session 信息
      appState.is_connected = false;
      appState.session_id = null;
      appState.instance_url = null;
      localStorage.removeItem('sf_session_id');
      localStorage.removeItem('sf_instance_url');
      await chrome.storage.local.remove(['sf_session_id', 'sf_instance_url', 'is_connected', 'userInfo', 'orgInfo']);
      
      // 打开 login.html 页面重新登录
      chrome.tabs.create({
        url: chrome.runtime.getURL('login.html')
      });
      return; // 停止初始化，等待用户重新登录
    }
  }

  // 替换图标
  replaceIcons();

  // 初始化午餐功能
  initLunch();
  
  // 初始化横向菜单栏点击事件
  initHorizontalTabsEvents();

  // 更新UI状态
  updateUIState();

  // 显示初始section - autoDetectSession 内部已经处理了多session选择页面的显示
  // 如果 available_sessions 存在且长度大于1，说明正在显示选择页面，不需要再次调用 showSection
  // 如果 is_connected 为 true，说明已经自动连接成功
  // 否则显示默认的连接设置页面
  if (!appState.available_sessions || appState.available_sessions.length <= 1) {
    if (appState.is_connected) {
      showSection(5); // 连接成功后默认显示 LTS 概览
    } else {
      showSection(1); // 默认显示连接设置
    }
  }

  // 绑定事件
  bindEvents();
}

// 绑定事件
function bindEvents() {
  // Session ID表单提交
  document
    .getElementById("session-id-form")
    .addEventListener("submit", function (e) {
      e.preventDefault();
      const sessionId = document.getElementById("session_id").value.trim();

      if (sessionId) {
        appState.session_id = sessionId;
        localStorage.setItem("sf_session_id", sessionId);
        updateUIState();
        showNotification("Session ID已成功保存");

        // 自动触发连接测试
        const testConnectionForm = document.getElementById("test-connection-form");
        if (testConnectionForm) {
          testConnectionForm.dispatchEvent(new Event('submit'));
        }
      } else {
        showNotification("请输入Session ID", "error");
      }
    });

  // 测试连接表单提交
  document
    .getElementById("test-connection-form")
    .addEventListener("submit", async function (e) {
      e.preventDefault();
      const statusElement = document.getElementById("connection-status");
      const successElement = document.getElementById("connection-success");
      const errorElement = document.getElementById("connection-error");
      const infoElement = document.getElementById("connection-info");

      statusElement.innerHTML =
        `${Icons.spinner} 正在测试连接...`;
      statusElement.style.color = "var(--warning-color)";

      try {
        // 测试Salesforce连接
        const isConnected = await sfConn.testConnection(appState.session_id, appState.instance_url);
        if (isConnected) {
          // 连接成功
          appState.is_connected = true;

          statusElement.innerHTML =
            `${Icons.checkCircle} 连接成功`;
          statusElement.style.color = "#52c41a"; // Ant Design success color
          successElement.style.display = "flex";
          errorElement.style.display = "none";
          infoElement.style.display = "none";
          console.log("获取用户信息");
          // 获取用户信息
          await fetchUserInfo();
          // 获取组织信息
          await fetchOrgInfo();
          // // 获取 LTS Account 数量
          // await fetchLTSAccountCount();

          // 更新UI状态
          updateUIState();
          
          showSection(5);
          showNotification("Salesforce连接成功");
        } else {
          // 连接失败
          throw new Error("Connection failed");
        }
      } catch (error) {
        // 连接失败
        appState.is_connected = false;

        statusElement.innerHTML =
          `${Icons.timesCircle} 连接失败`;
        statusElement.style.color = "#ff4d4f"; // Ant Design error color
        successElement.style.display = "none";
        errorElement.style.display = "flex";
        infoElement.style.display = "block";
        showNotification(
          "Salesforce连接失败，请检查Session ID是否正确",
          "error"
        );

        // 更新UI状态，确保后续步骤被禁用
        updateUIState();
      }
    });

  // 获取当日数据表单提交
  document
    .getElementById("daily-data-form")
    .addEventListener("submit", function (e) {
      e.preventDefault();

      // 显示loading mask
      const loadingMask = document.getElementById("loading-mask");
      const recordCountSpan = document.getElementById("record-count");

      if (loadingMask && recordCountSpan) {
        loadingMask.style.display = "flex";
        loadingMask.querySelector("h3").textContent = "正在获取当日数据...";
        recordCountSpan.textContent = "0";
      }

      // 获取当日数据
      getDailyData();
    });

  // 获取 PCD 当日数据表单提交
  document
    .getElementById("pcd-daily-data-form")
    .addEventListener("submit", function (e) {
      e.preventDefault();

      // 显示loading mask
      const loadingMask = document.getElementById("loading-mask");
      const recordCountSpan = document.getElementById("record-count");

      if (loadingMask && recordCountSpan) {
        loadingMask.style.display = "flex";
        loadingMask.querySelector("h3").textContent = "正在获取 PCD 当日数据...";
        recordCountSpan.textContent = "0";
      }

      // 获取 PCD 当日数据
      getPCDDailyData();
    });

  // 获取 PCD PID Fallout 数据表单提交
  document
    .getElementById("pcd-pid-fallout-data-form")
    .addEventListener("submit", function (e) {
      e.preventDefault();

      // 显示loading mask
      const loadingMask = document.getElementById("loading-mask");
      const recordCountSpan = document.getElementById("record-count");

      if (loadingMask && recordCountSpan) {
        loadingMask.style.display = "flex";
        loadingMask.querySelector("h3").textContent = "正在获取 PCD PID Fallout 数据...";
        recordCountSpan.textContent = "0";
      }

      // 获取 PCD PID Fallout 数据
      getPCDPIDFalloutData();
    });

  // 获取 PCD QC Issue 数据表单提交
  document
    .getElementById("pcd-qc-issue-data-form")
    .addEventListener("submit", function (e) {
      e.preventDefault();

      // 显示loading mask
      const loadingMask = document.getElementById("loading-mask");
      const recordCountSpan = document.getElementById("record-count");

      if (loadingMask && recordCountSpan) {
        loadingMask.style.display = "flex";
        loadingMask.querySelector("h3").textContent = "正在获取 PCD QC Issue 数据...";
        recordCountSpan.textContent = "0";
      }

      // 获取 PCD QC Issue 数据
      getPCDQCIssueData();
    });

  // 自定义日期复选框变化事件
  const dailyCustomDateCheckbox = document.getElementById("daily-custom-date-checkbox");
  if (dailyCustomDateCheckbox) {
    dailyCustomDateCheckbox.addEventListener("change", function(e) {
      const container = document.getElementById("daily-custom-date-container");
      if (container) {
        container.style.display = e.target.checked ? "block" : "none";
      }
    });
  }

  // PCD 自定义日期复选框变化事件
  const pcdDailyCustomDateCheckbox = document.getElementById("pcd-daily-custom-date-checkbox");
  if (pcdDailyCustomDateCheckbox) {
    pcdDailyCustomDateCheckbox.addEventListener("change", function(e) {
      const container = document.getElementById("pcd-daily-custom-date-container");
      if (container) {
        container.style.display = e.target.checked ? "block" : "none";
      }
    });
  }

  // 获取报表数据表单提交
  document
    .getElementById("report-data-form")
    .addEventListener("submit", function (e) {
      e.preventDefault();

      // 显示loading mask
      const loadingMask = document.getElementById("loading-mask");
      const recordCountSpan = document.getElementById("record-count");

      if (loadingMask && recordCountSpan) {
        loadingMask.style.display = "flex";
        loadingMask.querySelector("h3").textContent = "正在获取报表数据...";
        recordCountSpan.textContent = "0";
      }

      // 获取报表数据
      getReportData();
    });

  // 获取T-4数据表单提交
  document
    .getElementById("t2-data-form")
    .addEventListener("submit", function (e) {
      e.preventDefault();

      // 显示loading mask
      const loadingMask = document.getElementById("loading-mask");
      const recordCountSpan = document.getElementById("record-count");

      if (loadingMask && recordCountSpan) {
        loadingMask.style.display = "flex";
        loadingMask.querySelector("h3").textContent = "正在获取T-4数据...";
        recordCountSpan.textContent = "0";
      }

      // 获取T-4数据
      getT2Data();
    });

    // 文件上传表单提交
  document
    .getElementById("file-upload-form")
    .addEventListener("submit", function (e) {
      e.preventDefault();
      const fileInput = document.getElementById("file");
      const file = fileInput.files[0];

      processExcelFile(file);
    });

  // VVIP文件上传表单提交
  document
    .getElementById("vvip-file-upload-form")
    .addEventListener("submit", function (e) {
      e.preventDefault();
      const fileInput = document.getElementById("vvip-file");
      const file = fileInput.files[0];

      processVVIPExcelFile(file);
    });

  // 数据分析文件上传表单提交
  document
    .getElementById("analysis-file-upload-form")
    .addEventListener("submit", function (e) {
      e.preventDefault();
      const fileInput = document.getElementById("analysis-file");
      const file = fileInput.files[0];

      processAnalysisExcelFile(file);
    });

  // T-4 分析文件上传表单提交
  document
    .getElementById("t2-analysis-file-upload-form")
    .addEventListener("submit", function (e) {
      e.preventDefault();
      const fileInput = document.getElementById("t2-analysis-file");
      const file = fileInput.files[0];

      processT2AnalysisExcelFile(file);
    });



  // 设置和版本信息等普通菜单项点击事件
  const stepLinks = document.querySelectorAll(".step-link");
  stepLinks.forEach((link) => {
    link.addEventListener("click", function (e) {
      e.preventDefault();
      const sectionNumber = parseInt(this.getAttribute("data-step"));
      // showSection 内部已有连接状态检查
      showSection(sectionNumber);
    });
  });

  // 主菜单点击事件 - 点击侧边栏主菜单时更新横向菜单栏
  const navItems = document.querySelectorAll(".sidebar > .sidebar-nav > .nav-section > .nav-list > .nav-item[data-module]");
  navItems.forEach((item) => {
    item.addEventListener("click", function (e) {
      const module = this.getAttribute("data-module");
      if (module && submenuConfig[module]) {
        // 更新横向菜单栏
        updateHorizontalTabs(module);
      }
    });
  });

  // 子菜单切换事件 - 处理 Tools 等可展开的子菜单
  const submenuToggles = document.querySelectorAll(".submenu-toggle");
  submenuToggles.forEach((toggle) => {
    toggle.addEventListener("click", function (e) {
      e.preventDefault();
      const parentItem = this.closest(".nav-item");
      if (parentItem) {
        parentItem.classList.toggle("open");
        
        // 如果是子菜单展开，也更新横向菜单栏
        const module = parentItem.getAttribute("data-module");
        if (module && parentItem.classList.contains("open") && submenuConfig[module]) {
          updateHorizontalTabs(module);
        }
      }
    });
  });
  
  // 侧边栏切换事件
  const sidebarTrigger = document.getElementById("sidebar-trigger");
  if (sidebarTrigger) {
    sidebarTrigger.addEventListener("click", function () {
      const sidebar = document.querySelector(".sidebar");
      if (sidebar) {
        sidebar.classList.toggle("collapsed");
        // 触发 resize 事件以调整 Handsontable
        window.dispatchEvent(new Event('resize'));
      }
    });
  }
  
  // 导出当日数据按钮点击事件
  const exportDailyDataBtn = document.getElementById("export-daily-data");
  if (exportDailyDataBtn) {
    exportDailyDataBtn.addEventListener("click", exportDailyData);
  }

  // 导出 PCD 当日数据按钮点击事件
  const exportPCDDailyDataBtn = document.getElementById("export-pcd-daily-data");
  if (exportPCDDailyDataBtn) {
    exportPCDDailyDataBtn.addEventListener("click", exportPCDDailyData);
  }

  // 导出 PCD PID Fallout 数据按钮点击事件
  const exportPCDPIDFalloutDataBtn = document.getElementById("export-pcd-pid-fallout-data");
  if (exportPCDPIDFalloutDataBtn) {
    exportPCDPIDFalloutDataBtn.addEventListener("click", exportPCDPIDFalloutData);
  }

  // 导出 PCD QC Issue 数据按钮点击事件
  const exportPCDQCIssueDataBtn = document.getElementById("export-pcd-qc-issue-data");
  if (exportPCDQCIssueDataBtn) {
    exportPCDQCIssueDataBtn.addEventListener("click", exportPCDQCIssueData);
  }

  // 导出报表数据按钮点击事件
  const exportReportDataBtn = document.getElementById("export-report-data");
  if (exportReportDataBtn) {
    exportReportDataBtn.addEventListener("click", exportReportData);
  }

  // 导出T-4数据按钮点击事件
  const exportT2DataBtn = document.getElementById("export-t2-data");
  if (exportT2DataBtn) {
    exportT2DataBtn.addEventListener("click", exportT2Data);
  }

  // 导出最新数据按钮点击事件
  const exportLatestDataBtn = document.getElementById("export-latest-data");
  if (exportLatestDataBtn) {
    exportLatestDataBtn.addEventListener("click", exportLatestData);
  }

  // 导出VVIP数据按钮点击事件
  const exportVVIPDataBtn = document.getElementById("export-vvip-data");
  if (exportVVIPDataBtn) {
    exportVVIPDataBtn.addEventListener("click", exportVVIPData);
  }

  // 导出数据分析数据按钮点击事件
  const exportAnalysisDataBtn = document.getElementById("export-analysis-data");
  if (exportAnalysisDataBtn) {
    exportAnalysisDataBtn.addEventListener("click", exportAnalysisData);
  }

  // "显示最新数据"按钮点击事件
  const getLatestDataBtn = document.getElementById("get-latest-data-btn");
  if (getLatestDataBtn) {
    getLatestDataBtn.addEventListener("click", function() {
      // 显示loading mask
      const loadingMask = document.getElementById("loading-mask");
      const recordCountSpan = document.getElementById("record-count");

      if (loadingMask && recordCountSpan) {
        loadingMask.style.display = "flex";
        loadingMask.querySelector("h3").textContent = "正在获取最新数据...";
        recordCountSpan.textContent = "0";
      }

      // 从Salesforce获取数据
      getSalesforceData();
    });
  }

  // "获取 PCD/LTS 状态"按钮点击事件
  const getVVIPDataBtn = document.getElementById("get-vvip-data-btn");
  if (getVVIPDataBtn) {
    getVVIPDataBtn.addEventListener("click", function() {
      // 显示loading mask
      const loadingMask = document.getElementById("loading-mask");
      const recordCountSpan = document.getElementById("record-count");

      if (loadingMask && recordCountSpan) {
        loadingMask.style.display = "flex";
        loadingMask.querySelector("h3").textContent = "正在获取VVIP数据...";
        recordCountSpan.textContent = "0";
      }

      // 从Salesforce获取数据
      getVVIPData();
    });
  }


  // "开始分析"按钮点击事件
  const analyzeDataBtn = document.getElementById("analyze-data-btn");
  if (analyzeDataBtn) {
    analyzeDataBtn.addEventListener("click", analyzeData);
  }

  // "T-4 开始分析"按钮点击事件
  const analyzeT2DataBtn = document.getElementById("analyze-t2-data-btn");
  if (analyzeT2DataBtn) {
    analyzeT2DataBtn.addEventListener("click", analyzeT2Data);
  }

  // 导出T-4分析数据按钮点击事件
  const exportT2AnalysisDataBtn = document.getElementById("export-t2-analysis-data");
  if (exportT2AnalysisDataBtn) {
    exportT2AnalysisDataBtn.addEventListener("click", exportT2AnalysisData);
  }

  // LTS MD 文件上传处理
  const ltsMdUpload = document.getElementById("lts-md-upload");
  if (ltsMdUpload) {
    ltsMdUpload.addEventListener("change", function(e) {
      if (this.files.length > 0) {
        const file = this.files[0];
        
        if (!file.name.endsWith(".md")) {
          showNotification("请上传Markdown文件(.md)", "error");
          this.value = ""; // 清空选择
          return;
        }

        const reader = new FileReader();
        reader.onload = function(e) {
          try {
            const content = e.target.result;
            const container = document.getElementById('lts-summary-content');
            if (container) {
              renderMarkdownContent(container, content);
              showNotification("LTS 概览已更新", "success");
            }
          } catch (error) {
            console.error("读取MD文件失败:", error);
            showNotification("读取文件失败", "error");
          }
        };
        reader.readAsText(file);
      }
    });
  }
  
  // 移动端侧边栏切换事件
  const sidebarToggleMobile = document.getElementById("sidebar-toggle-mobile");
  if (sidebarToggleMobile) {
    sidebarToggleMobile.addEventListener("click", function () {
      const sidebar = document.querySelector(".sidebar");
      if (sidebar) {
        sidebar.classList.toggle("open");
      }
    });
  }
  


  // 拖拽事件处理
  const fileUpload = document.querySelector(".file-upload");
  if (fileUpload) {
    // 拖拽进入
    fileUpload.addEventListener("dragover", function (e) {
      e.preventDefault();
      this.classList.add("dragover");
    });

    // 拖拽离开
    fileUpload.addEventListener("dragleave", function (e) {
      e.preventDefault();
      this.classList.remove("dragover");
    });

    // 拖拽结束
    fileUpload.addEventListener("dragend", function (e) {
      e.preventDefault();
      this.classList.remove("dragover");
    });

    // 释放文件
    fileUpload.addEventListener("drop", function (e) {
      e.preventDefault();
      this.classList.remove("dragover");

      // 获取文件
      if (e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        // 检查文件类型
        if (
          file.type ===
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
          file.name.endsWith(".xlsx")
        ) {
          // 设置文件到input元素
          const fileInput = this.querySelector('input[type="file"]');
          if (fileInput) {
            fileInput.files = e.dataTransfer.files;
            // 直接处理文件
            processExcelFile(file);
          }
        } else {
          showNotification("请上传Excel文件(.xlsx)", "error");
        }
      }
    });

    // 监听文件选择变化
    const fileInput = fileUpload.querySelector('input[type="file"]');
    if (fileInput) {
      fileInput.addEventListener("change", function(e) {
        if (this.files.length > 0) {
          const file = this.files[0];
          processExcelFile(file);
        }
      });
    }
  }

  // VVIP拖拽事件处理
  const vvipFileUpload = document.querySelector("#vvip-file-upload-form .file-upload");
  if (vvipFileUpload) {
    // 拖拽进入
    vvipFileUpload.addEventListener("dragover", function (e) {
      e.preventDefault();
      this.classList.add("dragover");
    });

    // 拖拽离开
    vvipFileUpload.addEventListener("dragleave", function (e) {
      e.preventDefault();
      this.classList.remove("dragover");
    });

    // 拖拽结束
    vvipFileUpload.addEventListener("dragend", function (e) {
      e.preventDefault();
      this.classList.remove("dragover");
    });

    // 释放文件
    vvipFileUpload.addEventListener("drop", function (e) {
      e.preventDefault();
      this.classList.remove("dragover");

      // 获取文件
      if (e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        // 检查文件类型
        if (
          file.type ===
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
          file.name.endsWith(".xlsx")
        ) {
          // 设置文件到input元素
          const fileInput = this.querySelector('input[type="file"]');
          if (fileInput) {
            fileInput.files = e.dataTransfer.files;
            // 直接处理文件
            processVVIPExcelFile(file);
          }
        } else {
          showNotification("请上传Excel文件(.xlsx)", "error");
        }
      }
    });

    // 监听文件选择变化
    const fileInput = vvipFileUpload.querySelector('input[type="file"]');
    if (fileInput) {
      fileInput.addEventListener("change", function(e) {
        if (this.files.length > 0) {
          const file = this.files[0];
          processVVIPExcelFile(file);
        }
      });
    }
  }

  // 数据分析拖拽事件处理
  const analysisFileUpload = document.querySelector("#analysis-file-upload-form .file-upload");
  if (analysisFileUpload) {
    // 拖拽进入
    analysisFileUpload.addEventListener("dragover", function (e) {
      e.preventDefault();
      this.classList.add("dragover");
    });

    // 拖拽离开
    analysisFileUpload.addEventListener("dragleave", function (e) {
      e.preventDefault();
      this.classList.remove("dragover");
    });

    // 拖拽结束
    analysisFileUpload.addEventListener("dragend", function (e) {
      e.preventDefault();
      this.classList.remove("dragover");
    });

    // 释放文件
    analysisFileUpload.addEventListener("drop", function (e) {
      e.preventDefault();
      this.classList.remove("dragover");

      // 获取文件
      if (e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        // 检查文件类型
        if (
          file.type ===
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
          file.name.endsWith(".xlsx")
        ) {
          // 设置文件到input元素
          const fileInput = this.querySelector('input[type="file"]');
          if (fileInput) {
            fileInput.files = e.dataTransfer.files;
            // 直接处理文件
            processAnalysisExcelFile(file);
          }
        } else {
          showNotification("请上传Excel文件(.xlsx)", "error");
        }
      }
    });

    // 监听文件选择变化
    const fileInput = analysisFileUpload.querySelector('input[type="file"]');
    if (fileInput) {
      fileInput.addEventListener("change", function(e) {
        if (this.files.length > 0) {
          const file = this.files[0];
          processAnalysisExcelFile(file);
        }
      });
    }
  }

  // T-4 分析文件拖拽事件处理
  const t2AnalysisFileUpload = document.querySelector("#t2-analysis-file-upload-form .file-upload");
  if (t2AnalysisFileUpload) {
    // 拖拽进入
    t2AnalysisFileUpload.addEventListener("dragover", function (e) {
      e.preventDefault();
      this.classList.add("dragover");
    });

    // 拖拽离开
    t2AnalysisFileUpload.addEventListener("dragleave", function (e) {
      e.preventDefault();
      this.classList.remove("dragover");
    });

    // 拖拽结束
    t2AnalysisFileUpload.addEventListener("dragend", function (e) {
      e.preventDefault();
      this.classList.remove("dragover");
    });

    // 释放文件
    t2AnalysisFileUpload.addEventListener("drop", function (e) {
      e.preventDefault();
      this.classList.remove("dragover");

      // 获取文件
      if (e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        // 检查文件类型
        if (
          file.type ===
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
          file.name.endsWith(".xlsx")
        ) {
          // 设置文件到input元素
          const fileInput = this.querySelector('input[type="file"]');
          if (fileInput) {
            fileInput.files = e.dataTransfer.files;
            // 直接处理文件
            processT2AnalysisExcelFile(file);
          }
        } else {
          showNotification("请上传Excel文件(.xlsx)", "error");
        }
      }
    });

    // 监听文件选择变化
    const fileInput = t2AnalysisFileUpload.querySelector('input[type="file"]');
    if (fileInput) {
      fileInput.addEventListener("change", function(e) {
        if (this.files.length > 0) {
          const file = this.files[0];
          processT2AnalysisExcelFile(file);
        }
      });
    }
  }

  // 规则文件上传处理
  const rulesFileInput = document.getElementById("rules-file");
  if (rulesFileInput) {
    rulesFileInput.addEventListener("change", function(e) {
      if (this.files.length > 0) {
        const file = this.files[0];
        
        if (!file.name.endsWith(".json")) {
          showNotification("请上传JSON格式的规则文件", "error");
          this.value = ""; // 清空选择
          return;
        }

        const reader = new FileReader();
        reader.onload = function(e) {
          try {
            const rules = JSON.parse(e.target.result);
            appState.custom_rules = rules;
            
            // 更新UI显示
            const infoDiv = document.getElementById("rules-file-info");
            const nameSpan = document.getElementById("rules-file-name");
            if (infoDiv && nameSpan) {
              nameSpan.textContent = `已加载规则: ${file.name}`;
              infoDiv.style.display = "flex";
            }
            
            // 渲染规则列表
            renderRulesList(rules);
            
            showNotification("规则文件加载成功", "success");
          } catch (error) {
            console.error("解析规则文件失败:", error);
            showNotification("解析规则文件失败，请检查JSON格式", "error");
            appState.custom_rules = null;
            
            // 清空规则列表
            const rulesListContainer = document.getElementById("rules-list-container");
            if (rulesListContainer) {
              rulesListContainer.style.display = "none";
            }
          }
        };
        reader.readAsText(file);
      }
    });
  }

  // T-4 规则文件上传处理
  const t2RulesFileInput = document.getElementById("t2-rules-file");
  if (t2RulesFileInput) {
    t2RulesFileInput.addEventListener("change", function(e) {
      if (this.files.length > 0) {
        const file = this.files[0];
        processT2RulesFile(file);
      }
    });
  }

  // 午餐文件上传处理
  const lunchFileInput = document.getElementById("lunch-file");
  if (lunchFileInput) {
    lunchFileInput.addEventListener("change", function(e) {
      if (this.files.length > 0) {
        processLunchFile(this.files[0]);
      }
    });
  }

  // 午餐文件拖拽事件处理
  const lunchFileUpload = document.querySelector("#lunch-file-upload-form .file-upload");
  if (lunchFileUpload) {
    // 拖拽进入
    lunchFileUpload.addEventListener("dragover", function (e) {
      e.preventDefault();
      this.classList.add("dragover");
    });

    // 拖拽离开
    lunchFileUpload.addEventListener("dragleave", function (e) {
      e.preventDefault();
      this.classList.remove("dragover");
    });

    // 拖拽结束
    lunchFileUpload.addEventListener("dragend", function (e) {
      e.preventDefault();
      this.classList.remove("dragover");
    });

    // 释放文件
    lunchFileUpload.addEventListener("drop", function (e) {
      e.preventDefault();
      this.classList.remove("dragover");

      // 获取文件
      if (e.dataTransfer.files.length > 0) {
        const file = e.dataTransfer.files[0];
        // 检查文件类型
        if (file.name.endsWith(".json")) {
          // 设置文件到input元素
          const fileInput = this.querySelector('input[type="file"]');
          if (fileInput) {
            fileInput.files = e.dataTransfer.files;
            // 直接处理文件
            processLunchFile(file);
          }
        } else {
          showNotification("请上传 JSON 文件", "error");
        }
      }
    });
  }

  // 摇一摇按钮点击事件
  const shakeBtn = document.getElementById("shake-lunch-btn");
  if (shakeBtn) {
      shakeBtn.addEventListener("click", shakeLunch);
  }

  // Bulk 操作按钮事件
  const createBulkJobBtn = document.getElementById("create-bulk-job-btn");
  if (createBulkJobBtn) {
    createBulkJobBtn.addEventListener("click", handleCreateBulkJob);
  }

  const checkBulkJobBtn = document.getElementById("check-bulk-job-btn");
  if (checkBulkJobBtn) {
    checkBulkJobBtn.addEventListener("click", handleCheckBulkJob);
  }

  const downloadBulkCsvBtn = document.getElementById("download-bulk-csv-btn");
  if (downloadBulkCsvBtn) {
    downloadBulkCsvBtn.addEventListener("click", () => handleDownloadBulkResult('csv'));
  }

  const downloadBulkZipBtn = document.getElementById("download-bulk-zip-btn");
  if (downloadBulkZipBtn) {
    downloadBulkZipBtn.addEventListener("click", () => handleDownloadBulkResult('zip'));
  }

  // Execute Anonymous 按钮事件
  const executeAnonymousBtn = document.getElementById("execute-anonymous-btn");
  if (executeAnonymousBtn) {
    executeAnonymousBtn.addEventListener("click", executeAnonymousCode);
  }

  // Schedule Jobs 刷新按钮事件
  const refreshScheduleJobsBtn = document.getElementById("refresh-schedule-jobs-btn");
  if (refreshScheduleJobsBtn) {
    refreshScheduleJobsBtn.addEventListener("click", loadScheduleJobs);
  }

  // Schedule Jobs 创建按钮事件
  const createScheduleJobBtn = document.getElementById("create-schedule-job-btn");
  if (createScheduleJobBtn) {
    createScheduleJobBtn.addEventListener("click", createScheduleJob);
  }

  // Schedule Jobs 清除所有按钮事件
  const clearAllScheduleJobsBtn = document.getElementById("clear-all-schedule-jobs-btn");
  if (clearAllScheduleJobsBtn) {
    clearAllScheduleJobsBtn.addEventListener("click", clearAllScheduleJobs);
  }

  // 绑定重新初始化事件
  const pageHeader = document.querySelector(".page-header");
  if (pageHeader) {
    pageHeader.addEventListener("click", function () {
      showNotification("正在重新初始化...", "info");
      initApp();
      showNotification("应用已重新初始化", "success");
    });
  }

  // Tab 切换事件
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', function() {
      const tabId = this.getAttribute('data-tab');
      const container = this.closest('.ant-card-body');
      
      // 切换按钮状态
      container.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      this.classList.add('active');
      
      // 切换内容显示
      container.querySelectorAll('.tab-content').forEach(content => {
        if (content.id === `${tabId}-tab`) {
          content.style.display = 'block';
        } else {
          content.style.display = 'none';
        }
      });
    });
  });
  
  // 绑定头像点击事件，显示/隐藏用户信息下拉菜单
  const avatarContainer = document.getElementById("avatar-container");
  const userMenu = document.getElementById("user-menu");
  
  if (avatarContainer && userMenu) {
    avatarContainer.addEventListener("click", function (e) {
      e.stopPropagation();
      // 切换下拉菜单显示状态
      userMenu.style.display = userMenu.style.display === "block" ? "none" : "block";
    });
    
    // 点击页面其他地方关闭下拉菜单
    document.addEventListener("click", function (e) {
      if (!avatarContainer.contains(e.target) && !userMenu.contains(e.target)) {
        userMenu.style.display = "none";
      }
    });
    
    // 点击下拉菜单内部不关闭
    userMenu.addEventListener("click", function (e) {
      e.stopPropagation();
    });
  }
}

// 页面加载完成后初始化
document.addEventListener("DOMContentLoaded", initApp);

// 将 schedule job 相关函数暴露到 window 对象，供 HTML 按钮 onclick 调用
window.deleteScheduleJob = deleteScheduleJob;
window.pauseScheduleJob = pauseScheduleJob;
window.resumeScheduleJob = resumeScheduleJob;

// 全局错误处理：捕获未处理的Promise拒绝
window.addEventListener('unhandledrejection', function(event) {
  console.error('Unhandled Promise Rejection:', event.reason);
  showNotification(`发生未处理的错误：${event.reason.message || event.reason}`, 'error');
  
  // 隐藏所有可能的loading mask
  const loadingMasks = document.querySelectorAll('#loading-mask');
  loadingMasks.forEach(mask => {
    mask.style.display = 'none';
  });
});

// 全局错误处理：捕获未处理的错误
window.addEventListener('error', function(event) {
  console.error('Global Error:', event.error);
  showNotification(`发生全局错误：${event.error.message || event.error}`, 'error');
  
  // 隐藏所有可能的loading mask
  const loadingMasks = document.querySelectorAll('#loading-mask');
  loadingMasks.forEach(mask => {
    mask.style.display = 'none';
  });
});
