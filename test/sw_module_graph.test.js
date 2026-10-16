/**
 * 单元测试: service worker 的模块图必须能**求值**（顶层不许炸）
 *
 * 为什么单列一条：`src/background.js` 是**逐字复制**进 dist 的 ESM service worker，
 * 不经打包器 —— 也就是说它和它 import 的那几个模块，**没有任何构建期语法检查**兜底：
 *   · `node --check` 把 `.js` 当 CJS/脚本解析，抓不到模块语义上的重复 `const`；
 *   · vite 不解析它（既不是入口、也不在入口的依赖链上）；
 *   · check:ui 只做正则级检查，更抓不到。
 * 而一旦顶层抛异常（重复声明 / 引用了不存在的导出 / 在 SW 里碰了 `document`），
 * Chrome **不报错，只是不注册 SW** —— 表现是快捷键没反应、消息全线石沉大海，
 * 而页面照常渲染、控制台一片安静。
 * （2026-10-15 实测踩到：删贴边浮窗时手滑多留了一份 `const OVERLAY_LEVELS`，
 *  `node --check` 与构建全绿，只有真加载扩展才发现"找不到 service worker target"。）
 *
 * 这里用**万能桩 + 调用日志**把整条图求值一遍：桩上任何属性访问都返回可调用的桩，
 * 因此只有**真正的**顶层错误（语法 / 未定义引用）才会让 require 失败。
 */

/**
 * 万能桩 + 调用日志。
 * @param {string} path 当前路径（用于记录"哪条链被调用了"）
 * @param {string[]} calls 收集调用过的路径
 */
function makeStub(path, calls) {
  const fn = function () {};
  return new Proxy(fn, {
    get: (_t, prop) => {
      if (prop === "then") return undefined; // 别让 await 把它当 thenable
      if (prop === Symbol.toPrimitive || prop === "toString") return () => "";
      return makeStub(`${path}.${String(prop)}`, calls);
    },
    apply: () => {
      calls.push(path);
      return makeStub(`${path}()`, calls);
    },
    construct: () => makeStub(`${path}()`, calls)
  });
}

describe("service worker 模块图（src/background.js）", () => {
  const saved = {};
  const GLOBALS = ["chrome", "document", "window", "navigator"];
  const calls = [];

  beforeAll(() => {
    for (const k of GLOBALS) saved[k] = Object.getOwnPropertyDescriptor(globalThis, k);
    globalThis.chrome = makeStub("chrome", calls);
    globalThis.document = makeStub("document", calls);
    globalThis.window = makeStub("window", calls);
    Object.defineProperty(globalThis, "navigator", {
      value: { platform: "Win32", userAgentData: { platform: "Windows" } },
      configurable: true
    });
    // eslint-disable-next-line global-require
    require("../src/background.js");
  });

  afterAll(() => {
    for (const k of GLOBALS) {
      if (saved[k]) Object.defineProperty(globalThis, k, saved[k]);
      else delete globalThis[k];
    }
  });

  test("整条 import 图能被求值（顶层没有重复声明 / 未定义引用）", () => {
    // beforeAll 里已经 require 过：能走到这里就说明模块图求值成功。
    // 这条断言的价值在**失败时**：重复 const / 引用了不存在的导出会在这里抛 SyntaxError，
    // 而这正是"扩展装上了、SW 却没注册"的唯一可静态复现的形态。
    expect(calls.length).toBeGreaterThan(0);
  });

  test("执行到了文件末尾：两个 runtime.onMessage 监听器都注册了", () => {
    const registered = calls.filter((c) => c === "chrome.runtime.onMessage.addListener");
    // 一个给 alarm / OneDrive 那套老逻辑，一个给搜索浮层的 `search:*`
    // （后者还依赖老监听器"开头提前放行 search:*"，见两处注释）
    expect(registered.length).toBe(2);
  });

  test("没有在顶层使用只在页面里存在的 API（SW 里没有 DOM）", () => {
    const domCalls = calls.filter((c) => c.startsWith("document.") || c.startsWith("window."));
    // 允许：模块顶层只是定义函数时不碰 DOM。真正的判据是"顶层执行路径里没有 DOM 调用"，
    // 而桩无法区分"顶层"与"函数体里"——所以这里只在**出现 DOM 调用**时报出来，
    // 让作者自己确认它确实发生在函数体里。
    expect(domCalls).toEqual([]);
  });
});
