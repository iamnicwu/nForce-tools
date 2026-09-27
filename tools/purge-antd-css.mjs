#!/usr/bin/env node
/**
 * antd.min.css 按类名裁剪（PurgeCSS 等价实现，无额外依赖）
 *
 * ── 为什么需要它 ──
 * src/lib/css/antd.full.css 是完整的 Ant Design 样式表：545KB / 5300+ 条规则。
 * 本项目只用到其中 40 多个 ant-* 类名（另有 ant-alert-${type} / anticon-${type}
 * 两处动态拼接），也就是说 95% 的规则是死重量 —— 而侧边栏每点一次工具栏图标
 * 都要重新解析它。
 *
 * ── 文件约定 ──
 *   src/lib/css/antd.full.css   vendored 原始文件，**唯一的源头**，不进 dist
 *   src/lib/css/antd.min.css    本脚本生成的裁剪版，由 index.html / popup.html 加载
 *   webpack.config.js 的 CopyPlugin 已配置忽略 antd.full.css
 *
 * ── 用法 ──
 *   node tools/purge-antd-css.mjs            # 由 full 重新生成 min
 *   node tools/purge-antd-css.mjs --check    # 只检查 min 是否已是最小（CI 用）
 *   node tools/purge-antd-css.mjs --dry      # 只报告，不写文件
 *
 * ── 重要 ──
 * 新增 UI 如果用到新的 ant-* 类名，必须把类名补进下面的 SAFELIST 再重新生成。
 * 忘了这一步的表现是「组件样式突然没了」。tools/check-ui.mjs 的 M 组会比对
 * 「源码用到的 ant-* 类名」与「SAFELIST」，漏项直接报 ERROR。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import selectorParser from "postcss-selector-parser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const FULL_PATH = path.join(ROOT, "src/lib/css/antd.full.css");
const MIN_PATH = path.join(ROOT, "src/lib/css/antd.min.css");
const SRC_DIR = path.join(ROOT, "src");

/**
 * 允许保留的 ant-* / anticon 类名白名单。
 * 来源：全量扫描 src/**（排除 src/lib）得到的静态类名，加上动态拼接的族。
 *
 * 注意：这里只需要列**源码里会真的出现在 DOM 上的类**。
 * 我们的页面不使用 antd 的 JS（没有 React），所有 ant-* 类都是手写在
 * HTML/JS 里的，所以「选择器里出现白名单之外的 ant-* 类」= 永不匹配，可以安全删掉。
 * 例：.ant-upload.ant-upload-drag 会被删 —— 因为我们的标记里只有
 * `class="file-upload ant-upload-drag"`，没有 .ant-upload 父级，
 * 这条规则本来就没生效过（样式来自 main.css 的 .file-upload）。
 */
export const SAFELIST = new Set([
  // alert（ant-alert-${type} 动态拼接，四种 type 全留）
  "ant-alert",
  "ant-alert-close-icon",
  "ant-alert-content",
  "ant-alert-description",
  "ant-alert-icon",
  "ant-alert-message",
  "ant-alert-with-description",
  "ant-alert-success",
  "ant-alert-error",
  "ant-alert-warning",
  "ant-alert-info",
  // button
  "ant-btn",
  "ant-btn-dangerous",
  "ant-btn-default",
  "ant-btn-disabled",
  "ant-btn-lg",
  "ant-btn-primary",
  "ant-btn-sm",
  // card
  "ant-card",
  "ant-card-body",
  "ant-card-bordered",
  "ant-card-extra",
  "ant-card-head",
  "ant-card-head-title",
  "ant-card-head-wrapper",
  // checkbox
  "ant-checkbox-wrapper",
  // divider
  "ant-divider",
  "ant-divider-horizontal",
  "ant-divider-inner-text",
  "ant-divider-with-text",
  // input
  "ant-input",
  // table（标记里只有这三个类，antd 的 .ant-table-container 结构我们没有，
  // 所以表格边框/内边距由 main.css 的 .ant-table-* 规则负责）
  "ant-table",
  "ant-table-bordered",
  "ant-table-default",
  "ant-table-tbody",
  "ant-table-thead",
  // tag
  "ant-tag",
  "ant-tag-blue",
  "ant-tag-error",
  "ant-tag-orange",
  "ant-tag-success",
  "ant-tag-warning",
  // upload（同样只有标记里的这几个类真实存在）
  "ant-upload-drag",
  "ant-upload-drag-container",
  "ant-upload-drag-icon",
  "ant-upload-hint",
  "ant-upload-text",
  // 图标容器：anticon anticon-${type}（type ∈ success/error/info/warning），
  // 其中只有 .anticon / .anticon-close 在 antd CSS 里真的有规则
  "anticon",
  "anticon-close",
  "anticon-success",
  "anticon-error",
  "anticon-info",
  "anticon-warning",
]);

/** 收集源码里出现的 ant-* / anticon 类名（用于校验白名单是否漏项） */
export function collectUsedAntClasses(dir = SRC_DIR) {
  const used = new Set();
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "lib" && path.resolve(d) === path.resolve(SRC_DIR)) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(js|html)$/.test(entry.name)) {
        const txt = fs.readFileSync(full, "utf8");
        for (const m of txt.matchAll(/\bant-[a-z0-9]+(?:-[a-z0-9]+)*\b/g)) {
          used.add(m[0]);
        }
        for (const m of txt.matchAll(/\banticon(?:-[a-z0-9]+)*\b/g)) {
          used.add(m[0]);
        }
      }
    }
  };
  walk(dir);
  return used;
}

