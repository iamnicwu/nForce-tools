// 模拟 applyT2Rules 函数 (从 common/excel_utils.js 复制并稍作调整以适应独立运行)
function applyT2Rules(data) {
  if (!data || data.length === 0) return data;

  const jsonData = JSON.parse(JSON.stringify(data)); // 深拷贝

  const getValue = (row, ...possibleNames) => {
    const keys = Object.keys(row);
    for (const name of possibleNames) {
      let key = keys.find(k => k === name);
      if (key) return row[key];
      const normalize = str => str.toLowerCase().replace(/[\s_]/g, '');
      const target = normalize(name);
      key = keys.find(k => normalize(k) === target);
      if (key) return row[key];
      key = keys.find(k => normalize(k) === normalize(name + '__c'));
      if (key) return row[key];
    }
    return null;
  };

  const setValue = (row, colName, value) => {
    const keys = Object.keys(row);
    let key = keys.find(k => k.toLowerCase() === colName.toLowerCase());
    if (!key) {
      key = colName;
    }
    row[key] = value;
  };

  jsonData.forEach(row => {
    const orderStatus = getValue(row, "Order Status", "Custom_OrderStatus", "Custom_OrderStatus__c");
    const fulfillmentStatus = getValue(row, "Fulfillment Status", "Custom_FulfilmentStatus", "Custom_FulfilmentStatus__c");
    const fulfillmentRemark = getValue(row, "Fulfillment Remark", "FulfillmentRemark", "FulfillmentRemark__c");
    const orderName = getValue(row, "Order Name", "OrderNumber", "Name");
    const createdBy = getValue(row, "Created By", "CreatedBy", "CreatedById");
    const appointmentId = getValue(row, "Appointment ID", "AppointmentId", "Appointment__c");

    let action = null;

    // 1. Check Order.Custom_OrderStatus__c and Order.Custom_FulfilmentStatus__c
    if (orderStatus === "Ready To Submit" && fulfillmentStatus === "In Progress") {
      action = "COM(PCD)";
      if (createdBy !== "integration.user") {
        action = "Sales";
      }
    } else if (orderStatus === "Cancel Requested" && fulfillmentStatus === "In Progress") {
      action = "COM(PCD)";
    } else if (orderStatus === "Ready To Submit" && fulfillmentStatus === "Appointment Changed (M1)") {
      action = "COM(PCD)";
    } else if (orderStatus === "Ready To Submit" && fulfillmentStatus === "Sales Support Follow-up (M3)") {
      action = "COM(PCD)";
    } else if (orderStatus === "Ready To Submit" && fulfillmentStatus === "Remake Appointment (M1)") {
      action = "COM(PCD)";
    } else if (orderStatus === "Amend Requested" && fulfillmentStatus === "Inventory Fallout") {
      action = "COM(PCD)";
    } else if (orderStatus === "Forzen" || orderStatus === "Rejected") {
      action = "COM(PCD)";
    } else if (orderStatus === "Amend Requested" && (fulfillmentStatus === "Appointment Changed (M1)" || fulfillmentStatus === "Appointment Changed (M2)")) {
      action = "COM(PCD)";
    } else if (orderStatus === "In Progress" && !fulfillmentStatus) {
      action = "COM(PCD)";
    } else if (fulfillmentStatus === "In Progress - Fulfillment Data Issue") {
      action = "COM(PCD)";
    } else if ((fulfillmentStatus === "Appointment Changed (M1)" || fulfillmentStatus === "Appointment Changed (M2)") && !appointmentId) {
      action = "COM(PCD)";
    } else if (orderStatus === "In Progress" && fulfillmentStatus === "F&S Followed") {
      action = "N/A";
    } else if (orderStatus === "In Progress" && fulfillmentStatus === "Inventory Replenishment") {
      action = "F&S";
    } else if (orderStatus === "In Progress" && fulfillmentStatus === "Address Check Sales Follow-up") {
      action = "Sales";
    } else if (orderStatus === "Ready To Submit" && !fulfillmentStatus) {
      action = "N/A";
    } else if (fulfillmentStatus === "Address Approved") {
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
      
      for (const remark of remarks) {
        if (remark.includes("APPOINTMENT CHANGED")) {
          if (remark.includes("DRC: [31]") && orderStatus === "Amend Requested") {
            action = "COM(PCD)";
            break;
          }
          if (remark.includes("DRC: [31]") && (fulfillmentStatus === "Remake Appointment (M1)" || fulfillmentStatus === "Remake Appointment (M2)")) {
            action = "Sales";
            break;
          }
          if (remark.includes("DRC: [31]") && remark.includes("TID: true")) {
            action = "Sales";
            break;
          }
          if (remark.includes("Await Sales Follow Up")) {
            action = "Sales";
            break;
          }
          if (remark.includes("DRC: [50]") && remark.includes("TID: true")) {
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

        if (remark.includes("INVENTORY FALLOUT")) {
          if (remark.includes("OPS")) {
            action = "OPS";
            break;
          }
          if (remark.includes("ORA-01403: no data found")) {
            action = "COM(PCD)";
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
          action = "COM(PCD)";
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

// 测试用例
const testCases = [
  // 1. 备注分割测试
  {
    desc: "Split Remark: Basic",
    input: { "Fulfillment Remark": "[2026-01-01] First\n[2026-01-02] Second" },
    check: (remarks) => remarks.length === 2 && remarks[0] === "[2026-01-01] First" && remarks[1] === "[2026-01-02] Second"
  },
  {
    desc: "Split Remark: Multiple Newlines",
    input: { "Fulfillment Remark": "[2026-01-01] First\n\n\n[2026-01-02] Second" },
    check: (remarks) => remarks.length === 2 && remarks[1] === "[2026-01-02] Second"
  },
  {
    desc: "Split Remark: No Newline before [",
    input: { "Fulfillment Remark": "[2026-01-01] First [2026-01-02] Second" },
    check: (remarks) => remarks.length === 1 // Python re.split requires \n+
  },

  // 2. 逻辑测试
  {
    desc: "Logic: L2JOB ISSUED + 2N Status: Failed",
    input: { "Fulfillment Remark": "[2026-01-01] updated \"L2JOB ISSUED\"\n[2026-01-02] 2N Status: Failed" },
    expected: "Sales"
  },
  {
    desc: "Logic: 2N UPDATED + 2N Status: Failed",
    input: { "Fulfillment Remark": "[2026-01-01] 2N UPDATED 2N Status: Failed" },
    expected: "FS CALL CENTER"
  }
];

console.log("开始执行测试...");
let passed = 0;
let failed = 0;

// 辅助函数：仅测试分割逻辑
function testSplit(remark) {
    return remark.split(/\n+(?=\[)/).map(s => s.trim()).filter(s => s);
}

testCases.forEach((tc, index) => {
  if (tc.check) {
      const remarks = testSplit(tc.input["Fulfillment Remark"]);
      if (tc.check(remarks)) {
          console.log(`[PASS] Case ${index + 1}: ${tc.desc}`);
          passed++;
      } else {
          console.error(`[FAIL] Case ${index + 1}: ${tc.desc}`);
          console.log("Actual remarks:", remarks);
          failed++;
      }
  } else {
      const result = applyT2Rules([tc.input]);
      const actual = result[0].Action;
      
      if (actual === tc.expected) {
        console.log(`[PASS] Case ${index + 1}: ${tc.desc}`);
        passed++;
      } else {
        console.error(`[FAIL] Case ${index + 1}: ${tc.desc}`);
        console.error(`       Expected: ${tc.expected}, Actual: ${actual}`);
        failed++;
      }
  }
});

console.log(`\n测试完成。通过: ${passed}, 失败: ${failed}`);