
// Service Worker for nForce Tools
// 使用 Chrome Alarm API 管理定时任务
import { createLogger } from "./common/logger.js";
// 偏好层：SW 也要初始化它（跨宿主同步 + 供搜索浮层读常用/布局）。
// ⚠️ 本文件是**逐字复制**进 dist 的 ESM service worker，它的 import 必须真的存在：
// tools/build-plan.mjs 的 COPY_RULES 里为 prefs.js 与它依赖的
// api_version.js / shortcut.js / logger.js 各列了一条复制规则（check-ui 的 J 组会盯这件事）。
import { loadPrefs, watchPrefsStorage } from "./common/prefs.js";
// 全局搜索（Alt+Shift+S）的消息名与 storage 键。两端（这里 / biz/command_palette.js
// / src/search_overlay.js）共用同一份常量，理由见 ui_events.js 头部；
// 同样在 COPY_RULES 里登记过。
import { UI_MESSAGE, UI_STORAGE } from "./common/ui_events.js";
// 注入到网页的搜索浮层由这里提供数据与渲染：条目构建与结果 HTML 都复用
// 插件面板那一套（common/command_index.js / common/cmdk_view.js）——
// 浮层是"复制型的经典脚本"，连 import 都不能有，所以只能由我们把现成的结果发过去。
// ⚠️ 这两个模块（含它们依赖的 fuzzy / icons / utils）都必须有对应的 COPY_RULES：
// 本文件是**逐字复制**的 ESM service worker，import 的目标在 dist 里必须真实存在。
import { buildSearchEntries, defaultFavoriteIds } from "./common/command_index.js";
import { renderList, shellHtml } from "./common/cmdk_view.js";

const log = createLogger("BG");

// 版本号唯一来源是 manifest.json，不要在这里硬编码
log.info(`Service Worker 已启动（v${chrome.runtime.getManifest().version}-onedrive）`);

// Storage key for task configs
const TASK_CONFIGS_KEY = 'schedule_task_configs';

// Storage key for paused tasks
const PAUSED_TASKS_KEY = 'schedule_paused_tasks';

// 获取存储的任务配置
async function getTaskConfigs() {
  try {
    const result = await chrome.storage.local.get(TASK_CONFIGS_KEY);
    return result[TASK_CONFIGS_KEY] || {};
  } catch (error) {
    log.error("读取任务配置失败:", error);
    return {};
  }
}

// 保存任务配置到存储
async function saveTaskConfigs(configs) {
  try {
    await chrome.storage.local.set({ [TASK_CONFIGS_KEY]: configs });
  } catch (error) {
    log.error("保存任务配置失败:", error);
  }
}

// 获取暂停的任务列表
async function getPausedTasks() {
  try {
    const result = await chrome.storage.local.get(PAUSED_TASKS_KEY);
    return result[PAUSED_TASKS_KEY] || {};
  } catch (error) {
    log.error("读取暂停任务列表失败:", error);
    return {};
  }
}

// 保存暂停的任务列表
async function savePausedTasks(pausedTasks) {
  try {
    await chrome.storage.local.set({ [PAUSED_TASKS_KEY]: pausedTasks });
  } catch (error) {
    log.error("保存暂停任务列表失败:", error);
  }
}

// 监听扩展安装
chrome.runtime.onInstalled.addListener(() => {
  log.info("扩展已安装");
  initSidePanel();
});

// 监听 alarm 触发
chrome.alarms.onAlarm.addListener((alarm) => {
  log.info("Alarm 触发:", alarm.name);
  
  // 异步获取任务配置
  getTaskConfigs().then((configs) => {
    const config = configs[alarm.name];
    if (config) {
      log.debug("找到任务配置:", config);
      
      // 发送消息给前端页面
      chrome.runtime.sendMessage({
        type: 'ALARM_TRIGGERED',
        alarm: alarm,
        config: config
      }).catch(err => {
        log.debug("无活动页面可接收消息:", err.message);
      });
    } else {
      log.debug("未找到该 Alarm 的任务配置:", alarm.name);
    }
  });
});

const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';

