/**
 * 单元测试: src/common/apex_log_view.js
 *
 * 这一层把 `@apexdevtools/apex-log-parser` 的解析结果转成界面要的形状。两个最容易写错、
 * 而**在页面上完全看不出来**的地方：
 *   ① 库的指标字段是 `{self, total}`（`duration` / `soqlRows` / 根上的 `soqlCount` 都是），
 *      直接 `Number(x)` 得到 `NaN` —— 界面上会显示成 "NaN ms"，看着像日志本身有问题；
 *   ② 「最慢的几步」必须按**自身耗时**排：容器节点（CODE_UNIT / EXECUTION_STARTED）的
 *      总耗时永远最大，按它排出来的表只能告诉用户"整个事务花了 3 秒"，等于没回答"慢在哪"。
 */

/** 造一个与真实解析结果同形状的最小节点 */
function node(type, { text = "", selfMs: s = 0, totalMs: t = s, children = [], ...rest } = {}) {
  return {
    type,
    text: text || type,
    duration: { self: s * 1e6, total: t * 1e6 },
    children,
    ...rest
  };
}

/** 造一个根（库里根节点是 `type: null` 的虚拟容器） */
function root(children, extra = {}) {
  return { type: null, text: "", children, duration: { self: 0, total: 0 }, ...extra };
}

