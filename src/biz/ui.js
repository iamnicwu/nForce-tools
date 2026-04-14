import { appState } from "./state.js";
import { Icons } from "../common/icons.js";
import { renderTable } from "../common/table_utils.js";
import { showNotification, parseMarkdown } from "../common/utils.js";

// 更新午餐 UI 状态
export function updateLunchUIState() {
  const lunchActions = document.getElementById("lunch-actions");
  if (lunchActions) {
      lunchActions.style.display = "block";
  }
  
  const shakeBtn = document.getElementById("shake-lunch-btn");
  if (shakeBtn) {
      shakeBtn.disabled = false;
      shakeBtn.classList.remove("ant-btn-disabled");
      shakeBtn.classList.add("ant-btn-primary");
  }

  const countSpan = document.getElementById("lunch-place-count");
  if (countSpan && appState.lunch_places) {
      countSpan.textContent = appState.lunch_places.length;
  }

  // 渲染地点列表
  renderLunchList();
}

// 渲染午餐地点列表
function renderLunchList() {
  const container = document.getElementById("lunch-list-container");
  const list = document.getElementById("lunch-list");

  if (!container || !list) return;

  if (!appState.lunch_places || appState.lunch_places.length === 0) {
    container.style.display = "none";
    return;
  }

  container.style.display = "block";
  list.innerHTML = "";

  appState.lunch_places.forEach(place => {
    const tag = document.createElement("span");
    tag.className = "ant-tag ant-tag-blue";
    tag.style.fontSize = "14px";
    tag.style.padding = "4px 10px";
    tag.style.margin = "0";
    
    if (typeof place === 'string') {
        tag.textContent = place;
    } else if (typeof place === 'object') {
        tag.textContent = place.name || '未知地点';
        if (place.description) {
            tag.title = place.description;
        }
    }
    
    list.appendChild(tag);
  });
}

// 全局Handsontable实例
let dailyDataHot = null;
let pcdDailyDataHot = null;
let pcdPidFalloutDataHot = null;
let pcdQCIssueDataHot = null;
let reportDataHot = null;
let t2DataHot = null;
let t2AnalysisDataHot = null;
let latestDataHot = null;
let vvipDataHot = null;
let analysisDataHot = null;
let analysisChart = null;
let analysisBarChart = null;
let t2AnalysisChartStatus = null;
let t2AnalysisChartFulfillment = null;

// 显示对应section
export function showSection(sectionNumber) {
  // 如果是连接设置 (section 1)，重定向到版本信息 (section 6)
  if (sectionNumber === 1) {
    sectionNumber = 6;
  }
  
  // 隐藏所有section
  const sections = document.querySelectorAll(".step-section");
  if (sections && sections.length > 0) {
    sections.forEach((section) => {
      section.style.display = "none";
    });
  }

  // 显示目标section，根据连接状态决定可访问性
  if (appState.is_connected) {
    // 连接成功后，可以访问所有功能section
    const targetSection = document.getElementById(`section-${sectionNumber}`);
    if (targetSection) {
      targetSection.style.display = "block";
    } else {
      console.error(`Section ${sectionNumber} not found`);
    }
  } else {
    // 未连接时，只能访问版本信息和多session选择页面
    if (sectionNumber === 0 || sectionNumber === 6) {
      const targetSection = document.getElementById(`section-${sectionNumber}`);
      if (targetSection) {
        targetSection.style.display = "block";
      } else {
        console.error(`Section ${sectionNumber} not found`);
      }
    }
  }

  // 如果是版本信息页面 (section 6)，加载 README
  if (sectionNumber === 6 && !appState.readme_loaded) {
    loadReadme();
  }

  // 如果是 LTS 页面 (section 5)，加载 LTS Summary
  if (sectionNumber === 5 && !appState.lts_summary_loaded) {
    loadLTSSummary();
  }
  
  // 更新侧边栏激活链接
  updateActiveSidebarLink(sectionNumber);
  
  // 更新横向菜单栏
  updateHorizontalTabsFromSection(sectionNumber);
}

// 更新侧边栏激活链接
export function updateActiveSidebarLink(stepNumber) {
  const stepLinks = document.querySelectorAll(".step-link");
  stepLinks.forEach(link => {
    const linkStep = parseInt(link.getAttribute("data-step"));
    if (linkStep === stepNumber) {
      link.classList.add("active");
      
      // 如果链接在子菜单中，展开父菜单
      const parentSubmenu = link.closest(".nav-submenu");
      if (parentSubmenu) {
        const parentItem = parentSubmenu.closest(".nav-item");
        if (parentItem) {
          parentItem.classList.add("open");
        }
      }
    } else {
      link.classList.remove("active");
    }
  });
}

