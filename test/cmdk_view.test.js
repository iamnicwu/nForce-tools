/**
 * 单元测试: src/common/cmdk_view.js
 *
 * 这个模块是**两处入口共用的渲染器**（插件面板 + 注入到网页里的浮层），
 * 而它跑在 service worker 里的时候**没有任何截图能看** —— 真机验证只在
 * `overlay-verify.mjs` 那一轮跑得到，日常改代码时太慢。所以这里把最容易出错的三件事
 * 钉在单测里：
 *   ① 图标必须是**内联 SVG**（浮层是内容脚本、拿不到 icons.js，`<i>` 在那边是空白方块）；
 *   ② 空查询只出常用功能、有输入就搜全量（含"没有常用功能时回落"）；
 *   ③ 命中必须真的带 `<mark>` —— 这里踩过：高亮原本只跟"得分最高的字段"走，
 *      而别名词条（`tile.keywords` 里写死 "t4"）会以"完全相同"胜出，
 *      于是可见标题里的 `T-4` 一个高亮都没有，看着像"搜了没命中"。
 */

const fs = require("fs");
const path = require("path");

describe("cmdk_view.js - 搜索结果渲染", () => {
  const { renderList, shellHtml, svgFor, resolveScope } = require("../src/common/cmdk_view.js");

  /** 与 common/command_index.js 的条目形状保持一致的最小夹具 */
  const entry = (over = {}) => ({
    id: "tile:x",
    tileId: "x",
    step: 1,
    label: "X",
    desc: "",
    icon: "fa-cube",
    tint: "var(--accent-blue-tint)",
    accent: "var(--accent-blue)",
    groupTitle: "G",
    keywords: [],
    requiresConnection: false,
    locked: false,
    favorite: false,
    ...over
  });

  const entries = [
    entry({ id: "tile:t4-list", tileId: "t4-list", step: 12, label: "T-4 Outstanding",
            desc: "T-4 connectivity 清单", icon: "fa-file-alt", keywords: ["t4"], favorite: true }),
    entry({ id: "tile:lunch", tileId: "lunch", step: 14, label: "中午食乜",
            desc: "随机挑选午餐", icon: "fa-utensils", keywords: ["wucan"], favorite: true }),
    entry({ id: "tile:bulk", tileId: "bulk", step: 15, label: "Bulk 操作",
            desc: "批量作业管理", icon: "fa-database", locked: true })
  ];

  describe("shellHtml()", () => {
    const html = shellHtml();
    test("骨架带齐面板所需的 id（面板与浮层都靠它们取元素）", () => {
      expect(html).toContain('id="cmdk-input"');
      expect(html).toContain('id="cmdk-list"');
      expect(html).toContain('id="cmdk-count"');
      expect(html).toContain('class="cmdk-panel"');
    });

    test("搜索图标是内联 SVG，不是等 replaceIcons 的 <i>", () => {
      expect(html).toContain("<svg");
      // 只允许 .cmdk-item-lock 里那种结构；骨架里不该出现 fa- 类
      expect(html).not.toMatch(/class="fas fa-/);
    });
  });

  describe("svgFor()", () => {
    test("布局里用到的每个图标都能解析出内联 SVG", () => {
      const layoutPath = path.join(__dirname, "..", "src", "rules", "ui_layout.json");
      const layout = JSON.parse(fs.readFileSync(layoutPath, "utf8"));
      const icons = new Set();
      layout.groups.forEach((g) => g.tiles.forEach((t) => icons.add(t.icon)));
      expect(icons.size).toBeGreaterThan(10);
      const missing = [...icons].filter((icon) => !svgFor(icon).startsWith("<svg"));
      expect(missing).toEqual([]);
    });

    test("拿不到映射时返回空串（宁可缺图标，也不要漏出一个永远不会被替换的 <i>）", () => {
      expect(svgFor("fa-not-a-real-icon")).toBe("");
      expect(svgFor(undefined)).toBe("");
    });
  });

  describe("resolveScope()", () => {
    test("空查询 + 有常用 → 只出常用", () => {
      expect(resolveScope("", entries).scope).toBe("favorites");
      expect(resolveScope("", entries).pool.length).toBe(2);
    });

    test("有输入 → 搜全量", () => {
      expect(resolveScope("bulk", entries).scope).toBe("all");
      expect(resolveScope("bulk", entries).pool.length).toBe(3);
    });

    test("一个常用都没有时回落成全量（否则面板一打开就是空的）", () => {
      const noFav = entries.map((e) => ({ ...e, favorite: false }));
      expect(resolveScope("", noFav).scope).toBe("all");
      expect(resolveScope("", noFav).pool.length).toBe(3);
    });
  });

  describe("renderList()", () => {
    test("空查询只渲染常用功能，并带一行「输入关键词可搜索全部」的提示", () => {
      const view = renderList({ query: "", entries, activeIndex: 0 });
      expect(view.scope).toBe("favorites");
      expect(view.count).toBe(2);
      expect(view.total).toBe(3);
      expect(view.html).toContain("T-4 Outstanding");
      expect(view.html).not.toContain("Bulk 操作");
      expect(view.html).toContain("cmdk-hint");
    });

    test("有输入时搜全量（计数文案由调用方拼）", () => {
      const view = renderList({ query: "bulk", entries, activeIndex: 0 });
      expect(view.scope).toBe("all");
      expect(view.count).toBe(1);
      expect(view.firstLabel).toBe("Bulk 操作");
      expect(view.firstLocked).toBe(true);
    });

    test("命中处必须有 <mark>（别名词条胜出时标题也要高亮）", () => {
      // `t4` 在 keywords 里是完全相同（1000×0.92），它才是"得分最高的字段"；
      // 但可见标题「T-4 Outstanding」本身也命中，必须显示高亮。
      const view = renderList({ query: "t4", entries, activeIndex: 0 });
      expect(view.count).toBe(1);
      expect(view.html).toContain("<mark>");
      // 高亮不能把中间的连字符也涂上：`T-4` 只有 T 与 4 被包进去
      expect(view.html).toContain("<mark>T</mark>-<mark>4</mark>");
    });

    test("命中描过描述时，描述里也要高亮", () => {
      const view = renderList({ query: "connectivity", entries, activeIndex: 0 });
      expect(view.html).toContain("cmdk-item-desc");
      expect(view.html).toMatch(/cmdk-item-desc">.*<mark>/);
    });

    test("没有命中时给空态而不是空字符串", () => {
      const view = renderList({ query: "zzz", entries, activeIndex: 0 });
      expect(view.count).toBe(0);
      expect(view.html).toContain("cmdk-empty");
    });

    test("锁定项带 .is-locked 与内联锁图标", () => {
      const view = renderList({ query: "bulk", entries, activeIndex: 0 });
      expect(view.html).toContain("is-locked");
      expect(view.html).toContain("cmdk-item-lock");
      expect(view.html).toContain("<svg");
    });

    test("高亮项由 activeIndex 决定（方向键只改这个下标）", () => {
      const view = renderList({ query: "", entries, activeIndex: 1 });
      expect(view.activeLabel).toBe("中午食乜");
      expect(view.html).toMatch(/id="cmdk-item-1"[\s\S]*?is-active|is-active[\s\S]*?id="cmdk-item-1"/);
    });

    test("条目文本里的 HTML 必须被转义（布局 JSON 是用户可编辑的）", () => {
      const evil = [entry({ label: '<img src=x onerror="alert(1)">', favorite: true })];
      const view = renderList({ query: "", entries: evil, activeIndex: 0 });
      expect(view.html).not.toContain("<img");
      expect(view.html).toContain("&lt;img");
    });
  });
});
