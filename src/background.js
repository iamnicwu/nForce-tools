
// Service Worker for nForce Tools
// 使用 Chrome Alarm API 管理定时任务
import { createLogger } from "./common/logger.js";

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