// 更新UI状态
export function updateUIState() {
  // 更新Session ID状态
  if (appState.session_id) {
    const sessionIdInput = document.getElementById("session_id");
    if (sessionIdInput) {
      sessionIdInput.value = appState.session_id;
    }
    
    const sessionIdSuccess = document.getElementById("session-id-success");
    if (sessionIdSuccess) {
      sessionIdSuccess.style.display = "flex";
    }
    
    const sessionIdBadge = document.getElementById("session-id-badge");
    if (sessionIdBadge) {
      sessionIdBadge.style.display = "inline-block";
      sessionIdBadge.className = "ant-tag ant-tag-success";
    }
    
    // 更新Session状态徽章
    const sessionStatusBadge = document.getElementById("session-status-badge");
    if (sessionStatusBadge) {
      sessionStatusBadge.textContent = "已设置";
      sessionStatusBadge.className = "ant-tag ant-tag-success";
    }
  } else {
    // 更新Session状态徽章为未设置
    const sessionStatusBadge = document.getElementById("session-status-badge");
    if (sessionStatusBadge) {
      sessionStatusBadge.textContent = "未设置";
      sessionStatusBadge.className = "ant-tag";
    }
  }

  // 更新连接状态
  if (appState.is_connected) {
    const connectionSuccess = document.getElementById("connection-success");
    if (connectionSuccess) {
      connectionSuccess.style.display = "flex";
    }
    
    const connectionBadge = document.getElementById("connection-badge");
    if (connectionBadge) {
      connectionBadge.style.display = "inline-block";
      connectionBadge.className = "ant-tag ant-tag-success";
    }
    
    // 更新连接状态徽章
    const connectionStatusBadge = document.getElementById("connection-status-badge");
    if (connectionStatusBadge) {
      connectionStatusBadge.textContent = "已连接";
      connectionStatusBadge.className = "ant-tag ant-tag-success";
    }
    
    // 显示统计卡片区域
    const statsSection = document.getElementById("stats-section");
    if (statsSection) {
      statsSection.style.display = "block";
    }
    
    // 更新统计数据
    updateStats();

    // 连接成功后，启用所有功能section
    for (let i = 2; i <= 18; i++) {
      const section = document.getElementById(`section-${i}`);
      if (section) {
        section.style.opacity = "1";
        section.style.pointerEvents = "auto";
      }
    }
  } else {
    // 未连接时，更新连接状态徽章为未连接
    const connectionStatusBadge = document.getElementById("connection-status-badge");
    if (connectionStatusBadge) {
      connectionStatusBadge.textContent = "未连接";
      connectionStatusBadge.className = "ant-tag";
    }
    
    // 隐藏统计卡片区域
    const statsSection = document.getElementById("stats-section");
    if (statsSection) {
      statsSection.style.display = "none";
    }
    
    // 未连接时，禁用所有功能section
    for (let i = 2; i <= 18; i++) {
      const section = document.getElementById(`section-${i}`);
      if (section) {
        section.style.opacity = "0.5";
        section.style.pointerEvents = "none";
      }
    }
  }

  // 版本信息始终启用
  const section6 = document.getElementById("section-6");
  if (section6) {
    section6.style.opacity = "1";
    section6.style.pointerEvents = "auto";
  }

  // 更新当日数据状态
  if (appState.has_daily_data && appState.is_connected) {
    const dailyDataBadge = document.getElementById("daily-data-badge");
    if (dailyDataBadge) {
      dailyDataBadge.style.display = "inline-block";
      dailyDataBadge.className = "ant-tag ant-tag-success";
    }
    
    // 显示导出按钮区域
    const dailyDataActions = document.getElementById("daily-data-actions");
    if (dailyDataActions) {
      dailyDataActions.style.display = "block";
    }
  } else if (!appState.is_connected) {
    const dailyDataBadge = document.getElementById("daily-data-badge");
    if (dailyDataBadge) {
      dailyDataBadge.style.display = "none";
    }
    
    const dailyDataActions = document.getElementById("daily-data-actions");
    if (dailyDataActions) {
      dailyDataActions.style.display = "none";
    }
  }

  // 更新 PCD 当日数据状态
  if (appState.has_pcd_daily_data && appState.is_connected) {
    const pcdDailyDataBadge = document.getElementById("pcd-daily-data-badge");
    if (pcdDailyDataBadge) {
      pcdDailyDataBadge.style.display = "inline-block";
      pcdDailyDataBadge.className = "ant-tag ant-tag-success";
    }
    
    // 显示导出按钮区域
    const pcdDailyDataActions = document.getElementById("pcd-daily-data-actions");
    if (pcdDailyDataActions) {
      pcdDailyDataActions.style.display = "block";
    }
  } else if (!appState.is_connected) {
    const pcdDailyDataBadge = document.getElementById("pcd-daily-data-badge");
    if (pcdDailyDataBadge) {
      pcdDailyDataBadge.style.display = "none";
    }
    
    const pcdDailyDataActions = document.getElementById("pcd-daily-data-actions");
    if (pcdDailyDataActions) {
      pcdDailyDataActions.style.display = "none";
    }
  }

  // 更新 PCD PID Fallout 数据状态
  if (appState.has_pcd_pid_fallout_data && appState.is_connected) {
    const pcdPidFalloutDataBadge = document.getElementById("pcd-pid-fallout-data-badge");
    if (pcdPidFalloutDataBadge) {
      pcdPidFalloutDataBadge.style.display = "inline-block";
      pcdPidFalloutDataBadge.className = "ant-tag ant-tag-success";
    }
    
    // 显示导出按钮区域
    const pcdPidFalloutDataActions = document.getElementById("pcd-pid-fallout-data-actions");
    if (pcdPidFalloutDataActions) {
      pcdPidFalloutDataActions.style.display = "block";
    }
  } else if (!appState.is_connected) {
    const pcdPidFalloutDataBadge = document.getElementById("pcd-pid-fallout-data-badge");
    if (pcdPidFalloutDataBadge) {
      pcdPidFalloutDataBadge.style.display = "none";
    }
    
    const pcdPidFalloutDataActions = document.getElementById("pcd-pid-fallout-data-actions");
    if (pcdPidFalloutDataActions) {
      pcdPidFalloutDataActions.style.display = "none";
    }
  }

  // 更新 PCD QC Issue 数据状态
  if (appState.has_pcd_qc_issue_data && appState.is_connected) {
    const pcdQCIssueDataBadge = document.getElementById("pcd-qc-issue-data-badge");
    if (pcdQCIssueDataBadge) {
      pcdQCIssueDataBadge.style.display = "inline-block";
      pcdQCIssueDataBadge.className = "ant-tag ant-tag-success";
    }
    
    // 显示导出按钮区域
    const pcdQCIssueDataActions = document.getElementById("pcd-qc-issue-data-actions");
    if (pcdQCIssueDataActions) {
      pcdQCIssueDataActions.style.display = "block";
    }
  } else if (!appState.is_connected) {
    const pcdQCIssueDataBadge = document.getElementById("pcd-qc-issue-data-badge");
    if (pcdQCIssueDataBadge) {
      pcdQCIssueDataBadge.style.display = "none";
    }
    
    const pcdQCIssueDataActions = document.getElementById("pcd-qc-issue-data-actions");
    if (pcdQCIssueDataActions) {
      pcdQCIssueDataActions.style.display = "none";
    }
  }

  // 更新报表数据状态
  if (appState.has_report_data && appState.is_connected) {
    const reportDataBadge = document.getElementById("report-data-badge");
    if (reportDataBadge) {
      reportDataBadge.style.display = "inline-block";
      reportDataBadge.className = "ant-tag ant-tag-success";
    }
    
    // 显示导出按钮区域
    const reportDataActions = document.getElementById("report-data-actions");
    if (reportDataActions) {
      reportDataActions.style.display = "block";
    }
  } else if (!appState.is_connected) {
    const reportDataBadge = document.getElementById("report-data-badge");
    if (reportDataBadge) {
      reportDataBadge.style.display = "none";
    }
    
    const reportDataActions = document.getElementById("report-data-actions");
    if (reportDataActions) {
      reportDataActions.style.display = "none";
    }
  }

  // 更新T-4数据状态
  if (appState.has_t2_data && appState.is_connected) {
    const t2DataBadge = document.getElementById("t2-data-badge");
    if (t2DataBadge) {
      t2DataBadge.style.display = "inline-block";
      t2DataBadge.className = "ant-tag ant-tag-success";
    }
    
    // 显示导出按钮区域
    const t2DataActions = document.getElementById("t2-data-actions");
    if (t2DataActions) {
      t2DataActions.style.display = "block";
    }
  } else if (!appState.is_connected) {
    const t2DataBadge = document.getElementById("t2-data-badge");
    if (t2DataBadge) {
      t2DataBadge.style.display = "none";
    }
    
    const t2DataActions = document.getElementById("t2-data-actions");
    if (t2DataActions) {
      t2DataActions.style.display = "none";
    }
  }

  // 更新T-4分析状态
  if (appState.t2_analysis_data && appState.is_connected) {
    const t2AnalysisBadge = document.getElementById("t2-analysis-badge");
    if (t2AnalysisBadge) {
      t2AnalysisBadge.style.display = "inline-block";
      t2AnalysisBadge.className = "ant-tag ant-tag-success";
    }

    // 显示导出按钮
    const exportT2AnalysisBtn = document.getElementById("export-t2-analysis-data");
    if (exportT2AnalysisBtn) {
      exportT2AnalysisBtn.style.display = "inline-block";
    }
  } else if (!appState.is_connected) {
    const t2AnalysisBadge = document.getElementById("t2-analysis-badge");
    if (t2AnalysisBadge) {
      t2AnalysisBadge.style.display = "none";
    }

    const exportT2AnalysisBtn = document.getElementById("export-t2-analysis-data");
    if (exportT2AnalysisBtn) {
      exportT2AnalysisBtn.style.display = "none";
    }
  }

  // 更新T-4分析文件上传状态
  if (appState.has_t2_analysis_file && appState.is_connected) {
    const t2AnalysisFileUploadBadge = document.getElementById("t2-analysis-file-upload-badge");
    if (t2AnalysisFileUploadBadge) {
      t2AnalysisFileUploadBadge.style.display = "inline-block";
      t2AnalysisFileUploadBadge.className = "ant-tag ant-tag-success";
    }

    // 显示"开始分析"按钮
    const analyzeT2DataBtn = document.getElementById("analyze-t2-data-btn");
    if (analyzeT2DataBtn) {
      analyzeT2DataBtn.style.display = "inline-block";
    }
  } else if (!appState.is_connected) {
    const t2AnalysisFileUploadBadge = document.getElementById("t2-analysis-file-upload-badge");
    if (t2AnalysisFileUploadBadge) {
      t2AnalysisFileUploadBadge.style.display = "none";
    }

    // 隐藏"开始分析"按钮
    const analyzeT2DataBtn = document.getElementById("analyze-t2-data-btn");
    if (analyzeT2DataBtn) {
      analyzeT2DataBtn.style.display = "none";
    }
  }

  // 更新文件上传状态
  if (appState.has_file && appState.is_connected) {
    const fileUploadSuccess = document.getElementById("file-upload-success");
    if (fileUploadSuccess) {
      fileUploadSuccess.style.display = "flex";
    }
    
    const fileUploadBadge = document.getElementById("file-upload-badge");
    if (fileUploadBadge) {
      fileUploadBadge.style.display = "inline-block";
      fileUploadBadge.className = "ant-tag ant-tag-success";
    }
    
    const orderCount = document.getElementById("order-count");
    if (orderCount) {
      orderCount.textContent = appState.order_numbers.length;
    }

    // 显示"显示最新数据"按钮
    const getLatestDataBtn = document.getElementById("get-latest-data-btn");
    if (getLatestDataBtn) {
      getLatestDataBtn.style.display = "inline-block";
    }
  } else if (!appState.is_connected) {
    const fileUploadSuccess = document.getElementById("file-upload-success");
    if (fileUploadSuccess) {
      fileUploadSuccess.style.display = "none";
    }
    
    const fileUploadBadge = document.getElementById("file-upload-badge");
    if (fileUploadBadge) {
      fileUploadBadge.style.display = "none";
    }

    // 隐藏"显示最新数据"按钮
    const getLatestDataBtn = document.getElementById("get-latest-data-btn");
    if (getLatestDataBtn) {
      getLatestDataBtn.style.display = "none";
    }
  }

  // 更新VVIP文件上传状态
  if (appState.has_vvip_file && appState.is_connected) {

    // 显示"获取 PCD/LTS 状态"按钮
    const getVVIPDataBtn = document.getElementById("get-vvip-data-btn");
    if (getVVIPDataBtn) {
      getVVIPDataBtn.style.display = "inline-block";
    }
  } else if (!appState.is_connected) {
    
    // 隐藏"获取 PCD/LTS 状态"按钮
    const getVVIPDataBtn = document.getElementById("get-vvip-data-btn");
    if (getVVIPDataBtn) {
      getVVIPDataBtn.style.display = "none";
    }
  }

  // 更新T-4分析文件上传状态
  if (appState.has_t2_analysis_file && appState.is_connected) {
    const t2AnalysisFileUploadBadge = document.getElementById("t2-analysis-file-upload-badge");
    if (t2AnalysisFileUploadBadge) {
      t2AnalysisFileUploadBadge.style.display = "inline-block";
      t2AnalysisFileUploadBadge.className = "ant-tag ant-tag-success";
    }

    // 显示"开始分析"按钮
    const analyzeT2DataBtn = document.getElementById("analyze-t2-data-btn");
    if (analyzeT2DataBtn) {
      analyzeT2DataBtn.style.display = "inline-block";
    }
  } else if (!appState.is_connected) {
    const t2AnalysisFileUploadBadge = document.getElementById("t2-analysis-file-upload-badge");
    if (t2AnalysisFileUploadBadge) {
      t2AnalysisFileUploadBadge.style.display = "none";
    }

    // 隐藏"开始分析"按钮
    const analyzeT2DataBtn = document.getElementById("analyze-t2-data-btn");
    if (analyzeT2DataBtn) {
      analyzeT2DataBtn.style.display = "none";
    }
  }

  // 更新数据分析文件上传状态
  if (appState.has_analysis_file && appState.is_connected) {
    const analysisFileUploadBadge = document.getElementById("analysis-file-upload-badge");
    if (analysisFileUploadBadge) {
      analysisFileUploadBadge.style.display = "inline-block";
      analysisFileUploadBadge.className = "ant-tag ant-tag-success";
    }

    // 显示"开始分析"按钮 (虽然目前只是显示数据)
    const analyzeDataBtn = document.getElementById("analyze-data-btn");
    if (analyzeDataBtn) {
      analyzeDataBtn.style.display = "inline-block";
    }
    
    // 显示导出按钮
    const exportAnalysisBtn = document.getElementById("export-analysis-data");
    if (exportAnalysisBtn) {
      exportAnalysisBtn.style.display = "inline-block";
    }
  } else if (!appState.is_connected) {
    const analysisFileUploadBadge = document.getElementById("analysis-file-upload-badge");
    if (analysisFileUploadBadge) {
      analysisFileUploadBadge.style.display = "none";
    }

    // 隐藏按钮
    const analyzeDataBtn = document.getElementById("analyze-data-btn");
    if (analyzeDataBtn) {
      analyzeDataBtn.style.display = "none";
    }
    const exportAnalysisBtn = document.getElementById("export-analysis-data");
    if (exportAnalysisBtn) {
      exportAnalysisBtn.style.display = "none";
    }
  }
  
  // 更新用户信息
  updateUserInfo();
}

