/**
 * 单元测试: src/common/apex_completions.js
 *
 * 补全这种东西，"浮层能弹出来"和"弹得对"是两件事：前者看截图就知道，后者只有把
 * **上下文解析**与**排序规则**钉在单测里才守得住。这里覆盖三类容易出错的：
 *   ① 在字符串 / 注释里不该提示（含跨行块注释、转义引号）；
 *   ② `X.` 后面的成员来自哪个类（内置类 / sObject 字段 / 枚举）；
 *   ③ 排序：前缀匹配要压过包含匹配，短名要压过长名。
 */

describe("apex_completions.js - Apex 代码提示的纯逻辑", () => {
  const C = require("../src/common/apex_completions.js");

  describe("上下文解析", () => {
    it("普通位置：token 就是光标前那个标识符", () => {
      const ctx = C.parseContext("Syst", 4);
      expect(ctx.token).toBe("Syst");
      expect(ctx.receiver).toBeNull();
      expect(ctx.replaceFrom).toBe(0);
      expect(ctx.replaceTo).toBe(4);
      expect(ctx.blocked).toBe(false);
    });

    it("`System.de` → receiver=System、token=de、替换范围只覆盖 de", () => {
      const text = "System.de";
      const ctx = C.parseContext(text, text.length);
      expect(ctx.receiver).toBe("System");
      expect(ctx.token).toBe("de");
      expect(ctx.replaceFrom).toBe(7);
    });

    it("`Account.` → receiver=Account、token 为空（此时要列出全部字段）", () => {
      const text = "Account.";
      const ctx = C.parseContext(text, text.length);
      expect(ctx.receiver).toBe("Account");
      expect(ctx.token).toBe("");
    });

    it("链式访问取**最近**一个接收者（`a.b.c` → b）", () => {
      const text = "a.b.c";
      expect(C.parseContext(text, text.length).receiver).toBe("b");
    });

    it("`Sobject s = new Acc` 这种行内位置也能认出前缀", () => {
      const text = "Account a = new Acc";
      const ctx = C.parseContext(text, text.length);
      expect(ctx.token).toBe("Acc");
      expect(ctx.receiver).toBeNull();
    });

    it("字符串里不提示（含转义引号）", () => {
      expect(C.parseContext("String s = 'Syst", 16).blocked).toBe(true);
      expect(C.parseContext("String s = 'it\\'s Syst", 20).blocked).toBe(true);
    });

    it("行注释与块注释里不提示；块注释结束后恢复正常", () => {
      expect(C.parseContext("// Syst", 7).blocked).toBe(true);
      expect(C.parseContext("/* Syst", 7).blocked).toBe(true);
      expect(C.parseContext("/* a\nb */ Syst", 13).blocked).toBe(false);
    });

    it("字符串里的 `//` 不会被当成注释（顺序不能反）", () => {
      expect(C.parseContext("String url = 'http://x", 20).blocked).toBe(true);
    });
  });

  describe("候选组装", () => {
    it("普通位置有关键字 / 类型 / 内置类 / sObject", () => {
      const items = C.collectCompletions(C.parseContext("", 0), {});
      const labels = items.map((i) => i.label);
      expect(labels).toContain("public");
      expect(labels).toContain("String");
      expect(labels).toContain("System");
      expect(labels).toContain("Account");
      expect(labels).toContain("List");
    });

    it("`System.` → 内置类成员，且方法补成 `()` 并把光标放进括号", () => {
      const ctx = C.parseContext("System.", 7);
      const items = C.collectCompletions(ctx, {});
      const debug = items.find((i) => i.label === "debug");
      expect(debug).toBeTruthy();
      expect(debug.insert).toBe("debug()");
      expect(debug.caretInside).toBe(true);
      // 属性/常量不补括号
      const now = items.find((i) => i.label === "now");
      expect(now.insert).toBe("now()");
    });

    it("`Account.` → 静态字段兜底（Name / AccountNumber…）", () => {
      const items = C.collectCompletions(C.parseContext("Account.", 8), {});
      const labels = items.map((i) => i.label);
      expect(labels).toContain("Name");
      expect(labels).toContain("AccountNumber");
      expect(items[0].kind).toBe("field");
    });

    it("运行时（org describe）拿到的字段会**覆盖**静态兜底", () => {
      const items = C.collectCompletions(C.parseContext("Account.", 8), {
        objectFields: { Account: ["MyCustomField__c", "Id"] }
      });
      expect(items.map((i) => i.label)).toEqual(["MyCustomField__c", "Id"]);
    });

    it("运行时拿到的 sObject 名会合并进来，并注明来源", () => {
      const items = C.collectCompletions(C.parseContext("MyOb", 4), {
        sObjects: ["MyObject__c"]
      });
      const custom = items.find((i) => i.label === "MyObject__c");
      expect(custom).toBeTruthy();
      expect(custom.detail).toContain("org");
      // 静态标准对象还在（未连接 / describe 失败时的兜底）
      expect(items.map((i) => i.label)).toContain("Account");
    });

    it("`FROM ` 之后只给对象名（这时候关键字是噪音）", () => {
      const ctx = C.parseContext("[SELECT Id FROM Acc", 18);
      const items = C.collectCompletions(ctx, { sObjects: ["MyObject__c"] });
      expect(items.map((i) => i.label)).toContain("Account");
      expect(items.map((i) => i.label)).toContain("MyObject__c");
      expect(items.map((i) => i.label)).not.toContain("public");
    });

    it("字符串 / 注释里给空候选", () => {
      const ctx = C.parseContext("String s = 'Syst", 16);
      expect(C.collectCompletions(ctx, {})).toEqual([]);
    });

    it("未知接收者（局部变量）不硬凑候选", () => {
      expect(C.collectCompletions(C.parseContext("acc.", 4), {})).toEqual([]);
    });

    it("LoggingLevel 枚举", () => {
      const items = C.collectCompletions(C.parseContext("LoggingLevel.", 13), {});
      expect(items.map((i) => i.label)).toContain("ERROR");
    });
  });

  describe("排序与截断", () => {
    it("前缀匹配压过包含匹配", () => {
      const items = C.rankCompletions(
        [
          { label: "Campaign", kind: "sObject" },
          { label: "Account", kind: "sObject" }
        ],
        "acc"
      );
      expect(items[0].label).toBe("Account");
    });

    it("同档里短名优先", () => {
      const items = C.rankCompletions(
        [
          { label: "AccountHistory", kind: "sObject" },
          { label: "Account", kind: "sObject" }
        ],
        "account"
      );
      expect(items[0].label).toBe("Account");
    });

    it("类型权重：类 > 成员 > 字段", () => {
      const items = C.rankCompletions(
        [
          { label: "System", kind: "class" },
          { label: "List", kind: "class" },
          { label: "LeadSource", kind: "field" },
          { label: "LoggingLevel", kind: "member" }
        ],
        ""
      );
      expect(items[0].label).toBe("List"); // 同类里更短
      expect(items[1].label).toBe("System");
      expect(items[2].label).toBe("LoggingLevel"); // member 压过 field
      expect(items[3].label).toBe("LeadSource");
    });

    it("空前缀（刚打完 `.` 或按 Ctrl+Space）不匹配任何前缀也返回候选", () => {
      const items = C.rankCompletions([{ label: "Name", kind: "field" }], "");
      expect(items.length).toBe(1);
    });

    it("limit 生效", () => {
      const many = Array.from({ length: 50 }, (_, i) => ({ label: `X${i}`, kind: "keyword" }));
      expect(C.rankCompletions(many, "", 12).length).toBe(12);
    });
  });

  describe("应用候选", () => {
    it("只替换正在输入的那一段，前后文不动", () => {
      const text = "System.de";
      const { ctx } = C.completionsFor(text, text.length, {});
      const out = C.applyCompletion(text, ctx, { label: "debug", insert: "debug()", caretInside: true });
      expect(out.text).toBe("System.debug()");
      expect(out.caret).toBe("System.debug(".length); // 光标在括号里
    });

    it("属性类候选不带括号，光标落在词尾", () => {
      const text = "Trigger.ne";
      const { ctx } = C.completionsFor(text, text.length, {});
      const out = C.applyCompletion(text, ctx, { label: "new", insert: "new" });
      expect(out.text).toBe("Trigger.new");
      expect(out.caret).toBe(out.text.length);
    });

    it("替换范围之外的文本原样保留", () => {
      const text = "System.de\nSystem.debug('x');";
      const out = C.applyCompletion(text, C.parseContext(text, 9), {
        label: "debug",
        insert: "debug()"
      });
      expect(out.text).toBe("System.debug()\nSystem.debug('x');");
    });
  });
});
