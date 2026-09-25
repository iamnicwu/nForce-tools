import { createLogger } from "./common/logger.js";

const log = createLogger("APP");
import { sfConn } from "./biz/sf_service.js";
import { showNotification } from "./common/utils.js";
import { replaceIcons, Icons } from "./common/icons.js";
import { $, on } from "./common/dom.js";
import { appState } from "./biz/state.js";
import { OneDriveWorkbookService } from "./common/onedrive_service.js";
import { initUiLayout, renderLauncher } from "./biz/ui_layout.js";
// Org 状态面板：session 真正可用后必须调 markSessionReady()，
// 否则面板不会发起 limits 请求（时序约束见 org_limits.js 头部注释）
import { markSessionReady } from "./biz/org_limits.js";
import {
  initInspectorTools,
  loadSoqlFields,
  runSoqlQuery,
  exportSoqlResults,
  handleImportFileChange,
  handleImportObjectChange,
  renderImportMapping,
  runDataImport,
  loadMetadataTypes,
  listMetadataMembers,
  retrieveMetadataPackage,
  loadEventChannels,
  onEventTypeChange,
  subscribeEventChannel,
  unsubscribeEventChannel,
  clearEventLog,
  exportEventLog
} from "./biz/inspector_tools.js";
// marked 以 ES Module 形式发布（不挂在 window 上），这里显式引入并暴露给
// ui.js 的 renderMarkdownContent 使用，否则 README / LTS 概览会退化成简易解析器
import { marked } from "./lib/js/marked.min.js";
import {
  showSection,
  updateUIState,
  renderRulesList,
  moveRule,
  moveRuleTo,
  renderMarkdownContent,
  showBulkJobsLoading,
  initLauncher,
  goHome,
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
    log.warn('Session 验证失败:', e);
    return false;
  }
}

// 服务端明确判定「会话无效」的错误码
const AUTH_FAILURE_CODES = [
  "INVALID_SESSION_ID",
  "SESSION_EXPIRED",
  "INVALID_LOGIN",
  "INVALID_GRANT",
  "UNAUTHORIZED"
];

/**
 * 判断最近一次连接失败是否属于「会话真的失效」。
 * 只有这种情况才允许把界面降级为未连接；
 * 如果是 CSP / 网络 / 代理导致的请求被拦截（没有 errorCode / 状态码），
 * 必须保留已连接状态，否则就会出现「刚找到 session 进入主页却显示未连接」。
 */
function isSessionAuthFailure() {
  const err = sfConn.lastError;
  if (!err) return false;
  if (err.statusCode === 401 || err.statusCode === 403) return true;
  if (!err.errorCode) return false;
  return AUTH_FAILURE_CODES.includes(err.errorCode.toUpperCase());
}

/**
 * 从浏览器 Cookie 中重新获取 Salesforce 会话（sid）。
 * 场景：存储的 session 已过期，但用户在浏览器里仍登录着 Salesforce，
 * 此时 Cookie 里的 sid 是最新的。刷新 index.html 即可自动换新，无需手动重登。
 * @param {string|null} knownBadSid - 刚被服务端判定失效的 sid，同值 Cookie 直接跳过
 * @returns {Promise<boolean>} 是否刷新成功
 */
