/**
 * 定时任务（chrome.alarms 的增删查改）
 *
 * 「Schedule Jobs」页的全部动作。列表渲染由 ui.js 负责，所以这里用**动态** `import(./ui.js)` —— 与拆分前同样的手法，避免模块初始化期的循环依赖。
 *
 * ── 为什么单独一个文件（2026-10-15）──
 * 这些代码原先都在 `biz/logic.js` 里 —— 一个 2239 行、45 个导出的巨型模块，把取数、导入、
 * 导出、Bulk、定时任务、午餐抽签全塞在一起，改一处要在两千行里翻。按功能域拆成 10 个文件后，
 * 每个 60~400 行，文件名即功能域。**只做了搬运，没有改任何函数体**。
 */

import { createLogger } from "../common/logger.js";

const log = createLogger("SCHEDULE");
import { appState } from "./state.js";
import { showNotification, formatDateTime } from "../common/utils.js";

/**
 * 触发记录（与 `background.js` 的 `FIRED_LOG_KEY` **逐字一致** —— storage 键是跨上下文的协议）。
 *
 * 为什么页面这边也要知道它：本功能本质是**提醒**，而提醒的接收方是页面。
 * 侧边栏一收，`ALARM_TRIGGERED` 就没有接收者了 —— 以前的表现是"任务创建了但从不触发"。
 * 现在 SW 会先把每一次触发落盘，页面启动时用 `flushMissedAlarmReminders()` 补一条汇总。
 */
const FIRED_LOG_STORAGE_KEY = "schedule_fired_log";

/** 本页打开的时刻：比它更早的触发记录才算"错过"（之后的会走实时通知） */
const PAGE_STARTED_AT = Date.now();

export async function loadScheduleJobs() {
    const loadingEl = document.getElementById("schedule-jobs-loading");
    const emptyEl = document.getElementById("schedule-jobs-empty");
    const listEl = document.getElementById("schedule-jobs-list");
    const refreshBtn = document.getElementById("refresh-schedule-jobs-btn");

    try {
        // 显示 loading
        if (loadingEl) loadingEl.style.display = "block";
        if (emptyEl) emptyEl.style.display = "none";
        if (listEl) listEl.style.display = "none";
        if (refreshBtn) {
            refreshBtn.disabled = true;
            refreshBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 加载中...';
        }

        // 使用 Chrome Alarm API 获取任务列表
        const result = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'GET_ALARMS' }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message || "Communication error"));
                } else {
                    resolve(response);
                }
            });
        });

        if (result && result.success) {
            const alarms = result.alarms || [];
            log.debug("定时任务 (Alarms):", alarms);

            if (alarms.length === 0) {
                if (loadingEl) loadingEl.style.display = "none";
                if (emptyEl) emptyEl.style.display = "block";
            } else {
                if (loadingEl) loadingEl.style.display = "none";
                if (emptyEl) emptyEl.style.display = "none";
                if (listEl) listEl.style.display = "block";

                // 保存到 appState
                appState.schedule_jobs = alarms;

                // 直接导入并调用 ui.js 中的渲染函数
                import('./ui.js').then((uiModule) => {
                    if (uiModule.renderScheduleJobsData) {
                        uiModule.renderScheduleJobsData(alarms);
                    }
                });

                showNotification(`已加载 ${alarms.length} 个定时任务`, "success");
            }
        } else {
            throw new Error(result && result.error ? result.error : "获取定时任务失败");
        }
    } catch (error) {
        log.error("获取定时任务出错:", error);
        showNotification("获取定时任务出错: " + (error.message || error), "error");
        if (loadingEl) loadingEl.style.display = "none";
        if (emptyEl) emptyEl.style.display = "block";
        if (emptyEl) {
            emptyEl.innerHTML = '';
            const icon = document.createElement('i');
            icon.className = 'fas fa-exclamation-triangle';
            icon.style.cssText = 'font-size: var(--icon-2xl); margin-bottom: 1rem; color: var(--error-color);';
            const p = document.createElement('p');
            p.textContent = `加载失败: ${error.message || error}`;
            emptyEl.appendChild(icon);
            emptyEl.appendChild(p);
        }
    } finally {
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.innerHTML = '<i class="fas fa-sync"></i> 刷新列表';
        }
    }
}

