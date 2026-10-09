/**
 * Babel 配置 —— **只服务于 `npm test`**。
 *
 * 为什么需要它：`src/` 全部是原生 ES Module，而 Jest（29.x）默认在 CJS 里跑测试，
 * `require("../src/biz/state.js")` 撞上源码里的 `import` 就是
 * "Cannot use import statement outside a module"，4 个套件、109 个用例全红。
 *
 * 这里只挂**一个**插件，把 ESM 语法转成 CJS。刻意不用 preset-env：
 * 不做语法降级，测试跑的就是源码本身（Node 22 完全支持我们用的语法），
 * 转换面越小，测试与线上行为的偏差越小。
 *
 * 构建（vite）不经过 Babel —— vite.config.mjs 里没有 babel 插件，
 * 而 `src/` 本身就是浏览器可直跑的原生 ESM，打包器只做打包与压缩。
 * 所以这个文件对 dist/ 产物没有任何影响。
 *
 * 备选方案（没用）：给 package.json 加 `"type": "module"` 能让 Jest 原生支持 ESM，
 * 但会同时把 jest.config.js / babel.config.js 变成 ESM，得连带改名成 .cjs，
 * 牵连构建脚本与文档，收益不抵改动面。（vite 的配置文件已用 `.mjs` 后缀单独特判，
 * 绕开这条约束，见 vite.config.mjs。）
 */
module.exports = {
  plugins: ["@babel/plugin-transform-modules-commonjs"],
};