async function tryRefreshSessionFromCookie(knownBadSid = null) {
  const instanceUrl = appState.instance_url;
  if (!instanceUrl) return false;
  if (!chrome.cookies || typeof chrome.cookies.getAll !== "function") {
    log.warn("当前环境无 chrome.cookies 权限，跳过自动刷新");
    return false;
  }
  try {
    const cookies = await chrome.cookies.getAll({ url: instanceUrl, name: "sid" });
    if (!cookies || cookies.length === 0) {
      log.info("浏览器中未找到 sid Cookie，无法自动刷新会话");
      return false;
    }

    // 与当前实例域名匹配的 Cookie 优先，其余按返回顺序兜底
    let host = "";
    try { host = new URL(instanceUrl).hostname; } catch (e) { /* instanceUrl 已在上面保证非空，忽略 */ }
    const domainRank = (c) => {
      const d = String(c.domain || "").replace(/^\./, "");
      return host && (host === d || host.endsWith("." + d)) ? 0 : 1;
    };
    const sorted = [...cookies].sort((a, b) => domainRank(a) - domainRank(b));

    for (const cookie of sorted) {
      // Cookie 格式: org!sessionId
      const parts = String(cookie.value || "").split("!");
      const sid = parts.length >= 2 ? parts[1] : parts[0];
      if (!sid || (knownBadSid && sid === knownBadSid)) continue;

      log.info("尝试用浏览器 Cookie 刷新会话，domain:", cookie.domain);
      const ok = await sfConn.testConnection(sid, instanceUrl);
      if (ok) {
        appState.session_id = sid;
        appState.is_connected = true;
        try {
          await chrome.storage.local.set({
            sf_session_id: sid,
            sf_instance_url: instanceUrl,
            is_connected: true
          });
        } catch (e) {
          log.warn("写入刷新后的会话失败:", e);
        }
        log.info("已通过浏览器 Cookie 自动刷新 Salesforce 会话");
        return true;
      }
      log.warn("该 Cookie 对应的会话无效，继续尝试下一个，domain:", cookie.domain);
    }
    return false;
  } catch (e) {
    log.warn("从 Cookie 自动刷新会话失败:", e);
    return false;
  }
}

/** 会话恢复 / 自动刷新成功后的统一收尾（补齐用户与组织信息并刷新 UI） */
async function onSessionRestored(message) {
  // session 已确认有效：打开 Org 状态面板的请求门闩（会触发 limits 拉取）
  markSessionReady();
  try {
    await fetchUserInfo();
    await fetchOrgInfo();
  } catch (e) {
    log.warn("获取用户/组织信息失败（不影响功能）:", e);
  }
  updateUIState();
  try {
    // 同步刷新 storage 中的用户 / 组织信息，保持与 chrome.storage 一致
    await chrome.storage.local.set({
      userInfo: appState.userInfo,
      orgInfo: appState.orgInfo
    });
  } catch (e) {
    log.warn("同步用户/组织信息到 storage 失败:", e);
  }
  try {
    await renderLauncher();
  } catch (e) {
    log.warn('刷新首页图标状态失败:', e);
  }
  if (message) showNotification(message, "success");
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
    // 注意：Session 信息仅保存在 chrome.storage.local 中，不再使用 localStorage
    if (stored.sf_session_id) {
      appState.session_id = stored.sf_session_id;
    }
    if (stored.sf_instance_url) {
      appState.instance_url = stored.sf_instance_url;
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
    log.warn('从 chrome.storage.local 读取登录状态失败:', e);
  }

  // ===== 先把界面完整渲染出来：任何情况下都不能白屏 =====
  // 替换图标
  replaceIcons();

  // 初始化午餐功能
  initLunch();

  // 初始化首页交互（返回按钮 / Esc 快捷键）
  initLauncher();

  // 初始化 Inspector 移植功能模块（section-23 ~ 26 的懒加载与事件）
  initInspectorTools();

  // 更新UI状态（连接徽标 / 统计数据 / 锁定状态）
  updateUIState();

  // 渲染功能中心首页（布局由 rules/ui_layout.json 驱动）
  try {
    await initUiLayout();
  } catch (e) {
    log.error("首页布局渲染失败:", e);
    showNotification(`首页布局渲染失败：${e.message || e}`, "error");
    renderLauncherErrorHint(e);
  }

  // 默认停留在「功能中心」首页，由用户点击图标进入具体功能
  goHome();

  // 绑定事件
  // 兜底：bindEvents 内部已统一改用 dom.js 的 on()（元素缺失只会 warn 不会抛），
  // 这里再包一层，保证将来任何一处绑定出错都不会让整页变成「看着正常但点不动」。
  try {
    bindEvents();
  } catch (e) {
    log.error("事件绑定过程中出现异常，部分功能可能不可用：", e);
    showNotification("部分界面事件绑定失败，请打开控制台查看详情", "error");
  }

  // ===== 最后再尝试恢复 Salesforce 会话：只做「尽力而为」，绝不影响首页展示 =====
  // 重要：这里失败时不能把界面降级为「未连接」。
  // 校验请求可能被 CSP / 网络 / 代理拦截，但会话本身是好的；
  // 之前直接降级（甚至清空 session 并跳登录页）会造成
  // 「找到 session 进入主页却显示未连接、且没有功能图标」的问题。
  if (appState.is_connected && appState.session_id && appState.instance_url) {
    const isValid = await validateStoredSession();
    if (isValid) {
      log.info("已恢复 Salesforce 会话");
      await onSessionRestored();
    } else if (isSessionAuthFailure()) {
      // 只有服务端明确返回「会话无效」时才需要处理。
      // 先尝试从浏览器 Cookie 自动获取新 session（用户浏览器仍登录着的话即可无感续期），
      // 刷新失败才降级为未连接。
      log.warn("Salesforce 会话已失效，尝试从浏览器 Cookie 自动刷新...");
      const refreshed = await tryRefreshSessionFromCookie(appState.session_id);
      if (refreshed) {
        await onSessionRestored("Session 已过期，已自动从浏览器获取新会话");
      } else {
        log.warn("自动刷新会话失败，降级为未连接状态（保留 session ID 便于重试）");
        appState.is_connected = false;
        // 只清除连接标记，保留 session_id / instance_url 以便用户直接重试
        try {
          await chrome.storage.local.set({ is_connected: false });
        } catch (e) {
          log.warn('更新连接状态失败:', e);
        }
        updateUIState();
        try {
          await renderLauncher();
        } catch (e) {
          log.warn('刷新首页图标状态失败:', e);
        }
        showNotification("Salesforce 会话已过期且自动刷新失败，请到 Salesforce 重新登录后刷新本页，或在「连接设置」手动更新", "error");
      }
    } else {
      // 无法判定会话失效（多为请求被拦截）：保留已连接状态，仅记录日志
      log.warn("启动时会话校验未通过（可能是网络/CSP 限制），保留已连接状态。原因:", sfConn.lastError);
      // session 本身来自存储且未被判失效：视为可用，打开 limits 请求门闩
      // （若网络确实不通，limits 拉取会走既有失败态，不影响其他功能）
      markSessionReady();
    }
  } else if (!appState.is_connected && appState.instance_url) {
    // 之前降级为未连接：刷新 index.html 时尝试从浏览器 Cookie 重新获取会话，
    // 让用户不必手动走一遍登录页。
    const refreshed = await tryRefreshSessionFromCookie(appState.session_id || null);
    if (refreshed) {
      await onSessionRestored("已自动从浏览器 Cookie 恢复 Salesforce 会话");
    }
  }

  // 会话恢复 / 自动刷新都结束后，仍未连接才提示（避免先弹警告又马上连接成功的噪音）
  if (!appState.is_connected) {
    showNotification("尚未连接 Salesforce，请点击「连接设置」完成连接", "warning");
  }
}

