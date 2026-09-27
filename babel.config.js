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
 * 构建（webpack）不经过 Babel —— webpack.config.js 里没有 babel-loader，
 * 所以这个文件对 dist/ 产物没有任何影响。
 *
 * 备选方案（没用）：给 package.json 加 `"type": "module"` 能让 Jest 原生支持 ESM，
 * 但会同时把 webpack.config.js / jest.config.js 变成 ESM，得连带改名成 .cjs，
 * 牵连构建脚本与文档，收益不抵改动面。
 */
module.exports = {
  plugins: ["@babel/plugin-transform-modules-commonjs"],
};
