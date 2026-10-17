/**
 * 单元测试: src/common/history_store.js
 *
 * 这一层是「批量导出 / 批量导入 / 同步知识库」的地基，坏掉的后果都很安静：
 *   · 去重口径不一致 → 导入自己刚导出的文件会凭空多出一倍条目
 *   · 旧格式没迁移   → 老用户的查询历史在升级后"消失"
 *   · 文件格式没校验 → Apex 历史被导进 SOQL 列表
 * 所以这里把口径逐条钉住，尤其是**纯函数**部分（storage 那半边靠真机验证）。
 */

describe("history_store", () => {
  let H;

  beforeAll(() => {
    H = require("../src/common/history_store.js");
  });

  describe("normalizeText / hashText / itemId", () => {
    test("换行符统一且去首尾空白", () => {
      expect(H.normalizeText("  SELECT 1\r\nFROM X\r\n")).toBe("SELECT 1\nFROM X");
    });

    test("非字符串一律当成空", () => {
      expect(H.normalizeText(null)).toBe("");
      expect(H.normalizeText(42)).toBe("");
    });

    test("同一段文字的 id 稳定，不同文字不撞", () => {
      const a = H.itemId("SELECT Id FROM Account");
      expect(a).toBe(H.itemId("SELECT Id FROM Account"));
      expect(a).not.toBe(H.itemId("SELECT Id FROM Contact"));
      expect(a.startsWith("q")).toBe(true);
    });

    test("仅首尾空白不同视为同一条", () => {
      expect(H.itemId("  SELECT 1  ")).toBe(H.itemId("SELECT 1"));
    });
  });

  describe("名字（2026-10-17 新增）", () => {
    test("normalizeName 压空白 + 截断 + 空串合法", () => {
      expect(H.normalizeName("  Order  查询  ")).toBe("Order 查询");
      expect(H.normalizeName("")).toBe("");
      expect(H.normalizeName(null)).toBe("");
      expect(H.normalizeName("x".repeat(200)).length).toBe(H.NAME_MAX_LENGTH);
    });

    test("条目带 name，缺省是空串（旧数据不会凭空长出一个名字）", () => {
      const [legacy] = H.normalizeHistory(["SELECT 1"]);
      expect(legacy.name).toBe("");
      const [named] = H.normalizeHistory([{ text: "SELECT 1", name: "  每日订单  " }]);
      expect(named.name).toBe("每日订单");
    });

    test("导出带上名字（换机器导入后还在）", () => {
      const items = H.normalizeHistory([{ text: "SELECT 1", name: "每日订单" }]);
      const payload = H.buildExportPayload("soql", items);
      expect(payload.items[0].name).toBe("每日订单");
    });

    test("合并时本地已有的名字优先，本地没名字才采纳文件里的", () => {
      const existing = H.normalizeHistory([{ text: "SELECT 1", name: "本地名" }, { text: "SELECT 2" }]);
      const incoming = H.normalizeHistory([{ text: "SELECT 1", name: "文件里的名字" }, { text: "SELECT 2", name: "补上的名字" }]);
      const merged = H.mergeHistories(existing, incoming);
      expect(merged.items.find((i) => i.text === "SELECT 1").name).toBe("本地名");
      expect(merged.items.find((i) => i.text === "SELECT 2").name).toBe("补上的名字");
    });

    test("名字不参与去重：正文相同的两条仍是同一条（只是名字不同）", () => {
      const merged = H.mergeHistories(
        H.normalizeHistory([{ text: "SELECT 1", name: "A" }]),
        H.normalizeHistory([{ text: "SELECT 1", name: "B" }])
      );
      expect(merged.items).toHaveLength(1);
      expect(merged.added).toBe(0);
    });
  });

  describe("normalizeHistory", () => {
    test("吃旧格式（string[]）并补上时间与次数", () => {
      const now = 1700000000000;
      const items = H.normalizeHistory(["SELECT 1", "SELECT 2"], now);
      expect(items).toHaveLength(2);
      expect(items[0].text).toBe("SELECT 1");
      expect(items[0].createdAt).toBe(now);
      expect(items[0].uses).toBe(1);
      expect(items[0].meta).toEqual({});
    });

    test("丢掉空条目与重复条目", () => {
      const items = H.normalizeHistory(["", "  ", "SELECT 1", " SELECT 1 "]);
      expect(items).toHaveLength(1);
    });

    test("按最近使用倒序", () => {
      const items = H.normalizeHistory([
        { text: "A", lastUsedAt: 100 },
        { text: "B", lastUsedAt: 300 },
        { text: "C", lastUsedAt: 200 }
      ]);
      expect(items.map((i) => i.text)).toEqual(["B", "C", "A"]);
    });

    test("不是数组时返回空数组（storage 里被写坏也不炸）", () => {
      expect(H.normalizeHistory(null)).toEqual([]);
      expect(H.normalizeHistory({ a: 1 })).toEqual([]);
    });
  });

  describe("mergeHistories", () => {
    const existing = [
      { text: "SELECT 1", lastUsedAt: 100, createdAt: 50, uses: 2 },
      { text: "SELECT 2", lastUsedAt: 200, createdAt: 60, uses: 1 }
    ];

    test("新条目计入 added，重复条目计入 duplicates", () => {
      const merged = H.mergeHistories(existing, ["SELECT 1", "SELECT 3"]);
      expect(merged.added).toBe(1);
      expect(merged.duplicates).toBe(1);
      expect(merged.items.map((i) => i.text).sort()).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
    });

    test("重复条目取较大的次数与较晚的使用时间", () => {
      const merged = H.mergeHistories(existing, [
        { text: "SELECT 1", uses: 9, lastUsedAt: 999, createdAt: 10 }
      ]);
      const one = merged.items.find((i) => i.text === "SELECT 1");
      expect(one.uses).toBe(9);
      expect(one.lastUsedAt).toBe(999);
      // createdAt 取更早的那个（这条记录第一次出现的时间）
      expect(one.createdAt).toBe(10);
    });

    test("导入一份自己刚导出的东西 = 0 新增", () => {
      const normalized = H.normalizeHistory(existing);
      const merged = H.mergeHistories(normalized, normalized);
      expect(merged.added).toBe(0);
      expect(merged.duplicates).toBe(2);
      expect(merged.items).toHaveLength(2);
    });

    test("超过上限时截断（保留最近使用的）", () => {
      const merged = H.mergeHistories([], ["A", "B", "C"], 2);
      expect(merged.items).toHaveLength(2);
    });
  });

  describe("导出", () => {
    test("文件里带格式标识与条数", () => {
      const items = H.normalizeHistory(["SELECT 1"]);
      const payload = H.buildExportPayload("soql", items);
      expect(payload.format).toBe("nforce-tools-history");
      expect(payload.kind).toBe("soql");
      expect(payload.count).toBe(1);
      expect(payload.items[0].text).toBe("SELECT 1");
      // 导入时用于去重的 id 不落盘 —— 由正文重新算，避免两个来源的 id 规则不同
      expect(payload.items[0].id).toBeUndefined();
    });

    test("文件名可读且带时间戳", () => {
      const name = H.exportFileName("apex", new Date(2026, 9, 17, 13, 5));
      expect(name).toBe("nforce_apex_history_20261017_1305.json");
    });
  });

  describe("解析导入文件", () => {
    test("读自己导出的 JSON", () => {
      const items = H.normalizeHistory(["SELECT 1", "SELECT 2"]);
      const text = JSON.stringify(H.buildExportPayload("soql", items));
      const parsed = H.parseHistoryFileContent(text, { kind: "soql", fileName: "h.json" });
      expect(parsed.map((i) => i.text)).toEqual(["SELECT 1", "SELECT 2"]);
    });

    test("读手写的 JSON 数组（字符串）", () => {
      const parsed = H.parseHistoryFileContent('["SELECT 1","SELECT 2"]', { kind: "soql" });
      expect(parsed).toHaveLength(2);
    });

    test("kind 不一致时拒绝（Apex 历史不能导进 SOQL）", () => {
      const text = JSON.stringify(H.buildExportPayload("apex", H.normalizeHistory(["x"])));
      expect(() => H.parseHistoryFileContent(text, { kind: "soql", fileName: "h.json" }))
        .toThrow(/apex/);
    });

    test("非法 JSON 给出可读的错误", () => {
      expect(() => H.parseHistoryFileContent("{oops", { kind: "soql", fileName: "h.json" }))
        .toThrow(/JSON/);
    });

    test(".sql 文本按分号切条", () => {
      const text = "SELECT 1\nFROM A;\nSELECT 2\nFROM B;\n";
      const parsed = H.parseHistoryFileContent(text, { kind: "soql", fileName: "q.sql" });
      expect(parsed.map((i) => i.text)).toEqual(["SELECT 1\nFROM A", "SELECT 2\nFROM B"]);
    });

    test("没有分号的 .apex 整段算一条", () => {
      const text = "System.debug('a');\nSystem.debug('b');";
      const parsed = H.parseHistoryFileContent(text, { kind: "apex", fileName: "x.apex" });
      expect(parsed).toHaveLength(1);
      expect(parsed[0].text).toContain("System.debug('b')");
    });

    test("空文件报错而不是返回空数组", () => {
      expect(() => H.parseHistoryFileContent("   ", { kind: "soql" })).toThrow();
    });
  });

  test("两种历史的上限与 storage 键写在同一处", () => {
    expect(H.HISTORY_KINDS.soql.storageKey).toBe("soql_history");
    expect(H.HISTORY_KINDS.apex.storageKey).toBe("apex_history");
    expect(H.HISTORY_KINDS.soql.limit).toBeGreaterThan(20); // 老实现只有 20 条
  });
});
