/**
 * 单元测试: src/common/shortcut.js
 *
 * 这个模块把"同一条快捷键"在三种语言之间翻译（Chrome 的字符串 / KeyboardEvent 的布尔位 / 界面上的字）。
 * 一旦翻译错，用户看到的是"设置里写着 ⌘K、按下去没反应"这种**只在真机上才能发现**的问题
 * （静态预览里没有真实按键，panel-shot 也派发不了组合键）。所以这里把每条规则都钉住。
 */

const {
  SEARCH_PANEL_SHORTCUT_DEFAULT,
  normalizeKey,
  acceleratorFromEvent,
  normalizeAccelerator,
  parseAccelerator,
  matchesAccelerator,
  displayAccelerator,
  manifestDefaultShortcut
} = require("../src/common/shortcut.js");

/** 造一个 keydown 事件对象（只需要这几个字段） */
const keyEvent = (key, mods = {}) => ({
  key,
  ctrlKey: !!mods.ctrl,
  metaKey: !!mods.meta,
  altKey: !!mods.alt,
  shiftKey: !!mods.shift
});

describe("shortcut.js - 快捷键的规范化与匹配", () => {
  test("默认值是跨平台的 Mod+K（mac 上是 ⌘K，其它平台是 Ctrl+K）", () => {
    expect(SEARCH_PANEL_SHORTCUT_DEFAULT).toBe("Mod+K");
    expect(displayAccelerator(SEARCH_PANEL_SHORTCUT_DEFAULT, { mac: true })).toBe("⌘K");
    expect(displayAccelerator(SEARCH_PANEL_SHORTCUT_DEFAULT, { mac: false })).toBe("Ctrl+K");
  });

  describe("normalizeKey()", () => {
    test("接受字母（大小写都行）、数字、F1–F12", () => {
      expect(normalizeKey("k")).toBe("K");
      expect(normalizeKey("K")).toBe("K");
      expect(normalizeKey("7")).toBe("7");
      expect(normalizeKey("f5")).toBe("F5");
      expect(normalizeKey("F12")).toBe("F12");
    });

    test("拒绝方向键 / 符号键 / 空值（主键集合先只收这三类，宁缺毋滥）", () => {
      expect(normalizeKey("ArrowDown")).toBeNull();
      expect(normalizeKey(",")).toBeNull();
      expect(normalizeKey(" ")).toBeNull();
      expect(normalizeKey("")).toBeNull();
      expect(normalizeKey(undefined)).toBeNull();
      expect(normalizeKey("F13")).toBeNull();
    });
  });

  describe("acceleratorFromEvent()", () => {
    test("非 mac：Ctrl → Mod", () => {
      expect(acceleratorFromEvent(keyEvent("k", { ctrl: true }), { mac: false })).toEqual({
        ok: true,
        value: "Mod+K"
      });
    });

    test("mac：⌘ 记成 Command，⌃ 记成 Ctrl（不混用）", () => {
      expect(acceleratorFromEvent(keyEvent("k", { meta: true }), { mac: true }).value).toBe("Command+K");
      expect(acceleratorFromEvent(keyEvent("k", { ctrl: true }), { mac: true }).value).toBe("Ctrl+K");
    });

    test("多修饰键按固定顺序排列（与 Chrome 的写法一致：Alt 在 Shift 前）", () => {
      const e = keyEvent("s", { alt: true, shift: true, ctrl: false });
      expect(acceleratorFromEvent(e, { mac: false }).value).toBe("Alt+Shift+S");
    });

    test("只按 Shift+字母 → 拒绝（Chrome 也拒绝：必须含 Ctrl/⌘/Alt）", () => {
      const r = acceleratorFromEvent(keyEvent("k", { shift: true }), { mac: false });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("Ctrl");
    });

    test("光按一个字母 → 拒绝（否则面板里没法打字）", () => {
      expect(acceleratorFromEvent(keyEvent("k"), { mac: false }).ok).toBe(false);
    });

    test("主键不在支持集合里 → 给一句能看懂的话", () => {
      const r = acceleratorFromEvent(keyEvent("ArrowDown", { ctrl: true }), { mac: false });
      expect(r.ok).toBe(false);
      expect(r.error).toContain("F1");
    });
  });

  describe("normalizeAccelerator()", () => {
    test("大小写与顺序都被规范化", () => {
      expect(normalizeAccelerator("alt+shift+s")).toBe("Alt+Shift+S");
      expect(normalizeAccelerator("shift+alt+S")).toBe("Alt+Shift+S");
      expect(normalizeAccelerator("mod+k")).toBe("Mod+K");
    });

    test("非法值返回 null（prefs 层据此回落到默认值并提示）", () => {
      expect(normalizeAccelerator("shift+k")).toBeNull(); // 缺强修饰键
      expect(normalizeAccelerator("k")).toBeNull(); // 没有修饰键
      expect(normalizeAccelerator("mod+arrowdown")).toBeNull(); // 主键不支持
      expect(normalizeAccelerator("mod+nope+k")).toBeNull(); // 未知修饰键
      expect(normalizeAccelerator("")).toBeNull();
      expect(normalizeAccelerator(undefined)).toBeNull();
    });

    test("parseAccelerator 拆出修饰键集合与主键", () => {
      const p = parseAccelerator("Alt+Shift+S");
      expect([...p.mods].sort()).toEqual(["Alt", "Shift"]);
      expect(p.key).toBe("S");
    });
  });

  describe("matchesAccelerator()", () => {
    test("非 mac：Mod+K 命中 Ctrl+K", () => {
      const e = keyEvent("k", { ctrl: true });
      expect(matchesAccelerator(e, "Mod+K", { mac: false })).toBe(true);
      expect(matchesAccelerator(e, "Mod+K", { mac: true })).toBe(false);
    });

    test("mac：Mod+K 命中 ⌘K", () => {
      expect(matchesAccelerator(keyEvent("k", { meta: true }), "Mod+K", { mac: true })).toBe(true);
      expect(matchesAccelerator(keyEvent("k", { ctrl: true }), "Mod+K", { mac: true })).toBe(false);
    });

    test("**多按一个修饰键就不该命中**（否则用户想打大写的 K 时面板会跳出来）", () => {
      expect(matchesAccelerator(keyEvent("k", { ctrl: true, shift: true }), "Mod+K", { mac: false })).toBe(false);
      expect(matchesAccelerator(keyEvent("k", { ctrl: true, alt: true }), "Mod+K", { mac: false })).toBe(false);
    });

    test("Alt+Shift+S 只有两个修饰键同时按下才命中", () => {
      expect(matchesAccelerator(keyEvent("s", { alt: true, shift: true }), "Alt+Shift+S", { mac: false })).toBe(true);
      expect(matchesAccelerator(keyEvent("s", { alt: true }), "Alt+Shift+S", { mac: false })).toBe(false);
      expect(matchesAccelerator(keyEvent("s", { shift: true }), "Alt+Shift+S", { mac: false })).toBe(false);
    });

    test("大小写与 CapsLock 不影响命中", () => {
      expect(matchesAccelerator(keyEvent("K", { ctrl: true }), "Mod+K", { mac: false })).toBe(true);
      expect(matchesAccelerator(keyEvent("k", { ctrl: true, shift: true }), "Mod+Shift+K", { mac: false })).toBe(true);
    });

    test("非法 spec / 空事件一律 false（不抛异常）", () => {
      expect(matchesAccelerator(keyEvent("k", { ctrl: true }), "", { mac: false })).toBe(false);
      expect(matchesAccelerator(null, "Mod+K", { mac: false })).toBe(false);
    });
  });

  describe("displayAccelerator()", () => {
    test("mac 用符号（与 Chrome 扩展快捷键页一致）", () => {
      expect(displayAccelerator("Alt+Shift+S", { mac: true })).toBe("⌥⇧S");
      expect(displayAccelerator("Command+Shift+K", { mac: true })).toBe("⇧⌘K");
      expect(displayAccelerator("Ctrl+Alt+P", { mac: true })).toBe("⌃⌥P");
    });

    test("其它平台用英文名", () => {
      expect(displayAccelerator("Alt+Shift+S", { mac: false })).toBe("Alt+Shift+S");
      expect(displayAccelerator("Command+Shift+K", { mac: false })).toBe("Command+Shift+K");
    });

    test("非法值原样返回（界面上宁可显示怪字符串，也不要显示空白）", () => {
      expect(displayAccelerator("", { mac: false })).toBe("");
      expect(displayAccelerator("whatever", { mac: false })).toBe("whatever");
    });
  });

  describe("manifestDefaultShortcut()", () => {
    const manifest = {
      commands: {
        "open-search": {
          suggested_key: { default: "Alt+Shift+S", mac: "Alt+Shift+S" }
        }
      }
    };

    test("读 manifest，不硬编码", () => {
      expect(manifestDefaultShortcut(manifest, "open-search")).toBe("Alt+Shift+S");
    });

    test("缺失时给空串而不是抛错", () => {
      expect(manifestDefaultShortcut(manifest, "nope")).toBe("");
      expect(manifestDefaultShortcut(null, "open-search")).toBe("");
      expect(manifestDefaultShortcut({ commands: { x: {} } }, "x")).toBe("");
    });
  });
});
