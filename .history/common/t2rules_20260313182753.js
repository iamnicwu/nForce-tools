export function applyT2Rules(data) {
  if (!data || data.length === 0) return data;

  const m1Criteria = [
    "DRC: [31]", "DRC: [50]", "DRC: [28]", "DRC: [38]",
    "DRC: [34]", "DRC: [40]", "DRC: [57]", "DRC: [58]",
    "DRC: [65]", "DRC: [69]", "DRC: [77]", "DRC: [79]",
  ];

  const BANDKeywords = [
    "MANUAL ASSIGNMENT REQUIRED",
    "NOT ALLOW AUTO ASSIGN FOR THIS SB",
    "NO AVAILABLE DP"
  ];

  const jsonData = [...data];

  jsonData.forEach((row) => {
    const debugInfo = [];
    const log = (msg) => debugInfo.push(msg);

    // 1. 提取上下文信息
    const ctx = extractContext(row, log);
    
    log(`[Init] Status='${ctx.status}', Fulfilment='${ctx.fulfillStatus}', RemarkLen=${ctx.fulfillRemark ? ctx.fulfillRemark.length : 0}`);

    // 2. 根据状态评估规则
    let action = evaluateStatusRules(ctx, BANDKeywords);

    // 3. 如果状态规则未匹配，则根据备注评估规则
    if (!action) {
      action = evaluateRemarkRules(ctx, m1Criteria);
    }

    if (!action) {
      log(`[Info] No Main Rule matched for Status='${ctx.status}', Fulfilment='${ctx.fulfillStatus}'`);
    }

    // 4. 应用 Sales 覆盖规则 (例如 CS 订单、DRC 检测)
    action = applySalesOverride(action, ctx, m1Criteria);

    // 5. 应用结果到行
    if (action) {
      setValue(row, "Action", action);
    }
    setValue(row, "Debug_Log", debugInfo.join(" | "));
  });

  return jsonData;
}

// ==========================================
// 辅助函数
// ==========================================

function getValue(row, ...possibleNames) {
  const keys = Object.keys(row);
  for (const name of possibleNames) {
    // 1. 精确匹配
    let key = keys.find((k) => k === name);
    if (key) return row[key];

    // 2. 忽略大小写和下划线/空格匹配
    const normalize = (str) => str.toLowerCase().replace(/[\s_]/g, "");
    const target = normalize(name);
    key = keys.find((k) => normalize(k) === target);
    if (key) return row[key];

    // 3. 尝试匹配包含 __c 的情况 (Salesforce 字段)
    key = keys.find((k) => normalize(k) === normalize(name + "__c"));
    if (key) return row[key];
  }
  return null;
}

function setValue(row, colName, value) {
  const keys = Object.keys(row);
  let key = keys.find((k) => k.toLowerCase() === colName.toLowerCase());
  row[key || colName] = value;
}

function extractContext(row, log) {
  const status = getValue(row, "Order Status", "Custom_OrderStatus", "Custom_OrderStatus__c", "Order.Custom_OrderStatus__c");
  const fulfillStatus = getValue(row, "Fulfillment Status", "Custom_FulfilmentStatus", "Custom_FulfilmentStatus__c", "Order.Custom_FulfilmentStatus__c");
  const fulfillRemark = getValue(row, "Fulfillment Remark", "FulfillmentRemark", "FulfillmentRemark__c");
  const fulfillId = getValue(row, "FulfillmentId__c");
  const orderName = getValue(row, "Order Name", "OrderNumber", "Name", "Order.Name");
  const orderNature = getValue(row, "Order Nature", "OrderNature", "OrderNature__c", "Order.Order_Nature__c");
  const createdBy = getValue(row, "Created By", "CreatedBy", "CreatedById", "Order.CreatedBy.Name");
  const apptId = getValue(row, "Appointment ID", "AppointmentId", "Appointment__c", "AppointmentId__c");
  const lob = getValue(row, "LOB", "LOB__c", "Order.LOB__c");
  const nature = getValue(row, "Nature", "Nature", "Order.Order_Nature__c", "Order.Nature__c");
  const orderType = lob === "FixedLine" ? "COM(LTS)" : "COM(PCD)";
  const details = getValue(row,"FulfillmentDetail__c");

  return { row, status, fulfillStatus, fulfillRemark, fulfillId, orderName, orderNature, createdBy, apptId, lob, orderType, log };
}

