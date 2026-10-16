/**
 * 单元测试: src/common/soql_completions.js
 *
 * SOQL 提示与 Apex 提示最大的差别在于**对象名可能在光标后面**：
 * 用户先写 `SELECT ` 再回头挑字段时，`FROM Account` 还没打、或者已经打在了右边 ——
 * 只看光标前的文本会让字段表永远空着。这里把这条钉死，另外覆盖：
 *   · 子句识别（SELECT / FROM / WHERE / ORDER BY / GROUP BY / HAVING）；
 *   · `'from x'` 这类字符串字面量不能被子句解析误认；
 *   · 别名（`FROM Account a` → `a.Name` 要给 Account 的字段）。
 */

describe("soql_completions.js - SOQL 代码提示的纯逻辑", () => {
  const S = require("../src/common/soql_completions.js");

  describe("从整条语句里找 FROM 目标", () => {
    it("基本形态", () => {
      expect(S.findFromTarget("SELECT Id FROM Account").objectName).toBe("Account");
      expect(S.findFromTarget("SELECT Id FROM My_Object__c WHERE Id != null").objectName).toBe("My_Object__c");
    });

    it("识别别名，但不会把 WHERE / ORDER 当成别名", () => {
      expect(S.findFromTarget("SELECT Id FROM Account a WHERE a.Name = 'x'").alias).toBe("a");
      expect(S.findFromTarget("SELECT Id FROM Account WHERE Name = 'x'").alias).toBeNull();
      expect(S.findFromTarget("SELECT Id FROM Account ORDER BY Name").alias).toBeNull();
    });

    it("字符串里的 `from` 不算（`WHERE Name = 'from x'`）", () => {
      expect(S.findFromTarget("SELECT Id FROM Account WHERE Name = 'from x'").objectName).toBe("Account");
      expect(S.findFromTarget("SELECT Id WHERE Name = 'from x'").objectName).toBeNull();
    });

    it("没有 FROM 时返回 null（此时只能给函数与关键字）", () => {
      expect(S.findFromTarget("SELECT Id, Na").objectName).toBeNull();
    });
  });

  describe("子句识别", () => {
    it("按光标前最后一个子句关键字判定", () => {
      const sql = "SELECT Id FROM Account WHERE Name = 'x' ORDER BY CreatedDate DESC";
      expect(S.findClause(sql, "SELECT Id".length)).toBe("SELECT");
      expect(S.findClause(sql, "SELECT Id FROM Acc".length)).toBe("FROM");
      expect(S.findClause(sql, "SELECT Id FROM Account WHERE Name".length)).toBe("WHERE");
      expect(S.findClause(sql, sql.length)).toBe("ORDER BY");
    });

    it("GROUP BY / HAVING 分开算", () => {
      expect(S.findClause("SELECT COUNT(Id) FROM Account GROUP BY N", 40)).toBe("GROUP BY");
      expect(S.findClause("SELECT COUNT(Id) FROM Account GROUP BY Name HAVING COUNT(Id) > ", 60)).toBe("HAVING");
    });

    it("还没写任何子句 → NONE", () => {
      expect(S.findClause("", 0)).toBe("NONE");
      expect(S.findClause("Id, Na", 6)).toBe("NONE");
    });

    it("子句判定只看**光标之前**（右边的 ORDER BY 不算数）", () => {
      const sql = "SELECT Id FROM Account ORDER BY Name";
      expect(S.findClause(sql, 8)).toBe("SELECT");
    });
  });

  describe("候选组装", () => {
    const extras = {
      sObjects: ["My_Object__c"],
      objectFields: { Account: ["Id", "Name", "OrgSpecificField__c"] }
    };

    it("`FROM ` 之后只给对象名（含当前 org 的）", () => {
      const ctx = S.parseSoqlContext("SELECT Id FROM ", 14);
      const items = S.collectSoqlCompletions(ctx, extras);
      const labels = items.map((i) => i.label);
      expect(labels).toContain("Account");
      expect(labels).toContain("My_Object__c");
      expect(labels).not.toContain("WHERE");
    });

    it("**光标在 SELECT 里、FROM 在右边** —— 也要给那张表的字段", () => {
      const sql = "SELECT  FROM Account";
      const ctx = S.parseSoqlContext(sql, 7); // 光标在 SELECT 后面
      expect(ctx.clause).toBe("SELECT");
      expect(ctx.objectName).toBe("Account");
      const labels = S.collectSoqlCompletions(ctx, extras).map((i) => i.label);
      expect(labels).toContain("Name");
      expect(labels).toContain("OrgSpecificField__c");
      expect(labels).toContain("COUNT()");
    });

    it("`WHERE ` 之后给字段 + 日期字面量 + 关键字", () => {
      const sql = "SELECT Id FROM Account WHERE ";
      const items = S.collectSoqlCompletions(S.parseSoqlContext(sql, sql.length), extras);
      const labels = items.map((i) => i.label);
      expect(labels).toContain("Name");
      expect(labels).toContain("TODAY");
      expect(labels).toContain("LIKE");
    });

    it("`Account.` 前缀只给字段；别名 `a.` 也能映射回对象", () => {
      const one = S.collectSoqlCompletions(S.parseSoqlContext("SELECT Account.", 15), extras);
      expect(one.every((i) => i.kind === "field")).toBe(true);
      expect(one.map((i) => i.label)).toContain("OrgSpecificField__c");

      const sql = "SELECT a. FROM Account a";
      const ctx = S.parseSoqlContext(sql, 9);
      expect(S.effectiveObject(ctx)).toBe("Account");
      expect(S.collectSoqlCompletions(ctx, extras).map((i) => i.label)).toContain("Name");
    });

    it("未知前缀（不是对象也不是别名）不硬凑候选", () => {
      expect(S.collectSoqlCompletions(S.parseSoqlContext("SELECT foo.", 11), extras)).toEqual([]);
    });

    it("静态兜底：describe 没回来时标准对象也有字段", () => {
      const sql = "SELECT Id FROM Account WHERE ";
      const labels = S.collectSoqlCompletions(S.parseSoqlContext(sql, sql.length), {}).map((i) => i.label);
      expect(labels).toContain("AccountNumber"); // 来自 apex_symbols 的 STANDARD_OBJECTS
    });

    it("字符串字面量里不提示", () => {
      const sql = "SELECT Id FROM Account WHERE Name = 'Acc";
      expect(S.collectSoqlCompletions(S.parseSoqlContext(sql, sql.length), extras)).toEqual([]);
    });

    it("SELECT 子句里会补一个 FROM（写完字段接着写子句）", () => {
      const labels = S.collectSoqlCompletions(S.parseSoqlContext("SELECT Na", 9), extras).map((i) => i.label);
      expect(labels).toContain("FROM");
    });
  });

  describe("排序与应用", () => {
    it("字段排在任何关键字之前（打 `Na` 想要的是 Name 而不是 NULLS FIRST）", () => {
      const sql = "SELECT Id FROM Account WHERE Na";
      const items = S.soqlCompletionsFor(sql, sql.length, {
        objectFields: { Account: ["Id", "Name"] }
      }).items;
      expect(items[0].label).toBe("Name");
    });

    it("函数补成 `()` 并把光标放进括号", () => {
      const sql = "SELECT COUN FROM Account";
      const { ctx, items } = S.soqlCompletionsFor(sql, "SELECT COUN".length, {});
      expect(items[0].label).toBe("COUNT()");
      const out = S.applyCompletion(sql, ctx, items[0]);
      expect(out.text).toBe("SELECT COUNT() FROM Account");
      expect(out.caret).toBe("SELECT COUNT(".length);
    });

    it("对象名候选应用后只替换正在输入的那段", () => {
      const sql = "SELECT Id FROM Acc";
      const { ctx, items } = S.soqlCompletionsFor(sql, sql.length, {});
      const account = items.find((i) => i.label === "Account");
      expect(S.applyCompletion(sql, ctx, account).text).toBe("SELECT Id FROM Account");
    });
  });
});
