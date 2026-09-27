#!/usr/bin/env node
/**
 * nForce Tools —— UI 一致性自检
 *
 * 背景
 *   一个功能是否"存在"，目前同时写在 6 个地方：
 *     1) src/index.html                 #section-N 卡片 + needs-connection / theme-* 类
 *     2) src/rules/ui_layout.json       首页磁贴 { id, step, label, icon, desc, requiresConnection }
 *     3) src/biz/ui_layout_default.js   同一份磁贴的 JS 兜底副本（需手工同步）
 *     4) src/biz/ui_layout.js           CONNECTION_REQUIRED_STEPS 硬编码 Set
 *     5) src/biz/ui.js                  showSection 的未连接白名单 + 各 section 的懒加载分支
 *     6) src/app.js / biz/logic.js      bindEvents 按元素 id 绑定
 *   改动任一功能都要同时改对这几处，漏一处就会出现"首页有图标点进去空白"
 *   "图标是空白方块""未连接被弹回"这类问题。
 *
 * 本脚本把这套隐含规则显式化成断言，一条命令就能定位是哪一处没对齐。
 *
 * 用法
 *   node tools/check-ui.mjs            # 人类可读报告
 *   node tools/check-ui.mjs --json     # JSON（供 CI / 编辑器消费）
 *   退出码：0 = 全部通过；1 = 存在 ERROR
 *
 * 依赖：无（只用 node 内置模块）
 *
 * 检查项
 *   A 磁贴 → section     磁贴指向的 section 必须存在
 *   B section → 磁贴     有 section 但首页没入口 = 孤儿功能
 *   C 两份默认布局        rules/ui_layout.json 与 biz/ui_layout_default.js 必须一致
 *   D 连接门禁            requiresConnection / CONNECTION_REQUIRED_STEPS / needs-connection 三处对齐
 *   E 未连接白名单        免连接功能必须出现在 showSection 白名单里
 *   F 图标映射            用到的 fa-* 必须在 common/icons.js 的 IconMap 里
 *   G 死引用              getElementById 找的 id 必须存在
 *   H 懒加载              sectionNumber === N 的分支必须有对应 section
 *   I 样式守卫  ★P1-13    字号必须走刻度令牌、不得新增硬编码颜色、通知必须显式传 type
 *   J 页面资源可达性 ★      HTML 引用的每个相对路径，构建后都必须真的存在于 dist/
 *   K 日志规范 ★           第一方 JS 禁止绕过 common/logger.js 直接调 console.*
 *   L 全局依赖 ★           大写全局必须有出处；用库全局必须调过对应的 ensureXxx()
 *                            （直接拦下 `Handsontable` / `CometD` 这类"引用了不存在的库"）
 *   M 体积预算 ★           同步 <script> 合计 / 单库 / 第三方库总量的上界
 *   N 仓库卫生 ★           .DS_Store / Thumbs.db 等系统垃圾文件
 *   O 内联脚本有效性 ★     带 src 的 <script> 不得再有内联内容（会被整段忽略）
 */

import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const ROOT = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "src");
const JSON_OUT = process.argv.includes("--json");

/* ------------------------------------------------------------------ *
 * 规则参数：与代码里的硬编码保持一致，改动这里之前先确认代码是否也变了
 * ------------------------------------------------------------------ */

// 不参与「首页磁贴 ↔ section」配对的内部 section（只能从顶栏齿轮 / 弹窗进入）
const INTERNAL_SECTIONS = {
  20: "布局配置（设置页内入口）",
  21: "设置总览（顶栏齿轮）",
  27: "Org Dashboard 详情页（入口在首页「Org 状态」面板，见 biz/org_limits.js）"
};

// 不是真图标，属于修饰类（fa-spin / fa-fw 等），不参与图标映射检查
const ICON_MODIFIERS = new Set(["fa-spin", "fa-fw", "fa-pulse", "fa-2x", "fa-lg"]);

// 已确认的"历史遗留死引用"，修了就从这里删掉即可（此刻会降级为 INFO 不再报错）
const KNOWN_DEAD_ID_ALLOWLIST = new Set([]);

/* ------------------------------------------------------------------ *
 * I. 样式守卫（P1-13）
 *
 * 这一组断言的目的不是"发现新问题"，而是给已经收敛好的设计系统上锁：
 * 2026-09 那次把 1542 处硬编码色收敛到 19 处、字号收敛到 8 级刻度，
 * 如果没有守卫，下一次加功能时很轻易又会写回 #1890ff / font-size: 15px，
 * 收敛成果会在几周内自然腐烂掉。
 *
 * 所以这里的规则是"宁可报错也不要静默放行"，确实需要例外时，
 * 就往下面的白名单里加一条 **并写清楚理由** —— 让例外变成一次显式决策。
 * ------------------------------------------------------------------ */

// 字号只允许这两套刻度（定义见 src/lib/css/main.css 的 :root）。
// 注意两套档位不同：文字是 xs/sm/base/lg/xl/2xl/3xl/4xl，图标是 sm/md/lg/xl/2xl。
const FONT_SIZE_TOKEN_RE = /^var\(--(?:fs-(?:xs|sm|base|lg|xl|2xl|3xl|4xl)|icon-(?:sm|md|lg|xl|2xl))\)$/;
// 相对/继承值随父级缩放，不属于绝对刻度表，放行
const FONT_SIZE_RELATIVE = new Set(["inherit", "0", "85%", "100%"]);

// 允许出现在 :root 之外（即组件样式里）的硬编码颜色。
// 值 = 当前基线出现次数，超出即 WARN（防止靠"多写几处"绕过收敛）。
const HEX_ALLOWLIST = {
  "#fff": 15,
  //   纯白背景/文字。没有语义等价的令牌：--text-inverse 语义是"深色底上的字"，
  //   拿它当背景在换主题时会错。白色就是白色，写死反而更诚实。
  //   （17 → 15：2026-09-25 移除首页 launcher-hero 渐变块，顺带删掉它的 2 处 #fff）
  "#52c41a": 2,
  //   ECharts canvas 绘制色（var() 不生效，必须字面量）：ui.js 分析图 ×1 +
  //   org_limits.js 仪表盘进度弧（= --success-color）×1。
  "#5470c6": 1,
  //   ECharts 默认蓝（canvas）。
  "#faad14": 1,
  //   ECharts canvas：org_limits.js 仪表盘警告色进度弧（= --warning-color）。
  "#ff4d4f": 1,
  //   ECharts canvas：org_limits.js 仪表盘危险色进度弧（= --error-color）。
  "#b7eb8f": 1,
  //   ECharts canvas：org_limits.js 仪表盘绿色分区底带（= --success-border）。
  "#ffe58f": 1,
  //   ECharts canvas：org_limits.js 仪表盘黄色分区底带（= --warning-border）。
  "#ffccc7": 1,
  //   ECharts canvas：org_limits.js 仪表盘红色分区底带（= --error-border）。
  "#cf1322": 1
  //   ECharts canvas：org_limits.js 超额档进度弧（= --error-strong，用量 >100%）。
};

// 通知类型只能是这四个；showNotification 的定义处（common/utils.js）由
// NOTIFY_DEF_RE 单独排除，不参与"必须显式传类型"的检查。
const NOTIFY_TYPES = new Set(["success", "error", "warning", "info"]);
const NOTIFY_DEF_RE = /(export\s+)?(async\s+)?function\s+showNotification\s*$/;

// 样式守卫不检查：第三方库、第三方样式、独立开发页
// （logo_generator.html 自带 <style> 且不加载 main.css，是工具不是功能页）
const STYLE_EXCLUDE_PATHS = [
  "src/lib/js/",                  // jQuery / ECharts / jsforce 等第三方 JS
  "src/lib/css/antd.min.css",     // 第三方样式表（裁剪后的产物）
  "src/lib/css/antd.full.css",    // 第三方样式表的未裁剪原始件（唯一真身，仅供 purge 脚本读取）
  "src/icons/logo_generator.html" // 独立图标生成器
];

/* ------------------------------------------------------------------ *
 * 数据采集
 * ------------------------------------------------------------------ */

const read = (p) => fs.readFileSync(p, "utf8");
const exists = (p) => fs.existsSync(p);

/**
 * 注释行判定：用于跳过注释里的示例代码。
 * 例如 dom.js 的文档注释里写了 `document.getElementById("x")` 作为用法示例，
 * 那是文档不是引用，不应该被当成死引用报出来。
 */
function isCommentLine(line) {
  const t = line.trim();
  return t.startsWith("//") || t.startsWith("/*") || t.startsWith("*");
}