// 更新统计卡片数据
export function updateStats() {
  // 确保stats对象存在
  if (!appState.stats) {
    appState.stats = {
      dailyOrders: 0,
      reportRecords: 0,
      uploadedOrders: 0,
      fetchedData: 0,
      uploadedAccounts: 0,
      ltsAccounts: 0,
      vvipOrders: 0,
      ltsOrders: 0,
      pcdDailyOrders: 0
    };
  }
  
  // 更新用户信息中的统计数据
  updateUserInfo();
}

// 更新用户信息
export function updateUserInfo() {
  // 更新头像
  const avatarEl = document.getElementById("user-avatar");
  console.log(avatarEl);
  console.log(appState.userInfo);
  if (avatarEl) {
    // 检查是否有缩略图
    if (appState.userInfo && appState.userInfo.thumbnail) {
      // 使用缩略图作为背景
      avatarEl.style.backgroundImage = `url(${appState.userInfo.thumbnail})`;
      avatarEl.style.backgroundSize = "cover";
      avatarEl.style.backgroundPosition = "center";
      avatarEl.style.backgroundRepeat = "no-repeat";
      // 隐藏默认的用户图标
      const iconEl = avatarEl.querySelector("i");
      if (iconEl) {
        iconEl.style.display = "none";
      }
    } else {
      // 恢复默认样式
      avatarEl.style.backgroundImage = "";
      avatarEl.style.backgroundSize = "";
      avatarEl.style.backgroundPosition = "";
      avatarEl.style.backgroundRepeat = "";
      // 显示默认的用户图标
      const iconEl = avatarEl.querySelector("i");
      if (iconEl) {
        iconEl.style.display = "";
      }
    }
    
    // 更新头像颜色/环境标识
    if (appState.orgInfo) {
      if (appState.orgInfo.IsSandbox) {
        avatarEl.style.backgroundColor = "#f39c12"; // 黄色 - UAT/Sandbox
        avatarEl.title = "Sandbox Environment";
      } else {
        avatarEl.style.backgroundColor = "#e74c3c"; // 红色 - Production
        avatarEl.title = "Production Environment";
      }
    } else {
      avatarEl.style.backgroundColor = ""; // 默认颜色
      avatarEl.title = "";
    }
  }

  // 确保stats对象存在
  if (!appState.stats) {
    appState.stats = {
      dailyOrders: 0,
      reportRecords: 0,
      uploadedOrders: 0,
      fetchedData: 0,
      uploadedAccounts: 0,
      ltsAccounts: 0,
      vvipOrders: 0,
      ltsOrders: 0,
      pcdDailyOrders: 0
    };
  }
  
  // 确保userInfo对象存在
  if (!appState.userInfo) {
    appState.userInfo = {
      username: '',
      email: '',
      fullName: '',
      thumbnail: ''
    };
  }
  
  // 更新用户名显示
  const userNameEl = document.getElementById("user-name");
  if (userNameEl) {
    userNameEl.textContent = appState.userInfo.fullName || appState.userInfo.username || "用户信息";
  }
  
  // 更新全名显示
  const userFullnameEl = document.getElementById("user-fullname");
  if (userFullnameEl) {
    userFullnameEl.textContent = appState.userInfo.fullName || "-";
  }
  
  // 更新邮箱显示
  const userEmailEl = document.getElementById("user-email");
  if (userEmailEl) {
    userEmailEl.textContent = appState.userInfo.email || "-";
  }
  
  // // 更新用户名显示
  // const userUsernameEl = document.getElementById("user-username");
  // if (userUsernameEl) {
  //   userUsernameEl.textContent = appState.userInfo.username || "-";
  // }
  
  // 更新Session ID显示（只显示部分字符）
  const sessionIdEl = document.getElementById("user-session-id");
  if (sessionIdEl) {
    if (appState.session_id) {
      // 显示Session ID的前8位和后8位，中间用...代替
      const shortSessionId = `${appState.session_id.substring(0, 8)}...${appState.session_id.substring(appState.session_id.length - 8)}`;
      sessionIdEl.textContent = shortSessionId;
    } else {
      sessionIdEl.textContent = "未设置";
    }
  }
  
  // 更新连接状态
  const connectionStatusEl = document.getElementById("user-connection-status");
  if (connectionStatusEl) {
    connectionStatusEl.textContent = appState.is_connected ? "已连接" : "未连接";
    connectionStatusEl.className = `value ${appState.is_connected ? "text-success" : "text-error"}`;
  }
  
  // 更新当前步骤
  const currentStepEl = document.getElementById("user-current-step");
  if (currentStepEl) {
    currentStepEl.textContent = appState.current_step || 1;
  }
  
  // 更新当日订单数
  const dailyOrdersEl = document.getElementById("user-daily-orders");
  if (dailyOrdersEl) {
    dailyOrdersEl.textContent = appState.stats.dailyOrders || 0;
  }

  // 更新 PCD 当日订单数
  const pcdDailyOrdersEl = document.getElementById("user-pcd-daily-orders");
  if (pcdDailyOrdersEl) {
    pcdDailyOrdersEl.textContent = appState.stats.pcdDailyOrders || 0;
  }
  
  // 更新报表记录数
  const reportRecordsEl = document.getElementById("user-report-records");
  if (reportRecordsEl) {
    reportRecordsEl.textContent = appState.stats.reportRecords || 0;
  }

  // 更新T-4记录数
  const t2RecordsEl = document.getElementById("user-t2-records");
  if (t2RecordsEl) {
    t2RecordsEl.textContent = appState.stats.t2Records || 0;
  }
  
  // 更新上传订单数
  const uploadedOrdersEl = document.getElementById("user-uploaded-orders");
  if (uploadedOrdersEl) {
    uploadedOrdersEl.textContent = appState.stats.uploadedOrders || 0;
  }
}

// 渲染当日数据
export function renderDailyData(data) {
  dailyDataHot = renderTable("daily-data-container", "daily-data-table", data, dailyDataHot);
}

// 渲染 PCD 当日数据
export function renderPCDDailyData(data) {
  pcdDailyDataHot = renderTable("pcd-daily-data-container", "pcd-daily-data-table", data, pcdDailyDataHot);
}

// 渲染 PCD PID Fallout 数据
export function renderPCDPIDFalloutData(data) {
  const container = document.getElementById("pcd-pid-fallout-data-container");
  const table = document.getElementById("pcd-pid-fallout-data-table");
  
  // 销毁旧实例
  if (pcdPidFalloutDataHot) {
    pcdPidFalloutDataHot.destroy();
    pcdPidFalloutDataHot = null;
  }
  
  if (!data || data.length === 0) {
    container.style.display = "none";
    return;
  }
  
  // 准备Handsontable需要的数据格式
  const tableColumns = Object.keys(data[0]).map(col => ({
      title: col.replace(/__c/g, '').replace(/_/g, ' '),
      data: col
  }));
  
  // 配置Handsontable
  const hotConfig = {
    data: data,
    columns: tableColumns,
    colHeaders: true,
    rowHeaders: true,
    stretchH: 'all',
    autoWrapRow: true,
    autoWrapCol: true,
    maxRows: 1000,
    width: '100%',
    height: '500px',
    licenseKey: 'non-commercial-and-evaluation',
    filters: true,
    dropdownMenu: true,
    sortIndicator: true,
    manualColumnResize: true,
    manualRowResize: true,
    manualColumnMove: true,
    search: true,
    contextMenu: true
  };
  
  // 创建Handsontable实例
  pcdPidFalloutDataHot = new Handsontable(table, hotConfig);
  
  // 显示数据容器
  container.style.display = "block";
}

// 渲染 PCD QC Issue 数据
export function renderPCDQCIssueData(data) {
  const container = document.getElementById("pcd-qc-issue-data-container");
  const table = document.getElementById("pcd-qc-issue-data-table");
  
  // 销毁旧实例
  if (pcdQCIssueDataHot) {
    pcdQCIssueDataHot.destroy();
    pcdQCIssueDataHot = null;
  }
  
  if (!data || data.length === 0) {
    container.style.display = "none";
    return;
  }
  
  // 准备Handsontable需要的数据格式
  const tableColumns = Object.keys(data[0]).map(col => ({
      title: col.replace(/__c/g, '').replace(/_/g, ' '),
      data: col
  }));
  
  // 配置Handsontable
  const hotConfig = {
    data: data,
    columns: tableColumns,
    colHeaders: true,
    rowHeaders: true,
    stretchH: 'all',
    autoWrapRow: true,
    autoWrapCol: true,
    maxRows: 1000,
    width: '100%',
    height: '500px',
    licenseKey: 'non-commercial-and-evaluation',
    filters: true,
    dropdownMenu: true,
    sortIndicator: true,
    manualColumnResize: true,
    manualRowResize: true,
    manualColumnMove: true,
    search: true,
    contextMenu: true
  };
  
  // 创建Handsontable实例
  pcdQCIssueDataHot = new Handsontable(table, hotConfig);
  
  // 显示数据容器
  container.style.display = "block";
}

// 渲染报表数据
export function renderReportData(data) {
  reportDataHot = renderTable("report-data-container", "report-data-table", data, reportDataHot);
}

// 渲染T-4数据
export function renderT2Data(data) {
  t2DataHot = renderTable("t2-data-container", "t2-data-table", data, t2DataHot);
}

