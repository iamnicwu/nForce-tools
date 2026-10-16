/**
 * 单元测试: `common/order_query.js` —— 值识别与 SOQL 拼装
 *
 * 这里的**核心风险是识别判宽了**：搜索框一打开就被合成条目顶上第一条，
 * 用户搜功能（`t4list` / `wucan` / `bulk`）反而找不到东西。
 * 所以下面一半用例是在钉"什么**不该**被识别成 Order 值"。
 */
import {
  detectOrderQuery,
  classifyOrderValue,
  buildOrderWhere,
  buildOrderSoql,
  buildHistorySoql,
  historyRows,
  HISTORY_COLUMNS,
  orderFieldGrid,
  orderFieldColumnWidths,
  oneLineSoql,
  soqlErrorHint
} from "../src/common/order_query.js";

describe("detectOrderQuery（决定要不要在搜索结果里插「查询 Order 历史」）", () => {
  test("认：15/18 位 Salesforce Id", () => {
    expect(detectOrderQuery("801000000000001AAA")).toEqual({ value: "801000000000001AAA", kind: "id" });
    expect(detectOrderQuery("801000000000001")).toEqual({ value: "801000000000001", kind: "id" });
  });

  test("认：纯数字单号（首尾空格要吃掉）", () => {
    expect(detectOrderQuery("  00012345  ")).toEqual({ value: "00012345", kind: "number" });
  });

  test("认：带连字符/下划线且含数字的业务号", () => {
    expect(detectOrderQuery("ORD-2026-0001").kind).toBe("code");
    expect(detectOrderQuery("PCCW_0001").kind).toBe("code");
  });

  test("认：`#` 前缀强制当订单值（用户明确表达时不受形状限制）", () => {
    expect(detectOrderQuery("#MYORDER")).toEqual({ value: "MYORDER", kind: "code" });
  });

  test("不认：普通功能关键词（这是最要紧的一条 —— 判宽了等于毁了搜索）", () => {
    ["t4list", "wucan", "bulk", "lunch", "soql", "org", "settings", "prefs"].forEach((q) => {
      expect(detectOrderQuery(q)).toBeNull();
    });
  });

  test("不认：太短的纯数字、以及空串 / 只有分隔符", () => {
    expect(detectOrderQuery("12")).toBeNull();
    expect(detectOrderQuery("")).toBeNull();
    expect(detectOrderQuery("   ")).toBeNull();
    expect(detectOrderQuery("-")).toBeNull();
    expect(detectOrderQuery("#")).toBeNull();
  });
});

describe("classifyOrderValue（表单里用户明确要查，所以不做形状限制）", () => {
  test("认不出来的形状也照查，kind 归 any（不拼 Id 条件）", () => {
    expect(classifyOrderValue("MYORDER")).toEqual({ value: "MYORDER", kind: "any" });
  });
});

describe("SOQL 拼装", () => {
  test("Id 只在 kind=id 时进 WHERE（避免 MALFORMED_ID）", () => {
    expect(buildOrderWhere({ value: "00012345", kind: "number" })).toBe(
      "OrderNumber = '00012345' OR Name = '00012345'"
    );
    expect(buildOrderWhere({ value: "801000000000001AAA", kind: "id" })).toBe(
      "Id = '801000000000001AAA' OR OrderNumber = '801000000000001AAA' OR Name = '801000000000001AAA'"
    );
  });

  test("单引号与反斜杠被转义（否则就是 SOQL 语法错，还是个注入面）", () => {
    expect(buildOrderWhere({ value: "O'Brien", kind: "any" })).toBe(
      "OrderNumber = 'O\\'Brien' OR Name = 'O\\'Brien'"
    );
    expect(buildOrderWhere({ value: "a\\b", kind: "any" })).toContain("a\\\\b");
  });

  test("找单：带 Name 与降级版（个别 org 没有 Order.Name）", () => {
    const withName = buildOrderSoql({ value: "00012345", kind: "number" });
    expect(withName).toContain("SELECT Id, OrderNumber, Name, Custom_OrderStatus__c FROM Order");
    expect(withName).toMatch(/LIMIT 5$/);
    const without = buildOrderSoql({ value: "00012345", kind: "number" }, { includeName: false });
    expect(without).not.toContain("Name,");
    expect(without).toContain("OrderNumber = '00012345'");
  });

  test("查历史：父字段用 OrderId（标准对象历史对象的命名），倒序，带上操作人", () => {
    const soql = buildHistorySoql("801000000000001AAA", 50);
    expect(soql).toContain("FROM OrderHistory");
    // ⚠️ 父字段是 OrderId：标准对象的字段历史对象用「对象名 + Id」——
    //    AccountHistory.AccountId / ContactHistory.ContactId / OrderHistory.OrderId；
    //    ParentId 那套是自定义对象 __History 用的。
    //    （2026-10-16：我按猜测要过 ParentId，用户已在真 org 确认是 OrderId。）
    expect(soql).toContain("OrderId = '801000000000001AAA'");
    expect(soql).not.toContain("ParentId");
    // 父字段不进 SELECT（界面用不到：父记录就是当前查的这张单）
    expect(soql).toContain("SELECT Id, Field, OldValue");
    expect(soql).toContain("CreatedBy.Name");
    expect(soql).toContain("ORDER BY CreatedDate DESC");
    expect(soql).toMatch(/LIMIT 50$/);
    // 默认上限
    expect(buildHistorySoql("801000000000001AAA")).toMatch(/LIMIT 200$/);
  });
});