// 处理 OneDrive API 请求（代理 content script 的 fetch，避免宿主页 CSP 限制）
async function handleOneDriveApiRequest(request, sendResponse) {
  try {
    const { url, method, body, headers } = request;

    const options = {
      method: method || 'GET',
      headers: headers || {
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    };

    if (body && (method === 'POST' || method === 'PATCH')) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    // 处理错误状态码
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      sendResponse({
        success: false,
        error: `Graph API error (${response.status}): ${errorData.error?.message || response.statusText}`
      });
      return;
    }

    // 204 No Content
    if (response.status === 204) {
      sendResponse({ success: true, data: null });
      return;
    }

    const data = await response.json();
    sendResponse({ success: true, data });
  } catch (error) {
    log.error("OneDrive API 代理请求失败:", error);
    sendResponse({ success: false, error: error.message });
  }
}

// 验证消息来源是否合法
function isValidSender(sender) {
  // 允许扩展内部页面
  if (!sender.url && !sender.tab) return false;
  const validPrefixes = [
    'chrome-extension://',
    'moz-extension://',
    'edge://extension/'
  ];
  // 扩展内部页面（popup, options 等）
  if (sender.url && validPrefixes.some(prefix => sender.url.startsWith(prefix))) {
    return true;
  }
  // Content script：通过 sender.tab.id 确认是本扩展注入的
  if (sender.tab && sender.tab.id) {
    return true;
  }
  return false;
}

// 监听来自前端的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // ⚠️ 必须最先放行 `search:*`（那条链路的监听器在文件末尾）。
  // Chrome 对同一条消息会依次调用**所有**监听器，但只认**第一个** sendResponse：
  // 这里下面的白名单校验对 `search:open` 是"未知类型"，会立刻回一个
  // `{success:false, error:'Invalid message type'}`，于是后面那个监听器的
  // 异步回话永远送不出去（浮层只拿到 ok=false）→ 浮层静默地永远打不开。
  // 静态检查与截图都抓不到这个：它只在真实网页上才暴露。
  const earlyPass =
    typeof message?.type === "string" && message.type.startsWith("search:");
  if (earlyPass) {
    return undefined;
  }

  log.debug("收到页面消息:", message.type);
  
  // 验证消息来源
  if (!isValidSender(sender)) {
    log.warn("拒绝来自非法来源的消息:", sender.url);
    sendResponse({ success: false, error: 'Invalid sender' });
    return false;
  }
  
  // 验证消息类型
  const validMessageTypes = ['CREATE_ALARM', 'GET_ALARMS', 'PAUSE_ALARM', 'RESUME_ALARM', 'DELETE_ALARM', 'CLEAR_ALL_ALARMS', 'ONEDRIVE_API_REQUEST'];
  if (!message.type || !validMessageTypes.includes(message.type)) {
    log.warn("未知或无效的消息类型:", message.type);
    sendResponse({ success: false, error: 'Invalid message type' });
    return false;
  }
  
  switch (message.type) {
    case 'CREATE_ALARM':
      handleCreateAlarm(message.data, sendResponse);
      return true; // 异步响应
      
    case 'GET_ALARMS':
      handleGetAlarms(sendResponse);
      return true; // 异步响应
      
    case 'PAUSE_ALARM':
      handlePauseAlarm(message.alarmName, sendResponse);
      return true; // 异步响应
      
    case 'RESUME_ALARM':
      handleResumeAlarm(message.alarmName, sendResponse);
      return true; // 异步响应
      
    case 'DELETE_ALARM':
      handleDeleteAlarm(message.alarmName, sendResponse);
      return true; // 异步响应
      
    case 'CLEAR_ALL_ALARMS':
      handleClearAllAlarms(sendResponse);
      return true; // 异步响应

    case 'ONEDRIVE_API_REQUEST':
      handleOneDriveApiRequest(message.request, sendResponse);
      return true; // 异步响应

    default:
      log.debug("未处理的消息类型:", message.type);
      return false;
  }
});