// 渲染T-4分析数据
export function renderT2AnalysisData(data) {
  const container = document.getElementById("t2-analysis-data-container");
  const table = document.getElementById("t2-analysis-data-table");
  
  // 销毁旧实例
  if (t2AnalysisDataHot) {
    t2AnalysisDataHot.destroy();
    t2AnalysisDataHot = null;
  }
  
  if (!data || data.length === 0) {
    container.style.display = "none";
    return;
  }
  
  // 准备Handsontable需要的数据格式
  const tableColumns = Object.keys(data[0]).map(col => ({
      title: col,
      data: col
  }));
  
  // 配置Handsontable
  const hotConfig = {
    data: data,
    columns: tableColumns,
    colHeaders: true,
    rowHeaders: true,
    stretchH: 'all',
    autoWrapRow: true,
    autoWrapCol: true,
    maxRows: 1000,
    width: '100%',
    height: '500px',
    licenseKey: 'non-commercial-and-evaluation',
    filters: true,
    dropdownMenu: true,
    sortIndicator: true,
    manualColumnResize: true,
    manualRowResize: true,
    manualColumnMove: true,
    search: true,
    contextMenu: true
  };
  
  // 创建Handsontable实例
  t2AnalysisDataHot = new Handsontable(table, hotConfig);
  
  // 显示数据容器
  container.style.display = "block";

  // 渲染图表
  renderT2AnalysisCharts(data);
}

// 渲染T-4分析图表
export function renderT2AnalysisCharts(data) {
  const container = document.getElementById("t2-analysis-charts-container");
  const statusChartDom = document.getElementById("t2-analysis-chart-status");
  const fulfillmentChartDom = document.getElementById("t2-analysis-chart-fulfillment");
  
  if (!data || data.length === 0) {
    container.style.display = "none";
    return;
  }

  container.style.display = "block";

  // 1. 状态分布图表
  if (t2AnalysisChartStatus) {
    t2AnalysisChartStatus.dispose();
  }
  t2AnalysisChartStatus = echarts.init(statusChartDom);

  // 确定要统计的字段
  let statusField = 'Custom_OrderStatus__c';
  // 如果数据中没有 Custom_OrderStatus__c，尝试寻找其他状态字段
  if (data.length > 0 && !data[0].hasOwnProperty('Custom_OrderStatus__c')) {
    const fields = Object.keys(data[0]);
    const keywords = ["Status", "状态", "Result", "结果", "Category", "类别"];
    for (const keyword of keywords) {
      const found = fields.find(f => f.includes(keyword));
      if (found) {
        statusField = found;
        break;
      }
    }
    // 如果还没找到，使用最后一列
    if (statusField === 'Custom_OrderStatus__c' && fields.length > 0) {
        statusField = fields[fields.length - 1];
    }
  }

  const statusCounts = {};
  data.forEach(row => {
    const status = row[statusField] || 'Unknown';
    statusCounts[status] = (statusCounts[status] || 0) + 1;
  });

  const statusChartData = Object.keys(statusCounts).map(key => ({
    name: key,
    value: statusCounts[key]
  }));

  const statusOption = {
    title: {
      text: `${statusField} 分布`,
      left: 'center'
    },
    tooltip: {
      trigger: 'item',
      formatter: '{a} <br/>{b} : {c} ({d}%)'
    },
    legend: {
      orient: 'vertical',
      left: 'left'
    },
    series: [
      {
        name: '订单状态',
        type: 'pie',
        radius: '50%',
        data: statusChartData,
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowOffsetX: 0,
            shadowColor: 'rgba(0, 0, 0, 0.5)'
          }
        }
      }
    ]
  };
  t2AnalysisChartStatus.setOption(statusOption);

  // 2. 履行状态分布图表 (vlocity_cmt__FulfilmentStatus__c) 或其他辅助字段
  if (t2AnalysisChartFulfillment) {
    t2AnalysisChartFulfillment.dispose();
  }
  t2AnalysisChartFulfillment = echarts.init(fulfillmentChartDom);

  // 确定要统计的字段
  let fulfillmentField = 'vlocity_cmt__FulfilmentStatus__c';
  // 如果数据中没有 vlocity_cmt__FulfilmentStatus__c，尝试寻找其他字段
  if (data.length > 0 && !data[0].hasOwnProperty('vlocity_cmt__FulfilmentStatus__c')) {
      const fields = Object.keys(data[0]);
      // 排除已经用作状态分布的字段
      const otherFields = fields.filter(f => f !== statusField);
      
      const keywords = ["Fulfilment", "履行", "Action", "操作", "Reason", "原因"];
      for (const keyword of keywords) {
        const found = otherFields.find(f => f.includes(keyword));
        if (found) {
            fulfillmentField = found;
            break;
        }
      }
      
      // 如果还没找到，且有剩余字段，取倒数第二个（假设倒数第一个是状态）
      if (fulfillmentField === 'vlocity_cmt__FulfilmentStatus__c' && otherFields.length > 0) {
          fulfillmentField = otherFields[otherFields.length - 1];
      }
  }

  const fulfillmentCounts = {};
  data.forEach(row => {
    const status = row[fulfillmentField] || 'Unknown';
    fulfillmentCounts[status] = (fulfillmentCounts[status] || 0) + 1;
  });

  const fulfillmentChartData = Object.keys(fulfillmentCounts).map(key => ({
    name: key,
    value: fulfillmentCounts[key]
  }));

  // 按数量降序排序
  fulfillmentChartData.sort((a, b) => b.value - a.value);

  const fulfillmentOption = {
    title: {
      text: `${fulfillmentField} 分布`,
      left: 'center'
    },
    tooltip: {
      trigger: 'axis',
      axisPointer: {
        type: 'shadow'
      }
    },
    grid: {
      left: '3%',
      right: '4%',
      bottom: '3%',
      containLabel: true
    },
    xAxis: {
      type: 'category',
      data: fulfillmentChartData.map(item => item.name),
      axisLabel: {
        interval: 0,
        rotate: 30,
        overflow: 'break'
      }
    },
    yAxis: {
      type: 'value'
    },
    series: [
      {
        name: '数量',
        type: 'bar',
        data: fulfillmentChartData.map(item => item.value),
        itemStyle: {
          color: '#52c41a'
        },
        label: {
          show: true,
          position: 'top'
        }
      }
    ]
  };
  t2AnalysisChartFulfillment.setOption(fulfillmentOption);

  // 监听窗口大小变化
  window.addEventListener('resize', function() {
    if (t2AnalysisChartStatus) t2AnalysisChartStatus.resize();
    if (t2AnalysisChartFulfillment) t2AnalysisChartFulfillment.resize();
  });
}

// 渲染最新数据
export function renderLatestData(data) {
  const container = document.getElementById("latest-data-container");
  const table = document.getElementById("latest-data-table");
  
  // 销毁旧实例
  if (latestDataHot) {
    latestDataHot.destroy();
    latestDataHot = null;
  }
  
  if (!data || data.length === 0) {
    container.style.display = "none";
    return;
  }
  
  // 准备Handsontable需要的数据格式
  const tableColumns = Object.keys(data[0]).map(col => ({
      title: col.replace(/__c/g, '').replace(/Order_/g, '').replace(/_/g, ' '),
      data: col
  }));
  
  // 配置Handsontable
  const hotConfig = {
    data: data,
    columns: tableColumns,
    colHeaders: true,
    rowHeaders: true,
    stretchH: 'all',
    autoWrapRow: true,
    autoWrapCol: true,
    maxRows: 1000,
    width: '100%',
    height: '500px',
    licenseKey: 'non-commercial-and-evaluation',
    filters: true,
    dropdownMenu: true,
    sortIndicator: true,
    manualColumnResize: true,
    manualRowResize: true,
    manualColumnMove: true,
    search: true,
    contextMenu: {
        items: {
            'row_above': {
                name: '在上方插入行'
            },
            'row_below': {
                name: '在下方插入行'
            },
            'col_left': {
                name: '在左侧插入列'
            },
            'col_right': {
                name: '在右侧插入列'
            },
            'remove_row': {
                name: '删除行'
            },
            'remove_col': {
                name: '删除列'
            },
            '---------': '---------',
            'copy': {
                name: '复制'
            },
            'cut': {
                name: '剪切'
            },
            'paste': {
                name: '粘贴'
            }
        }
    }
  };
  
  // 创建Handsontable实例
  latestDataHot = new Handsontable(table, hotConfig);
  
  // 显示数据容器
  container.style.display = "block";
}

// 渲染VVIP数据
export function renderVVIPData(data) {
  const container = document.getElementById("vvip-data-container");
  const table = document.getElementById("vvip-data-table");
  
  // 销毁旧实例
  if (vvipDataHot) {
    vvipDataHot.destroy();
    vvipDataHot = null;
  }
  
  if (!data || data.length === 0) {
    container.style.display = "none";
    return;
  }
  
  // 准备Handsontable需要的数据格式
  const tableColumns = Object.keys(data[0]).map(col => ({
      title: col.replace(/__c/g, '').replace(/_/g, ' '),
      data: col
  }));
  
  // 配置Handsontable
  const hotConfig = {
    data: data,
    columns: tableColumns,
    colHeaders: true,
    rowHeaders: true,
    stretchH: 'all',
    autoWrapRow: true,
    autoWrapCol: true,
    maxRows: 1000,
    width: '100%',
    height: '500px',
    licenseKey: 'non-commercial-and-evaluation',
    filters: true,
    dropdownMenu: true,
    sortIndicator: true,
    manualColumnResize: true,
    manualRowResize: true,
    manualColumnMove: true,
    search: true,
    contextMenu: true
  };
  
  // 创建Handsontable实例
  vvipDataHot = new Handsontable(table, hotConfig);
  
  // 显示数据容器
  container.style.display = "block";
}

// 渲染数据分析数据
export function renderAnalysisData(data) {
  const container = document.getElementById("analysis-data-container");
  const table = document.getElementById("analysis-data-table");
  
  // 销毁旧实例
  if (analysisDataHot) {
    analysisDataHot.destroy();
    analysisDataHot = null;
  }
  
  if (!data || data.length === 0) {
    container.style.display = "none";
    return;
  }
  
  // 准备Handsontable需要的数据格式
  const tableColumns = Object.keys(data[0]).map(col => ({
      title: col,
      data: col
  }));
  
  // 配置Handsontable
  const hotConfig = {
    data: data,
    columns: tableColumns,
    colHeaders: true,
    rowHeaders: true,
    stretchH: 'all',
    autoWrapRow: true,
    autoWrapCol: true,
    maxRows: 1000,
    width: '100%',
    height: '500px',
    licenseKey: 'non-commercial-and-evaluation',
    filters: true,
    dropdownMenu: true,
    sortIndicator: true,
    manualColumnResize: true,
    manualRowResize: true,
    manualColumnMove: true,
    search: true,
    contextMenu: true
  };
  
  // 创建Handsontable实例
  analysisDataHot = new Handsontable(table, hotConfig);
  
  // 显示数据容器
  container.style.display = "block";

  // 渲染图表
  renderAnalysisChart(data);
}

