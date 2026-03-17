/**
 * 应用 T2 规则 (填充 Action 列)
 * @param {Array} data - JSON 数据
 * @returns {Array} - 处理后的数据
 */
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
    // 映射 Python 代码中的列索引到可能的列名
    // row[16]: Order Status (Order.Custom_OrderStatus__c)
    const orderStatus = getValue(row, "Order Status", "Custom_OrderStatus", "Custom_OrderStatus__c", "Order.Custom_OrderStatus__c");
    // row[17]: Fulfillment Status (Order.Custom_FulfilmentStatus__c)
    const fulfillmentStatus = getValue(row, "Fulfillment Status", "Custom_FulfilmentStatus", "Custom_FulfilmentStatus__c", "Order.Custom_FulfilmentStatus__c");
    // row[23]: Fulfillment Remark (FulfillmentRemark__c)
    const fulfillmentRemark = getValue(row, "Fulfillment Remark", "FulfillmentRemark", "FulfillmentRemark__c");
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

    // 1. Check Order.Custom_OrderStatus__c and Order.Custom_FulfilmentStatus__c
    if (orderStatus === "Ready To Submit" && fulfillmentStatus === "In Progress") {
      action = orderType;
      if (createdBy !== "integration.user") {
        action = "Sales";
      }
    } else if (orderStatus === "Cancel Requested") {
      action = orderType;
    } else if (orderStatus === "Ready To Submit" && fulfillmentStatus === "Appointment Changed (M1)") {
      action = orderType;
    } else if (orderStatus === "Ready To Submit" && fulfillmentStatus === "Sales Support Follow-up (M3)") {
      action = orderType;
    } else if (orderStatus === "Ready To Submit" && fulfillmentStatus === "Remake Appointment (M1)") {
      action = orderType;
    } else if (orderStatus === "Amend Requested" && fulfillmentStatus === "Inventory Fallout") {
      action = orderType;
    } else if (orderStatus === "Frozen" || orderStatus === "Rejected") {
      action = orderType;
    } else if (orderStatus === "Amend Requested" && (fulfillmentStatus === "Appointment Changed (M1)" || fulfillmentStatus === "Appointment Changed (M2)")) {
      action = orderType;
    } else if (orderStatus === "In Progress" && !fulfillmentStatus) {
      action = orderType;
    } else if (fulfillmentStatus === "In Progress - Fulfillment Data Issue") {
      action = orderType;
    } else if ((fulfillmentStatus === "Appointment Changed (M1)" || fulfillmentStatus === "Appointment Changed (M2)") && !appointmentId) {
      action = orderType;
    } else if (orderStatus === "In Progress" && fulfillmentStatus === "F&S Followed") {
      action = "N/A";
    } else if (orderStatus === "In Progress" && fulfillmentStatus === "Inventory Replenishment") {
      action = "F&S";
    } else if (orderStatus === "Ready to submit" && fulfillmentStatus === "Remake Appointment (M1)") {
      action = "Sales";
    }else if (orderStatus === "In Progress" && fulfillmentStatus === "Address Check Sales Follow-up") {
      action = "Sales";
    } else if (orderStatus === "Ready To Submit" && !fulfillmentStatus) {
      action = "N/A";
    } else if (fulfillmentStatus === "Address Approved" || fulfillmentStatus === "Address Check SB Assigned") {
      action = "Sales";
    }

    // 2. Check FulfillmentRemark__c column
    if (!action && typeof fulfillmentRemark === 'string') {
      // Python: re.split(r'\n+(?=\[)', fulfillment_remark)
      // JS: split by newline followed by '['
      const remarks = fulfillmentRemark.split(/\n+(?=\[)/).map(s => s.trim()).filter(s => s);
      
      if (remarks.length > 0) {
        const firstRemark = remarks[0];
        
        if (firstRemark.includes("CANCELLED")) {
          action = "N/A";
        } else if (firstRemark.includes("RESOURCE USED UP")) {
          action = "F&S";
        } else if (firstRemark.includes("L2JOB FALLOUT")) {
          action = "LDAP";
        } else if (firstRemark.includes('NORA updated "ORDER ABORT"')) {
          action = "NORA";
        } else if (firstRemark.includes('updated "L2JOB ISSUED"')) {
          action = "N/A";
          if (remarks.length > 1) {
            const secondRemark = remarks[1].trim();
            if (secondRemark.includes("2N Status: Rented")) {
              action = "N/A";
            } else if (secondRemark.includes("2N Status: Failed")) {
              action = "Sales";
            } else if (secondRemark.includes("DRC: [33]")) {
              action = "N/A";
            }
          }
        }
      }
    }

    // 3. Check other conditions (scan all remarks)
    if (!action && typeof fulfillmentRemark === 'string') {
      const remarks = fulfillmentRemark.split(/\n+(?=\[)/).map(s => s.trim()).filter(s => s);
      const m1Criteria = ["DRC: [31]", "DRC: [50]",  "DRC: [28]",  "DRC: [38]",  "DRC: [34]", "DRC: [40]", "DRC: [57]", "DRC: [58]", "DRC: [65]", "DRC: [69]", "DRC: [77]", "DRC: [79]"];
      
      let hasM1words = m1Criteria.some(keyword => remarks.includes(keyword));

      for (const remark of remarks) {
        if (remark.includes("APPOINTMENT CHANGED")) {
          if (hasM1words && orderStatus === "Amend Requested") {
            action = orderType;
            break;
          }
          if (hasM1words && (fulfillmentStatus === "Remake Appointment (M1)" || fulfillmentStatus === "Remake Appointment (M2)")) {
            action = "Sales";
            break;
          }
          if (hasM1words) {
            action = "Sales";
            break;
          }
          if (remark.includes("Await Sales Follow Up")) {
            action = "Sales";
            break;
          }
          if ((remark.includes("Customer Busy") || remark.includes("await customer")) && remark.includes("TID: true")) {
            action = "N/A";
            break;
          }
          if (remark.includes("DRC: [21]") || remark.includes("DRC: [22]")) {
            action = "OPS";
            break;
          }
          if (remark.includes("DRC: [68]")) {
            action = "FS";
            break;
          }
          if (remark.includes("DRC: [12]")) {
            action = "N/A";
            break;
          }
          if (remark.includes("DRC: [58]")) {
            action = "Sales";
            break;
          }
          if (remark.includes("Customer Busy") && remark.includes("TID: false")) {
            action = "N/A";
            break;
          }
        }

        if (remark.includes("2N UPDATED") && (remark.includes("2N Status: Failed") || remark.includes("SEE"))) {
          action = "FS CALL CENTER";
          break;
        }

        if (remark.includes("INVENTORY FALLOUT") || remark.includes("Fallout Reason: Cable assignment issue")) {
          if (remark.includes("OPS")) {
            action = "OPS";
            break;
          }
          if (remark.includes("ORA-01403: no data found")) {
            action = orderType;
            break;
          }
          if (remark.includes("UIM")) {
            action = "UIM";
            if (remark.includes("MANUAL ASSIGNMENT REQUIRED")) {
              action = "BAND";
            }
            break;
          }
          if (remark.includes("BAND")) {
            action = "BAND";
            break;
          }
        }

        if (remark.includes("PID FALLOUT")) {
          action = orderType;
          break;
        }
        
        if (remark.includes("RESOURCE USED UP")) {
          action = "F&S";
          break;
        }

        if (action) break;

        if (remark.includes("ORDER RECEIVED")) {
          action = "N/A";
        }
      }
    }

    // Special case for Sales action with CS order name
    if (action === "Sales" && orderName && String(orderName).startsWith("CS")) {
      action = "CS";
    }

    // Apply action
    if (action) {
      setValue(row, "Action", action);
    }
  });

  return jsonData;
}