// 创建定时任务
async function handleCreateAlarm(data, sendResponse) {
  try {
    const { name, delayInMinutes, periodInMinutes, config } = data;
    
    // 保存任务配置到 storage
    if (config) {
      const configs = await getTaskConfigs();
      configs[name] = config;
      await saveTaskConfigs(configs);
    }
    
    // 创建 alarm
    const alarmInfo = {
      delayInMinutes: delayInMinutes || 1
    };
    
    if (periodInMinutes) {
      alarmInfo.periodInMinutes = periodInMinutes;
    }
    
    await chrome.alarms.create(name, alarmInfo);
    
    log.info("Alarm 已创建:", name, alarmInfo);
    
    sendResponse({ success: true, alarmName: name });
  } catch (error) {
    log.error("创建 Alarm 失败:", error);
    sendResponse({ success: false, error: error.message });
  }
}

// 获取所有定时任务（包括暂停的任务）
async function handleGetAlarms(sendResponse) {
  try {
    const alarms = await chrome.alarms.getAll();
    
    // 获取存储的任务配置
    const configs = await getTaskConfigs();
    
    // 获取暂停的任务列表
    const pausedTasks = await getPausedTasks();
    
    // 为每个 alarm 添加配置信息和暂停状态
    const alarmsWithConfig = alarms.map(alarm => ({
      ...alarm,
      config: configs[alarm.name] || null,
      isPaused: false
    }));
    
    // 添加暂停的任务（不在 active alarms 列表中的）
    const pausedAlarmList = [];
    for (const [name, pausedConfig] of Object.entries(pausedTasks)) {
      // 检查是否已经在 active alarms 中
      const exists = alarms.find(a => a.name === name);
      if (!exists) {
        pausedAlarmList.push({
          name: name,
          scheduledTime: pausedConfig.scheduledTime || 0,
          periodInMinutes: pausedConfig.periodInMinutes || null,
          config: pausedConfig.config || null,
          isPaused: true
        });
      }
    }
    
    const allAlarms = [...alarmsWithConfig, ...pausedAlarmList];
    
    log.debug("全部 Alarm（含暂停）:", allAlarms);
    
    sendResponse({ success: true, alarms: allAlarms });
  } catch (error) {
    log.error("获取 Alarm 列表失败:", error);
    sendResponse({ success: false, error: error.message });
  }
}

// 暂停定时任务
async function handlePauseAlarm(alarmName, sendResponse) {
  try {
    // 获取当前 alarm 信息
    const alarm = await chrome.alarms.get(alarmName);
    if (!alarm) {
      sendResponse({ success: false, error: 'Alarm not found' });
      return;
    }
    
    // 获取任务配置
    const configs = await getTaskConfigs();
    const config = configs[alarmName];
    
    // 保存到暂停列表
    const pausedTasks = await getPausedTasks();
    pausedTasks[alarmName] = {
      scheduledTime: alarm.scheduledTime,
      periodInMinutes: alarm.periodInMinutes,
      config: config,
      pausedAt: Date.now()
    };
    await savePausedTasks(pausedTasks);
    
    // 清除 alarm
    await chrome.alarms.clear(alarmName);
    
    log.info("Alarm 已暂停:", alarmName);
    
    sendResponse({ success: true, alarmName: alarmName });
  } catch (error) {
    log.error("暂停 Alarm 失败:", error);
    sendResponse({ success: false, error: error.message });
  }
}

// 恢复定时任务
async function handleResumeAlarm(alarmName, sendResponse) {
  try {
    // 获取暂停的任务信息
    const pausedTasks = await getPausedTasks();
    const pausedConfig = pausedTasks[alarmName];
    
    if (!pausedConfig) {
      sendResponse({ success: false, error: 'Paused task not found' });
      return;
    }
    
    // 重新创建 alarm
    // 计算新的延迟时间：如果之前保存了 scheduledTime，可以计算剩余时间
    let delayInMinutes = 1; // 默认延迟1分钟
    if (pausedConfig.scheduledTime && pausedConfig.scheduledTime > Date.now()) {
      delayInMinutes = Math.max(1, Math.ceil((pausedConfig.scheduledTime - Date.now()) / 60000));
    }
    
    const alarmInfo = {
      delayInMinutes: delayInMinutes
    };
    
    if (pausedConfig.periodInMinutes) {
      alarmInfo.periodInMinutes = pausedConfig.periodInMinutes;
    }
    
    await chrome.alarms.create(alarmName, alarmInfo);
    
    // 从暂停列表中移除
    delete pausedTasks[alarmName];
    await savePausedTasks(pausedTasks);
    
    log.info(`Alarm 已恢复: ${alarmName}，延迟 ${delayInMinutes} 分钟`);
    
    sendResponse({ success: true, alarmName: alarmName, newDelay: delayInMinutes });
  } catch (error) {
    log.error("恢复 Alarm 失败:", error);
    sendResponse({ success: false, error: error.message });
  }
}

