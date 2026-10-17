/**
 * 单元测试: src/common/ima_service.js 的纯逻辑部分
 *
 * Markdown 渲染与分片是「同步到知识库」里唯一能离线验证的两块：
 *   · 渲染决定 ima 里能不能搜到（标题带正文开头，而不是 #1 #2）
 *   · 分片决定会不会被服务端截断（一份超长笔记 = 后面全部丢失）
 * 网络那半边（import_doc / add_knowledge）只能真机验：它依赖用户自己的凭证。
 */

describe("ima_service 的 Markdown 构建", () => {
  let ima;

  beforeAll(() => {
    ima = require("../src/common/ima_service.js");
  });

  const soqlItems = [
    {
      text: "SELECT Id, Name FROM Account LIMIT 10",
      createdAt: 1,
      lastUsedAt: new Date(2026, 9, 17, 13, 30).getTime(),
      uses: 3,
      meta: { rows: 24, ms: 320 }
    },
    {
      text: "SELECT Id FROM Contact",
      createdAt: 1,
      lastUsedAt: new Date(2026, 9, 17, 12, 0).getTime(),
      uses: 1,
      meta: { rows: 5, ms: 80, scanAll: true }
    }
  ];

  test("标题、条数与条目正文都在", () => {
    const md = ima.buildHistoryMarkdown("soql", soqlItems);
    expect(md).toContain("# nForce Tools · SOQL 查询历史");
    expect(md).toContain("共 2 条");
    expect(md).toContain("SELECT Id, Name FROM Account LIMIT 10");
    expect(md).toContain("```soql");
  });

  test("标题用正文首行，而不是「1.」这种位置编号", () => {
    const md = ima.buildHistoryMarkdown("soql", soqlItems);
    expect(md).toContain("## 1. SELECT Id, Name FROM Account LIMIT 10");
  });

  test("起了名字时标题用名字，并补一行正文预览", () => {
    const md = ima.buildHistoryMarkdown("soql", [
      { name: "每日订单检查", text: "SELECT Id FROM Order LIMIT 10", lastUsedAt: Date.now(), uses: 1, meta: {} }
    ]);
    expect(md).toContain("## 1. 每日订单检查");
    // 名字下方那句引用是正文预览：光看名字不知道查的是什么
    expect(md).toContain("> SELECT Id FROM Order LIMIT 10");
  });

  test("元信息：次数只在 >1 时出现，行数与耗时进「本次结果」", () => {
    const md = ima.buildHistoryMarkdown("soql", soqlItems);
    expect(md).toContain("- 使用次数：3");
    expect(md).toContain("24 行");
    expect(md).toContain("320ms");
    expect(md).toContain("含已删除");
    // 第二条只跑过一次，不该出现「使用次数：1」
    expect(md).not.toContain("- 使用次数：1");
  });

  test("Apex 用 apex 代码块，并标注执行结果与 Log ID", () => {
    const md = ima.buildHistoryMarkdown("apex", [
      { text: "System.debug(1);", lastUsedAt: Date.now(), uses: 1, meta: { ok: true, logId: "07Lxxx", ms: 900 } }
    ]);
    expect(md).toContain("```apex");
    expect(md).toContain("执行成功");
    expect(md).toContain("Log ID 07Lxxx");
  });

  test("分片时标题带（1/2）", () => {
    const md = ima.buildHistoryMarkdown("soql", soqlItems, { part: 2, total: 2 });
    expect(md).toContain("（2/2）");
    expect(md).toContain("本份是第 2 份");
  });

  test("超长首行会被截断，不会把标题撑成一段正文", () => {
    const long = "SELECT " + "a, ".repeat(100) + "b FROM Account";
    const md = ima.buildHistoryMarkdown("soql", [{ text: long, lastUsedAt: Date.now(), uses: 1, meta: {} }]);
    const heading = md.split("\n").find((l) => l.startsWith("## 1. "));
    expect(heading.length).toBeLessThan(90);
    expect(heading.endsWith("…")).toBe(true);
  });
});

describe("ima_service 的分片", () => {
  let ima;

  beforeAll(() => {
    ima = require("../src/common/ima_service.js");
  });

  test("按字符预算切分，且不丢条目", () => {
    const items = Array.from({ length: 10 }, (_, i) => ({ text: "x".repeat(1000) + i }));
    const chunks = ima.chunkHistoryItems(items, 5000);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.flat().length).toBe(10);
    // 每片的总量不超过预算（200 是标题/元信息的余量）
    for (const chunk of chunks) {
      const size = chunk.reduce((sum, it) => sum + it.text.length + 200, 0);
      expect(size).toBeLessThanOrEqual(5000);
    }
  });

  test("单条超长时独占一片，不切正文", () => {
    const chunks = ima.chunkHistoryItems([{ text: "y".repeat(9000) }, { text: "small" }], 5000);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(1);
    expect(chunks[0][0].text.length).toBe(9000);
  });

  test("空数组给出空分片", () => {
    expect(ima.chunkHistoryItems([])).toEqual([]);
  });
});

describe("ima_service 的配置判定", () => {
  let ima;

  beforeAll(() => {
    ima = require("../src/common/ima_service.js");
  });

  test("没配置时给出可读的阻塞原因", () => {
    const reason = ima.describeImaBlocker();
    expect(typeof reason).toBe("string");
    // jest 环境里没有 chrome.storage，偏好读默认值（空串）→ 一定缺凭证
    expect(reason).toMatch(/凭证|知识库/);
  });

  test("时间格式化：非法值不抛错", () => {
    expect(ima.formatStamp(NaN)).toBe("—");
    expect(ima.formatStamp(new Date(2026, 0, 2, 3, 4).getTime())).toBe("2026-01-02 03:04");
  });
});
