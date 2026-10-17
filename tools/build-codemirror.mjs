/**
 * 把 CodeMirror 6 打成一个**单文件 ESM**，vendor 进 `src/lib/js/`。
 *
 * 为什么要预打包而不是直接从 node_modules 导入：
 *   `src/` 本身就是"可直接加载的扩展目录"（见 MEMORY「src 不打包也要能跑」），
 *   浏览器里解析不了裸模块名（`import "@codemirror/view"`）。所以像 echarts / xlsx 一样
 *   把产物提交进仓库，运行时按需 `import(chrome.runtime.getURL("lib/js/..."))`。
 *
 * 重新生成（改了版本号或要加扩展时）：
 *   node tools/build-codemirror.mjs
 * 产物：src/lib/js/codemirror.bundle.js（minified，约 0.4MB）
 */
import { build } from "esbuild";
import { readFileSync, writeFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src/lib/js/codemirror.bundle.js");
const pkgVersion = (name) => {
  const p = join(ROOT, "node_modules", name, "package.json");
  return JSON.parse(readFileSync(p, "utf8")).version;
};

/**
 * 出口清单：**只导出我们真正用到的 API**，让 tree-shaking 把没用的删干净。
 * 这里的每一项都在 `biz/soql_editor.js` 里用到；加功能时先改这里再重新打包。
 */
const ENTRY = `
export { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
         drawSelection, dropCursor, rectangularSelection, crosshairCursor, highlightSpecialChars,
         placeholder } from "@codemirror/view";
export { EditorState, Compartment } from "@codemirror/state";
export { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
export { bracketMatching, indentOnInput, syntaxHighlighting, HighlightStyle, foldGutter, foldKeymap,
         StreamLanguage } from "@codemirror/language";
export { tags } from "@lezer/highlight";
export { sql, SQLDialect } from "@codemirror/lang-sql";
export { autocompletion, completionKeymap, startCompletion, closeCompletion } from "@codemirror/autocomplete";
export { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
`;

const banner = `/**
 * CodeMirror 6 —— 打包产物，**不要手改**。
 *
 * 源码版本：codemirror ${pkgVersion("codemirror")} · @codemirror/lang-sql ${pkgVersion("@codemirror/lang-sql")}
 * 生成命令：node tools/build-codemirror.mjs
 * 用法：common/lib_loader.js 的 ensureCodeMirror() 按需 import 这个文件
 */`;

const result = await build({
  stdin: { contents: ENTRY, resolveDir: ROOT, sourcefile: "codemirror-entry.js", loader: "js" },
  bundle: true,
  format: "esm",
  minify: true,
  target: ["chrome110"],
  legalComments: "none",
  banner: { js: banner },
  outfile: OUT,
  metafile: true,
  logLevel: "warning"
});

const bytes = statSync(OUT).size;
// 产物大小进不了 src（那里只放运行时文件），打出来看就行；超预算会被 check:ui 的 M 组拦住
const biggest = Object.entries(result.metafile.inputs)
  .filter(([p]) => !p.startsWith("codemirror-entry"))
  .sort((a, b) => b[1].bytesInOutput - a[1].bytesInOutput)
  .slice(0, 5)
  .map(([p, v]) => `    ${(v.bytesInOutput / 1024).toFixed(1).padStart(6)} KB  ${p.replace(/^node_modules\//, "")}`);
console.log(`✓ ${OUT}`);
console.log(`  合计 ${(bytes / 1024).toFixed(1)} KB；占用最多的来源：\n${biggest.join("\n")}`);
