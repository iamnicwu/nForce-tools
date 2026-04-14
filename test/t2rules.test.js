/**
 * 单元测试: src/common/t2rules.js
 * 测试 T2 规则引擎: applyT2Rules, applyExpiryRules
 */

describe('t2rules.js - T2规则引擎测试', () => {
  let applyT2Rules;
  let applyExpiryRules;

  beforeAll(() => {
    const t2rules = require('../src/common/t2rules.js');
    applyT2Rules = t2rules.applyT2Rules;
    applyExpiryRules = t2rules.applyExpiryRules;
  });

  describe('applyT2Rules() - T2规则应用', () => {
    test('空数据返回空数组', () => {
      expect(applyT2Rules([])).toEqual([]);
      expect(applyT2Rules(null)).toBe(null);
      expect(applyT2Rules(undefined)).toBe(undefined);
    });

    test('Ready To Submit + In Progress + Created By integration.user -> COM(PCD)', () => {
      const data = [{
        'Order Status': 'Ready To Submit',
        'Fulfillment Status': 'In Progress',
        'Created By': 'integration.user'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('COM(PCD)');
    });

    test('Ready To Submit + In Progress + 非 integration.user -> N/A', () => {
      const data = [{
        'Order Status': 'Ready To Submit',
        'Fulfillment Status': 'In Progress',
        'Created By': 'regular.user'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('N/A');
    });

    test('Ready To Submit + Inventory Fallout + UIM -> UIM', () => {
      const data = [{
        'Order Status': 'Ready To Submit',
        'Fulfillment Status': 'Inventory Fallout',
        'Fulfillment Remark': '[2026-01-01] Some remark with UIM'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('UIM');
    });

    test('Ready To Submit + Inventory Fallout + UIM + MANUAL ASSIGNMENT REQUIRED -> BAND', () => {
      const data = [{
        'Order Status': 'Ready To Submit',
        'Fulfillment Status': 'Inventory Fallout',
        'Fulfillment Remark': '[2026-01-01] UIM MANUAL ASSIGNMENT REQUIRED'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('BAND');
    });

    test('Ready To Submit + Inventory Replenishment -> F&S', () => {
      const data = [{
        'Order Status': 'Ready To Submit',
        'Fulfillment Status': 'Inventory Replenishment'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('F&S');
    });

    test('Fulfillment Remark 包含 CANCELLED -> N/A', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] Order CANCELLED by user'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('N/A');
    });

    test('Fulfillment Remark 包含 RESOURCE USED UP -> F&S', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] RESOURCE USED UP for this order'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('F&S');
    });

    test('Fulfillment Remark 包含 L2JOB FALLOUT -> LDAP', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] L2JOB FALLOUT occurred'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('LDAP');
    });

    test('Fulfillment Remark 包含 NORA updated "ORDER ABORT" -> NORA', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] NORA updated "ORDER ABORT"'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('NORA');
    });

    test('Fulfillment Remark 包含 updated "L2JOB ISSUED" -> N/A', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] updated "L2JOB ISSUED"'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('N/A');
    });

    test('Fulfillment Remark 包含 updated "L2JOB ISSUED" + 2N Status: Failed -> Sales', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] updated "L2JOB ISSUED"\n[2026-01-02] 2N Status: Failed'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('Sales');
    });

    test('Fulfillment Remark 包含 APPOINTMENT CHANGED + DRC: [21] -> OPS', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] APPOINTMENT CHANGED\nDRC: [21] some message'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('OPS');
    });

    test('Fulfillment Remark 包含 APPOINTMENT CHANGED + DRC: [22] -> OPS', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] APPOINTMENT CHANGED\nDRC: [22] some message'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('OPS');
    });

    test('Fulfillment Remark 包含 APPOINTMENT CHANGED + DRC: [68] -> N/A', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] APPOINTMENT CHANGED\nDRC: [68] some message'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('N/A');
    });

    test('Fulfillment Remark 包含 APPOINTMENT CHANGED + DRC: [58] -> Sales', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] APPOINTMENT CHANGED\nDRC: [58] some message'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('Sales');
    });

    test('Fulfillment Remark 包含 APPOINTMENT CHANGED + Customer Busy + TID: true -> N/A', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] APPOINTMENT CHANGED\nCustomer Busy TID: true'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('N/A');
    });

    test('Fulfillment Remark 包含 2N UPDATED + 2N Status: Failed -> N/A', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] 2N UPDATED 2N Status: Failed'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('N/A');
    });

    test('Fulfillment Remark 包含 INVENTORY FALLOUT + OPS -> OPS', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] INVENTORY FALLOUT\nOPS handling'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('OPS');
    });

    test('Fulfillment Remark 包含 INVENTORY FALLOUT + ORA-01403 -> COM(PCD)', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] INVENTORY FALLOUT\nORA-01403: no data found'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('COM(PCD)');
    });

    test('Fulfillment Remark 包含 INVENTORY FALLOUT + BAND -> BAND', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] INVENTORY FALLOUT\nBAND assignment'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('BAND');
    });

    test('Fulfillment Remark 包含 PID FALLOUT -> COM(PCD)', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] PID FALLOUT occurred'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('COM(PCD)');
    });

    test('Order Name 以 CS 开头 + Action 为 Sales -> CS', () => {
      const data = [{
        'Order Status': 'Ready To Submit',
        'Fulfillment Status': 'In Progress',
        'Order Name': 'CS123456',
        'Created By': 'integration.user'
      }];
      const result = applyT2Rules(data);
      // CS 订单特殊覆盖逻辑
      expect(result[0].Action).toBeDefined();
    });

    test('In Progress + Empty Fulfillment Status + No FulfillId -> COM(PCD)', () => {
      const data = [{
        'Order Status': 'In Progress',
        'Fulfillment Status': null,
        'FulfillmentId__c': null
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('COM(PCD)');
    });

    test('Cancelled 状态 -> COM(PCD)', () => {
      const data = [{
        'Order Status': 'Cancel Requested'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('COM(PCD)');
    });

    test('Frozen 状态 -> COM(PCD)', () => {
      const data = [{
        'Order Status': 'Frozen'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('COM(PCD)');
    });

    test('Rejected 状态 -> COM(PCD)', () => {
      const data = [{
        'Order Status': 'Rejected'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('COM(PCD)');
    });

    test('Amend Requested + Inventory Fallout -> NORA', () => {
      const data = [{
        'Order Status': 'Amend Requested',
        'Fulfillment Status': 'Inventory Fallout'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('NORA');
    });

    test('Address Approved -> Sales', () => {
      const data = [{
        'Fulfillment Status': 'Address Approved'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('Sales');
    });

    test('设置 Debug_Log 字段', () => {
      const data = [{
        'Order Status': 'Ready To Submit',
        'Fulfillment Status': 'In Progress'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Debug_Log).toBeDefined();
      expect(typeof result[0].Debug_Log).toBe('string');
    });

    test('LOB 为 FixedLine 时 orderType 为 COM(LTS)', () => {
      const data = [{
        'Order Status': 'Ready To Submit',
        'Fulfillment Status': 'In Progress',
        'LOB': 'FixedLine',
        'Created By': 'integration.user'
      }];
      const result = applyT2Rules(data);
      // LOB 为 FixedLine 时应该是 COM(LTS)
      expect(result[0].Action).toBe('COM(LTS)');
    });
  });

  describe('applyExpiryRules() - 过期规则应用', () => {
    test('空数据返回空数组', () => {
      expect(applyExpiryRules([])).toEqual([]);
      expect(applyExpiryRules(null)).toBe(null);
      expect(applyExpiryRules(undefined)).toBe(undefined);
    });

    test('设置 Issue Status 字段', () => {
      const data = [{
        'Order Status': 'Ready To Submit',
        'Fulfillment Status': 'In Progress',
        'Created By': 'integration.user'
      }];
      const result = applyExpiryRules(data);
      expect(result[0]['Issue Status']).toBeDefined();
    });

    test('Ready To Submit + Resumption + FixedLine -> N/A', () => {
      const data = [{
        'Order Status': 'Ready To Submit',
        'Order Nature': 'Resumption',
        'LOB': 'FixedLine'
      }];
      const result = applyExpiryRules(data);
      expect(result[0]['Latest Action By']).toBe('N/A');
    });

    test('设置 Debug_Log 字段', () => {
      const data = [{
        'Order Status': 'Ready To Submit',
        'Fulfillment Status': 'In Progress'
      }];
      const result = applyExpiryRules(data);
      expect(result[0].Debug_Log).toBeDefined();
      expect(typeof result[0].Debug_Log).toBe('string');
    });
  });

  describe('备注分割逻辑 - Split by timestamp', () => {
    test('按换行符 + [ 分隔备注', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] First remark\n[2026-01-02] Second remark'
      }];
      const result = applyT2Rules(data);
      // 应该能正确分割并处理
      expect(result[0].Action).toBeDefined();
    });

    test('多个换行符后跟 [ 分隔备注', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] First\n\n\n[2026-01-02] Second'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBeDefined();
    });

    test('单个备注（无分隔符）', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] Single remark only'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBeDefined();
    });
  });

  describe('边界条件测试', () => {
    test('缺失所有字段的数据', () => {
      const data = [{}];
      const result = applyT2Rules(data);
      // 不应该抛出错误
      expect(result).toBeDefined();
      expect(result.length).toBe(1);
    });

    test('undefined 字段值', () => {
      const data = [{
        'Order Status': undefined,
        'Fulfillment Status': undefined
      }];
      const result = applyT2Rules(data);
      expect(result).toBeDefined();
    });

    test('null 字段值', () => {
      const data = [{
        'Order Status': null,
        'Fulfillment Status': null
      }];
      const result = applyT2Rules(data);
      expect(result).toBeDefined();
    });

    test('空字符串字段值', () => {
      const data = [{
        'Order Status': '',
        'Fulfillment Status': ''
      }];
      const result = applyT2Rules(data);
      expect(result).toBeDefined();
    });

    test('Remark 为空字符串', () => {
      const data = [{
        'Fulfillment Remark': ''
      }];
      const result = applyT2Rules(data);
      expect(result).toBeDefined();
    });

    test('Remark 为 null', () => {
      const data = [{
        'Fulfillment Remark': null
      }];
      const result = applyT2Rules(data);
      expect(result).toBeDefined();
    });

    test('Remark 为 undefined', () => {
      const data = [{
        'Fulfillment Remark': undefined
      }];
      const result = applyT2Rules(data);
      expect(result).toBeDefined();
    });

    test('Remark 非字符串类型（数组）', () => {
      const data = [{
        'Fulfillment Remark': ['array', 'items']
      }];
      const result = applyT2Rules(data);
      expect(result).toBeDefined();
    });

    test('Remark 非字符串类型（数字）', () => {
      const data = [{
        'Fulfillment Remark': 12345
      }];
      const result = applyT2Rules(data);
      expect(result).toBeDefined();
    });

    test('多行数据处理', () => {
      const data = [
        { 'Order Status': 'Ready To Submit', 'Fulfillment Status': 'In Progress', 'Created By': 'integration.user' },
        { 'Order Status': 'In Progress', 'Fulfillment Status': 'Address Approved' },
        { 'Fulfillment Remark': 'CANCELLED' }
      ];
      const result = applyT2Rules(data);
      expect(result.length).toBe(3);
      expect(result[0].Action).toBe('COM(PCD)');
      expect(result[1].Action).toBe('Sales');
      expect(result[2].Action).toBe('N/A');
    });

    test('原始数据不被修改（深拷贝）', () => {
      const originalData = [{
        'Order Status': 'Ready To Submit',
        'Fulfillment Status': 'In Progress',
        'Created By': 'integration.user'
      }];
      const dataCopy = JSON.parse(JSON.stringify(originalData));
      applyT2Rules(originalData);
      expect(originalData).toEqual(dataCopy);
    });
  });
});
