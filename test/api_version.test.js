/**
 * 单元测试: src/common/api_version.js
 *
 * 这块逻辑对着的是**最容易被误诊的一类故障**：某个 org 落后一版 → `/services/data/v67.0/...`
 * 返回 404 → `identity()` 失败 → 界面表现成「一直未连接」。那条 404 的文案跟"路径写错了"
 * 一模一样，光看日志分不出来。所以"版本解析 + 夹进实例可用范围"这两步必须有单测：
 * 解析宽松了会静默用错版本，降级判错了会把可用的 org 判成不可用。
 */

describe("api_version.js - API 版本解析与降级", () => {
  const V = require("../src/common/api_version.js");

  describe("parseApiVersion（容忍手打格式，越界一律 null）", () => {
    it("缺 minor / 带空格 / 数字类型都能解析", () => {
      expect(V.parseApiVersion("67")).toBe("67.0");
      expect(V.parseApiVersion("67.0")).toBe("67.0");
      expect(V.parseApiVersion("  67.0  ")).toBe("67.0");
      expect(V.parseApiVersion(67)).toBe("67.0");
    });

    it("保留 minor", () => {
      expect(V.parseApiVersion("67.5")).toBe("67.5");
    });

    it("范围边界：20.0 与 70.9 可用，19.x / 71 不可用", () => {
      expect(V.parseApiVersion("20.0")).toBe("20.0");
      expect(V.parseApiVersion("70.9")).toBe("70.9");
      expect(V.parseApiVersion("19.9")).toBeNull();
      expect(V.parseApiVersion("19")).toBeNull();
      expect(V.parseApiVersion("71")).toBeNull();
    });

    it("非法输入一律 null（不猜、不截断）", () => {
      expect(V.parseApiVersion("")).toBeNull();
      expect(V.parseApiVersion(null)).toBeNull();
      expect(V.parseApiVersion(undefined)).toBeNull();
      expect(V.parseApiVersion("abc")).toBeNull();
      expect(V.parseApiVersion("67.55")).toBeNull(); // minor 只允许一位
      expect(V.parseApiVersion("0")).toBeNull();
      expect(V.parseApiVersion("-1")).toBeNull();
    });
  });

  describe("normalizeApiVersion（读 storage 的防御性包装）", () => {
    it("合法就原样，非法落默认值", () => {
      expect(V.normalizeApiVersion("64.0")).toBe("64.0");
      expect(V.normalizeApiVersion("垃圾")).toBe(V.DEFAULT_API_VERSION);
      expect(V.normalizeApiVersion(null)).toBe(V.DEFAULT_API_VERSION);
    });
  });

  describe("pickUsableApiVersion（把偏好夹进实例可用范围）", () => {
    it("偏好可用 → 原样，不标记降级", () => {
      const r = V.pickUsableApiVersion("67.0", [20, 66, 67]);
      expect(r).toEqual({ version: "67.0", fellBack: false, available: [20, 66, 67] });
    });

    it("偏好不可用 → 退到**可用版本中最高的那个**并标记降级", () => {
      const r = V.pickUsableApiVersion("67.0", [20, 64, 66]);
      expect(r.version).toBe("66.0");
      expect(r.fellBack).toBe(true);
    });

    it("**探测不出来时原样返回且不标降级** —— 离线/CSP/域名不是 Salesforce 时，", () => {
      // 不该被伪装成"版本不对"，后续请求该抛什么就抛什么
      const r = V.pickUsableApiVersion("67.0", []);
      expect(r).toEqual({ version: "67.0", fellBack: false, available: [] });
      expect(V.pickUsableApiVersion("67.0", null).fellBack).toBe(false);
    });

    it("带 minor 的偏好（67.5）不在整数列表里 → 按可用最高版降级", () => {
      const r = V.pickUsableApiVersion("67.5", [20, 67]);
      expect(r.version).toBe("67.0");
      expect(r.fellBack).toBe(true);
    });

    it("没给偏好时用默认值参与判断", () => {
      expect(V.pickUsableApiVersion(null, [65]).version).toBe("65.0");
      expect(V.pickUsableApiVersion(undefined, [67]).fellBack).toBe(false);
    });
  });

  describe("probeInstanceApiVersions（版本发现端点）", () => {
    const realFetch = globalThis.fetch;
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    it("把实例返回的版本解析成升序整数数组", async () => {
      globalThis.fetch = jest.fn(async () => ({
        ok: true,
        json: async () => [{ version: "67.0" }, { version: "20.0" }, { version: 66 }]
      }));
      const got = await V.probeInstanceApiVersions("https://probe-a.example.com");
      expect(got).toEqual([20, 66, 67]);
      // 请求的是**版本发现端点**，且不需要认证 —— 打错路径就永远探测不到
      expect(globalThis.fetch.mock.calls[0][0]).toBe("https://probe-a.example.com/services/data/");
    });

    it("非 2xx / 非数组 → 空数组（当作「探测不出来」）", async () => {
      globalThis.fetch = jest.fn(async () => ({ ok: false, json: async () => ({}) }));
      expect(await V.probeInstanceApiVersions("https://probe-b.example.com")).toEqual([]);

      globalThis.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ notArray: 1 }) }));
      expect(await V.probeInstanceApiVersions("https://probe-c.example.com")).toEqual([]);
    });

    it("同一实例只探测一次（多个候选会话常属于同一个 org）", async () => {
      const spy = jest.fn(async () => ({ ok: true, json: async () => [{ version: "67.0" }] }));
      globalThis.fetch = spy;
      const url = "https://probe-cache.example.com/"; // 末尾斜杠要被归一
      await V.probeInstanceApiVersions(url);
      await V.probeInstanceApiVersions("https://probe-cache.example.com");
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("**失败不缓存**：一次网络抖动不该变成永久结论", async () => {
      const spy = jest.fn(async () => {
        throw new Error("boom");
      });
      globalThis.fetch = spy;
      const url = "https://probe-fail.example.com";
      expect(await V.probeInstanceApiVersions(url)).toEqual([]);
      expect(await V.probeInstanceApiVersions(url)).toEqual([]);
      expect(spy).toHaveBeenCalledTimes(2); // 第二次仍然真的去试了
    });

    it("空实例地址直接给空数组（不发请求）", async () => {
      const spy = jest.fn();
      globalThis.fetch = spy;
      expect(await V.probeInstanceApiVersions("")).toEqual([]);
      expect(spy).not.toHaveBeenCalled();
    });
  });
});