export async function createScheduleJob() {
    const nameInput = document.getElementById("schedule-job-name");
    const delayInput = document.getElementById("schedule-job-delay");
    const periodInput = document.getElementById("schedule-job-period");
    const createBtn = document.getElementById("create-schedule-job-btn");

    // 获取输入值
    const name = nameInput ? nameInput.value.trim() : "";
    const delayInMinutes = parseFloat(delayInput ? delayInput.value : "1") || 1;
    const periodInMinutes = periodInput && periodInput.value.trim() ? parseFloat(periodInput.value) : null;

    // 验证输入
    if (!name) {
        showNotification("请输入任务名称", "warning");
        return;
    }

    // Chrome alarm name 只能包含字母、数字、下划线，长度限制在 64 字符以内
    const sanitizedName = name.replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 64);
    if (sanitizedName !== name) {
        showNotification(`任务名称已自动清理为: ${sanitizedName}`, "info");
    }

    if (delayInMinutes <= 0) {
        showNotification("延迟时间必须大于 0", "warning");
        return;
    }

    if (periodInMinutes !== null && periodInMinutes <= 0) {
        showNotification("周期时间必须大于 0", "warning");
        return;
    }

    try {
        if (createBtn) {
            createBtn.disabled = true;
            createBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 创建中...';
        }

        // 使用 Promise 包装 chrome.runtime.sendMessage
        const result = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                type: 'CREATE_ALARM',
                data: {
                    name: sanitizedName,
                    delayInMinutes: delayInMinutes,
                    periodInMinutes: periodInMinutes,
                    config: {
                        originalName: name,
                        createdAt: new Date().toISOString(),
                        delay: delayInMinutes,
                        period: periodInMinutes
                    }
                }
            }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message || "Communication error"));
                } else {
                    resolve(response);
                }
            });
        });

        log.debug("创建 Alarm 结果: ", result);

        if (result && result.success) {
            showNotification(`定时任务 "${sanitizedName}" 创建成功`, "success");
            
            // 清空输入框
            if (nameInput) nameInput.value = "";
            if (delayInput) delayInput.value = "1";
            if (periodInput) periodInput.value = "";
            
            // 刷新列表
            loadScheduleJobs();
        } else {
            throw new Error(result && result.error ? result.error : "创建定时任务失败");
        }
    } catch (error) {
        log.error("创建定时任务出错:", error);
        showNotification("创建定时任务出错: " + (error.message || error), "error");
    } finally {
        if (createBtn) {
            createBtn.disabled = false;
            createBtn.innerHTML = '<i class="fas fa-plus"></i> 创建任务';
        }
    }
}

export async function deleteScheduleJob(alarmName) {
    if (!alarmName) {
        showNotification("任务名称无效", "warning");
        return;
    }

    try {
        const result = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                type: 'DELETE_ALARM',
                alarmName: alarmName
            }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message || "Communication error"));
                } else {
                    resolve(response);
                }
            });
        });

        if (result && result.success) {
            showNotification(`定时任务 "${alarmName}" 已删除`, "success");
            loadScheduleJobs();
        } else {
            throw new Error(result && result.error ? result.error : "删除定时任务失败");
        }
    } catch (error) {
        log.error("删除定时任务出错:", error);
        showNotification("删除定时任务出错: " + (error.message || error), "error");
    }
}

export async function clearAllScheduleJobs() {
    try {
        const result = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                type: 'CLEAR_ALL_ALARMS'
            }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message || "Communication error"));
                } else {
                    resolve(response);
                }
            });
        });

        if (result && result.success) {
            showNotification("所有定时任务已清除", "success");
            loadScheduleJobs();
        } else {
            throw new Error(result && result.error ? result.error : "清除定时任务失败");
        }
    } catch (error) {
        log.error("清除定时任务出错:", error);
        showNotification("清除定时任务出错: " + (error.message || error), "error");
    }
}

export async function pauseScheduleJob(alarmName) {
    if (!alarmName) {
        showNotification("任务名称无效", "warning");
        return;
    }

    try {
        // 先获取任务列表，找到对应的任务来判断状态
        const alarmsResult = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({ type: 'GET_ALARMS' }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message || "Communication error"));
                } else {
                    resolve(response);
                }
            });
        });

        if (!alarmsResult || !alarmsResult.success) {
            throw new Error("获取任务列表失败");
        }

        const alarms = alarmsResult.alarms || [];
        const alarm = alarms.find(a => a.name === alarmName);

        if (!alarm) {
            showNotification(`定时任务 "${alarmName}" 不存在`, "warning");
            return;
        }

        // 根据 isPaused 状态决定是暂停还是恢复
        const isPaused = alarm.isPaused === true;
        const actionType = isPaused ? 'RESUME_ALARM' : 'PAUSE_ALARM';
        const actionText = isPaused ? '恢复' : '暂停';

        const result = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                type: actionType,
                alarmName: alarmName
            }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message || "Communication error"));
                } else {
                    resolve(response);
                }
            });
        });

        if (result && result.success) {
            showNotification(`定时任务 "${alarmName}" 已${actionText}`, "success");
            loadScheduleJobs();
        } else {
            throw new Error(result && result.error ? result.error : `${actionText}定时任务失败`);
        }
    } catch (error) {
        log.error("操作定时任务出错:", error);
        showNotification("操作定时任务出错: " + (error.message || error), "error");
    }
}

