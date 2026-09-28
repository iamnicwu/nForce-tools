
// Service Worker for nForce Tools
// 使用 Chrome Alarm API 管理定时任务
import { createLogger } from "./common/logger.js";
// 贴边浮窗（内容脚本）的配置来源。内容脚本是经典脚本、不能 import，
// 所以它通过 runtime.sendMessage 向这里要配置 —— 偏好的键名只在 prefs.js 里写一份。
// ⚠️ 本文件是**逐字复制**进 dist 的 ESM service worker，它的 import 必须真的存在：
// webpack.config.js 里已为 common/prefs.js 与 common/api_version.js 各加了一条复制规则。
import { loadPrefs, watchPrefsStorage, onPrefsChanged, getPref, PREF_KEYS } from "./common/prefs.js";

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
  // ⚠️ 必须最先放行 `dock:*`（贴边浮窗那条链路，监听器在文件末尾）。
  // Chrome 对同一条消息会依次调用**所有**监听器，但只认**第一个** sendResponse：
  // 这里下面的白名单校验对 `dock:get-config` 是"未知类型"，会立刻回一个
  // `{success:false, error:'Invalid message type'}`，于是后面那个监听器的
  // 异步回话永远送不出去（内容脚本只拿到 ok=false）→ 浮窗静默地永不启用。
  // 静态检查与截图都抓不到这个：它只在真实的 Salesforce 页面上才暴露。
  if (typeof message?.type === "string" && message.type.startsWith("dock:")) {
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

try {
  chrome.commands?.onCommand?.addListener(async (command) => {
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

// ===== 贴边浮窗：配置下发 + 日志转发 =====
// 内容脚本（dist/dock.js）是经典脚本，既不能 import 偏好层、也不能用 logger，
// 所以这两件事都由这里代劳。
const dockLog = createLogger("DOCK");

/** 浮窗需要的最小配置。键名一律取自 PREF_KEYS，别在这里写字符串字面量。 */
function dockConfig() {
  return {
    enabled: !!getPref(PREF_KEYS.dockEnabled),
    side: getPref(PREF_KEYS.dockSide),
    hideDelay: Number(getPref(PREF_KEYS.dockHideDelay))
  };
}

const prefsReady = loadPrefs();
watchPrefsStorage();

// 上一次广播出去的配置。作用：偏好里任何一项变化都会触发 onPrefsChanged，
// 但我们只该在**浮窗相关**的项变化时才打扰所有标签页。
let lastDockConfigJson = null;

async function broadcastDockConfig(force = false) {
  const config = dockConfig();
  const json = JSON.stringify(config);
  if (!force && json === lastDockConfigJson) return;
  lastDockConfigJson = json;

  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return;
  }
  await Promise.all(
    tabs.map(async (tab) => {
      if (tab.id === undefined) return;
      try {
        await chrome.tabs.sendMessage(tab.id, { type: "dock:config", config });
      } catch (e) {
        // 该标签页没有注入内容脚本（非 Salesforce 域 / chrome:// 页面），属正常
      }
    })
  );
  log.debug(`已向 ${tabs.length} 个标签页广播浮窗配置：${json}`);
}

onPrefsChanged(() => {
  broadcastDockConfig();
});

/** `dock:log` 的级别白名单 —— 内容脚本给什么都不能让 logger 崩掉 */
const DOCK_LEVELS = { debug: "debug", info: "info", warn: "warn", error: "error" };

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== "string") return undefined;

  if (msg.type === "dock:get-config") {
    // 必须 return true 保持消息通道开着：loadPrefs() 是异步的
    prefsReady
      .catch(() => {})
      .then(() => sendResponse({ ok: true, config: dockConfig() }));
    return true;
  }

  if (msg.type === "dock:log") {
    const level = DOCK_LEVELS[msg.level] || "debug";
    const tabId = sender && sender.tab ? sender.tab.id : "-";
    dockLog[level](`[tab ${tabId}] ${msg.message}`);
    return undefined;
  }

  return undefined;
});