// ==========================================
// 规则逻辑模块
// ==========================================

function evaluateStatusRules(ctx, BANDKeywords) {
  const { status,details, nature, fulfillStatus, fulfillRemark, fulfillId, apptId, createdBy, orderType, log } = ctx;

  if (status === "Ready To Submit") {
    
    if(nature == 'Resumption'){
      if(lob === 'FixedLine'){
        log(`[Status Rule 1.1.0] Ready To Submit + Resumption -> N/A`);
        return "N/A";
      }
    }

    if (fulfillStatus === "In Progress" || fulfillStatus === "In Progress-Distributed") {
      if (createdBy != "integration.user") {
        log(`[Status Rule 1.1.1] Ready To Submit + In Progress + CreatedBy(!= integration.user) -> N/A`);
        return "Sales";
      } 
      log(`[Status Rule 1.1.2] Ready To Submit + In Progress + CreatedBy(= integration.user) -> Sales`);
      return orderType;
      
    } 
    if (!fulfillStatus) {
      log(`[Status Rule 1.2] Ready To Submit + Empty Fulfillment -> N/A`);
      return "N/A";
    } 
    if (fulfillStatus === "Remake Appointment (M1)") {
      if (createdBy != "integration.user") {
        log(`[Status Rule 1.6.1] Ready To Submit + Remake Appt (M1) + CreatedBy(!= integration.user) -> Sales`);
        return "Sales";
      }
      log(`[Status Rule 1.6.2] Ready To Submit + Remake Appt (M1) + CreatedBy(integration.user) -> ${orderType}`);
      return orderType;
    } 

    if (fulfillStatus === "Sales Support Follow-up (M3)") {
      log(`[Status Rule 1.3] Ready To Submit + '${fulfillStatus}' -> ${orderType}`);
      return orderType;
    } 
    if (fulfillStatus === "Inventory Replenishment") {
      log(`[Status Rule 1.4] Ready To Submit + Inventory Replenishment -> F&S`);
      return "F&S";
    } 
    if (fulfillStatus === "Inventory Fallout") {
      log(`[Status Rule 1.5] Ready To Submit + Inventory Fallout -> NORA`);
      return "NORA";
    } 
    if (fulfillStatus === "Address Under Review") {
      log(`[Status Rule 1.6] Ready To Submit + Address Under Review -> Sales`);
      return "Sales";
    }
    if(fulfillStatus === "Completed"){
      log(`[Status Rule 1.7] Ready To Submit + '${fulfillStatus}' -> ${orderType}`);
      return orderType;
    }

    if(fulfillStatus === "Appointment Changed (M1)"){
      if (createdBy != "integration.user") {
        log(`[Status Rule 1.9.0] Ready To Submit + '${fulfillStatus}' -> Sales`);
        return "Sales";
      }
      log(`[Status Rule 1.9.1] Ready To Submit + '${fulfillStatus}' -> ${orderType}}`);
      return orderType;
    }

    if(fulfillStatus === "Appointment Changed (M2)"){
      if (createdBy != "integration.user") {
        log(`[Status Rule 1.8.0] Ready To Submit + '${fulfillStatus}' -> N/A`);
        return "N/A";
      }
      log(`[Status Rule 1.8.1] Ready To Submit + '${fulfillStatus}' -> ${orderType}}`);
      return orderType;
    }
  } 
  
  if (status === "Amend Requested") {
    if (["Inventory Fallout", "Appointment Changed (M1)", "Remake Appointment (M1)", "Appointment Changed (M2)"].includes(fulfillStatus)) {
      if (createdBy != "integration.user") {
        log(`[Status Rule 2.1] Amend Requested + '${fulfillStatus}' + CreatedBy(!= integration.user) -> N/A`);
        return "N/A";
      }
      log(`[Status Rule 2.2] Amend Requested + '${fulfillStatus}' + CreatedBy(integration.user) -> ${orderType}`);
      return orderType;
    }
    if(fulfillStatus === "In Progress" || fulfillStatus === "In Progress-Distributed"){
      log(`[Status Rule 2.3] Amend Requested + '${fulfillStatus}' -> ${orderType}`);
      return orderType;
    }
  } 
  
  if (status === "In Progress") {

    if(nature == 'Resumption'){
      if(lob === 'FixedLine' && !details.includes("fallout")){
        log(`[Status Rule 3.0.0] In Progress + Resumption -> N/A`);
        return "N/A";
      }
    }
    if (!fulfillStatus && !fulfillId) {
      log(`[Status Rule 3.0] In Progress + Empty Fulfillment & FulfillId -> ${orderType}`);
      return orderType;
    } 
    if (!fulfillStatus || fulfillStatus === "In Progress - Fulfillment Data Issue" || !fulfillRemark) {
      log(`[Status Rule 3.1] In Progress + Missing Fulfill/Remark or Data Issue -> ${orderType}`);
      return orderType;
    } 
    if (fulfillStatus === "Appointment Changed (M2)") {
      log(`[Status Rule 3.2.1] In Progress + Appointment Changed (M2) -> N/A`);
      return "N/A";
    } 
    if (fulfillStatus === "F&S Followed") {
      log(`[Status Rule 3.2.2] In Progress + F&S Followed -> N/A`);
      return "N/A";
    } 
    if (fulfillStatus === "Inventory Replenishment") {
      log(`[Status Rule 3.3] In Progress + Inventory Replenishment -> F&S`);
      return "F&S";
    } 
    if (fulfillStatus === "Address Check Sales Follow-up") {
      log(`[Status Rule 3.4] In Progress + Address Check Sales Follow-up -> Sales`);
      return "Sales";
    } 
    if (fulfillStatus === "[F&S] Resources Issues") {
      log(`[Status Rule 3.5] In Progress + [F&S] Resources Issues -> F&S`);
      return "F&S";
    } 
    if (fulfillStatus === "Address Check SB Assigned") {
      log(`[Status Rule 3.5] In Progress + Address Check SB Assigned -> Sales`);
      return "Sales";
    } 
    if (fulfillStatus === "Leased-In Failed") {
      log(`[Status Rule 3.6] In Progress + Leased-In Failed -> Sales`);
      return "Sales";
    } 
    if (fulfillStatus === "Waiting For Inventory") {
      if (fulfillRemark.includes("UIM")) {
        if (BANDKeywords.some(keyword => fulfillRemark.includes(keyword))) {
          log(`[Remark Rule 3.7.3] INVENTORY FALLOUT + UIM + MANUAL ASSIGNMENT REQUIRED -> BAND`);
          return "BAND";
        }
        log(`[Status Rule 3.7.1] In Progress + Waiting For Inventory + Remark(UIM) -> UIM`);
        return "UIM";
      }
      log(`[Status Rule 3.7.2] In Progress + Waiting For Inventory -> OPS`);
      return "OPS";
    }
    if(fulfillStatus === "Remake Appointment (M1)"){
      if(createdBy === "integration.user"){
        log(`[Status Rule 3.8.1] In Progress + Remake Appt (M1) + CreatedBy(=== integration.user) -> N/A`);
        return "Sales";
      }
    }
    if(fulfillStatus === "In Progress" || fulfillStatus === "In Progress-Distributed" ){
       log(`[Status Rule 3.9] In Progress + In Progress -> Sales`);
       return "Sales";
    }
    if(fulfillStatus === "Cancelled"){
      log(`[Status Rule 3.10] In Progress + In Progress -> ${orderType}`);
      return orderType;
    }
  } 
  
  if (status === "In Progress-Fulfilment Completed") {
    if (fulfillStatus === "Completed") {
      log(`[Status Rule 3.3.1] In Progress-Fulfilment Completed + Completed -> N/A`);
      return "N/A";
    }
  } 
  
  if (
    ["Cancel Requested", "Frozen", "Rejected"].includes(status) ||
    fulfillStatus === "In Progress - Fulfillment Data Issue" ||
    (["Appointment Changed (M1)", "Appointment Changed (M2)"].includes(fulfillStatus) && !apptId)
  ) {
    log(`[Status Rule 4] Status='${status}', Fulfilment='${fulfillStatus}', ApptId='${apptId}' -> ${orderType}`);
    return orderType;
  } 
  
  if (["Address Approved", "Address Check SB Assigned"].includes(fulfillStatus)) {
    log(`[Status Rule 5] Fulfilment='${fulfillStatus}' -> Sales`);
    return "Sales";
  }

  return null;
}

