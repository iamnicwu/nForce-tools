/**
 * 单元测试: src/common/command_index.js
 *
 * 这个模块是**首页磁贴与搜索索引的唯一来源**：页面侧走 `biz/ui_layout.js` 的
 * `getSearchEntries()`，service worker 侧走 `background.js` 的 `search:index`
 * （给注入到网页里的浮层用）。所以这里的过滤规则错一点，两个入口给出的功能列表
 * 就会不一致 —— 而 SW 那一侧日常根本没人看得到。
 *
 * 这里钉住的是 2026-10-16 的那次修复：「设置类」section 不进功能区。
 * 背景见 `SETTINGS_ONLY_STEPS` 的注释 —— 用户在早期版本里保存过一份本地布局，
 * 里面那个「设置」分组（只有一个「项目说明」磁贴）会**永久覆盖**出厂配置，
 * 光从 `rules/ui_layout.json` 里删掉它没有任何作用。
 */

describe("command_index.js - 设置类 section 不进功能区", () => {
  const {
    SETTINGS_ONLY_STEPS,
    entriesFromLayout,
    buildSearchEntries
  } = require("../src/common/command_index.js");

  it("SETTINGS_ONLY_STEPS = {6, 20, 21, 28}（项目说明 / 布局配置 / 设置总览 / 插件偏好）", () => {
    expect([...SETTINGS_ONLY_STEPS].sort((a, b) => a - b)).toEqual([6, 20, 21, 28]);
  });

  /**
   * 用户本地保存过的那份布局（真实形状）。
   * 「设置」分组里只有一条 step 6 的磁贴 —— 它指向 index.html 的 #section-6「项目说明」，
   * 与设置页里那行 `data-goto="6"` 是同一个页面。整个分组连标题一起应当消失。
   */
  const storedLayout = {
    groups: [
      {
        id: "lts",
        title: "LTS",
        color: "blue",
        tiles: [
          { id: "t4-list", step: 12, label: "T-4 Outstanding" },
          { id: "order-history", step: 30, label: "Order 历史" }
        ]
      },
      {
        id: "settings-group",
        title: "设置",
        color: "gray",
        tiles: [{ id: "about", step: 6, label: "项目说明", desc: "版本信息与使用说明" }]
      }
    ]
  };

  it("本地布局里的「设置」分组不再产生条目（整组消失，不留空标题）", () => {
    const entries = entriesFromLayout([storedLayout], {});
    expect(entries.map((e) => e.tileId)).toEqual(["t4-list", "order-history"]);
    expect(entries.some((e) => e.groupTitle === "设置")).toBe(false);
    expect(entries.some((e) => /项目说明/.test(e.label))).toBe(false);
  });

  it("出厂布局里若误加了这些磁贴，同样漏不出来（过滤不看来源）", () => {
    const shipped = {
      groups: [
        {
          id: "tools",
          title: "工具",
          tiles: [
            { id: "prefs", step: 28, label: "插件偏好" },
            { id: "layout", step: 20, label: "布局配置" },
            { id: "settings", step: 21, label: "设置" },
            { id: "t4-list", step: 12, label: "T-4 Outstanding" }
          ]
        }
      ]
    };
    expect(entriesFromLayout([shipped], {}).map((e) => e.tileId)).toEqual(["t4-list"]);
  });

  it("其它磁贴不受影响：顺序、文案、常用标记与配色照旧", () => {
    const entries = entriesFromLayout([storedLayout], { favoriteIds: ["order-history"] });
    expect(entries[0]).toMatchObject({
      tileId: "order-history",
      label: "Order 历史",
      favorite: true,
      groupTitle: "LTS"
    });
    expect(entries[1].favorite).toBe(false);
  });

  it("搜索里的设置入口仍在 —— 那条通道来自 STATIC_ENTRIES，不受过滤影响", () => {
    const ids = buildSearchEntries({ candidates: [storedLayout] }).map((e) => e.id);
    expect(ids).toContain("page:settings");
    expect(ids).toContain("page:layout");
    expect(ids).toContain("page:prefs");
  });
});