// 删除指定的定时任务
async function handleDeleteAlarm(alarmName, sendResponse) {
  try {
    await chrome.alarms.clear(alarmName);
    
    // 从存储中删除任务配置
    const configs = await getTaskConfigs();
    delete configs[alarmName];
    await saveTaskConfigs(configs);
    
    // 从暂停列表中删除
    const pausedTasks = await getPausedTasks();
    delete pausedTasks[alarmName];
    await savePausedTasks(pausedTasks);
    
    log.info("Alarm 已删除:", alarmName);
    
    sendResponse({ success: true, alarmName: alarmName });
  } catch (error) {
    log.error("删除 Alarm 失败:", error);
    sendResponse({ success: false, error: error.message });
  }
}

// 清除所有定时任务
async function handleClearAllAlarms(sendResponse) {
  try {
    await chrome.alarms.clearAll();
    
    // 清空存储的任务配置
    await chrome.storage.local.remove(TASK_CONFIGS_KEY);
    await chrome.storage.local.remove(PAUSED_TASKS_KEY);
    
    log.info("已清除全部 Alarm");
    
    sendResponse({ success: true });
  } catch (error) {
    log.error("清除 Alarm 失败:", error);
    sendResponse({ success: false, error: error.message });
  }
}

// ===== 侧边栏（Chrome 114+ Side Panel API）=====
// 目标：点扩展工具栏图标即「开 / 关」浏览器右侧栏，用户可固定也可隐藏。
// 侧边栏内容就是 index.html 本体（同一套应用），由 app.js 侦测面板宿主后
// 叠加 body.host-panel 与面板专属排版（见 main.css 末尾的侧边栏排版层）。
// 侧边栏默认在 Chrome 设置里可选左 / 右，扩展不干预。
//
// 注意：一旦 setPanelBehavior({ openPanelOnActionClick: true }) 生效，
// chrome.action.onClicked 就**不会**再触发（Chrome 的既定行为）。
// 因此下面的 onClicked 监听天然只是「不支持 Side Panel 的浏览器」的回退路径。
async function initSidePanel() {
  if (!chrome.sidePanel || typeof chrome.sidePanel.setPanelBehavior !== "function") {
    log.warn("当前浏览器不支持 Side Panel API，回退为「点图标打开新标签页」");
    return false;
  }
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
    log.info("侧边栏已启用：点击工具栏图标开关侧边栏");
    return true;
  } catch (e) {
    log.error("启用侧边栏失败，将回退为「点图标打开新标签页」:", e);
    return false;
  }
}

// Service Worker 每次唤醒都重申一次（幂等），避免用户改过设置后被重置
initSidePanel();

// ===== 回退路径：不支持 Side Panel 的浏览器 =====
// 上面 setPanelBehavior 成功时这个监听不会触发，所以不会出现双重行为。
chrome.action.onClicked.addListener((tab) => {
  log.info("未启用侧边栏（或浏览器不支持），改为在新标签页打开登录页");
  chrome.tabs.create({
    url: chrome.runtime.getURL('login.html')
  });
});

// ===== 快捷键：开 / 关侧边栏 =====
// 为什么需要它：侧边栏一旦被「鼠标移出自动关闭」收起，用户就需要一个不依赖鼠标的召回方式。
// 快捷键是 chrome.sidePanel.open() 允许的四种用户动作之一（另外三种是点图标、右键菜单、
// 扩展页/内容脚本里的手势），而**鼠标移动不算**。
//
// 开/关状态只能靠 onOpened / onClosed 事件维护（API 没有 isOpen()）。
// 这两个事件是 Chrome 141/142+ 才有的，所以低版本上退化成「盲开」：
// 首次按下只会打开（若本来就开着，等价于无操作），第二次按键才由我们自己记的状态关掉。
const PANEL_OPEN_KEY = "side_panel_open_windows";
const sidePanelApi = chrome.sidePanel || null;

