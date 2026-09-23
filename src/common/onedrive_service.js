/**
 * OneDrive Workbook Service
 * 通过 Microsoft Graph API 连接 OneDrive 中的 Excel Workbook
 * 使用 graph_token 作为 access_token 进行身份验证
 *
 * 读取功能：
 * - 连接 OneDrive Workbook
 * - 创建/管理 Workbook Session（提高性能）
 * - 读取 Worksheets、Tables、Rows、Cells
 * - 支持通过文件 ID 或路径访问
 *
 * 编辑功能：
 * - Worksheet: 创建、删除、重命名、移动
 * - Range: 更新值、公式、数字格式、清除、插入、删除单元格
 * - Table: 创建、删除、添加行、更新行、删除行、重命名
 * - 批量写入 JSON 数据到 Table/Worksheet
 *
 * Microsoft Graph API 文档：
 * https://learn.microsoft.com/zh-cn/graph/api/resources/excel?view=graph-rest-1.0
 */

// 导入 graph_token.js 中的默认 token
import { createLogger, maskSecret } from "./logger.js";

const log = createLogger("OD");
import defaultGraphToken from './graph_token.js';

const GRAPH_API_BASE = 'https://graph.microsoft.com/v1.0';
const ExpiredWorkbook = '017WP3WBAYGP7HS2I3XJDKF6Q2PL24MSOD';

/**
 * OneDrive Workbook 服务类
 */
export class OneDriveWorkbookService {
  constructor(graphToken = null) {
    // 优先使用传入的 token，否则使用 graph_token 文件的值
    this.graphToken = graphToken || defaultGraphToken || null;
    // 使用 ExpiredWorkbook 作为默认 workbookId
    this.workbookId = ExpiredWorkbook;
    this.sessionId = null;
    this.workbookPath = null;
    this.baseUrl = null;
  }

  /**
   * 设置 Graph Token（Access Token）
   * @param {string} token - Microsoft Graph access token
   */
  setGraphToken(token) {
    if (!token || typeof token !== 'string') {
      throw new Error('Invalid graph token: token must be a non-empty string');
    }
    this.graphToken = token;
  }

  /**
   * 检查是否已设置 token
   * @returns {boolean}
   */
  isAuthenticated() {
    return !!this.graphToken;
  }

