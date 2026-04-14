/**
 * 单元测试: src/common/excel_utils.js
 * 测试 Excel 工具函数: analyzeData, analyzeT2Data, applyRules, getUniqueOrderCount
 */

// Mock the XLSX library
jest.mock('xlsx', () => ({
  utils: {
    json_to_sheet: jest.fn(() => ({})),
    sheet_to_json: jest.fn(() => []),
    book_new: jest.fn(() => ({})),
    book_append_sheet: jest.fn(),
    read: jest.fn()
  },
  writeFile: jest.fn()
}));

// Mock showNotification
jest.mock('../src/common/utils.js', () => ({
  showNotification: jest.fn()
}));

describe('excel_utils.js - Excel工具函数测试', () => {
  let analyzeData;
  let analyzeT2Data;
  let applyRules;
  let getUniqueOrderCount;

  beforeAll(() => {
    const excelUtils = require('../src/common/excel_utils.js');
    analyzeData = excelUtils.analyzeData;
    analyzeT2Data = excelUtils.analyzeT2Data;
    applyRules = excelUtils.applyRules;
    getUniqueOrderCount = excelUtils.getUniqueOrderCount;
  });

  describe('analyzeData() - 数据分析', () => {
    test('空数据返回空数组', () => {
      expect(analyzeData([])).toEqual([]);
      expect(analyzeData(null)).toBe(null);
      expect(analyzeData(undefined)).toBe(undefined);
    });

    test('Order Status 为 Activated -> Issue Status = Fixed', () => {
      const data = [{
        'Order Status': 'Activated',
        'Order Number': '001'
      }];
      const result = analyzeData(data);
      expect(result[0]['Issue Status']).toBe('Fixed');
    });

    test('Order Status 为 Superseded -> Issue Status = Fixed', () => {
      const data = [{
        'Order Status': 'Superseded',
        'Order Number': '002'
      }];
      const result = analyzeData(data);
      expect(result[0]['Issue Status']).toBe('Fixed');
    });

    test('Order Status 为 Cancelled -> Issue Status = Fixed', () => {
      const data = [{
        'Order Status': 'Cancelled',
        'Order Number': '003'
      }];
      const result = analyzeData(data);
      expect(result[0]['Issue Status']).toBe('Fixed');
    });

    test('Order Status 为 In Progress-Fulfilment Completed -> Issue Status = In progress, Action = RBS', () => {
      const data = [{
        'Order Status': 'In Progress-Fulfilment Completed',
        'Order Number': '004'
      }];
      const result = analyzeData(data);
      expect(result[0]['Issue Status']).toBe('In progress');
      expect(result[0]['Action']).toBe('RBS');
      expect(result[0]['Latest Action By']).toBe('RBS');
    });

    test('Order Status 为 In Progress + Fulfilment Status 为 Remake Appointment (M1) -> Action = Vicki', () => {
      const data = [{
        'Order Status': 'In Progress',
        'Fulfilment Status': 'Remake Appointment (M1)',
        'Order Number': '005'
      }];
      const result = analyzeData(data);
      expect(result[0]['Action']).toBe('Vicki');
      expect(result[0]['Latest Action By']).toBe('Vicki');
      expect(result[0]['Issue Status']).toBe('Waiting for user');
    });

    test('Fulfilment Status 为 F&S Followed -> Latest Action By = F&S', () => {
      const data = [{
        'Fulfilment Status': 'F&S Followed',
        'Order Number': '006'
      }];
      const result = analyzeData(data);
      expect(result[0]['Latest Action By']).toBe('F&S');
      expect(result[0]['Issue Status']).toBe('Waiting for user');
    });

    test('使用自定义规则', () => {
      const customRules = [{
        name: 'Custom Rule',
        conditions: [{
          field: 'Order Status',
          operator: 'equals',
          value: 'Custom'
        }],
        actions: [{
          field: 'Issue Status',
          value: 'Custom Status'
        }]
      }];
      const data = [{
        'Order Status': 'Custom',
        'Order Number': '007'
      }];
      const result = analyzeData(data, customRules);
      expect(result[0]['Issue Status']).toBe('Custom Status');
    });
  });

  describe('applyRules() - 规则应用', () => {
    test('空数据返回原数据', () => {
      expect(applyRules([], [])).toEqual([]);
      expect(applyRules(null, [])).toBe(null);
    });

    test('空规则返回原数据', () => {
      const data = [{ 'Order Status': 'Test' }];
      expect(applyRules(data, [])).toEqual(data);
    });

    test('基本规则 - equals 操作符', () => {
      const data = [{ 'Status': 'Active' }];
      const rules = [{
        name: 'Test Rule',
        conditions: [{
          field: 'Status',
          operator: 'equals',
          value: 'Active'
        }],
        actions: [{
          field: 'Result',
          value: 'Matched'
        }]
      }];
      const result = applyRules(data, rules);
      expect(result[0].Result).toBe('Matched');
    });

    test('基本规则 - in 操作符', () => {
      const data = [{ 'Status': 'Active' }, { 'Status': 'Pending' }];
      const rules = [{
        name: 'Test Rule',
        conditions: [{
          field: 'Status',
          operator: 'in',
          value: ['Active', 'Approved']
        }],
        actions: [{
          field: 'Matched',
          value: 'Yes'
        }]
      }];
      const result = applyRules(data, rules);
      expect(result[0].Matched).toBe('Yes');
      expect(result[1].Matched).toBeUndefined();
    });

    test('基本规则 - contains 操作符', () => {
      const data = [{ 'Description': 'This is an active order' }];
      const rules = [{
        name: 'Test Rule',
        conditions: [{
          field: 'Description',
          operator: 'contains',
          value: 'active'
        }],
        actions: [{
          field: 'ContainsActive',
          value: 'Yes'
        }]
      }];
      const result = applyRules(data, rules);
      expect(result[0].ContainsActive).toBe('Yes');
    });

    test('基本规则 - not_contains 操作符', () => {
      const data = [{ 'Description': 'Completed order' }];
      const rules = [{
        name: 'Test Rule',
        conditions: [{
          field: 'Description',
          operator: 'not_contains',
          value: 'pending'
        }],
        actions: [{
          field: 'NotPending',
          value: 'Yes'
        }]
      }];
      const result = applyRules(data, rules);
      expect(result[0].NotPending).toBe('Yes');
    });

    test('基本规则 - is_empty 操作符', () => {
      const data = [{ 'Status': '' }, { 'Status': 'Active' }];
      const rules = [{
        name: 'Test Rule',
        conditions: [{
          field: 'Status',
          operator: 'is_empty',
          value: true
        }],
        actions: [{
          field: 'EmptyStatus',
          value: 'Marked'
        }]
      }];
      const result = applyRules(data, rules);
      expect(result[0].EmptyStatus).toBe('Marked');
      expect(result[1].EmptyStatus).toBeUndefined();
    });

    test('基本规则 - is_not_empty 操作符', () => {
      const data = [{ 'Status': '' }, { 'Status': 'Active' }];
      const rules = [{
        name: 'Test Rule',
        conditions: [{
          field: 'Status',
          operator: 'is_not_empty',
          value: true
        }],
        actions: [{
          field: 'HasStatus',
          value: 'Yes'
        }]
      }];
      const result = applyRules(data, rules);
      expect(result[0].HasStatus).toBeUndefined();
      expect(result[1].HasStatus).toBe('Yes');
    });

    test('多条件规则 - AND (all) 模式', () => {
      const data = [{ 'Status': 'Active', 'Type': 'VIP' }];
      const rules = [{
        name: 'Test Rule',
        match: 'all',
        conditions: [
          { field: 'Status', operator: 'equals', value: 'Active' },
          { field: 'Type', operator: 'equals', value: 'VIP' }
        ],
        actions: [{
          field: 'VIPActive',
          value: 'Yes'
        }]
      }];
      const result = applyRules(data, rules);
      expect(result[0].VIPActive).toBe('Yes');
    });

    test('多条件规则 - OR (any) 模式', () => {
      const data = [{ 'Status': 'Active', 'Type': 'Normal' }];
      const rules = [{
        name: 'Test Rule',
        match: 'any',
        conditions: [
          { field: 'Status', operator: 'equals', value: 'Active' },
          { field: 'Type', operator: 'equals', value: 'VIP' }
        ],
        actions: [{
          field: 'ActiveOrVIP',
          value: 'Yes'
        }]
      }];
      const result = applyRules(data, rules);
      expect(result[0].ActiveOrVIP).toBe('Yes');
    });

    test('多个动作', () => {
      const data = [{ 'Status': 'Test' }];
      const rules = [{
        name: 'Test Rule',
        conditions: [{
          field: 'Status',
          operator: 'equals',
          value: 'Test'
        }],
        actions: [
          { field: 'Field1', value: 'Value1' },
          { field: 'Field2', value: 'Value2' }
        ]
      }];
      const result = applyRules(data, rules);
      expect(result[0].Field1).toBe('Value1');
      expect(result[0].Field2).toBe('Value2');
    });

    test('规则优先级 - 后续规则可以覆盖', () => {
      const data = [{ 'Status': 'Test' }];
      const rules = [
        {
          name: 'Rule 1',
          conditions: [{
            field: 'Status',
            operator: 'equals',
            value: 'Test'
          }],
          actions: [{ field: 'Priority', value: 'Low' }]
        },
        {
          name: 'Rule 2',
          conditions: [{
            field: 'Status',
            operator: 'equals',
            value: 'Test'
          }],
          actions: [{ field: 'Priority', value: 'High' }]
        }
      ];
      const result = applyRules(data, rules);
      expect(result[0].Priority).toBe('High');
    });

    test('Salesforce 字段名智能匹配 - 去除 __c 后缀', () => {
      const data = [{ 'Order_Status__c': 'Active' }];
      const rules = [{
        name: 'Test Rule',
        conditions: [{
          field: 'Order Status',
          operator: 'equals',
          value: 'Active'
        }],
        actions: [{
          field: 'Matched',
          value: 'Yes'
        }]
      }];
      const result = applyRules(data, rules);
      expect(result[0].Matched).toBe('Yes');
    });

    test('Salesforce 字段名智能匹配 - Order.Field 格式', () => {
      const data = [{ 'Order.Status': 'Active' }];
      const rules = [{
        name: 'Test Rule',
        conditions: [{
          field: 'Order Status',
          operator: 'equals',
          value: 'Active'
        }],
        actions: [{
          field: 'Matched',
          value: 'Yes'
        }]
      }];
      const result = applyRules(data, rules);
      expect(result[0].Matched).toBe('Yes');
    });

    test('规则统计', () => {
      const data = [
        { 'Status': 'Active' },
        { 'Status': 'Active' },
        { 'Status': 'Pending' }
      ];
      const rules = [{
        name: 'Counting Rule',
        conditions: [{
          field: 'Status',
          operator: 'equals',
          value: 'Active'
        }],
        actions: [{ field: 'Counted', value: 'Yes' }]
      }];
      const result = applyRules(data, rules);
      // 前两条应该匹配
      expect(result.filter(r => r.Counted === 'Yes').length).toBe(2);
    });
  });

  describe('analyzeT2Data() - T2数据分析', () => {
    test('空数据返回空数组', () => {
      expect(analyzeT2Data([], [])).toEqual([]);
      expect(analyzeT2Data(null, [])).toBe(null);
    });

    test('空规则返回原数据', () => {
      const data = [{ 'Order Status': 'Test' }];
      expect(analyzeT2Data(data, [])).toEqual(data);
    });

    test('使用规则分析数据', () => {
      const data = [{ 'Status': 'Active' }];
      const rules = [{
        name: 'T2 Rule',
        conditions: [{
          field: 'Status',
          operator: 'equals',
          value: 'Active'
        }],
        actions: [{
          field: 'T2Processed',
          value: 'Yes'
        }]
      }];
      const result = analyzeT2Data(data, rules);
      expect(result[0].T2Processed).toBe('Yes');
    });
  });

  describe('getUniqueOrderCount() - 获取唯一订单号数量', () => {
    test('空数据返回 0', () => {
      expect(getUniqueOrderCount([])).toBe(0);
      expect(getUniqueOrderCount(null)).toBe(0);
      expect(getUniqueOrderCount(undefined)).toBe(0);
    });

    test('基本唯一订单号计数', () => {
      const data = [
        { 'OrderNumber': '001' },
        { 'OrderNumber': '002' },
        { 'OrderNumber': '003' }
      ];
      expect(getUniqueOrderCount(data)).toBe(3);
    });

    test('重复订单号去重', () => {
      const data = [
        { 'OrderNumber': '001' },
        { 'OrderNumber': '002' },
        { 'OrderNumber': '001' },
        { 'OrderNumber': '003' },
        { 'OrderNumber': '002' }
      ];
      expect(getUniqueOrderCount(data)).toBe(3);
    });

    test('不同列名的订单号', () => {
      const data = [
        { 'order number': '001' },
        { 'order number': '002' }
      ];
      expect(getUniqueOrderCount(data)).toBe(2);
    });

    test('忽略空值', () => {
      const data = [
        { 'OrderNumber': '001' },
        { 'OrderNumber': '' },
        { 'OrderNumber': null },
        { 'OrderNumber': undefined },
        { 'OrderNumber': '002' }
      ];
      expect(getUniqueOrderCount(data)).toBe(2);
    });

    test('带空行的数据', () => {
      const data = [
        { 'OrderNumber': '001' },
        { 'OrderNumber': '   ' },
        { 'OrderNumber': '002' }
      ];
      expect(getUniqueOrderCount(data)).toBe(2);
    });
  });
});
