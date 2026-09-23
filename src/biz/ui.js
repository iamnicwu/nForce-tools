import { createLogger } from "../common/logger.js";

const log = createLogger("UI");
import { appState } from "./state.js";
import { Icons } from "../common/icons.js";
import { renderTable } from "../common/table_utils.js";
import { showNotification, parseMarkdown, escapeHtml } from "../common/utils.js";
import {
    DEFAULT_LUNCH_PLACES
} from "./ui_config.js";

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

// Resize 事件监听器引用，用于防止重复注册
let analysisResizeListener = null;
let t2AnalysisResizeListener = null;

// 显示对应功能（v3.2：从首页进入详情页，一次只显示一个功能）
export function showSection(sectionNumber) {
  log.debug(`showSection called with sectionNumber=${sectionNumber}, is_connected=${appState.is_connected}`);

  // 未连接时仅允许访问连接设置(1)、版本信息(6)、布局配置(20)与设置(21)
  if (!appState.is_connected && ![1, 6, 20, 21].includes(sectionNumber)) {
    log.debug(`Section ${sectionNumber} requires connection`);
    showNotification("请先完成 Salesforce 连接", "warning");
    showSection(1);
    return;
  }

  const target = document.getElementById(`section-${sectionNumber}`);
  if (!target) {
    log.error(`[ERROR] Section ${sectionNumber} not found`);
    return;
  }

  // 懒加载：版本信息 README
  if (sectionNumber === 6 && !appState.readme_loaded) {
    loadReadme();
  }

  // 懒加载：LTS Summary
  if (sectionNumber === 5 && !appState.lts_summary_loaded) {
    loadLTSSummary();
  }

  // 懒加载：Schedule Jobs 列表
  if (sectionNumber === 19) {
    import('./logic.js').then((logicModule) => {
      if (logicModule.loadScheduleJobs) {
        logicModule.loadScheduleJobs();
      }
    });
  }

  // 懒加载：Session 链接 / 连接信息（每次进入都按当前连接状态重新渲染）
  if (sectionNumber === 22) {
    import('./session_info.js').then((m) => {
      if (m.renderSessionInfo) m.renderSessionInfo();
    });
  }

  // 切换视图：隐藏首页，显示该功能
  document.querySelectorAll(".step-section").forEach((section) => {
    section.classList.remove("active");
  });
  target.classList.add("active");
  enterDetailView(sectionNumber);
}

// 进入详情页
function enterDetailView(sectionNumber) {
  const launcher = document.getElementById("launcher-view");
  const detail = document.getElementById("detail-view");
  if (launcher) launcher.style.display = "none";
  if (detail) detail.style.display = "block";

  // 返回按钮并入当前功能卡片头部（不单独占一行）：
  // #detail-back 从隐藏宿主移入该 section 的 .ant-card-head-wrapper 最前面，
  // 卡片自身的标题就是页面标题，无需再维护一份 detail-title
  const target = document.getElementById(`section-${sectionNumber}`);
  const backBtn = document.getElementById("detail-back");
  const backHost = document.getElementById("detail-back-host");
  const cardHeadWrapper = target
    ? target.querySelector(":scope > .ant-card-head > .ant-card-head-wrapper")
    : null;
  if (backBtn) {
    if (cardHeadWrapper && backBtn.parentElement !== cardHeadWrapper) {
      cardHeadWrapper.insertBefore(backBtn, cardHeadWrapper.firstChild);
    } else if (backHost && backBtn.parentElement !== backHost) {
      backHost.appendChild(backBtn);
    }
  }

  setActiveTile(sectionNumber);

  const pageContent = document.querySelector(".page-content");
  if (pageContent) pageContent.scrollTop = 0;

  // 通知各模块「已进入某个功能」，布局配置页借此刷新 JSON 编辑器内容
  window.dispatchEvent(new CustomEvent("nforce:section", { detail: { section: sectionNumber } }));
}

// 返回首页（功能图标列表）
export function goHome() {
  const launcher = document.getElementById("launcher-view");
  const detail = document.getElementById("detail-view");
  if (detail) detail.style.display = "none";
  if (launcher) launcher.style.display = "block";

  document.querySelectorAll(".step-section").forEach((section) => {
    section.classList.remove("active");
  });

  // 返回按钮放回隐藏宿主，下次进入其他功能时再移入对应卡片
  const backBtn = document.getElementById("detail-back");
  const backHost = document.getElementById("detail-back-host");
  if (backBtn && backHost && backBtn.parentElement !== backHost) {
    backHost.appendChild(backBtn);
  }

  setActiveTile(null);

  const pageContent = document.querySelector(".page-content");
  if (pageContent) pageContent.scrollTop = 0;

  // 通知首页（用于退出「常用功能」编辑态等收尾动作）
  window.dispatchEvent(new CustomEvent("nforce:home"));
}

// 高亮当前进入的功能图标
function setActiveTile(sectionNumber) {
  document.querySelectorAll(".tile").forEach((tile) => {
    const step = parseInt(tile.getAttribute("data-step"));
    tile.classList.toggle("active", sectionNumber !== null && step === sectionNumber);
  });
}