async function readOpenWindows() {
  try {
    const stored = await chrome.storage.session.get(PANEL_OPEN_KEY);
    return new Set(stored[PANEL_OPEN_KEY] || []);
  } catch (e) {
    return new Set(); // storage.session 不可用时按「都没开」处理
  }
}

async function writeOpenWindows(set) {
  try {
    await chrome.storage.session.set({ [PANEL_OPEN_KEY]: [...set] });
  } catch (e) {
    log.debug("记录侧边栏开关状态失败（不影响功能）:", e);
  }
}

try {
  sidePanelApi?.onOpened?.addListener(async (info) => {
    if (info && info.windowId !== undefined) {
      const set = await readOpenWindows();
      set.add(info.windowId);
      await writeOpenWindows(set);
    }
  });
  sidePanelApi?.onClosed?.addListener(async (info) => {
    if (info && info.windowId !== undefined) {
      const set = await readOpenWindows();
      set.delete(info.windowId);
      await writeOpenWindows(set);
    }
  });
  if (!sidePanelApi?.onOpened || !sidePanelApi?.onClosed) {
    log.debug("onOpened/onClosed 不可用（需 Chrome 141/142+），快捷键退化为「先开后关」");
  }
} catch (e) {
  log.debug("绑定侧边栏开关事件失败:", e);
}

// ===== 快捷键：唤起全局搜索（Alt+Shift+S，Spotlight 式） =====
// 首选路径是**把浮层注入到当前网页**（用户明确要求的"浮在当前网页上"），
// 只有注入不了时才回退到"让插件自己的页面弹面板 / 打开侧边栏"。
//
// ⚠️ 用到 `chrome.scripting.executeScript`，而它需要 `scripting` 权限 +
// **对当前标签页的访问权**。后者来自 `activeTab`：Chrome 规定
// 「用户按下 commands 快捷键」也是一种授予 activeTab 的用户手势，
// 所以这条路径**不需要** `<all_urls>` 主机权限（也就不会在安装时多出
// 「读取和更改您在所有网站上的数据」那条提示）。
// 权限没给上 / 页面受限（chrome:// 、扩展页、文件页）时会抛错 → 走回退路径。

/** 注入用的文件名。与 tools/build-plan.mjs 的 COPY_RULES 逐字一致（check-ui 的 J 组会核对它在 dist 里存在） */
const SEARCH_OVERLAY_FILE = "search_overlay.js";

/** 索引缓存：SW 随时可能被回收，丢了重建即可；TTL 只是避免每次按键都读一遍 storage + JSON */
let searchIndexCache = { at: 0, entries: null };
const SEARCH_INDEX_TTL_MS = 30000;

async function loadSearchEntries() {
  if (searchIndexCache.entries && Date.now() - searchIndexCache.at < SEARCH_INDEX_TTL_MS) {
    return searchIndexCache.entries;
  }
  let stored = {};
  try {
    stored = await chrome.storage.local.get(["ui_layout", "ui_favorites", "is_connected"]);
  } catch (e) {
    log.debug("读取搜索索引所需的 storage 失败:", e);
  }
  let shipped = null;
  try {
    const res = await fetch(chrome.runtime.getURL("rules/ui_layout.json"));
    if (res.ok) shipped = await res.text();
  } catch (e) {
    log.debug("读取出厂布局失败（只用内置页面条目）:", e);
  }

  const candidates = [stored.ui_layout, shipped];
  const favoriteIds = Array.isArray(stored.ui_favorites)
    ? stored.ui_favorites
    : defaultFavoriteIds(candidates);
  const entries = buildSearchEntries({
    candidates,
    favoriteIds,
    isConnected: stored.is_connected === true
  });
  searchIndexCache = { at: Date.now(), entries };
  return entries;
}