// 渲染数据分析图表
export function renderAnalysisChart(data) {
  const container = document.getElementById("analysis-charts-container");
  const chartDom = document.getElementById("analysis-chart-main");
  
  if (!data || data.length === 0) {
    container.style.display = "none";
    return;
  }

  container.style.display = "block";

  // 初始化图表
  if (analysisChart) {
    analysisChart.dispose();
  }
  analysisChart = echarts.init(chartDom);

  // 统计数据
  // 假设我们要统计某个字段的分布，这里以 "Status" 或 "状态" 为例，如果没有则尝试统计最后一列
  let targetField = null;
  const fields = Object.keys(data[0]);
  
  // 尝试寻找包含 "Status", "状态", "Result", "结果" 的字段
  const keywords = ["Status", "状态", "Result", "结果", "Category", "类别"];
  for (const keyword of keywords) {
    const found = fields.find(f => f.includes(keyword));
    if (found) {
      targetField = found;
      break;
    }
  }
  
  // 如果没找到，默认使用最后一列（通常是分析结果）
  if (!targetField && fields.length > 0) {
    targetField = fields[fields.length - 1];
  }

  if (!targetField) return;

  // 统计频次
  const counts = {};
  data.forEach(row => {
    const value = row[targetField] || "Unknown";
    // 过滤掉 Fixed 状态
    if (value === "Fixed") return;
    counts[value] = (counts[value] || 0) + 1;
  });

  const chartData = Object.keys(counts).map(key => ({
    name: key,
    value: counts[key]
  }));

  // 配置图表
  const option = {
    title: {
      text: `${targetField}分布统计`,
      left: 'center'
    },
    tooltip: {
      trigger: 'item',
      formatter: '{a} <br/>{b} : {c} ({d}%)'
    },
    legend: {
      orient: 'vertical',
      left: 'left'
    },
    series: [
      {
        name: targetField,
        type: 'pie',
        radius: '50%',
        data: chartData,
        emphasis: {
          itemStyle: {
            shadowBlur: 10,
            shadowOffsetX: 0,
            shadowColor: 'rgba(0, 0, 0, 0.5)'
          }
        }
      }
    ]
  };

  analysisChart.setOption(option);

  // 渲染柱状图 (Latest Action By)
  const barChartDom = document.getElementById("analysis-chart-bar");
  if (barChartDom) {
    // 寻找 Latest Action By 字段
    let actionByField = null;
    const actionByKeywords = ["Latest Action By", "latest action by", "LatestActionBy", "Action By", "action by"];
    for (const keyword of actionByKeywords) {
      const found = fields.find(f => f.toLowerCase().replace(/\s+/g, '') === keyword.toLowerCase().replace(/\s+/g, ''));
      if (found) {
        actionByField = found;
        break;
      }
    }

    if (actionByField) {
      if (analysisBarChart) {
        analysisBarChart.dispose();
      }
      analysisBarChart = echarts.init(barChartDom);
      
      // 统计频次
      const actionCounts = {};
      data.forEach(row => {
        // 如果存在状态字段，且状态为 Fixed，则跳过
        if (targetField && row[targetField] === "Fixed") return;

        let value = row[actionByField];
        if (value === undefined || value === null || value === '') {
          value = "Unknown";
        }
        actionCounts[value] = (actionCounts[value] || 0) + 1;
      });

      const barChartData = Object.keys(actionCounts).map(key => ({
        name: key,
        value: actionCounts[key]
      }));
      
      // 按数量降序排序
      barChartData.sort((a, b) => b.value - a.value);

      const barOption = {
        title: {
          text: `Issue分布`,
          left: 'center'
        },
        tooltip: {
          trigger: 'axis',
          axisPointer: {
            type: 'shadow'
          }
        },
        grid: {
          left: '3%',
          right: '4%',
          bottom: '3%',
          containLabel: true
        },
        xAxis: {
          type: 'category',
          data: barChartData.map(item => item.name),
          axisLabel: {
            interval: 0,
            rotate: 30,
            overflow: 'break'
          }
        },
        yAxis: {
          type: 'value'
        },
        series: [
          {
            name: '数量',
            type: 'bar',
            data: barChartData.map(item => item.value),
            itemStyle: {
              color: '#5470c6'
            },
            label: {
              show: true,
              position: 'top'
            }
          }
        ]
      };
      
      analysisBarChart.setOption(barOption);
    } else {
      // 如果之前初始化过，需要销毁实例以显示innerHTML
      if (analysisBarChart) {
          analysisBarChart.dispose();
          analysisBarChart = null;
      }
      barChartDom.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100%;color:#999;">未找到 "Latest Action By" 相关字段</div>';
    }
  }
  
  // 监听窗口大小变化
  window.addEventListener('resize', function() {
    if (analysisChart) analysisChart.resize();
    if (analysisBarChart) analysisBarChart.resize();
  });
}

// 更新文件上传UI
export function updateFileUploadUI(file) {
  const fileUpload = document.querySelector("#file-upload-form .file-upload");
  if (!fileUpload) return;

  // 更改图标为Excel文件图标
  const iconContainer = fileUpload.querySelector(".ant-upload-drag-icon");
  if (iconContainer) {
    iconContainer.innerHTML = Icons.fileExcelAlt;
    iconContainer.querySelector('svg').style.color = '#107c41';
  }

  // 更新文本显示文件名
  const textContainer = fileUpload.querySelector(".ant-upload-text");
  if (textContainer) {
    textContainer.innerHTML = `
      <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.5rem;">${file.name}</div>
      <div style="font-size: 0.875rem; color: var(--text-secondary);">
        ${(file.size / 1024).toFixed(2)} KB
      </div>
      <div style="font-size: 0.875rem; color: var(--primary-color); margin-top: 0.5rem; cursor: pointer;">
        点击或拖拽更换文件
      </div>
    `;
  }
  
  // 添加已选择样式
  fileUpload.classList.add("has-file");
}

// 更新VVIP文件上传UI
export function updateVVIPFileUploadUI(file) {
  const fileUpload = document.querySelector("#vvip-file-upload-form .file-upload");
  if (!fileUpload) return;

  // 更改图标为Excel文件图标
  const iconContainer = fileUpload.querySelector(".ant-upload-drag-icon");
  if (iconContainer) {
    iconContainer.innerHTML = Icons.fileExcelAlt;
    iconContainer.querySelector('svg').style.color = '#107c41';
  }

  // 更新文本显示文件名
  const textContainer = fileUpload.querySelector(".ant-upload-text");
  if (textContainer) {
    textContainer.innerHTML = `
      <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.5rem;">${file.name}</div>
      <div style="font-size: 0.875rem; color: var(--text-secondary);">
        ${(file.size / 1024).toFixed(2)} KB
      </div>
      <div style="font-size: 0.875rem; color: var(--primary-color); margin-top: 0.5rem; cursor: pointer;">
        点击或拖拽更换文件
      </div>
    `;
  }
  
  // 添加已选择样式
  fileUpload.classList.add("has-file");
}

// 更新T-4分析文件上传UI
export function updateT2AnalysisFileUploadUI(file) {
  const fileUpload = document.querySelector("#t2-analysis-file-upload-form .file-upload");
  if (!fileUpload) return;

  // 更改图标为Excel文件图标
  const iconContainer = fileUpload.querySelector(".ant-upload-drag-icon");
  if (iconContainer) {
    iconContainer.innerHTML = Icons.fileExcelAlt;
    iconContainer.querySelector('svg').style.color = '#107c41';
  }

  // 更新文本显示文件名
  const textContainer = fileUpload.querySelector(".ant-upload-text");
  if (textContainer) {
    textContainer.innerHTML = `
      <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.5rem;">${file.name}</div>
      <div style="font-size: 0.875rem; color: var(--text-secondary);">
        ${(file.size / 1024).toFixed(2)} KB
      </div>
      <div style="font-size: 0.875rem; color: var(--primary-color); margin-top: 0.5rem; cursor: pointer;">
        点击或拖拽更换文件
      </div>
    `;
  }
  
  // 添加已选择样式
  fileUpload.classList.add("has-file");
}

// 更新T-4规则文件上传UI
export function updateT2RulesFileUploadUI(file) {
  const fileUpload = document.querySelector("#t2-rules-file-upload-form .file-upload");
  if (!fileUpload) return;

  // 更改图标为JSON文件图标
  const iconContainer = fileUpload.querySelector(".ant-upload-drag-icon");
  if (iconContainer) {
    iconContainer.innerHTML = '<i class="fas fa-file-code" style="font-size: 48px; color: #f39c12;"></i>';
  }

  // 更新文本显示文件名
  const textContainer = fileUpload.querySelector(".ant-upload-text");
  if (textContainer) {
    textContainer.innerHTML = `
      <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.5rem;">${file.name}</div>
      <div style="font-size: 0.875rem; color: var(--text-secondary);">
        ${(file.size / 1024).toFixed(2)} KB
      </div>
      <div style="font-size: 0.875rem; color: var(--primary-color); margin-top: 0.5rem; cursor: pointer;">
        点击或拖拽更换文件
      </div>
    `;
  }
  
  // 添加已选择样式
  fileUpload.classList.add("has-file");
}