function listFiles(dir, ext, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const st = fs.statSync(full);
    if (st.isDirectory()) {
      if (name === "lib" || name === "node_modules") continue; // 第三方库不参与检查
      listFiles(full, ext, out);
    } else if (name.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

const rel = (p) => path.relative(ROOT, p);

/* ------------------------------------------------------------------ *
 * L. 全局依赖守卫
 *
 * 为什么需要这一组：2026-09 那次审查里两个「功能直接不可用」的 P1
 *   （`new Handsontable(...)` 三处、`CometD` 未加载）
 * 都是「代码引用了根本不存在的全局库」，而 A~K 全部守卫都抓不到：
 * 它们检查的是 id / 类名 / 路径是否对齐，不检查"这个标识符到底从哪来"。
 *
 * 判定方式：
 *   可用的"大写开头"标识符 = JS 内置全局 ∪ 本文件（或任一第一方文件）的本地/导入绑定
 *                            ∪ common/lib_loader.js 负责注入的库全局
 *   差集非空 → ERROR。
 *
 * 关键前提是先把注释、字符串、模板字面量、正则字面量遮蔽掉，
 * 否则 `record["Order.OrderNumber"]`、SOQL 语句、Mermaid 模板里的标识符
 * 会被误报（实测：不遮蔽时误报数百处，遮蔽后只剩真正的库全局）。
 * ------------------------------------------------------------------ */

// JS / 浏览器内置里"大写开头"的全局对象。只列会用到的，新增时补一行即可。
const JS_BUILTIN_GLOBALS = new Set([
  "AbortController", "Array", "ArrayBuffer", "Atomics", "BigInt", "BigInt64Array", "BigUint64Array",
  "Blob", "Boolean", "BroadcastChannel", "CSS", "Cache", "Comment", "Crypto", "CryptoKey",
  "CustomEvent", "DOMException", "DOMParser", "DataView", "Date", "DocumentFragment", "Element",
  "Error", "EvalError", "Event", "EventTarget", "File", "FileList", "FileReader", "FinalizationRegistry",
  "Float32Array", "Float64Array", "FormData", "Function", "HTMLElement", "Headers", "IDBKeyRange",
  "Image", "IndexedDB", "Int16Array", "Int32Array", "Int8Array", "IntersectionObserver", "Intl",
  "JSON", "Map", "Math", "MediaRecorder", "MediaStream", "MessageChannel", "MutationObserver",
  "Node", "NodeList", "Notification", "Number", "Object", "OffscreenCanvas", "Path2D", "Promise",
  "Proxy", "Range", "RangeError", "ReferenceError", "Reflect", "RegExp", "Request", "ResizeObserver",
  "Response", "Set", "SharedArrayBuffer", "String", "StructuredClone", "SubtleCrypto", "Symbol",
  "SyntaxError", "Text", "TextDecoder", "TextEncoder", "TypeError", "URIError", "URL", "URLSearchParams",
  "Uint16Array", "Uint32Array", "Uint8Array", "Uint8ClampedArray", "WeakMap", "WeakRef", "WeakSet",
  "WebSocket", "Worker", "XMLHttpRequest"
]);

/* ------------------------------------------------------------------ *
 * M. 产物体积预算（防止再次把几 MB 的库塞回首屏）
 * ------------------------------------------------------------------ */

// 「同步 <script src>」加载的本地脚本合计上限：这些字节是每次打开页面都要先解析的。
// 现状只有 dayjs.min.js（约 7KB）；一旦有人把 echarts / xlsx 写回 <script>，立刻报警。
const INLINE_SCRIPT_BUDGET_BYTES = 80 * 1024;
// 单个第三方库文件上限（现状最大是 echarts 约 0.99MB；jsforce 1.34MB 已于 2026-09-28 移除）
const SINGLE_LIB_BUDGET_BYTES = 1.2 * 1024 * 1024;
// lib/js/*.js + lib/css/antd.min.css 合计上限（现状约 1.99MB）
// 移除 jsforce 前这里是 3.34MB，所以把预算从 5MB 收到 3MB —— 留约 1MB 余量，
// 同时保证「再塞一个 1MB 级的大库」会被拦住。
const TOTAL_LIB_BUDGET_BYTES = 3 * 1024 * 1024;

/** 1) index.html：section 编号 → { classes, line } */
function parseIndexHtml() {
  const file = path.join(SRC, "index.html");
  const text = read(file);
  const sections = new Map();
  const re = /<div id="section-(\d+)" class="([^"]*)"/g;
  let m;
  while ((m = re.exec(text))) {
    const line = text.slice(0, m.index).split("\n").length;
    sections.set(Number(m[1]), { classes: m[2], line, file: rel(file) });
  }
  // 同时收集 HTML 里出现的所有 id（用于死引用检查）
  const htmlIds = new Set();
  for (const idm of text.matchAll(/\sid="([^"]+)"/g)) htmlIds.add(idm[1]);
  // 页面内的跳转入口（设置页 .settings-row data-goto="N"），这类 section 不需要首页磁贴
  const gotoSteps = new Set();
  for (const gm of text.matchAll(/data-goto="(\d+)"/g)) gotoSteps.add(Number(gm[1]));
  return { text, sections, htmlIds, gotoSteps, file: rel(file) };
}

/** 2) rules/ui_layout.json：首页磁贴（运行时优先读这个文件） */
function parseLayoutJson() {
  const file = path.join(SRC, "rules", "ui_layout.json");
  if (!exists(file)) return null;
  const data = JSON.parse(read(file));
  return { data, file: rel(file) };
}

/** 3) biz/ui_layout_default.js：磁贴的内置 JS 兜底副本（应保持与 JSON 一致） */
function parseLayoutDefault() {
  const file = path.join(SRC, "biz", "ui_layout_default.js");
  if (!exists(file)) return null;
  const text = read(file);
  const m = text.match(/const DEFAULT_LAYOUT\s*=\s*([\s\S]*?)\n\};/);
  if (!m) return null;
  // 对象字面量是纯数据（无函数），用 Function 求值即可，避免额外依赖
  const data = new Function(`return ${m[1]}\n}`)();
  return { data, file: rel(file) };
}

/** 4) biz/ui_layout.js：CONNECTION_REQUIRED_STEPS */
function parseConnectionRequiredSteps() {
  const text = read(path.join(SRC, "biz", "ui_layout.js"));
  const m = text.match(/CONNECTION_REQUIRED_STEPS\s*=\s*new Set\(\[([\s\S]*?)\]\)/);
  if (!m) return null;
  return new Set(
    m[1]
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0)
  );
}

/** 5) biz/ui.js：未连接可访问的白名单 */
function parseUnconnectedAllowlist() {
  const text = read(path.join(SRC, "biz", "ui.js"));
  const m = text.match(/!appState\.is_connected\s*&&\s*!\[([0-9,\s]+)\]\.includes/);
  if (!m) return null;
  return new Set(
    m[1]
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n))
  );
}

/** 5b) biz/ui.js：各 section 的懒加载分支（if (sectionNumber === N)） */
function parseLazyLoadSteps() {
  const text = read(path.join(SRC, "biz", "ui.js"));
  const set = new Set();
  for (const m of text.matchAll(/if\s*\(\s*sectionNumber\s*===\s*(\d+)/g)) set.add(Number(m[1]));
  return set;
}

/** 6) common/icons.js：IconMap 已映射的 fa-* */
function parseMappedIcons() {
  const text = read(path.join(SRC, "common", "icons.js"));
  const m = text.match(/export const IconMap\s*=\s*\{([\s\S]*?)\n\};/);
  if (!m) return null;
  return new Set([...m[1].matchAll(/'(fa-[a-z0-9-]+)'/g)].map((x) => x[1]));
}

/** 7) JS 源码：getElementById 引用的 id + JS 里动态生成的 id="x" */
function parseJsIdUsage() {
  const jsFiles = [...listFiles(SRC, ".js")];
  const refs = new Map(); // id -> [ {file, line} ]
  const dynamicIds = new Set();
  for (const f of jsFiles) {
    const text = read(f);
    const lines = text.split("\n");
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      for (const m of line.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) {
        const id = m[1];
        if (!refs.has(id)) refs.set(id, []);
        refs.get(id).push({ file: rel(f), line: i + 1 });
      }
      // 动态创建：JS 模板里写了 id="xxx"，或 element.id = "xxx"
      if (!isCommentLine(line)) {
        for (const m of line.matchAll(/\bid="([^"]+)"/g)) dynamicIds.add(m[1]);
        for (const m of line.matchAll(/\.id\s*=\s*["']([^"']+)["']/g)) dynamicIds.add(m[1]);
      }
    });
  }
  return { refs, dynamicIds };
}

