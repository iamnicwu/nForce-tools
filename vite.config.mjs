/**
 * Vite 构建配置 —— nForce Tools（Chrome MV3 扩展）
 *
 * 取代了原先的 webpack.config.js。迁移时保持的**行为等价**（这是硬要求，
 * 因为 `src/` 本身就是可直接加载的扩展目录，产物布局不能变）：
 *
 *   入口打包    app.js / login_app.js        → dist/{app,login_app}.js（文件名固定）
 *   逐字复制    HTML / manifest / SW / 内容脚本 / 页面外壳 / 静态资源 / 第三方库
 *   动态 import cometd 等 → 独立懒加载 chunk（不写进 HTML，运行时按需请求）
 *
 * 三处必须记住的**扩展特有约束**（踩过坑，别按普通 web 项目来改）：
 *
 * 1. `base` 必须是 `'./'`。默认的 `'/'` 会让动态 import 的 chunk 解析到
 *    `chrome-extension://<id>/chunk-xxx.js` 这种扩展根路径 —— 在标签页/侧边栏里
 *    也许看着没事，但贴边浮窗（内容脚本注入的 iframe，路径带目录）下就会 404。
 *
 * 2. `entryFileNames` 不能带 hash。index.html / login.html / popup.html 都是
 *    **手写并逐字复制**的 HTML（没有 html 插件来改写引用），里面写死
 *    `./app.js`、`login_app.js`、`popup_app.js`。文件名一变，页面只剩空壳，
 *    而且**控制台一个报错都没有**（脚本压根没请求到）。check-ui 的 J2 守这条。
 *
 * 3. 不许有依赖「HTML 由打包器注入」的选项。`public/` 目录不存在，
 *    `modulePreload` 关掉 —— 它的作用就是往 HTML 里插 `<link rel=modulepreload>`，
 *    而这里的 HTML 不经过打包器处理，注入无处可去；顺带也省掉动态 import 的
 *    polyfill（扩展只跑在新版 Chrome 上，纯负担）。
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

import { COPY_RULES, ENTRIES, isExcluded } from "./tools/build-plan.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * 递归复制目录，按规则跳过排除项。
 * 复制就是复制：不做压缩、不做改写、不注入 sourcemap —— 这些文件在 `src/` 下
 * 是什么样，在 `dist/` 下就是什么样（曾经 webpack 会把"复制来的"文件顺手压一遍，
 * 于是 `src/` 与 `dist/` 两份产物逐字节不一致，排查时非常误导）。
 * @param {string} srcDir
 * @param {string} destDir
 * @param {{exclude?: string[], excludeBasenames?: string[]}} rule
 * @returns {number} 实际复制出去的文件数（已扣掉 exclude）
 */
function copyDirRecursive(srcDir, destDir, rule) {
  let copied = 0;
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const from = path.join(srcDir, entry.name);
    const relPosix = path.relative(srcDir, from).split(path.sep).join("/");
    if (isExcluded(relPosix, rule)) continue;

    const to = path.join(destDir, entry.name);
    if (entry.isDirectory()) {
      copied += copyDirRecursive(from, to, rule);
      continue;
    }
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(from, to);
    copied += 1;
  }
  return copied;
}

/** 把「src 就是扩展目录」这件事搬进 dist：逐字复制 build-plan 里列出的文件 */
function copyExtensionAssets() {
  return {
    name: "nforce:copy-extension-assets",
    apply: "build",
    // closeBundle = 打包产物已经落盘、且 Vite 自己的收尾（含 emptyOutDir）都完成。
    // 挂在这个时点可以确保「清空 dist」不会把我们复制的文件顺手删掉。
    closeBundle() {
      const outDir = path.resolve(ROOT, "dist");
      let copied = 0;

      for (const rule of COPY_RULES) {
        const src = path.resolve(ROOT, rule.from);
        if (!fs.existsSync(src)) {
          throw new Error(
            `[vite] 复制规则指向的文件/目录不存在：${rule.from}（清单见 tools/build-plan.mjs）`
          );
        }

        const dest = path.resolve(outDir, rule.to);
        if (fs.statSync(src).isDirectory()) {
          copied += copyDirRecursive(src, dest, rule);
        } else {
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          fs.copyFileSync(src, dest);
          copied += 1;
        }
      }

      // 复制型文件是"原样搬运"，这里主动说一句，免得有人以为它们也过了打包器。
      // 数字是**实际落盘数**（已扣掉 exclude），不是清单里的源文件数。
      this.info(`已逐字复制 ${copied} 个扩展文件（含 HTML / manifest / SW / 静态资源）`);
    },
  };
}

export default defineConfig(({ mode }) => ({
  root: ROOT,
  // 见文件头第 1 条：扩展页面必须用相对路径
  base: "./",

  build: {
    outDir: "dist",
    // 每次构建先清空 dist —— 残留的旧 chunk 会被 manifest / HTML 之外的地方引用到，
    // 是「改了代码却跑旧逻辑」的常见来源
    emptyOutDir: true,
    // 只跑在 Chrome（当前最低 Chrome 110+ 级）里，不需要给老浏览器降级。
    // 顺带避免 Vite 往产物里塞任何 polyfill。
    target: "esnext",
    // 生产构建压缩，开发构建保留可读（npm run build:dev）
    minify: mode === "production",
    sourcemap: mode !== "production",
    // 见文件头第 3 条
    modulePreload: false,
    // 项目里没有任何 `import "xxx.css"`（CSS 由 HTML 的 <link> 直接加载，
    // 且 CSS 文件是逐字复制的）——关掉分包，别凭空产出 assets/ 目录
    cssCodeSplit: false,
    rolldownOptions: {
      input: Object.fromEntries(
        Object.entries(ENTRIES).map(([name, file]) => [name, path.resolve(ROOT, file)])
      ),
      output: {
        // 见文件头第 2 条：入口名固定，不能带 hash
        entryFileNames: "[name].js",
        // 懒加载 chunk 可以带 hash：它们由打包器生成的 import() 引用，不写死在 HTML 里。
        // `[name]` 取自模块文件名 —— 所以 `lib/js/apex-log-parser.js` 的产物叫
        // `chunk-apex-log-parser-xxxx.js`，出问题时一眼能认出是谁（别改名成看不懂的东西）。
        chunkFileNames: "chunk-[name]-[hash].js",
        // 当前没有需要打包的静态资源；保留这条只是为了将来加图片时不至于落到 dist 根目录
        assetFileNames: "assets/[name]-[hash][extname]",
      },
    },
  },

  plugins: [copyExtensionAssets()],
}));