// 兼容旧调用名
export function updateActiveSidebarLink(stepNumber) {
  setActiveTile(stepNumber);
}

// 初始化首页：返回按钮 + 快捷键
export function initLauncher() {
  const backBtn = document.getElementById("detail-back");
  if (backBtn) {
    backBtn.addEventListener("click", goHome);
  }

  document.addEventListener("keydown", (e) => {
    const detail = document.getElementById("detail-view");
    const inDetail = detail && detail.style.display !== "none";
    if (e.key === "Escape" && inDetail) {
      goHome();
    }
  });
}

// 根据连接状态切换功能section与首页图标的锁定样式
function refreshSectionLocks() {
  if (!appState.is_connected) return;
  document.querySelectorAll(".step-section.needs-connection").forEach((section) => {
    section.classList.remove("needs-connection");
  });
  document.querySelectorAll(".tile.locked").forEach((tile) => {
    tile.classList.remove("locked");
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
  }

  // 更新连接状态
  if (appState.is_connected) {
    const connectionSuccess = document.getElementById("connection-success");
    if (connectionSuccess) {
      connectionSuccess.style.display = "flex";
    }
    
    // 更新连接状态徽章
    const connectionStatusBadge = document.getElementById("connection-status-badge");
    if (connectionStatusBadge) {
      connectionStatusBadge.textContent = "已连接";
      connectionStatusBadge.className = "ant-tag ant-tag-success";
    }
    
    // 更新统计数据
    updateStats();

    // 连接成功后，解锁所有功能section
    refreshSectionLocks();
  } else {
    // 未连接时，更新连接状态徽章为未连接
    const connectionStatusBadge = document.getElementById("connection-status-badge");
    if (connectionStatusBadge) {
      connectionStatusBadge.textContent = "未连接";
      connectionStatusBadge.className = "ant-tag";
    }

    // 未连接时，锁定所有功能section
    refreshSectionLocks();
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
    // 显示导出按钮
    const exportT2AnalysisBtn = document.getElementById("export-t2-analysis-data");
    if (exportT2AnalysisBtn) {
      exportT2AnalysisBtn.style.display = "inline-block";
    }
  } else if (!appState.is_connected) {
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
    const fileUploadBadge = document.getElementById("file-upload-badge");
    if (fileUploadBadge) {
      fileUploadBadge.style.display = "inline-block";
      fileUploadBadge.className = "ant-tag ant-tag-success";
    }

    // 显示"显示最新数据"按钮
    const getLatestDataBtn = document.getElementById("get-latest-data-btn");
    if (getLatestDataBtn) {
      getLatestDataBtn.style.display = "inline-block";
    }
  } else if (!appState.is_connected) {
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
        avatarEl.style.backgroundColor = "var(--warning-color)"; // 黄色 - UAT/Sandbox
        avatarEl.title = "Sandbox Environment";
      } else {
        avatarEl.style.backgroundColor = "var(--error-color)"; // 红色 - Production
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
  
  // 更新连接状态
  const connectionStatusEl = document.getElementById("user-connection-status");
  if (connectionStatusEl) {
    connectionStatusEl.textContent = appState.is_connected ? "已连接" : "未连接";
    connectionStatusEl.className = `value ${appState.is_connected ? "text-success" : "text-error"}`;
  }
  
  // 更新系统环境
  const systemEnvironmentEl = document.getElementById("user-system-environment");
  if (systemEnvironmentEl) {
    if (appState.orgInfo) {
      systemEnvironmentEl.textContent = appState.orgInfo.IsSandbox ? "Sandbox (UAT)" : "Production";
      systemEnvironmentEl.className = `value ${appState.orgInfo.IsSandbox ? "text-warning" : "text-success"}`;
    } else {
      systemEnvironmentEl.textContent = "-";
      systemEnvironmentEl.className = "value";
    }
  }

  // 更新顶部导航栏系统环境指示器
  const envIndicator = document.getElementById("env-indicator");
  const envBadge = document.getElementById("env-badge");
  if (envIndicator && envBadge) {
    if (appState.orgInfo) {
      envIndicator.style.display = "flex";
      if (appState.orgInfo.IsSandbox) {
        envBadge.textContent = "Sandbox";
        envBadge.className = "ant-tag ant-tag-warning";
        envBadge.title = "当前环境: Sandbox (UAT)";
      } else {
        envBadge.textContent = "Production";
        envBadge.className = "ant-tag ant-tag-error";
        envBadge.title = "当前环境: Production";
      }
    } else {
      envIndicator.style.display = "none";
    }
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

  pcdPidFalloutDataHot = renderTable("pcd-pid-fallout-data-container", "pcd-pid-fallout-data-table" , data, pcdPidFalloutDataHot);
  
}

// 渲染 PCD QC Issue 数据
export function renderPCDQCIssueData(data) {

  // 渲染 QC issue 数据
  pcdQCIssueDataHot = renderTable("pcd-qc-issue-data-container","pcd-qc-issue-data-table", data, pcdQCIssueDataHot);
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
  t2AnalysisDataHot = renderTable("t2-analysis-data-container","t2-analysis-data-table" , data, t2AnalysisDataHot);
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

  // 监听窗口大小变化 - 先移除旧的监听器，防止重复注册
  if (t2AnalysisResizeListener) {
    window.removeEventListener('resize', t2AnalysisResizeListener);
  }
  t2AnalysisResizeListener = function() {
    if (t2AnalysisChartStatus) t2AnalysisChartStatus.resize();
    if (t2AnalysisChartFulfillment) t2AnalysisChartFulfillment.resize();
  };
  window.addEventListener('resize', t2AnalysisResizeListener);
}

// 渲染最新数据
export function renderLatestData(data) {
  latestDataHot = renderTable("latest-data-container", "latest-data-table", data, latestDataHot);
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
      barChartDom.innerHTML = '<div style="display:flex;justify-content:center;align-items:center;height:100%;color:var(--text-secondary);">未找到 "Latest Action By" 相关字段</div>';
    }
  }
  
  // 监听窗口大小变化 - 先移除旧的监听器，防止重复注册
  if (analysisResizeListener) {
    window.removeEventListener('resize', analysisResizeListener);
  }
  analysisResizeListener = function() {
    if (analysisChart) analysisChart.resize();
    if (analysisBarChart) analysisBarChart.resize();
  };
  window.addEventListener('resize', analysisResizeListener);
}

// 更新文件上传UI
export function updateFileUploadUI(file) {
  const fileUpload = document.querySelector("#file-upload-form .upload-drag-wrapper");
  if (!fileUpload) return;
    // 更改图标为Excel文件图标
  const iconContainer = fileUpload.querySelector(".ant-upload-drag-icon");
  if (iconContainer) {
    iconContainer.innerHTML = Icons.fileExcelAlt;
    iconContainer.querySelector('svg').style.color = 'var(--brand-excel)';
  }

  // 更新文本显示文件名
  const textContainer = fileUpload.querySelector(".ant-upload-text");
  if (textContainer) {
    textContainer.innerHTML = '';
    const nameDiv = document.createElement('div');
    nameDiv.style.cssText = 'font-weight: 600; color: var(--text-primary); margin-bottom: 0.5rem;';
    nameDiv.textContent = file.name;
    
    const sizeDiv = document.createElement('div');
    sizeDiv.style.cssText = 'font-size: var(--fs-base); color: var(--text-secondary);';
    sizeDiv.textContent = `${(file.size / 1024).toFixed(2)} KB`;
    
    const hintDiv = document.createElement('div');
    hintDiv.style.cssText = 'font-size: var(--fs-base); color: var(--primary-color); margin-top: 0.5rem; cursor: pointer;';
    hintDiv.textContent = '点击或拖拽更换文件';
    
    textContainer.appendChild(nameDiv);
    textContainer.appendChild(sizeDiv);
    textContainer.appendChild(hintDiv);
  }
  
  // 添加已选择样式
  fileUpload.classList.add("has-file");
}

// 更新VVIP文件上传UI
export function updateVVIPFileUploadUI(file) {
  const fileUpload = document.querySelector("#vvip-file-upload-form .upload-drag-wrapper");
  if (!fileUpload) return;

  // 更改图标为Excel文件图标
  const iconContainer = fileUpload.querySelector(".ant-upload-drag-icon");
  if (iconContainer) {
    iconContainer.innerHTML = Icons.fileExcelAlt;
    iconContainer.querySelector('svg').style.color = 'var(--brand-excel)';
  }

  // 更新文本显示文件名
  const textContainer = fileUpload.querySelector(".ant-upload-text");
  if (textContainer) {
    textContainer.innerHTML = '';
    const nameDiv = document.createElement('div');
    nameDiv.style.cssText = 'font-weight: 600; color: var(--text-primary); margin-bottom: 0.5rem;';
    nameDiv.textContent = file.name;
    
    const sizeDiv = document.createElement('div');
    sizeDiv.style.cssText = 'font-size: var(--fs-base); color: var(--text-secondary);';
    sizeDiv.textContent = `${(file.size / 1024).toFixed(2)} KB`;
    
    const hintDiv = document.createElement('div');
    hintDiv.style.cssText = 'font-size: var(--fs-base); color: var(--primary-color); margin-top: 0.5rem; cursor: pointer;';
    hintDiv.textContent = '点击或拖拽更换文件';
    
    textContainer.appendChild(nameDiv);
    textContainer.appendChild(sizeDiv);
    textContainer.appendChild(hintDiv);
  }
  
  // 添加已选择样式
  fileUpload.classList.add("has-file");
}

// 更新T-4分析文件上传UI
export function updateT2AnalysisFileUploadUI(file) {
  const fileUpload = document.querySelector("#t2-analysis-file-upload-form .upload-drag-wrapper");
  if (!fileUpload) return;

  // 更改图标为Excel文件图标
  const iconContainer = fileUpload.querySelector(".ant-upload-drag-icon");
  if (iconContainer) {
    iconContainer.innerHTML = Icons.fileExcelAlt;
    iconContainer.querySelector('svg').style.color = 'var(--brand-excel)';
  }

  // 更新文本显示文件名
  const textContainer = fileUpload.querySelector(".ant-upload-text");
  if (textContainer) {
    textContainer.innerHTML = '';
    const nameDiv = document.createElement('div');
    nameDiv.style.cssText = 'font-weight: 600; color: var(--text-primary); margin-bottom: 0.5rem;';
    nameDiv.textContent = file.name;
    
    const sizeDiv = document.createElement('div');
    sizeDiv.style.cssText = 'font-size: var(--fs-base); color: var(--text-secondary);';
    sizeDiv.textContent = `${(file.size / 1024).toFixed(2)} KB`;
    
    const hintDiv = document.createElement('div');
    hintDiv.style.cssText = 'font-size: var(--fs-base); color: var(--primary-color); margin-top: 0.5rem; cursor: pointer;';
    hintDiv.textContent = '点击或拖拽更换文件';
    
    textContainer.appendChild(nameDiv);
    textContainer.appendChild(sizeDiv);
    textContainer.appendChild(hintDiv);
  }
  
  // 添加已选择样式
  fileUpload.classList.add("has-file");
}

// 更新T-4规则文件上传UI
export function updateT2RulesFileUploadUI(file) {
  const fileUpload = document.querySelector("#t2-rules-file-upload-form .upload-drag-wrapper");
  if (!fileUpload) return;

  // 更改图标为JSON文件图标
  const iconContainer = fileUpload.querySelector(".ant-upload-drag-icon");
  if (iconContainer) {
    iconContainer.innerHTML = '<i class="fas fa-file-code" style="font-size: var(--icon-2xl); color: var(--warning-color);"></i>';
  }

  // 更新文本显示文件名
  const textContainer = fileUpload.querySelector(".ant-upload-text");
  if (textContainer) {
    textContainer.innerHTML = '';
    const nameDiv = document.createElement('div');
    nameDiv.style.cssText = 'font-weight: 600; color: var(--text-primary); margin-bottom: 0.5rem;';
    nameDiv.textContent = file.name;
    
    const sizeDiv = document.createElement('div');
    sizeDiv.style.cssText = 'font-size: var(--fs-base); color: var(--text-secondary);';
    sizeDiv.textContent = `${(file.size / 1024).toFixed(2)} KB`;
    
    const hintDiv = document.createElement('div');
    hintDiv.style.cssText = 'font-size: var(--fs-base); color: var(--primary-color); margin-top: 0.5rem; cursor: pointer;';
    hintDiv.textContent = '点击或拖拽更换文件';
    
    textContainer.appendChild(nameDiv);
    textContainer.appendChild(sizeDiv);
    textContainer.appendChild(hintDiv);
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
  const fileUpload = document.querySelector("#analysis-file-upload-form .upload-drag-wrapper");
  if (!fileUpload) return;

  // 更改图标为Excel文件图标
  const iconContainer = fileUpload.querySelector(".ant-upload-drag-icon");
  if (iconContainer) {
    iconContainer.innerHTML = Icons.fileExcelAlt;
    iconContainer.querySelector('svg').style.color = 'var(--brand-excel)';
  }

  // 更新文本显示文件名
  const textContainer = fileUpload.querySelector(".ant-upload-text");
  if (textContainer) {
    textContainer.innerHTML = `
      <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.5rem;">${file.name}</div>
      <div style="font-size: var(--fs-base); color: var(--text-secondary);">
        ${(file.size / 1024).toFixed(2)} KB
      </div>
      <div style="font-size: var(--fs-base); color: var(--primary-color); margin-top: 0.5rem; cursor: pointer;">
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
    // 配置 marked 选项 - 安全设置
    marked.setOptions({
      gfm: true, // 启用 GitHub Flavored Markdown
      breaks: true, // 启用换行符转 <br>
      headerIds: false, // 禁用标题 ID，防止 ID 冲突
      mangle: false // 禁用标题 ID 混淆
    });
    html = marked.parse(markdownText);
  } else {
    // 降级使用简单的解析器
    html = parseMarkdown(markdownText);
  }
  
  // 使用 DOMPurify 或手动清理 HTML（如果可用）
  if (window.DOMPurify) {
    html = window.DOMPurify.sanitize(html);
  }
  
  container.innerHTML = html;

  // 处理 Mermaid 图表
  processMermaidDiagrams(container);
}

/**
 * CSS/HTML 流程图渲染器 - 替代 Mermaid
 * 支持基本的 flowchart 语法：graph TD, 节点定义, 箭头连接
 */
class FlowchartRenderer {
  constructor() {
    this.nodes = new Map(); // nodeId -> { id, label, type }
    this.edges = []; // [{ from, to, label }]
    this.subgraphs = []; // [{ id, label, nodes: [] }]
    this.currentSubgraph = null;
  }

  // 解析 mermaid flowchart 代码
  parse(code) {
    this.nodes.clear();
    this.edges = [];
    this.subgraphs = [];
    this.currentSubgraph = null;

    const lines = code.trim().split('\n');

    for (let line of lines) {
      line = line.trim();
      if (!line || line.startsWith('%%')) continue; // 跳过空行和注释

      // 检测 graph 类型
      if (line.match(/^(graph|flowchart)\s+(TD|LR)/)) {
        continue;
      }

      // subgraph 开始: subgraph ID ["label"] 或 subgraph ID [label]
      const subgraphStartMatch = line.match(/^subgraph\s+(\w+)\s*\[(.+?)\]$/);
      if (subgraphStartMatch) {
        this.currentSubgraph = {
          id: subgraphStartMatch[1],
          label: subgraphStartMatch[2],
          nodes: []
        };
        this.subgraphs.push(this.currentSubgraph);
        continue;
      }

      // subgraph 结束
      if (line === 'end') {
        this.currentSubgraph = null;
        continue;
      }

      // 解析整行
      this.parseLine(line);
    }

    return this;
  }

  // 解析一行
  parseLine(line) {
    // 首先提取所有节点定义
    // 方形节点: ID["label"]
    const squareMatches = line.matchAll(/(\w+)\[([^\]]+)\]/g);
    for (const match of squareMatches) {
      const [full, id, label] = match;
      this.addNode(id, this.decodeHtmlEntities(label), 'square');
    }

    // 圆角节点: ID(label)
    const roundMatches = line.matchAll(/(\w+)\(([^)]+)\)/g);
    for (const match of roundMatches) {
      const [full, id, label] = match;
      // 跳过方形节点
      if (!this.nodes.has(id)) {
        this.addNode(id, this.decodeHtmlEntities(label), 'round');
      }
    }

    // 菱形节点: ID{label}
    const diamondMatches = line.matchAll(/(\w+)\{([^}]+)\}/g);
    for (const match of diamondMatches) {
      const [full, id, label] = match;
      if (!this.nodes.has(id)) {
        this.addNode(id, this.decodeHtmlEntities(label), 'diamond');
      }
    }

    // 提取边定义
    // 格式: A --> B 或 A -->|label| B
    const edgeRegex = /(\w+)\s*(-->|--|==>)\|?([^|]*?)\|?\s*(\w+)/g;
    let match;
    
    while ((match = edgeRegex.exec(line)) !== null) {
      const [full, from, arrow, label, to] = match;
      
      // 如果起始节点还没定义，添加为方形节点
      if (!this.nodes.has(from)) {
        this.addNode(from, from, 'square');
      }
      
      // 如果结束节点还没定义，添加为方形节点
      if (!this.nodes.has(to)) {
        this.addNode(to, to, 'square');
      }
      
      // 添加边
      this.edges.push({
        from,
        to,
        label: label ? label.trim() : ''
      });
    }
  }

  addNode(id, label, type) {
    if (!this.nodes.has(id)) {
      const node = { id, label, type };
      this.nodes.set(id, node);
      if (this.currentSubgraph) {
        this.currentSubgraph.nodes.push(id);
        node.subgraphId = this.currentSubgraph.id;
      }
    }
  }

  decodeHtmlEntities(text) {
    if (!text) return '';
    return text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/<br\s*\/?>/gi, '<br>')
      .replace(/&nbsp;/g, ' ');
  }

  // 渲染为 HTML/CSS
  render() {
    if (this.nodes.size === 0) {
      return '<div class="flowchart-error">无法解析流程图: 未发现节点</div>';
    }

    let html = `<div class="flowchart-container">`;

    // 渲染 subgraph
    for (const sg of this.subgraphs) {
      html += `<div class="flowchart-subgraph">
        <div class="flowchart-subgraph-title">${this.escapeHtml(sg.label)}</div>
        <div class="flowchart-subgraph-content">`;
      
      for (const nodeId of sg.nodes) {
        const node = this.nodes.get(nodeId);
        if (node) {
          html += this.renderNode(node);
        }
      }
      
      html += `</div></div>`;
    }

    // 渲染不在 subgraph 中的节点
    for (const [id, node] of this.nodes) {
      const inSubgraph = this.subgraphs.some(sg => sg.nodes.includes(id));
      if (!inSubgraph) {
        html += this.renderNode(node);
      }
    }

    // 渲染边 - 使用 CSS flexbox 布局
    html += `<div class="flowchart-flow">`;
    for (const edge of this.edges) {
      html += this.renderEdge(edge);
    }
    html += `</div>`;

    html += `</div>`;
    return html;
  }

  renderNode(node) {
    const shapeClass = `flowchart-node-${node.type}`;
    const label = node.label.replace(/<br\s*\/?>/gi, '<br>');
    return `<div class="flowchart-node ${shapeClass}" data-node-id="${this.escapeHtml(node.id)}">
      <span class="flowchart-node-label">${label}</span>
    </div>`;
  }

  renderEdge(edge) {
    const labelHtml = edge.label 
      ? `<div class="flowchart-edge-label">${this.escapeHtml(edge.label)}</div>` 
      : '';
    const arrowHtml = `<span class="flowchart-arrow">→</span>`;

    return `<div class="flowchart-edge">
      <span class="flowchart-edge-from">${this.escapeHtml(edge.from)}</span>
      ${arrowHtml}
      ${labelHtml}
      <span class="flowchart-edge-to">${this.escapeHtml(edge.to)}</span>
    </div>`;
  }

  escapeHtml(text) {
    if (!text) return '';
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }
}

// 添加流程图样式到页面
function addFlowchartStyles() {
  if (document.getElementById('flowchart-styles')) return;
  
  const style = document.createElement('style');
  style.id = 'flowchart-styles';
  style.textContent = `
    .flowchart-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      padding: 20px;
      gap: 15px;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      position: relative;
    }
    
    .flowchart-node {
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 12px 20px;
      margin: 8px;
      min-width: 120px;
      max-width: 300px;
      text-align: center;
      font-size: var(--fs-base);
      line-height: 1.4;
      box-sizing: border-box;
    }
    
    .flowchart-node-square {
      background: var(--primary-bg);
      border: 2px solid var(--primary-color);
      border-radius: 4px;
    }
    
    .flowchart-node-round {
      background: var(--warning-border);
      border: 2px solid var(--warning-color);
      border-radius: 20px;
    }
    
    .flowchart-node-diamond {
      background: var(--success-bg);
      border: 2px solid var(--success-color);
      border-radius: 4px;
    }
    
    .flowchart-subgraph {
      border: 2px dashed var(--text-secondary);
      border-radius: 8px;
      padding: 10px;
      margin: 10px 0;
      width: 100%;
      max-width: 600px;
    }
    
    .flowchart-subgraph-title {
      font-weight: bold;
      color: var(--text-tertiary);
      margin-bottom: 10px;
      padding: 5px 10px;
      background: var(--bg-tertiary);
      border-radius: 4px;
    }
    
    .flowchart-subgraph-content {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
    }
    
    .flowchart-flow {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 5px;
      width: 100%;
    }
    
    .flowchart-edge {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 4px 10px;
      background: rgba(255,255,255,0.8);
      border-radius: 4px;
      font-size: var(--fs-xs);
      color: var(--text-tertiary);
    }
    
    .flowchart-edge-from,
    .flowchart-edge-to {
      padding: 4px 8px;
      background: var(--border-light);
      border-radius: 4px;
      font-weight: 500;
    }
    
    .flowchart-edge-label {
      padding: 2px 8px;
      background: var(--warning-border);
      border: 1px solid var(--warning-color);
      border-radius: 4px;
      font-size: var(--fs-xs);
      color: var(--text-tertiary);
    }
    
    .flowchart-arrow {
      color: var(--text-tertiary);
      font-weight: bold;
    }
    
    .flowchart-error {
      color: var(--error-color);
      padding: 16px;
      border: 1px solid var(--error-border);
      background-color: var(--error-bg);
      border-radius: 4px;
    }
    
    .flowchart-loading {
      color: var(--text-tertiary);
      padding: 20px;
      text-align: center;
    }
  `;
  document.head.appendChild(style);
}

// 处理 Mermaid/流程图代码块 - 使用 CSS/HTML 渲染
function processMermaidDiagrams(container) {
  log.info("processMermaidDiagrams: 使用 CSS/HTML 渲染流程图");
  
  // 添加流程图样式
  addFlowchartStyles();

  // 收集所有需要渲染的流程图代码块
  const nodesToProcess = [];
  
  // 1. 处理 marked 生成的 <pre><code class="language-mermaid">
  container.querySelectorAll('code.language-mermaid').forEach(code => {
    const pre = code.parentElement;
    if (pre.tagName === 'PRE') {
      nodesToProcess.push({
        element: pre,
        code: code.textContent
      });
    }
  });

  // 2. 处理 parseMarkdown 生成的 <pre class="mermaid">
  container.querySelectorAll('pre.mermaid').forEach(pre => {
    nodesToProcess.push({
      element: pre,
      code: pre.textContent
    });
  });

  if (nodesToProcess.length === 0) return;

  log.info(`processMermaidDiagrams: 发现 ${nodesToProcess.length} 个流程图`);

  // 逐个渲染
  nodesToProcess.forEach(({ element, code }) => {
    // 创建容器
    const div = document.createElement('div');
    div.className = 'flowchart-wrapper';
    div.style.display = 'flex';
    div.style.justifyContent = 'center';
    div.style.padding = '20px';
    div.style.overflowX = 'auto';
    
    // 显示加载状态
    div.innerHTML = '<div class="flowchart-loading"><i class="fas fa-spinner fa-spin"></i> 正在渲染流程图...</div>';
    
    // 替换原元素
    element.replaceWith(div);

    try {
      // 解析并渲染
      const renderer = new FlowchartRenderer();
      renderer.parse(code);
      div.innerHTML = renderer.render();
      div.style.padding = '';
    } catch (error) {
      log.error('流程图渲染错误:', error);
      div.innerHTML = `
        <div style="text-align: left; color: var(--error-color); padding: 16px; border: 1px solid var(--error-border); background-color: var(--error-bg); border-radius: 4px; width: 100%; overflow: auto;">
          <div style="font-weight: bold; margin-bottom: 8px;">
            <i class="fas fa-exclamation-circle"></i> 流程图渲染失败
          </div>
          <div style="font-family: monospace; font-size: var(--fs-xs); margin-bottom: 8px;">${error.message || '未知错误'}</div>
          <details>
            <summary style="cursor: pointer; color: var(--primary-color); font-size: var(--fs-xs);">查看原始代码</summary>
            <pre style="margin-top: 8px; background: rgba(0,0,0,0.05); padding: 8px; border-radius: 4px; font-size: var(--fs-xs); white-space: pre-wrap;">${code.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</pre>
          </details>
        </div>
      `;
      div.style.padding = '';
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
    log.error('加载README失败:', error);
    readmeContainer.innerHTML = '<p style="color: var(--error-color);">加载说明文档出错</p>';
  }
}

// 加载 LTS Fallout Summary
async function loadLTSSummary() {
  log.debug('loadLTSSummary 被调用');
  const container = document.getElementById('lts-summary-content');
  if (!container) {
    log.error('未找到 #lts-summary-content 容器');
    return;
  }

  try {
    log.debug('正在获取 docs/LTS_Fallout_Summary.md');
    const response = await fetch('docs/LTS_Fallout_Summary.md');
    log.debug('fetch 响应: ok=', response.ok, 'status=', response.status);
    if (response.ok) {
      const text = await response.text();
      // console.log('[DEBUG] Fetched text length:', text.length);
      renderMarkdownContent(container, text);
      appState.lts_summary_loaded = true;
      log.debug('LTS Summary 加载成功');
    } else {
      log.error('获取 LTS Summary 失败，状态码:', response.status);
      container.innerHTML = '<p style="color: var(--error-color);">加载 LTS Fallout Summary 失败</p>';
    }
  } catch (error) {
    log.error('加载 LTS Fallout Summary 异常:', error);
    container.innerHTML = '<p style="color: var(--error-color);">加载 LTS Fallout Summary 出错</p>';
  }
}

// 更新午餐文件上传UI
export function updateLunchFileUploadUI(file) {
  const fileUpload = document.querySelector("#lunch-file-upload-form .upload-drag-wrapper");
  if (!fileUpload) return;

  // 更改图标
  const iconContainer = fileUpload.querySelector(".ant-upload-drag-icon");
  if (iconContainer) {
    iconContainer.innerHTML = '<i class="fas fa-utensils" style="font-size: var(--icon-2xl); color: var(--warning-color);"></i>';
  }

  // 更新文本显示文件名
  const textContainer = fileUpload.querySelector(".ant-upload-text");
  if (textContainer) {
    textContainer.innerHTML = `
      <div style="font-weight: 600; color: var(--text-primary); margin-bottom: 0.5rem;">${file.name}</div>
      <div style="font-size: var(--fs-base); color: var(--text-secondary);">
        ${(file.size / 1024).toFixed(2)} KB
      </div>
      <div style="font-size: var(--fs-base); color: var(--primary-color); margin-top: 0.5rem; cursor: pointer;">
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
        container.innerHTML = '';
        
        const wrapper = document.createElement('div');
        wrapper.style.cssText = 'text-align: center; padding: 30px; background: var(--warning-bg); border: 2px dashed var(--warning-border); border-radius: 8px; box-shadow: 0 4px 12px rgba(250, 173, 20, 0.15);';
        
        const emoji = document.createElement('div');
        emoji.style.cssText = 'font-size: var(--icon-2xl); margin-bottom: 20px;';
        emoji.textContent = '🎉';
        
        const label = document.createElement('div');
        label.style.cssText = 'margin-bottom: 10px; color: var(--text-secondary);';
        label.textContent = '今天中午吃这个：';
        
        wrapper.appendChild(emoji);
        wrapper.appendChild(label);
        
        if (typeof place === 'string') {
            const h2 = document.createElement('h2');
            h2.style.cssText = 'color: var(--warning-color); margin: 0; font-size: var(--fs-3xl);';
            h2.textContent = place;
            wrapper.appendChild(h2);
        } else if (typeof place === 'object') {
            const h2 = document.createElement('h2');
            h2.style.cssText = 'color: var(--warning-color); margin: 0; font-size: var(--fs-3xl);';
            h2.textContent = place.name || '未知地点';
            wrapper.appendChild(h2);
            
            if (place.description) {
                const p = document.createElement('p');
                p.style.cssText = 'color: var(--text-tertiary); margin-top: 10px; font-size: var(--fs-lg);';
                p.textContent = place.description;
                wrapper.appendChild(p);
            }
            
            if (place.tags && Array.isArray(place.tags)) {
                const tagsDiv = document.createElement('div');
                tagsDiv.style.cssText = 'margin-top: 10px;';
                place.tags.forEach(tag => {
                    const span = document.createElement('span');
                    span.className = 'ant-tag ant-tag-orange';
                    span.textContent = tag;
                    tagsDiv.appendChild(span);
                });
                wrapper.appendChild(tagsDiv);
            }
        }
        
        container.appendChild(wrapper);
        
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

// （v3.1 单页布局）横向菜单栏已移除，分区导航见 showSection / initModuleGroups

// 渲染 Schedule Jobs 列表
export function renderScheduleJobsData(alarms) {
    const listEl = document.getElementById("schedule-jobs-list");
    const tableEl = document.getElementById("schedule-jobs-table");
    const emptyEl = document.getElementById("schedule-jobs-empty");
    if (!listEl) return;
    
    // 清空列表
    listEl.innerHTML = "";
    
    if (!alarms || alarms.length === 0) {
        if (tableEl) tableEl.style.display = "none";
        if (emptyEl) emptyEl.style.display = "block";
        return;
    }
    
    if (emptyEl) emptyEl.style.display = "none";
    if (tableEl) tableEl.style.display = "table";
    
    alarms.forEach((alarm) => {
        const tr = document.createElement("tr");
        tr.style.cssText = "border-bottom: 1px solid var(--border-color); transition: background 0.2s;";
        tr.onmouseenter = () => tr.style.background = "var(--bg-tertiary)";
        tr.onmouseleave = () => tr.style.background = "#fff";

        // 统一创建居中单元格
        const makeTd = (html) => {
            const td = document.createElement('td');
            td.style.cssText = 'padding: 12px 16px; text-align: center; vertical-align: middle; box-sizing: border-box;';
            td.innerHTML = html;
            return td;
        };
        
        // 格式化下次触发时间
        let nextRunText = "N/A";
        if (alarm.scheduledTime) {
            const date = new Date(alarm.scheduledTime);
            nextRunText = date.toLocaleString('zh-CN', {
                year: 'numeric',
                month: '2-digit',
                day: '2-digit',
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
        }
        
        // 判断是否为周期任务
        const isPeriodic = alarm.periodInMinutes && alarm.periodInMinutes > 0;
        const isPaused = alarm.isPaused === true;

        // 名称
        const nameTd = makeTd(`
            <span style="display:inline-flex; align-items:center; justify-content:center; gap:8px;">
                <i class="fas fa-clock" style="color: var(--accent-indigo);"></i>
                <span style="font-weight: 500; color: var(--text-primary);">${alarm.name || 'Unnamed Job'}</span>
            </span>
        `);

        // 类型
        const typeTd = makeTd(
            isPeriodic
                ? '<span style="background: var(--primary-bg); color: var(--primary-color); padding: 2px 8px; border-radius: 4px; font-size: var(--fs-xs); display:inline-block;">周期</span>'
                : '<span style="background: var(--bg-tertiary); color: var(--text-secondary); padding: 2px 8px; border-radius: 4px; font-size: var(--fs-xs); display:inline-block;">一次性</span>'
        );

        // 状态
        const statusTd = makeTd(
            isPaused
                ? '<span style="background: var(--error-bg); color: var(--error-color); padding: 2px 8px; border-radius: 4px; font-size: var(--fs-xs); display:inline-block;">已暂停</span>'
                : '<span style="background: var(--success-bg); color: var(--success-color); padding: 2px 8px; border-radius: 4px; font-size: var(--fs-xs); display:inline-block;">运行中</span>'
        );

        // 周期
        const periodTd = makeTd(`${isPeriodic ? (alarm.periodInMinutes + ' 分钟') : '-'}`);
        periodTd.style.color = 'var(--text-secondary)';

        // 下次执行
        const nextTd = makeTd(`
            <span style="display:inline-flex; align-items:center; justify-content:center; gap:6px; color:var(--text-secondary);">
                <i class="fas fa-calendar-alt"></i>${nextRunText}
            </span>
        `);

        // 操作
        const actionTd = document.createElement('td');
        actionTd.style.cssText = 'padding: 12px 16px; text-align: center; vertical-align: middle;';
        const actionWrap = document.createElement('div');
        actionWrap.style.cssText = 'display:inline-flex; align-items:center; justify-content:center; gap:6px;';

        const pauseBtn = document.createElement('button');
        pauseBtn.className = 'ant-btn ant-btn-sm';
        pauseBtn.title = '暂停/恢复';
        pauseBtn.innerHTML = `<i class="fas ${isPaused ? 'fa-play' : 'fa-pause'}"></i> ${isPaused ? '恢复' : '暂停'}`;
        pauseBtn.addEventListener('click', (e) => {
            e.preventDefault();
            if (window && typeof window.pauseScheduleJob === 'function') {
                window.pauseScheduleJob(alarm.name);
            }
        });

        const deleteBtn = document.createElement('button');
        deleteBtn.className = 'ant-btn ant-btn-sm ant-btn-dangerous';
        deleteBtn.title = '删除';
        deleteBtn.innerHTML = '<i class="fas fa-trash"></i> 删除';
        deleteBtn.addEventListener('click', (e) => {
            e.preventDefault();
            const confirmed = window.confirm(`确认删除定时任务 "${alarm.name}" 吗？`);
            if (!confirmed) return;
            if (window && typeof window.deleteScheduleJob === 'function') {
                window.deleteScheduleJob(alarm.name);
            }
        });

        actionWrap.appendChild(pauseBtn);
        actionWrap.appendChild(deleteBtn);
        actionTd.appendChild(actionWrap);

        // 拼装行
        tr.appendChild(nameTd);
        tr.appendChild(typeTd);
        tr.appendChild(statusTd);
        tr.appendChild(periodTd);
        tr.appendChild(nextTd);
        tr.appendChild(actionTd);

        listEl.appendChild(tr);
    });
}