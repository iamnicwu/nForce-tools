export function applyT2Rules(data) {
  if (!data || data.length === 0) return data;

  const jsonData = [...data];

  jsonData.forEach(row => {
    const ctx = new RuleContext(row);
    let result = null;

    // 1. Main Status Rules
    result = matchMainStatusRules(ctx);

    // 2. Remark Rules (only if no action yet)
    if (!result && ctx.hasRemarks) {
      result = matchRemarkRules(ctx);
    }

    // 3. Special Case: CS Order
    if (result && result.action === "Sales" && ctx.isCSOrder) {
      result.action = "CS";
      ctx.log("Rule 8: Special Case CS Order -> CS");
    }

    // Apply Action
    if (result) {
      ctx.setValue("Action", result.action);
      if (result.log) ctx.log(result.log);
    }
    
    // Always update Debug_Log
    // ctx.setValue("Debug_Log", ctx.getLogs());
  });

  return jsonData;
}

// --- Constants ---

const M1_CRITERIA = [
  "DRC: [31]", "DRC: [50]", "DRC: [28]", "DRC: [38]", "DRC: [34]", 
  "DRC: [40]", "DRC: [57]", "DRC: [58]", "DRC: [65]", "DRC: [69]", 
  "DRC: [77]", "DRC: [79]"
];

// --- Helper Classes ---

