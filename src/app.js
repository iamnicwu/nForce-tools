import { createLogger } from "./common/logger.js";

const log = createLogger("APP");
import { sfConn, applyApiVersion, setAuthFailureHandler } from "./biz/sf_service.js";
import { showNotification, describeError } from "./common/utils.js";
import { replaceIcons, Icons } from "./common/icons.js";
import { $, on } from "./common/dom.js";
import { appState } from "./biz/state.js";
import { OneDriveWorkbookService } from "./common/onedrive_service.js";
// 会话自动恢复：侧边栏（side panel）里没有地址栏、也没有「重载当前页」的动线，
// 会话过期后必须能自己从浏览器 Cookie 换一个新会话，否则会永久停在「未连接」。
import { recoverSessionFromBrowser } from "./biz/session_recovery.js";
import { initUiLayout, renderLauncher } from "./biz/ui_layout.js";
// Org 状态面板：session 真正可用后必须调 markSessionReady()，
// 否则面板不会发起 limits 请求（时序约束见 org_limits.js 头部注释）
import { markSessionReady } from "./biz/org_limits.js";
// 本机偏好（目前只有 API 版本）：存 chrome.storage.local，侧边栏与标签页共享。
// 必须在任何建连之前载入 —— validateStoredSession / testConnection 都会用到版本号。
import {
  loadPrefs,
  getApiVersion,
  watchPrefsStorage,
  onPrefsChanged,
  PREF_KEYS
} from "./common/prefs.js";
import { initPrefsPanel } from "./biz/prefs_panel.js";
// 侧边栏「鼠标移出自动隐藏」。只在**侧边栏宿主**下启用 ——
// 贴边浮窗里调用它会把浏览器侧边栏关掉（模块头部的注释有详细说明）。
import { initPanelAutoHide } from "./biz/panel_auto_hide.js";
import {
  initInspectorTools,
  loadSoqlFields,
  runSoqlQuery,
  exportSoqlResults,
  handleImportFileChange,
  handleImportObjectChange,
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
  renderMarkdownContent,
  initLauncher,
  goHome
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
  fetchBulkJobs,
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
    // 成功即视为"会话新鲜"：刷新新鲜度并摘掉"疑似失效"标记（看门狗也会随之停下）
    if (isConnected) markSessionVerified();
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

/* ============================================================
 * 会话自动恢复与自动续期 —— 「过期后不必再手动连」的全部机制都在这里
 *
 * 为什么需要这么多层：会话过期有**四种完全不同的形态**，每一种能观察到的信号都不一样，
 * 只堵住其中一两种，用户就会在另一种形态下卡在「未连接」里。
 *
 *   ① 打开面板时就已经过期（浏览器闲置了一夜）
 *      → 启动时校验失败 / 根本没连上，两种都立刻自动恢复
 *   ② 用着用着过期（最阴的一种：界面徽标还绿着，会话其实已经死了）
 *      → 任意请求拿到 401/403 时自动换新会话，**并把原来那条请求重发一次**，
 *        用户完全无感。这是本轮新增的能力，也是"减少手动操作"最关键的一环。
 *   ③ 用户在别的标签页重新登录了 Salesforce，再切回面板
 *      → sid Cookie 变化（最准）+ 面板重新可见/窗口获得焦点（兜底）
 *   ④ 面板一直开着，什么都没发生（用户在别处忙了很久）
 *      → 断连期间的低频看门狗；一旦连上就自动停，不烧 API 配额
 *
 * 四层共用同一把重入锁（recoveryInFlight）与最小间隔，避免叠加成请求风暴。
 * ============================================================ */
const RECOVERY_MIN_INTERVAL_MS = 3000;

/**
 * 「会话新鲜度」阈值：距离上次确认会话可用超过这么久，用户回到面板时就复验一次。
 *
 * 为什么不再只看 `is_connected`：那是个内存布尔值，**服务端会话过期不会让它变红**。
 * 老实现里「已连接就直接返回」的短路，正是形态 ② 永远等不到自愈的原因
 * —— 用户切回来 → 短路 → 什么都没发生 → 点任何功能都失败 → 只能手动重连。
 * identity 复验是 2 个 HTTP 请求，代价远小于让用户自己去点一次重连。
 */
const VERIFY_STALE_MS = 5 * 60 * 1000;
/** 两次自动复验之间的最小间隔：focus / visibilitychange 会连续触发，必须压住 */
const VERIFY_MIN_INTERVAL_MS = 60 * 1000;

/** 看门狗：首次等待 / 最大退避 / 最多连续尝试次数（之后暂停，等新的触发源唤醒） */
const WATCHDOG_BASE_MS = 15 * 1000;
const WATCHDOG_MAX_MS = 120 * 1000;
const WATCHDOG_MAX_TRIES = 8;

let recoveryInFlight = null;
let lastRecoveryAt = 0;
/** 最近一次**真实 API 请求**被判鉴权失败（401/403）—— 即"徽标还绿着、会话其实已死" */
let sessionSuspect = false;
/** 上次**确认**会话可用的时刻（验证通过 / 恢复成功 / 手动连接成功都会刷新） */
let lastVerifiedAt = 0;
/** 上次发起自动复验的时刻（只管节流，不代表成功） */
let lastVerifyAt = 0;

/** 会话刚被确认可用：刷新新鲜度、摘掉"疑似失效"、停掉看门狗 */
function markSessionVerified() {
  lastVerifiedAt = Date.now();
  sessionSuspect = false;
  stopWatchdog();
}

/** 当前停留的 section 号（首页返回 null） */
function currentSectionNumber() {
  const active = document.querySelector(".step-section.active");
  const matched = active && active.id ? String(active.id).match(/^section-(\d+)$/) : null;
  return matched ? Number(matched[1]) : null;
}

/**
 * 在「连接设置」卡片里显示一行状态（元素不存在时静默跳过 —— 这个卡片在别的 section 时也可能不在 DOM 里）。
 * @param {string} text
 * @param {"auto-pending"|"auto-ok"|"auto-error"} state
 */
function setReconnectHint(text, state) {
  const el = $("connection-reconnect-status");
  if (!el) return;
  el.textContent = text;
  el.dataset.state = state;
  el.style.color = state === "auto-ok" ? "var(--success-color)" : state === "auto-error" ? "var(--error-color)" : "var(--warning-color)";
}

/** 自动恢复失败时给用户一句能照着做的提示（不弹错误 toast，避免反复打扰） */
function describeRecoveryFailure(reason) {
  if (reason === "no-candidate") return "浏览器里没有 Salesforce 登录态：登录后会自动重连";
  if (reason === "verify-blocked") return "校验请求没能到达 Salesforce（网络/代理），稍后会自动重试";
  return "浏览器里的会话都已失效：重新登录 Salesforce 后会自动重连";
}

/**
 * 尝试从浏览器 Cookie 恢复会话。
 * @param {string} trigger 触发源（只用于日志，排查"到底谁在重试"）
 * @param {{force?:boolean, knownBadSid?:string|null, successMessage?:string}} [opts]
 *   `force` 绕过最小间隔（启动流程与用户手动点击用）；
 *   `knownBadSid` 传刚被判失效的 sid，避免拿同一个死会话再发一次请求。
 * @returns {Promise<{ok:boolean, skipped?:string, reason?:string, tried?:number}>}
 */
async function attemptSessionRecovery(trigger, opts = {}) {
  const { force = false, knownBadSid = null, successMessage = "" } = opts;

  if (appState.is_connected) return { ok: true, skipped: "already-connected" };
  if (recoveryInFlight) return recoveryInFlight; // 已经有人在试，搭个便车
  if (!force && Date.now() - lastRecoveryAt < RECOVERY_MIN_INTERVAL_MS) {
    return { ok: false, skipped: "throttled" };
  }

  lastRecoveryAt = Date.now();
  recoveryInFlight = (async () => {
    log.info(`尝试恢复 Salesforce 会话（触发：${trigger}）`);
    setReconnectHint("正在重新获取 Salesforce 会话…", "auto-pending");
    const result = await recoverSessionFromBrowser({
      preferredInstanceUrl: appState.instance_url || null,
      knownBadSid
    });
    if (result.ok) {
      await onSessionRestored(successMessage || "已从浏览器获取新的 Salesforce 会话");
      // 未连接时侧边栏会被自动送到「连接设置」，恢复成功后把它送回功能中心
      if (currentSectionNumber() === 1) {
        goHome();
      }
      setReconnectHint("已自动获取到可用会话", "auto-ok");
    } else {
      // 自动恢复失败**不弹 toast**：形态 ④ 的看门狗会反复尝试，每次都弹就成了骚扰。
      // 只把状态写进「连接设置」卡片，用户真去看时能看到原因。
      setReconnectHint(describeRecoveryFailure(result.reason), "auto-error");
    }
    return result;
  })();

  try {
    return await recoveryInFlight;
  } finally {
    recoveryInFlight = null;
  }
}

/* ── 第 ② 层：运行期请求被判会话失效 → 自动换会话，并让原请求重试 ── */

/**
 * 由 `sf_service.setAuthFailureHandler()` 注入，被 `SfRestConnection.request()`
 * 在收到 401/403 时调用。**返回新凭据意味着那条失败的请求会被原样重发一次**，
 * 所以对用户来说就是"点了功能，正常出结果"，而不是"报错 + 自己去重连"。
 *
 * ⚠️ 刻意**不**在这里等 `recoveryInFlight`：恢复流程内部会调 `onSessionRestored()`，
 * 而后者自己也会发请求（fetchOrgInfo 查 Organization）。若那条请求再吃一个 401，
 * 就会回到这里等"正在跑的那趟恢复"，而它正等着这条请求 —— 死锁。
 * 并发 401 时让后来者按原样失败即可，不影响任何人。
 *
 * @returns {Promise<{sessionId: string, instanceUrl: string}|null>}
 */
async function handleAuthFailure() {
  sessionSuspect = true;
  log.warn("API 请求被判会话失效（401/403），尝试自动换一份新会话…");

  if (recoveryInFlight) return null; // 已经有一趟在跑，这一条按原样失败就好

  // 服务端已经明确判定失效，此刻的 `is_connected` 一定是错的，必须先摘掉：
  // `attemptSessionRecovery()` 开头有「已连接就直接返回」的短路，不摘的话恢复会被
  // 整个跳过，然后我们会把**同一个死会话**当成"续期成功"返回，重试再吃一次 401。
  // storage 先不写 —— 乐观一点，恢复成功（绝大多数情况）时它本来就会被覆盖。
  appState.is_connected = false;
  updateUIState();

  const result = await attemptSessionRecovery("运行期请求被判会话失效", {
    force: true,
    knownBadSid: appState.session_id,
    successMessage: "Salesforce 会话已过期，已自动换用浏览器里的新会话"
  });

  if (result && result.ok) {
    return { sessionId: appState.session_id, instanceUrl: appState.instance_url };
  }

  // 浏览器里也没有可用登录态：如实落盘为未连接，并交给看门狗继续等。
  // 用户重新登录 Salesforce 后，sid Cookie 变化与看门狗两条路都会把它接回来。
  log.warn("自动换新会话失败，面板保持未连接，等用户重新登录后自动恢复");
  try {
    await chrome.storage.local.set({ is_connected: false });
  } catch (e) {
    log.warn("写入未连接状态失败:", e);
  }
  ensureWatchdog();
  return null;
}

// 注入点。函数声明会提升，所以放在这里也能拿到上面的定义。
// 只要 app.js 被加载（侧边栏 / 标签页 / 贴边浮窗三种宿主都是同一个页面），
// 运行期会话过期就会自动续期，不再需要用户手动点重连。
setAuthFailureHandler(handleAuthFailure);

/* ── 第 ③ 层：用户回到面板 / 窗口重新获得焦点 ── */

/**
 * 「用户回来了」时的会话体检。
 *
 * 判据是**新鲜度**而不是 `is_connected`：
 *   · 已连接 + 不旧 + 不可疑 → 什么都不做（不打扰、不烧配额）
 *   · 否则复验；确认失效就顺手换新会话（`reconnectNow` 内部完成）
 * 用 VERIFY_MIN_INTERVAL_MS 压住 focus / visibilitychange 的连续触发。
 *
 * @param {string} trigger
 */
async function ensureSessionHealthy(trigger) {
  if (document.visibilityState === "hidden") return { ok: true, skipped: "hidden" };

  const now = Date.now();
  if (appState.is_connected && !sessionSuspect && now - lastVerifiedAt < VERIFY_STALE_MS) {
    return { ok: true, skipped: "fresh" };
  }
  if (now - lastVerifyAt < VERIFY_MIN_INTERVAL_MS) return { ok: false, skipped: "throttled" };

  lastVerifyAt = now;
  return reconnectNow(trigger);
}

/* ── 第 ④ 层：看门狗（断连期间的低频重试，连上即停） ── */

let watchdogTimer = null;
let watchdogTries = 0;
let watchdogDelay = WATCHDOG_BASE_MS;

/** 停表并复位（注意：只清定时器与计数，不改变任何会话状态） */
function stopWatchdog() {
  if (watchdogTimer !== null) clearTimeout(watchdogTimer);
  watchdogTimer = null;
  watchdogTries = 0;
  watchdogDelay = WATCHDOG_BASE_MS;
}

function scheduleWatchdog(delay) {
  if (watchdogTimer !== null) clearTimeout(watchdogTimer);
  watchdogTimer = setTimeout(watchdogTick, delay);
}

/**
 * 保证看门狗在跑（幂等）。
 *
 * 只有「未连接」或「疑似失效」才需要它 —— 连接正常时它一次都不会跑，
 * 从根上避免"为了自愈而一直烧 API 配额"。
 * @param {{reset?: boolean}} [opts] `reset` 用于"新的触发源来了，重新从最短间隔开始"
 */
function ensureWatchdog({ reset = false } = {}) {
  if (reset) {
    watchdogTries = 0;
    watchdogDelay = WATCHDOG_BASE_MS;
  }
  if (watchdogTimer !== null) return;
  if (appState.is_connected && !sessionSuspect) return;
  scheduleWatchdog(watchdogDelay);
}

async function watchdogTick() {
  watchdogTimer = null;
  if (appState.is_connected && !sessionSuspect) {
    stopWatchdog();
    return;
  }
  // 面板不可见时只把闹钟往后推、不发任何请求：没人看着，连上了也没意义
  if (document.visibilityState === "hidden") {
    scheduleWatchdog(WATCHDOG_MAX_MS);
    return;
  }

  watchdogTries += 1;
  const result = await attemptSessionRecovery(`看门狗第 ${watchdogTries} 次`, {
    force: true,
    // 疑似失效时跳过刚刚被判死的那条会话，别拿它再发一次无谓请求
    knownBadSid: sessionSuspect ? appState.session_id : null
  });
  if (result && result.ok) {
    stopWatchdog();
    return;
  }

  if (watchdogTries >= WATCHDOG_MAX_TRIES) {
    log.info(
      `看门狗已连续尝试 ${watchdogTries} 次仍未连上，暂停自动重试` +
        `（重新回到面板、窗口获得焦点，或登录 Salesforce 后都会再次触发）`
    );
    stopWatchdog();
    return;
  }
  watchdogDelay = Math.min(watchdogDelay * 2, WATCHDOG_MAX_MS);
  scheduleWatchdog(watchdogDelay);
}

/**
 * 注册"环境变了就再确认一次"的监听：sid Cookie 变化、面板重新可见、窗口重新获得焦点。
 *
 * 三者的信号强度不同，因此**不是同一套守卫**：
 *   · `cookies.onChanged`（sid）—— 表示"登录态真的变了"，是最强的信号：用户在别的
 *     标签页重新登录 / 换了 org。未连接或疑似失效时**绕过所有节流立刻复验**
 *     （这正是"用户刚登录完，等着面板自己好"的那一刻）。
 *   · `visibilitychange` / `window.focus` —— 只表示"用户回来了"，会话未必变。
 *     走 `ensureSessionHealthy()`：按会话**新鲜度**决定要不要复验，而不是被
 *     `is_connected` 这个可能已经骗人的布尔值一票否决。
 *
 * 幂等：重复调用只绑一次。
 */
let recoveryWatchersBound = false;
function watchSessionRecovery() {
  if (recoveryWatchersBound) return;
  recoveryWatchersBound = true;

  // ⑤ Salesforce 的 sid Cookie 变化 = 用户刚在某个标签页登录/换号。
  //    只认 sid，且限制在 Salesforce 域上，其他 Cookie 一律忽略。
  //    `info.removed` 为真表示是删除（登出/清理），没有可恢复的东西，直接忽略。
  try {
    chrome.cookies?.onChanged?.addListener((info) => {
      const cookie = info && info.cookie;
      if (!cookie || cookie.name !== "sid" || info.removed) return;
      const domain = String(cookie.domain || "").replace(/^\./, "");
      if (!/salesforce\.com$|force\.com$/i.test(domain)) return;

      if (!appState.is_connected || sessionSuspect) {
        reconnectNow("检测到 Salesforce sid Cookie 变化");
      } else {
        ensureSessionHealthy("检测到 Salesforce sid Cookie 变化");
      }
    });
  } catch (e) {
    log.warn("注册 Cookie 变化监听失败（不影响手动恢复）:", e);
  }

  // ③-a 面板重新可见：被鼠标移出自动隐藏后又被召回，或窗口从后台切回来
  // ③-b 窗口重新获得焦点：用户去浏览器里登录完 Salesforce 再切回来
  const onWakeUp = (trigger) => {
    ensureSessionHealthy(trigger)
      .catch((e) => log.warn(`会话体检异常（${trigger}）:`, e))
      // 无论体检结果如何，都确保看门狗在跑（未连接时它是最后一道兜底）
      .then(() => ensureWatchdog());
  };
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    onWakeUp("面板重新可见");
  });
  window.addEventListener("focus", () => onWakeUp("窗口重新获得焦点"));
}