describe("historyRows（表格行）", () => {
  const fmt = (v) => (v ? String(v).slice(0, 10) : "");
  test("中文列名 + 关系字段展平 + 空值给空串（不是 undefined）", () => {
    const rows = historyRows(
      [
        {
          Field: "Custom_OrderStatus__c",
          OldValue: "Draft",
          NewValue: "Submitted",
          CreatedDate: "2026-10-14T02:15:00.000+0000",
          CreatedBy: { Name: "预览用户" }
        },
        { Field: "Attention__c", OldValue: null, NewValue: "true", CreatedDate: "2026-10-15T01:05:00.000+0000" }
      ],
      fmt
    );
    expect(rows).toHaveLength(2);
    expect(Object.keys(rows[0])).toEqual([...HISTORY_COLUMNS]);
    // ⚠️ 顺序是**倒序**（晚的在前）—— 见下面那条「自己按 CreatedDate 倒序」的用例
    expect(rows[0]).toEqual({
      时间: "2026-10-15",
      字段: "Attention__c",
      旧值: "",
      新值: "true",
      操作人: ""
    });
    // 空值 / 缺 CreatedBy 都不能变成 "undefined" 或 "null"
    expect(rows[0].旧值).toBe("");
    expect(rows[0].操作人).toBe("");
    expect(rows[1]).toEqual({
      时间: "2026-10-14",
      字段: "Custom_OrderStatus__c",
      旧值: "Draft",
      新值: "Submitted",
      操作人: "预览用户"
    });
  });

  test("非数组输入不炸（防御性）", () => {
    expect(historyRows(null, fmt)).toEqual([]);
    expect(historyRows(undefined, fmt)).toEqual([]);
  });

  test("自己按 CreatedDate 倒序，不依赖服务端顺序（乱序进、倒序出）", () => {
    const rows = historyRows(
      [
        { Field: "A", CreatedDate: "2026-10-14T02:00:00.000+0000" },
        { Field: "C", CreatedDate: "2026-10-16T09:00:00.000+0000" },
        { Field: "B", CreatedDate: "2026-10-15T00:00:00.000+0000" }
      ],
      fmt
    );
    expect(rows.map((r) => r.字段)).toEqual(["C", "B", "A"]);
  });

  test("时间不可解析时退回字符串比较（顺序仍然确定，不是随机）", () => {
    // 注意：输入是**Salesforce 记录**，字段名是 Field（不是中文化的 字段）
    const rows = historyRows(
      [{ Field: "old", CreatedDate: "" }, { Field: "new", CreatedDate: "not-a-date" }],
      fmt
    );
    expect(rows.map((r) => r.字段)).toEqual(["new", "old"]);
  });
});

