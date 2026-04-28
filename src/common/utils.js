/**
 * 显示通知
 * @param {string} message - 通知内容
 * @param {string} type - 通知类型 (success, error, info)
 */
import { Icons } from "./icons.js";

/**
 * 显示通知 - 适配 Ant Design 风格
 * @param {string} message - 通知内容
 * @param {string} type - 通知类型 (success, error, info, warning)
 */
// 存储活动通知以管理合并
const activeNotifications = new Map();
const MAX_NOTIFICATIONS = 3;

export function showNotification(message, type = "success") {
  const container = document.getElementById("notification-container");
  if (!container) {
    console.error("Notification container not found");
    return;
  }

  // 创建唯一键
  const key = `${type}:${message}`;

  if (activeNotifications.has(key)) {
    // 更新现有通知
    const existing = activeNotifications.get(key);
    existing.count++;
    
    // 更新消息文本
    const messageEl = existing.element.querySelector('.ant-alert-description');
    if (messageEl) {
        messageEl.textContent = `${message} (${existing.count})`;
    }
    
    // 重置定时器
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => {
        closeNotification(key);
    }, 3000);
    
    // 添加视觉效果
    existing.element.classList.remove('pulse');
    void existing.element.offsetWidth; // 触发重绘
    existing.element.classList.add('pulse');
    
    return;
  }

  // 限制通知数量
  if (activeNotifications.size >= MAX_NOTIFICATIONS) {
      // 移除最早的通知
      const oldestKey = activeNotifications.keys().next().value;
      closeNotification(oldestKey);
  }
  
  const notification = document.createElement("div");
  notification.className = `ant-alert ant-alert-${type} ant-alert-with-description`;
  // 样式已在CSS中定义
  
  let icon = Icons.checkCircle;
  if (type === "error") {
    icon = Icons.timesCircle;
  } else if (type === "info") {
    icon = Icons.infoCircle;
  } else if (type === "warning") {
    icon = Icons.exclamationCircle;
  }

  // Ant Design Alert 结构
  notification.innerHTML = `
        <span role="img" aria-label="${type}" class="anticon anticon-${type} ant-alert-icon">
            ${icon}
        </span>
        <div class="ant-alert-content">
            <div class="ant-alert-message">${type.charAt(0).toUpperCase() + type.slice(1)}</div>
            <div class="ant-alert-description">${message}</div>
        </div>
        <button type="button" class="ant-alert-close-icon" tabindex="0">
            <span role="img" aria-label="close" class="anticon anticon-close">
                ${Icons.times}
            </span>
        </button>
    `;
    
  // 绑定关闭按钮事件
  const closeBtn = notification.querySelector('.ant-alert-close-icon');
  if (closeBtn) {
      closeBtn.onclick = () => closeNotification(key);
  }

  container.appendChild(notification);

  // 自动关闭定时器
  const timer = setTimeout(() => {
    closeNotification(key);
  }, 3000);
  
  // 存储到Map中
  activeNotifications.set(key, {
      element: notification,
      count: 1,
      timer: timer
  });
}

function closeNotification(key) {
    if (!activeNotifications.has(key)) return;
    
    const { element, timer } = activeNotifications.get(key);
    clearTimeout(timer);
    
    // 添加淡出动画
    element.style.opacity = '0';
    element.style.transition = 'opacity 0.3s';
    
    setTimeout(() => {
        if (element.parentNode) {
            element.remove();
        }
        activeNotifications.delete(key);
    }, 300);
}

/**
 * 在loading-log区域显示日志消息
 * @param {string} message - 日志消息
 * @param {string} type - 日志类型 (info, success, error, warning)
 */
export function loadingLog(message, type = 'info') {
    const logContent = document.getElementById('loading-log-content');
    const loadingLog = document.getElementById('loading-log');
    
    if (!loadingLog) return;
    
    // 确保日志区域显示
    loadingLog.style.display = 'block';
    
    if (!logContent) return;
    
    const entry = document.createElement('div');
    entry.className = `log-entry ${type}`;
    
    // 添加时间戳
    const now = new Date();
    const timeStr = now.toLocaleTimeString('zh-CN', { hour12: false });
    
    entry.textContent = `[${timeStr}] ${message}`;
    logContent.appendChild(entry);
    
    // 自动滚动到最新消息
    logContent.scrollTop = logContent.scrollHeight;
    
    // 同时输出到console
    if (type === 'error') {
        console.error(`[Loading] ${message}`);
    } else if (type === 'warning') {
        console.warn(`[Loading] ${message}`);
    } else {
        console.log(`[Loading] ${message}`);
    }
}