// 首页渲染失败时的兜底提示，避免出现空白页面
function renderLauncherErrorHint(error) {
  const host = $("launcher-groups");
  if (!host) return;
  host.innerHTML = `
    <section class="launcher-group">
      <div class="launcher-group-head">
        <span class="launcher-group-chip">首页加载失败</span>
      </div>
      <p style="margin:0 0 12px; color: var(--text-secondary); font-size: var(--fs-sm);">
        功能列表加载失败：${error && error.message ? error.message : error}。
        可点击上方「布局配置」检查 JSON，或点「恢复默认」后重试。
      </p>
      <button type="button" class="ant-btn ant-btn-primary" id="launcher-retry-btn">重新加载首页</button>
    </section>`;
  const retry = $("launcher-retry-btn");
  if (retry) {
    retry.addEventListener("click", () => window.location.reload());
  }
}

// 绑定事件
function bindEvents() {
  // Session ID表单提交
  on("session-id-form", "submit", function (e) {
      e.preventDefault();
      const sessionId = $("session_id").value.trim();

      if (sessionId) {
        appState.session_id = sessionId;
        updateUIState();
        showNotification("Session ID已成功保存", "success");

        // 自动触发连接测试
        const testConnectionForm = $("test-connection-form");
        if (testConnectionForm) {
          testConnectionForm.dispatchEvent(new Event('submit'));
        }
      } else {
        showNotification("请输入Session ID", "error");
      }
    });

  // 测试连接表单提交
  on("test-connection-form", "submit", async function (e) {
      e.preventDefault();
      const statusElement = $("connection-status");
      const successElement = $("connection-success");
      const errorElement = $("connection-error");
      const infoElement = $("connection-info");

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
          statusElement.style.color = "var(--success-color)"; // Ant Design success color
          successElement.style.display = "flex";
          errorElement.style.display = "none";
          infoElement.style.display = "none";
          log.debug("获取用户信息");
          // 获取用户信息
          await fetchUserInfo();
          // 获取组织信息
          await fetchOrgInfo();
          // session 刚测试通过：打开 Org 状态面板的请求门闩（会触发 limits 拉取）
          markSessionReady();
          // // 获取 LTS Account 数量
          // await fetchLTSAccountCount();

          // 更新UI状态
          updateUIState();

          // 连接成功后回到功能中心，所有功能图标解锁
          goHome();
          showNotification("Salesforce连接成功，可点击图标进入功能", "success");
        } else {
          // 连接失败
          throw new Error("Connection failed");
        }
      } catch (error) {
        // 连接失败
        appState.is_connected = false;

        statusElement.innerHTML =
          `${Icons.timesCircle} 连接失败`;
        statusElement.style.color = "var(--error-color)"; // Ant Design error color
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
  on("daily-data-form", "submit", function (e) {
      e.preventDefault();

      // 显示loading mask
      const loadingMask = $("loading-mask");
      const recordCountSpan = $("record-count");

      if (loadingMask && recordCountSpan) {
        loadingMask.style.display = "flex";
        loadingMask.querySelector("h3").textContent = "正在获取当日数据...";
        recordCountSpan.textContent = "0";
      }

      // 获取当日数据
      getDailyData();
    });

  // 获取 PCD 当日数据表单提交
  on("pcd-daily-data-form", "submit", function (e) {
      e.preventDefault();

      // 显示loading mask
      const loadingMask = $("loading-mask");
      const recordCountSpan = $("record-count");

      if (loadingMask && recordCountSpan) {
        loadingMask.style.display = "flex";
        loadingMask.querySelector("h3").textContent = "正在获取 PCD 当日数据...";
        recordCountSpan.textContent = "0";
      }

      // 获取 PCD 当日数据
      getPCDDailyData();
    });

  // 获取 PCD PID Fallout 数据表单提交
  on("pcd-pid-fallout-data-form", "submit", function (e) {
      e.preventDefault();

      // 显示loading mask
      const loadingMask = $("loading-mask");
      const recordCountSpan = $("record-count");

      if (loadingMask && recordCountSpan) {
        loadingMask.style.display = "flex";
        loadingMask.querySelector("h3").textContent = "正在获取 PCD PID Fallout 数据...";
        recordCountSpan.textContent = "0";
      }

      // 获取 PCD PID Fallout 数据
      getPCDPIDFalloutData();
    });

  // 获取 PCD QC Issue 数据表单提交
  on("pcd-qc-issue-data-form", "submit", function (e) {
      e.preventDefault();

      // 显示loading mask
      const loadingMask = $("loading-mask");
      const recordCountSpan = $("record-count");

      if (loadingMask && recordCountSpan) {
        loadingMask.style.display = "flex";
        loadingMask.querySelector("h3").textContent = "正在获取 PCD QC Issue 数据...";
        recordCountSpan.textContent = "0";
      }

      // 获取 PCD QC Issue 数据
      getPCDQCIssueData();
    });

  // 自定义日期复选框变化事件
  const dailyCustomDateCheckbox = $("daily-custom-date-checkbox");
  if (dailyCustomDateCheckbox) {
    dailyCustomDateCheckbox.addEventListener("change", function(e) {
      const container = $("daily-custom-date-container");
      if (container) {
        container.style.display = e.target.checked ? "block" : "none";
      }
    });
  }

  // 获取报表数据表单提交
  on("report-data-form", "submit", function (e) {
      e.preventDefault();

      // 显示loading mask
      const loadingMask = $("loading-mask");
      const recordCountSpan = $("record-count");

      if (loadingMask && recordCountSpan) {
        loadingMask.style.display = "flex";
        loadingMask.querySelector("h3").textContent = "正在获取报表数据...";
        recordCountSpan.textContent = "0";
      }

      // 获取报表数据
      getReportData();
    });

  // 获取T-4数据表单提交
  on("t2-data-form", "submit", function (e) {
      e.preventDefault();

      // 显示loading mask
      const loadingMask = $("loading-mask");
      const recordCountSpan = $("record-count");

      if (loadingMask && recordCountSpan) {
        loadingMask.style.display = "flex";
        loadingMask.querySelector("h3").textContent = "正在获取T-4数据...";
        recordCountSpan.textContent = "0";
      }

      // 获取T-4数据
      getT2Data();
    });

    // 文件上传表单提交
  on("file-upload-form", "submit", function (e) {
      e.preventDefault();
      const fileInput = $("file");
      const file = fileInput.files[0];

      processExcelFile(file);
    });

  // VVIP文件上传表单提交
  on("vvip-file-upload-form", "submit", function (e) {
      e.preventDefault();
      const fileInput = $("vvip-file");
      const file = fileInput.files[0];

      processVVIPExcelFile(file);
    });

  // 数据分析文件上传表单提交
  on("analysis-file-upload-form", "submit", function (e) {
      e.preventDefault();
      const fileInput = $("analysis-file");
      const file = fileInput.files[0];

      processAnalysisExcelFile(file);
    });

  // T-4 分析文件上传表单提交
  on("t2-analysis-file-upload-form", "submit", function (e) {
      e.preventDefault();
      const fileInput = $("t2-analysis-file");
      const file = fileInput.files[0];

      processT2AnalysisExcelFile(file);
    });



  // （v3.2 App 图标式布局）首页图标点击已改为事件委托，见 ui_layout.js 的 initUiLayout
  // 侧边栏 / 横向菜单事件已移除

  // 顶部导航「设置」入口 + 设置页内的各项跳转
  const settingsNavBtn = $("settings-nav-btn");
  if (settingsNavBtn) {
    settingsNavBtn.addEventListener("click", () => showSection(21));
  }
  document.querySelectorAll(".settings-row").forEach((row) => {
    row.addEventListener("click", () => {
      const target = parseInt(row.getAttribute("data-goto"), 10);
      if (target) showSection(target);
    });
  });

  // 导出当日数据按钮点击事件
  const exportDailyDataBtn = $("export-daily-data");
  if (exportDailyDataBtn) {
    exportDailyDataBtn.addEventListener("click", exportDailyData);
  }

  // 导出 PCD 当日数据按钮点击事件
  const exportPCDDailyDataBtn = $("export-pcd-daily-data");
  if (exportPCDDailyDataBtn) {
    exportPCDDailyDataBtn.addEventListener("click", exportPCDDailyData);
  }

  // 导出 PCD PID Fallout 数据按钮点击事件
  const exportPCDPIDFalloutDataBtn = $("export-pcd-pid-fallout-data");
  if (exportPCDPIDFalloutDataBtn) {
    exportPCDPIDFalloutDataBtn.addEventListener("click", exportPCDPIDFalloutData);
  }

  // 导出 PCD QC Issue 数据按钮点击事件
  const exportPCDQCIssueDataBtn = $("export-pcd-qc-issue-data");
  if (exportPCDQCIssueDataBtn) {
    exportPCDQCIssueDataBtn.addEventListener("click", exportPCDQCIssueData);
  }

  // 导出报表数据按钮点击事件
  const exportReportDataBtn = $("export-report-data");
  if (exportReportDataBtn) {
    exportReportDataBtn.addEventListener("click", exportReportData);
  }

  // 导出T-4数据按钮点击事件
  const exportT2DataBtn = $("export-t2-data");
  if (exportT2DataBtn) {
    exportT2DataBtn.addEventListener("click", exportT2Data);
  }

  // 导出最新数据按钮点击事件
  const exportLatestDataBtn = $("export-latest-data");
  if (exportLatestDataBtn) {
    exportLatestDataBtn.addEventListener("click", exportLatestData);
  }

  // 导出VVIP数据按钮点击事件
  const exportVVIPDataBtn = $("export-vvip-data");
  if (exportVVIPDataBtn) {
    exportVVIPDataBtn.addEventListener("click", exportVVIPData);
  }

  // 导出数据分析数据按钮点击事件
  const exportAnalysisDataBtn = $("export-analysis-data");
  if (exportAnalysisDataBtn) {
    exportAnalysisDataBtn.addEventListener("click", exportAnalysisData);
  }

  // "显示最新数据"按钮点击事件
  const getLatestDataBtn = $("get-latest-data-btn");
  if (getLatestDataBtn) {
    getLatestDataBtn.addEventListener("click", function() {
      // 显示loading mask
      const loadingMask = $("loading-mask");
      const recordCountSpan = $("record-count");

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
  const getVVIPDataBtn = $("get-vvip-data-btn");
  if (getVVIPDataBtn) {
    getVVIPDataBtn.addEventListener("click", function() {
      // 显示loading mask
      const loadingMask = $("loading-mask");
      const recordCountSpan = $("record-count");

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
  const analyzeDataBtn = $("analyze-data-btn");
  if (analyzeDataBtn) {
    analyzeDataBtn.addEventListener("click", analyzeData);
  }

  // "T-4 开始分析"按钮点击事件
  const analyzeT2DataBtn = $("analyze-t2-data-btn");
  if (analyzeT2DataBtn) {
    analyzeT2DataBtn.addEventListener("click", analyzeT2Data);
  }

  // 导出T-4分析数据按钮点击事件
  const exportT2AnalysisDataBtn = $("export-t2-analysis-data");
  if (exportT2AnalysisDataBtn) {
    exportT2AnalysisDataBtn.addEventListener("click", exportT2AnalysisData);
  }

  // LTS MD 文件上传处理
  const ltsMdUpload = $("lts-md-upload");
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
            const container = $('lts-summary-content');
            if (container) {
              renderMarkdownContent(container, content);
              showNotification("LTS 概览已更新", "success");
            }
          } catch (error) {
            log.error("读取MD文件失败:", error);
            showNotification("读取文件失败", "error");
          }
        };
        reader.readAsText(file);
      }
    });
  }
  
  // （v3.1）移动端侧边栏已移除


  // 拖拽事件处理
  const fileUpload = document.querySelector("#file-upload-form .upload-drag-wrapper");
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
  const vvipFileUpload = document.querySelector("#vvip-file-upload-form .upload-drag-wrapper");
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
  const analysisFileUpload = document.querySelector("#analysis-file-upload-form .upload-drag-wrapper");
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
  const t2AnalysisFileUpload = document.querySelector("#t2-analysis-file-upload-form .upload-drag-wrapper");
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
  const rulesFileInput = $("rules-file");
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
            const infoDiv = $("rules-file-info");
            const nameSpan = $("rules-file-name");
            if (infoDiv && nameSpan) {
              nameSpan.textContent = `已加载规则: ${file.name}`;
              infoDiv.style.display = "flex";
            }
            
            // 渲染规则列表
            renderRulesList(rules);
            
            showNotification("规则文件加载成功", "success");
          } catch (error) {
            log.error("解析规则文件失败:", error);
            showNotification("解析规则文件失败，请检查JSON格式", "error");
            appState.custom_rules = null;
            
            // 清空规则列表
            const rulesListContainer = $("rules-list-container");
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
  const t2RulesFileInput = $("t2-rules-file");
  if (t2RulesFileInput) {
    t2RulesFileInput.addEventListener("change", function(e) {
      if (this.files.length > 0) {
        const file = this.files[0];
        processT2RulesFile(file);
      }
    });
  }

  // 午餐文件上传处理
  const lunchFileInput = $("lunch-file");
  if (lunchFileInput) {
    lunchFileInput.addEventListener("change", function(e) {
      if (this.files.length > 0) {
        processLunchFile(this.files[0]);
      }
    });
  }

  // 午餐文件拖拽事件处理
  const lunchFileUpload = document.querySelector("#lunch-file-upload-form .upload-drag-wrapper");
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
  const shakeBtn = $("shake-lunch-btn");
  if (shakeBtn) {
      shakeBtn.addEventListener("click", shakeLunch);
  }

  // Bulk 操作按钮事件
  const createBulkJobBtn = $("create-bulk-job-btn");
  if (createBulkJobBtn) {
    createBulkJobBtn.addEventListener("click", handleCreateBulkJob);
  }

  const checkBulkJobBtn = $("check-bulk-job-btn");
  if (checkBulkJobBtn) {
    checkBulkJobBtn.addEventListener("click", handleCheckBulkJob);
  }

  const downloadBulkCsvBtn = $("download-bulk-csv-btn");
  if (downloadBulkCsvBtn) {
    downloadBulkCsvBtn.addEventListener("click", () => handleDownloadBulkResult('csv'));
  }

  const downloadBulkZipBtn = $("download-bulk-zip-btn");
  if (downloadBulkZipBtn) {
    downloadBulkZipBtn.addEventListener("click", () => handleDownloadBulkResult('zip'));
  }

  // Execute Anonymous 按钮事件
  const executeAnonymousBtn = $("execute-anonymous-btn");
  if (executeAnonymousBtn) {
    executeAnonymousBtn.addEventListener("click", executeAnonymousCode);
  }

  // Schedule Jobs 刷新按钮事件
  const refreshScheduleJobsBtn = $("refresh-schedule-jobs-btn");
  if (refreshScheduleJobsBtn) {
    refreshScheduleJobsBtn.addEventListener("click", loadScheduleJobs);
  }

  // Schedule Jobs 创建按钮事件
  const createScheduleJobBtn = $("create-schedule-job-btn");
  if (createScheduleJobBtn) {
    createScheduleJobBtn.addEventListener("click", createScheduleJob);
  }

  // Schedule Jobs 清除所有按钮事件
  const clearAllScheduleJobsBtn = $("clear-all-schedule-jobs-btn");
  if (clearAllScheduleJobsBtn) {
    clearAllScheduleJobsBtn.addEventListener("click", clearAllScheduleJobs);
  }

  // ===== Inspector 移植功能（section-23 ~ 26）=====

  // section-23 SOQL 数据导出
  const soqlObjectInput = $("soql-object-input");
  if (soqlObjectInput) soqlObjectInput.addEventListener("change", loadSoqlFields);
  const runSoqlBtn = $("run-soql-btn");
  if (runSoqlBtn) runSoqlBtn.addEventListener("click", runSoqlQuery);
  const exportSoqlXlsxBtn = $("export-soql-xlsx-btn");
  if (exportSoqlXlsxBtn) exportSoqlXlsxBtn.addEventListener("click", () => exportSoqlResults("xlsx"));
  const exportSoqlCsvBtn = $("export-soql-csv-btn");
  if (exportSoqlCsvBtn) exportSoqlCsvBtn.addEventListener("click", () => exportSoqlResults("csv"));
  const soqlHistorySelect = $("soql-history-select");
  if (soqlHistorySelect) {
    soqlHistorySelect.addEventListener("change", function () {
      const queryInput = $("soql-query-input");
      if (queryInput && this.value) queryInput.value = this.value;
    });
  }

  // section-24 批量数据导入
  const importFileInput = $("import-file-input");
  if (importFileInput) importFileInput.addEventListener("change", function () { handleImportFileChange(this); });
  const importObjectInput = $("import-object-input");
  if (importObjectInput) importObjectInput.addEventListener("change", handleImportObjectChange);
  const runImportBtn = $("run-import-btn");
  if (runImportBtn) runImportBtn.addEventListener("click", runDataImport);

  // section-25 Metadata 工具
  const loadMetadataTypesBtn = $("load-metadata-types-btn");
  if (loadMetadataTypesBtn) loadMetadataTypesBtn.addEventListener("click", loadMetadataTypes);
  const listMetadataMembersBtn = $("list-metadata-members-btn");
  if (listMetadataMembersBtn) listMetadataMembersBtn.addEventListener("click", listMetadataMembers);
  const metadataRetrieveBtn = $("metadata-retrieve-btn");
  if (metadataRetrieveBtn) metadataRetrieveBtn.addEventListener("click", retrieveMetadataPackage);

  // section-26 事件监听
  const eventTypeSelect = $("event-type-select");
  if (eventTypeSelect) eventTypeSelect.addEventListener("change", onEventTypeChange);
  const eventReloadChannelsBtn = $("event-reload-channels-btn");
  if (eventReloadChannelsBtn) eventReloadChannelsBtn.addEventListener("click", loadEventChannels);
  const eventSubscribeBtn = $("event-subscribe-btn");
  if (eventSubscribeBtn) eventSubscribeBtn.addEventListener("click", subscribeEventChannel);
  const eventUnsubscribeBtn = $("event-unsubscribe-btn");
  if (eventUnsubscribeBtn) eventUnsubscribeBtn.addEventListener("click", unsubscribeEventChannel);
  const eventClearBtn = $("event-clear-btn");
  if (eventClearBtn) eventClearBtn.addEventListener("click", clearEventLog);
  const eventExportBtn = $("event-export-btn");
  if (eventExportBtn) eventExportBtn.addEventListener("click", exportEventLog);

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
  const avatarContainer = $("avatar-container");
  const userMenu = $("user-menu");
  
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

// 把 marked 暴露到 window，供 ui.js / 其他模块的 Markdown 渲染使用
if (marked) {
  window.marked = marked;
}

// 页面加载完成后初始化
// 使用 readyState 判断，避免脚本在 DOMContentLoaded 之后才执行时永不初始化
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initApp);
} else {
  initApp();
}