/**
 * 逐选择器过滤一条规则的 selector
 *
 * 为什么不是「整条规则保留/丢弃」：antd 里有 979 条组合选择器，例如
 *   .ant-btn,.ant-btn:active,.ant-btn:focus { ... }
 * 如果因为 `.ant-btn-link`（未使用）出现在同一条规则里就整条丢弃，
 * 会把 `.ant-btn` 的基础声明一起删掉 → 按钮样式直接崩。
 * 因此按**单个选择器**粒度过滤，保留下来的重新拼回逗号列表（与 PurgeCSS 行为一致）。
 *
 * @param {string} selector
 * @returns {string} 过滤后的选择器；空串表示整条规则可丢弃
 */
function filterSelector(selector) {
  const processor = selectorParser((selectors) => {
    selectors.each((sel) => {
      let sawAntClass = false;
      let ok = true;
      sel.walkClasses((node) => {
        const value = node.value;
        if (!value.startsWith("ant-") && !value.startsWith("anticon")) return;
        sawAntClass = true;
        if (!SAFELIST.has(value)) ok = false;
      });
      // 不含任何 ant-* / anticon 类的选择器，说明它只服务于被裁掉的组件，
      // 一并丢弃（antd 对 html/body 的 reset 由 main.css 自己负责）。
      if (!sawAntClass || !ok) sel.remove();
    });
  });
  return processor.processSync(selector).trim();
}

/**
 * 对一棵 CSS AST 做裁剪，返回统计信息
 * @param {import('postcss').Root} root
 * @returns {{kept: number, dropped: number}}
 */
function prune(root) {
  let kept = 0;
  let dropped = 0;
  root.walkRules((rule) => {
    // @keyframes 内部的步骤规则（0% / from / to）不是选择器，永远保留
    if (rule.parent && rule.parent.type === "atrule" && /keyframes/i.test(rule.parent.name)) {
      return;
    }
    const filtered = filterSelector(rule.selector);
    if (filtered) {
      rule.selector = filtered;
      kept++;
    } else {
      rule.remove();
      dropped++;
    }
  });
  return { kept, dropped };
}

/** 报告源码里用到、但不在白名单里的类名（它们会被裁掉） */
function reportSafelistGaps() {
  const used = collectUsedAntClasses();
  // 只关心 antd 命名空间下的类；anticon-success 这类 antd 里根本不存在，
  // 但也一并列出，避免误以为"用了就该有样式"
  const missing = [...used].filter((c) => !SAFELIST.has(c)).sort();
  if (missing.length) {
    console.log(`\n⚠ 源码用到了白名单外的类名，它们会被裁掉，请补进 SAFELIST：`);
    missing.forEach((c) => console.log(`    ${c}`));
  } else {
    console.log(`  白名单覆盖：✓ 源码用到的 ${used.size} 个类名全部在白名单内`);
  }
  return missing;
}

const BANNER =
  "/*! antd.min.css —— 由 tools/purge-antd-css.mjs 从 antd.full.css 生成，请勿手工编辑。\n" +
  " *  新增 ant-* 类名必须同步该脚本的 SAFELIST 并重新生成，否则会被裁掉。\n" +
  " */\n";

function main() {
  const mode = process.argv.includes("--check")
    ? "check"
    : process.argv.includes("--dry")
      ? "dry"
      : "write";

  if (!fs.existsSync(FULL_PATH)) {
    console.error(`✗ 找不到源头文件 ${path.relative(ROOT, FULL_PATH)}`);
    process.exit(1);
  }

  if (mode === "check") {
    // 检查模式：不对 full 做裁剪，而是验证当前 min 是否已经是最小形态
    if (!fs.existsSync(MIN_PATH)) {
      console.error(`✗ 缺少 ${path.relative(ROOT, MIN_PATH)}，请先运行 node tools/purge-antd-css.mjs`);
      process.exit(1);
    }
    const root = postcss.parse(fs.readFileSync(MIN_PATH, "utf8"));
    const { dropped } = prune(root);
    const missing = reportSafelistGaps();
    if (dropped > 0 || missing.length > 0) {
      if (dropped > 0) {
        console.error(
          `✗ antd.min.css 仍有 ${dropped} 条可裁剪的规则 —— 可能是被还原成了完整版，` +
          `或新增类名后忘了重新生成。请运行：node tools/purge-antd-css.mjs`
        );
      }
      process.exit(1);
    }
    console.log("✓ antd.min.css 已是最小形态，白名单覆盖完整");
    return;
  }

  const before = fs.statSync(FULL_PATH).size;
  const root = postcss.parse(fs.readFileSync(FULL_PATH, "utf8"));
  const { kept, dropped } = prune(root);
  const out = root.toString();
  const after = Buffer.byteLength(BANNER + out, "utf8");
  const savedPct = (((before - after) / before) * 100).toFixed(1);

  console.log("antd.min.css 裁剪");
  console.log(`  规则：保留 ${kept} 条，删除 ${dropped} 条`);
  console.log(`  体积：${(before / 1024).toFixed(0)}KB → ${(after / 1024).toFixed(0)}KB（省 ${savedPct}%）`);
  reportSafelistGaps();

  if (mode === "dry") return;

  fs.writeFileSync(MIN_PATH, BANNER + out, "utf8");
  console.log(`  ✓ 已写入 ${path.relative(ROOT, MIN_PATH)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