/**
 * 简单的 Markdown 解析器
 * @param {string} markdown 
 * @returns {string} HTML
 */
export function parseMarkdown(markdown) {
  const lines = markdown.split('\n');
  let html = '';
  let inList = false;
  let listType = null; // 'ul' or 'ol'
  let inCodeBlock = false;
  let inTable = false;
  let isHeader = false;

  for (let line of lines) {
    // 代码块处理
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        html += '</code></pre>\n';
        inCodeBlock = false;
      } else {
        const lang = line.trim().substring(3).trim();
        html += `<pre><code class="language-${lang}">`;
        inCodeBlock = true;
      }
      continue;
    }
    if (inCodeBlock) {
      // 转义 HTML 特殊字符，防止代码内容被解析为 HTML 标签
      html += line.replace(/&/g, "&").replace(/</g, "<").replace(/>/g, ">") + '\n';
      continue;
    }

    // 标题处理
    if (line.startsWith('# ')) {
      html += `<h1>${parseInline(line.substring(2))}</h1>`;
      continue;
    }
    if (line.startsWith('## ')) {
      html += `<h2>${parseInline(line.substring(3))}</h2>`;
      continue;
    }
    if (line.startsWith('### ')) {
      html += `<h3>${parseInline(line.substring(4))}</h3>`;
      continue;
    }
    if (line.startsWith('#### ')) {
      html += `<h4>${parseInline(line.substring(5))}</h4>`;
      continue;
    }

    // 表格处理
    if (line.trim().startsWith('|')) {
        if (!inTable) {
            html += '<table>';
            inTable = true;
            // 检查是否是表头分隔行
            const nextLine = lines[lines.indexOf(line) + 1];
            if (nextLine && nextLine.trim().startsWith('|') && nextLine.includes('---')) {
                isHeader = true;
            }
        }
        
        // 如果是分隔行，跳过
        if (line.trim().replace(/\|/g, '').replace(/-/g, '').replace(/:/g, '').trim() === '') {
            isHeader = false; // 分隔行之后是内容
            continue;
        }

        const cells = line.split('|').filter((cell, index, arr) => {
            // 过滤掉首尾的空字符串（如果行首尾有 |）
            if (index === 0 && cell.trim() === '') return false;
            if (index === arr.length - 1 && cell.trim() === '') return false;
            return true;
        });

        html += '<tr>';
        cells.forEach(cell => {
            const tag = isHeader ? 'th' : 'td';
            html += `<${tag}>${parseInline(cell.trim())}</${tag}>`;
        });
        html += '</tr>';
        continue;
    }

    if (inTable) {
        html += '</table>';
        inTable = false;
        isHeader = false;
    }

    // 列表处理
    const isUl = line.trim().startsWith('- ');
    const isOl = /^\d+\.\s/.test(line.trim());

    if (isUl || isOl) {
      const currentListType = isUl ? 'ul' : 'ol';
      if (!inList || listType !== currentListType) {
        if (inList) html += `</${listType}>`;
        html += `<${currentListType}>`;
        inList = true;
        listType = currentListType;
      }
      const content = isUl ? line.trim().substring(2) : line.trim().replace(/^\d+\.\s/, '');
      html += `<li>${parseInline(content)}</li>`;
      continue;
    }

    if (inList) {
      html += `</${listType}>`;
      inList = false;
      listType = null;
    }

    // 空行处理
    if (line.trim() === '') {
      continue;
    }

    // 普通段落
    html += `<p>${parseInline(line)}</p>`;
  }

  if (inList) {
    html += `</${listType}>`;
  }

  return html;
}

/**
 * 解析行内样式
 * @param {string} text 
 * @returns {string}
 */
export function parseInline(text) {
  if (!text) return '';
  // 粗体
  text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  // 代码
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  // 链接
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  return text;
}

/**
 * 递归展平对象
 * @param {Object} obj - 待展平的对象
 * @param {string} prefix - 当前键的前缀
 * @param {Object} res - 结果对象
 * @returns {Object} 展平后的对象
 */
function flatten(obj, prefix = '', res = {}) {
  for (const key in obj) {
    // 忽略原型链属性
    if (!Object.prototype.hasOwnProperty.call(obj, key)) continue;
    
    // 忽略 Salesforce 的 attributes 属性
    if (key === 'attributes') continue;

    const val = obj[key];
    const newKey = prefix ? `${prefix}.${key}` : key;

    if (typeof val === 'object' && val !== null && !Array.isArray(val)) {
      flatten(val, newKey, res);
    } else {
      res[newKey] = val;
    }
  }
  return res;
}