  /**
   * 构建请求头
   * @returns {Object} HTTP headers
   */
  _getHeaders() {
    const headers = {
      'Authorization': `Bearer ${this.graphToken}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    };

    // 如果存在 session，添加 session header
    if (this.sessionId) {
      headers['workbook-session-id'] = this.sessionId;
    }

    return headers;
  }

  /**
   * 构建 Workbook 基础 URL
   * 支持通过文件 ID 或路径访问
   *
   * @param {string} workbookId - OneDrive 文件 ID
   * @param {string} workbookPath - OneDrive 文件路径（如 "Documents/data.xlsx"）
   * @returns {string} 基础 URL
   */
  _buildBaseUrl(workbookId, workbookPath) {
    if (workbookId) {
      return `${GRAPH_API_BASE}/me/drive/items/${workbookId}/workbook`;
    } else if (workbookPath) {
      // 路径中的特殊字符需要处理
      const encodedPath = workbookPath.split('/').map(encodeURIComponent).join('/');
      return `${GRAPH_API_BASE}/me/drive/root:/${encodedPath}:/workbook`;
    }
    throw new Error('Must provide either workbookId or workbookPath');
  }

  /**
   * 发送 Graph API 请求
   * 通过 chrome.runtime.sendMessage 代理到 background.js 执行
   * 避免 content script 被宿主页面的 CSP 阻止
   *
   * @param {string} url - API 端点
   * @param {string} method - HTTP 方法
   * @param {Object} body - 请求体
   * @returns {Promise<Object>} 响应数据
   */
  async _request(url, method = 'GET', body = null) {
    if (!this.isAuthenticated()) {
      throw new Error('Not authenticated: graph token is required');
    }

    try {
      // 判断运行环境
      // background.js (Service Worker) 中没有 window 对象，可直接 fetch
      // content script / popup 中有 window 对象，需要通过 background 代理
      const isInBackground = typeof window === 'undefined';
      log.debug("isInBackground: ", isInBackground);
      
      if (isInBackground) {
        
        // 在 Service Worker 中直接 fetch
        return await this._fetchDirect(url, method, body);
      } else {
        
        // 在 content script / popup 中通过 background 代理
        return await this._fetchViaBackground(url, method, body);
      }
    } catch (error) {
      log.error('OneDrive Workbook API 请求失败:', error);
      throw error;
    }
  }

  /**
   * 直接 fetch（在 background.js Service Worker 中使用）
   */
  async _fetchDirect(url, method, body) {
    const options = {
      method: method,
      headers: this._getHeaders()
    };

    if (body && (method === 'POST' || method === 'PATCH' || method === 'DELETE')) {
      options.body = JSON.stringify(body);
    }

    const response = await fetch(url, options);

    // 处理 401 Unauthorized
    if (response.status === 401) {
      throw new Error('Graph API authentication failed: token expired or invalid');
    }

    // 处理 404 Not Found
    if (response.status === 404) {
      if (this.sessionId && url.includes('/workbook/') && !url.includes('/createSession')) {
        log.warn('Workbook session 已过期，正在重建...');
        await this.createSession();
        return this._fetchDirect(url, method, body);
      }
      throw new Error('Workbook or resource not found');
    }

    // 处理其他错误
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(
        `Graph API error (${response.status}): ${errorData.error?.message || response.statusText}`
      );
    }

    // 204 No Content
    if (response.status === 204) {
      return null;
    }

    return await response.json();
  }

  /**
   * 通过 background.js 代理 fetch（在 content script 中使用）
   * 避免 CSP 限制
   */
  async _fetchViaBackground(url, method, body) {

    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({
        type: 'ONEDRIVE_API_REQUEST',
        request: {
          url,
          method,
          body,
          headers: this._getHeaders()
        }
      }, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!response) {
          reject(new Error('No response from background'));
          return;
        }
        if (response.success) {
          resolve(response.data);
        } else {
          reject(new Error(response.error || 'OneDrive API request failed'));
        }
      });
    });
  }

  /**
   * 连接 Workbook
   * 初始化与 OneDrive Workbook 的连接，创建 session
   * 支持通过 options 传入 workbookId/workbookPath，未传时使用 constructor 中的默认值
   *
   * @param {Object} options - 连接选项
   * @param {string} options.workbookId - OneDrive 文件 ID
   * @param {string} options.workbookPath - OneDrive 文件路径
   * @param {boolean} options.persistChanges - 是否持久化更改（默认 true）
   * @returns {Promise<Object>} 连接结果
   */
  async connect(options = {}) {
    const workbookId = options.workbookId || this.workbookId || null;
    const workbookPath = options.workbookPath || this.workbookPath || null;
    const persistChanges = options.persistChanges !== undefined ? options.persistChanges : true;

    if (!this.isAuthenticated()) {
      throw new Error('Graph token is required. Call setGraphToken() first.');
    }

    if (!workbookId && !workbookPath) {
      throw new Error('Must provide either workbookId or workbookPath (via connect() options or constructor defaults)');
    }

    this.workbookId = workbookId;
    this.workbookPath = workbookPath;
    this.baseUrl = this._buildBaseUrl(workbookId, workbookPath);

    try {
      // 验证 Workbook 可访问
      await this._request(this.baseUrl);
      log.info('Workbook 连接验证成功');

      // 创建 Session（提高性能）
      await this.createSession(persistChanges);

      return {
        success: true,
        workbookId: this.workbookId,
        workbookPath: this.workbookPath,
        sessionId: this.sessionId
      };
    } catch (error) {
      log.error('连接 Workbook 失败:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * 创建 Workbook Session
   * Session 可以显著提高 API 性能
   *
   * @param {boolean} persistChanges - 是否持久化更改
   * @returns {Promise<string>} Session ID
   */
  async createSession(persistChanges = true) {
    if (!this.baseUrl) {
      throw new Error('Workbook not connected. Call connect() first.');
    }

    try {
      const url = `${this.baseUrl}/createSession`;
      const result = await this._request(url, 'POST', { persistChanges });

      this.sessionId = result.id;
      log.info(`Workbook session created: ${maskSecret(this.sessionId)}, persistChanges: ${persistChanges}`);

      return this.sessionId;
    } catch (error) {
      log.error('创建 Workbook session 失败:', error);
      throw error;
    }
  }

  /**
   * 刷新 Session（防止过期）
   * 永久 Session 约 5 分钟不活动过期，非永久约 7 分钟
   * @returns {Promise<boolean>}
   */
  async refreshSession() {
    if (!this.sessionId) {
      log.warn('没有可刷新的活动 session');
      return false;
    }

    try {
      // 通过简单的请求刷新 session
      await this.getWorksheets();
      return true;
    } catch (error) {
      log.warn('Session 刷新失败，正在重建...');
      await this.createSession();
      return true;
    }
  }

  /**
   * 关闭 Session
   * @returns {Promise<boolean>}
   */
  async closeSession() {
    if (!this.sessionId) {
      return true;
    }

    try {
      const url = `${this.baseUrl}/closeSession`;
      await this._request(url, 'POST');
      log.info('Workbook session 已关闭');
      this.sessionId = null;
      return true;
    } catch (error) {
      log.error('关闭 session 失败:', error);
      this.sessionId = null;
      return false;
    }
  }

  // ==================== Worksheet 读取操作 ====================

  /**
   * 获取所有 Worksheets
   * @returns {Promise<Array>} Worksheets 列表
   */
  async getWorksheets() {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets`;
    const result = await this._request(url);
    return result.value || [];
  }

  /**
   * 获取指定 Worksheet
   * @param {string} name - Worksheet 名称
   * @returns {Promise<Object>} Worksheet 信息
   */
  async getWorksheet(name) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets/${encodeURIComponent(name)}`;
    return await this._request(url);
  }

  /**
   * 获取 Worksheet 中的 Used Range（已使用区域）
   * @param {string} worksheetName - Worksheet 名称
   * @returns {Promise<Object>} Range 数据
   */
  async getUsedRange(worksheetName) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets/${encodeURIComponent(worksheetName)}/usedRange`;
    return await this._request(url);
  }