// 渲染 T-4 Sheet 选择器
export function renderT2SheetSelector(sheetNames, onSelect) {
  const container = document.getElementById("t2-sheet-selector-container");
  const selector = document.getElementById("t2-sheet-selector");
  
  if (!container || !selector) return;
  
  // 清空选项
  selector.innerHTML = "";
  
  // 添加选项
  sheetNames.forEach(name => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = name;
    selector.appendChild(option);
  });
  
  // 显示容器
  container.style.display = "block";
  
  // 绑定事件
  // 移除旧的事件监听器 (通过克隆节点)
  const newSelector = selector.cloneNode(true);
  selector.parentNode.replaceChild(newSelector, selector);
  
  newSelector.addEventListener("change", (e) => {
    if (onSelect) {
      onSelect(e.target.value);
    }
  });

  // 默认选中第一个并触发回调
  if (sheetNames.length > 0 && onSelect) {
      // 稍微延迟一下，确保 UI 已经更新
      setTimeout(() => {
          onSelect(sheetNames[0]);
      }, 0);
  }
}

// 渲染T-4规则列表
export function renderT2RulesList(rules) {
  const container = document.getElementById("t2-rules-list-container");
  const list = document.getElementById("t2-rules-list");
  
  if (!container || !list) return;
  
  // 清空列表
  list.innerHTML = "";
  
  if (!rules || rules.length === 0) {
    container.style.display = "none";
    return;
  }
  
  // 显示容器
  container.style.display = "flex";
  container.style.flexDirection = "column";
  
  // 遍历规则并创建列表项
  rules.forEach((rule, index) => {
    const li = document.createElement("li");
    li.className = "rule-item";
    li.draggable = true; // 启用拖拽
    li.dataset.index = index; // 存储索引
    li.dataset.type = 't2'; // 标记为T-4规则
    
    // 拖拽事件
    li.addEventListener('dragstart', handleDragStart);
    li.addEventListener('dragover', handleDragOver);
    li.addEventListener('drop', handleDrop);
    li.addEventListener('dragenter', handleDragEnter);
    li.addEventListener('dragleave', handleDragLeave);
    li.addEventListener('dragend', handleDragEnd);
    
    // 规则名称
    const nameSpan = document.createElement("span");
    nameSpan.className = "rule-name";
    nameSpan.textContent = rule.name || `规则 ${index + 1}`;
    nameSpan.title = rule.description || rule.name || "";
    
    // 操作按钮容器
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "rule-actions";
    
    // 上移按钮
    const upBtn = document.createElement("button");
    upBtn.className = "rule-action-btn";
    upBtn.innerHTML = '<i class="fas fa-arrow-up"></i>';
    upBtn.title = "上移";
    upBtn.disabled = index === 0;
    upBtn.onclick = () => moveT2Rule(index, -1);
    
    // 下移按钮
    const downBtn = document.createElement("button");
    downBtn.className = "rule-action-btn";
    downBtn.innerHTML = '<i class="fas fa-arrow-down"></i>';
    downBtn.title = "下移";
    downBtn.disabled = index === rules.length - 1;
    downBtn.onclick = () => moveT2Rule(index, 1);
    
    actionsDiv.appendChild(upBtn);
    actionsDiv.appendChild(downBtn);
    
    li.appendChild(nameSpan);
    li.appendChild(actionsDiv);
    list.appendChild(li);
  });
}

// 更新数据分析文件上传UI
export function updateAnalysisFileUploadUI(file) {
  const fileUpload = document.querySelector("#analysis-file-upload-form .file-upload");
  if (!fileUpload) return;

  // 更改图标为Excel文件图标
  const iconContainer = fileUpload.querySelector(".ant-upload-drag-icon");
  if (iconContainer) {
    iconContainer.innerHTML = Icons.fileExcelAlt;
    iconContainer.querySelector('svg').style.color = '#107c41';
  }

  // 更新文本显示文件名
  const textContainer = fileUpload.querySelector(".ant-upload-text");
  if (textContainer) {
    textContainer.innerHTML = `
      <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.5rem;">${file.name}</div>
      <div style="font-size: 0.875rem; color: var(--text-secondary);">
        ${(file.size / 1024).toFixed(2)} KB
      </div>
      <div style="font-size: 0.875rem; color: var(--primary-color); margin-top: 0.5rem; cursor: pointer;">
        点击或拖拽更换文件
      </div>
    `;
  }
  
  // 添加已选择样式
  fileUpload.classList.add("has-file");
}

// 渲染规则列表
export function renderRulesList(rules) {
  const container = document.getElementById("rules-list-container");
  const list = document.getElementById("rules-list");
  
  if (!container || !list) return;
  
  // 清空列表
  list.innerHTML = "";
  
  if (!rules || rules.length === 0) {
    container.style.display = "none";
    return;
  }
  
  // 显示容器
  container.style.display = "flex";
  container.style.flexDirection = "column";
  
  // 遍历规则并创建列表项
  rules.forEach((rule, index) => {
    const li = document.createElement("li");
    li.className = "rule-item";
    li.draggable = true; // 启用拖拽
    li.dataset.index = index; // 存储索引
    
    // 拖拽事件
    li.addEventListener('dragstart', handleDragStart);
    li.addEventListener('dragover', handleDragOver);
    li.addEventListener('drop', handleDrop);
    li.addEventListener('dragenter', handleDragEnter);
    li.addEventListener('dragleave', handleDragLeave);
    li.addEventListener('dragend', handleDragEnd);
    
    // 规则名称
    const nameSpan = document.createElement("span");
    nameSpan.className = "rule-name";
    nameSpan.textContent = rule.name || `规则 ${index + 1}`;
    nameSpan.title = rule.description || rule.name || "";
    
    // 操作按钮容器
    const actionsDiv = document.createElement("div");
    actionsDiv.className = "rule-actions";
    
    // 上移按钮
    const upBtn = document.createElement("button");
    upBtn.className = "rule-action-btn";
    upBtn.innerHTML = '<i class="fas fa-arrow-up"></i>';
    upBtn.title = "上移";
    upBtn.disabled = index === 0;
    upBtn.onclick = () => moveRule(index, -1);
    
    // 下移按钮
    const downBtn = document.createElement("button");
    downBtn.className = "rule-action-btn";
    downBtn.innerHTML = '<i class="fas fa-arrow-down"></i>';
    downBtn.title = "下移";
    downBtn.disabled = index === rules.length - 1;
    downBtn.onclick = () => moveRule(index, 1);
    
    actionsDiv.appendChild(upBtn);
    actionsDiv.appendChild(downBtn);
    
    li.appendChild(nameSpan);
    li.appendChild(actionsDiv);
    list.appendChild(li);
  });
}

// 拖拽相关变量
let dragSrcEl = null;

// 拖拽开始
function handleDragStart(e) {
  dragSrcEl = this;
  e.dataTransfer.effectAllowed = 'move';
  e.dataTransfer.setData('text/html', this.innerHTML);
  this.classList.add('dragging');
}

// 拖拽经过
function handleDragOver(e) {
  if (e.preventDefault) {
    e.preventDefault();
  }
  e.dataTransfer.dropEffect = 'move';
  return false;
}

// 拖拽进入
function handleDragEnter(e) {
  this.classList.add('over');
}

// 拖拽离开
function handleDragLeave(e) {
  this.classList.remove('over');
}

// 拖拽放置
function handleDrop(e) {
  if (e.stopPropagation) {
    e.stopPropagation();
  }

  if (dragSrcEl !== this) {
    const fromIndex = parseInt(dragSrcEl.dataset.index);
    const toIndex = parseInt(this.dataset.index);
    const type = this.dataset.type; // 获取规则类型
    
    // 移动规则
    if (type === 't2') {
      moveT2RuleTo(fromIndex, toIndex);
    } else {
      moveRuleTo(fromIndex, toIndex);
    }
  }
  
  return false;
}

// 拖拽结束
function handleDragEnd(e) {
  this.classList.remove('dragging');
  
  const items = document.querySelectorAll('.rule-item');
  items.forEach(function (item) {
    item.classList.remove('over');
  });
}

// 移动规则到指定位置
export function moveRuleTo(fromIndex, toIndex) {
  if (!appState.custom_rules) return;
  
  // 移除元素
  const [removed] = appState.custom_rules.splice(fromIndex, 1);
  // 插入元素
  appState.custom_rules.splice(toIndex, 0, removed);
  
  // 重新渲染列表
  renderRulesList(appState.custom_rules);
}

// 移动规则
export function moveRule(index, direction) {
  if (!appState.custom_rules) return;
  
  const newIndex = index + direction;
  
  // 检查边界
  if (newIndex < 0 || newIndex >= appState.custom_rules.length) return;
  
  // 交换元素
  const temp = appState.custom_rules[index];
  appState.custom_rules[index] = appState.custom_rules[newIndex];
  appState.custom_rules[newIndex] = temp;
  
  // 重新渲染列表
  renderRulesList(appState.custom_rules);
}

// 移动T-4规则到指定位置
export function moveT2RuleTo(fromIndex, toIndex) {
  if (!appState.t2_custom_rules) return;
  
  // 移除元素
  const [removed] = appState.t2_custom_rules.splice(fromIndex, 1);
  // 插入元素
  appState.t2_custom_rules.splice(toIndex, 0, removed);
  
  // 重新渲染列表
  renderT2RulesList(appState.t2_custom_rules);
}

// 移动T-4规则
export function moveT2Rule(index, direction) {
  if (!appState.t2_custom_rules) return;
  
  const newIndex = index + direction;
  
  // 检查边界
  if (newIndex < 0 || newIndex >= appState.t2_custom_rules.length) return;
  
  // 交换元素
  const temp = appState.t2_custom_rules[index];
  appState.t2_custom_rules[index] = appState.t2_custom_rules[newIndex];
  appState.t2_custom_rules[newIndex] = temp;
  
  // 重新渲染列表
  renderT2RulesList(appState.t2_custom_rules);
}

// 渲染 Markdown 内容并处理 Mermaid
export function renderMarkdownContent(container, markdownText) {
  if (!container) return;

  let html;
  // 使用 marked 库解析 Markdown (如果可用)
  if (window.marked) {
    // 配置 marked 选项
    marked.setOptions({
      gfm: true, // 启用 GitHub Flavored Markdown
      breaks: true, // 启用换行符转 <br>
      headerIds: true, // 启用标题 ID
      mangle: false // 禁用标题 ID 混淆
    });
    html = marked.parse(markdownText);
  } else {
    // 降级使用简单的解析器
    html = parseMarkdown(markdownText);
  }
  
  container.innerHTML = html;

  // 处理 Mermaid 图表
  processMermaidDiagrams(container);
}