export async function resumeScheduleJob(alarmName) {
    if (!alarmName) {
        showNotification("任务名称无效", "warning");
        return;
    }

    try {
        const result = await new Promise((resolve, reject) => {
            chrome.runtime.sendMessage({
                type: 'RESUME_ALARM',
                alarmName: alarmName
            }, (response) => {
                if (chrome.runtime.lastError) {
                    reject(new Error(chrome.runtime.lastError.message || "Communication error"));
                } else {
                    resolve(response);
                }
            });
        });

        if (result && result.success) {
            showNotification(`定时任务 "${alarmName}" 已恢复`, "success");
            loadScheduleJobs();
        } else {
            throw new Error(result && result.error ? result.error : "恢复定时任务失败");
        }
    } catch (error) {
        log.error("恢复定时任务出错:", error);
        showNotification("恢复定时任务出错: " + (error.message || error), "error");
    }
}

/* ============================================================
 * 触发记录：把"页面不在时错过的那几次"补成可见的提醒
 * ============================================================ */

/** 读一次触发记录（任何异常都退化成空数组，绝不阻断启动流程） */
async function readFiredLog() {
    try {
        const stored = await chrome.storage.local.get(FIRED_LOG_STORAGE_KEY);
        const list = stored ? stored[FIRED_LOG_STORAGE_KEY] : null;
        return Array.isArray(list) ? list : [];
    } catch (e) {
        log.debug("读取定时任务触发记录失败:", e);
        return [];
    }
}

/**
 * 把"实时通知已经弹过"的那条记录摘掉。
 *
 * 不摘的后果：那一项会在下次打开页面时被当成"错过"，同一次触发提醒两遍。
 * 调用时机安全 —— SW 是**先把记录落盘、再广播**（见 `background.js` 的
 * `handleAlarmFired`），所以这里读到的记录一定包含刚触发的那条。
 */
async function consumeFiredEntry(alarmName) {
    try {
        const list = await readFiredLog();
        const index = list.findIndex((entry) => entry && entry.name === alarmName);
        if (index < 0) return;
        list.splice(index, 1);
        await chrome.storage.local.set({ [FIRED_LOG_STORAGE_KEY]: list });
    } catch (e) {
        log.debug("摘除已通知的触发记录失败（下次可能重复提醒一次）:", e);
    }
}

/**
 * 启动时补提醒：把"本页打开之前就已经触发过"的记录汇总成一条通知。
 *
 * 这是 P0 修复的**用户可见那一半** —— 以前页面没开就等于什么也没发生，
 * 现在至少会告诉用户"你错过了什么"。返回补上的条数（0 表示没有可补的）。
 *
 * @returns {Promise<number>}
 */
export async function flushMissedAlarmReminders() {
    if (typeof chrome === "undefined" || !chrome.storage || !chrome.storage.local) return 0;

    const list = await readFiredLog();
    if (!list.length) return 0;

    const missed = list.filter((entry) => entry && Number(entry.at) < PAGE_STARTED_AT);
    const rest = list.filter((entry) => !(entry && Number(entry.at) < PAGE_STARTED_AT));

    try {
        // 补报过的不留（否则每次打开都会重报）；本页打开后触发的也留在原处，等实时通知自己摘
        if (rest.length) {
            await chrome.storage.local.set({ [FIRED_LOG_STORAGE_KEY]: rest });
        } else {
            await chrome.storage.local.remove(FIRED_LOG_STORAGE_KEY);
        }
    } catch (e) {
        log.debug("清理触发记录失败（下次可能重复提醒）:", e);
    }

    if (!missed.length) return 0;

    if (missed.length === 1) {
        const one = missed[0];
        showNotification(
            `定时提醒「${one.label || one.name}」曾在 ${formatDateTime(one.at)} 触发 —— 当时插件页面没有打开`,
            "info"
        );
    } else {
        const newest = missed.slice(-3).map((entry) => `「${entry.label || entry.name}」`).join("、");
        showNotification(
            `错过了 ${missed.length} 个定时提醒：${newest}${missed.length > 3 ? "等" : ""}（当时插件页面没有打开）`,
            "info"
        );
    }
    log.info(`补报 ${missed.length} 条错过的定时提醒`);
    return missed.length;
}

// 监听来自 background 的 alarm 触发消息（页面开着时的实时提醒）
if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // 只处理 ALARM_TRIGGERED 消息，其他消息类型不干预，交给其他监听器处理
        if (message.type === 'ALARM_TRIGGERED') {
            const label = (message.config && message.config.originalName) || message.alarm.name;
            log.info('页面收到 Alarm 触发:', message.alarm.name);
            showNotification(`定时提醒「${label}」到点了`, "info");

            // 摘掉刚落盘的那条记录，避免下次打开页面时被当成"错过"再报一次
            consumeFiredEntry(message.alarm.name);

            // 触发一个自定义事件，让页面可以处理
            const event = new CustomEvent('scheduleJobTriggered', {
                detail: {
                    alarm: message.alarm,
                    config: message.config
                }
            });
            document.dispatchEvent(event);
        }
        // 不调用 sendResponse，不 return true，让消息继续传递给其他监听器
    });
}
