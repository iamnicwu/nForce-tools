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
import { showNotification } from "../common/utils.js";

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

// 监听来自 background 的 alarm 触发消息
if (typeof chrome !== 'undefined' && chrome.runtime) {
    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
        // 只处理 ALARM_TRIGGERED 消息，其他消息类型不干预，交给其他监听器处理
        if (message.type === 'ALARM_TRIGGERED') {
            log.info('页面收到 Alarm 触发:', message.alarm.name);
            showNotification(`定时任务 "${message.alarm.name}" 已触发!`, "info");
            
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