// 将 schedule job 相关函数暴露到 window 对象，供 HTML 按钮 onclick 调用
window.deleteScheduleJob = deleteScheduleJob;
window.pauseScheduleJob = pauseScheduleJob;
window.resumeScheduleJob = resumeScheduleJob;

/**
 * 测试 OneDrive Workbook 连接
 * 从 Chrome Storage 自动读取 graph_token 和 workbook 配置进行测试
 *
 * 使用方法：在 Chrome DevTools Console 中直接输入
 *   await testOneDrive()
 *
 * 配置 Token 和 Workbook：
 *   await chrome.storage.local.set({
 *     graph_token: 'your-microsoft-graph-access-token',
 *     onedrive_workbook_path: 'Documents/data.xlsx'
 *   });
 */
window.testOneDrive = async function() {
  log.info('===== OneDrive Workbook 连接测试 =====');

  const service = new OneDriveWorkbookService();
  const result = await service.testConnection();

  log.debug('测试结果:', result);

  if (result.success) {
    showNotification(result.message, 'success');
    log.debug('Worksheet 列表:', result.worksheets.map(w => w.name));
  } else {
    showNotification(result.message, 'error');
    log.error('测试失败详情:', result);
  }

  return result;
};

/**
 * 列出 OneDrive 最近 Excel 文件（帮助查找有效的 Workbook ID）
 * 用法：await listOneDriveFiles()
 */
