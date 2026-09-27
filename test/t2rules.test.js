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

    test('Fulfillment Remark 包含 NORA updated "ORDER ABORT" -> "<orderType> - order abort"', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] NORA updated "ORDER ABORT"'
      }];
      const result = applyT2Rules(data);
      // 备注规则 6.4 返回的是 `orderType + " - order abort"`，不是裸的 "NORA"。
      // 状态规则 3.0.0 / 3.9.0 对同类输入也返回同样的带后缀形式，
      // 三处一致 → 这是刻意的（下游要靠后缀区分"NORA 撤单"与其它 NORA 场景）。
      // 原断言写的 'NORA' 是错的期望值。
      expect(result[0].Action).toBe('COM(PCD) - order abort');
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

    // DRC [21] / [22] 被备注规则 7.1.6 明确判为 N/A。
    // 注意它们**不在** M1_CRITERIA（31/50/28/38/34/40/57/58/65/69/77/79）里，
    // 所以不会走 7.1.1~7.1.3 的 M1 分支，而是直接命中 7.1.6 的 N/A。
    // 同组的 [68]→N/A、[58]→Sales 两条用例一直是绿的，可以互相印证。
    test('Fulfillment Remark 包含 APPOINTMENT CHANGED + DRC: [21] -> N/A', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] APPOINTMENT CHANGED\nDRC: [21] some message'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('N/A');
    });

    test('Fulfillment Remark 包含 APPOINTMENT CHANGED + DRC: [22] -> N/A', () => {
      const data = [{
        'Fulfillment Remark': '[2026-01-01] APPOINTMENT CHANGED\nDRC: [22] some message'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('N/A');
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

    test('Amend Requested + Inventory Fallout 按 Created By 分流', () => {
      // 规则 2.1 / 2.2：Amend Requested + Inventory Fallout 时，
      // Created By 是 integration.user 才回 orderType，否则 N/A。
      // 原测试期望的 'NORA' 属于"张冠李戴"——那是规则 1.5
      // （Ready To Submit + Inventory Fallout）的结果，与 Amend Requested 无关。
      const nonIntegration = applyT2Rules([{
        'Order Status': 'Amend Requested',
        'Fulfillment Status': 'Inventory Fallout'
      }]);
      expect(nonIntegration[0].Action).toBe('N/A');

      const integration = applyT2Rules([{
        'Order Status': 'Amend Requested',
        'Fulfillment Status': 'Inventory Fallout',
        'Created By': 'integration.user'
      }]);
      expect(integration[0].Action).toBe('COM(PCD)');
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

    test('Order.LOB__c 为 FixedLine 时 orderType 为 COM(LTS)', () => {
      // 列名必须是 `Order.LOB__c`：规则引擎只认这一个 key。
      // 它来自 sf_service 的 SOQL `order.LOB__c` 经 flattenRecords 展平后的形状
      // （项目里其它关系字段同理：`Order.OrderNumber`、`Order.CreatedBy.Name`）。
      // 原测试用的裸 `LOB` 是自造列名 → 匹配不上 → lob 恒为 null → 永远 COM(PCD)，
      // 结果这条用例既碰不到 FixedLine 分支，又长期是红的。
      const data = [{
        'Order Status': 'Ready To Submit',
        'Fulfillment Status': 'In Progress',
        'Order.LOB__c': 'FixedLine',
        'Created By': 'integration.user'
      }];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('COM(LTS)');
    });

    test('裸 `LOB` 列不被识别为 LOB（列名契约）', () => {
      // 与上一条互为对照：列名写错时应当静默退化成 COM(PCD)，而不是抛错。
      const data = [{
        'Order Status': 'Ready To Submit',
        'Fulfillment Status': 'In Progress',
        'LOB': 'FixedLine', // ← 错误列名
        'Created By': 'integration.user'
      }];
      expect(applyT2Rules(data)[0].Action).toBe('COM(PCD)');
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
    // 契约先讲清楚，避免这组用例再退化成一堆 `toBeDefined()`：
    //   · `Action` **只在规则命中时才写**。没命中就没有这个 key（值为 undefined），
    //     这不是 bug —— 引擎正是靠"有没有命中"来决定要不要填 Action 列。
    //   · `Debug_Log` **无论命中与否都会写**，用于事后解释"为什么这行没分类"。
    //   · 备注按 /\n+(?=\[)/ 切分：只有"换行 + 紧跟 [ 时间戳"才算分段，
    //     所以多条备注之间夹任意个换行都会被切成独立段落。
    test('无规则命中时不写 Action，但一定写 Debug_Log', () => {
      const cases = [
        '[2026-01-01] First remark\n[2026-01-02] Second remark', // 两条都不命中
        '[2026-01-01] First\n\n\n[2026-01-02] Second',           // 多换行
        '[2026-01-01] Single remark only',                       // 单条
      ];
      for (const remark of cases) {
        const result = applyT2Rules([{ 'Fulfillment Remark': remark }]);
        expect(result[0].Action).toBeUndefined();
        expect(typeof result[0].Debug_Log).toBe('string');
        expect(result[0].Debug_Log).toContain('No Main Rule matched');
      }
    });

    test('只按「第一条备注」判定的规则：CANCELLED 在第一条才命中', () => {
      // 规则 6.1 只检查 remarks[0]，因此同样的关键词换个位置结果就不同。
      // 这一对用例是"分割真的生效了"的直接证据。
      const first = applyT2Rules([{
        'Fulfillment Remark': '[2026-01-01] CANCELLED\n[2026-01-02] Second'
      }]);
      expect(first[0].Action).toBe('N/A');
      expect(first[0].Debug_Log).toContain('First Remark(CANCELLED)');

      const second = applyT2Rules([{
        'Fulfillment Remark': '[2026-01-01] harmless text\n[2026-01-02] CANCELLED'
      }]);
      // 6.x 里没有"任意一条备注含 CANCELLED"的规则，7.x 也没有 → 不命中
      expect(second[0].Action).toBeUndefined();
    });

    test('多条换行符分隔后，第一条仍被正确识别', () => {
      const result = applyT2Rules([{
        'Fulfillment Remark': '[2026-01-01] CANCELLED\n\n\n[2026-01-02] X'
      }]);
      expect(result[0].Action).toBe('N/A');
    });

    test('依赖「第二条备注」的规则 6.5.x', () => {
      const result = applyT2Rules([{
        'Fulfillment Remark': '[2026-01-01] updated "L2JOB ISSUED"\n[2026-01-02] 2N Status: Failed'
      }]);
      expect(result[0].Action).toBe('Sales');
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
      // 第 2 行是 'COM(PCD)' 而不是 'Sales'：状态规则 3.1
      // （In Progress + 缺 Fulfillment/Remark）排在规则 5（Address Approved -> Sales）**之前**，
      // 本行没有备注 → 在 3.1 就被拦下，永远到不了规则 5。
      // 详见下面那条「已知疑点」用例。
      expect(result[1].Action).toBe('COM(PCD)');
      expect(result[2].Action).toBe('N/A');
    });

    test('已知疑点：规则 3.1 会遮蔽规则 5（Address Approved -> Sales）', () => {
      // 这不是"测试写错了"，而是**实现里疑似存在的规则排序缺陷**，此处刻意把现状钉住，
      // 以便将来真的改规则时能一眼看到行为变了。判定依据：
      //   · 规则 3.1 `if (!fulfillStatus || !fulfillRemark) return orderType;` 位于第 435 行；
      //   · 规则 5 `['Address Approved','Address Check SB Assigned'].includes(fulfillStatus)` 位于第 562 行；
      //   · 只要 fulfillStatus 为 'Address Approved' 且备注为空，3.1 必然先命中 →
      //     规则 5 的 'Address Approved' 分支在"无备注"时是不可达的死分支。
      // 同文件里另有一处 `// 逻辑有问题, 后面再睇` 的注释（规则 3.1.0），说明作者当时已存疑。
      // ⚠️ 修它等于改业务判定，必须由业务方确认后再动，不要顺手改。
      const noRemark = applyT2Rules([{
        'Order Status': 'In Progress',
        'Fulfillment Status': 'Address Approved'
      }]);
      expect(noRemark[0].Action).toBe('COM(PCD)'); // 现状（疑似应为 Sales）

      // 带上任意备注后绕开 3.1，就能走到规则 5 —— 这也印证了上面的归因
      const withRemark = applyT2Rules([{
        'Order Status': 'In Progress',
        'Fulfillment Status': 'Address Approved',
        'Fulfillment Remark': '[2026-01-01] some note'
      }]);
      expect(withRemark[0].Action).toBe('Sales');
    });

    test('行对象是原地改写的（不是深拷贝）—— 调用方必须用返回值', () => {
      // 契约：runRuleEngine 返回**新数组**，但数组里的行对象是**原对象本身**，
      // 会被直接写上 Action / Debug_Log（与原实现一致，也是刻意的）。
      // 之所以不做深拷贝：单批可达数千行 × 几十列，逐行拷贝的内存/耗时都不划算，
      // 而现有 5 个调用方（sf_service 4 处、logic.js 1 处）全部只用返回值。
      // ⚠️ 新增调用方时不要沿用入参，务必使用返回值。
      const originalData = [{
        'Order Status': 'Ready To Submit',
        'Fulfillment Status': 'In Progress',
        'Created By': 'integration.user'
      }];
      const returned = applyT2Rules(originalData);

      expect(returned).not.toBe(originalData);       // 数组是新的
      expect(returned[0]).toBe(originalData[0]);     // 行对象是同一个引用
      expect(originalData[0].Action).toBe('COM(PCD)');   // 入参已被写脏
      expect(originalData[0].Debug_Log).toBeDefined();
    });
  });

  describe('回归：行结构不一致 / 非字符串备注', () => {
    test('首行缺少某列时，后续行的该列仍必须能读到', () => {
      // 回归用例（2026-09-27）：列名索引曾只按**首行**建立一份。
      // 于是首行没有 `Fulfillment Remark` 时，后面每一行的备注都读成 null，
      // 备注类规则（6.x / 7.x）**全部静默失效**。
      // 真实触发路径：XLSX 上传的表格首行该单元格为空；或 Salesforce 里首条
      // 记录的 FulfillmentRemark__c 为 null。
      // 旧实现 getValue 每次 Object.keys(row)，天然按行解析，不会踩到。
      const data = [
        { 'Order Status': 'Ready To Submit', 'Fulfillment Status': 'In Progress', 'Created By': 'integration.user' },
        { 'Fulfillment Remark': 'CANCELLED' }
      ];
      const result = applyT2Rules(data);
      expect(result[0].Action).toBe('COM(PCD)');
      expect(result[1].Action).toBe('N/A');          // ← 曾退化成 undefined
      expect(result[1].Debug_Log).toContain('First Remark(CANCELLED)');
    });

    test('备注为 null / 数字时不得抛错（把崩溃降级为判定结果）', () => {
      // 回归用例（2026-09-27）：这些字段直接 `.includes(...)`，
      // 遇到 Salesforce 的 null 空字段或 Excel 解析出的数字就抛 TypeError，
      // 让**整批订单的分析**中断（外层只提示"分析失败"）。
      const cases = [
        { 'Order Status': 'Ready To Submit', 'Fulfillment Status': 'Inventory Fallout', 'Fulfillment Remark': null },
        { 'Order Status': 'Ready To Submit', 'Fulfillment Status': 'Inventory Fallout' },                        // 连列都没有
        { 'Order Status': 'Ready To Submit', 'Fulfillment Status': 'Waiting For Inventory', 'Fulfillment Remark': 12345 },
        { 'Order Status': 'Ready To Submit', 'Fulfillment Status': 'Inventory Fallout', 'Fulfillment Remark': ['a'] },
        { 'Order Status': 'In Progress', 'Order Nature': 'Resumption', 'Order.LOB__c': 'FixedLine', 'FulfillmentDetail': null },
      ];
      for (const row of cases) {
        const input = [JSON.parse(JSON.stringify(row))];
        expect(() => applyT2Rules(input)).not.toThrow();
        expect(input[0].Debug_Log).toBeDefined();
      }
      // 非字符串一律视为"不包含关键词" → 退回该分支的兜底动作
      expect(applyT2Rules([cases[0]])[0].Action).toBe('NORA');
      expect(applyT2Rules([cases[4]])[0].Action).toBe('N/A');
    });
  });
});
