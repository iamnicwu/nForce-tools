/* eslint-disable no-unused-vars */
import { flattenRecords, remove_duplicates } from "../common/utils.js";
import { applyExpiryRules, applyT2Rules } from "../common/t2rules.js";

export let defaultApiVersion = "65.0";
export let globalConn = null;
export let userInfo = null;
export let sfConn = {
  connection: null,
  

  async testConnection(session_id, instanceUrl) {
    try {
      console.log("instanceUrl", instanceUrl);
      let finalInstanceUrl = instanceUrl;
      
      // 如果没有传入 instanceUrl，尝试从 localStorage 获取
      if (!finalInstanceUrl) {
        finalInstanceUrl = localStorage.getItem("sf_instance_url");
      }
      
      // 如果仍然没有，使用默认的 here2serve 实例
      if (!finalInstanceUrl) {
        finalInstanceUrl = "https://here2serve.my.salesforce.com";
        console.log("No instanceUrl provided or found in storage, using default:", finalInstanceUrl);
      } else {
        console.log("Using instanceUrl from session:", finalInstanceUrl);
      }

      if (finalInstanceUrl === "https://here2serve.lightning.force.com") {
        finalInstanceUrl = "https://here2serve.my.salesforce.com";
      }
      const conn = new jsforce.Connection({
        instanceUrl: finalInstanceUrl,
        serverUrl: `${finalInstanceUrl}/services/Soap/u/${defaultApiVersion}`,
        sessionId: session_id,
        version: defaultApiVersion,
      });

      // Get user identity info
      userInfo = await conn.identity();
      console.log("abc: ", conn);
      console.log("User info:", userInfo);
      // 保存连接对象
      this.connection = conn;
      globalConn = conn;
      return true;
    } catch (err) {
      console.error("Error:", err);
      this.connection = null;
      return false;
    }
  },

  async getUserInfo() {
    try {
      return { success: true, userInfo };
    } catch (error) {
      console.error("Error getting user info:", error);
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
      console.error("Error getting org info:", error);
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
        console.log(`Using custom days: fetching T2 data for next ${nextNDays} days.`);
      } else {
        console.log(`Today is day ${dayOfWeek}, fetching T2 data for next ${nextNDays} days.`);
        // 如果是周五 (5)，查询未来3天的数据（覆盖周六、周日、周一）
        // if (dayOfWeek === 5) {
        //   nextNDays = 3;
        //   console.log("Today is Friday, fetching T2 data for next 3 days.");
        // } else {
        //   console.log(`Today is day ${dayOfWeek}, fetching T2 data for next 2 days.`);
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
      const result = await this.connection.query(dailyQuery, { autoFetch: true, maxFetch: 99999 });
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

        console.log(`报表数据获取成功，原始: ${processedRecords.length}, 去重后: ${filteredRecords.length}`);
        
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
      console.error("获取当日数据失败:", error);
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
          order.Service_Request_Date__c > 2026-01-01 AND
          order.Custom_OrderStatus__c NOT IN (
              'Ready To Submit', 'Superseded', 'Activated',
              'Cancel Requested', 'Cancelled', 'Rejected', 'Discarded')`;
      
      // 优化：直接获取查询结果，避免流式回调带来的额外开销
      const result = await this.connection.query(dailyQuery, { autoFetch: true, maxFetch: 9999 });
      const records = result.records || [];
      
      if (records.length > 0) {
        // 预处理数据，展平嵌套结构
        const processedRecords = flattenRecords(records);

        // 启用去重逻辑
        const removedDupeList = remove_duplicates(processedRecords);
        console.log(`报表数据获取成功，原始: ${processedRecords.length}, 去重后: ${removedDupeList.length}`);
        
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
      console.error("获取当日数据失败:", error);
      return { success: false, error: error.message };
    }
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

      if (startDate || endDate) {
        // 自定义日期范围逻辑
        if (startDate && endDate) {
          dateCondition = `order.Service_Request_Date__c >= ${startDate} AND order.Service_Request_Date__c <= ${endDate}`;
          console.log(`Fetching data for custom range: ${startDate} to ${endDate}`);
        } else if (startDate) {
          dateCondition = `order.Service_Request_Date__c >= ${startDate}`;
          console.log(`Fetching data from: ${startDate}`);
        } else if (endDate) {
          dateCondition = `order.Service_Request_Date__c <= ${endDate}`;
          console.log(`Fetching data until: ${endDate}`);
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
          console.log(`Fetching data for dates: ${saturday}, ${sunday}, ${today} (Monday logic)`);
        } else {
          dateCondition = `order.Service_Request_Date__c = ${today}`;
          console.log("Fetching data for date:", today);
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
      const result = await this.connection.query(dailyQuery, { autoFetch: true, maxFetch: 9999 });
      const records = result.records || [];
      
      if (records.length > 0) {
        // 预处理数据，展平嵌套结构
        const processedRecords = flattenRecords(records);

        // 启用去重逻辑
        const removedDupeList = remove_duplicates(processedRecords);
        console.log(`当日数据获取成功，原始: ${processedRecords.length}, 去重后: ${removedDupeList.length}`);
        
        

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
      console.error("获取当日数据失败:", error);
      return { success: false, error: error.message };
    }
  },
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

      const BATCH_SIZE = 600;
      let allRecords = [];

      // 分批处理
      for (let i = 0; i < orderNumbers.length; i += BATCH_SIZE) {
        const batchOrderNumbers = orderNumbers.slice(i, i + BATCH_SIZE);

        // 确保订单号正确转义，防止SQL注入
        const escapedOrderNumbers = batchOrderNumbers.map((orderNum) =>
          orderNum.replace(/'/g, "''")
        );

        // 构建SOQL查询，获取订单相关数据
        const soql = `select order.Name,order.OrderNumber,order.Order_Nature__c,order.Service_Request_Date__c,
        order.Attention__c,FulfillmentRemark__c,order.id,order.Custom_OrderStatus__c,
        order.Custom_FulfilmentStatus__c,FulfillmentId__c,AppointmentId__c,vlocity_cmt__FulfilmentStatus__c,
        BRM_Request_Id__c from OrderItem where 
        MainProduct__c = true AND
        LOB__c ='FixedLine' AND
        order.OrderNumber in ('${escapedOrderNumbers.join(
          "','"
        )}')`;

        console.log(
          `正在查询数据，批次: ${Math.floor(i / BATCH_SIZE) + 1}, 数量: ${
            batchOrderNumbers.length
          }`
        );

        // 优化：直接获取查询结果，避免流式回调带来的额外开销
        const result = await this.connection.query(soql, { autoFetch: true });
        if (result.records && result.records.length > 0) {
          allRecords = allRecords.concat(result.records);
          if (onProgress) onProgress(allRecords.length);
        }
        console.log(`已获取${result.records.length}条记录`);
      }

      // 展平数据
      const processedRecords = flattenRecords(allRecords);

      // 启用去重逻辑
      const removedDupeList = remove_duplicates(processedRecords);
      
      return {
        success: true,
        salesforceData: removedDupeList,
      };
    } catch (error) {
      console.error("获取Salesforce数据失败:", error);
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

        console.log(
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
        console.log(`已获取${result.records.length}条记录`);
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
      console.error("获取Salesforce数据失败:", error);
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
        console.log(
          `正在查询 AccountProfile__c 数据，批次: ${
            Math.floor(i / BATCH_SIZE) + 1
          }, 数量: ${batchAccountIds.length}`
        );

        // 优化：直接获取查询结果，避免流式回调带来的额外开销
        const result = await this.connection.query(soql, { autoFetch: true });
        if (result.records && result.records.length > 0) {
          allAccounts = allAccounts.concat(result.records);
        }
        console.log(`已获取${result.records.length}条 AccountProfile__c 记录`);
      }

      let allOrderItems = [];
      if (allAccounts.length > 0) {
        // 提取 Account__c ID 并去重
        const accountIds = [
          ...new Set(allAccounts.map((acc) => acc.Account__c).filter((id) => id)),
        ];
        console.log(`提取到 ${accountIds.length} 个 Account ID`);

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

          console.log(
            `正在查询 OrderItem 数据，批次: ${
              Math.floor(i / BATCH_SIZE) + 1
            }, 数量: ${batchIds.length}`
          );

          const result = await this.connection.query(soql, { autoFetch: true });
          if (result.records && result.records.length > 0) {
            allOrderItems = allOrderItems.concat(result.records);
            if (onProgress) onProgress(allOrderItems.length);
          }
          console.log(`已获取${result.records.length}条 OrderItem 记录`);
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
      console.error("获取 LTS Orders 失败:", error);
      return { success: false, error: error.message };
    }
  },

  async getPCDDailyData(startDate = null, endDate = null) {
    try {
      if (!this.connection) {
        return {
          success: false,
          error: "Salesforce connection not established",
        };
      }

      let records = [];
      let PCDExpiry = [];
      let LTSExpiry = [];
      
      let ltsRecords = await this.getLTSExpiryData();
      console.log(
        "获取LTS数据开始", ltsRecords.length
      );
      if (ltsRecords.success) {
        LTSExpiry = ltsRecords.data;
        console.log(
          "获取LTS数据成功，总计:",
          LTSExpiry.length,
          "条记录"
        );
      } else {
        console.error("获取LTS数据失败:", ltsRecords.error);
      }

      let pcdRecords = await this.getPCDExpiryData();
      console.log(
        "获取PCD数据开始", pcdRecords.length
      );
      if (pcdRecords.success) {
        PCDExpiry = pcdRecords.data;
        console.log(
          "获取PCD数据成功，总计:",
          PCDExpiry.length,
          "条记录"
        );
      } else {
        console.error("获取PCD数据失败:", pcdRecords.error);
      }
      
      records = [...PCDExpiry, ...LTSExpiry];
      console.log(
        "获取数据成功，总计:",
        records.length,
        "条记录"
      );

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
        console.log(addFieldList.length);

        // 应用 T2 规则
        const finalRecords = applyT2Rules(addFieldList);
        console.log(`报表数据获取成功，原始: ${processedRecords.length}, 去重后: ${removedDupeList.length}`);
        
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
      console.error("获取 Expiry daily Data 失败:", error);
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
          console.log(
            "获取PCD数据成功，总计:",
            pcdRecordsData.length,
            "条记录"
          );
        } else {
          console.error("获取PCD数据失败:", pcdRecords.error);
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
          console.log(
            "获取LTS数据成功，总计:",
            ltsRecordsData.length,
            "条记录"
          );
        } else {
          console.error("获取LTS数据失败:", ltsRecords.error);
        }
      }

      let allRecords = pcdRecordsData.concat(ltsRecordsData);

      console.log("获取VVIP数据成功，总计:", allRecords.length, "条记录");

      // 再次去重，确保合并后的数据唯一
      const finalUniqueRecords = remove_duplicates(allRecords);

      return {
        success: true,
        data: finalUniqueRecords,
      };
    } catch (error) {
      console.error("获取VVIP数据失败:", error);
      return { success: false, error: error.message };
    }
  },

  async getLTSExpiryData() {
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
FROM
    OrderItem
WHERE
    order.RecordType.name = 'Consumer Fixed'
    AND order.LOB__c = 'Fixedline'
    AND MainProduct__c = true
    AND (
        order.Custom_FulfilmentStatus__c IN (
            'Address Under Review',
            'Address Approval',
            'Address Rejected',
            'Number Investigation',
            'DN Inventory Ready',
            'Waiting for Inventory'
        )
        OR order.Custom_OrderStatus__c IN ('In Progress-Fulfilment Completed', 'In Progress')
    )
    AND order.Service_Request_Date__c >= 2025-07-01 AND 
order.Service_Request_Date__c < TODAY`;
      
      const result = await this.connection.query(dailyQuery, { autoFetch: true, maxFetch: 9999 });
      const records = result.records || [];
      
      if (records.length > 0) {
        return {
          success: true,
          data: records,
        };
      } else {
        return {
            success: true,
            data: [],
        };
      }
    } catch (error) {
      console.error("获取 LTS expiry 当日数据失败:", error);
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
      console.error("Create Bulk Job Error:", error);
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
      console.error("Check Bulk Job Status Error:", error);
      return { success: false, error: error.message };
    }
  },

  async getBulkJobResults(jobId) {
    try {
      if (!this.connection) {
        return { success: false, error: "Salesforce connection not established" };
      }
      
      let allCsvData = "";
      let locator = null;
      let isFirstPage = true;
      
      // 使用原生 fetch 以便获取 response headers 中的 Sforce-Locator
      do {
        let fetchUrl = `${this.connection.instanceUrl}/services/data/v${defaultApiVersion}/jobs/query/${jobId}/results`;
        if (locator && locator !== "null") {
          fetchUrl += `?locator=${locator}`;
        }

        const response = await fetch(fetchUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${this.connection.accessToken}`,
            'Accept': 'text/csv'
          }
        });

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

        allCsvData += csvText;
        isFirstPage = false;

      } while (locator && locator !== "null");

      return { success: true, csvData: allCsvData };
    } catch (error) {
      console.error("Get Bulk Job Results Error:", error);
      return { success: false, error: error.message };
    }
  },

  async getPCDExpiryData() {
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
          order.RecordType.name = 'Consumer Fixed' AND
          MainProduct__c = true AND
          LOB__c in ('Broadband','NowTV') AND
          order.Channel_Owner__c = 'BU_MOB' AND
          order.Custom_OrderStatus__c NOT IN (
              'Ready To Submit', 'Superseded', 'Activated', 'Cancelled', 'Discarded') AND
          order.Service_Request_Date__c >= 2025-10-01 AND 
order.Service_Request_Date__c < TODAY`;
      
      const result = await this.connection.query(dailyQuery, { autoFetch: true, maxFetch: 9999 });
      const records = result.records || [];
      
      if (records.length > 0) {
        return {
          success: true,
          data: records,
        };
      } else {
        return {
            success: true,
            data: [],
        };
      }
    } catch (error) {
      console.error("获取 PCD expiry 当日数据失败:", error);
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
      
      const result = await this.connection.query(pidFalloutQuery, { autoFetch: true, maxFetch: 99999 });
      const records = result.records || [];
      
      if (records.length > 0) {
        // 展平 OrderItem 数据
        const flatternRecords = flattenRecords(records);
        
        // 提取 OrderId 列表（去重）
        const orderIds = [...new Set(flatternRecords.map(record => record.OrderId).filter(id => id))];
        
        if (orderIds.length > 0) {
          console.log(`提取到 ${orderIds.length} 个 Order ID`);
          
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
              const orchResult = await this.connection.query(orchestrationQuery, { autoFetch: true, maxFetch: 99999 });
              if (orchResult.records && orchResult.records.length > 0) {
                allOrchestrationItems = allOrchestrationItems.concat(orchResult.records);
              }
            } catch (orchError) {
              console.error(`查询 OrchestrationItem 批次 ${Math.floor(i / BATCH_SIZE) + 1} 失败:`, orchError);
            }
          }
          
          console.log(`获取到 ${allOrchestrationItems.length} 条 OrchestrationItem 记录`);
          
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
      console.error("获取 PCD PID Fallout 数据失败:", error);
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
      
      const orderResult = await this.connection.query(orderQuery, { autoFetch: true, maxFetch: 99999 });
      const orderRecords = orderResult.records || [];
      
      if (orderRecords.length === 0) {
        return {
          success: true,
          data: [],
        };
      }
      
      console.log(`获取到 ${orderRecords.length} 条 Order 记录`);
      
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
      
      console.log(`提取到 ${orderIds.length} 个 Order ID`);
      
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
          const orchResult = await this.connection.query(orchestrationQuery, { autoFetch: true, maxFetch: 99999 });
          if (orchResult.records && orchResult.records.length > 0) {
            allOrchestrationItems = allOrchestrationItems.concat(orchResult.records);
          }
        } catch (orchError) {
          console.error(`查询 OrchestrationItem 批次 ${Math.floor(i / BATCH_SIZE) + 1} 失败:`, orchError);
        }
      }
      
      console.log(`获取到 ${allOrchestrationItems.length} 条 OrchestrationItem 记录`);
      
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
      console.error("获取 PCD QC Issue 数据失败:", error);
      return { success: false, error: error.message };
    }
  },

  /**
   * 获取所有正在运行的 Bulk Query Job
   * 使用 Bulk API 2.0 的 jobs/query 端点来查询所有任务
   */
  async getAllBulkQueryJobs() {
    try {
      if (!this.connection) {
        return { success: false, error: "Salesforce connection not established" };
      }
      
      const response = await this.connection.request({
        method: 'GET',
        url: `/services/data/v${defaultApiVersion}/jobs/ingest/`
      });
      
      // 解析响应，可能包含 totalAPiUsage等统计信息
      const jobs = response.hasOwnProperty('records') ? response.records : (Array.isArray(response) ? response : []);
      
      return { success: true, jobs: jobs };
    } catch (error) {
      console.error("Get All Bulk Query Jobs Error:", error);
      return { success: false, error: error.message };
    }
  },

  /**
   * 执行 Anonymous Apex 代码
   * 使用 Tooling API 的 executeAnonymous 端点通过 HTTPS callout
   * 执行完成后自动获取当前执行的日志详情
   */
  async executeAnonymous(apexCode) {
    try {
      if (!this.connection) {
        return { success: false, error: "Salesforce connection not established" };
      }

      // 1. 执行 Execute Anonymous
      // apex 代码需要进行 URL encoding 并作为查询参数传递
      const encodedApexCode = encodeURIComponent(apexCode);
      const executeResponse = await this.connection.request({
        method: 'GET',
        url: `/services/data/v${defaultApiVersion}/tooling/executeAnonymous/?anonymousBody=${encodedApexCode}`
      });

      console.log("Execute Anonymous Response:", executeResponse);

      // 2. 如果执行成功且有 compiled bytecode 或 success 为 true，自动获取日志详情
      let logDetails = null;
      if (executeResponse && executeResponse.success) {
        // 获取当前用户的最新日志
        logDetails = await this.getLatestDebugLog();
        console.log("Debug Log Details: ", logDetails);
      }

      return {
        success: true,
        result: executeResponse,
        logDetails: logDetails
      };
    } catch (error) {
      console.error("Execute Anonymous Error:", error);
      return { success: false, error: error.message };
    }
  },

  /**
   * 获取当前用户最新的 Debug Log 详情
   * 先查询最新日志 ID，再调用 getDebugLogDetail 获取详细信息
   */
  async getLatestDebugLog(limit = 1) {
    try {
      if (!this.connection) {
        return { success: false, error: "Salesforce connection not established" };
      }

      // 查询当前用户最新的日志，按 LastModifiedDate 降序排列
      const logQuery = `SELECT Id, Application, Operation, LogLength, StartTime 
                        FROM ApexLog 
                        ORDER BY LastModifiedDate DESC 
                        LIMIT ${limit}`;

      const result = await this.connection.query(logQuery, { autoFetch: true, maxFetch: limit });
      const records = result.records || [];

      if (records.length > 0) {
        const latestLog = records[0];
        const logId = latestLog.Id;

        // 调用 getDebugLogDetail 获取详细日志信息
        const logDetail = await this.getDebugLogDetail(logId);
        console.log("logDetail: ", logDetail);
        if (logDetail.success) {
          return {
            success: true,
            log: logDetail.log,
            logs: records,
            totalLogs: records.length
          };
        }

        // 如果获取详情失败，仍返回基本信息
        return {
          success: true,
          log: latestLog,
          logs: records,
          totalLogs: records.length
        };
      }

      return { success: false, error: "No debug logs found" };
    } catch (error) {
      console.error("Get Latest Debug Log Error:", error);
      return { success: false, error: error.message };
    }
  },

  /**
   * 获取指定 Log 的详细信息
   * @param {string} logId - Log 的 Id
   */
  async getDebugLogDetail(logId) {
    try {
      if (!this.connection) {
        return { success: false, error: "Salesforce connection not established" };
      }

      if (!logId) {
        return { success: false, error: "Log ID is required" };
      }
      console.log("logId: ", logId);
      // 使用 ApexLog 的 Body 端点获取日志内容
      let logBody = await this.connection.request({
        method: 'GET',
        url: `/services/data/v${defaultApiVersion}/sobjects/ApexLog/${logId}/Body`
      });

      // 格式化日志内容：将 \n 转换为实际换行符
      if (typeof logBody === 'string') {
        logBody = logBody.replace(/\\n/g, '\n');
      }
      console.log("logBody: ", logBody);
      return {
        success: true,
        log: logBody
      };
    } catch (error) {
      console.error("Get Debug Log Detail Error:", error);
      return { success: false, error: error.message };
    }
  },

  /**
   * 获取指定 Log 的行日志详情 (LogEntry)
   * @param {string} logId - Log 的 Id
   * @param {number} limit - 返回的日志行数限制
   */
  async getDebugLogLines(logId, limit = 1000) {
    try {
      if (!this.connection) {
        return { success: false, error: "Salesforce connection not established" };
      }

      if (!logId) {
        return { success: false, error: "Log ID is required" };
      }

      // 查询 LogEntry 按时间排序
      const logLinesQuery = `SELECT Id, Timestamp, Sequence, Line, TimestampOffset, ExecutableLine, 
                              Value, StackTrace, Method, Type
                              FROM LogEntry
                              WHERE LogId = '${logId}'
                              ORDER BY Sequence ASC
                              LIMIT ${limit}`;

      const encodedQuery = encodeURIComponent(logLinesQuery);
      const response = await this.connection.request({
        method: 'GET',
        url: `/services/data/v${defaultApiVersion}/tooling/query/?q=${encodedQuery}`
      });

      if (response && response.records) {
        return {
          success: true,
          logLines: response.records,
          totalSize: response.totalSize || response.records.length
        };
      }

      return { success: false, error: "No log lines found" };
    } catch (error) {
      console.error("Get Debug Log Lines Error:", error);
      return { success: false, error: error.message };
    }
  }

};