function evaluateRemarkRules(ctx, m1Criteria) {
  const { fulfillRemark, status, fulfillStatus, createdBy, orderType, log } = ctx;

  if (typeof fulfillRemark !== "string") return null;

  const remarks = fulfillRemark.split(/\n+(?=\[)/).map((s) => s.trim()).filter(Boolean);
  if (remarks.length === 0) return null;

  const firstRemark = remarks[0];
  const hasM1words = remarks.some((r) => m1Criteria.some((k) => r.includes(k)));

  if (hasM1words) log(`[Info] Found M1 words in remarks`);

  // 1. 根据第一条备注内容判断
  if (firstRemark.includes("CANCELLED")) {
    log(`[Remark Rule 6.1] First Remark(CANCELLED) -> N/A`);
    return "N/A";
  }
  if (firstRemark.includes("RESOURCE USED UP")) {
    log(`[Remark Rule 6.2] First Remark(RESOURCE USED UP) -> F&S`);
    return "F&S";
  }
  if (firstRemark.includes("L2JOB FALLOUT")) {
    log(`[Remark Rule 6.3] First Remark(L2JOB FALLOUT) -> LDAP`);
    return "LDAP";
  }
  if (firstRemark.includes('NORA updated "ORDER ABORT"')) {
    log(`[Remark Rule 6.4] First Remark(NORA updated "ORDER ABORT") -> NORA`);
    return "NORA";
  }
  if(firstRemark.includes('VNDP')){
    log(`[Remark Rule 6.5] First Remark(VNDP) -> VNDP`);
    return "VNDP";
  }
  if (firstRemark.includes('updated "L2JOB ISSUED"')) {
    log(`[Remark Rule 6.5] First Remark(updated "L2JOB ISSUED") -> N/A`);
    if (remarks.length > 1) {
      const secondRemark = remarks[1];
      if (secondRemark.includes("2N Status: Rented")) {
        log(`[Remark Rule 6.5.1] Second Remark(2N Status: Rented) -> N/A`);
        return "N/A";
      }
      if (secondRemark.includes("2N Status: Failed")) {
        log(`[Remark Rule 6.5.2] Second Remark(2N Status: Failed) -> Sales`);
        return "Sales";
      }
      if (secondRemark.includes("DRC: [33]")) {
        log(`[Remark Rule 6.5.3] Second Remark(DRC: [33]) -> N/A`);
        return "N/A";
      }
    }
    return "N/A"; // 匹配了外层，直接返回
  }

  // 2. 遍历所有备注寻找匹配
  for (const remark of remarks) {
    if (remark.includes("APPOINTMENT CHANGED")) {
      if (hasM1words && status === "Amend Requested") {
        log(`[Remark Rule 7.1.1] APPOINTMENT CHANGED + M1 words + Amend Requested -> ${orderType}`);
        return orderType;
      }
      if (hasM1words && ["Remake Appointment (M1)", "Remake Appointment (M2)"].includes(fulfillStatus)) {
        log(`[Remark Rule 7.1.2] APPOINTMENT CHANGED + M1 words + Remake Appointment -> Sales`);
        return "Sales";
      }
      if (hasM1words && createdBy === "integration.user") {
        log(`[Remark Rule 7.1.3] APPOINTMENT CHANGED + M1 words + integration.user -> Sales`);
        return "Sales";
      }
      if (remark.includes("Await Sales Follow Up")) {
        log(`[Remark Rule 7.1.4] APPOINTMENT CHANGED + Await Sales Follow Up -> Sales`);
        return "Sales";
      }
      if ((remark.includes("Customer Busy") || remark.includes("await customer")) && remark.includes("TID: true")) {
        log(`[Remark Rule 7.1.5] APPOINTMENT CHANGED + Customer Busy + TID: true -> N/A`);
        return "N/A";
      }
      if (remark.includes("DRC: [21]") || remark.includes("DRC: [22]")) {
        log(`[Remark Rule 7.1.6] APPOINTMENT CHANGED + DRC: [21]/[22] -> N/A`);
        return "N/A";
      }
      if (remark.includes("DRC: [68]")) {
        log(`[Remark Rule 7.1.7] APPOINTMENT CHANGED + DRC: [68] -> FS (Action: N/A)`); 
        return "N/A"; // 原始代码逻辑是 N/A，但 log 写的是 FS，此处保留原始动作 N/A
      }
      if (remark.includes("DRC: [12]")) {
        log(`[Remark Rule 7.1.8] APPOINTMENT CHANGED + DRC: [12] -> N/A`);
        return "N/A";
      }
      if (remark.includes("DRC: [58]")) {
        log(`[Remark Rule 7.1.9] APPOINTMENT CHANGED + DRC: [58] -> Sales`);
        return "Sales";
      }
      if (remark.includes("Customer Busy") && remark.includes("TID: false")) {
        log(`[Remark Rule 7.1.10] APPOINTMENT CHANGED + Customer Busy + TID: false -> N/A`);
        return "N/A";
      }
    }

    if (remark.includes("2N UPDATED") && (remark.includes("2N Status: Failed") || remark.includes("SEE"))) {
      log(`[Remark Rule 7.2] 2N UPDATED + Failed/SEE -> N/A (FS CALL CENTER)`);
      return "N/A";
    }

    if (remark.includes("INVENTORY FALLOUT") || remark.includes("Fallout Reason: Cable assignment issue")) {
      if (remark.includes("OPS")) {
        log(`[Remark Rule 7.3.1] INVENTORY FALLOUT + OPS -> OPS`);
        return "OPS";
      }
      if (remark.includes("ORA-01403: no data found")) {
        log(`[Remark Rule 7.3.2] INVENTORY FALLOUT + ORA-01403 -> ${orderType}`);
        return orderType;
      }
      if (remark.includes("UIM")) {
        if (remark.includes("MANUAL ASSIGNMENT REQUIRED") || remark.includes("NOT ALLOW AUTO ASSIGN FOR THIS SB")) {
          log(`[Remark Rule 7.3.3.1] INVENTORY FALLOUT + UIM + MANUAL ASSIGNMENT REQUIRED -> BAND`);
          return "BAND";
        }
        log(`[Remark Rule 7.3.3] INVENTORY FALLOUT + UIM -> UIM`);
        return "UIM";
      }
      if (remark.includes("BAND")) {
        log(`[Remark Rule 7.3.4] INVENTORY FALLOUT + BAND -> BAND`);
        return "BAND";
      }
    }

    if (remark.includes("PID FALLOUT")) {
      log(`[Remark Rule 7.4] PID FALLOUT -> ${orderType}`);
      return orderType;
    }

    if (remark.includes("RESOURCE USED UP")) {
      log(`[Remark Rule 7.5] RESOURCE USED UP -> F&S`);
      return "F&S";
    }

    if (remark.includes("Fallout Reason: NOSS related issue (VNDP)") || 
    remark.includes("Voice network assignment issue from EIPI (VNDP)") ) {
      log(`[Remark Rule 7.6] NOSS related issue (VNDP) -> VNDP`);
      return "VNDP";
    }

    if (remark.includes("<head><title>504 Gateway Time-out</title></head>")) {
      log(`[Remark Rule 7.7] 504 Gateway Time-out -> NORA`);
      return "NORA";
    }

    // if (remark.includes("ORDER RECEIVED")) {
    //   log(`[Remark Rule 7.8] ORDER RECEIVED -> N/A`);
    //   return "N/A";
    // }
  }

  return null;
}

function applySalesOverride(currentAction, ctx, m1Criteria) {
  const {orderName, createdBy, status, fulfillStatus, fulfillRemark, log } = ctx;
  let finalAction = currentAction;

  // 特例：当 Action 为 Sales 时，做深度 DRC 检查
  if (finalAction === "Sales" && 
    (status === "In Progress" || status === "Ready To Submit") &&
    (fulfillStatus === "In Progress" || fulfillStatus === "In Progress-Distributed" || 
      fulfillStatus === "Remake Appointment (M1)" || fulfillStatus === "Appointment Changed (M2)") &&
      
    typeof fulfillRemark === "string") {

    log(`[Override Info] Validating Sales action with advanced DRC check`);
    const paragraphs = extractDRCParagraphsAdvanced(fulfillRemark);
    
    if ( paragraphs.length > 0) {
      const hasM1words = paragraphs.some((r) => m1Criteria.some((k) => r.includes(k)));
      if (hasM1words) {
        const firstDRC = paragraphs[0];
        
        // 生成正则用来校验 firstDRC 内部是否匹配指定的 DRC
        const m1Numbers = m1Criteria.map(k => k.match(/\d+/)[0]);
        const drcRegex = new RegExp(`DRC:\\s*\\[(${m1Numbers.join('|')})\\]`, 'i');
        const isFirstMatch = drcRegex.test(firstDRC);

        log(`[Override Info] First DRC Paragraph Match: ${isFirstMatch}`);

        if (!isFirstMatch) {
          finalAction = "N/A";
          log(`[Override Rule 9.0] contains M1 DRC but not the first DRC -> Sales -> N/A`);
        }

        if(createdBy != "integration.user"){
          finalAction = "N/A";
          log(`[Override Rule 9.1] contains M1 DRC and the first DRC -> Sales -> N/A`);
        }
      }
      else{
        finalAction = "N/A";
        log(`[Override Rule 9.2] contains M1 DRC but not the first DRC -> Sales -> N/A`);
      }
    }else{
      finalAction = "N/A";
      log(`[Override Rule 9.3] does not contain M1 DRC -> N/A`);
    }
  }

  // 特例：当 Action 为 Sales 且 OrderName 以 CS 开头时，重载为 CS
  if (finalAction === "Sales" && orderName && String(orderName).startsWith("CS")) {
    log(`[Override Rule 8] Special Case CS Order -> CS`);
    finalAction = "CS";
  }

  return finalAction;
}

/**
 * 高级版本：使用正则表达式精确匹配 drc 段落
 * 段落定义为从包含 drc: [ 的行开始，到空行或文件结束
 */
function extractDRCParagraphsAdvanced(text) {
  if (!text || typeof text !== 'string') return [];

  // 统一换行符
  const normalizedText = text.replace(/\r\n/g, '\n');
  const result = [];
  const lines = normalizedText.split('\n');
  
  let paragraph = [];
  let collecting = false;
  
  for (const line of lines) {
    if (line.includes('DRC: [')) {
      if (collecting && paragraph.length > 0) {
        result.push(paragraph.join('\n'));
        paragraph = [];
      }
      collecting = true;
      paragraph.push(line);
    } else if (line.trim() === '') {
      if (collecting && paragraph.length > 0) {
        result.push(paragraph.join('\n'));
        paragraph = [];
        collecting = false;
      }
    } else if (collecting) {
      paragraph.push(line);
    }
  }
  
  if (collecting && paragraph.length > 0) {
    result.push(paragraph.join('\n'));
  }
  
  return result;
}