window.listOneDriveFiles = async function(limit = 10) {
  const service = new OneDriveWorkbookService();
  try {
    const files = await service.listRecentFiles(limit);
    const excelFiles = files.filter(f => f.name.endsWith('.xlsx'));
    log.info('===== OneDrive 最近 Excel 文件 =====');
    excelFiles.forEach((f, i) => {
      log.info(`${i + 1}. ${f.name}`);
      log.info(`   ID: ${f.id}`);
      log.info(`   URL: ${f.webUrl}`);
    });
    return excelFiles;
  } catch (error) {
    log.error('列出文件失败:', error);
    showNotification('列出文件失败: ' + error.message, 'error');
    return [];
  }
};

/**
 * 按文件名搜索 OneDrive Workbook
 * 用法：await searchOneDriveWorkbook('data.xlsx')
 */
window.searchOneDriveWorkbook = async function(fileName) {
  const service = new OneDriveWorkbookService();
  try {
    const files = await service.searchWorkbookByName(fileName);
    log.info(`===== 搜索 "${fileName}" 结果 =====`);
    files.forEach((f, i) => {
      log.info(`${i + 1}. ${f.name}`);
      log.info(`   ID: ${f.id}`);
      log.info(`   Path: ${f.path}`);
    });
    return files;
  } catch (error) {
    log.error('搜索失败:', error);
    showNotification('搜索失败: ' + error.message, 'error');
    return [];
  }
};

// 全局错误处理：捕获未处理的Promise拒绝
window.addEventListener('unhandledrejection', function(event) {
  log.error('未处理的 Promise 拒绝:', event.reason);
  showNotification(`发生未处理的错误：${event.reason.message || event.reason}`, 'error');
  
  // 隐藏所有可能的loading mask
  const loadingMasks = document.querySelectorAll('#loading-mask');
  loadingMasks.forEach(mask => {
    mask.style.display = 'none';
  });
});

// 全局错误处理：捕获未处理的错误
window.addEventListener('error', function(event) {
  log.error('全局未捕获异常:', event.error);
  showNotification(`发生全局错误：${event.error.message || event.error}`, 'error');
  
  // 隐藏所有可能的loading mask
  const loadingMasks = document.querySelectorAll('#loading-mask');
  loadingMasks.forEach(mask => {
    mask.style.display = 'none';
  });
});