/**
 * 展平 Salesforce 记录，递归处理嵌套对象并移除 attributes。
 *
 * @param {Array<Object>} records - 原始记录数组
 * @returns {Array<Object>} 展平后的记录数组
 */
export function flattenRecords(records) {
  if (!records || records.length === 0) {
    return [];
  }

  return records.map(record => flatten(record));
}

/**
 * 根据 OrderNumber 对记录进行去重。
 *
 * 去重规则（优先级从高到低）：
 * 1. FulfillmentId__c 非空 (has_fid=true)
 *
 * 对于同一个 OrderNumber，保留排序后的第一条记录。
 *
 * @param {Array<Object>} records - 原始记录数组
 * @returns {Array<Object>} 去重后的记录数组
 */
export function remove_duplicates(records) {
  if (!records || records.length === 0) {
    return [];
  }

  try {
    // 确保 OrderNumber 存在，如果不存在则无法去重，直接返回原数据
    const hasOrderNumber = records.some(
      (record) =>
        record["Order.OrderNumber"] !== undefined &&
        record["Order.OrderNumber"] !== null
    );

    console.log("数据中包含 hasOrderNumber 列:", hasOrderNumber);

    if (!hasOrderNumber) {
      console.warn("数据中缺少 'Order.OrderNumber' 列，跳过去重。");
      return records;
    }

    // 分离有有效 OrderNumber 和无效 OrderNumber 的记录
    const validRecords = records.filter(
      (record) =>
        record["Order.OrderNumber"] !== undefined &&
        record["Order.OrderNumber"] !== null &&
        record["Order.OrderNumber"] !== ""
    );

    const invalidRecords = records.filter(
      (record) =>
        record["Order.OrderNumber"] === undefined ||
        record["Order.OrderNumber"] === null ||
        record["Order.OrderNumber"] === ""
    );
    console.log(`有效 OrderNumber 记录数：${validRecords.length}`);
    console.log(`无效 OrderNumber 记录数：${invalidRecords.length}`);

    if (validRecords.length === 0) {
      return records;
    }

    // 定义判断非空的辅助函数
    const isValid = (val) => {
      if (val === undefined || val === null) {
        return false;
      }
      return Boolean(String(val).trim());
    };

    // 为有效记录添加辅助字段 has_fid
    const validRecordsWithFlags = validRecords.map((record) => ({
      ...record,
      has_fid: isValid(record["FulfillmentId__c"]),
    }));

    // 排序：按 OrderNumber 分组，组内按 has_fid 降序排列
    // 这样对于每个 OrderNumber，has_fid=true 的记录会排在前面
    validRecordsWithFlags.sort((a, b) => {
      // 首先按 OrderNumber 排序
      if (a["Order.OrderNumber"] < b["Order.OrderNumber"]) {
        return -1;
      }
      if (a["Order.OrderNumber"] > b["Order.OrderNumber"]) {
        return 1;
      }

      // 在相同 OrderNumber 下，按 has_fid 降序排列 (true 优先于 false)
      if (a.has_fid && !b.has_fid) {
        return -1;
      }
      if (!a.has_fid && b.has_fid) {
        return 1;
      }
      return 0;
    });

    // 计算重复数量 (仅用于日志展示)
    const uniqueOrderNumbers = new Set(
      validRecordsWithFlags.map((record) => record["Order.OrderNumber"])
    );
    const duplicateCount =
      validRecordsWithFlags.length - uniqueOrderNumbers.size;

    // 去重，保留每个 OrderNumber 的第一条记录 (即优先级最高的一条)
    const seenOrderNumbers = new Set();
    const uniqueRecords = validRecordsWithFlags.filter((record) => {
      if (seenOrderNumbers.has(record["Order.OrderNumber"])) {
        return false;
      }
      seenOrderNumbers.add(record["Order.OrderNumber"]);
      return true;
    });

    // 清理辅助列
    const cleanedUniqueRecords = uniqueRecords.map(
      ({ has_fid, ...rest }) => rest
    );

    // 合并无效 OrderNumber 的记录 (这些记录不参与去重，直接保留)
    const finalResult = [...cleanedUniqueRecords, ...invalidRecords];

    console.log(
      `去重完成：原始记录 ${records.length} 条，去重后 ${finalResult.length} 条，移除了 ${duplicateCount} 条重复记录`
    );
    return finalResult;
  } catch (error) {
    console.error(`去重过程出错: ${error.message}`, error);
    return records;
  }
}