/**
 * 「先复验，失效才换新会话」的统一入口 ——
 * 自动触发源（回到面板 / 获得焦点 / sid Cookie 变化）与用户手动点按钮都走它。
 *
 * 为什么不直接调 `attemptSessionRecovery()`：后者开头有「已连接就直接返回」的短路，
 * 而最需要救的场景恰恰是「界面说已连接、其实会话已经过期」。
 * 所以这里先真的复验一次（`validateStoredSession()`，成功会自动 `markSessionVerified()`），
 * 确认失效了才把状态降级、去浏览器 Cookie 换新的。
 *
 * @param {string} trigger
 * @returns {Promise<{ok:boolean, skipped?:string, reason?:string}>}
 */
async function reconnectNow(trigger) {
  if (appState.is_connected) {
    const stillOk = await validateStoredSession();
    if (stillOk) {
      log.info(`复验通过（触发：${trigger}），当前会话仍然有效，无需换新`);
      return { ok: true, skipped: "verified-still-valid" };
    }
    if (!isSessionAuthFailure()) {
      // 校验请求被网络/CSP 拦住 —— 会话本身可能还好，不能贸然标记为未连接
      log.warn("复验未通过但无法判定会话失效（多为网络/CSP）：", sfConn.lastError);
      return { ok: false, reason: "verify-blocked" };
    }
    log.warn(`复验确认会话已失效（触发：${trigger}），切换到未连接并重新获取`);
    sessionSuspect = true;
    appState.is_connected = false;
    updateUIState();
  }
  // 刚复验过的这条会话已经确定是死的，别再拿它去发一次请求
  return attemptSessionRecovery(trigger, { force: true, knownBadSid: appState.session_id });
}

