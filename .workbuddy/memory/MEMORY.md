# nForce-tools 项目长期笔记

## UI 架构（v3.3，2026-09-20 起）
- 布局：App 图标式首页（#launcher-view）+ 详情页（#detail-view，一次一个 section）。首页磁贴由 `src/rules/ui_layout.json` 驱动（JS 渲染，见 `biz/ui_layout.js`），用户明确偏好此模式，不要恢复 sidebar / 横向 tab / 长单页
- 首页顶部有「常用功能」栏：auto 模式按使用频率（chrome.storage `ui_tile_usage`）自动置顶，fixed 模式按配置；可在首页「布局配置」面板里编辑 JSON（存 `ui_layout`）或直接改 `rules/ui_layout.json`（fetch 加载，改完刷新即生效，无需重新打包）
- 导航：磁贴点击为 document 事件委托（ui_layout.js），`showSection(n)` = 视图切换 + 懒加载（5 LTS Summary / 6 README / 19 Schedule Jobs）；`goHome()` 返回并派发 `nforce:home` 事件刷新常用排序；Esc 也可返回
- 图标体系：无 FontAwesome 字体，全部经 `src/common/icons.js` 的 IconMap 替换为内联 SVG。**新增 UI 用新 fa-* 图标时必须同步在 icons.js 里补 SVG 和映射**；JS 动态渲染的 DOM 要在渲染后手动调 `replaceIcons()`；替换后 `<i>` 的自定义类会丢（用 `.tile > svg:last-child` 这类结构选择器）
- 未连接锁定：section `.needs-connection`（半透明 + 头部「需连接」徽标）、tile `.locked`；连接成功后 `refreshSectionLocks()` 统一解锁
- section-0（index.html 多 Session 选择）是死代码，多环境选择在 login.html

## 构建 / 验证
- 构建：`node node_modules/webpack/bin/webpack.js --mode production`（node_modules/.bin shim 无执行权限，npm run build 会 Permission denied）
- 已知问题：jest 4 套件全挂（ESM 源码被 CJS require，历史遗留，与 UI 无关）

## 硬性约束（踩过坑，务必遵守）
- **禁止 `import xxx from "*.json"`**：浏览器/扩展不支持 JSON 模块导入，会让整个 app.js 加载失败（表现为首页空白 + 徽标停在「未连接」）。默认数据用 JS 模块（如 `biz/ui_layout_default.js`），运行时用 `fetch(chrome.runtime.getURL(...))` 读 JSON
- **`src/index.html` 的 `<script src="./app.js">` 必须保留 `type="module"`**：src/app.js 是原生 ESM（去掉报 Cannot use import statement outside a module），dist/app.js 是 IIFE（用 module 加载也正常）
- **`src/` 本身就是一个可直接「加载已解压的扩展程序」的目录**（含 manifest.json/index.html/app.js/rules/lib/icons）。因此源码改动必须保证不打包也能跑，用户可能直接从 src/ 加载或预览
- **静态预览必须显式设置 MIME**：本机 python 的 mimetypes 未初始化，`.js` 会被当成 text/plain，Chrome 的 module 严格 MIME 检查会拒载。用自定义 handler 映射 .js→text/javascript、.json→application/json
- **启动时不要因会话校验失败就降级连接状态**：校验请求会被 CSP/网络拦截，误判会重现「找到 session 进主页却显示未连接」。只有 401/403 或 INVALID_SESSION_ID 才算真失效（见 `sfConn.lastError`）
- `content_security_policy.extension_pages` 的 connect-src 必须覆盖全部 host_permissions 域名，否则对应 org 的请求会被静默拦截

## 验证工具（/tmp/nforce-verify，可重建）
- `serve.py`（正确 MIME 的静态服务，端口 8765）+ `prepare.py`（复制 dist/ 与 src/ 两个副本并注入 chrome.* shim，`?scenario=connected|fresh|unconnected` 预置 storage）+ `run-checks.sh`（Chrome `--headless=new --no-sandbox --dump-dom`，抓 `#__preview_report__` 的 data-* 断言）
- 服务须用 run_in_background 保持常驻；Chrome 必须加 `--no-sandbox`，且不要用 `timeout`（macOS 无此命令）