// 动态加载 Mermaid 库
async function loadMermaid() {
  if (window.mermaid) return window.mermaid;

  return new Promise((resolve, reject) => {
    console.log("正在从 CDN 加载 Mermaid 库...");
    // 优先使用 CDN 加载, 减少插件体积
    const cdnScript = document.createElement('script');
    cdnScript.src = 'https://cdn.jsdelivr.net/npm/mermaid@10.6.1/dist/mermaid.min.js';
    cdnScript.onload = () => {
      console.log("Mermaid 库从 CDN 加载成功");
      resolve(window.mermaid);
    };
    cdnScript.onerror = (err) => {
      console.error("Mermaid 库从 CDN 加载失败:", err);
      // CDN 失败时尝试本地加载作为备选
      console.log("尝试从本地加载 Mermaid...");
      const script = document.createElement('script');
      script.src = 'lib/js/mermaid.min.js';
      script.onload = () => {
        console.log("Mermaid 库本地加载成功");
        resolve(window.mermaid);
      };
      script.onerror = (e) => {
        console.error("Mermaid 库本地加载也失败:", e);
        reject(new Error("无法加载 Mermaid 库"));
      };
      document.head.appendChild(script);
    };
    document.head.appendChild(cdnScript);
  });
}

// 处理 Mermaid 图表
async function processMermaidDiagrams(container) {
  // 收集所有需要渲染的 Mermaid 节点信息
  const nodesToProcess = [];
  console.log("processMermaidDiagrams");
  // 1. 处理 marked 生成的 <pre><code class="language-mermaid">
  container.querySelectorAll('code.language-mermaid').forEach(code => {
    const pre = code.parentElement;
    if (pre.tagName === 'PRE') {
        nodesToProcess.push({
            element: pre,
            code: code.textContent // 获取原始代码
        });
    }
  });

  // 2. 处理 parseMarkdown 生成的 <pre class="mermaid">
  container.querySelectorAll('pre.mermaid').forEach(pre => {
      nodesToProcess.push({
          element: pre,
          code: pre.textContent // 获取原始代码
      });
  });

  if (nodesToProcess.length === 0) return;

  console.log("processMermaidDiagrams: 检查 mermaid 是否可用");
  
  // 确保 Mermaid 已加载
  if (!window.mermaid) {
    try {
      await loadMermaid();
    } catch (error) {
      console.error("Mermaid 加载失败，无法渲染图表:", error);
      nodesToProcess.forEach(({ element }) => {
        element.innerHTML = `<div style="color: red; padding: 10px; border: 1px solid red;">无法加载流程图组件 (Mermaid)</div>`;
      });
      return;
    }
  }

  console.log("processMermaidDiagrams: mermaid 可用", window.mermaid);

  // 初始化 Mermaid (如果尚未初始化)
  // 注意：mermaid.initialize 应该只调用一次，或者在配置变更时调用
  // 这里我们做一个简单的检查，避免重复初始化导致的问题
  if (!window.mermaidInitialized) {
    try {
      mermaid.initialize({
        startOnLoad: false, // 手动初始化
        theme: 'base', // 使用 base 主题以便自定义
        themeVariables: {
          primaryColor: '#e6f7ff',
          primaryTextColor: '#000000',
          primaryBorderColor: '#1890ff',
          lineColor: '#5c5c5c',
          secondaryColor: '#fff1b8',
          tertiaryColor: '#fff',
          fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif'
        },
        flowchart: {
          curve: 'basis', // 使用平滑曲线
          padding: 20,
          htmlLabels: true
        },
        securityLevel: 'loose',
        logLevel: 'error'
      });
      window.mermaidInitialized = true;
    } catch (e) {
      console.error('Mermaid 初始化配置失败:', e);
    }
  }
      
  // 逐个渲染
  nodesToProcess.forEach(async ({ element, code }, index) => {
    // 创建容器 div
    const div = document.createElement('div');
    div.className = 'mermaid';
    // 初始状态样式
    div.style.display = 'flex';
    div.style.justifyContent = 'center';
    div.style.padding = '20px';
    div.innerHTML = '<div style="color: #666;"><i class="fas fa-spinner fa-spin"></i> 正在渲染流程图...</div>';
    
    // 替换原元素
    element.replaceWith(div);

    const id = `mermaid-svg-${Date.now()}-${index}`;
    try {
        // 清理代码，去除首尾空白
        const cleanCode = code.trim();
        
        // 渲染
        // 检查是否支持 mermaid.render (v10+)
        if (typeof mermaid.render === 'function') {
            const { svg } = await mermaid.render(id, cleanCode);
            div.innerHTML = svg;
        } else {
            // 旧版本兼容 (v9-)
            // 旧版本 render 通常是 render(id, txt, cb)
            mermaid.render(id, cleanCode, (svg) => {
                div.innerHTML = svg;
            });
        }
        
        // 渲染成功后移除临时样式
        div.style.padding = '';
    } catch (error) {
        console.error(`Mermaid 图表 [${id}] 渲染错误:`, error);
        
        // 尝试解析错误行号
        // Error message example: "Parse error on line 2: ..."
        const lineMatch = error.message && error.message.match(/line\s+(\d+)/i);
        let errorLine = -1;
        if (lineMatch) {
            errorLine = parseInt(lineMatch[1], 10);
            console.log(`%c检测到错误发生在第 ${errorLine} 行`, 'color: red; font-weight: bold; font-size: 14px;');
        }

        console.group('Mermaid 出错代码详情');
        const lines = code.split('\n');
        lines.forEach((line, idx) => {
            const lineNum = idx + 1;
            const isErrorLine = lineNum === errorLine;
            const prefix = isErrorLine ? '>> ' : '   ';
            const style = isErrorLine ? 'color: red; font-weight: bold; background: #ffe6e6;' : 'color: gray;';
            console.log(`%c${prefix}${lineNum.toString().padEnd(3)}| ${line}`, style);
        });
        console.groupEnd();
        
        // 显示错误信息
        div.innerHTML = `
            <div style="text-align: left; color: #ff4d4f; padding: 16px; border: 1px solid #ffccc7; background-color: #fff2f0; border-radius: 4px; width: 100%; overflow: auto;">
                <div style="font-weight: bold; margin-bottom: 8px;">
                    <i class="fas fa-exclamation-circle"></i> 流程图渲染失败
                </div>
                <div style="font-family: monospace; font-size: 12px; margin-bottom: 8px;">${error.message || '未知错误'}</div>
                <details>
                    <summary style="cursor: pointer; color: #1890ff; font-size: 12px;">查看原始代码</summary>
                    <pre style="margin-top: 8px; background: rgba(0,0,0,0.05); padding: 8px; border-radius: 4px; font-size: 12px; white-space: pre-wrap;">${code.replace(/</g, '<').replace(/>/g, '>')}</pre>
                </details>
            </div>
        `;
        div.style.display = 'block'; // 错误信息块级显示
    }
  });
}

// 加载 README.md
async function loadReadme() {
  const readmeContainer = document.getElementById('readme-content');
  if (!readmeContainer) return;

  try {
    const response = await fetch('docs/README.md');
    if (response.ok) {
      const text = await response.text();
      renderMarkdownContent(readmeContainer, text);
      appState.readme_loaded = true;
    } else {
      readmeContainer.innerHTML = '<p style="color: var(--error-color);">加载说明文档失败</p>';
    }
  } catch (error) {
    console.error('加载README失败:', error);
    readmeContainer.innerHTML = '<p style="color: var(--error-color);">加载说明文档出错</p>';
  }
}

// 加载 LTS Fallout Summary
async function loadLTSSummary() {
  const container = document.getElementById('lts-summary-content');
  if (!container) return;

  try {
    const response = await fetch('docs/LTS_Fallout_Summary.md');
    if (response.ok) {
      const text = await response.text();
      renderMarkdownContent(container, text);
      appState.lts_summary_loaded = true;
    } else {
      container.innerHTML = '<p style="color: var(--error-color);">加载 LTS Fallout Summary 失败</p>';
    }
  } catch (error) {
    console.error('加载 LTS Fallout Summary 失败:', error);
    container.innerHTML = '<p style="color: var(--error-color);">加载 LTS Fallout Summary 出错</p>';
  }
}

// 更新午餐文件上传UI
export function updateLunchFileUploadUI(file) {
  const fileUpload = document.querySelector("#lunch-file-upload-form .file-upload");
  if (!fileUpload) return;

  // 更改图标
  const iconContainer = fileUpload.querySelector(".ant-upload-drag-icon");
  if (iconContainer) {
    iconContainer.innerHTML = '<i class="fas fa-utensils" style="font-size: 48px; color: #faad14;"></i>';
  }

  // 更新文本显示文件名
  const textContainer = fileUpload.querySelector(".ant-upload-text");
  if (textContainer) {
    textContainer.innerHTML = `
      <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.5rem;">${file.name}</div>
      <div style="font-size: 0.875rem; color: var(--text-secondary);">
        ${(file.size / 1024).toFixed(2)} KB
      </div>
      <div style="font-size: 0.875rem; color: var(--primary-color); margin-top: 0.5rem; cursor: pointer;">
        点击或拖拽更换文件
      </div>
    `;
  }
  
  // 添加已选择样式
  fileUpload.classList.add("has-file");
}

