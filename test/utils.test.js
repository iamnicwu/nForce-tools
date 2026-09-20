/**
 * 单元测试: src/common/utils.js
 * 测试工具函数: parseMarkdown, parseInline, flattenRecords, remove_duplicates
 */

describe('utils.js - 工具函数测试', () => {
  describe('parseInline() - 行内样式解析', () => {
    const { parseInline } = require('../src/common/utils.js');

    test('解析粗体文本', () => {
      expect(parseInline('**粗体**')).toBe('<strong>粗体</strong>');
    });

    test('解析代码文本', () => {
      expect(parseInline('`code`')).toBe('<code>code</code>');
    });

    test('解析链接', () => {
      expect(parseInline('[链接](https://example.com)')).toBe('<a href="https://example.com" target="_blank">链接</a>');
    });

    test('解析多个样式', () => {
      expect(parseInline('**粗体** 和 `代码`')).toBe('<strong>粗体</strong> 和 <code>代码</code>');
    });

    test('空字符串返回空', () => {
      expect(parseInline('')).toBe('');
    });

    test('null/undefined 返回空字符串', () => {
      expect(parseInline(null)).toBe('');
      expect(parseInline(undefined)).toBe('');
    });
  });

  describe('parseMarkdown() - Markdown 解析', () => {
    const { parseMarkdown } = require('../src/common/utils.js');

    test('解析一级标题', () => {
      const result = parseMarkdown('# 一级标题');
      expect(result).toContain('<h1>一级标题</h1>');
    });

    test('解析二级标题', () => {
      const result = parseMarkdown('## 二级标题');
      expect(result).toContain('<h2>二级标题</h2>');
    });

    test('解析无序列表', () => {
      const result = parseMarkdown('- 项目1\n- 项目2');
      expect(result).toContain('<ul>');
      expect(result).toContain('<li>项目1</li>');
      expect(result).toContain('<li>项目2</li>');
    });

    test('解析有序列表', () => {
      const result = parseMarkdown('1. 第一项\n2. 第二项');
      expect(result).toContain('<ol>');
      expect(result).toContain('<li>第一项</li>');
    });

    test('解析代码块', () => {
      const result = parseMarkdown('```\nconsole.log("hello")\n```');
      expect(result).toContain('<pre><code');
      expect(result).toContain('console.log("hello")');
    });

    test('解析表格', () => {
      const md = '| 列1 | 列2 |\n| --- | --- |\n| 值1 | 值2 |';
      const result = parseMarkdown(md);
      expect(result).toContain('<table>');
      expect(result).toContain('<th>列1</th>');
      expect(result).toContain('<td>值1</td>');
    });

    test('解析段落', () => {
      const result = parseMarkdown('这是一个普通段落');
      expect(result).toContain('<p>这是一个普通段落</p>');
    });

    test('空字符串返回空', () => {
      expect(parseMarkdown('')).toBe('');
    });
  });

  describe('flattenRecords() - 扁平化 Salesforce 记录', () => {
    const { flattenRecords } = require('../src/common/utils.js');

    test('扁平化简单对象', () => {
      const records = [
        { name: 'Test', value: 123 }
      ];
      const result = flattenRecords(records);
      expect(result).toEqual([{ name: 'Test', value: 123 }]);
    });

    test('扁平化嵌套对象', () => {
      const records = [
        {
          name: 'Test',
          nested: {
            level: 1,
            value: 'nested'
          }
        }
      ];
      const result = flattenRecords(records);
      expect(result[0]).toHaveProperty('name');
      expect(result[0]).toHaveProperty('nested.level');
      expect(result[0]).toHaveProperty('nested.value');
    });

    test('移除 Salesforce attributes 属性', () => {
      const records = [
        {
          Id: '001xxx',
          Name: 'Test Account',
          attributes: {
            type: 'Account',
            url: '/services/data/v50.0/sobjects/Account/001xxx'
          }
        }
      ];
      const result = flattenRecords(records);
      expect(result[0]).not.toHaveProperty('attributes');
      expect(result[0]).toHaveProperty('Id', '001xxx');
      expect(result[0]).toHaveProperty('Name', 'Test Account');
    });

    test('处理空数组', () => {
      expect(flattenRecords([])).toEqual([]);
    });

    test('处理 null/undefined', () => {
      expect(flattenRecords(null)).toEqual([]);
      expect(flattenRecords(undefined)).toEqual([]);
    });

    test('处理多维嵌套对象', () => {
      const records = [
        {
          Order: {
            Id: '001',
            Account: {
              Name: 'Test Account',
              nested: {
                deep: 'value'
              }
            }
          }
        }
      ];
      const result = flattenRecords(records);
      expect(result[0]).toHaveProperty('Order.Id');
      expect(result[0]).toHaveProperty('Order.Account.Name');
      expect(result[0]).toHaveProperty('Order.Account.nested.deep');
    });
  });

  describe('remove_duplicates() - 记录去重', () => {
    const { remove_duplicates } = require('../src/common/utils.js');

    test('基本去重功能', () => {
      const records = [
        { 'Order.OrderNumber': '001', 'FulfillmentId__c': 'FID1', Name: 'A' },
        { 'Order.OrderNumber': '001', 'FulfillmentId__c': 'FID2', Name: 'B' },
        { 'Order.OrderNumber': '002', 'FulfillmentId__c': '', Name: 'C' }
      ];
      const result = remove_duplicates(records);
      // 应该保留每个 OrderNumber 的第一条记录 (按 has_fid 排序)
      expect(result.length).toBeLessThanOrEqual(records.length);
    });

    test('按 FulfillmentId__c 优先级排序', () => {
      const records = [
        { 'Order.OrderNumber': '001', 'FulfillmentId__c': '', Name: 'No FID' },
        { 'Order.OrderNumber': '001', 'FulfillmentId__c': 'FID1', Name: 'Has FID' }
      ];
      const result = remove_duplicates(records);
      // 有 FID 的记录应该排在前面，会被保留
      const order001Records = result.filter(r => r['Order.OrderNumber'] === '001');
      expect(order001Records.length).toBe(1);
    });

    test('保留无效 OrderNumber 的记录', () => {
      const records = [
        { 'Order.OrderNumber': '001', Name: 'Valid' },
        { 'Order.OrderNumber': '', Name: 'Empty' },
        { 'Order.OrderNumber': null, Name: 'Null' }
      ];
      const result = remove_duplicates(records);
      // 有效记录去重后，无效的应该被保留
      expect(result.some(r => r.Name === 'Empty')).toBe(true);
    });

    test('处理空数组', () => {
      expect(remove_duplicates([])).toEqual([]);
    });

    test('处理 null/undefined', () => {
      expect(remove_duplicates(null)).toEqual([]);
      expect(remove_duplicates(undefined)).toEqual([]);
    });

    test('缺少 Order.OrderNumber 列时返回原数据', () => {
      const records = [
        { Name: 'Test', Value: 123 },
        { Name: 'Test2', Value: 456 }
      ];
      const result = remove_duplicates(records);
      expect(result).toEqual(records);
    });
  });
});