describe("oneLineSoql / soqlErrorHint（诊断日志里的两个纯函数）", () => {
  test("SOQL 收成一行：多行写法要能变成可直接粘进 Developer Console 的一行", () => {
    expect(oneLineSoql("SELECT Id,\n   Name\nFROM Order\nWHERE Id = 'x'")).toBe(
      "SELECT Id, Name FROM Order WHERE Id = 'x'"
    );
    expect(oneLineSoql("  SELECT 1  ")).toBe("SELECT 1");
    expect(oneLineSoql(null)).toBe("");
    expect(oneLineSoql(undefined)).toBe("");
  });

  test("errorCode → 「下一步该做什么」（日志只说明失败，用户要的是改哪里）", () => {
    expect(soqlErrorHint("INVALID_TYPE")).toContain("字段历史追踪");
    expect(soqlErrorHint("INVALID_FIELD")).toContain("字段");
    expect(soqlErrorHint("MALFORMED_QUERY")).toContain("LIMIT");
    expect(soqlErrorHint("INSUFFICIENT_ACCESS")).toContain("权限");
    expect(soqlErrorHint("INSUFFICIENT_ACCESS_OR_READONLY")).toContain("权限");
    expect(soqlErrorHint("INVALID_SESSION_ID")).toContain("重连");
    expect(soqlErrorHint("NOT_FOUND")).toContain("API 版本");
    expect(soqlErrorHint("NO_CONNECTION")).toContain("连接");
  });

  test("没有 errorCode 时按文案兜底；都不认识也给一条通用的可执行建议", () => {
    expect(soqlErrorHint(null, "Failed to fetch")).toContain("网络");
    expect(soqlErrorHint(undefined, "sObject type 'OrderFoo' is not supported.")).toContain("字段历史追踪");
    expect(soqlErrorHint("WHATEVER", "something odd")).toContain("Developer Console");
    expect(soqlErrorHint()).toContain("Developer Console");
  });
});

describe("orderFieldGrid（Order 字段：一条记录一行）", () => {
  const record = {
    Id: "801000000000001AAA",
    OrderNumber: "00012345",
    Name: "ORD-2026-0001",
    Attention__c: true,
    Account: { Id: "001000000000001AAA", Name: "预览客户" },
    FulfillmentRemark__c: "",
    BRM_Request_Id__c: null,
    attributes: { type: "Order" }
  };

  test("一条记录一行：单条记录 → 1 行；列 = 行标识 + 该记录的字段（按 API 名排序）", () => {
    const grid = orderFieldGrid(record);
    expect(grid.rows).toHaveLength(1);
    expect(grid.columns).toEqual([
      "Order",
      "Account",
      "Attention__c",
      "BRM_Request_Id__c",
      "FulfillmentRemark__c",
      "Id",
      "Name",
      "OrderNumber"
    ]);
    // attributes 是 SOQL 的类型元信息，不该变成一列
    expect(grid.columns).not.toContain("attributes");
    // 第一列的「行标识」默认取单号（没有单号才退回 Id）
    expect(grid.rows[0].Order).toBe("00012345");
    // 关系字段取 Name，不能是 [object Object]
    expect(grid.rows[0].Account).toBe("预览客户");
  });

  test("空值给空串（不是 null / undefined 文本），并统计为空的数量", () => {
    const grid = orderFieldGrid(record);
    expect(grid.rows[0].FulfillmentRemark__c).toBe("");
    expect(grid.rows[0].BRM_Request_Id__c).toBe("");
    expect(grid.fieldCount).toBe(7); // 8 个键 - attributes
    expect(grid.emptyCount).toBe(2);
  });

  test("多条记录 → 多行；列取并集（缺的列留空，不错位）", () => {
    const grid = orderFieldGrid([
      { Id: "A", OrderNumber: "0001", LOB__c: "FixedLine" },
      { Id: "B", OrderNumber: "0002", Attention__c: true }
    ]);
    expect(grid.rows).toHaveLength(2);
    expect(grid.columns).toEqual(["Order", "Attention__c", "Id", "LOB__c", "OrderNumber"]);
    expect(grid.rows[0].LOB__c).toBe("FixedLine");
    expect(grid.rows[0].Attention__c).toBe("");
    expect(grid.rows[1].Attention__c).toBe("true");
    expect(grid.rows[1].LOB__c).toBe("");
    expect(grid.rows.map((r) => r.Order)).toEqual(["0001", "0002"]);
  });

  test("没有单号时行标识退回 Id；空输入返回空网格（调用方不用判空数组）", () => {
    expect(orderFieldGrid({ Id: "8010", LOB__c: "x" }).rows[0].Order).toBe("8010");
    const empty = orderFieldGrid([]);
    expect(empty).toEqual({ columns: [], rows: [], fieldCount: 0, emptyCount: 0 });
    expect(orderFieldGrid(null).columns).toEqual([]);
  });

  test("列宽：每一列都要有宽度（固定布局下缺宽度的列会平分剩余 → 几百列时挤成 0）", () => {
    const grid = orderFieldGrid(record);
    const widths = orderFieldColumnWidths(grid.columns);
    grid.columns.forEach((col) => expect(widths[col]).toBeTruthy());
    expect(widths.Order).toBe("10rem");
    expect(widths.Name).toBe("12rem");
  });
});