class RuleContext {
  constructor(row) {
    this.row = row;
    this.logs = [];
    this.normalizedMap = new Map();
    
    // Build normalized map for fuzzy lookup
    Object.keys(row).forEach(key => {
        this.normalizedMap.set(this.normalize(key), key);
    });

    // Pre-fetch common fields
    this.orderStatus = this.getValue("Order Status", "Custom_OrderStatus", "Custom_OrderStatus__c", "Order.Custom_OrderStatus__c");
    this.fulfillmentStatus = this.getValue("Fulfillment Status", "Custom_FulfilmentStatus", "Custom_FulfilmentStatus__c", "Order.Custom_FulfilmentStatus__c");
    this.fulfillmentRemark = this.getValue("Fulfillment Remark", "FulfillmentRemark", "FulfillmentRemark__c");
    this.fulfillmentId = this.getValue("FulfillmentId__c");
    this.orderName = this.getValue("Order Name", "OrderNumber", "Name", "Order.Name");
    this.orderNature = this.getValue("Order Nature", "OrderNature", "OrderNature__c", "Order.Order_Nature__c");
    this.createdBy = this.getValue("Created By", "CreatedBy", "CreatedById", "Order.CreatedBy.Name");
    this.appointmentId = this.getValue("Appointment ID", "AppointmentId", "Appointment__c", "AppointmentId__c");
    this.lob = this.getValue("LOB", "LOB__c", "Order.LOB__c");

    // Derived properties
    this.orderType = (this.lob === "FixedLine") ? "COM(LTS)" : "COM(PCD)";
    this.isIntegrationUser = (this.createdBy === "integration.user");
    this.isCSOrder = this.orderName && String(this.orderName).startsWith("CS");

    // Parse remarks
    this.remarks = [];
    this.hasM1words = false;
    if (typeof this.fulfillmentRemark === 'string') {
      // Split by newline followed by '['
      this.remarks = this.fulfillmentRemark.split(/\n+(?=\[)/).map(s => s.trim()).filter(s => s);
      this.hasM1words = this.remarks.some(r => M1_CRITERIA.some(k => r.includes(k)));
    }
    this.hasRemarks = this.remarks.length > 0;

    // Initial Log
    this.log(`Init: Status='${this.orderStatus}', Fulfilment='${this.fulfillmentStatus}', RemarkLen=${this.fulfillmentRemark ? this.fulfillmentRemark.length : 0}`);
    if (this.hasM1words) this.log(`Info: Found M1 words in remarks.`);
  }

  normalize(str) {
    return str.toLowerCase().replace(/[\s_]/g, '');
  }

  getValue(...possibleNames) {
    for (const name of possibleNames) {
      let foundKey = null;
      
      // 1. Exact match
      if (Object.prototype.hasOwnProperty.call(this.row, name)) {
        foundKey = name;
      } 
      // 2. Normalized match
      else {
        const norm = this.normalize(name);
        if (this.normalizedMap.has(norm)) {
          foundKey = this.normalizedMap.get(norm);
        } else {
          // 3. __c match
          const normC = this.normalize(name + '__c');
          if (this.normalizedMap.has(normC)) {
            foundKey = this.normalizedMap.get(normC);
          }
        }
      }

      if (foundKey) return this.row[foundKey];
    }
    return null;
  }

  setValue(colName, value) {
    let key = null;
    // Try to find existing key case-insensitive
    for (const k of Object.keys(this.row)) {
        if (k.toLowerCase() === colName.toLowerCase()) {
            key = k;
            break;
        }
    }
    
    if (!key) {
      key = colName;
      // Update map if new key added
      this.normalizedMap.set(this.normalize(key), key);
    }
    this.row[key] = value;
  }

  log(msg) {
    this.logs.push(msg);
  }

  getLogs() {
    return this.logs.join(" | ");
  }
}

// --- Main Status Rules ---

function matchMainStatusRules(ctx) {
  const { orderStatus, fulfillmentStatus } = ctx;

  if (orderStatus === "Ready To Submit") return matchReadyToSubmitRules(ctx);
  if (orderStatus === "Amend Requested") return matchAmendRequestedRules(ctx);
  if (orderStatus === "In Progress") return matchInProgressRules(ctx);
  
  // Rule Group 4: Cancel/Frozen/Rejected/etc
  if (
    orderStatus === "Cancel Requested" ||
    orderStatus === "Frozen" ||
    orderStatus === "Rejected" ||
    fulfillmentStatus === "In Progress - Fulfillment Data Issue" ||
    ((fulfillmentStatus === "Appointment Changed (M1)" || fulfillmentStatus === "Appointment Changed (M2)") && !ctx.appointmentId)
  ) {
    return { action: ctx.orderType, log: `Rule 4: Status='${orderStatus}', Fulfilment='${fulfillmentStatus}', ApptId='${ctx.appointmentId}'` };
  }

  // Rule Group 5: Address Approved
  if (fulfillmentStatus === "Address Approved" || fulfillmentStatus === "Address Check SB Assigned") {
    return { action: "Sales", log: `Rule 5: Fulfilment='${fulfillmentStatus}'` };
  }

  ctx.log(`No Main Rule matched for Status='${orderStatus}', Fulfilment='${fulfillmentStatus}'`);
  return null;
}

function matchReadyToSubmitRules(ctx) {
  const { fulfillmentStatus, isIntegrationUser, orderType, createdBy } = ctx;
  const ret = (action, rule) => ({ action, log: rule });

  if (fulfillmentStatus === "In Progress") {
    if (!isIntegrationUser) return ret("Sales", `Rule 1.1.1: CreatedBy='${createdBy}' (!= integration.user)`);
    return ret(orderType, `Rule 1.1: Status=Ready To Submit, Fulfilment=In Progress`);
  }
  
  if (!fulfillmentStatus) {
    return ret("N/A", `Rule 1.2: Status=Ready To Submit, Fulfilment=Empty`);
  }

  if (fulfillmentStatus === "Remake Appointment (M1)" || fulfillmentStatus === "Appointment Changed (M2)") {
    if (!isIntegrationUser) return ret("Sales", `Rule 1.6.1: CreatedBy='${createdBy}' (!= integration.user)`);
    return ret(orderType, `Rule 1.6.2: CreatedBy='${createdBy}' (= integration.user)`);
  }

  if (fulfillmentStatus === "Appointment Changed (M1)" || fulfillmentStatus === "Sales Support Follow-up (M3)") {
    return ret(orderType, `Rule 1.3: Status=Ready To Submit, Fulfilment='${fulfillmentStatus}'`);
  }

  if (fulfillmentStatus === "Inventory Replenishment") {
    return ret("F&S", `Rule 1.4: Status=Ready To Submit, Fulfilment='${fulfillmentStatus}'`);
  }

  if (fulfillmentStatus === "Inventory Fallout") {
    return ret("NORA", `Rule 1.5: Status=Ready To Submit, Fulfilment='${fulfillmentStatus}'`);
  }

  ctx.log(`Rule 1: Status=Ready To Submit, but Fulfilment='${fulfillmentStatus}' matched no sub-rule.`);
  return null;
}

function matchAmendRequestedRules(ctx) {
  const { fulfillmentStatus, isIntegrationUser, orderType } = ctx;
  const ret = (action, rule) => ({ action, log: rule });

  const targetStatuses = [
    "Inventory Fallout", 
    "Appointment Changed (M1)", 
    "Remake Appointment (M1)", 
    "Appointment Changed (M2)"
  ];
  
  if (targetStatuses.includes(fulfillmentStatus)) {
    if (!isIntegrationUser) return ret("N/A", `Rule 2.1.1: Status=Amend Requested, Fulfilment='${fulfillmentStatus}'`);
    return ret(orderType, `Rule 2.1.2: Status=Amend Requested, Fulfilment='${fulfillmentStatus}'`);
  }

  ctx.log(`Rule 2: Status=Amend Requested, but Fulfilment='${fulfillmentStatus}' matched no sub-rule.`);
  return null;
}

function matchInProgressRules(ctx) {
  const { fulfillmentStatus, fulfillmentId, fulfillmentRemark, orderType } = ctx;
  const ret = (action, rule) => ({ action, log: rule });

  if (!fulfillmentStatus && !fulfillmentId) {
    return ret(orderType, `Rule 3.0: Status=In Progress, Fulfilment='${fulfillmentStatus}', Remark='${fulfillmentRemark ? 'Yes' : 'No'}'`);
  }

  if (!fulfillmentStatus || fulfillmentStatus === "In Progress - Fulfillment Data Issue" || !fulfillmentRemark) {
    return ret(orderType, `Rule 3.1: Status=In Progress, Fulfilment='${fulfillmentStatus}', Remark='${fulfillmentRemark ? 'Yes' : 'No'}'`);
  }


  if (fulfillmentStatus === "F&S Followed") {
    return ret("N/A", `Rule 3.2.2: Status=In Progress, Fulfilment=F&S Followed`);
  }

  if (fulfillmentStatus === "Inventory Replenishment") {
    return ret("F&S", `Rule 3.3: Status=In Progress, Fulfilment=Inventory Replenishment`);
  }

  if (fulfillmentStatus === "Address Check Sales Follow-up") {
    return ret("Sales", `Rule 3.4: Status=In Progress, Fulfilment=Address Check Sales Follow-up`);
  }

  if (fulfillmentStatus === "[F&S] Resources Issues") {
    return ret("F&S", `Rule 3.5: Fulfilment='${fulfillmentStatus}'`);
  }

  if(fulfillmentStatus === "Cancelled"){
    return ret(orderType, `Rule 3.6: Fulfilment='${fulfillmentStatus}'`);
  }

  if(fulfillmentStatus === "In Progress" && fulfillmentRemark.includes("Voice network assignment issue from EIPI (VNDP)(SNORA)")){
    return ret("VNDP", `Rule 3.7: Fulfilment='${fulfillmentStatus}'`);
  }

  ctx.log(`Rule 3: Status=In Progress, but Fulfilment='${fulfillmentStatus}' matched no sub-rule.`);
  return null;
}

// --- Remark Rules ---

function matchRemarkRules(ctx) {
  const { remarks } = ctx;
  let weakAction = null;

  for (let i = 0; i < remarks.length; i++) {
    const remark = remarks[i];

    // 1. Strong Rules (Priority: High)
    const strong = matchStrongRemarkRules(ctx, remark);
    if (strong) return strong;

    // 2. Check "Stop if action set" logic
    if (i === 0) {
      // For the first remark, check Rule 6 (First Remark Rules)
      const rule6 = matchFirstRemarkRules(ctx);
      if (rule6) return rule6;
    } else {
      // For subsequent remarks, if we have a pending weak action, we stop here.
      if (weakAction) return weakAction;
    }

    // 3. Weak Rules (Priority: Low)
    if (remark.includes("ORDER RECEIVED")) {
      weakAction = { action: "N/A", log: "Rule 7.6: ORDER RECEIVED -> N/A" };
    }
  }

  return weakAction;
}

function matchFirstRemarkRules(ctx) {
  const { remarks } = ctx;
  const firstRemark = remarks[0];
  const ret = (action, rule) => ({ action, log: rule });

  if (firstRemark.includes("CANCELLED")) return ret("N/A", `Rule 6.1: First Remark includes CANCELLED`);
  if (firstRemark.includes("RESOURCE USED UP")) return ret("F&S", `Rule 6.2: First Remark includes RESOURCE USED UP`);
  if (firstRemark.includes("L2JOB FALLOUT")) return ret("LDAP", `Rule 6.3: First Remark includes L2JOB FALLOUT`);
  if (firstRemark.includes('NORA updated "ORDER ABORT"')) return ret("NORA", `Rule 6.4: First Remark includes NORA updated "ORDER ABORT"`);
  
  if (firstRemark.includes('updated "L2JOB ISSUED"')) {
    ctx.log(`Rule 6.5: First Remark includes updated "L2JOB ISSUED" -> N/A`);
    if (remarks.length > 1) {
      const secondRemark = remarks[1];
      if (secondRemark.includes("2N Status: Rented")) return ret("N/A", `Rule 6.5.1: Second Remark includes 2N Status: Rented`);
      if (secondRemark.includes("2N Status: Failed")) return ret("Sales", `Rule 6.5.2: Second Remark includes 2N Status: Failed`);
      if (secondRemark.includes("DRC: [33]")) return ret("N/A", `Rule 6.5.3: Second Remark includes DRC: [33]`);
      ctx.log(`Rule 6.5: Second Remark matched no sub-rule.`);
    }
    return ret("N/A", `Rule 6.5: First Remark includes updated "L2JOB ISSUED"`);
  }
  // if(firstRemark.includes('DN Fallout')){
  //   return ret("VDAP", `Rule 6.6: First Remark includes EIPI (VNDP)(SNORA) updated "VDAP"`);
  // }
  return null;
}

function matchStrongRemarkRules(ctx, remark) {
  const { orderType } = ctx;
  const ret = (action, rule) => ({ action, log: rule });

  if (remark.includes("APPOINTMENT CHANGED")) return matchAppointmentChangedRules(ctx, remark);

  // Rule 7.2: 2N UPDATED
  if (remark.includes("2N UPDATED") && (remark.includes("2N Status: Failed") || remark.includes("SEE"))) {
    return ret("FS CALL CENTER", `Rule 7.2: 2N UPDATED + Failed/SEE`);
  }

  // Rule 7.3: INVENTORY FALLOUT
  if (remark.includes("INVENTORY FALLOUT") || remark.includes("Fallout Reason: Cable assignment issue")) {
    if (remark.includes("OPS")) return ret("OPS", `Rule 7.3.1: INVENTORY FALLOUT + OPS`);
    if (remark.includes("ORA-01403: no data found")) return ret(orderType, `Rule 7.3.2: INVENTORY FALLOUT + ORA-01403`);
    if (remark.includes("UIM")) {
      if (remark.includes("MANUAL ASSIGNMENT REQUIRED")) return ret("BAND", `Rule 7.3.3.1: INVENTORY FALLOUT + UIM + MANUAL ASSIGNMENT REQUIRED`);
      return ret("UIM", `Rule 7.3.3: INVENTORY FALLOUT + UIM`);
    }
    if (remark.includes("BAND")) return ret("BAND", `Rule 7.3.4: INVENTORY FALLOUT + BAND`);
  }

  // Rule 7.4: PID FALLOUT
  if (remark.includes("PID FALLOUT")) return ret(orderType, `Rule 7.4: PID FALLOUT`);

  // Rule 7.5: RESOURCE USED UP
  if (remark.includes("RESOURCE USED UP")) return ret("F&S", `Rule 7.5: RESOURCE USED UP`);

  return null;
}

function matchAppointmentChangedRules(ctx, remark) {
  const { hasM1words, orderStatus, fulfillmentStatus, orderType } = ctx;
  const ret = (action, rule) => ({ action, log: rule });

  if (hasM1words) {
    if (orderStatus === "Amend Requested") return ret(orderType, `Rule 7.1.1: APPOINTMENT CHANGED + M1 words + Amend Requested`);
    if (fulfillmentStatus === "Remake Appointment (M1)" || fulfillmentStatus === "Remake Appointment (M2)") return ret("Sales", `Rule 7.1.2: APPOINTMENT CHANGED + M1 words + Remake Appointment`);
    return ret("Sales", `Rule 7.1.3: APPOINTMENT CHANGED + M1 words`);
  }
  if (remark.includes("Await Sales Follow Up")) return ret("Sales", `Rule 7.1.4: APPOINTMENT CHANGED + Await Sales Follow Up`);
  if ((remark.includes("Customer Busy") || remark.includes("await customer")) && remark.includes("TID: true")) return ret("N/A", `Rule 7.1.5: APPOINTMENT CHANGED + Customer Busy/await customer + TID: true`);
  if (remark.includes("DRC: [21]") || remark.includes("DRC: [22]")) return ret("OPS", `Rule 7.1.6: APPOINTMENT CHANGED + DRC: [21]/[22]`);
  if (remark.includes("DRC: [68]")) return ret("FS", `Rule 7.1.7: APPOINTMENT CHANGED + DRC: [68]`);
  if (remark.includes("DRC: [12]")) return ret("N/A", `Rule 7.1.8: APPOINTMENT CHANGED + DRC: [12]`);
  if (remark.includes("DRC: [58]")) return ret("Sales", `Rule 7.1.9: APPOINTMENT CHANGED + DRC: [58]`);
  if (remark.includes("Customer Busy") && remark.includes("TID: false")) return ret("N/A", `Rule 7.1.10: APPOINTMENT CHANGED + Customer Busy + TID: false`);

  return null;
}