/* --- I. 样式守卫的数据采集 ------------------------------------------ */

/**
 * 把块注释 / HTML 注释替换成等长空白（保留换行，行号不变）。
 * 必须在统计颜色字号之前调用：注释里写"以前这里是 #d1fae5"属于文档，
 * 不能被当成真代码报出来。
 */
function maskComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
}

/** 剥离 :root { … } 块：令牌的定义处本来就必须写死具体颜色值 */
function stripRootBlock(text) {
  return text.replace(/:root\s*\{[\s\S]*?\n\}/g, "");
}

/** 收集项目自有的样式载体：css 文件 + html/js 里的内联 style="" */
function collectStyleFiles() {
  const out = [];
  const walk = (dir) => {
    for (const name of fs.readdirSync(dir)) {
      const full = path.join(dir, name);
      if (fs.statSync(full).isDirectory()) {
        walk(full);
      } else if (/\.(css|html|js)$/.test(name)) {
        const r = rel(full);
        if (STYLE_EXCLUDE_PATHS.some((p) => r === p || r.startsWith(p))) continue;
        out.push(full);
      }
    }
  };
  walk(SRC);
  return out;
}

/** font-size 违规 + 硬编码颜色统计 */
function parseStyleGuards() {
  const fontSizeOffenders = [];
  const hexOffenders = []; // 不在白名单里的 hex
  const hexCount = new Map(); // hex -> 出现次数（含白名单内的）

  for (const f of collectStyleFiles()) {
    const lines = stripRootBlock(maskComments(read(f))).split("\n");
    lines.forEach((line, i) => {
      for (const m of line.matchAll(/font-size\s*:\s*([^;}"'\n]+)/g)) {
        const v = m[1].trim();
        if (FONT_SIZE_TOKEN_RE.test(v) || FONT_SIZE_RELATIVE.has(v)) continue;
        fontSizeOffenders.push({ file: rel(f), line: i + 1, value: v });
      }
      for (const m of line.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) {
        const hex = m[0].toLowerCase();
        hexCount.set(hex, (hexCount.get(hex) || 0) + 1);
        if (!(hex in HEX_ALLOWLIST)) hexOffenders.push({ file: rel(f), line: i + 1, hex });
      }
    });
  }
  return { fontSizeOffenders, hexOffenders, hexCount };
}

/**
 * showNotification 调用必须显式传第 2 个参数（type）。
 * 自动取参数时要按括号深度切分，否则 showNotification(a ? "x" : "y", ...) 
 * 和 message 里带逗号的调用都会解析错。
 */
function parseNotificationTypes() {
  const offenders = [];
  for (const f of listFiles(path.join(SRC), ".js")) {
    const text = read(f);
    for (const m of text.matchAll(/showNotification\s*\(/g)) {
      // 跳过函数定义本身
      if (NOTIFY_DEF_RE.test(text.slice(Math.max(0, m.index - 40), m.index))) continue;
      const line = text.slice(0, m.index).split("\n").length;

      // 括号平衡，取出实参串
      let i = m.index + m[0].length;
      let depth = 1;
      const start = i;
      while (i < text.length && depth > 0) {
        if (text[i] === "(") depth++;
        else if (text[i] === ")") depth--;
        i++;
      }
      const args = text.slice(start, i - 1);

      // 按顶层逗号切分参数
      const parts = [];
      let curly = 0;
      let cur = "";
      for (const ch of args) {
        if ("([{".includes(ch)) curly++;
        else if (")]}".includes(ch)) curly--;
        if (ch === "," && curly === 0) {
          parts.push(cur);
          cur = "";
        } else cur += ch;
      }
      parts.push(cur);

      const type = (parts[1] ?? "").trim();
      if (!type) {
        offenders.push({ file: rel(f), line, type: "<缺失>", reason: "未显式传 type（会默认渲染成绿色成功提示）" });
        continue;
      }
      // 三元表达式（ok ? "success" : "error"）也允许，但每个字面量都必须在集合里
      const literals = [...type.matchAll(/["']([a-z]+)["']/g)].map((x) => x[1]);
      if (!literals.length) {
        offenders.push({ file: rel(f), line, type, reason: "type 不是字面量，无法静态校验" });
        continue;
      }
      const bad = literals.filter((t) => !NOTIFY_TYPES.has(t));
      if (bad.length) {
        offenders.push({ file: rel(f), line, type, reason: `未知类型 ${bad.join("/")}` });
      }
    }
  }
  return { offenders };
}

/* --- J. 页面资源可达性 ---------------------------------------------- *
 * 起因（真实缺陷，2026-09 修复）：
 *   login.html / popup.html 改成 `import { replaceIcons } from "./common/icons.js"` 之后，
 *   src/ 直接加载一切正常（源码目录本身就是原生 ESM），但 **构建产物 dist/ 里根本没有
 *   common/ 目录** —— icons.js 既不是 webpack 入口，也不在 CopyPlugin 的复制列表里。
 *   于是 dist 下这个 import 404，replaceIcons() 从不执行，页面上的
 *   <i class="fa-*"> 全部退化成空白方块。
 *
 * 教训：HTML 里写一个相对路径很容易，但"这个路径在 dist/ 里到底存不存在"
 * 取决于 webpack 配置，两者相隔很远。这条检查把它拉近到一条命令。
 * ------------------------------------------------------------------ */

/** 从 webpack.config.js 解析出：入口产出的文件名 + CopyPlugin 的复制范围 */
function parseBuildPlan() {
  const file = path.join(ROOT, "webpack.config.js");
  if (!exists(file)) return null;
  const cfg = read(file);

  const entries = new Set();
  const em = cfg.match(/entry\s*:\s*\{([\s\S]*?)\n\s*\}/);
  if (em) for (const m of em[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*['"]/g)) entries.add(`${m[1]}.js`);

  const copies = [];
  for (const m of cfg.matchAll(/from\s*:\s*['"]([^'"]+)['"]\s*,\s*to\s*:\s*['"]([^'"]+)['"]/g)) {
    copies.push({ from: m[1], to: m[2] });
  }
  return { entries, copies, file: rel(file) };
}

/** HTML 页面里引用的相对资源（script src / link href / 内联模块的 import from） */
function collectHtmlRefs() {
  const refs = [];
  for (const name of ["index.html", "login.html", "popup.html"]) {
    const p = path.join(SRC, name);
    if (!exists(p)) continue;
    read(p)
      .split("\n")
      .forEach((line, i) => {
        for (const m of line.matchAll(/<script[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi))
          refs.push({ from: name, line: i + 1, ref: m[1], kind: "script" });
        for (const m of line.matchAll(/<link[^>]*\shref\s*=\s*["']([^"']+)["']/gi))
          refs.push({ from: name, line: i + 1, ref: m[1], kind: "link" });
        for (const m of line.matchAll(/import\s*[\w*{},\s$]*\s*from\s*["']([^"']+)["']/g))
          refs.push({ from: name, line: i + 1, ref: m[1], kind: "import" });
      });
  }
  return refs;
}

/** manifest.json 里引用的相对资源 */
function collectManifestRefs() {
  const p = path.join(SRC, "manifest.json");
  if (!exists(p)) return [];
  const mf = JSON.parse(read(p));
  const out = [];
  const push = (v, where) => {
    if (typeof v === "string" && v && !/^(https?:)?\/\//.test(v) && !v.includes("*")) {
      out.push({ from: "manifest.json", line: 0, ref: v, kind: where });
    }
  };
  push(mf.background && mf.background.service_worker, "background");
  push(mf.action && mf.action.default_popup, "action.default_popup");
  // 侧边栏宿主页（Chrome 114+ Side Panel）：同样是"HTML 里的相对引用"，
  // 必须能在 dist 里落地，否则点图标开出来的侧边栏是 404 白屏。
  push(mf.side_panel && mf.side_panel.default_path, "side_panel.default_path");
  (mf.content_scripts || []).forEach((cs) => {
    (cs.js || []).forEach((f) => push(f, "content_scripts.js"));
    (cs.css || []).forEach((f) => push(f, "content_scripts.css"));
  });
  (mf.web_accessible_resources || []).forEach((w) => {
    const res = typeof w === "string" ? [w] : w.resources || [];
    res.forEach((f) => push(f, "web_accessible_resources"));
  });
  for (const [, v] of Object.entries(mf.icons || {})) push(v, "icons");
  return out;
}

/* ------------------------------------------------------------------ *
 * K. 日志规范守卫
 *
 * 2026-09 统一日志格式后上锁：全插件日志一律走 common/logger.js
 * （统一前缀 [nForce][TAG]、分级 debug/info/warn/error、maskSecret 脱敏）。
 * 直接写 console.* 会让格式再次发散 —— 想加日志就 import createLogger。
 * logger 自身是唯一允许触达 console 的实现处。
 * ------------------------------------------------------------------ */

const LOG_GUARD_EXCLUDES = new Set([
  "src/common/logger.js" // 统一 logger 的唯一实现处
]);

/** 裸 console.* 调用扫描（跳过注释；行内 // 之后的代码视为注释） */
function parseLogGuard() {
  const offenders = [];
  for (const f of listFiles(SRC, ".js")) {
    const r = rel(f);
    if (LOG_GUARD_EXCLUDES.has(r)) continue;
    maskComments(read(f))
      .split("\n")
      .forEach((line, i) => {
        const code = line.split("//")[0];
        if (/\bconsole\.(?:log|info|warn|error|debug)\s*\(/.test(code)) {
          offenders.push({ file: r, line: i + 1 });
        }
      });
  }
  return { offenders };
}

/**
 * 遮蔽注释 / 字符串 / 模板字面量 / 正则字面量，保留 `${ }` 内的表达式为代码。
 * 等长替换（保留换行），因此行号与原文一一对应。
 *
 * 正则字面量用启发式判断：看 `/` 前面最近的有效字符，
 * 若是 `)` `]` 标识符字符或数字则是除号，否则是正则。
 * 不做这一步的话，`escapeHtml` 里的 `/"/g` 会被当成字符串开头，
 * 从这里往后整个文件的遮蔽状态全部错位（实测：utils.js 之后的 `Order.OrderNumber` 会误报）。
 */
function maskStringsAndComments(text) {
  let out = "";
  let i = 0;
  const n = text.length;

  const isRegexStart = (idx) => {
    let j = idx - 1;
    while (j >= 0 && /\s/.test(text[j])) j--;
    if (j < 0) return true;
    if (!/[)\]}A-Za-z0-9_$]/.test(text[j])) return true;
    const w = /([A-Za-z_$][\w$]*)\s*$/.exec(text.slice(Math.max(0, j - 12), j + 1));
    return !!w && /^(return|typeof|instanceof|case|in|of|do|else|void|delete|new|yield|await)$/.test(w[1]);
  };

  const skipString = (quote) => {
    out += " ";
    i++;
    while (i < n && text[i] !== quote) {
      if (text[i] === "\\") { out += "  "; i += 2; continue; }
      out += text[i] === "\n" ? "\n" : " ";
      i++;
    }
    if (i < n) { out += " "; i++; }
  };

  while (i < n) {
    const c = text[i];
    const c2 = text[i + 1];
    if (c === "/" && c2 === "/") {
      while (i < n && text[i] !== "\n") { out += " "; i++; }
      continue;
    }
    if (c === "/" && c2 === "*") {
      out += "  "; i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) { out += text[i] === "\n" ? "\n" : " "; i++; }
      if (i < n) { out += "  "; i += 2; }
      continue;
    }
    if (c === "/" && isRegexStart(i)) {
      out += " "; i++;
      let inClass = false;
      while (i < n) {
        const ch = text[i];
        if (ch === "\\") { out += "  "; i += 2; continue; }
        if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "\n") break;
        else if (ch === "/" && !inClass) break;
        out += " "; i++;
      }
      if (i < n && text[i] === "/") { out += " "; i++; }
      while (i < n && /[gimsuyvd]/.test(text[i])) { out += " "; i++; }
      continue;
    }
    if (c === "'" || c === '"') { skipString(c); continue; }
    if (c === "`") {
      out += " "; i++;
      while (i < n && text[i] !== "`") {
        if (text[i] === "\\") { out += "  "; i += 2; continue; }
        if (text[i] === "$" && text[i + 1] === "{") {
          out += "${"; i += 2;
          let depth = 1;
          while (i < n && depth > 0) {
            if (text[i] === "{") depth++;
            else if (text[i] === "}") { depth--; if (!depth) break; }
            if (text[i] === "'" || text[i] === '"' || text[i] === "`") { skipString(text[i]); continue; }
            out += text[i]; i++;
          }
          if (i < n) { out += "}"; i++; }
          continue;
        }
        out += text[i] === "\n" ? "\n" : " "; i++;
      }
      if (i < n) { out += " "; i++; }
      continue;
    }
    out += c; i++;
  }
  return out;
}

/** common/lib_loader.js 声明的「库 → 注入后的全局名 / ensure 函数名」 */
function parseLazyLibs() {
  const file = path.join(SRC, "common", "lib_loader.js");
  if (!exists(file)) return null;
  const text = read(file);
  const block = text.match(/GLOBAL_NAME\s*=\s*\{([\s\S]*?)\}/);
  const globals = new Set();
  const ensureFn = new Map();
  if (!block) return { globals, ensureFn, missingExports: [], file: rel(file) };

  // 实际导出的 ensure* 函数名（不靠命名约定猜，XLSX / JSZip 这种大小写约定推不出来）
  const exportedEnsure = new Set();
  for (const m of text.matchAll(/export\s+(?:async\s+)?(?:function|const|let|var)\s+(ensure[A-Za-z0-9_$]*)/g)) {
    exportedEnsure.add(m[1]);
  }
  const byLower = new Map([...exportedEnsure].map((n) => [n.toLowerCase(), n]));

  const missingExports = [];
  for (const m of block[1].matchAll(/([A-Za-z_$][\w$]*)\s*:\s*["']([^"']+)["']/g)) {
    const libKey = m[1];
    globals.add(m[2]);
    const guess = `ensure${libKey[0].toUpperCase()}${libKey.slice(1)}`;
    const fn = exportedEnsure.has(guess) ? guess : byLower.get(guess.toLowerCase());
    if (fn) ensureFn.set(m[2], fn);
    else missingExports.push({ libKey, global: m[2], guess });
  }
  return { globals, ensureFn, missingExports, file: rel(file) };
}

/**
 * 从形参串里抠出绑定名。支持解构、默认值、rest、以及 `a: b` 重命名。
 * 目的只有一个：别把形参误判成"没有出处的全局库"。
 */
function collectParamNames(sig, out) {
  for (const raw of sig.split(",")) {
    let t = raw.trim();
    if (!t) continue;
    t = t.replace(/^\.\.\./, "");            // rest
    t = t.split("=")[0].trim();              // 默认值
    t = t.replace(/[{}[\]]/g, " ");          // 解构花括号
    for (const piece of t.split(/[\s:]+/)) {
      const name = piece.trim();
      if (/^[A-Za-z_$][\w$]*$/.test(name)) out.add(name);
    }
  }
}

/** L. 全局依赖守卫：大写全局必须"有出处"；用库全局必须调过对应的 ensure 函数 */
function parseGlobalDependencyGuard() {
  const lazy = parseLazyLibs();
  const libGlobals = lazy ? lazy.globals : new Set();
  const files = listFiles(SRC, ".js");

  // 收集所有第一方文件里声明过的绑定（跨文件并集 = 宽容的近似，宁可漏报不误报）
  const locals = new Set();
  for (const f of files) {
    const code = maskStringsAndComments(read(f));
    for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g)) locals.add(m[1]);
    for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)/g)) locals.add(m[1]);
    for (const m of code.matchAll(/\bclass\s+([A-Za-z_$][\w$]*)/g)) locals.add(m[1]);
    for (const m of code.matchAll(/\bimport\s+([A-Za-z_$][\w$]*)\s*(?:,|from)/g)) locals.add(m[1]);
    for (const m of code.matchAll(/\bimport\s*\*\s*as\s+([A-Za-z_$][\w$]*)/g)) locals.add(m[1]);
    for (const m of code.matchAll(/\bimport\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(",")) {
        const t = part.trim();
        if (!t) continue;
        const as = t.split(/\s+as\s+/);
        locals.add((as[1] || as[0]).trim());
      }
    }

    // 形参也必须是"有出处的"。漏了这一步会误报：
    // t2rules.js 的 `function evaluateStatusRules(ctx, bandKeywords)` 里
    // `bandKeywords.some(...)` 会被当成来历不明的大写全局。
    // 形参永远不可能是外部库全局，所以收集它们只会减少误报。
    for (const m of code.matchAll(/\bfunction\s*\*?\s*[A-Za-z_$][\w$]*\s*\(([^)]*)\)/g))
      collectParamNames(m[1], locals);          // function 声明 / 表达式
    for (const m of code.matchAll(/\(([^()]*)\)\s*=>/g))
      collectParamNames(m[1], locals);          // (a, b) => …（无参 () 与单参同形）
    for (const m of code.matchAll(/^\s*(?:static\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{/gm))
      collectParamNames(m[2], locals);          // 类方法 / 对象方法简写
  }

  const unknown = new Map();     // 名字 → [{file,line,kind}]
  const missingEnsure = [];      // 用了库全局但文件里没出现对应 ensureXxx
  for (const f of files) {
    const r = rel(f);
    const raw = read(f);
    const code = maskStringsAndComments(raw);

    code.split("\n").forEach((line, i) => {
      const hit = (name, kind) => {
        if (JS_BUILTIN_GLOBALS.has(name) || locals.has(name) || libGlobals.has(name)) return;
        if (!unknown.has(name)) unknown.set(name, []);
        unknown.get(name).push({ file: r, line: i + 1, kind });
      };
      for (const m of line.matchAll(/\bnew\s+([A-Z][\w$]*)\s*\(/g)) hit(m[1], "new");
      for (const m of line.matchAll(/(?:^|[^\w.$])([A-Z][\w$]*)\s*\.\s*[A-Za-z_$]/g)) hit(m[1], "成员访问");
    });

    // 库全局与 ensure 函数必须成对出现（同一文件内）
    for (const [globalName, ensureName] of lazy ? lazy.ensureFn : []) {
      const used = new RegExp(`(?:^|[^\\w.$])${globalName}\\s*[.(]`).test(code);
      if (!used) continue;
      if (globalName === "jsforce" && r === rel(lazy.file)) continue; // lib_loader 自己就是加载器
      if (!new RegExp(`\\b${ensureName}\\b`).test(code)) {
        missingEnsure.push({ file: r, global: globalName, ensure: ensureName });
      }
    }
  }

  return { unknown, missingEnsure, libGlobals, missingExports: lazy ? lazy.missingExports : [], localCount: locals.size };
}

/** M. 产物体积预算 */
function parseSizeBudget() {
  const pages = ["index.html", "login.html", "popup.html"];
  const inlineScripts = [];
  for (const name of pages) {
    const p = path.join(SRC, name);
    if (!exists(p)) continue;
    for (const m of read(p).matchAll(/<script[^>]*\ssrc\s*=\s*["']([^"']+)["']/gi)) {
      const ref = m[1];
      if (/^(https?:)?\/\//.test(ref)) continue;
      const clean = ref.replace(/^\.\//, "");
      // 只统计第三方库脚本。app.js / login_app.js 是应用自身的入口 bundle，
      // 是"必须存在的那一份代码"，不构成可以优化掉的阻塞成本。
      if (!clean.startsWith("lib/")) continue;
      const abs = path.join(SRC, clean);
      if (exists(abs) && clean.endsWith(".js")) {
        inlineScripts.push({ page: name, ref: clean, bytes: fs.statSync(abs).size });
      }
    }
  }
  const libs = [];
  const libDir = path.join(SRC, "lib", "js");
  if (exists(libDir)) {
    for (const name of fs.readdirSync(libDir)) {
      if (!name.endsWith(".js")) continue;
      libs.push({ ref: `lib/js/${name}`, bytes: fs.statSync(path.join(libDir, name)).size });
    }
  }
  const antd = path.join(SRC, "lib", "css", "antd.min.css");
  if (exists(antd)) libs.push({ ref: "lib/css/antd.min.css", bytes: fs.statSync(antd).size });
  return { inlineScripts, libs };
}

/** N. 仓库卫生：不应出现在仓库里的系统垃圾文件 */
function parseRepoHygiene() {
  const junkNames = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 3) return;
    let entries;
    try {
      entries = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const name of entries) {
      if (name === "node_modules" || name === ".git") continue;
      const full = path.join(dir, name);
      if (junkNames.has(name)) found.push(rel(full));
      else if (fs.statSync(full).isDirectory()) walk(full, depth + 1);
    }
  };
  walk(ROOT, 0);
  return { found };
}

/* ------------------------------------------------------------------ *
 * O. <script> 内联有效性
 *
 * 带 src 的 <script>，其**内联内容会被浏览器整段忽略**（HTML 规范：src 存在时
 * 元素的子内容不参与解析）。这类写法不报错、不警告，控制台一片安静，
 * 只是那段代码永远不执行 —— 2026-09 登录页就中过：`<script src="login_app.js"
 * type="module">` 后面直接跟了内联模块，结果 replaceIcons() 从未跑过
 * （7 个图标长期是空白方块），#login-version 也一直停在占位符 "v-"。
 *
 * 要"既加载外部脚本又跑内联代码"，只能拆成两个 <script> 标签。
 * ------------------------------------------------------------------ */

function parseInlineScriptValidity() {
  const offenders = [];
  for (const name of ["index.html", "login.html", "popup.html"]) {
    const p = path.join(SRC, name);
    if (!exists(p)) continue;
    // 先去掉 HTML 注释：注释掉的 <script> 不参与解析，不该被误报
    const text = read(p).replace(/<!--[\s\S]*?-->/g, (m) => m.replace(/[^\n]/g, " "));
    const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
    for (const m of text.matchAll(re)) {
      const attrs = m[1];
      const body = m[2];
      if (!/\bsrc\s*=/i.test(attrs)) continue;
      if (!body.trim()) continue;
      const line = text.slice(0, m.index).split("\n").length;
      const src = (attrs.match(/\bsrc\s*=\s*["']([^"']+)["']/i) || [])[1] || "?";
      offenders.push({
        from: name,
        line,
        src,
        bytes: Buffer.byteLength(body, "utf8"),
        head: body.trim().split("\n")[0].slice(0, 70)
      });
    }
  }
  return { offenders };
}

const kb = (b) => `${(b / 1024).toFixed(1)}KB`;
const mb = (b) => `${(b / 1024 / 1024).toFixed(2)}MB`;

/* ------------------------------------------------------------------ *
 * 断言
 * ------------------------------------------------------------------ */

const findings = [];
const add = (level, check, message, detail) => findings.push({ level, check, message, detail });

function run() {
  const html = parseIndexHtml();
  const layoutJson = parseLayoutJson();
  const layoutDefault = parseLayoutDefault();
  const connSteps = parseConnectionRequiredSteps();
  const allowlist = parseUnconnectedAllowlist();
  const lazySteps = parseLazyLoadSteps();
  const mappedIcons = parseMappedIcons();
  const jsIds = parseJsIdUsage();

  // 以运行时真正生效的 rules/ui_layout.json 为准
  const tiles = [];
  if (layoutJson) {
    layoutJson.data.groups.forEach((g) => {
      (g.tiles || []).forEach((t) =>
        tiles.push({
          id: t.id,
          step: Number(t.step),
          label: t.label,
          icon: t.icon,
          group: g.id,
          requiresConnection: t.requiresConnection !== false,
          source: layoutJson.file
        })
      );
    });
  }

  const tileByStep = new Map(tiles.map((t) => [t.step, t]));
  const tileIds = new Set(tiles.map((t) => t.id));

  /* --- A. 磁贴 → section 必须存在（否则点进去无反应/白屏） --- */
  for (const t of tiles) {
    if (!html.sections.has(t.step)) {
      add(
        "ERROR",
        "A. 磁贴↔section",
        `磁贴「${t.label}」(${t.id}) 指向 section-${t.step}，但 index.html 里没有这个 section`,
        `${t.source} → 需要新建 <div id="section-${t.step}" class="... step-section">，或修正 step`
      );
    }
  }

  /* --- B. section ↔ 磁贴 双向：有 section 但首页没入口 = 孤儿功能 --- */
  for (const [step, info] of html.sections) {
    if (INTERNAL_SECTIONS[step]) continue;
    if (tileByStep.has(step)) continue;
    if (html.gotoSteps.has(step)) continue; // 设置页里有 data-goto 入口，不算孤儿
    add(
      "ERROR",
      "B. section↔磁贴",
      `section-${step}（${info.file}:${info.line}）在首页没有任何磁贴入口，用户点不进去`,
      `在 rules/ui_layout.json 的某个 group.tiles 里补一条 { "id": "...", "step": ${step}, ... }`
    );
  }

  /* --- C. 两份默认布局必须一致（JSON 是主入口，JS 是兜底） --- */
  if (layoutJson && layoutDefault) {
    const jsonIds = new Set(tiles.map((t) => t.id));
    const defTiles = [];
    (layoutDefault.data.groups || []).forEach((g) =>
      (g.tiles || []).forEach((t) => defTiles.push({ ...t, group: g.id }))
    );
    const defIds = new Set(defTiles.map((t) => t.id));
    const onlyJson = [...jsonIds].filter((x) => !defIds.has(x));
    const onlyDef = [...defIds].filter((x) => !jsonIds.has(x));
    if (onlyJson.length || onlyDef.length) {
      add(
        "WARN",
        "C. 两份默认布局",
        "rules/ui_layout.json 与 biz/ui_layout_default.js 的磁贴不一致（仅改一份，另一份会滞后）",
        [
          onlyJson.length ? `  仅 JSON 有：${onlyJson.join(", ")}` : "",
          onlyDef.length ? `  仅 JS 兜底有：${onlyDef.join(", ")}` : ""
        ]
          .filter(Boolean)
          .join("\n")
      );
    }
    // favorites.ids 引用的磁贴必须存在
    const favIds = (layoutJson.data.favorites && layoutJson.data.favorites.ids) || [];
    const badFav = favIds.filter((id) => !jsonIds.has(id));
    if (badFav.length) {
      add(
        "ERROR",
        "C. 两份默认布局",
        `favorites.ids 引用了不存在的磁贴：${badFav.join(", ")}`,
        "这些 id 会被静默丢弃，导致「常用功能」恢复默认后条数不对"
      );
    }
  }

  /* --- D. requiresConnection 三处必须对齐 --- */
  if (connSteps) {
    for (const t of tiles) {
      const sec = html.sections.get(t.step);
      if (!sec) continue;
      const htmlNeeds = sec.classes.includes("needs-connection");
      const inSet = connSteps.has(t.step);
      const declared = t.requiresConnection;

      if (inSet && !htmlNeeds) {
        add(
          "WARN",
          "D. 连接门禁",
          `step ${t.step}（${t.label}）在 CONNECTION_REQUIRED_STEPS 里，但 index.html 的 section 没有 needs-connection 类`,
          "未连接时首页图标会被锁，点进去却能看到内容 —— 两处语义应一致"
        );
      }
      if (!inSet && htmlNeeds) {
        add(
          "WARN",
          "D. 连接门禁",
          `step ${t.step}（${t.label}）的 section 带 needs-connection，但不在 CONNECTION_REQUIRED_STEPS 里`,
          "连接成功后 refreshSectionLocks 不会解锁这个 section（它只处理 .needs-connection），实际会被 showSection 白名单拦下"
        );
      }
      if (declared === false && htmlNeeds) {
        add(
          "ERROR",
          "D. 连接门禁",
          `磁贴「${t.label}」声明 requiresConnection: false，但 section-${t.step} 带 needs-connection 类`,
          "声明与实际相反，未连接时会显示成锁定状态"
        );
      }
      if (declared === false && connSteps.has(t.step)) {
        add("ERROR", "D. 连接门禁", `磁贴「${t.label}」声明免连接，却出现在 CONNECTION_REQUIRED_STEPS 里`, "");
      }
      // 声明需要连接，但三处都没有真正门禁住：未连接时图标不显示锁定，
      // 点进去却被 showSection 的白名单弹回「连接设置」。用户看到的是「能点但没反应」。
      if (declared !== false && !inSet && !htmlNeeds && !(allowlist && allowlist.has(t.step))) {
        add(
          "WARN",
          "D. 连接门禁",
          `磁贴「${t.label}」(step ${t.step}) 声明 requiresConnection: true，但既不在 CONNECTION_REQUIRED_STEPS 里，section 也没有 needs-connection 类`,
          "未连接时它不会被锁（看着可点），点进去却会被 showSection 弹回连接设置。二选一：真需要连接就补进 CONNECTION_REQUIRED_STEPS 并给 section 加 needs-connection 类；确实不需要（纯本地功能）就把 requiresConnection 改成 false 并加进未连接白名单"
        );
      }
    }
  } else {
    add("WARN", "D. 连接门禁", "未能从 biz/ui_layout.js 解析出 CONNECTION_REQUIRED_STEPS", "请检查该常量是否被重命名");
  }

  /* --- E. 免连接功能必须出现在 showSection 的未连接白名单里 --- */
  if (allowlist) {
    for (const t of tiles) {
      if (t.requiresConnection === false && !allowlist.has(t.step)) {
        add(
          "ERROR",
          "E. 未连接白名单",
          `「${t.label}」(step ${t.step}) 声明免连接，但不在 biz/ui.js 的未连接白名单 [${[...allowlist].join(", ")}] 里`,
          "未连接时点它会被弹回连接设置页"
        );
      }
    }
    for (const step of allowlist) {
      const t = tileByStep.get(step);
      if (t && t.requiresConnection !== false) {
        add(
          "WARN",
          "E. 未连接白名单",
          `白名单里的 step ${step}（${t.label}）在布局里是 requiresConnection: true`,
          "语义矛盾：它在未连接时可达，但首页图标是锁的"
        );
      }
    }
  } else {
    add("WARN", "E. 未连接白名单", "未能从 biz/ui.js 解析出未连接白名单", "请检查 showSection 的判断条件是否被改写");
  }

  /* --- F. 图标：用到但没映射 → 页面显示为空白方块 --- */
  if (mappedIcons) {
    const used = new Map(); // icon -> [ {file, line} ]
    const collect = (text, file) => {
      text.split("\n").forEach((line, i) => {
        if (isCommentLine(line)) return;
        for (const m of line.matchAll(/\bfa-[a-z0-9-]+/g)) {
          const icon = m[0];
          if (ICON_MODIFIERS.has(icon)) continue;
          if (!used.has(icon)) used.set(icon, []);
          used.get(icon).push({ file, line: i + 1 });
        }
      });
    };
    collect(html.text, html.file);
    if (layoutJson) collect(read(path.join(SRC, "rules", "ui_layout.json")), layoutJson.file);
    for (const f of listFiles(path.join(SRC, "biz"), ".js")) collect(read(f), rel(f));

    for (const [icon, places] of used) {
      if (mappedIcons.has(icon)) continue;
      // 只报「首页磁贴」和「index.html」里用到的，JS 内部的可降级为提示
      const inHtml = places.some((p) => p.file === html.file);
      const inLayout = places.some((p) => layoutJson && p.file === layoutJson.file);
      const level = inHtml || inLayout ? "ERROR" : "INFO";
      add(
        level,
        "F. 图标映射",
        `${icon} 未在 common/icons.js 的 IconMap 中映射（会渲染成空白）`,
        places
          .slice(0, 4)
          .map((p) => `  ${p.file}:${p.line}`)
          .join("\n") + (places.length > 4 ? `\n  …共 ${places.length} 处` : "")
      );
    }
  }

  /* --- G. 死引用：JS 找的 id 在 HTML 里不存在 --- */
  const allHtmlIds = new Set([...html.htmlIds]);
  for (const name of ["login.html", "popup.html"]) {
    const p = path.join(SRC, name);
    if (!exists(p)) continue;
    for (const m of read(p).matchAll(/\sid="([^"]+)"/g)) allHtmlIds.add(m[1]);
  }
  for (const [id, places] of jsIds.refs) {
    if (allHtmlIds.has(id) || jsIds.dynamicIds.has(id)) continue;
    const level = KNOWN_DEAD_ID_ALLOWLIST.has(id) ? "INFO" : "WARN";
    add(
      level,
      "G. 死引用",
      `JS 引用了不存在的元素 id「${id}」`,
      places
        .slice(0, 3)
        .map((p) => `  ${p.file}:${p.line}`)
        .join("\n") + (places.length > 3 ? `\n  …共 ${places.length} 处` : "")
    );
  }

  /* --- H. 懒加载分支对应的 section 是否都还在 --- */
  for (const step of lazySteps) {
    if (!html.sections.has(step)) {
      add("WARN", "H. 懒加载", `biz/ui.js 有 sectionNumber === ${step} 的懒加载分支，但 index.html 里没有 section-${step}`, "");
    }
  }

  /* --- I. 样式守卫：给已收敛的设计系统上锁 ----------------------------
   * 详见文件头部 I 组的说明。规则是"宁可报错也不静默放行"。
   * ------------------------------------------------------------------ */
  const style = parseStyleGuards();

  if (style.fontSizeOffenders.length) {
    const byValue = new Map();
    for (const o of style.fontSizeOffenders) {
      if (!byValue.has(o.value)) byValue.set(o.value, []);
      byValue.get(o.value).push(o);
    }
    add(
      "ERROR",
      "I. 样式守卫",
      `发现 ${style.fontSizeOffenders.length} 处 font-size 不在刻度表内（绕过设计令牌，字号会各写各的）`,
      [...byValue.entries()]
        .map(([v, list]) => `  ${v} ×${list.length}  →  ${list.slice(0, 3).map((o) => `${o.file}:${o.line}`).join(", ")}`)
        .join("\n") +
        "\n可用令牌：--fs-xs/sm/base/lg/xl/2xl/3xl/4xl（文字）、--icon-sm/md/lg/xl/2xl（图标）" +
        "\n确实需要新档位就先在 main.css 的 :root 里加变量，不要就地写死"
    );
  }

  if (style.hexOffenders.length) {
    const byHex = new Map();
    for (const o of style.hexOffenders) {
      if (!byHex.has(o.hex)) byHex.set(o.hex, []);
      byHex.get(o.hex).push(o);
    }
    add(
      "ERROR",
      "I. 样式守卫",
      `发现 ${style.hexOffenders.length} 处新增硬编码颜色（共 ${byHex.size} 种），绕过了 :root 的设计令牌`,
      [...byHex.entries()]
        .map(([h, list]) => `  ${h} ×${list.length}  →  ${list.slice(0, 4).map((o) => `${o.file}:${o.line}`).join(", ")}`)
        .join("\n") +
        "\n优先用语义令牌（--text-primary / --error-color / --accent-* …）；" +
        "\n确有理由（canvas 绘制、纯白）就在 tools/check-ui.mjs 的 HEX_ALLOWLIST 里加一条并写明原因"
    );
  }

  // 白名单内的颜色如果出现次数超标，说明有人靠"多写几处"绕过了收敛
  for (const [hex, limit] of Object.entries(HEX_ALLOWLIST)) {
    const now = style.hexCount.get(hex) || 0;
    if (now > limit) {
      add(
        "WARN",
        "I. 样式守卫",
        `${hex} 出现 ${now} 次，超出白名单基线 ${limit} 次（新增了 ${now - limit} 处）`,
        "白名单只应容纳既有例外；新增的这类用法请改用语义令牌，或连同理由一起抬高基线"
      );
    }
  }

  const notif = parseNotificationTypes();
  if (notif.offenders.length) {
    add(
      "ERROR",
      "I. 样式守卫",
      `发现 ${notif.offenders.length} 处 showNotification 没有显式传 type`,
      notif.offenders
        .slice(0, 6)
        .map((o) => `  ${o.file}:${o.line}  type=${o.type}  ${o.reason}`)
        .join("\n") + (notif.offenders.length > 6 ? `\n  …共 ${notif.offenders.length} 处` : "")
    );
  }

  /* --- J. 页面资源可达性：HTML/manifest 引用的路径必须能在 dist 里落地 --- */
  const plan = parseBuildPlan();
  if (plan) {
    const refs = [...collectHtmlRefs(), ...collectManifestRefs()];
    // 追加：逐字复制到 dist 的 JS（非 webpack 入口，如 background.js）内部的
    // 静态 import 也必须在 dist 里可达 —— 否则 ESM 加载直接失败。
    // （入口 JS 的 import 由 webpack 打包解析，不在此列。）
    for (const c of plan.copies) {
      if (!c.from.endsWith(".js")) continue;
      const abs = path.join(ROOT, c.from);
      if (!exists(abs)) continue;
      const text = read(abs);
      for (const m of text.matchAll(/import\s+[^'";]*?from\s*["']([^"']+)["']/g)) {
        const spec = m[1];
        if (!spec.startsWith(".")) continue; // 裸说明符（包名）不适用复制模型
        const target = rel(path.resolve(path.dirname(abs), spec));
        const line = text.slice(0, m.index).split("\n").length;
        if (!exists(path.join(ROOT, target))) {
          missing.push({ from: rel(abs), line, ref: target, kind: "copy-import", why: `源文件 ${target} 不存在` });
          continue;
        }
        if (plan.entries.has(path.basename(target))) continue;
        const covered = plan.copies.some((cc) => target === cc.from || target.startsWith(cc.from + "/"));
        if (!covered) {
          missing.push({
            from: rel(abs),
            line,
            ref: target,
            kind: "copy-import",
            why: `被复制的 JS import 了它，但它既不是 webpack 入口，也不在 CopyPlugin 复制范围内 → dist/ 里没有`
          });
        }
      }
    }
    // 分级：HTML 引用断了 = 页面真的坏（图标变方框、样式不生效）→ ERROR。
    // web_accessible_resources 里的死条目 Chrome 会静默忽略，只是白占一行 → WARN。
    // content_scripts / background / popup 指错文件是真故障，也算 ERROR。
    const INERT_KINDS = new Set(["web_accessible_resources"]);
    const missing = [];
    for (const r of refs) {
      const clean = String(r.ref).replace(/^\.\//, "");
      if (/^(https?:)?\/\//.test(clean) || clean.startsWith("data:")) continue;
      const abs = path.join(SRC, clean);
      const relPath = rel(abs);
      if (!exists(abs)) {
        missing.push({ ...r, why: `源文件 src/${clean} 不存在` });
        continue;
      }
      if (plan.entries.has(path.basename(relPath))) continue; // webpack 入口，会产出同名 bundle
      const covered = plan.copies.some((c) => relPath === c.from || relPath.startsWith(c.from + "/"));
      if (!covered) {
        missing.push({
          ...r,
          why: `既不是 webpack 入口，也不在 CopyPlugin 的复制范围内 → dist/ 里不会有这个文件`
        });
      }
    }
    for (const level of ["ERROR", "WARN"]) {
      const group = missing.filter((m) => (INERT_KINDS.has(m.kind) ? "WARN" : "ERROR") === level);
      if (!group.length) continue;
      add(
        level,
        "J. 页面资源",
        level === "ERROR"
          ? `有 ${group.length} 个引用在构建产物里不存在（src/ 下能跑，加载 dist/ 时会 404）`
          : `manifest 的 web_accessible_resources 里有 ${group.length} 个死条目（Chrome 会静默忽略，不影响功能）`,
        group
          .map((m) => `  ${m.from}${m.line ? `:${m.line}` : ""} → ${m.ref}  [${m.kind}]\n      ${m.why}`)
          .join("\n") +
          (level === "ERROR"
            ? `\n修法：在 webpack.config.js 的 CopyWebpackPlugin 里补一条 { from: 'src/...', to: '...' }，` +
              `\n或者把它变成 webpack 入口。现有入口：${[...plan.entries].join(", ")}`
            : `\n修法：删掉这些条目，或把路径改成真实位置（如 README.md → docs/README.md）`)
      );
    }
  } else {
    add("WARN", "J. 页面资源", "未找到 webpack.config.js，无法校验引用在 dist 中是否可达", "");
  }

  /* --- K. 日志规范：禁止绕过统一 logger 直接调 console.* --- */
  const logGuard = parseLogGuard();
  if (logGuard.offenders.length) {
    add(
      "ERROR",
      "K. 日志规范",
      `发现 ${logGuard.offenders.length} 处直接调用 console.*（绕过统一 logger，格式会重新发散）`,
      logGuard.offenders
        .slice(0, 6)
        .map((o) => `  ${o.file}:${o.line}`)
        .join("\n") +
        (logGuard.offenders.length > 6 ? `\n  …共 ${logGuard.offenders.length} 处` : "") +
        "\n统一用法：import { createLogger } from \".../common/logger.js\"; const log = createLogger(\"TAG\");" +
        "\n敏感值先过 maskSecret()；级别含义见 logger.js 头部注释"
    );
  }

  /* --- L. 全局依赖：每个"大写开头"的标识符都必须有出处 --- */
  const globalDeps = parseGlobalDependencyGuard();
  if (globalDeps.unknown.size) {
    const list = [...globalDeps.unknown.entries()].sort();
    add(
      "ERROR",
      "L. 全局依赖",
      `发现 ${list.length} 个没有出处的全局标识符（不在 JS 内置里、不是本地/导入绑定、也不是 lib_loader 注入的库）`,
      list
        .map(([name, locs]) => {
          const head = `  ${name}  ×${locs.length}`;
          const detail = locs.slice(0, 3).map((l) => `      ${l.file}:${l.line}  [${l.kind}]`).join("\n");
          return locs.length > 3 ? `${head}\n${detail}\n      …共 ${locs.length} 处` : `${head}\n${detail}`;
        })
        .join("\n") +
        `\n为什么重要：2026-09 的「表格全部渲染失败」「事件订阅不可用」两个 P1 就是这类问题` +
        `\n（\`new Handsontable(...)\`、\`CometD\` 都不存在），A~K 守卫全部抓不到。` +
        `\n修法：import 它、用 lib_loader 按需注入、或删掉这段死代码。` +
        `\n若是新引入的浏览器内置 API，把名字加进 check-ui.mjs 的 JS_BUILTIN_GLOBALS。`
    );
  }
  if (globalDeps.missingEnsure.length) {
    add(
      "ERROR",
      "L. 全局依赖",
      `有 ${globalDeps.missingEnsure.length} 处使用了按需加载的库全局，但文件里没有调用对应的 ensureXxx()`,
      globalDeps.missingEnsure
        .map((x) => `  ${x.file}  用了 ${x.global}，但没调用 ${x.ensure}()`)
        .join("\n") +
        `\n背景：这些库已从 index.html 的同步 <script> 里移除，改为 lib_loader.js 按需注入。` +
        `\n用法必须是 \`await ensureXxx();\` 之后再访问该全局，否则会拿到 undefined。`
    );
  }

  if (globalDeps.missingExports.length) {
    add(
      "ERROR",
      "L. 全局依赖",
      `lib_loader.js 里有 ${globalDeps.missingExports.length} 个库没有对应的 ensureXxx() 导出（守卫无法判断"用之前该调什么"）`,
      globalDeps.missingExports
        .map((x) => `  ${x.libKey} → 全局 ${x.global}，未找到导出函数 ${x.guess}()`)
        .join("\n") +
        `\n修法：在 common/lib_loader.js 里 export 一个 ensureXxx()，并在 GLOBAL_NAME / LIB_PATH 里登记。`
    );
  }

  /* --- M. 产物体积预算 --- */
  const budget = parseSizeBudget();
  const blocking = budget.inlineScripts.reduce((s, x) => s + x.bytes, 0);
  if (blocking > INLINE_SCRIPT_BUDGET_BYTES) {
    add(
      "WARN",
      "M. 体积预算",
      `同步 <script src> 的本地脚本合计 ${kb(blocking)}，超出预算 ${kb(INLINE_SCRIPT_BUDGET_BYTES)}`,
      budget.inlineScripts
        .sort((a, b) => b.bytes - a.bytes)
        .map((x) => `  ${x.page} → ${x.ref}  ${kb(x.bytes)}`)
        .join("\n") +
        `\n这些字节每次打开页面都要先解析完才会执行 app.js（侧边栏每次点击都会重新加载）。` +
        `\n修法：改成 common/lib_loader.js 的按需注入（ensureECharts / ensureXLSX / ensureJSZip）。`
    );
  }
  const totalLib = budget.libs.reduce((s, x) => s + x.bytes, 0);
  const fat = budget.libs.filter((x) => x.bytes > SINGLE_LIB_BUDGET_BYTES);
  if (fat.length || totalLib > TOTAL_LIB_BUDGET_BYTES) {
    add(
      "WARN",
      "M. 体积预算",
      fat.length
        ? `有 ${fat.length} 个第三方文件超过单文件预算 ${mb(SINGLE_LIB_BUDGET_BYTES)}`
        : `第三方库合计 ${mb(totalLib)}，超出总预算 ${mb(TOTAL_LIB_BUDGET_BYTES)}`,
      budget.libs
        .sort((a, b) => b.bytes - a.bytes)
        .map((x) => `  ${x.ref}  ${mb(x.bytes)}`)
        .join("\n") +
        `\n合计 ${mb(totalLib)}；单文件上限 ${mb(SINGLE_LIB_BUDGET_BYTES)}，总上限 ${mb(TOTAL_LIB_BUDGET_BYTES)}。` +
        `\n确实需要更大的库时，请同步调高 check-ui.mjs 里对应的预算常量并说明理由。`
    );
  }

  /* --- N. 仓库卫生 --- */
  const hygiene = parseRepoHygiene();
  if (hygiene.found.length) {
    add(
      "WARN",
      "N. 仓库卫生",
      `发现 ${hygiene.found.length} 个系统垃圾文件（应删除并确认已被 .gitignore 覆盖）`,
      hygiene.found.slice(0, 8).map((p) => `  ${p}`).join("\n") +
        (hygiene.found.length > 8 ? `\n  …共 ${hygiene.found.length} 个` : "") +
        `\n修法：find . -name .DS_Store -not -path "./node_modules/*" -delete`
    );
  }

  /* --- O. <script> 内联有效性 --- */
  const inlineValidity = parseInlineScriptValidity();
  for (const o of inlineValidity.offenders) {
    add(
      "ERROR",
      "O. 内联脚本有效性",
      `${o.from}:${o.line} 的 <script src="${o.src}"> 带了 ${o.bytes} 字节内联代码，` +
        `但带 src 的 script 会整段忽略内联内容 —— 这段代码永远不会执行`,
      `  首行：${o.head}\n` +
        `修法：拆成两个标签：<script src="${o.src}" type="module"></script>` +
        ` 然后再写 <script type="module">…</script>`
    );
  }

  return {
    tiles,
    sections: html.sections,
    findings,
    style,
    notif,
    logGuard,
    globalDeps,
    budget,
    hygiene,
    inlineValidity
  };
}

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */

function main() {
  const { tiles, sections, findings, style, notif, logGuard, globalDeps, budget, hygiene } = run();

  if (JSON_OUT) {
    console.log(
      JSON.stringify(
        {
          tiles: tiles.length,
          sections: sections.size,
          style: {
            fontSizeOffenders: style.fontSizeOffenders.length,
            hexOffenders: style.hexOffenders.length,
            hexDistinct: style.hexCount.size,
            notifyOffenders: notif.offenders.length
          },
          rawConsoleCalls: logGuard.offenders.length,
          globalDependencies: {
            localBindings: globalDeps.localCount,
            unknownGlobals: globalDeps.unknown.size,
            missingEnsure: globalDeps.missingEnsure.length
          },
          sizeBudget: {
            blockingScriptBytes: budget.inlineScripts.reduce((s, x) => s + x.bytes, 0),
            libBytes: budget.libs.reduce((s, x) => s + x.bytes, 0)
          },
          junkFiles: hygiene.found.length,
          findings
        },
        null,
        2
      )
    );
  } else {
    const icon = { ERROR: "✗", WARN: "!", INFO: "i" };
    const errors = findings.filter((f) => f.level === "ERROR");
    const warns = findings.filter((f) => f.level === "WARN");
    const infos = findings.filter((f) => f.level === "INFO");

    console.log("");
    console.log("nForce Tools · UI 一致性自检");
    console.log("=".repeat(62));
    console.log(`  首页磁贴 ${tiles.length} 个 · 详情页 section ${sections.size} 个 · 图标映射 ${parseMappedIcons()?.size ?? 0} 个`);
    console.log(
      `  样式守卫：font-size 越界 ${style.fontSizeOffenders.length} 处 · ` +
        `硬编码色 ${style.hexOffenders.length} 处（残留 ${style.hexCount.size} 种）· ` +
        `通知缺 type ${notif.offenders.length} 处`
    );
    console.log(`  日志守卫：裸 console.* ${logGuard.offenders.length} 处`);
    console.log(
      `  全局依赖：无出处的大写全局 ${globalDeps.unknown.size} 个 · ` +
        `缺 ensureXxx 调用 ${globalDeps.missingEnsure.length} 处（已收集本地绑定 ${globalDeps.localCount} 个）`
    );
    console.log(
      `  体积预算：同步脚本 ${kb(budget.inlineScripts.reduce((s, x) => s + x.bytes, 0))} · ` +
        `第三方库合计 ${mb(budget.libs.reduce((s, x) => s + x.bytes, 0))} · 垃圾文件 ${hygiene.found.length} 个`
    );
    console.log("-".repeat(62));

    if (!findings.length) {
      console.log("  ✓ 未发现不一致");
    }
    for (const f of [...errors, ...warns, ...infos]) {
      console.log(`  ${icon[f.level]} [${f.check}] ${f.message}`);
      if (f.detail) console.log(f.detail.split("\n").map((l) => `      ${l.trim()}`).join("\n"));
    }

    console.log("-".repeat(62));
    console.log(`  ERROR ${errors.length} · WARN ${warns.length} · INFO ${infos.length}`);
    console.log("=".repeat(62));
    console.log("");
  }

  process.exit(findings.some((f) => f.level === "ERROR") ? 1 : 0);
}

main();