/** 渲染一次结果（浮层要的就是"现成的 HTML + 行数 + 计数文案"） */
async function renderSearchForOverlay(query) {
  const entries = await loadSearchEntries();
  const view = renderList({ query, entries, activeIndex: 0 });
  return {
    listHtml: view.html,
    rows: view.count,
    countText:
      view.scope === "favorites"
        ? `常用 ${view.count} / 全部 ${view.total}`
        : `${view.count} / ${view.total}`,
    firstLabel: view.firstLabel,
    scope: view.scope
  };
}

/**
 * 把「请进入某个功能」落到某个宿主上（`step` 为空表示"只把插件打开"）。
 *
 * 顺序与 open-search 同源：**先问已打开的插件页面**（那里有完整的"未连接就先自动连接"
 * 逻辑，见 app.js 的 gotoSection），没人接单才打开侧边栏并留一枚待办。
 */
async function routeGoto(step, extra = null) {
  const target = Number(step) || 0;
  // `extra` 是要带给目标功能的参数（目前只有 `orderValue`：搜索里输入的 Order 值）。
  // 两条落地路径都得带上它 —— 消息直达那条、以及"没人接单 → 写待办 → 新页面读"那条。
  const orderValue = extra && extra.orderValue ? String(extra.orderValue) : undefined;

  try {
    const res = await chrome.runtime.sendMessage({
      type: UI_MESSAGE.GOTO_SECTION,
      step: target || undefined,
      orderValue
    });
    if (res && res.ok) {
      log.info(`网页浮层跳转${target ? ` section-${target}` : ""}，交给已打开的插件页面处理`);
      return true;
    }
  } catch (e) {
    log.debug("没有插件页面响应跳转请求:", e && e.message ? e.message : e);
  }

  // ⚠️ 待办必须在 open() **之前**写：面板页面一开始加载就跑 initApp，
  // 那时的读取早于 open() 之后的任何 await —— 顺序反了就是一个纯竞态。
  if (target) {
    try {
      await chrome.storage.session.set({
        [UI_STORAGE.PENDING_SECTION]: { step: target, orderValue, at: Date.now() }
      });
    } catch (e) {
      log.warn("写入待办功能失败（面板会打开但不自动跳转）:", e);
    }
  }

  if (sidePanelApi && typeof sidePanelApi.open === "function") {
    try {
      const win = await chrome.windows.getLastFocused();
      if (win && win.id !== undefined) {
        await sidePanelApi.open({ windowId: win.id });
        const openSet = await readOpenWindows();
        openSet.add(win.id);
        await writeOpenWindows(openSet);
        log.info(`网页浮层跳转${target ? ` section-${target}` : ""}，已打开侧边栏`);
        return true;
      }
    } catch (e) {
      // 侧边栏打不开（不支持 / 非用户手势）→ 下面退化成开一个标签页，
      // 同一枚待办会被那个页面兑现，所以不必回滚
      log.warn("打开侧边栏失败，改用标签页承载跳转:", e);
    }
  }

  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL("index.html") });
    log.info(`网页浮层跳转${target ? ` section-${target}` : ""}，已用标签页打开`);
    return true;
  } catch (e) {
    log.error("跳转失败：侧边栏与标签页都打不开:", e);
    return false;
  }
}

/** 把浮层注入当前标签页；返回是否注入成功 */
async function injectSearchOverlay() {
  if (!chrome.scripting || typeof chrome.scripting.executeScript !== "function") {
    log.debug("chrome.scripting 不可用，跳过浮层注入");
    return false;
  }
  let tab = null;
  try {
    const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    tab = tabs && tabs[0];
  } catch (e) {
    log.debug("查询当前标签页失败:", e);
    return false;
  }
  if (!tab || tab.id === undefined || !tab.url) return false;
  // 只有普通网页能注入：chrome:// / about: / 文件页 / 扩展页 一律不行
  if (!/^https?:/i.test(tab.url)) return false;
  // 插件自己的页面不需要浮层（页面内已有 Ctrl/Cmd+K 与首页入口）→ 交给回退路径
  if (tab.url.startsWith(chrome.runtime.getURL(""))) return false;

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: [SEARCH_OVERLAY_FILE]
    });
    log.info("快捷键：已把搜索浮层注入当前网页");
    return true;
  } catch (e) {
    log.warn("注入搜索浮层失败，回退到插件自身路径:", e);
    return false;
  }
}