// 显示午餐结果
export function showLunchResult(place) {
    const container = document.getElementById("lunch-result-container");
    if (!container) return;

    // 简单的动画效果
    container.style.opacity = '0';
    container.style.transform = 'scale(0.8)';
    
    setTimeout(() => {
        let content = '';
        if (typeof place === 'string') {
            content = `<h2 style="color: #faad14; margin: 0; font-size: 28px;">${place}</h2>`;
        } else if (typeof place === 'object') {
            content = `<h2 style="color: #faad14; margin: 0; font-size: 28px;">${place.name || '未知地点'}</h2>`;
            if (place.description) {
                content += `<p style="color: #666; margin-top: 10px; font-size: 16px;">${place.description}</p>`;
            }
            if (place.tags && Array.isArray(place.tags)) {
                content += `<div style="margin-top: 10px;">${place.tags.map(tag => `<span class="ant-tag ant-tag-orange">${tag}</span>`).join('')}</div>`;
            }
        }

        container.innerHTML = `
            <div style="text-align: center; padding: 30px; background: #fffbe6; border: 2px dashed #ffe58f; border-radius: 8px; box-shadow: 0 4px 12px rgba(250, 173, 20, 0.15);">
                <div style="font-size: 48px; margin-bottom: 20px;">🎉</div>
                <div style="margin-bottom: 10px; color: #8c8c8c;">今天中午吃这个：</div>
                ${content}
            </div>
        `;
        
        container.style.display = 'block';
        
        // 触发重绘
        container.offsetHeight;
        
        container.style.transition = 'all 0.5s cubic-bezier(0.175, 0.885, 0.32, 1.275)';
        container.style.opacity = '1';
        container.style.transform = 'scale(1)';
    }, 50);
}

// 全局 Handsontable 实例 for Bulk Jobs
let bulkJobsHot = null;

// 渲染 Bulk Jobs 表格
export function renderBulkJobsTable(data) {
    const container = document.getElementById("bulk-jobs-container");
    const table = document.getElementById("bulk-jobs-table");
    const loadingEl = document.getElementById("bulk-jobs-loading");
    const emptyEl = document.getElementById("bulk-jobs-empty");
    
    // 隐藏 loading
    if (loadingEl) {
        loadingEl.style.display = "none";
    }
    
    // 销毁旧实例
    if (bulkJobsHot) {
        bulkJobsHot.destroy();
        bulkJobsHot = null;
    }
    
    if (!data || data.length === 0) {
        if (container) container.style.display = "none";
        if (emptyEl) emptyEl.style.display = "block";
        return;
    }
    
    // 显示容器，隐藏空状态
    if (container) container.style.display = "block";
    if (emptyEl) emptyEl.style.display = "none";
    
    // 准备表格列 - 只显示关键字段
    const displayFields = ['id', 'operation', 'state', 'query', 'createdDate', 'numberOfRecordsProcessed', 'numberOfRecordsFailed', 'totalProcessingTime'];
    
    // 过滤存在的字段
    const availableFields = displayFields.filter(field => data.length > 0 && data[0].hasOwnProperty(field));
    
    // 如果没有可用字段，使用所有字段
    const fieldsToUse = availableFields.length > 0 ? availableFields : Object.keys(data[0]);
    
    const tableColumns = fieldsToUse.map(col => ({
        title: col,
        data: col
    }));
    
    // 配置 Handsontable
    const hotConfig = {
        data: data,
        columns: tableColumns,
        colHeaders: true,
        rowHeaders: true,
        stretchH: 'all',
        autoWrapRow: true,
        autoWrapCol: true,
        maxRows: 100,
        width: '100%',
        height: 'auto',
        licenseKey: 'non-commercial-and-evaluation',
        filters: true,
        dropdownMenu: true,
        sortIndicator: true,
        manualColumnResize: true,
        manualRowResize: true,
        search: true,
        contextMenu: true,
        readOnly: true // 只读
    };
    
    // 创建 Handsontable 实例
    bulkJobsHot = new Handsontable(table, hotConfig);
}

// 显示 Bulk Jobs 加载状态
export function showBulkJobsLoading() {
    const loadingEl = document.getElementById("bulk-jobs-loading");
    const container = document.getElementById("bulk-jobs-container");
    const emptyEl = document.getElementById("bulk-jobs-empty");
    
    if (loadingEl) loadingEl.style.display = "block";
    if (container) container.style.display = "none";
    if (emptyEl) emptyEl.style.display = "none";
}

// 子菜单配置
export const submenuConfig = {
    'lts': {
        title: 'LTS',
        icon: 'fas fa-cubes',
        items: [
            { step: 5, text: '概览', icon: 'fas fa-home' },
            { step: 2, text: '获取当日数据', icon: 'fas fa-calendar-day' },
            { step: 3, text: '获取报表数据', icon: 'fas fa-chart-bar' },
            { step: 4, text: '获取文件数据', icon: 'fas fa-file-upload' },
            { step: 10, text: '数据分析', icon: 'fas fa-chart-pie' },
            { step: 9, text: 'VVIP', icon: 'fas fa-star' },
            { step: 12, text: 'T-4 Outstanding', icon: 'fas fa-file-alt' },
            { step: 13, text: 'T-4 Outstanding分析', icon: 'fas fa-chart-line' }
        ]
    },
    'ott': {
        title: 'OTT',
        icon: 'fas fa-tv',
        items: [
            { step: 7, text: 'OTT', icon: 'fas fa-tv' }
        ]
    },
    'pcd': {
        title: 'PCD',
        icon: 'fas fa-laptop-code',
        items: [
            { step: 8, text: 'PCD', icon: 'fas fa-laptop-code' },
            { step: 16, text: 'Data issue - PID fallout', icon: 'fas fa-exclamation-triangle' },
            { step: 17, text: 'Data issue - QC issue', icon: 'fas fa-search' }
        ]
    },
    'cvp7': {
        title: 'CVP7',
        icon: 'fas fa-network-wired',
        items: [
            { step: 11, text: 'CVP7', icon: 'fas fa-network-wired' }
        ]
    },
    'tools': {
        title: 'Tools',
        icon: 'fas fa-tools',
        items: [
            { step: 15, text: 'Bulk 操作', icon: 'fas fa-database' },
            { step: 14, text: '中午食乜', icon: 'fas fa-utensils' },
            { step: 18, text: 'Execute Anonymous', icon: 'fas fa-code' }
        ]
    },
    'settings': {
        title: '设置',
        icon: 'fas fa-cog',
        items: [
            { step: 6, text: '版本信息', icon: 'fas fa-info-circle' }
        ]
    }
};

// 更新横向菜单栏
export function updateHorizontalTabs(activeModule) {
    const tabsContainer = document.getElementById("horizontal-tabs");
    const tabsContent = document.getElementById("horizontal-tabs-content");
    
    if (!tabsContainer || !tabsContent) return;
    
    // 如果没有传入活跃模块，检查当前显示的section
    if (!activeModule) {
        const visibleSection = document.querySelector('.step-section[style*="display: block"]');
        if (visibleSection) {
            const sectionId = visibleSection.id;
            // 根据sectionId判断当前模块
            const sectionToModule = {
                'section-5': 'lts', 'section-2': 'lts', 'section-3': 'lts',
                'section-4': 'lts', 'section-10': 'lts', 'section-9': 'lts',
                'section-12': 'lts', 'section-13': 'lts',
                'section-7': 'ott',
                'section-8': 'pcd',
                'section-11': 'cvp7',
                'section-15': 'tools',
                'section-14': 'tools'
            };
            activeModule = sectionToModule[sectionId];
        }
    }
    
    // 清空内容
    tabsContent.innerHTML = '';
    
    // 如果没有活跃模块，隐藏横向菜单栏
    if (!activeModule || !submenuConfig[activeModule]) {
        tabsContainer.style.display = 'none';
        return;
    }
    
    // 显示横向菜单栏
    tabsContainer.style.display = 'block';
    
    const config = submenuConfig[activeModule];
    
    // 添加模块标题
    const moduleTitle = document.createElement("div");
    moduleTitle.className = 'horizontal-tab-module-title';
    moduleTitle.innerHTML = `<i class="${config.icon}"></i> ${config.title}`;
    tabsContent.appendChild(moduleTitle);
    
    // 添加子菜单项
    config.items.forEach(item => {
        // 处理分隔线
        if (item.divider) {
            const divider = document.createElement("div");
            divider.className = 'horizontal-tab-divider';
            tabsContent.appendChild(divider);
            return;
        }
        
        const tabItem = document.createElement("a");
        tabItem.href = "#";
        tabItem.className = 'horizontal-tab-item';
        tabItem.dataset.step = item.step;
        tabItem.innerHTML = `<i class="${item.icon}"></i> ${item.text}`;
        
        // 检查是否为当前激活的section
        const currentSection = document.getElementById(`section-${item.step}`);
        if (currentSection && currentSection.style.display === 'block') {
            tabItem.classList.add('active');
        }
        
        tabsContent.appendChild(tabItem);
    });
}

// 根据section number更新横向菜单栏
function updateHorizontalTabsFromSection(sectionNumber) {
    // 根据sectionNumber确定模块
    const sectionToModule = {
        1: null,    // 连接设置 - 已移除，不显示横向菜单
        2: 'lts',   // 获取当日数据
        3: 'lts',   // 获取报表数据
        4: 'lts',   // 获取文件数据
        5: 'lts',   // LTS 概览
        6: 'settings', // 版本信息 - 显示设置横向菜单
        7: 'ott',   // OTT
        8: 'pcd',   // PCD
        9: 'lts',   // VVIP
        10: 'lts',  // 数据分析
        11: 'cvp7', // CVP7
        12: 'lts',  // T-4 Outstanding
        13: 'lts',  // T-4 Outstanding分析
        14: 'tools',// 中午食乜
        15: 'tools', // Bulk 操作
        16: 'pcd',  // PCD PID Fallout
        17: 'pcd',  // PCD QC Issue
        18: 'tools'  // Execute Anonymous
    };
    
    const activeModule = sectionToModule[sectionNumber];
    updateHorizontalTabs(activeModule);
}

// 初始化横向菜单栏点击事件
export function initHorizontalTabsEvents() {
    const tabsContent = document.getElementById("horizontal-tabs-content");
    if (!tabsContent) return;
    
    tabsContent.addEventListener("click", (e) => {
        const tabItem = e.target.closest(".horizontal-tab-item");
        if (tabItem) {
            const step = parseInt(tabItem.dataset.step);
            if (step && typeof showSection === 'function') {
                showSection(step);
            }
        }
    });
}