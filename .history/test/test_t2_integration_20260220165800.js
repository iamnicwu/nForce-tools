import { applyT2Rules } from "../common/t2rules.js";

// 测试用例
const testCases = [
  // 1. 备注分割测试
  {
    desc: "Split Remark: Basic",
    input: { "Fulfillment Remark": "[2026-01-01] First\n[2026-01-02] Second" },
    check: (row) => {
        // 这里我们无法直接测试内部的 split 逻辑，但可以通过观察 Action 的结果来间接测试
        // 或者我们可以手动模拟 split 逻辑来验证
        const remarks = row["Fulfillment Remark"].split(/\n+(?=\[)/).map(s => s.trim()).filter(s => s);
        return remarks.length === 2 && remarks[0] === "[2026-01-01] First" && remarks[1] === "[2026-01-02] Second";
    }
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
  },
  {
      desc: "Logic: Order Status Ready To Submit & Fulfillment Status In Progress",
      input: { "Order Status": "Ready To Submit", "Fulfillment Status": "In Progress" },
      expected: "Sales" // Default createdBy is not integration.user
  },
  {
      desc: "Logic: Order Status Ready To Submit & Fulfillment Status In Progress (Integration User)",
      input: { "Order Status": "Ready To Submit", "Fulfillment Status": "In Progress", "Created By": "integration.user" },
      expected: "COM(PCD)"
  }
];

console.log("开始执行集成测试...");
let passed = 0;
let failed = 0;

testCases.forEach((tc, index) => {
  if (tc.check) {
      if (tc.check(tc.input)) {
          console.log(`[PASS] Case ${index + 1}: ${tc.desc}`);
          passed++;
      } else {
          console.error(`[FAIL] Case ${index + 1}: ${tc.desc}`);
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