/** 叫已打开的扩展页面自己弹搜索框；返回是否有页面接单 */
async function askOpenPagesForSearch() {
  try {
    const res = await chrome.runtime.sendMessage({ type: UI_MESSAGE.OPEN_SEARCH });
    return !!(res && res.ok);
  } catch (e) {
    log.debug("没有扩展页面响应全局搜索请求:", e && e.message ? e.message : e);
    return false;
  }
}

async function openSearchFromCommand() {
  // ① 首选：把浮层注入到当前网页（用户选的就是"浮在当前网页上"）
  if (await injectSearchOverlay()) return;

  // ② 当前页面注入不了（受限页 / 插件自己的页面）→ 让已打开的插件页面弹面板
  if (await askOpenPagesForSearch()) {
    log.info("快捷键：已唤起全局搜索（当前插件页面）");
    return;
  }

  if (!sidePanelApi || typeof sidePanelApi.open !== "function") {
    log.warn("快捷键：当前浏览器不支持侧边栏，也无法唤起全局搜索");
    return;
  }

  // ③ 谁都没接单 → 打开侧边栏，并留一枚带时间戳的 token 让新页面自己展开面板。
  //    ⚠️ token 必须在 open() **之前**写：面板页面一开始加载就会跑 initApp，
  //    而那时的读取早于 open() 之后的任何 await —— 顺序反了就是一个纯竞态，
  //    表现是"快捷键时灵时不灵"。
  try {
    await chrome.storage.session.set({ [UI_STORAGE.OPEN_SEARCH_TOKEN]: Date.now() });
  } catch (e) {
    log.warn("快捷键：写入搜索请求标记失败（侧边栏会打开但不自动弹出搜索框）:", e);
  }

  try {
    const win = await chrome.windows.getLastFocused();
    if (!win || win.id === undefined) {
      await clearSearchToken();
      return;
    }
    // 快捷键处理器里调用 open() 属于合法的用户手势上下文
    await sidePanelApi.open({ windowId: win.id });
    const openSet = await readOpenWindows();
    openSet.add(win.id);
    await writeOpenWindows(openSet);
    log.info("快捷键：已打开侧边栏并唤起全局搜索");
  } catch (e) {
    // 面板没开成 → 必须把 token 撤掉，否则它会在保鲜期内被下一个碰巧加载的页面消费
    log.error("快捷键：打开侧边栏失败，已放弃本次全局搜索:", e);
    await clearSearchToken();
  }
}

async function clearSearchToken() {
  try {
    await chrome.storage.session.remove([UI_STORAGE.OPEN_SEARCH_TOKEN]);
  } catch (e) {
    /* 撤不掉也只能算了：token 自带保鲜期，最多让下一个页面多弹一次 */
  }
}

try {
  chrome.commands?.onCommand?.addListener(async (command) => {
    if (command === "open-search") {
      await openSearchFromCommand();
      return;
    }
    if (command !== "toggle-side-panel") return;
    try {
      const win = await chrome.windows.getLastFocused();
      if (!win || win.id === undefined) return;

      const openSet = await readOpenWindows();
      if (openSet.has(win.id)) {
        await sidePanelApi.close({ windowId: win.id });
        openSet.delete(win.id);
        await writeOpenWindows(openSet);
        log.info("快捷键：已隐藏侧边栏");
      } else {
        // 在快捷键处理器里调用 open() 是合法的用户手势上下文
        await sidePanelApi.open({ windowId: win.id });
        openSet.add(win.id);
        await writeOpenWindows(openSet);
        log.info("快捷键：已打开侧边栏");
      }
    } catch (e) {
      log.error("快捷键切换侧边栏失败:", e);
    }
  });
} catch (e) {
  log.debug("注册快捷键监听失败（commands 不可用）:", e);
}

// 偏好层在 SW 里也要初始化：跨宿主同步（`watchPrefsStorage`）。
// 不 await —— 搜索浮层那边是各自去读 prefs 的缓存，没有必须先完成的事。
loadPrefs();
watchPrefsStorage();

