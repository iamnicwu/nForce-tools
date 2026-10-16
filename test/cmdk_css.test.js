/**
 * 单元测试: src/lib/css/cmdk.css 的令牌块必须与 main.css 的 :root 一致
 *
 * 背景：全局搜索的界面要出现在**两个地方** —— 插件自己的面板（index.html，令牌来自
 * main.css 的 `:root`）和注入到别人网页里的浮层（shadow DOM，`main.css` 够不着，
 * 只能由 `cmdk.css` 自带一份 `:host { … }`）。
 *
 * 自带的这份就是一处**必然的重复**，唯一的风险是两边悄悄漂移（改了 main.css 的主色，
 * 网页浮层里的高亮还是旧颜色 —— 而这种差异只有把浮层和面板摆在一起看才发现）。
 * 所以这里逐项核对：`cmdk.css` 声明了什么，`main.css` 的 `:root` 就必须有同名同值。
 */

const fs = require("fs");
const path = require("path");

/** 按顶层分号切声明（值里可能有括号与多行，比如 font-family / linear-gradient） */
function parseDeclarations(body) {
  const out = new Map();
  const noComments = body.replace(/\/\*[\s\S]*?\*\//g, "");
  const chunks = [];
  let depth = 0;
  let current = "";
  for (const ch of noComments) {
    if (ch === "(") depth += 1;
    else if (ch === ")") depth = Math.max(0, depth - 1);
    if (ch === ";" && depth === 0) {
      chunks.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) chunks.push(current);

  for (const chunk of chunks) {
    const m = chunk.match(/^\s*(--[A-Za-z0-9-]+)\s*:\s*([\s\S]+?)\s*$/);
    if (m) out.set(m[1], m[2].replace(/\s+/g, " ").trim());
  }
  return out;
}

function readBlock(file, selector) {
  const text = fs.readFileSync(file, "utf8");
  const re = new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([\\s\\S]*?)\\n\\}`);
  const m = text.match(re);
  return m ? parseDeclarations(m[1]) : null;
}

describe("cmdk.css - shadow DOM 令牌与 main.css 的 :root 保持一致", () => {
  const cssDir = path.join(__dirname, "..", "src", "lib", "css");
  const mainTokens = readBlock(path.join(cssDir, "main.css"), ":root");
  const hostTokens = readBlock(path.join(cssDir, "cmdk.css"), ":host");

  test("两份文件都能解析出令牌块", () => {
    expect(mainTokens).not.toBeNull();
    expect(hostTokens).not.toBeNull();
    expect(hostTokens.size).toBeGreaterThan(20);
  });

  test("cmdk.css 里声明的每一个令牌，main.css 的 :root 都有同名同值", () => {
    const mismatched = [];
    for (const [name, value] of hostTokens) {
      if (!mainTokens.has(name)) {
        mismatched.push(`${name}: main.css 的 :root 里没有这个令牌（cmdk.css 里是 ${value}）`);
        continue;
      }
      if (mainTokens.get(name) !== value) {
        mismatched.push(`${name}: cmdk.css=${value} ≠ main.css=${mainTokens.get(name)}`);
      }
    }
    expect(mismatched).toEqual([]);
  });

  test("面板真正用到的令牌（--bg-primary 等）必须在自带那份里也有，否则 shadow DOM 里是空白", () => {
    const used = new Set(
      [...fs.readFileSync(path.join(cssDir, "cmdk.css"), "utf8").matchAll(/var\((--[A-Za-z0-9-]+)/g)].map(
        (m) => m[1]
      )
    );
    // 只检查"定义在 :root/:host 里"的令牌；组件内部若用到别的变量（如 --cmdk-tint
    // 这种由行内 style 提供、带兜底默认值的）不算
    const missing = [...used].filter(
      (name) => mainTokens.has(name) && !hostTokens.has(name)
    );
    expect(missing).toEqual([]);
  });
});
