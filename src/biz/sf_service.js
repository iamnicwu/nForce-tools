/* eslint-disable no-unused-vars */
import { createLogger } from "../common/logger.js";

const log = createLogger("SF");
import { flattenRecords, remove_duplicates, loadingLog } from "../common/utils.js";
import { applyExpiryRules, applyT2Rules } from "../common/t2rules.js";
import { SfRestConnection } from "../common/sf_rest_client.js";
// Execute Anonymous 取日志的纯逻辑（SOQL 拼装 + "哪条日志才算本次的"），见该文件头
import * as apexLog from "../common/apex_log.js";
import {
  DEFAULT_API_VERSION,
  normalizeApiVersion,
  pickUsableApiVersion,
  probeInstanceApiVersions,
} from "../common/api_version.js";

/**
 * 当前使用的 Salesforce API 版本。
 *
 * 这是一个 **ESM 活绑定**（`export let`）：本文件里的
 * `/services/data/v${defaultApiVersion}/...` 模板串，以及其他 `import` 它的模块，
 * 都会在 `applyApiVersion()` 重新赋值后立刻读到新值，不需要各自再读一次设置。
 */
export let defaultApiVersion = DEFAULT_API_VERSION;
export let globalConn = null;
export let userInfo = null;

/**
 * 把设置页里配置的 API 版本应用到运行时（由 `app.js` 启动时与设置页保存时调用）。
 *
 * 两个容易漏掉的点：
 * 1. **已建立的连接对象自己缓存了一份 `version`**，必须一起改掉。
 *    否则用户改了版本、界面也显示新值，但请求其实还走在旧版本路径上，
 *    直到重新「测试连接」才生效 —— 属于看着对、实际没生效的那类 bug。
 * 2. 只改版本号不重连是安全的：它只是 URL 里的 `/v67.0/` 这一段。
 *    若配置的版本超出该 org 支持的范围，`testConnection()` 里的版本协商会在下一次
 *    建连接时自动退到实例支持的最高版本（`common/api_version.js` 的
 *    `probeInstanceApiVersions` / `pickUsableApiVersion`），不会再以 404 的形式
 *    伪装成「连不上」——各 org 的升级窗口不同，这不是配置错误。
 *
 * @param {string|number} raw 用户输入或 storage 里的值
 * @returns {boolean} 是否与之前不同（调用方可据此决定要不要提示用户重连）
 */
export function applyApiVersion(raw) {
  const next = normalizeApiVersion(raw);
  const changed = next !== defaultApiVersion;
  defaultApiVersion = next;

  const conn = sfConn.connection;
  if (conn && conn.version !== next) {
    conn.version = next;
    log.info(`API 版本切换为 v${next}，已同步到当前连接`);
  }
  return changed;
}

/**
 * 会话**中途**失效时的续期钩子。
 *
 * 由 `app.js` 在启动时通过 `setAuthFailureHandler()` 注入 —— 方向是 app → service，
 * 所以本模块不需要（也不应该）反向 import 应用层，避免循环依赖。
 *
 * 注入后，`sfConn.connection` 上发出的任何请求一旦拿到 401/403，都会先请钩子去
 * 浏览器 Cookie 换一份新会话，再用新凭据把**原来那条请求原样重发一次**。
 * 用户侧的体感是「用着用着会话过期了，但功能照常能用」——不再需要手动点重连。
 */
let authFailureHandler = null;

/**
 * 注入 / 卸载「会话失效自动续期」处理器（传 null 即卸载）。
 * @param {null | ((ctx: {instanceUrl: string, sessionId: string|null}) =>
 *   Promise<{sessionId?: string, instanceUrl?: string}|null>)} fn
 */
export function setAuthFailureHandler(fn) {
  authFailureHandler = typeof fn === "function" ? fn : null;
  // 已经建好的连接也要立刻跟上，否则要等下一次「测试连接」才生效
  if (sfConn.connection) sfConn.connection.onAuthFailure = authFailureHandler;
}

/**
 * ⚠️ TODO(query): PCD 过期数据的 SOQL 查询 —— **待补充**。
 *
 * 「获取 PCD 过期数据」功能（首页 PCD 分组 · section-29）只依赖这一个常量。
 * 拿到正式查询后，**只改这里**（把下面这串整体替换掉）即可，
 * sf_service.getPCDExpiredData() / logic.js / ui.js / index.html 都不用动。
 *
 * 当前值是「占位查询」：字段与筛选条件和 PCD 当日数据保持一致，只为让
 * 整条链路（取数 → 去重 → 渲染 → 导出）现在就能跑通，业务口径**并不代表**
 * 「过期」的正式定义。
 *
 * 注意：查询必须以 `FROM OrderItem` 为准，返回的字段名会直接决定表格列与导出列；
 * 若新增字段，`applyT2Rules` 会按字段名自动匹配（匹配不上就留空，不会报错）。
 */
const PCD_EXPIRED_SOQL = `SELECT order.Name,
        order.OrderNumber,
        order.Order_Nature__c,
        order.Service_Request_Date__c,
        order.Attention__c,
        FulfillmentRemark__c,
        order.id,
        order.Custom_OrderStatus__c,
        order.Custom_FulfilmentStatus__c,
        FulfillmentId__c,
        AppointmentId__c,
        vlocity_cmt__FulfilmentStatus__c,
        BRM_Request_Id__c,
        LOB__c,
        order.Is_Voluntary__c,
        order.Self_Return__c
    FROM OrderItem
    WHERE
        (MainProduct__c = TRUE OR Product2.vlocity_cmt__SubType__c = 'NowTV Standalone Starter Offer') AND
        LOB__c !='' AND
        order.Attention__c = '' AND
        order.Service_Request_Date__c <= TODAY AND
        order.Service_Request_Date__c > 2026-01-01 AND
        order.Custom_OrderStatus__c NOT IN (
            'Ready To Submit', 'Superseded', 'Activated',
            'Cancel Requested', 'Cancelled', 'Rejected', 'Discarded')`;