// ===== 网页内搜索浮层（src/search_overlay.js）的后端 =====
// 浮层是"复制型的经典脚本"：不能 import、也没有 storage/CDOM 之外的 API。
// 所以条目构建、模糊匹配、结果 HTML 全在这里做完发过去（与插件面板共用同一批模块）。
// 请求分四种：open / query / select / log。
const overlayLog = createLogger("SEARCH");
/** `search:log` 的级别白名单 —— 浮层给什么都不能让 logger 崩掉 */
const OVERLAY_LEVELS = { debug: "debug", info: "info", warn: "warn", error: "error" };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return undefined;
  const tabId = sender && sender.tab ? sender.tab.id : "-";

  if (msg.type === UI_MESSAGE.SEARCH_OPEN) {
    Promise.resolve()
      .then(async () => ({
        ok: true,
        // 样式随首次打开一起下发：浮层跑在 shadow DOM 里，拿不到宿主页面上的任何令牌，
        // 而它自己又不能 import —— 只能把 lib/css/cmdk.css 的文本递过去。
        css: await (await fetch(chrome.runtime.getURL("lib/css/cmdk.css"))).text(),
        html: shellHtml(),
        // ⚠️ 首帧必须**带上结果**：浮层拿到 open 的回执就立刻渲染，
        // 若这里只给骨架，用户会看到"面板开了但是空的"，一直要等他敲第一个字才有东西
        // （2026-10-15 的真机验证抓到过：`rows=0` 而后续查询正常）。
        ...(await renderSearchForOverlay(""))
      }))
      .catch((e) => {
        overlayLog.error(`[tab ${tabId}] 读取浮层资源失败:`, e);
        return { ok: false, error: String((e && e.message) || e) };
      })
      .then(sendResponse);
    return true; // 异步响应
  }

  if (msg.type === UI_MESSAGE.SEARCH_QUERY) {
    renderSearchForOverlay(typeof msg.q === "string" ? msg.q : "")
      .then((payload) => sendResponse(Object.assign({ ok: true, seq: msg.seq }, payload)))
      .catch((e) => {
        overlayLog.error(`[tab ${tabId}] 渲染搜索结果失败:`, e);
        sendResponse({ ok: false, seq: msg.seq, listHtml: "", rows: 0, countText: "" });
      });
    return true; // 异步响应
  }

  if (msg.type === UI_MESSAGE.SEARCH_SELECT) {
    // 浮层已经先把自己关掉了，这里不需要等结果，但仍然回执，便于排查
    sendResponse({ ok: true });
    Promise.resolve()
      .then(async () => {
        const entries = await loadSearchEntries();
        const view = renderList({
          query: typeof msg.q === "string" ? msg.q : "",
          entries,
          activeIndex: 0
        });
        const hit = view.rows[Number(msg.index)];
        if (!hit) {
          overlayLog.warn(`[tab ${tabId}] 选中的下标 ${msg.index} 没有对应条目`);
          return;
        }
        if (hit.item.action === "home") {
          // 「返回首页」在网页浮层里没有意义（那里没有插件首页）→ 只把插件打开（落在首页）
          await routeGoto(0);
          return;
        }
        if (hit.item.step) {
          // `orderValue`：搜索里输入的是 Order 的 Name/Id/OrderNumber 时，
          // 合成条目（见 cmdk_view.orderLookupRow）要连值一起带到 section-30。
          overlayLog.info(
            `[tab ${tabId}] 选中「${hit.item.label}」→ section-${hit.item.step}` +
              (hit.item.orderValue ? `（带值 ${hit.item.orderValue}）` : "")
          );
          await routeGoto(hit.item.step, { orderValue: hit.item.orderValue });
        }
      })
      .catch((e) => overlayLog.error(`[tab ${tabId}] 处理选中项失败:`, e));
    return undefined;
  }

  if (msg.type === UI_MESSAGE.SEARCH_LOG) {
    const level = OVERLAY_LEVELS[msg.level] || "debug";
    overlayLog[level](`[tab ${tabId}] ${msg.message}`);
    return undefined;
  }

  return undefined;
});