describe("apex_log_view.js - 日志分析的视图模型", () => {
  const view = require("../src/common/apex_log_view.js");

  describe("库里 {self, total} 形状的指标", () => {
    it("metric() 取 total；裸数字原样；缺字段给 0 而不是 NaN", () => {
      expect(view.metric({ self: 1, total: 5 })).toBe(5);
      expect(view.metric(7)).toBe(7);
      expect(view.metric(undefined)).toBe(0);
      expect(view.metric({})).toBe(0);
      expect(view.metric("abc")).toBe(0);
    });

    it("durationMs() 把纳秒换成毫秒", () => {
      expect(view.durationMs(node("X", { totalMs: 12.5 }))).toBeCloseTo(12.5, 5);
    });

    it("selfMs() 优先用库给的 self；库没给就自己减（total − 子节点 total）", () => {
      expect(view.selfMs(node("X", { selfMs: 3, totalMs: 99 }))).toBeCloseTo(3, 5);
      const parent = node("P", {
        totalMs: 10,
        children: [node("C1", { totalMs: 4 }), node("C2", { totalMs: 5 })]
      });
      parent.duration = { total: 10e6 }; // 库没给 self 的情形
      expect(view.selfMs(parent)).toBeCloseTo(1, 5);
    });
  });

  describe("事件树遍历", () => {
    const tree = root([
      node("EXECUTION_STARTED", {
        children: [
          node("CODE_UNIT_STARTED", {
            children: [node("METHOD_ENTRY", { children: [node("SOQL_EXECUTE_BEGIN")] })]
          })
        ]
      }),
      node("EXECUTION_FINISHED")
    ]);

    it("深度优先、层级正确、不把虚拟根算进去", () => {
      const rows = view.walkEvents(tree);
      expect(rows.map((r) => [view.typeOf(r.node), r.depth])).toEqual([
        ["EXECUTION_STARTED", 0],
        ["CODE_UNIT_STARTED", 1],
        ["METHOD_ENTRY", 2],
        ["SOQL_EXECUTE_BEGIN", 3],
        ["EXECUTION_FINISHED", 0]
      ]);
    });

    it("空树 / 脏数据不抛错", () => {
      expect(view.walkEvents(root([]))).toEqual([]);
      expect(view.walkEvents(null)).toEqual([]);
      expect(view.walkEvents({ children: [null, node("A")] }).length).toBe(1);
    });
  });

  describe("概览", () => {
    const tree = root([node("SOQL_EXECUTE_BEGIN"), node("DML_BEGIN"), node("METHOD_ENTRY")], {
      soqlCount: { self: 0, total: 2 },
      soqlRowCount: { self: 0, total: 150 },
      dmlCount: { self: 0, total: 1 },
      dmlRowCount: { self: 0, total: 1 },
      thrownCount: { self: 0, total: 1 },
      heapPeak: { self: 0, total: 2048 },
      startTime: "2026-10-16T10:00:00.000Z",
      entryPoints: ["Anonymous Apex"],
      duration: { self: 0, total: 3_500_000_000 }
    });

    it("数字全部来自库的聚合字段，并换算单位", () => {
      const s = view.summarize(tree);
      expect(s.eventCount).toBe(3);
      expect(s.durationMs).toBeCloseTo(3500, 3);
      expect(s.soql).toEqual({ count: 2, rows: 150 });
      expect(s.dml).toEqual({ count: 1, rows: 1 });
      expect(s.thrownCount).toBe(1);
      expect(s.heapPeakBytes).toBe(2048);
      expect(s.startTime).toBe("2026-10-16T10:00:00.000Z");
      expect(s.entryPoints).toEqual(["Anonymous Apex"]);
    });

    it("字段缺失时给 0 与空数组，不抛错", () => {
      const s = view.summarize(root([]));
      expect(s.soql).toEqual({ count: 0, rows: 0 });
      expect(s.entryPoints).toEqual([]);
      expect(s.truncated).toBe(false);
    });

    it("日志被截断时给出标记（统计会偏小，必须让用户知道）", () => {
      expect(
        view.summarize(root([], { truncation: { regions: [{ skipped: 100 }], totalSkippedBytes: 100 } }))
          .truncated
      ).toBe(true);
      expect(view.summarize(root([], { truncation: { totalSkippedBytes: 2048 } })).truncated).toBe(true);
      expect(view.summarize(root([], { truncatedEvents: [{}] })).truncated).toBe(true);
    });

    it("**没截断时不能误报**：库的 truncation 永远是个对象（{regions:[],totalSkippedBytes:0}）", () => {
      // 2026-10-16 的第一版写成 `!!r.truncation`，于是每一份正常日志都被标成"被截断" ——
      // 截图里一眼可见，但纯看断言是绿的，所以这条用例必须有
      const normal = { truncation: { regions: [], totalSkippedBytes: 0 }, truncatedEvents: [] };
      expect(view.summarize(root([], normal)).truncated).toBe(false);
      expect(view.summarize(root([])).truncated).toBe(false);
    });

    it("日志大小取库报的 size", () => {
      expect(view.summarize(root([], { size: 339 })).sizeBytes).toBe(339);
    });
  });

  describe("最慢的几步", () => {
    it("按**自身耗时**排序，容器节点不靠总量占位", () => {
      const tree = root([
        node("CODE_UNIT_STARTED", {
          totalMs: 1000, // 总耗时最大，但自身只花了 1ms
          children: [node("SOQL_EXECUTE_BEGIN", { selfMs: 300, totalMs: 300 })]
        }),
        node("DML_BEGIN", { selfMs: 20, totalMs: 20 })
      ]);
      const rows = view.topSlowest(tree, 5);
      expect(view.typeOf(rows[0].node)).toBe("SOQL_EXECUTE_BEGIN");
      expect(rows[0].ms).toBeCloseTo(300, 5);
      expect(rows[1].ms).toBeCloseTo(20, 5);
    });

    it("耗时 0 的节点与 exit 事件不进榜", () => {
      const tree = root([node("A"), node("B", { isExit: true, selfMs: 5 })]);
      expect(view.topSlowest(tree, 5)).toEqual([]);
    });

    it("只取前 N 个", () => {
      const tree = root([1, 2, 3, 4, 5].map((i) => node(`N${i}`, { selfMs: i })));
      expect(view.topSlowest(tree, 2).map((r) => view.typeOf(r.node))).toEqual(["N5", "N4"]);
    });
  });

  describe("SOQL / DML 明细", () => {
    const tree = root([
      node("SOQL_EXECUTE_BEGIN", { text: "SELECT Id FROM Account", soqlRows: { self: 50, total: 50 } }),
      node("SOQL_EXECUTE_END", { text: "Rows:50" }),
      node("DML_BEGIN", { text: "DML Op:Update Type:Account", dmlRows: { self: 1, total: 1 } }),
      node("DML_END")
    ]);

    it("只取 BEGIN 行（END 是它的出口事件，重复列出等于把表撑大一倍）", () => {
      const rows = view.statementRows(tree, "SOQL");
      expect(rows.length).toBe(1);
      expect(rows[0].text).toBe("SELECT Id FROM Account");
      expect(rows[0].rows).toBe(50);
    });

    it("DML 取 dmlRows，SOQL 取 soqlRows", () => {
      const rows = view.statementRows(tree, "DML");
      expect(rows.length).toBe(1);
      expect(rows[0].text).toContain("Op:Update");
      expect(rows[0].rows).toBe(1);
    });

    it("超过上限时截断", () => {
      const many = root(Array.from({ length: 10 }, (_, i) => node("SOQL_EXECUTE_BEGIN", { text: `q${i}` })));
      expect(view.statementRows(many, "SOQL", 3).length).toBe(3);
    });
  });

  describe("调用树渲染", () => {
    it("产出可折叠的嵌套 <details>，并把文本转义（日志内容不可信）", () => {
      const tree = root([node("USER_DEBUG", { text: "<img src=x onerror=alert(1)> & 'quoted'" })]);
      const html = view.treeHtml(tree);
      expect(html).toContain("<details");
      expect(html).toContain("USER_DEBUG");
      expect(html).not.toContain("<img src=x");
      expect(html).toContain("&lt;img");
      expect(html).toContain("&amp;");
    });

    it("节点太多时截断并给出提示（几万个事件不能全塞进 DOM）", () => {
      const many = root(Array.from({ length: 12 }, (_, i) => node(`N${i}`)));
      const html = view.treeHtml(many, { maxNodes: 5 });
      expect(html.match(/<details/g).length).toBe(5);
      expect(html).toContain("只画了前 5 个节点");
    });

    it("默认展开**前 3 个**节点（序号要在渲染子节点之前定下来）", () => {
      // 曾经的写法是递归完子节点再判断 `rendered <= 3` —— 那时计数已经被子节点推大，
      // 于是整棵树都是折叠的（截图里一眼能看到，断言却不会红）
      const tree = root(Array.from({ length: 5 }, (_, i) => node(`N${i}`)));
      const html = view.treeHtml(tree);
      expect((html.match(/<details[^>]*\sopen/g) || []).length).toBe(3);
      expect(html.indexOf("open") >= 0).toBe(true);
    });
  });

  describe("异常与问题", () => {
    it("把异常 / 事务问题 / 未解析的行合成一列，且**不做 JSON 序列化**（解析结果里有循环引用）", () => {
      const cyclic = { type: "FATAL_ERROR", text: "boom" };
      cyclic.self = cyclic;
      const rows = view.issuesList(
        root([], {
          exceptions: [cyclic],
          logIssues: ["日志被截断"],
          parsingErrors: [{ summary: "第 12 行看不懂" }]
        })
      );
      expect(rows.map((r) => r.kind)).toEqual(["异常", "事务问题", "未解析的行"]);
      expect(rows[0].text).toBe("boom");
      expect(rows[1].text).toBe("日志被截断");
      expect(rows[2].text).toBe("第 12 行看不懂");
    });

    it("取不到可读字段时跳过（而不是显示 [object Object]）", () => {
      expect(view.issuesList(root([], { exceptions: [{ foo: 1 }] }))).toEqual([]);
    });
  });

  describe("格式化", () => {
    it("耗时：毫秒与秒分档（<10ms 两位小数，其余一位；≥1s 换算成秒）", () => {
      expect(view.formatMs(9.876)).toBe("9.88 ms");
      expect(view.formatMs(12.34)).toBe("12.3 ms");
      expect(view.formatMs(123.4)).toBe("123.4 ms");
      expect(view.formatMs(1250)).toBe("1.25 s");
      expect(view.formatMs(0)).toBe("0 ms");
      expect(view.formatMs(undefined)).toBe("0 ms");
    });

    it("体积：B / KB / MB", () => {
      expect(view.formatBytes(512)).toBe("512 B");
      expect(view.formatBytes(2048)).toBe("2.0 KB");
      expect(view.formatBytes(3 * 1024 * 1024)).toBe("3.00 MB");
      expect(view.formatBytes(null)).toBe("0 B");
    });
  });
});