/** 会话恢复 / 自动刷新成功后的统一收尾（补齐用户与组织信息并刷新 UI） */
async function onSessionRestored(message) {
  // 会话刚被确认可用：刷新新鲜度、摘掉"疑似失效"、停掉看门狗。
  // 必须放在最前面 —— 后面的请求要是再出问题，标记要反映的是那之后的状态。
  markSessionVerified();
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

/* ============================================================
 * 显示宿主：浏览器侧边栏 ⇄ 普通标签页 ⇄ 贴边浮窗
 *
 * 侧边栏与标签页加载的是同一个 index.html（manifest 的
 * side_panel.default_path 指向它），所以必须在运行时区分宿主：
 *   · 侧边栏 → 顶栏给「完整应用」（在新标签页打开，宽屏更适合看表格与图表）
 *   · 标签页 → 顶栏给「侧边栏」（chrome.sidePanel.open 停靠到窗口右侧）
 *   · 贴边浮窗 → 同「完整应用」，窄栏排版
 * 排版本身由 main.css 末尾的「浏览器侧边栏排版层」按宽度生效，与这里的判定
 * 无关 —— 判定失败最多是少一个顶栏按钮，不会退化成难用的界面。
 * ============================================================ */
const HOST_PANEL = "panel";
const HOST_TAB = "tab";
/** 贴边浮窗（`src/dock.js` 注入到 Salesforce 页面里的 iframe，加载 index.html?dock=1） */
const HOST_DOCK = "dock";
let activeHost = HOST_TAB;
let hostSwitchBound = false;

/**
 * 贴边浮窗的自报家门。
 *
 * 为什么不能靠 API 判定：浮窗是个 iframe，`chrome.tabs.getCurrent()` 在子 frame 里
 * 会返回**宿主标签页**，于是它和普通标签页长得一模一样，必然被误判成 host-tab
 * （表现：顶栏按钮方向反了、窄栏排版不生效）。
 * 所以由 `dock.js` 在加载时带上 `?dock=1`，这里优先采信它 ——
 * 这个信号是自证的，不存在信号 1/2 之间「谁先谁后」的顺序问题。
 */
function detectDockHost() {
  try {
    if (new URLSearchParams(location.search).get("dock") === "1") return HOST_DOCK;
  } catch (e) {
    log.debug("解析 ?dock= 参数失败:", e);
  }
  return null;
}

async function detectHost() {
  // 信号 0（自证，优先级最高）：贴边浮窗带 ?dock=1 加载
  const dock = detectDockHost();
  if (dock) return dock;

  // 信号 1（决定性）：chrome.tabs.getCurrent() 只在「标签页」上下文里返回 tab 对象；
  // 侧边栏不属于任何标签页，返回 undefined。
  //
  // 这里必须先用它、而不是先比对 documentUrl —— 侧边栏与标签页加载的是同一个
  // index.html，两者的 documentUrl 完全相同。若先按 URL 比对就会把「另一个宿主存在的
  // 事实」误读成「我就是那个宿主」：标签页与侧边栏同时打开时，标签页会误判自己是
  // 侧边栏，顶栏按钮方向反过来（实测复现过）。
  // getCurrent() 回答的是「我是谁」，URL 比对只能回答「有没有别的宿主」，故以前者为准。
  try {
    const tab = await chrome.tabs.getCurrent();
    return tab ? HOST_TAB : HOST_PANEL;
  } catch (e) {
    log.debug("tabs.getCurrent 不可用，改用 runtime.getContexts 判定宿主:", e);
  }

  // 信号 2（Chrome 116+ 兜底）：拿不到 tab 又查不到自己这个 SIDE_PANEL 上下文时，
  // 按普通标签页处理更安全 —— 判错的代价只是顶栏多/少一个按钮。
  try {
    if (typeof chrome.runtime.getContexts === "function") {
      const self = location.href.split(/[?#]/)[0];
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
      if (contexts.some((c) => String(c.documentUrl || "").split(/[?#]/)[0] === self)) {
        return HOST_PANEL;
      }
    }
  } catch (e) {
    log.debug("runtime.getContexts 判定失败，按普通标签页处理:", e);
  }
  return HOST_TAB;
}

/** 按宿主设置 body 标记 + 顶栏「完整应用 / 侧边栏」切换按钮 */
function applyHostChrome(host) {
  const isPanel = host === HOST_PANEL;
  const isDock = host === HOST_DOCK;
  // 侧边栏与贴边浮窗都是「窄栏」：共用一套窄屏排版（main.css 的宽度媒体查询
  // 本来就会命中，这里保持 class 语义一致，方便按宿主写例外样式）。
  const isNarrow = isPanel || isDock;
  activeHost = host;
  document.body.classList.toggle("host-panel", isNarrow);
  document.body.classList.toggle("host-tab", !isNarrow);
  document.body.classList.toggle("host-dock", isDock);

  const btn = $("host-switch-btn");
  if (!btn) {
    log.warn("未找到 #host-switch-btn，跳过宿主切换按钮初始化");
    return;
  }
  // 直接注入 Icons 里的 SVG 字面量：顶栏是动态渲染的，replaceIcons() 已经跑过
  btn.innerHTML = isNarrow
    ? `${Icons.externalLink}<span>完整应用</span>`
    : `${Icons.outdent}<span>侧边栏</span>`;
  btn.title = isPanel
    ? "在新标签页中打开完整应用（宽屏更适合看数据表格与图表）"
    : isDock
      ? "在新标签页中打开完整应用"
      : "在浏览器侧边栏中打开（可固定在右侧，也可随时隐藏）";
  btn.hidden = false;

  // initApp 可能被重复调用（点顶部标题会重新初始化），事件只绑一次
  if (hostSwitchBound) return;
  hostSwitchBound = true;

  on("host-switch-btn", "click", async () => {
    if (activeHost !== HOST_TAB) {
      // 侧边栏 / 贴边浮窗 → 标签页：同一个 index.html，只是换成宽屏宿主
      await chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
      return;
    }
    // 标签页 → 侧边栏：sidePanel.open 必须在用户手势里调用（这次点击就是），
    // 且必须显式指定 windowId，否则 Chrome 无法确定停靠到哪个窗口
    try {
      const win = await chrome.windows.getCurrent();
      await chrome.sidePanel.open({ windowId: win.id });
      log.info("已把 nForce Tools 停靠到当前窗口的侧边栏");
    } catch (e) {
      log.error("打开侧边栏失败:", e);
      showNotification("当前浏览器不支持侧边栏，或侧边栏已被禁用", "warning");
    }
  });
}

function sameJson(a, b) {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch (e) {
    return false;
  }
}

/**
 * 跨宿主同步会话状态。
 * 侧边栏与标签页可以同时开着（用户可固定侧边栏、再另开一个完整应用），
 * 两边共享 chrome.storage.local。若不同步，就会出现「在标签页登录成功了，
 * 侧边栏还停在未连接」，反之亦然。
 * 注意：这个监听只读 storage、从不回写，所以不存在互相触发的死循环。
 */
let sessionWatchBound = false;
function watchSessionStorage() {
  if (sessionWatchBound) return;
  sessionWatchBound = true;

  try {
    chrome.storage.onChanged.addListener(async (changes, area) => {
      if (area !== "local") return;
      const keys = ["sf_session_id", "sf_instance_url", "is_connected", "userInfo", "orgInfo"];
      if (!keys.some((k) => k in changes)) return;

      const next = {
        session_id: "sf_session_id" in changes ? changes.sf_session_id.newValue || null : appState.session_id,
        instance_url: "sf_instance_url" in changes ? changes.sf_instance_url.newValue || null : appState.instance_url,
        is_connected: "is_connected" in changes ? changes.is_connected.newValue === true : appState.is_connected,
        userInfo: "userInfo" in changes ? changes.userInfo.newValue || null : appState.userInfo,
        orgInfo: "orgInfo" in changes ? changes.orgInfo.newValue || null : appState.orgInfo
      };

      // 与当前内存状态一致就什么都不做（本页自己写入 storage 时会走到这里）
      const changed =
        next.session_id !== appState.session_id ||
        next.instance_url !== appState.instance_url ||
        next.is_connected !== appState.is_connected ||
        !sameJson(next.userInfo, appState.userInfo) ||
        !sameJson(next.orgInfo, appState.orgInfo);
      if (!changed) return;

      const wasConnected = appState.is_connected;
      appState.session_id = next.session_id;
      appState.instance_url = next.instance_url;
      appState.is_connected = next.is_connected;
      appState.userInfo = next.userInfo;
      appState.orgInfo = next.orgInfo;

      log.info(
        `另一处（标签页/侧边栏）更新了连接信息，同步本页：is_connected=${appState.is_connected}`
      );

      // session 刚变为可用：打开 Org 状态面板的请求门闩（时序约束见 org_limits.js），
      // 并摘掉本页可能残留的"疑似失效"标记、停掉看门狗 —— 另一处既然连上了，就不必再自愈。
      if (appState.is_connected) {
        sessionSuspect = false;
        stopWatchdog();
        markSessionReady();
      }

      // updateUIState 内部会刷新连接徽标与各 section 的解锁状态
      updateUIState();
      try {
        await renderLauncher();
      } catch (e) {
        log.warn("同步连接状态后刷新首页失败:", e);
      }

      if (!wasConnected && appState.is_connected) {
        showNotification("已同步另一处建立的 Salesforce 连接", "success");
      } else if (wasConnected && !appState.is_connected) {
        showNotification("Salesforce 连接已在另一处断开", "warning");
      }
    });
  } catch (e) {
    log.warn("注册连接状态同步监听失败:", e);
  }
}

// 初始化应用
async function initApp() {
  // 先判定显示宿主（侧边栏 / 标签页）并配置顶栏切换按钮。
  // 放在最前面：body 上的宿主标记越早打上越好，避免排版闪一下再变。
  let host = HOST_TAB;
  try {
    host = await detectHost();
  } catch (e) {
    log.warn("宿主判定异常，按普通标签页处理:", e);
  }
  applyHostChrome(host);
  log.info(
    `当前显示宿主：${
      host === HOST_PANEL ? "浏览器侧边栏" : host === HOST_DOCK ? "贴边浮窗" : "标签页"
    }`
  );

  // 侧边栏独有的行为：鼠标移出后自动隐藏。
  // 必须卡在 host === HOST_PANEL 上：贴边浮窗的收起由 dock.js 自己管，
  // 且浮窗里调 sidePanel.close 关掉的是**浏览器侧边栏**，与用户所见无关。
  if (host === HOST_PANEL) {
    try {
      initPanelAutoHide();
    } catch (e) {
      log.warn("侧边栏自动隐藏初始化失败（不影响其他功能）:", e);
    }
  }

  // 侧边栏与标签页可能同时开着，连接状态要双向同步
  watchSessionStorage();

  // ===== 载入本机偏好（API 版本）=====
  // 位置很关键：必须早于 validateStoredSession() / onSessionRestored() / testConnection()，
  // 否则会话校验与后续所有请求都会先用默认版本发一次。
  try {
    await loadPrefs();
    applyApiVersion(getApiVersion());
    watchPrefsStorage();
    // 另一处（侧边栏/标签页）改了版本 → 本页也切过去。
    // 注意这里不写 storage（prefs.js 已写过了），只改运行时值，避免来回触发。
    onPrefsChanged((prefs) => applyApiVersion(prefs[PREF_KEYS.apiVersion]));
  } catch (e) {
    log.warn("偏好初始化失败，本次使用默认 API 版本:", e);
  }

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
  //
  // 另一种伪"已连接"：标记是 true，但 session_id / instance_url 缺了一个
  // （storage 被部分清过、或外部写入了半套值）。这种状态既通过了 `is_connected` 的门禁，
  // 又没有会话可用 —— 每个功能都会以「尚未连接 Salesforce」失败。
  // 直接按未连接处理并交给下面的恢复流程，别让它挂在中间态。
  if (appState.is_connected && !(appState.session_id && appState.instance_url)) {
    log.warn("标记为已连接但缺少 session_id / instance_url，按未连接处理并尝试恢复");
    appState.is_connected = false;
  }
  if (appState.is_connected && appState.session_id && appState.instance_url) {
    const isValid = await validateStoredSession();
    if (isValid) {
      log.info("已恢复 Salesforce 会话");
      await onSessionRestored();
    } else if (isSessionAuthFailure()) {
      // 只有服务端明确返回「会话无效」时才需要处理。
      // 先尝试从浏览器 Cookie 自动获取新 session（用户浏览器仍登录着的话即可无感续期），
      // 拿不到新会话才降级为未连接。
      log.warn("Salesforce 会话已失效，尝试从浏览器 Cookie 自动获取新会话...");
      // ⚠️ 必须**先**把内存里的连接标记摘掉再尝试恢复。
      // `attemptSessionRecovery` 开头有「已连接就直接返回」的短路（它是给自动触发器用的），
      // 而这里的 is_connected 还是 true（服务端刚判失效，但标记还没改）——不摘的话恢复会被
      // 整个跳过，界面停在「已连接」而 sfConn.connection 已是 null，每个功能都报
      // 「尚未连接 Salesforce」，比明确失败更难查。storage 不在这里写，
      // 由下面的成功/降级分支统一落盘，避免中间态被别的宿主读到。
      appState.is_connected = false;
      const recovery = await attemptSessionRecovery("启动时会话校验失败", {
        force: true,
        knownBadSid: appState.session_id,
        successMessage: "Session 已过期，已自动从浏览器获取新会话"
      });
      if (!recovery.ok) {
        log.warn("自动获取新会话失败，降级为未连接状态（保留 session ID 便于重试）");
        appState.is_connected = false;
        sessionSuspect = true; // 服务端刚判失效，别让"徽标还是绿的"继续骗人
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
        // 从这里开始交给看门狗：用户去 Salesforce 重新登录后，无需任何手动操作
        ensureWatchdog({ reset: true });
        // 文案要点：现在**不需要**用户去点什么按钮了 —— 后台看门狗 + sid Cookie 监听
        // 会在用户重新登录 Salesforce 的那一刻自动把连接接回来。所以这里只说明现状。
        showNotification(
          "Salesforce 会话已过期：在浏览器里重新登录 Salesforce 即可，面板会自动重新连接",
          "warning"
        );
      }
    } else {
      // 无法判定会话失效（多为请求被拦截）：保留已连接状态，仅记录日志
      log.warn("启动时会话校验未通过（可能是网络/CSP 限制），保留已连接状态。原因:", sfConn.lastError);
      // session 本身来自存储且未被判失效：视为可用，打开 limits 请求门闩
      // （若网络确实不通，limits 拉取会走既有失败态，不影响其他功能）
      markSessionReady();
    }
  } else if (!appState.is_connected) {
    // 未连接（含"上次降级为未连接"）：启动即尝试一次自动恢复，让用户不必手动走一遍登录流程。
    //
    // 这里**刻意不再要求 appState.instance_url 存在**：候选会话可以从当前打开的
    // Salesforce 标签页 URL、或 Cookie 自身的域推出来（见 session_recovery.js）。
    // 旧写法一旦丢了 instance_url 就直接放弃，正是"一直未连接、怎么都刷不出来"的一条成因。
    // 浏览器里本就没有登录态时，这次尝试不会发任何网络请求（没有候选就直接返回）。
    await attemptSessionRecovery("启动时未连接", { force: true });
  }

  // 启动时还没连上 → 交给看门狗在后台继续重试（每 15s 起、退避到最多 2 分钟、
  // 连续 8 次仍失败就暂停）。这样用户去浏览器里登录完 Salesforce 再回来时，
  // 面板多半已经自己连好了，不必再手动点任何按钮。
  ensureWatchdog({ reset: true });

  // 环境变化即可自动重试（sid Cookie 变化 / 面板重新可见 / 窗口重新获得焦点）。
  // 必须放在会话恢复之后绑：否则启动过程中就触发一次，与上面的启动尝试叠在一起。
  watchSessionRecovery();

  // 会话恢复 / 自动刷新都结束后，仍未连接才提示（避免先弹警告又马上连接成功的噪音）
  if (!appState.is_connected) {
    if (host !== HOST_TAB) {
      // 侧边栏 / 贴边浮窗又窄又高，一个 toast 很容易被忽略，而且首页全是「需连接」的灰磁贴。
      // 直接把用户送到「连接设置」卡片 —— 那里有「自动获取 Session 并重新连接」按钮
      // （现在它更多是"手动催一下"的用途，正常情况下后台会自动连上），
      // 侧边栏里没有地址栏可以重载，这个按钮仍是它的兜底自救入口。
      log.info(`${host === HOST_DOCK ? "贴边浮窗" : "侧边栏"}内尚未连接，直接进入「连接设置」`);
      showSection(1);
    }
    showNotification("尚未连接 Salesforce：若浏览器里登录过该 org，面板会自动连上", "warning");
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
          // session 刚测试通过：刷新新鲜度、摘掉"疑似失效"、停掉看门狗
          markSessionVerified();
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
        // 服务端明确判失效（而不是网络/笔误被拦）才算"会话疑似失效"，
        // 并让看门狗接手 —— 粘贴的 Session ID 可能只是过期了，浏览器里另有可用的会话。
        if (isSessionAuthFailure()) {
          sessionSuspect = true;
          ensureWatchdog({ reset: true });
        }

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

  // 「自动获取 Session 并重新连接」（section-1）
  // 这是侧边栏里唯一的自救入口：面板没有地址栏、也没法"重载当前页"，
  // 会话过期后如果只能手动粘贴 Session ID，多数用户就卡死在「未连接」了。
  on("connection-reconnect-btn", "click", async () => {
      const btn = $("connection-reconnect-btn");
      const statusElement = $("connection-reconnect-status");
      const originalHtml = btn ? btn.innerHTML : "";

      if (btn) {
        btn.disabled = true;
        btn.innerHTML = `${Icons.spinner} <span>正在读取浏览器会话...</span>`;
      }
      if (statusElement) {
        statusElement.textContent = "正在从浏览器 Cookie 中查找可用的 Salesforce 会话...";
        statusElement.style.color = "var(--warning-color)";
        statusElement.dataset.state = "pending";
      }

      let result;
      try {
        result = await reconnectNow("手动点击「自动获取 Session」");
      } catch (e) {
        log.error("自动获取 Session 异常:", e);
        result = { ok: false, reason: "error" };
      }

      if (result.ok) {
        // 成功时 onSessionRestored() 已经弹过成功提示，并且会把界面送回功能中心
        if (statusElement) {
          const already = result.skipped === "already-connected";
          const stillValid = result.skipped === "verified-still-valid";
          statusElement.innerHTML = stillValid
            ? `${Icons.checkCircle} 当前连接正常，无需重新获取`
            : already
              ? `${Icons.checkCircle} 当前已是连接状态`
              : `${Icons.checkCircle} 已获取到可用会话`;
          statusElement.style.color = "var(--success-color)";
          statusElement.dataset.state = "ok";
        }
      } else {
        const hint =
          result.reason === "no-candidate"
            ? "浏览器里没有找到 Salesforce 登录态：请先打开该 org 的 Salesforce 页面完成登录，再点一次。"
            : result.reason === "verify-blocked"
              ? "校验请求没能到达 Salesforce（可能是网络/代理被拦），当前连接状态未改动，请稍后再试。"
              : result.reason === "throttled"
                ? "刚刚已经试过一次了，请稍等几秒再点。"
                : "浏览器里的会话都已失效：请重新登录 Salesforce，或在上方手动粘贴新的 Session ID。";
        if (statusElement) {
          statusElement.innerHTML = `${Icons.timesCircle} ${hint}`;
          statusElement.style.color = "var(--error-color)";
          statusElement.dataset.state = "error";
        }
        showNotification(hint, "warning");
      }

      if (btn) {
        btn.disabled = false;
        btn.innerHTML = originalHtml;
      }
    });

  // 「打开登录页」。login.html 原本唯一的入口是 chrome.action.onClicked，
  // 而侧边栏启用 openPanelOnActionClick 之后 Chrome 就不再派发该事件 ——
  // 这个页面事实上变成了孤儿，这里把入口补回来（它会枚举所有 org 让用户挑一个）。
  // 登录成功写的是 chrome.storage，侧边栏的 storage 监听会自动同步过来。
  on("connection-open-login-btn", "click", () => {
      try {
        chrome.tabs.create({ url: chrome.runtime.getURL("login.html") });
      } catch (e) {
        log.error("打开登录页失败:", e);
        showNotification("打开登录页失败", "error");
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

  // 设置页内的「插件偏好」（section-28）：API 版本 + 侧边栏位置
  initPrefsPanel();

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

  // 「同时同步到 OneDrive」开关（默认关闭，显式选择后才会上传报表数据）
  const reportSyncCheckbox = $("report-sync-onedrive-checkbox");
  if (reportSyncCheckbox) {
    // 启动时回填上次的选择；读不到就保持未勾选
    chrome.storage.local
      .get("onedrive_report_sync")
      .then((stored) => {
        reportSyncCheckbox.checked = stored?.onedrive_report_sync === true;
      })
      .catch((error) => log.warn("读取 OneDrive 同步开关失败:", error));
  }
  on("report-sync-onedrive-checkbox", "change", (event) => {
    const enabled = event.target.checked === true;
    chrome.storage.local
      .set({ onedrive_report_sync: enabled })
      .catch((error) => log.warn("保存 OneDrive 同步开关失败:", error));
    log.info(`报表 OneDrive 同步已${enabled ? "开启" : "关闭"}`);
  });

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

  // 「正在运行的 Bulk Job」列表刷新按钮
  // （这个按钮以前是死的：没接线，且它依赖的 getAllBulkQueryJobs 打错了端点）
  on("refresh-bulk-jobs-btn", "click", fetchBulkJobs);

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

  // 注：这里曾绑定 `.page-header` 的点击「重新初始化」，
  // 但该元素在 index.html 里已不存在（顶栏改为 .top-nav），属于永不执行的死代码。
  // 更要紧的是：一旦有人把 .page-header 加回来，它会重复执行 initApp() → bindEvents()
  // 再次注册一遍 document 上的点击委托，导致每个点击被处理两次。
  // 如需「重新初始化」，请改用显式按钮（如 #launcher-retry-btn 的做法）。

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
// 注意：reason 可能是 undefined（Promise.reject() 无理由），必须走 describeError 兜底，
// 否则「错误处理器自己抛错」会把真正的错误信息吞掉。
window.addEventListener('unhandledrejection', function(event) {
  log.error('未处理的 Promise 拒绝:', event?.reason);
  showNotification(`发生未处理的错误：${describeError(event?.reason)}`, 'error');
  
  // 隐藏所有可能的loading mask
  const loadingMasks = document.querySelectorAll('#loading-mask');
  loadingMasks.forEach(mask => {
    mask.style.display = 'none';
  });
});

// 全局错误处理：捕获未处理的错误
// 资源加载失败（img/script 404）时 event.error 为 null，此时文字信息在 event.message 上。
window.addEventListener('error', function(event) {
  log.error('全局未捕获异常:', event?.error ?? event?.message);
  const detail = event?.error ? describeError(event.error) : (event?.message || '未知错误');
  showNotification(`发生全局错误：${detail}`, 'error');
  
  // 隐藏所有可能的loading mask
  const loadingMasks = document.querySelectorAll('#loading-mask');
  loadingMasks.forEach(mask => {
    mask.style.display = 'none';
  });
});