  /**
   * 获取指定 Range 的数据
   * @param {string} worksheetName - Worksheet 名称
   * @param {string} address - Range 地址（如 "A1:D10"）
   * @returns {Promise<Object>} Range 数据
   */
  async getRange(worksheetName, address) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets/${encodeURIComponent(worksheetName)}/range(address='${address}')`;
    return await this._request(url);
  }

  /**
   * 获取 Range 的值
   * @param {string} worksheetName - Worksheet 名称
   * @param {string} address - Range 地址
   * @returns {Promise<Array>} 二维数组值
   */
  async getRangeValues(worksheetName, address) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets/${encodeURIComponent(worksheetName)}/range(address='${address}')/$value`;
    return await this._request(url);
  }

  // ==================== Worksheet 编辑操作 ====================

  /**
   * 创建新 Worksheet
   * @param {string} name - 新 Worksheet 名称
   * @returns {Promise<Object>} 创建的 Worksheet 信息
   */
  async createWorksheet(name) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets`;
    return await this._request(url, 'POST', { name });
  }

  /**
   * 删除 Worksheet
   * @param {string} name - Worksheet 名称
   * @returns {Promise<boolean>}
   */
  async deleteWorksheet(name) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets/${encodeURIComponent(name)}`;
    await this._request(url, 'DELETE');
    return true;
  }

  /**
   * 重命名 Worksheet
   * @param {string} oldName - 当前名称
   * @param {string} newName - 新名称
   * @returns {Promise<Object>} 更新后的 Worksheet 信息
   */
  async renameWorksheet(oldName, newName) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets/${encodeURIComponent(oldName)}`;
    return await this._request(url, 'PATCH', { name: newName });
  }

  /**
   * 移动 Worksheet 位置
   * @param {string} name - Worksheet 名称
   * @param {number} position - 新位置索引（从 0 开始）
   * @returns {Promise<Object>} 更新后的 Worksheet 信息
   */
  async moveWorksheet(name, position) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets/${encodeURIComponent(name)}`;
    return await this._request(url, 'PATCH', { position });
  }

  // ==================== Range 编辑操作 ====================

  /**
   * 更新 Range 的值
   * values 是二维数组，与 Range 大小匹配
   *
   * @param {string} worksheetName - Worksheet 名称
   * @param {string} address - Range 地址（如 "A1:B2"）
   * @param {Array<Array>} values - 二维数组值
   * @returns {Promise<Object>} 更新后的 Range
   */
  async updateRangeValues(worksheetName, address, values) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets/${encodeURIComponent(worksheetName)}/range(address='${address}')`;
    return await this._request(url, 'PATCH', { values });
  }

  /**
   * 更新 Range 的公式
   * @param {string} worksheetName - Worksheet 名称
   * @param {string} address - Range 地址
   * @param {Array<Array>} formulas - 二维数组公式（如 "=SUM(A1:A10)"）
   * @returns {Promise<Object>} 更新后的 Range
   */
  async updateRangeFormulas(worksheetName, address, formulas) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets/${encodeURIComponent(worksheetName)}/range(address='${address}')`;
    return await this._request(url, 'PATCH', { formulas });
  }

  /**
   * 更新 Range 的数字格式
   * @param {string} worksheetName - Worksheet 名称
   * @param {string} address - Range 地址
   * @param {Array<Array>} numberFormat - 二维数组格式代码（如 "m-ddd", "0.00%"）
   * @returns {Promise<Object>} 更新后的 Range
   */
  async updateRangeNumberFormat(worksheetName, address, numberFormat) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets/${encodeURIComponent(worksheetName)}/range(address='${address}')`;
    return await this._request(url, 'PATCH', { numberFormat });
  }

  /**
   * 批量更新 Range（值、公式、格式）
   * @param {string} worksheetName - Worksheet 名称
   * @param {string} address - Range 地址
   * @param {Object} data - 包含 values/formulas/numberFormat 的对象
   * @returns {Promise<Object>} 更新后的 Range
   */
  async updateRange(worksheetName, address, data) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets/${encodeURIComponent(worksheetName)}/range(address='${address}')`;
    return await this._request(url, 'PATCH', data);
  }

  /**
   * 清除 Range 内容
   * @param {string} worksheetName - Worksheet 名称
   * @param {string} address - Range 地址
   * @param {string} applyTo - 清除类型: "All"(默认) | "Formats" | "Contents"
   * @returns {Promise<boolean>}
   */
  async clearRange(worksheetName, address, applyTo = 'All') {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets/${encodeURIComponent(worksheetName)}/range(address='${address}')/clear`;
    await this._request(url, 'POST', { applyTo });
    return true;
  }

  /**
   * 在 Range 位置插入单元格
   * @param {string} worksheetName - Worksheet 名称
   * @param {string} address - Range 地址
   * @param {string} shift - 插入方向: "Right" | "Down"
   * @returns {Promise<Object>} 新插入的 Range
   */
  async insertRange(worksheetName, address, shift = 'Down') {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets/${encodeURIComponent(worksheetName)}/range(address='${address}')/insert`;
    return await this._request(url, 'POST', { shift });
  }

  /**
   * 删除 Range 单元格
   * @param {string} worksheetName - Worksheet 名称
   * @param {string} address - Range 地址
   * @param {string} shift - 删除方向: "Left" | "Up"
   * @returns {Promise<boolean>}
   */
  async deleteRange(worksheetName, address, shift = 'Up') {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets/${encodeURIComponent(worksheetName)}/range(address='${address}')/delete`;
    await this._request(url, 'POST', { shift });
    return true;
  }

  // ==================== Table 读取操作 ====================

  /**
   * 获取 Worksheet 中的所有 Tables
   * @param {string} worksheetName - Worksheet 名称
   * @returns {Promise<Array>} Tables 列表
   */
  async getTables(worksheetName) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets/${encodeURIComponent(worksheetName)}/tables`;
    const result = await this._request(url);
    return result.value || [];
  }

  /**
   * 获取 Table 的所有行
   * @param {string} tableName - Table 名称或 ID
   * @returns {Promise<Array>} 行数据
   */
  async getTableRows(tableName) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/tables('${encodeURIComponent(tableName)}')/rows`;
    const result = await this._request(url);
    return result.value || [];
  }

  /**
   * 获取 Table 的列
   * @param {string} tableName - Table 名称或 ID
   * @returns {Promise<Array>} 列数据
   */
  async getTableColumns(tableName) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/tables('${encodeURIComponent(tableName)}')/columns`;
    const result = await this._request(url);
    return result.value || [];
  }

  /**
   * 将 Table 数据转换为 JSON 数组（类似 sheet_to_json）
   * @param {string} tableName - Table 名称
   * @returns {Promise<Array>} JSON 数组
   */
  async getTableDataAsJson(tableName) {
    const columns = await this.getTableColumns(tableName);
    const rows = await this.getTableRows(tableName);

    const headers = columns.map(col => col.name);

    return rows.map(row => {
      const obj = {};
      const values = row.values[0]; // 每行是一个二维数组
      headers.forEach((header, index) => {
        obj[header] = values[index] !== undefined ? values[index] : null;
      });
      return obj;
    });
  }

  // ==================== Table 编辑操作 ====================

  /**
   * 创建 Table
   * @param {string} worksheetName - Worksheet 名称
   * @param {string} address - Table 区域地址（如 "A1:D10"）
   * @param {boolean} hasHeaders - 第一行是否为表头（默认 true）
   * @returns {Promise<Object>} 创建的 Table 信息
   */
  async createTable(worksheetName, address, hasHeaders = true) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/worksheets/${encodeURIComponent(worksheetName)}/tables/add`;
    return await this._request(url, 'POST', { address, hasHeaders });
  }

  /**
   * 删除 Table
   * @param {string} tableName - Table 名称或 ID
   * @returns {Promise<boolean>}
   */
  async deleteTable(tableName) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/tables('${encodeURIComponent(tableName)}')`;
    await this._request(url, 'DELETE');
    return true;
  }

  /**
   * 向 Table 添加行
   * @param {string} tableName - Table 名称或 ID
   * @param {Array<Array>} values - 行数据二维数组（每个内层数组是一行）
   * @param {number|null} index - 插入位置（null 表示追加到末尾）
   * @returns {Promise<Object>} 添加的行信息
   */
  async addTableRow(tableName, values, index = null) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/tables('${encodeURIComponent(tableName)}')/rows/add`;
    const body = { values };
    if (index !== null) {
      body.index = index;
    }
    return await this._request(url, 'POST', body);
  }

  /**
   * 批量向 Table 添加多行
   * @param {string} tableName - Table 名称或 ID
   * @param {Array<Array<Array>>} rowsValues - 多行数据，每行是一个二维数组
   * @returns {Promise<Array>} 添加的行信息列表
   */
  async addTableRows(tableName, rowsValues) {
    const results = [];
    for (const rowValues of rowsValues) {
      const result = await this.addTableRow(tableName, [rowValues]);
      results.push(result);
    }
    return results;
  }

  /**
   * 更新 Table 行数据
   * @param {string} tableName - Table 名称或 ID
   * @param {number} rowIndex - 行索引（从 0 开始）
   * @param {Array<Array>} values - 新行数据二维数组
   * @returns {Promise<Object>} 更新后的行
   */
  async updateTableRow(tableName, rowIndex, values) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/tables('${encodeURIComponent(tableName)}')/rows/itemAt(index=${rowIndex})`;
    return await this._request(url, 'PATCH', { values });
  }

  /**
   * 删除 Table 行
   * @param {string} tableName - Table 名称或 ID
   * @param {number} rowIndex - 行索引（从 0 开始）
   * @returns {Promise<boolean>}
   */
  async deleteTableRow(tableName, rowIndex) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/tables('${encodeURIComponent(tableName)}')/rows/itemAt(index=${rowIndex})`;
    await this._request(url, 'DELETE');
    return true;
  }

  /**
   * 删除 Table 所有行（保留表头）
   * @param {string} tableName - Table 名称或 ID
   * @returns {Promise<boolean>}
   */
  async clearTableRows(tableName) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const rows = await this.getTableRows(tableName);
    // 从后往前删除，避免索引变化
    for (let i = rows.length - 1; i >= 0; i--) {
      await this.deleteTableRow(tableName, i);
    }
    return true;
  }

  /**
   * 更新 Table 名称
   * @param {string} tableName - 当前 Table 名称或 ID
   * @param {string} newName - 新名称
   * @returns {Promise<Object>} 更新后的 Table
   */
  async renameTable(tableName, newName) {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/tables('${encodeURIComponent(tableName)}')`;
    return await this._request(url, 'PATCH', { name: newName });
  }

  /**
   * 将 JSON 数组数据写入 Table（清空后写入）
   * @param {string} tableName - Table 名称或 ID
   * @param {Array<Object>} data - JSON 数组
   * @returns {Promise<boolean>}
   */
  async writeTableData(tableName, data) {
    if (!Array.isArray(data) || data.length === 0) {
      throw new Error('Data must be a non-empty array');
    }

    // 获取表头
    const columns = await this.getTableColumns(tableName);
    const headers = columns.map(col => col.name);

    // 清空现有行
    await this.clearTableRows(tableName);

    // 写入新数据
    for (const row of data) {
      const rowValues = headers.map(header => row[header] !== undefined ? row[header] : null);
      await this.addTableRow(tableName, [rowValues]);
    }

    return true;
  }

  // ==================== 便捷方法 ====================

  /**
   * 读取整个 Worksheet 的数据为 JSON 数组
   * 使用 Used Range 读取所有数据，第一行作为表头
   *
   * @param {string} worksheetName - Worksheet 名称
   * @returns {Promise<Array>} JSON 数组
   */
  async getWorksheetDataAsJson(worksheetName) {
    const range = await this.getUsedRange(worksheetName);

    if (!range.values || range.values.length === 0) {
      return [];
    }

    const rows = range.values;
    const headers = rows[0].map(h => String(h || '').trim());

    return rows.slice(1).map(row => {
      const obj = {};
      headers.forEach((header, index) => {
        obj[header] = row[index] !== undefined ? row[index] : null;
      });
      return obj;
    });
  }

  /**
   * 获取 Workbook 基本信息
   * @returns {Promise<Object>}
   */
  async getWorkbookInfo() {
    if (!this.baseUrl) throw new Error('Workbook not connected');
    return await this._request(this.baseUrl);
  }

  /**
   * 获取 Workbook 中的所有 Named Items（命名区域）
   * @returns {Promise<Array>}
   */
  async getNamedItems() {
    if (!this.baseUrl) throw new Error('Workbook not connected');

    const url = `${this.baseUrl}/names`;
    const result = await this._request(url);
    return result.value || [];
  }

  /**
   * 列出 OneDrive 最近文件（帮助查找有效的 Workbook ID）
   * 无需预先 connect Workbook，直接查询 Drive
   * @param {number} limit - 返回文件数量（默认 10）
   * @returns {Promise<Array>} 文件列表（含 id, name, size, lastModifiedDateTime）
   */
  async listRecentFiles(limit = 10) {
    if (!this.isAuthenticated()) {
      throw new Error('Graph token is required');
    }
    const url = `${GRAPH_API_BASE}/me/drive/recent?$top=${limit}`;
    const result = await this._request(url, 'GET');
    return (result.value || []).map(f => ({
      id: f.id,
      name: f.name,
      size: f.size,
      lastModified: f.lastModifiedDateTime,
      webUrl: f.webUrl
    }));
  }

  /**
   * 按文件名搜索 Workbook（帮助查找文件 ID）
   * @param {string} fileName - 文件名（如 "data.xlsx"）
   * @returns {Promise<Array>} 匹配的文件列表
   */
  async searchWorkbookByName(fileName) {
    if (!this.isAuthenticated()) {
      throw new Error('Graph token is required');
    }
    const url = `${GRAPH_API_BASE}/me/drive/root/search(q='${encodeURIComponent(fileName)}')`;
    const result = await this._request(url, 'GET');
    return (result.value || []).map(f => ({
      id: f.id,
      name: f.name,
      path: f.parentReference?.path,
      webUrl: f.webUrl
    }));
  }

  // ==================== 测试连接 ====================

  /**
   * 测试 OneDrive Workbook 连接
   * 使用 constructor 中已配置的默认值（graph_token.js + ExpiredWorkbook）
   * 分步验证：token → drive → workbook → worksheets
   *
   * @returns {Promise<Object>} 测试结果
   */
  async testConnection() {
    const result = {
      success: false,
      tokenOk: false,
      driveOk: false,
      workbookOk: false,
      worksheets: [],
      worksheetCount: 0,
      message: ''
    };

    try {
      // 1. 检查 Token（来自 graph_token.js）
      if (!this.isAuthenticated()) {
        result.message = '未找到 Graph Token，请更新 src/common/graph_token.js';
        return result;
      }
      result.tokenOk = true;

      // 2. 验证 Token 是否有效（调用 /me 验证身份）
      try {
        const profile = await this._request(`${GRAPH_API_BASE}/me`, 'GET');
        result.tokenUserName = profile?.displayName || profile?.userPrincipalName || 'Unknown';
        log.info('Token 验证成功，用户:', result.tokenUserName);
      } catch (tokenError) {
        result.tokenOk = false;
        result.message = `Token 已过期或无效: ${tokenError.message}`;
        return result;
      }

      // 3. 验证 Drive 访问（列出最近文件）
      try {
        const driveFiles = await this._request(`${GRAPH_API_BASE}/me/drive/recent`, 'GET');
        result.driveOk = true;
        result.recentFileCount = driveFiles?.value?.length || 0;
        result.recentFiles = (driveFiles?.value || []).slice(0, 5).map(f => ({
          name: f.name,
          id: f.id
        }));
        log.info('Drive 访问成功，最近文件:', result.recentFiles);
      } catch (driveError) {
        result.driveOk = false;
        result.message = `Drive 访问失败: ${driveError.message}`;
        return result;
      }

      // 4. 检查 Workbook（来自 ExpiredWorkbook 常量）
      if (!this.workbookId && !this.workbookPath) {
        result.message = '未找到 Workbook 配置，请更新 src/common/onedrive_service.js 中的 ExpiredWorkbook 常量';
        return result;
      }

      // 5. 连接 Workbook（使用实例已有的 workbookId/workbookPath）
      const connectResult = await this.connect({ persistChanges: true });

      if (!connectResult.success) {
        // Workbook 连接失败，列出最近文件帮助用户找到正确的 ID
        result.message = `连接 Workbook 失败: ${connectResult.error}`;
        try {
          const recentFiles = await this.listRecentFiles(5);
          result.suggestedFiles = recentFiles.filter(f => f.name.endsWith('.xlsx'));
          if (result.suggestedFiles.length > 0) {
            result.message += '\n\n建议：以下最近 Excel 文件可能可用，请更新 ExpiredWorkbook 常量:';
            result.suggestedFiles.forEach(f => {
              result.message += `\n  - ${f.name} (ID: ${f.id})`;
            });
          }
        } catch (e) { /* ignore list error */ }
        return result;
      }
      result.workbookOk = true;

      // 6. 获取 Worksheets 列表
      result.worksheets = await this.getWorksheets();
      result.worksheetCount = result.worksheets.length;

      // 7. 断开连接
      await this.disconnect();

      result.success = true;
      result.message = `连接成功！用户: ${result.tokenUserName}，Workbook 中有 ${result.worksheetCount} 个 Worksheet`;
      return result;

    } catch (error) {
      result.message = `测试失败: ${error.message}`;
      try { await this.disconnect(); } catch (e) { /* ignore */ }
      return result;
    }
  }

  // ==================== 断开连接 ====================

  /**
   * 断开 Workbook 连接
   * 关闭 session 并清理资源
   */
  async disconnect() {
    try {
      await this.closeSession();
    } catch (e) {
      // 忽略关闭 session 的错误
    }

    this.workbookId = null;
    this.workbookPath = null;
    this.baseUrl = null;
    log.info('Workbook 已断开连接');
  }
}

/**
 * 创建 OneDrive Workbook 服务实例（工厂函数）
 * @param {string} graphToken - Microsoft Graph access token
 * @returns {OneDriveWorkbookService}
 */
export function createOneDriveWorkbookService(graphToken) {
  return new OneDriveWorkbookService(graphToken);
}

export default OneDriveWorkbookService;