export let sfConn = {
  connection: null,

  // 最近一次连接失败的原因。
  // 用于区分「服务端明确判定会话失效（401 / INVALID_SESSION_ID）」
  // 与「请求根本没能到达服务端（CSP / 网络 / 代理拦截）」，
  // 前者才可以安全地把界面降级为未连接。
  lastError: null,

  async testConnection(session_id, instanceUrl) {
    try {
      log.debug("instanceUrl:", instanceUrl);
      let finalInstanceUrl = instanceUrl;
      
      // 如果没有传入 instanceUrl，尝试从 chrome.storage.local 获取
      if (!finalInstanceUrl) {
        try {
          const stored = await chrome.storage.local.get('sf_instance_url');
          finalInstanceUrl = stored.sf_instance_url;
        } catch (e) {
          log.warn('从 chrome.storage.local 读取 instanceUrl 失败:', e);
        }
      }
      
      // 如果仍然没有，使用默认的 here2serve 实例
      if (!finalInstanceUrl) {
        finalInstanceUrl = "https://here2serve.my.salesforce.com";
        log.info("未提供 instanceUrl（storage 中也未找到），使用默认值:", finalInstanceUrl);
      } else {
        log.info("使用会话中的 instanceUrl:", finalInstanceUrl);
      }

      if (finalInstanceUrl === "https://here2serve.lightning.force.com") {
        finalInstanceUrl = "https://here2serve.my.salesforce.com";
      }

      // ── 先把 API 版本夹进这个 org **实际支持**的范围 ──
      //
      // 各 org 的升级窗口是分批走的：同一家企业里的两个 org 完全可能差一版。
      // 对还没升上来的 org 请求 `/services/data/v<配置值>/`，Salesforce 返回
      // **404 Not Found** —— 而 `identity()` 正是建连接的第一步，于是整件事
      // 表现为「一直未连接」，从 404 这条错误上完全看不出是版本问题。
      //
      // 配置的版本可用 → 什么都不做；不可用 → 退到实例支持的最高版本。
      // 探测失败（离线 / CSP / 域名不是 Salesforce）→ 沿用配置值，不阻断主流程。
      const pickedVersion = pickUsableApiVersion(
        defaultApiVersion,
        await probeInstanceApiVersions(finalInstanceUrl)
      );
      if (pickedVersion.fellBack) {
        log.warn(
          `该 org 不支持 API v${defaultApiVersion}（实例可用：` +
            `${pickedVersion.available.map((v) => "v" + v.toFixed(1)).join(" / ")}），` +
            `本次连接改用 v${pickedVersion.version}`
        );
        // 同步模块级值：本文件里另有几处手拼 `/services/data/v${defaultApiVersion}/…`
        // （limits、Bulk 结果下载、Bulk 任务查询），不同步的话它们仍会打在不可用的版本上。
        defaultApiVersion = pickedVersion.version;
      }

      // Salesforce 客户端是自研的普通 ESM（common/sf_rest_client.js），
      // 直接 import 即可，不再需要惰性注入 1.37MB 的 jsforce
      const conn = new SfRestConnection({
        instanceUrl: finalInstanceUrl,
        serverUrl: `${finalInstanceUrl}/services/Soap/u/${pickedVersion.version}`,
        sessionId: session_id,
        version: pickedVersion.version,
      });

      // Get user identity info
      userInfo = await conn.identity();
      // 安全：不输出完整的连接对象和用户信息，避免泄露 session ID 和 access token
      log.info("Salesforce 连接建立成功");
      log.debug("用户:", userInfo?.display_name || userInfo?.name || userInfo?.username);
      // 保存连接对象
      //
      // ⚠️ 续期钩子必须挂在这里 —— 也就是 `identity()` 已经 **成功之后**。
      // `testConnection()` 同时承担两件事：它是「这条会话还活着吗」的**判据**，
      // 又负责造出 app 长期使用的那个连接对象。如果钩子在验证之前就挂上，
      // 那么验证本身拿到 401 时就会触发续期 → 续期又要调 testConnection 去验证
      // 候选会话 → 再次 401 → 无限递归（或撞上重入锁后互相等待）。
      // 放在验证之后，验证路径永远只是「照实回答 true/false」，
      // 而 app 里所有功能走的 `sfConn.connection` 才具备无缝续期能力。
      conn.onAuthFailure = authFailureHandler;
      this.connection = conn;
      globalConn = conn;
      this.lastError = null;
      return true;
    } catch (err) {
      log.error("连接测试失败:", err);
      this.connection = null;
      this.lastError = {
        message: err && err.message ? err.message : String(err),
        errorCode: err && (err.errorCode || err.name) ? String(err.errorCode || err.name) : null,
        statusCode: err && err.statusCode ? err.statusCode : null
      };
      return false;
    }
  },

  async getUserInfo() {
    try {
      return { success: true, userInfo };
    } catch (error) {
      log.error("获取用户信息失败:", error);
      return { success: false, error: error.message };
    }
  },

  async getOrgInfo() {
    try {
      if (!this.connection) {
        return {
          success: false,
          error: "Salesforce connection not established",
        };
      }

      const result = await this.connection.query("SELECT Id, IsSandbox, OrganizationType FROM Organization");
      if (result.records && result.records.length > 0) {
        return { success: true, orgInfo: result.records[0] };
      } else {
        return { success: false, error: "No organization info found" };
      }
    } catch (error) {
      log.error("获取组织信息失败:", error);
      return { success: false, error: error.message };
    }
  },


  /**
   * 获取 T2 报表数据
   *
   * 此方法执行以下操作：
   * 1. 确定查询的时间范围（默认根据当前是周五还是其他工作日，或使用自定义天数）。
   * 2. 执行 SOQL 查询获取 OrderItem 数据。
   * 3. 展平查询结果并去重。
   * 4. 添加额外的空列（Action, Comment 等）。
   * 5. 过滤掉 FulfillmentDetail__c 包含特定关键字（INVENTORY ASSIGNED/READY）的记录。
   * 6. 应用 T2 业务规则（applyT2Rules）自动填充 Action 列。
   *
   * @param {number|null} customDays - 自定义查询未来几天的数据。如果为 null，则使用默认逻辑（周五查3天，其他查2天）。
   * @returns {Promise<Object>} - 包含 success 状态和 data 数据的对象。
   */
  async getT2Data(customDays = null) {
    try {
      if (!this.connection) {
        return {
          success: false,
          error: "Salesforce connection not established",
        };
      }

      // 获取当前日期，判断是否为周五
      const todayObj = dayjs();
      const dayOfWeek = todayObj.day(); // 0 (Sunday) to 6 (Saturday)
      let nextNDays = 4;
      
      if (customDays && !isNaN(customDays) && customDays > 0) {
        nextNDays = parseInt(customDays);
        log.info(`使用自定义天数：获取未来 ${nextNDays} 天的 T2 数据`);
      } else {
        log.info(`今天是星期 ${dayOfWeek}，获取未来 ${nextNDays} 天的 T2 数据`);
        // 如果是周五 (5)，查询未来3天的数据（覆盖周六、周日、周一）
        // if (dayOfWeek === 5) {
        //   nextNDays = 3;
        // } else {
        //   nextNDays = 2;
        // }
      }

      let dailyQuery = `SELECT
          order.Name,
          order.OrderNumber,
          order.Order_Nature__c,
          order.Service_Request_Date__c,
          order.Salesman_Staff_ID__c,
          order.Original_Salesman__r.Name,
          order.Channel_Name__c,
          order.LOB__c,
          FulfillmentId__c,
          AppointmentId__c,
          order.Attention__c,
          FulfillmentRemark__c,
          order.Custom_OrderStatus__c,
          order.Custom_FulfilmentStatus__c,
          FulfillmentDetail__c,
          order.Is_Voluntary__c,
          vlocity_cmt__FulfilmentStatus__c,
          Brm_Feedback_Code__c,
          BRM_Feedback_Error_Log__c,
          BRM_Request_Id__c,
          order.CreatedBy.name,
          OSS_Service_Number__c,
          order.ServiceNumber__c,
          order.Self_Return__c,
          order.PreInstallation__c,
          order.KeepExistAddrSubscriptionLOB__c
      FROM OrderItem
      WHERE
          MainProduct__c = true AND
          LOB__c !='' AND
          order.Service_Request_Date__c > TODAY AND
          order.Service_Request_Date__c <= NEXT_N_DAYS:${nextNDays} AND
          order.Service_Request_Date__c != null AND
          order.Custom_OrderStatus__c NOT IN ('Superseded', 'Activated','Cancelled', 'Discarded') `;
      
      // AND order.Order_Nature__c includes ('New installation','External Relocation', 'Internal Relocation')
      
      // 优化：直接获取查询结果，避免流式回调带来的额外开销
      const result = await this.connection.query(dailyQuery, { autoFetch: true, maxFetch: 999999 });
      const records = result.records || [];
      
      if (records.length > 0) {
        // 预处理数据，展平嵌套结构
        const processedRecords = flattenRecords(records);

        // 启用去重逻辑
        const removedDupeList = remove_duplicates(processedRecords);

        // 增加额外的列，并确保它们在最前面
        const addFields = removedDupeList.map(record => {
          return {
            'Action': '',
            'Comment (Provide date if require F&S follow up)': '',
            'Status (Done/ Pending etc)': '',
            'F&S Followup': '',
            '(Required/ """" """")': '',
            'COM Patch M1': '',
            ...record
          };
        });

        // 过滤掉 FulfillmentDetail__c 包含 INVENTORY ASSIGNED 或 INVENTORY READY 的数据
        // 优化：还需要加上 order.CreatedBy.name 不等于 integration.user 的时候才过滤
        const filteredRecords = addFields.filter(record => {
          const detail = (record.FulfillmentDetail__c || '').toUpperCase();
          const hasKeyword = detail.includes('INVENTORY ASSIGNED') || detail.includes('INVENTORY READY');
          
          if (!hasKeyword) {
            return true;
          }
          // 尝试获取 CreatedBy Name，处理可能的字段名大小写差异
          const createdBy = record['Order.CreatedBy.Name'] || record['order.CreatedBy.name'] || '';
          
          // 如果是 integration.user 创建的，则不过滤（保留）
          // 否则过滤掉
          return createdBy === 'integration.user';
        });

        // 应用 T2 规则
        const finalRecords = applyT2Rules(filteredRecords);

        log.info(`报表数据获取成功，原始: ${processedRecords.length}, 去重后: ${filteredRecords.length}`);
        
        return {
          success: true,
          data: finalRecords,
        };
      } else {
        return {
            success: true,
            data: [],
        };
      }
    } catch (error) {
      log.error("获取当日数据失败:", error);
      return { success: false, error: error.message };
    }
  },  
  async getReportData() {
    try {
      if (!this.connection) {
        return {
          success: false,
          error: "Salesforce connection not established",
        };
      }
      let dailyQuery = `SELECT
          order.Name,
          order.OrderNumber,
          order.Order_Nature__c,
          order.Service_Request_Date__c,
          order.Attention__c,
          FulfillmentRemark__c,
          order.id,
          order.Custom_OrderStatus__c,
          order.Custom_FulfilmentStatus__c,
          FulfillmentId__c,
          AppointmentId__c,
          vlocity_cmt__FulfilmentStatus__c,
          BRM_Request_Id__c
      FROM OrderItem
      WHERE
          MainProduct__c = true AND
          LOB__c ='FixedLine' AND
          order.Service_Request_Date__c <= TODAY AND
          order.Service_Request_Date__c > 2026-03-01 AND
          order.Custom_OrderStatus__c NOT IN (
              'Ready To Submit', 'Superseded', 'Activated',
              'Cancel Requested', 'Cancelled', 'Rejected', 'Discarded')`;
      
      // 优化：直接获取查询结果，避免流式回调带来的额外开销
      const result = await this.connection.query(dailyQuery, { autoFetch: true, maxFetch: 99999 });
      const records = result.records || [];
      
      if (records.length > 0) {
        // 预处理数据，展平嵌套结构
        const processedRecords = flattenRecords(records);

        // 启用去重逻辑
        const removedDupeList = remove_duplicates(processedRecords);
        log.info(`报表数据获取成功，原始: ${processedRecords.length}, 去重后: ${removedDupeList.length}`);
        
        // 增加额外的列，并确保它们在最前面
        const addFields = removedDupeList.map(record => {
          return {
            ...record,
            'Issue Status': '',
            'Latest Action By': '',
            'Action': '',
            'Remark': '',
            'Root Cause Category': ''
          };
        });

        // 应用 T2 规则
        const finalRecords = applyExpiryRules(addFields);

        return {
          success: true,
          data: finalRecords,
        };
      } else {
        return {
            success: true,
            data: [],
        };
      }
    } catch (error) {
      log.error("获取当日数据失败:", error);
      return { success: false, error: error.message };
    }
  },

  // 验证日期格式，防止 SOQL 注入
  _validateDate(dateStr) {
    if (!dateStr) return null;
    // 只允许 YYYY-MM-DD 格式
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(dateStr)) {
      log.warn(`日期格式无效: ${dateStr}，已忽略`);
      return null;
    }
    // 验证是否为有效日期
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      log.warn(`日期无效: ${dateStr}，已忽略`);
      return null;
    }
    return dateStr;
  },

  async getDailyData(startDate = null, endDate = null) {
    try {
      if (!this.connection) {
        return {
          success: false,
          error: "Salesforce connection not established",
        };
      }

      let dateCondition;

      // 验证并清理日期输入，防止 SOQL 注入
      const validStartDate = this._validateDate(startDate);
      const validEndDate = this._validateDate(endDate);

      if (validStartDate || validEndDate) {
        // 自定义日期范围逻辑
        if (validStartDate && validEndDate) {
          dateCondition = `order.Service_Request_Date__c >= ${validStartDate} AND order.Service_Request_Date__c <= ${validEndDate}`;
          log.info(`获取自定义日期范围数据: ${validStartDate} ~ ${validEndDate}`);
        } else if (validStartDate) {
          dateCondition = `order.Service_Request_Date__c >= ${validStartDate}`;
          log.info(`获取数据，起始日期: ${validStartDate}`);
        } else if (validEndDate) {
          dateCondition = `order.Service_Request_Date__c <= ${validEndDate}`;
          log.info(`获取数据，截止日期: ${validEndDate}`);
        }
      } else {
        // 默认逻辑
        // 使用 dayjs 获取当前日期
        const todayObj = dayjs();
        const today = todayObj.format('YYYY-MM-DD');
        const dayOfWeek = todayObj.day(); // 0 (Sunday) to 6 (Saturday)
        
        // 如果是周一 (1)，获取周六、周日和周一的数据
        if (dayOfWeek === 1) {
          const sunday = todayObj.subtract(1, 'day').format('YYYY-MM-DD');
          const saturday = todayObj.subtract(2, 'day').format('YYYY-MM-DD');
          dateCondition = `order.Service_Request_Date__c IN (${saturday}, ${sunday}, ${today})`;
          log.info(`获取周末及当日数据（周一逻辑）: ${saturday}, ${sunday}, ${today}`);
        } else {
          dateCondition = `order.Service_Request_Date__c = ${today}`;
          log.info("获取当日数据，日期:", today);
        }
      }

      let dailyQuery = `SELECT
          order.Name,
          order.OrderNumber,
          order.Order_Nature__c,
          order.Service_Request_Date__c,
          order.Attention__c,
          FulfillmentRemark__c,
          order.id,
          order.Custom_OrderStatus__c,
          order.Custom_FulfilmentStatus__c,
          FulfillmentId__c,
          AppointmentId__c,
          vlocity_cmt__FulfilmentStatus__c,
          BRM_Request_Id__c
      FROM OrderItem
      WHERE
          MainProduct__c = true AND
          LOB__c ='FixedLine' AND
          order.Custom_OrderStatus__c NOT IN (
              'Ready To Submit', 'Superseded', 'Activated',
              'Cancel Requested', 'Cancelled', 'Discarded') AND
          ${dateCondition}`;
      
      // 优化：直接获取查询结果，避免流式回调带来的额外开销
      const result = await this.connection.query(dailyQuery, { autoFetch: true, maxFetch: 99999 });
      const records = result.records || [];
      
      if (records.length > 0) {
        // 预处理数据，展平嵌套结构
        const processedRecords = flattenRecords(records);

        // 启用去重逻辑
        const removedDupeList = remove_duplicates(processedRecords);
        log.info(`当日数据获取成功，原始: ${processedRecords.length}, 去重后: ${removedDupeList.length}`);
        
        

        return {
          success: true,
          data: removedDupeList,
        };
      } else {
        return {
            success: true,
            data: [],
        };
      }
    } catch (error) {
      log.error("获取当日数据失败:", error);
      return { success: false, error: error.message };
    }
  },

  // 获取数据from 文件
  async getSFData(orderNumbers, onProgress) {
    try {
      if (!this.connection) {
        return {
          success: false,
          error: "Salesforce connection not established",
        };
      }

      if (!orderNumbers || orderNumbers.length === 0) {
        return { success: false, error: "No order numbers provided" };
      }

      const BATCH_SIZE = 500;
      let allRecords = [];

      // 分批处理
      for (let i = 0; i < orderNumbers.length; i += BATCH_SIZE) {
        const batchOrderNumbers = orderNumbers.slice(i, i + BATCH_SIZE);

        // 确保订单号正确转义，防止SQL注入
        const escapedOrderNumbers = batchOrderNumbers.map((orderNum) =>
          orderNum.replace(/'/g, "''")
        );

// SELECT order.Name, OrderId, order.OrderNatureValue__c, vlocity_cmt__OneTimeTotal__c, vlocity_cmt__AssetId__c, 
//         Resource_Availability__c, Spare_Availability__c,   vlocity_cmt__Product2Id__r.name, Custom_Action__c,  vlocity_cmt__SubscriptionId__c, 
//         vlocity_cmt__SubscriptionId__r.vlocity_cmt__Status__c, vlocity_cmt__SubscriptionId__r.BillingAccountNo__c, 
//         vlocity_cmt__SubscriptionId__r.InvoluntaryTerminated__c, order.OrderNumber, order.Order_Nature__c, order.Service_Request_Date__c,
//         order.Channel_Name__c,order.LOB__c, FulfillmentId__c, order.Self_Return__c, order.Has_Collect__c, order.KeepExistAddrSubscriptionLOB__c, AppointmentDate__c,
//         AppointmentId__c,order.Attention__c,FulfillmentRemark__c,order.Custom_OrderStatus__c,order.Custom_FulfilmentStatus__c,
//         FulfillmentDetail__c,order.Is_Voluntary__c,vlocity_cmt__FulfilmentStatus__c,Brm_Feedback_Code__c, 
//         BRM_Feedback_Error_Log__c, vlocity_cmt__OneTimeCharge__c, BRM_Request_Id__c, order.CreatedBy.name, FulfillmentAction__c, 
//         OSS_Service_Number__c, order.ServiceNumber__c, order.vlocity_cmt__OrchestrationPlanId__r.vlocity_cmt__State__c
//         FROM OrderItem WHERE

// SELECT Order.Name, Order.OrderNumber,	Order.Order_Nature__c,	
//         Order.Service_Request_Date__c,	Order.Attention__c,	Order.Id,	Order.Custom_OrderStatus__c,	
//         Order.Custom_FulfilmentStatus__c,	FulfillmentRemark__c,	FulfillmentId__c,	AppointmentId__c,	
//         vlocity_cmt__FulfilmentStatus__c,	BRM_Request_Id__c
//         FROM OrderItem WHERE


        // 构建SOQL查询，获取订单相关数据
        const soql = `SELECT order.Name, OrderId, order.OrderNatureValue__c, vlocity_cmt__OneTimeTotal__c, vlocity_cmt__AssetId__c, 
        Resource_Availability__c, Spare_Availability__c,   vlocity_cmt__Product2Id__r.name, Custom_Action__c,  vlocity_cmt__SubscriptionId__c, 
        vlocity_cmt__SubscriptionId__r.vlocity_cmt__Status__c, vlocity_cmt__SubscriptionId__r.BillingAccountNo__c, 
        vlocity_cmt__SubscriptionId__r.InvoluntaryTerminated__c, order.OrderNumber, order.Order_Nature__c, order.Service_Request_Date__c,
        order.Channel_Name__c,order.LOB__c, FulfillmentId__c, order.Self_Return__c, order.Has_Collect__c, order.KeepExistAddrSubscriptionLOB__c, AppointmentDate__c,
        AppointmentId__c,order.Attention__c,FulfillmentRemark__c,order.Custom_OrderStatus__c,order.Custom_FulfilmentStatus__c,
        FulfillmentDetail__c,order.Is_Voluntary__c,vlocity_cmt__FulfilmentStatus__c,Brm_Feedback_Code__c, 
        BRM_Feedback_Error_Log__c, vlocity_cmt__OneTimeCharge__c, BRM_Request_Id__c, order.CreatedBy.name, FulfillmentAction__c, 
        OSS_Service_Number__c, order.ServiceNumber__c, order.vlocity_cmt__OrchestrationPlanId__r.vlocity_cmt__State__c
        FROM OrderItem WHERE
        Order.ordernumber in ('${escapedOrderNumbers.join(
          "','"
        )}')`;

        const batchNum = Math.floor(i / BATCH_SIZE) + 1;
        const totalBatches = Math.ceil(orderNumbers.length / BATCH_SIZE);
        log.info(
          `正在查询数据，批次: ${batchNum}/${totalBatches}, 数量: ${
            batchOrderNumbers.length
          }`
        );
        loadingLog(`正在查询第 ${batchNum}/${totalBatches} 批次 (${batchOrderNumbers.length} 条订单)...`, "info");

        // 优化：直接获取查询结果，避免流式回调带来的额外开销
        const result = await this.connection.query(soql, { autoFetch: true });
        if (result.records && result.records.length > 0) {
          allRecords = allRecords.concat(result.records);
          if (onProgress) onProgress(allRecords.length);
        }
        log.info(`已获取${result.records.length}条记录`);
        loadingLog(`第 ${batchNum} 批次完成，已获取 ${result.records ? result.records.length : 0} 条记录`, "success");
      }
      loadingLog(`所有批次查询完成，共获取 ${allRecords.length} 条记录，正在处理...`, "info");
      
      
        // 展平数据
        const processedRecords = flattenRecords(allRecords);
        // 启用去重逻辑
        const removedDupeList = remove_duplicates(processedRecords);
        log.debug("removedDupeList: " , removedDupeList);
        // 增加额外的列，并确保它们在最前面
        const addFields = removedDupeList.map(record => {
          return {
            ...record,
            'Issue Status': '',
            'Latest Action By': '',
            'Action': '',
            'Remark': '',
            'Root Cause Category': ''
          };
        });
        log.debug("addFields: " , addFields);
        // 应用 T2 规则
        const finalRecords = applyExpiryRules(addFields);
        log.debug("finalRecords, "+ finalRecords);
        return {
          success: true,
          data: finalRecords,
        };
      
    } catch (error) {
      log.error("获取Salesforce数据失败:", error);
      return { success: false, error: error.message };
    }
  },

  async getPCDOrders(accountIds, onProgress) {
    try {
      if (!this.connection) {
        return {
          success: false,
          error: "Salesforce connection not established",
        };
      }

      if (!accountIds || accountIds.length === 0) {
        return { success: false, error: "No accountIds provided" };
      }

      const BATCH_SIZE = 600;
      let allRecords = [];

      // 分批处理
      for (let i = 0; i < accountIds.length; i += BATCH_SIZE) {
        const batchAccountIds = accountIds.slice(i, i + BATCH_SIZE);

        // 确保订单号正确转义，防止SQL注入
        const escapedOrderNumbers = batchAccountIds.map((accountId) =>
          accountId.replace(/'/g, "''")
        );

        // 构建SOQL查询，获取订单相关数据
        const soql = `SELECT order.Name, order.OrderNumber,order.Original_Salesman__r.Phone, order.id, order.Order_Nature__c, order.LOB__c, order.Custom_OrderStatus__c, order.vlocity_cmt__FulfilmentStatus__c, FulfillmentId__c,  FulfillmentRemark__c, order.Completed_Date__c, AppointmentId__c,order.Service_Request_Date__c, order.CreatedDate, order.Submitted_Date__c FROM OrderItem WHERE 
order.Custom_OrderStatus__c not in ('Activated','Cancelled','Superseded','Rejected','Amend Requested','Superseded') and
 (MainProduct__c = TRUE OR Product2.vlocity_cmt__SubType__c = 'NowTV Standalone Starter Offer') and
order.Bsn__c in ('${escapedOrderNumbers.join(
          "','"
        )}')`;

        log.info(
          `正在查询数据，批次: ${Math.floor(i / BATCH_SIZE) + 1}, 数量: ${
            batchAccountIds.length
          }`
        );

        // 优化：直接获取查询结果，避免流式回调带来的额外开销
        const result = await this.connection.query(soql, { autoFetch: true });
        if (result.records && result.records.length > 0) {
          allRecords = allRecords.concat(result.records);
          if (onProgress) onProgress(allRecords.length);
        }
        log.info(`已获取${result.records.length}条记录`);
      }
      
      if(allRecords.length>0){
        // 预处理数据，展平嵌套结构
        const processedRecords = flattenRecords(allRecords);

        // 启用去重逻辑
        const removedDupeList = remove_duplicates(processedRecords);
        
        return {
          success: true,
          data: removedDupeList,
        };
      }else{
        return {
          success: true,
          data: [],
        };
      }
    } catch (error) {
      log.error("获取Salesforce数据失败:", error);
      return { success: false, error: error.message };
    }
  },

  async getLTSOrders(ltsAccounts, onProgress) {
    try {
      if (!this.connection) {
        return {
          success: false,
          error: "Salesforce connection not established",
        };
      }

      if (!ltsAccounts || ltsAccounts.length === 0) {
        return { success: false, error: "No ltsAccounts provided" };
      }

      const BATCH_SIZE = 600;
      let allAccounts = [];

      // 获取account Ids
      // 分批处理
      for (let i = 0; i < ltsAccounts.length; i += BATCH_SIZE) {
        const batchAccountIds = ltsAccounts.slice(i, i + BATCH_SIZE);

        // 确保订单号正确转义，防止SQL注入
        const escapedOrderNumbers = batchAccountIds.map((accountId) =>
          accountId.replace(/'/g, "''")
        );

        // 构建SOQL查询，获取订单相关数据
        const soql = `select Account__c from AccountProfile__c where CustomerNo__c in ('${escapedOrderNumbers.join(
          "','"
        )}')`;
        log.info(
          `正在查询 AccountProfile__c 数据，批次: ${
            Math.floor(i / BATCH_SIZE) + 1
          }, 数量: ${batchAccountIds.length}`
        );

        // 优化：直接获取查询结果，避免流式回调带来的额外开销
        const result = await this.connection.query(soql, { autoFetch: true });
        if (result.records && result.records.length > 0) {
          allAccounts = allAccounts.concat(result.records);
        }
        log.info(`已获取${result.records.length}条 AccountProfile__c 记录`);
      }

      let allOrderItems = [];
      if (allAccounts.length > 0) {
        // 提取 Account__c ID 并去重
        const accountIds = [
          ...new Set(allAccounts.map((acc) => acc.Account__c).filter((id) => id)),
        ];
        log.info(`提取到 ${accountIds.length} 个 Account ID`);

        // 分批查询 OrderItem
        for (let i = 0; i < accountIds.length; i += BATCH_SIZE) {
          const batchIds = accountIds.slice(i, i + BATCH_SIZE);
          const escapedIds = batchIds.map((id) => id.replace(/'/g, "''"));

          const soql = `SELECT order.Name, order.OrderNumber, order.Original_Salesman__r.Phone, order.id,
                          order.Order_Nature__c, order.LOB__c, order.Custom_OrderStatus__c, order.vlocity_cmt__FulfilmentStatus__c, FulfillmentId__c, 
                          FulfillmentRemark__c, order.Completed_Date__c, AppointmentId__c, order.Service_Request_Date__c, order.CreatedDate, order.Submitted_Date__c
                          FROM OrderItem
                          WHERE MainProduct__c = TRUE
                          AND Order.AccountId IN ('${escapedIds.join("','")}')
                          AND order.Custom_OrderStatus__c not in ('Activated','Cancelled','Superseded','Rejected','Amend Requested','Superseded')`;

          log.info(
            `正在查询 OrderItem 数据，批次: ${
              Math.floor(i / BATCH_SIZE) + 1
            }, 数量: ${batchIds.length}`
          );

          const result = await this.connection.query(soql, { autoFetch: true });
          if (result.records && result.records.length > 0) {
            allOrderItems = allOrderItems.concat(result.records);
            if (onProgress) onProgress(allOrderItems.length);
          }
          log.info(`已获取${result.records.length}条 OrderItem 记录`);
        }
      }

      if (allOrderItems.length > 0) {
        // 预处理数据，展平嵌套结构
        const processedRecords = flattenRecords(allOrderItems);

        // 启用去重逻辑
        const removedDupeList = remove_duplicates(processedRecords);
  
        return {
          success: true,
          data: removedDupeList,
        };
      } else {
        return {
          success: true,
          data: [],
        };
      }
    } catch (error) {
      log.error("获取 LTS Orders 失败:", error);
      return { success: false, error: error.message };
    }
  },

  async getPCDDailyData(customQuery = null) {
    try {
      if (!this.connection) {
        return {
          success: false,
          error: "Salesforce connection not established",
        };
      }

      let dailyQuery = '';

      // 安全警告：不再接受任意自定义 SOQL 查询以防止注入攻击
      // 如果提供了自定义查询，仅记录日志并忽略，使用默认安全查询
      if (customQuery && customQuery.trim()) {
        log.warn("自定义 SOQL 查询已被禁用以防止注入攻击，使用默认安全查询");
      }

      dailyQuery = `SELECT order.Name,
          order.OrderNumber,
          order.Order_Nature__c,
          order.Service_Request_Date__c,
          order.Attention__c,
          FulfillmentRemark__c,
          order.id,
          order.Custom_OrderStatus__c,
          order.Custom_FulfilmentStatus__c,
          FulfillmentId__c,
          AppointmentId__c,
          vlocity_cmt__FulfilmentStatus__c,
          BRM_Request_Id__c,
          LOB__c,
          order.Is_Voluntary__c,
          order.Self_Return__c
      FROM OrderItem
      WHERE
          (MainProduct__c = TRUE OR Product2.vlocity_cmt__SubType__c = 'NowTV Standalone Starter Offer') AND
          LOB__c !='' AND
          order.Attention__c = '' AND
          order.Service_Request_Date__c <= TODAY AND
          order.Service_Request_Date__c > 2026-01-01 AND
          order.Custom_OrderStatus__c NOT IN (
              'Ready To Submit', 'Superseded', 'Activated',
              'Cancel Requested', 'Cancelled', 'Rejected', 'Discarded')`;

      const result = await this.connection.query(dailyQuery, { autoFetch: true, maxFetch: 99999 });
      const records = result.records || [];
      
      if (records.length > 0) {
        // 预处理数据，展平嵌套结构
        const processedRecords = flattenRecords(records);

        // 启用去重逻辑
        const removedDupeList = remove_duplicates(processedRecords);

        // 增加额外的列，并确保它们在最前面
        const addFieldList = removedDupeList.map(record => {
          return {
            'Issue Status': '',
            'Action': '',
            'Remark': '',
            'Root Cause Category': '',
            'Need Attention': '',
            'Suspected Complaint Case': '',
            ...record
          };
        });
        log.debug(addFieldList.length);

        // 应用 T2 规则
        const finalRecords = applyT2Rules(addFieldList);
        log.info(`报表数据获取成功，原始: ${processedRecords.length}, 去重后: ${removedDupeList.length}`);
        
        return {
          success: true,
          data: finalRecords,
        };
      } else {
        return {
            success: true,
            data: [],
        };
      }
    } catch (error) {
      log.error("获取 Expiry daily Data 失败:", error);
      return { success: false, error: error.message };
    }
  },

  /**
   * 获取 PCD 过期（Expired）数据。
   *
   * 与「获取报表数据」（getReportData）同构的取数流程：
   *   查询 → 展平嵌套结构 → 去重 → 补齐人工填写列 → 套业务规则 → 返回。
   *
   * 查询语句集中在模块顶部的 `PCD_EXPIRED_SOQL` 常量里（待补充正式口径）。
   * 这里刻意不吃「自定义 SOQL」入参，避免重现 getPCDDailyData 那条
   * 「界面给了输入框、服务端却为了防注入把入参丢掉」的死 UI。
   *
   * @returns {Promise<{success: boolean, data?: Array<Object>, error?: string}>}
   */
  async getPCDExpiredData() {
    try {
      if (!this.connection) {
        return {
          success: false,
          error: "Salesforce connection not established",
        };
      }

      const result = await this.connection.query(PCD_EXPIRED_SOQL, {
        autoFetch: true,
        maxFetch: 99999,
      });
      const records = result.records || [];

      if (records.length === 0) {
        return { success: true, data: [] };
      }

      // 预处理数据，展平嵌套结构
      const processedRecords = flattenRecords(records);

      // 启用去重逻辑
      const removedDupeList = remove_duplicates(processedRecords);

      // 补齐人工填写列，并确保它们在最前面（与其它 PCD 模块一致）
      const addFieldList = removedDupeList.map((record) => {
        return {
          "Issue Status": "",
          "Action": "",
          "Remark": "",
          "Root Cause Category": "",
          "Need Attention": "",
          "Suspected Complaint Case": "",
          ...record,
        };
      });

      const finalRecords = applyT2Rules(addFieldList);
      log.info(
        `PCD 过期数据获取成功，原始: ${processedRecords.length}, 去重后: ${removedDupeList.length}`
      );

      return {
        success: true,
        data: finalRecords,
      };
    } catch (error) {
      log.error("获取 PCD 过期数据失败:", error);
      return { success: false, error: error.message };
    }
  },

  async getVVIPData(pcdAccounts, ltsAccounts, onProgress) {
    try {
      if (!this.connection) {
        return {
          success: false,
          error: "Salesforce connection not established",
        };
      }

      let pcdRawCount = 0;
      let ltsRawCount = 0;

      let pcdRecordsData = [];
      if (pcdAccounts && pcdAccounts.length > 0) {
        let pcdRecords = await sfConn.getPCDOrders(pcdAccounts, (count) => {
          pcdRawCount = count;
          if (onProgress) onProgress(pcdRawCount + ltsRawCount);
        });
        if (pcdRecords.success) {
          pcdRecordsData = pcdRecords.data;
          log.info(
            "获取PCD数据成功，总计:",
            pcdRecordsData.length,
            "条记录"
          );
        } else {
          log.error("获取PCD数据失败:", pcdRecords.error);
        }
      }

      let ltsRecordsData = [];
      if (ltsAccounts && ltsAccounts.length > 0) {
        let ltsRecords = await sfConn.getLTSOrders(ltsAccounts, (count) => {
          ltsRawCount = count;
          if (onProgress) onProgress(pcdRawCount + ltsRawCount);
        });
        if (ltsRecords.success) {
          ltsRecordsData = ltsRecords.data;
          log.info(
            "获取LTS数据成功，总计:",
            ltsRecordsData.length,
            "条记录"
          );
        } else {
          log.error("获取LTS数据失败:", ltsRecords.error);
        }
      }

      let allRecords = pcdRecordsData.concat(ltsRecordsData);

      log.info("获取VVIP数据成功，总计:", allRecords.length, "条记录");

      // 再次去重，确保合并后的数据唯一
      const finalUniqueRecords = remove_duplicates(allRecords);

      return {
        success: true,
        data: finalUniqueRecords,
      };
    } catch (error) {
      log.error("获取VVIP数据失败:", error);
      return { success: false, error: error.message };
    }
  },

  /**
   * 获取 Salesforce Org 的 Limits 用量（REST Limits API）
   * GET /services/data/v{version}/limits/
   * 返回形如 { DailyApiRequests: { Max, Remaining, type }, ... } 的映射，
   * Complex 类型的条目带 Consumed 数组（按 Entity 拆分的已用量）。
   */
  async getOrgLimits() {
    try {
      if (!this.connection) {
        return { success: false, error: "Salesforce connection not established" };
      }
      const response = await this.connection.request({
        method: 'GET',
        url: `/services/data/v${defaultApiVersion}/limits/`
      });
      if (!response || typeof response !== "object") {
        return { success: false, error: "Limits 接口返回了空数据" };
      }
      return { success: true, limits: response };
    } catch (error) {
      log.error("获取 Org Limits 失败:", error);
      return { success: false, error: error.message };
    }
  },

  async createBulkQueryJob(soql) {
    try {
      if (!this.connection) {
        return { success: false, error: "Salesforce connection not established" };
      }
      const response = await this.connection.request({
        method: 'POST',
        url: `/services/data/v${defaultApiVersion}/jobs/query`,
        body: JSON.stringify({
          operation: 'query',
          query: soql
        }),
        headers: {
          'Content-Type': 'application/json'
        }
      });
      return { success: true, jobInfo: response };
    } catch (error) {
      log.error("创建 Bulk Job 失败:", error);
      return { success: false, error: error.message };
    }
  },

  async checkBulkJobStatus(jobId) {
    try {
      if (!this.connection) {
        return { success: false, error: "Salesforce connection not established" };
      }
      const response = await this.connection.request({
        method: 'GET',
        url: `/services/data/v${defaultApiVersion}/jobs/query/${jobId}`
      });
      return { success: true, jobInfo: response };
    } catch (error) {
      log.error("查询 Bulk Job 状态失败:", error);
      return { success: false, error: error.message };
    }
  },

  async getBulkJobResults(jobId) {
    try {
      if (!this.connection) {
        return { success: false, error: "Salesforce connection not established" };
      }
      
      // 分页结果用数组累积，最后一次性 join。
      // 原先写 `allCsvData += csvText`：几十 MB 的 CSV 分多页返回时，
      // 每次 += 都要重新分配并拷贝整段字符串，页数越多退化越明显（O(n²) 拷贝量）。
      const csvChunks = [];
      let locator = null;
      let isFirstPage = true;
      // 使用原生 fetch 以便获取 response headers 中的 Sforce-Locator
      //
      // ⚠️ 正因为它绕过了 `connection.request()`，就没法自动享受「401 → 换会话 →
      // 重发」的续期能力，所以下面补了一次同语义的判断（Bulk 结果动辄下载几十秒，
      // 中途会话过期却只丢一句 HTTP 401 是最难让人理解的一类失败）。
      // 顺带一提：headers 里的 token 是**每一轮现读** `this.connection.accessToken`，
      // 续期后自然就是新值。
      const sendBulkFetch = () => {
        let fetchUrl = `${this.connection.instanceUrl}/services/data/v${defaultApiVersion}/jobs/query/${jobId}/results`;
        if (locator && locator !== "null") {
          fetchUrl += `?locator=${locator}`;
        }
        return fetch(fetchUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.connection.accessToken}`,
            'Accept': 'text/csv'
          }
        });
      };

      do {
        let response = await sendBulkFetch();

        if (
          (response.status === 401 || response.status === 403) &&
          typeof this.connection.renewAuth === "function" &&
          (await this.connection.renewAuth())
        ) {
          log.warn("Bulk 结果下载遇到会话失效，已换新会话并重发该页");
          response = await sendBulkFetch();
        }

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`HTTP error! status: ${response.status}, message: ${errorText}`);
        }

        let csvText = await response.text();
        locator = response.headers.get('Sforce-Locator');

        // 对于分页数据，除了第一页，后续页面的第一行也是表头，需要去除以避免重复
        if (!isFirstPage && csvText) {
          const firstNewlineIdx = csvText.indexOf('\n');
          if (firstNewlineIdx !== -1) {
            csvText = csvText.substring(firstNewlineIdx + 1);
          }
        }

        csvChunks.push(csvText);
        isFirstPage = false;

      } while (locator && locator !== "null");

      return { success: true, csvData: csvChunks.join("") };
    } catch (error) {
      log.error("获取 Bulk Job 结果失败:", error);
      return { success: false, error: error.message };
    }
  },


  async getPCDPIDFalloutData() {
    try {
      if (!this.connection) {
        return {
          success: false,
          error: "Salesforce connection not established",
        };
      }

      const pidFalloutQuery = `SELECT Id, OrderId, 
order.name,
    order.OrderNumber,
    order.Order_Nature__c,
    order.Custom_OrderStatus__c,
    order.Custom_FulfilmentStatus__c,
    order.Fulfillment_Id_List__c,
    order.FulfillmentOrderId__c,
    order.Service_Request_Date__c,
    order.Is_Voluntary__c,
    order.LastModifiedDate,
    order.Last_Submitted_Date__c,
FulfillmentAction__c, FulfillmentSystemId__c, FulfillmentDetail__c FROM ORDERITEM WHERE 
FulfillmentId__c != null and 
OrderId  IN (SELECT ID FROM Order WHERE
    Custom_FulfilmentStatus__c = 'In Progress - Fulfillment Data Issue'
    AND Custom_OrderStatus__c NOT IN (
        'Activated',
        'Superseded',
        'Amend Requested',
        'Submitted',
        'Ready To Submit'
    )) AND FulfillmentAction__c like '%FALLOUT%' AND 
    FulfillmentSystemId__c != 'WFM' AND 
    Order.Custom_OrderStatus__c != 'Cancelled'`;
      
      const result = await this.connection.query(pidFalloutQuery, { autoFetch: true, maxFetch: 999999 });
      const records = result.records || [];
      
      if (records.length > 0) {
        // 展平 OrderItem 数据
        const flatternRecords = flattenRecords(records);
        
        // 提取 OrderId 列表（去重）
        const orderIds = [...new Set(flatternRecords.map(record => record.OrderId).filter(id => id))];
        
        if (orderIds.length > 0) {
          log.info(`提取到 ${orderIds.length} 个 Order ID`);
          
          // 构建 OrchestrationItem 查询，分批处理以避免 SOQL 长度限制
          const BATCH_SIZE = 600;
          let allOrchestrationItems = [];
          
          for (let i = 0; i < orderIds.length; i += BATCH_SIZE) {
            const batchIds = orderIds.slice(i, i + BATCH_SIZE);
            const escapedIds = batchIds.map(id => id.replace(/'/g, "''"));
            
            const orchestrationQuery = `SELECT ID, Name, vlocity_cmt__OrchestrationPlanId__r.vlocity_cmt__OrderId__c, vlocity_cmt__ExecutionLog__c 
FROM vlocity_cmt__OrchestrationItem__c 
WHERE (Name LIKE '%callout-noss%' OR Name LIKE '%callout-opg%') 
AND vlocity_cmt__OrchestrationPlanId__r.vlocity_cmt__OrderId__c IN ('${escapedIds.join("','")}')`;
            
            try {
              const orchResult = await this.connection.query(orchestrationQuery, { autoFetch: true, maxFetch: 999999 });
              if (orchResult.records && orchResult.records.length > 0) {
                allOrchestrationItems = allOrchestrationItems.concat(orchResult.records);
              }
            } catch (orchError) {
              log.error(`查询 OrchestrationItem 批次 ${Math.floor(i / BATCH_SIZE) + 1} 失败:`, orchError);
            }
          }
          
          log.info(`获取到 ${allOrchestrationItems.length} 条 OrchestrationItem 记录`);
          
          // 展平 OrchestrationItem 数据并按 OrderId 分组
          const flatOrchItems = flattenRecords(allOrchestrationItems);
          const orchItemsByOrderId = {};
          
          for (const item of flatOrchItems) {
            const orderId = item['vlocity_cmt__OrchestrationPlanId__r.vlocity_cmt__OrderId__c'];
            if (orderId) {
              if (!orchItemsByOrderId[orderId]) {
                orchItemsByOrderId[orderId] = [];
              }
              orchItemsByOrderId[orderId].push(item);
            }
          }
          
          // 将 OrchestrationItem 数据合并到 OrderItem 记录中
          const mergedRecords = flatternRecords.map(record => {
            const orderId = record.OrderId || record.Id;
            const orchItems = orchItemsByOrderId[orderId] || [];
            
            return {
              ...record,
              OrchestrationItems: orchItems,
              OrchestrationItemNames: orchItems.map(item => item.Name).join('; '),
              OrchestrationExecutionLogs: orchItems.map(item => item['vlocity_cmt__ExecutionLog__c']).filter(log => log).join('; ')
            };
          });
          
          return {
            success: true,
            data: mergedRecords,
          };
        } else {
          return {
            success: true,
            data: flatternRecords,
          };
        }
      } else {
        return {
          success: true,
          data: [],
        };
      }
    } catch (error) {
      log.error("获取 PCD PID Fallout 数据失败:", error);
      return { success: false, error: error.message };
    }
  },

  async getPCDQCIssueData() {
    try {
      if (!this.connection) {
        return {
          success: false,
          error: "Salesforce connection not established",
        };
      }

      // 第一步：查询 Order 数据
      const orderQuery = `SELECT
          ID,
          Name,
          OrderNumber,
          Order_Nature__c,
          Custom_OrderStatus__c,
          Custom_FulfilmentStatus__c,
          Fulfillment_Id_List__c,
          FulfillmentOrderId__c,
          Service_Request_Date__c,
          Is_Voluntary__c,
          LastModifiedDate,
          Last_Submitted_Date__c
      FROM
          Order
      WHERE
          Custom_FulfilmentStatus__c = 'In Progress - Fulfillment Data Issue'
          AND Custom_OrderStatus__c NOT IN (
              'Activated',
              'Superseded',
              'Amend Requested',
              'Submitted',
              'Ready To Submit'
          )
          AND Custom_OrderStatus__c != 'Cancelled'
      ORDER BY
          Last_Submitted_Date__c ASC`;
      
      const orderResult = await this.connection.query(orderQuery, { autoFetch: true, maxFetch: 999999 });
      const orderRecords = orderResult.records || [];
      
      if (orderRecords.length === 0) {
        return {
          success: true,
          data: [],
        };
      }
      
      log.info(`获取到 ${orderRecords.length} 条 Order 记录`);
      
      // 展平 Order 数据
      const flatOrderRecords = flattenRecords(orderRecords);
      
      // 提取 Order ID 列表
      const orderIds = flatOrderRecords.map(record => record.Id).filter(id => id);
      
      if (orderIds.length === 0) {
        return {
          success: true,
          data: flatOrderRecords,
        };
      }
      
      log.info(`提取到 ${orderIds.length} 个 Order ID`);
      
      // 第二步：查询 OrchestrationItem 数据，分批处理
      const BATCH_SIZE = 600;
      let allOrchestrationItems = [];
      
      for (let i = 0; i < orderIds.length; i += BATCH_SIZE) {
        const batchIds = orderIds.slice(i, i + BATCH_SIZE);
        const escapedIds = batchIds.map(id => id.replace(/'/g, "''"));
        
        const orchestrationQuery = `SELECT ID, Name, vlocity_cmt__OrchestrationPlanId__r.vlocity_cmt__OrderId__c, vlocity_cmt__ExecutionLog__c 
FROM vlocity_cmt__OrchestrationItem__c 
WHERE (Name LIKE '%callout-noss%' OR Name LIKE '%callout-opg%') 
AND vlocity_cmt__OrchestrationPlanId__r.vlocity_cmt__OrderId__c IN ('${escapedIds.join("','")}')`;
        
        try {
          const orchResult = await this.connection.query(orchestrationQuery, { autoFetch: true, maxFetch: 999999 });
          if (orchResult.records && orchResult.records.length > 0) {
            allOrchestrationItems = allOrchestrationItems.concat(orchResult.records);
          }
        } catch (orchError) {
          log.error(`查询 OrchestrationItem 批次 ${Math.floor(i / BATCH_SIZE) + 1} 失败:`, orchError);
        }
      }
      
      log.info(`获取到 ${allOrchestrationItems.length} 条 OrchestrationItem 记录`);
      
      // 展平 OrchestrationItem 数据并按 OrderId 分组
      const flatOrchItems = flattenRecords(allOrchestrationItems);
      const orchItemsByOrderId = {};
      
      for (const item of flatOrchItems) {
        const orderId = item['vlocity_cmt__OrchestrationPlanId__r.vlocity_cmt__OrderId__c'];
        if (orderId) {
          if (!orchItemsByOrderId[orderId]) {
            orchItemsByOrderId[orderId] = [];
          }
          orchItemsByOrderId[orderId].push(item);
        }
      }
      
      // 第三步：将 OrchestrationItem 数据合并到 Order 记录中
      const mergedRecords = flatOrderRecords.map(record => {
        const orderId = record.Id;
        const orchItems = orchItemsByOrderId[orderId] || [];
        
        return {
          ...record,
          OrchestrationItems: orchItems,
          OrchestrationItemNames: orchItems.map(item => item.Name).join('; '),
          OrchestrationExecutionLogs: orchItems.map(item => item['vlocity_cmt__ExecutionLog__c']).filter(log => log).join('; ')
        };
      });
      
      return {
        success: true,
        data: mergedRecords,
      };
    } catch (error) {
      log.error("获取 PCD QC Issue 数据失败:", error);
      return { success: false, error: error.message };
    }
  },

  /**
   * 获取所有正在运行的 Bulk Query Job
   * 使用 Bulk API 2.0 的 jobs/query 端点来查询所有任务
   */
  /**
   * 列出 Bulk API 2.0 的 **查询型** job（`GET /jobs/query`）。
   *
   * 注意：这里必须打 `/jobs/query`，不是 `/jobs/ingest`。
   * 本扩展的 Bulk 功能（createBulkQueryJob / checkBulkJobStatus / getBulkJobResults）
   * 全部走 `/jobs/query`，而列表要展示的字段（query / numberOfRecordsProcessed /
   * totalProcessingTime）也都是 query job 的字段。
   * 之前误写成 `/jobs/ingest/`，列表永远是空的 —— 这也是它一直没被接线的根因。
   */
  async getAllBulkQueryJobs() {
    try {
      if (!this.connection) {
        return { success: false, error: "Salesforce connection not established" };
      }

      const response = await this.connection.request({
        method: 'GET',
        url: `/services/data/v${defaultApiVersion}/jobs/query`
      });

      // 列表接口返回 { done, records: [...] }，也兼容直接返回数组的情况
      const jobs = response && Object.prototype.hasOwnProperty.call(response, 'records')
        ? response.records
        : (Array.isArray(response) ? response : []);

      return { success: true, jobs: jobs };
    } catch (error) {
      log.error("获取全部 Bulk 查询任务失败:", error);
      return { success: false, error: error.message };
    }
  },

  // ---------- org 结构（给输入框里的代码提示用）----------
  //
  // Apex 编辑器与 SOQL 查询框都要"当前 org 里有哪些对象 / 某个对象有哪些字段"。
  // 两处共用这两个方法，缓存也放在这一层（进程内）：
  //   · describeGlobal 在几千对象的 org 上也就是一次请求 —— 但没必要每敲一个字都发；
  //   · 字段按对象缓存。
  // **失败一律落空值（不重试、不抛）**：提示功能不该因为取不到 org 结构就用不了，
  // 调用方拿不到东西时继续用静态词表兜底。

  /** sObject 名清单 → `{ names: string[], fromOrg: boolean }` */
  async listSObjectNames() {
    if (this._sobjectNames) return this._sobjectNames;
    if (!this.connection) return { names: [], fromOrg: false };
    try {
      const res = await this.describeGlobal();
      const names = ((res && res.sobjects) || []).map((s) => s && s.name).filter(Boolean);
      this._sobjectNames = { names, fromOrg: true };
      log.info(`代码提示：已从 org 取到 ${names.length} 个 sObject 名`);
    } catch (e) {
      this._sobjectNames = { names: [], fromOrg: false };
      log.warn("代码提示：取 sObject 名清单失败（继续用静态词表）:", e && e.message);
    }
    return this._sobjectNames;
  },

  /** 某个对象的字段名清单（拿不到给空数组，也会被缓存下来免得反复重试） */
  async listObjectFields(objectName) {
    if (!objectName) return [];
    if (!this._objectFields) this._objectFields = new Map();
    if (this._objectFields.has(objectName)) return this._objectFields.get(objectName);
    if (!this.connection) return [];
    try {
      const res = await this.connection.sobject(objectName).describe();
      const names = ((res && res.fields) || []).map((f) => f && f.name).filter(Boolean);
      this._objectFields.set(objectName, names);
      log.info(`代码提示：已取到 ${objectName} 的 ${names.length} 个字段`);
      return names;
    } catch (e) {
      log.warn(`代码提示：取 ${objectName} 的字段失败:`, e && e.message);
      // 缓存空数组：同一个对象不再反复请求（提示继续用静态兜底）
      this._objectFields.set(objectName, []);
      return [];
    }
  },

  /** 换 org / 断开时清掉结构缓存（否则提示会给出上一个 org 的字段） */
  clearSchemaCache() {
    this._sobjectNames = null;
    this._objectFields = null;
  },

  // ---------- Execute Anonymous + 自动取本次执行的日志 ----------
  //
  // 完整链路四步（每一步的"为什么"见 common/apex_log.js 的文件头）：
  //   ① 确保当前用户有一条未过期的 TraceFlag —— **没有它，org 根本不产生 ApexLog 记录**，
  //      "自动取日志"就是一条永远查不到东西的空链路（旧实现卡在这一步：只回一句 No debug logs found）
  //   ② 记下执行前最新一条 ApexLog 的 Id
  //   ③ 执行，轮询最新日志直到 Id 与 ② 不同 —— 那条才是本次执行的（不用时间比：服务端与本机时钟有偏差）
  //   ④ 取它的 Body（必须走 `/tooling/`，旧实现漏了这段前缀）
  //
  // ①③④ 任一步失败都**不影响代码本身执行**：日志是附加信息，不能因为取不到日志让用户
  // 以为"代码没跑起来"。失败原因原样带回，由界面分档显示。

  /** Tooling API 的 SOQL 查询（ApexLog / TraceFlag / DebugLevel 只在这里能查） */
  async toolingQuery(soql) {
    return this.connection.request({
      method: "GET",
      url: `/services/data/v${defaultApiVersion}/tooling/query?q=${encodeURIComponent(soql)}`
    });
  },

  /** Tooling API 建记录（返回 `{id, success, errors}`） */
  async toolingCreate(objectName, payload) {
    return this.connection.request({
      method: "POST",
      url: `/services/data/v${defaultApiVersion}/tooling/sobjects/${objectName}`,
      body: payload
    });
  },

  /** Tooling API 改记录 */
  async toolingUpdate(objectName, id, payload) {
    return this.connection.request({
      method: "PATCH",
      url: `/services/data/v${defaultApiVersion}/tooling/sobjects/${objectName}/${id}`,
      body: payload
    });
  },

  /** 当前用户的 15/18 位 Id（TraceFlag 的 TracedEntityId 需要它） */
  async currentUserId() {
    if (userInfo && userInfo.user_id) return userInfo.user_id;
    try {
      const info = await this.connection.identity();
      return (info && info.user_id) || null;
    } catch (e) {
      return null;
    }
  },

  /**
   * 保证当前用户有一条可用的 TraceFlag（三种成功形态：复用 / 续期 / 新建）。
   * 失败时带着原因返回 `{ok:false}`，调用方照常执行代码。
   */
  async ensureApexTraceFlag() {
    if (!this.connection) return { ok: false, error: "尚未连接 Salesforce" };
    const userId = await this.currentUserId();
    if (!userId) return { ok: false, error: "拿不到当前用户 Id（identity 接口没返回）" };

    let flags = [];
    try {
      const res = await this.toolingQuery(apexLog.traceFlagSoql(userId));
      flags = (res && res.records) || [];
    } catch (e) {
      return { ok: false, error: `查询 TraceFlag 失败：${e.message}` };
    }

    const active = apexLog.pickActiveTraceFlag(flags);
    if (active) return { ok: true, status: "reused", traceFlag: active };

    let level;
    try {
      level = await this.ensureDebugLevel();
    } catch (e) {
      return { ok: false, error: `准备 DebugLevel 失败：${e.message}` };
    }

    const expired = apexLog.pickExpiredTraceFlag(flags);
    try {
      if (expired) {
        // 续期而不是再建一条：一个用户同类型的跟踪通常只能存在一条，直接建会 FIELD_INTEGRITY_EXCEPTION
        await this.toolingUpdate("TraceFlag", expired.Id, apexLog.traceFlagRenewPayload(level.Id));
        return { ok: true, status: "renewed", traceFlag: { ...expired, DebugLevelId: level.Id } };
      }
      const created = await this.toolingCreate(
        "TraceFlag",
        apexLog.traceFlagPayload(userId, level.Id)
      );
      return { ok: true, status: "created", traceFlag: { Id: created && created.id, DebugLevelId: level.Id } };
    } catch (e) {
      return {
        ok: false,
        error:
          `${e.message}（多半是权限不足，或本用户的跟踪数量已达上限 —— ` +
          `可到 Setup → Debug Logs 里删掉旧的跟踪再试）`
      };
    }
  },

  /** 取（或建）一套调试级别：优先复用 org 自带的 `SFDC_DevConsole`，避免在客户 org 里多建记录 */
  async ensureDebugLevel() {
    const tryFind = async (name) => {
      const res = await this.toolingQuery(apexLog.debugLevelSoql(name));
      return (res && res.records && res.records[0]) || null;
    };
    const builtin = await tryFind("SFDC_DevConsole");
    if (builtin && builtin.Id) return builtin;
    const mine = await tryFind(apexLog.DEBUG_LEVEL_NAME);
    if (mine && mine.Id) return mine;
    const created = await this.toolingCreate("DebugLevel", apexLog.debugLevelPayload());
    return { Id: created && created.id };
  },

  /** 当前用户最新一条 ApexLog 的 Id（执行前的基线） */
  async newestApexLogId(userId) {
    const res = await this.toolingQuery(apexLog.apexLogSoql(userId, 1));
    const first = res && res.records && res.records[0];
    return first ? first.Id : null;
  },

  /** 等「本次执行」那条日志出现（判据：Id 与执行前不同），超时返回 null */
  async waitForNewApexLog(userId, beforeId) {
    const deadline = Date.now() + apexLog.LOG_POLL_TIMEOUT_MS;
    for (;;) {
      const res = await this.toolingQuery(apexLog.apexLogSoql(userId, 5));
      const hit = apexLog.pickNewestLog(res && res.records, beforeId);
      if (hit) return hit;
      if (Date.now() >= deadline) return null;
      await new Promise((r) => setTimeout(r, apexLog.LOG_POLL_INTERVAL_MS));
    }
  },

  /**
   * 取日志正文（**完整**，不截断）。
   *
   * 为什么在这一层不截断：View Log 要拿整份日志做分析 —— 截掉尾巴会让统计数字与调用树
   * 都不完整（而且那种缺失在界面上看不出来）。要不要截断由**展示方**决定：
   * Execute Anonymous 那边用 `apex_log.normalizeLogBody(text, LOG_BODY_DISPLAY_LIMIT)` 再截一次。
   *
   * ⚠️ 路径必须带 `tooling/`：ApexLog 的 Body 子资源只在 Tooling API 上提供。
   * 旧实现写成了 `/services/data/vXX/sobjects/ApexLog/{id}/Body`（漏了 `tooling/`），
   * 真机会 404 —— 只是那条路一直被"查不到日志"挡在前面，从没走到过。
   */
  async getApexLogBody(logId) {
    const raw = await this.connection.request({
      method: "GET",
      url: `/services/data/v${defaultApiVersion}/tooling/sobjects/ApexLog/${logId}/Body`
    });
    return apexLog.normalizeLogBody(raw, 0);
  },

  /**
   * 执行匿名 Apex，并自动带回**本次执行**的日志。
   *
   * @returns {{success:boolean, result?:object, trace?:object, logRecord?:object|null,
   *            logBody?:{text:string,truncated:boolean,bytes:number}|null,
   *            logError?:string|null, error?:string}}
   */
  async executeAnonymous(apexCode) {
    try {
      if (!this.connection) {
        return { success: false, error: "Salesforce connection not established" };
      }

      // ① 日志跟踪（失败不阻断执行）
      const trace = await this.ensureApexTraceFlag();
      const userId = trace.ok ? await this.currentUserId() : null;

      // ② 执行前基线
      let beforeLogId = null;
      if (trace.ok && userId) {
        try {
          beforeLogId = await this.newestApexLogId(userId);
        } catch (e) {
          log.warn("读取执行前最新日志 Id 失败（不影响执行）:", e && e.message);
        }
      }

      // ③ 执行
      const executeResponse = await this.runAnonymousCode(apexCode);

      // ④ 等本次的日志 + 取正文
      let logRecord = null;
      let logBody = null;
      let logError = null;
      if (trace.ok && userId) {
        try {
          logRecord = await this.waitForNewApexLog(userId, beforeLogId);
          if (logRecord) logBody = await this.getApexLogBody(logRecord.Id);
        } catch (e) {
          logError = e.message;
        }
      }

      return { success: true, result: executeResponse, trace, logRecord, logBody, logError };
    } catch (error) {
      log.error("执行 Execute Anonymous 失败:", error);
      return { success: false, error: error.message };
    }
  },

  /**
   * 真正发执行请求。
   *
   * 首选 **POST + 表单体**：`anonymousBody` 放 query string 会受 URL 长度限制
   * （稍长的脚本就 414 URI Too Long），而官方文档里 executeAnonymous 支持 POST 表单参数。
   * 只在**HTTP 层失败**时回退 GET（历史实现的形式，已验证可用）—— 代码本身的编译错误是
   * `200 + compiled:false`，不会走到这里。这样既拿回长代码能力，又不赌 POST 一定被支持。
   */
  async runAnonymousCode(apexCode) {
    const path = `/services/data/v${defaultApiVersion}/tooling/executeAnonymous/`;
    try {
      return await this.connection.request({
        method: "POST",
        url: path,
        body: `anonymousBody=${encodeURIComponent(apexCode)}`,
        headers: { "Content-Type": "application/x-www-form-urlencoded" }
      });
    } catch (e) {
      log.warn("executeAnonymous POST 未成功，回退 GET:", e && e.message);
      return await this.connection.request({
        method: "GET",
        url: `${path}?anonymousBody=${encodeURIComponent(apexCode)}`
      });
    }
  },

  // 说明：原先这里还有 `getLatestDebugLog()` / `getDebugLogDetail()` 两个方法，已删除 ——
  // 前者查的是「当前用户最新一条日志」，**不是本次执行的那条**（可能是别的操作或系统批处理留下的），
  // 而且它把 Body 端点写成了 `/services/data/vXX/sobjects/ApexLog/{id}/Body`（漏了 `tooling/`，
  // 真机 404）；后者只被前者调用。整条链路现在由 executeAnonymous + 上面那几个方法接管。


};
