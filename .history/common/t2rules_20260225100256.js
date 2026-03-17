export function applyT2Rules(data) {
  if (!data || data.length === 0) return data;

  const jsonData = [...data]; // 浅拷贝

  // 辅助函数：获取列值（模糊匹配列名）
  // 优先匹配 Salesforce API Name (__c), 然后是标准名称
  const getValue = (row, ...possibleNames) => {
    const keys = Object.keys(row);
    for (const name of possibleNames) {
      // 1. 精确匹配
      let key = keys.find(k => k === name);
      if (key) return row[key];

      // 2. 忽略大小写和下划线/空格匹配
      const normalize = str => str.toLowerCase().replace(/[\s_]/g, '');
      const target = normalize(name);
      key = keys.find(k => normalize(k) === target);
      if (key) return row[key];
      
      // 3. 尝试匹配包含 __c 的情况 (Salesforce 字段)
      key = keys.find(k => normalize(k) === normalize(name + '__c'));
      if (key) return row[key];
    }
    return null;
  };

  // 辅助函数：设置列值
  const setValue = (row, colName, value) => {
    // 查找现有的 Action 列
    const keys = Object.keys(row);
    let key = keys.find(k => k.toLowerCase() === colName.toLowerCase());
    
    if (!key) {
      key = colName; // 如果不存在，使用默认名称
    }
    row[key] = value;
  };

  jsonData.forEach(row => {
    let debugInfo = [];
    const log = (msg) => debugInfo.push(msg);

    // 映射 Python 代码中的列索引到可能的列名
    // row[16]: Order Status (Order.Custom_OrderStatus__c)
    const orderStatus = getValue(row, "Order Status", "Custom_OrderStatus", "Custom_OrderStatus__c", "Order.Custom_OrderStatus__c");
    // row[17]: Fulfillment Status (Order.Custom_FulfilmentStatus__c)
    const fulfillmentStatus = getValue(row, "Fulfillment Status", "Custom_FulfilmentStatus", "Custom_FulfilmentStatus__c", "Order.Custom_FulfilmentStatus__c");
    // row[23]: Fulfillment Remark (FulfillmentRemark__c)
    const fulfillmentRemark = getValue(row, "Fulfillment Remark", "FulfillmentRemark", "FulfillmentRemark__c");
    const fulfillmentId = getValue(row, "FulfillmentId__c");
    // row[7]: Order Name (Order.Name)
    const orderName = getValue(row, "Order Name", "OrderNumber", "Name", "Order.Name");
    // row[9]: Order Nature (Order.Order_Nature__c)
    const orderNature = getValue(row, "Order Nature", "OrderNature", "OrderNature__c", "Order.Order_Nature__c");
    // row[19]: CreatedBy (Order.CreatedBy.Name)
    const createdBy = getValue(row, "Created By", "CreatedBy", "CreatedById", "Order.CreatedBy.Name");
    // row[22]: Appointment ID (AppointmentId__c)
    const appointmentId = getValue(row, "Appointment ID", "AppointmentId", "Appointment__c", "AppointmentId__c");

    const lob = getValue(row, "LOB", "LOB__c", "Order.LOB__c");
    let orderType = '';

    if (lob === "FixedLine"){
      orderType = "COM(LTS)";
    }
    else{
      orderType = "COM(PCD)";
    }

    let action = null;

    // 记录初始状态
    log(`Init: Status='${orderStatus}', Fulfilment='${fulfillmentStatus}', RemarkLen=${fulfillmentRemark ? fulfillmentRemark.length : 0}`);

    // 1. Check Order.Custom_OrderStatus__c and Order.Custom_FulfilmentStatus__c
    if (orderStatus === "Ready To Submit" ) {

      if(fulfillmentStatus === "In Progress"){
        action = orderType;
        log(`Rule 1.1: Status=Ready To Submit, Fulfilment=In Progress -> ${action}`);
        if (createdBy !== "integration.user") {
          action = "Sales";
          log(`Rule 1.1.1: CreatedBy='${createdBy}' (!= integration.user) -> Sales`);
        }

      } else if(!fulfillmentStatus){
        action = "N/A";
        log(`Rule 1.2: Status=Ready To Submit, Fulfilment=Empty -> N/A`);

      } else if(fulfillmentStatus === "Remake Appointment (M1)"){
        if (createdBy !== "integration.user") {
          action = "Sales";
          log(`Rule 1.6.1: CreatedBy='${createdBy}' (!= integration.user) -> Sales`);
        }else{
          action = orderType;
          log(`Rule 1.6.2: CreatedBy='${createdBy}' (= integration.user) -> ${orderType}`);
        }
      } else if(fulfillmentStatus === "Appointment Changed (M1)" ||
              fulfillmentStatus === "Sales Support Follow-up (M3)"){
        action = orderType;
        log(`Rule 1.3: Status=Ready To Submit, Fulfilment='${fulfillmentStatus}' -> ${action}`);
      } else if(fulfillmentStatus === "Inventory Replenishment"){
        action = "F&S";
        log(`Rule 1.4: Status=Ready To Submit, Fulfilment='${fulfillmentStatus}' -> ${action}`);
      } else if(fulfillmentStatus === "Inventory Fallout"){
        action = "NORA";
        log(`Rule 1.5: Status=Ready To Submit, Fulfilment='${fulfillmentStatus}' -> ${action}`);
      } else {
        log(`Rule 1: Status=Ready To Submit, but Fulfilment='${fulfillmentStatus}' matched no sub-rule.`);
      }

    } else if (orderStatus === "Amend Requested") {

      if(fulfillmentStatus === "Inventory Fallout" ||
        fulfillmentStatus === "Appointment Changed (M1)" ||
        fulfillmentStatus === "Remake Appointment (M1)" ||
        fulfillmentStatus === "Appointment Changed (M2)"){
          if(createdBy !== "integration.user"){
            action = "N/A";
            log(`Rule 2.1.1: Status=Amend Requested, Fulfilment='${fulfillmentStatus}' -> ${action}`);
          } else{
            action = orderType;
            log(`Rule 2.1.2: Status=Amend Requested, Fulfilment='${fulfillmentStatus}' -> ${action}`);
          }
       
      } else {
        log(`Rule 2: Status=Amend Requested, but Fulfilment='${fulfillmentStatus}' matched no sub-rule.`);
      }

    } else if (orderStatus === "In Progress") {
      
      if(!fulfillmentStatus && !fulfillmentId){
        action = orderType;
        log(`Rule 3.0: Status=In Progress, Fulfilment='${fulfillmentStatus}', Remark='${fulfillmentRemark ? 'Yes' : 'No'}' -> ${action}`);
      } else if(!fulfillmentStatus ||
        fulfillmentStatus === "In Progress - Fulfillment Data Issue" ||
        !fulfillmentRemark){
        action = orderType;
        log(`Rule 3.1: Status=In Progress, Fulfilment='${fulfillmentStatus}', Remark='${fulfillmentRemark ? 'Yes' : 'No'}' -> ${action}`);
      
      } else if(fulfillmentStatus === "Appointment Changed (M2)"){
        action = "N/A";
        log(`Rule 3.2.1: Status=In Progress, Fulfilment=Appointment Changed (M2) -> N/A`);
      } else if(fulfillmentStatus === "F&S Followed"){
        action = "N/A";
        log(`Rule 3.2.2: Status=In Progress, Fulfilment=F&S Followed -> N/A`);
        // if(fulfillmentRemark.includes("INVENTORY REPLENISHMENT")){
        //   action = "OPS";
        //   log(`Rule 3.2.1: Status=In Progress, Fulfilment=F&S Followed -> OPS`);
        // }else{
        //   action = "N/A";
        //   log(`Rule 3.2.2: Status=In Progress, Fulfilment=F&S Followed -> N/A`);
        // }
       

      } else if(fulfillmentStatus === "Inventory Replenishment"){
        action = "F&S";
        log(`Rule 3.3: Status=In Progress, Fulfilment=Inventory Replenishment -> F&S`);
      } else if(fulfillmentStatus === "Address Check Sales Follow-up"){
        action = "Sales";
        log(`Rule 3.4: Status=In Progress, Fulfilment=Address Check Sales Follow-up -> Sales`);
      } else if (fulfillmentStatus === "[F&S] Resources Issues") {
        action = "F&S";
        log(`Rule 3.5: Fulfilment='${fulfillmentStatus}' -> F&S`);
      } else {
        log(`Rule 3: Status=In Progress, but Fulfilment='${fulfillmentStatus}' matched no sub-rule.`);
      }

    } else if (orderStatus === "In Progress-Fulfilment Completed"){
      if(fulfillmentStatus === "Completed"){
        action = "N/A";
        log(`Rule 3.3.1: Status=In Progress-Fulfilment Completed, Fulfilment= Completed -> N/A`);
      }
    } else if (orderStatus === "Cancel Requested" ||
              orderStatus === "Frozen" ||
              orderStatus === "Rejected" ||
              fulfillmentStatus === "In Progress - Fulfillment Data Issue" ||
              ((fulfillmentStatus === "Appointment Changed (M1)" ||
              fulfillmentStatus === "Appointment Changed (M2)") &&
              !appointmentId)) {
      action = orderType;
      log(`Rule 4: Status='${orderStatus}', Fulfilment='${fulfillmentStatus}', ApptId='${appointmentId}' -> ${action}`);
    
    } else if (fulfillmentStatus === "Address Approved" || 
              fulfillmentStatus === "Address Check SB Assigned") {
      action = "Sales";
      log(`Rule 5: Fulfilment='${fulfillmentStatus}' -> Sales`);

    } else {
        // 没有任何主要状态规则匹配
        log(`No Main Rule matched for Status='${orderStatus}', Fulfilment='${fulfillmentStatus}'`);
    }

    // 2. Check FulfillmentRemark__c column
    if (action===null && typeof fulfillmentRemark === 'string') {
      // Python: re.split(r'\n+(?=\[)', fulfillment_remark)
      // JS: split by newline followed by '['
      const remarks = fulfillmentRemark.split(/\n+(?=\[)/).map(s => s.trim()).filter(s => s);
      const firstRemark = remarks[0];
      
      const m1Criteria = ["DRC: [31]", "DRC: [50]",  "DRC: [28]",  "DRC: [38]",  "DRC: [34]", "DRC: [40]", "DRC: [57]", "DRC: [58]", "DRC: [65]", "DRC: [69]", "DRC: [77]", "DRC: [79]"];
      // 修正：检查是否有任何 remark 包含任何 keyword (模糊匹配)
      const hasM1words = remarks.some(r => m1Criteria.some(k => r.includes(k)));

      if (remarks.length > 0) {
        
        if (hasM1words) log(`Info: Found M1 words in remarks.`);
        
        if (firstRemark.includes("CANCELLED")) {
          action = "N/A";
          log(`Rule 6.1: First Remark includes CANCELLED -> N/A`);
        } else if (firstRemark.includes("RESOURCE USED UP")) {
          action = "F&S";
          log(`Rule 6.2: First Remark includes RESOURCE USED UP -> F&S`);
        } else if (firstRemark.includes("L2JOB FALLOUT")) {
          action = "LDAP";
          log(`Rule 6.3: First Remark includes L2JOB FALLOUT -> LDAP`);
        } else if (firstRemark.includes('NORA updated "ORDER ABORT"')) {
          action = "NORA";
          log(`Rule 6.4: First Remark includes NORA updated "ORDER ABORT" -> NORA`);
        } else if (firstRemark.includes('updated "L2JOB ISSUED"')) {
          action = "N/A";
          log(`Rule 6.5: First Remark includes updated "L2JOB ISSUED" -> N/A`);
          if (remarks.length > 1) {
            const secondRemark = remarks[1].trim();
            if (secondRemark.includes("2N Status: Rented")) {
              action = "N/A";
              log(`Rule 6.5.1: Second Remark includes 2N Status: Rented -> N/A`);
            } else if (secondRemark.includes("2N Status: Failed")) {
              action = "Sales";
              log(`Rule 6.5.2: Second Remark includes 2N Status: Failed -> Sales`);
            } else if (secondRemark.includes("DRC: [33]")) {
              action = "N/A";
              log(`Rule 6.5.3: Second Remark includes DRC: [33] -> N/A`);
            } else {
                log(`Rule 6.5: Second Remark matched no sub-rule.`);
            }
          }
        }

        for (const remark of remarks) {

          if (remark.includes("APPOINTMENT CHANGED")) {
            if (hasM1words && orderStatus === "Amend Requested") {
              action = orderType;
              log(`Rule 7.1.1: APPOINTMENT CHANGED + M1 words + Amend Requested -> ${action}`);
              break;
            }
            if (hasM1words && (fulfillmentStatus === "Remake Appointment (M1)" || fulfillmentStatus === "Remake Appointment (M2)")) {
              action = "Sales";
              log(`Rule 7.1.2: APPOINTMENT CHANGED + M1 words + Remake Appointment -> Sales`);
              break;
            }
            if (hasM1words) {
              action = "Sales";
              log(`Rule 7.1.3: APPOINTMENT CHANGED + M1 words -> Sales`);
              break;
            }
            if (remark.includes("Await Sales Follow Up")) {
              action = "Sales";
              log(`Rule 7.1.4: APPOINTMENT CHANGED + Await Sales Follow Up -> Sales`);
              break;
            }
            if ((remark.includes("Customer Busy") || remark.includes("await customer")) && remark.includes("TID: true")) {
              action = "N/A";
              log(`Rule 7.1.5: APPOINTMENT CHANGED + Customer Busy/await customer + TID: true -> N/A`);
              break;
            }
            if (remark.includes("DRC: [21]") || remark.includes("DRC: [22]")) {
              action = "OPS";
              log(`Rule 7.1.6: APPOINTMENT CHANGED + DRC: [21]/[22] -> OPS`);
              break;
            }
            if (remark.includes("DRC: [68]")) {
              action = "N/A";
              log(`Rule 7.1.7: APPOINTMENT CHANGED + DRC: [68] -> FS`);
              break;
            }
            if (remark.includes("DRC: [12]")) {
              action = "N/A";
              log(`Rule 7.1.8: APPOINTMENT CHANGED + DRC: [12] -> N/A`);
              break;
            }
            if (remark.includes("DRC: [58]")) {
              action = "Sales";
              log(`Rule 7.1.9: APPOINTMENT CHANGED + DRC: [58] -> Sales`);
              break;
            }
            if (remark.includes("Customer Busy") && remark.includes("TID: false")) {
              action = "N/A";
              log(`Rule 7.1.10: APPOINTMENT CHANGED + Customer Busy + TID: false -> N/A`);
              break;
            }
          }

          if (remark.includes("2N UPDATED") && (remark.includes("2N Status: Failed") || remark.includes("SEE"))) {
            action = "FS CALL CENTER";
            log(`Rule 7.2: 2N UPDATED + Failed/SEE -> FS CALL CENTER`);
            break;
          }

          if (remark.includes("INVENTORY FALLOUT") || remark.includes("Fallout Reason: Cable assignment issue")) {
            if (remark.includes("OPS")) {
              action = "OPS";
              log(`Rule 7.3.1: INVENTORY FALLOUT + OPS -> OPS`);
              break;
            }
            if (remark.includes("ORA-01403: no data found")) {
              action = orderType;
              log(`Rule 7.3.2: INVENTORY FALLOUT + ORA-01403 -> ${action}`);
              break;
            }
            if (remark.includes("UIM")) {
              action = "UIM";
              log(`Rule 7.3.3: INVENTORY FALLOUT + UIM -> UIM`);
              if (remark.includes("MANUAL ASSIGNMENT REQUIRED")) {
                action = "BAND";
                log(`Rule 7.3.3.1: INVENTORY FALLOUT + UIM + MANUAL ASSIGNMENT REQUIRED -> BAND`);
              }
              break;
            }
            if (remark.includes("BAND")) {
              action = "BAND";
              log(`Rule 7.3.4: INVENTORY FALLOUT + BAND -> BAND`);
              break;
            }
          }

          if (remark.includes("PID FALLOUT")) {
            action = orderType;
            log(`Rule 7.4: PID FALLOUT -> ${action}`);
            break;
          }
          
          if (remark.includes("RESOURCE USED UP")) {
            action = "F&S";
            log(`Rule 7.5: RESOURCE USED UP -> F&S`);
            break;
          }

          if (action) break;

          if (remark.includes("ORDER RECEIVED")) {
            action = "N/A";
            log(`Rule 7.6: ORDER RECEIVED -> N/A`);
          }

        }
      }
    }

    // Special case for Sales action with CS order name
    if (action === "Sales" && orderName && String(orderName).startsWith("CS")) {
      action = "CS";
      log(`Rule 8: Special Case CS Order -> CS`);
    }

    // Apply action
    if (action) {
      setValue(row, "Action", action);
    }
    setValue(row, "Debug_Log", debugInfo.join(" | "));
  });

  return jsonData;
}