# nForce-tools 架构审计：冗余与优化机会

> 审计时间：2026-10-15
> 触发：用户要求「默认 API 版本改 67.0 + 检查插件架构，看是否有冗余或优化的地方」
> 方法：源码静态统计（68 个文件 / 28,747 行）＋ 构建产物分析 ＋ **真机实验**（Chrome 155，
> `--enable-unsafe-extension-debugging`）＋ 现有验证套件（check-ui / jest / panel-shot / ext-verify / overlay-verify / page-boot-verify）
>
> 一句话结论：**没有发现结构性腐坏**（无孤儿模块、无重复工具函数泛滥、无"引用了不存在的库"），
> 但有 4 处**确定的冗余**已当场修掉（首屏 -38KB、包内 -5 个文件、-34 行死/重复代码），
> 另有 3 项**值得做但需要你拍板**的改动，其中最划算的是**去掉 `tabs` 权限**（安装提示少一条"读取浏览历史"）
> —— 我已用真机实验证明本插件不需要它，但有一条无法自动验证的边界，见 §2.1。

---

## 0. 已实施（4 项，全部通过完整验证）

| # | 改动 | 证据 / 收益 | 风险 |
|---|---|---|---|
| 1 | **`marked` 改为按需加载**（原本被 `app.js` 静态 import） | 主包 **292,481 → 254,326 字节（-38KB / -13%）**；新增 `chunk-marked.min-*.js` 38KB 只在真要渲染文档时取 | 低（有降级解析器兜底） |
| 2 | **删掉 `command_palette.js` 里那份死掉的 `fieldsOf`** | -14 行。它与 `cmdk_view.js` 导出的同名函数**逐字相同**，且**没有任何调用点**（重构后遗留）——留着就是"两份权重表将来会分叉"的隐患 | 无 |
| 3 | **`requireXLSX` 两份合并到 `lib_loader.js`** | -20 行。`excel_utils.js` 与 `inspector_tools.js` 里那两份**逐字相同**（只有 logger 的 TAG 不同） | 无（日志 TAG 统一成 `[LIB]`） |
| 4 | **dist 瘦身**：排除开发期文件 + 删死资源 | 复制文件 **38 → 33**：`icons/logo_generator.html`(7.7KB 图标生成器)、`icons/README.md`、`rules/lunch_places_sample.json`、`rules/rules_sample.json`（全仓无任何代码读它们）、`icons/excel-16.png`（无人引用，已从 src 删除） | 无（`build-plan.mjs` 的 exclude 机制是既有约定） |

### 顺带补齐的两条守卫

- **`test/sw_module_graph.test.js`**（第五轮就加了）：`background.js` 是逐字复制、不经打包器，
  顶层写错时 Chrome **不报错、只是不注册 SW**。这条单测用"万能桩"把整条模块图 require 一遍。
- **marked 懒加载的守卫**（本轮加）：`panel-shot` 新增
  `readme-panel-400`（打开「版本信息」→ 断言 marked 的 chunk **真的被请求到**、README 渲染出表格）
  与 `home-tab-1280` 的 `markedChunk: "false"`（首页**不许**请求它）。守的是
  "懒加载没接上 → 文档区静默退化成简易解析器"这类截图上几乎看不出来的失败。

---

## 1. 确认**没有**问题的（免得下次重复排查）

| 检查项 | 结果 |
|---|---|
| 孤儿模块（没有任何 import 的源文件） | **0 个**（初版扫描报 2 个，是我正则漏了单引号的动态 import，修正后归零） |
| 同名函数重复定义 | 13 组，其中**只有 2 组是真重复**（已修，见 §0.2/§0.3）；其余是**有意为之**：`isEntryLocked` 是 `ui_layout` 对 `command_index` 的薄包装；`moveActive/setActive/onKeydown` 是网页浮层（复制型经典脚本、不能 import）**必须**自带一份；`normalizeKey` 是两件不同的事撞名 |
| `escapeHtml` 是否有第二份实现 | **只有一份**（`common/utils.js`），47 处调用全部走它 |
| `app.js` 的巨型 `bindEvents()` 风险 | **已治理**：19 处事件绑定全走 `common/dom.js` 的 `on()`（id 不存在只警告不抛），**零处** `getElementById(x).addEventListener` / `getElementById(x).<prop>` |
| 第三方库是否有"引了没用"的 | echarts / xlsx / jszip / dayjs / marked **全都在用**（`marked` 之前是"用得很贵"，见 §0.1） |
| 权限面 | `content_scripts` / `web_accessible_resources` 已于 4.6.0 移除；`scripting` 只服务于搜索浮层的 `activeTab` 注入 |

---

## 2. 建议但**未实施**（按"性价比"排序，都需要你拍板）

### 2.1 【最划算】去掉 `tabs` 权限 —— 安装提示少一条"读取您的浏览历史记录"

**现状**：`manifest.permissions` 里有 `tabs`。它是安装提示里最吓人的一条文案来源。

**真机实验结果**（本机 Chrome 155；从 dist 复制一份临时扩展、**把 `tabs` 从 permissions 删掉**后加载）：

| 实验 | 结果 |
|---|---|
| `tabs.query({ url: ["https://*.salesforce.com/*", …] })` | ✅ **返回了 url 与 title**（host_permissions 覆盖了匹配的标签页） |
| `tabs.query({ active: true, lastFocusedWindow: true })` | ✅ 当前标签页是 Salesforce 页时 url 可见 |
| `tabs.getCurrent` / `tabs.create` / `tabs.update` | ✅ 全部照旧（这些从来不需要 `tabs` 权限） |

**结论**：本插件对 `tabs` 的三处使用（`login_app.js:146`、`session_recovery.js:187`、
`background.js:652`）中，前两处**完全靠 host_permissions 就够了**。

**唯一风险点（必须人工验一次）**：`background.js:652` 是"按 `Alt+Shift+S` 时找当前标签页来注入浮层"，
它读 `tab.url` 并有一句 `if (!tab.url) return false`。当用户在**非 Salesforce 页面**上按快捷键时，
url 是否可见取决于 **activeTab 是否被授予** —— 而"按下 commands 快捷键授予 activeTab"这一环
**CDP 派发不了浏览器级快捷键，无法自动验证**（这也是 `overlay-verify.mjs` 文件头写明的唯一盲区）。

**建议的验证方式**：临时去掉 `tabs`，在 `https://example.com` 上人工按一次 `Alt+Shift+S`：
浮层出现 = 可以永久去掉；没出现（回退成侧边栏）= 把 `tabs` 加回来。
**顺手可做的加固**：把 `if (!tab.url) return false` 改成"url 读不到时也尝试注入"（注入失败自然回退），
那样即使 activeTab 没授予也不丢功能 —— 但会多一次无用的注入尝试，取舍在你。

### 2.2 三个 2000+ 行的巨型模块（占全部代码的 26%）**【logic.js 已于 2026-10-15 拆掉 ✅】**

| 文件 | 行数 | 内容 |
|---|---|---|
| `app.js` | 2,261 | 入口 + 巨型 `bindEvents()` + 一堆功能分支 |
| `biz/logic.js` | 2,238 | SOQL / Bulk / 数据分析 / 定时任务 / 导入导出 |
| `biz/ui.js` | 2,231 | 29 个 section 的渲染 + 首页 + 图表 + Markdown |
| `index.html` | 1,980（121KB） | **29 个功能区块全在这一个手写 HTML 里** |

**拆分的真正障碍不是技术，而是项目的一条硬约束**：「`src/` 本身就是可直接加载的扩展目录，
不打包也要能跑」（见 `MEMORY.md`）。任何"把 HTML 拆成片段"的方案要么引入构建期 include（破坏约束），
要么改成运行时 fetch + 注入（可行、但比现在多一次请求与一次 DOM 注入）。

**建议的切法（按收益排序，都不必一次做完）**：
1. `logic.js` 按功能域拆成 `biz/soql.js` / `biz/bulk.js` / `biz/analysis.js` / `biz/schedule.js`
   —— 它已经没有 DOM 之外的耦合，是最安全的一刀（**不建议动 `ui.js`**：它和 sections 的 DOM 结构绑得很紧）。
2. `app.js` 的 `bindEvents()` 按 section 拆成 `biz/bind_*.js`，`app.js` 只留编排。
3. `index.html` 的拆分建议**先不做** —— 它是"src 可直接加载"的代价，且每次改动都有 panel-shot 的
   32 个场景兜着；拆了反而让"HTML 与 JS 的 id 对齐"这件事更难查。

### 2.3 三条 `INEFFECTIVE_DYNAMIC_IMPORT` 警告：名不副实，但**不是 bug**

构建时稳定出现三条警告（`ui.js` ⇄ `org_limits.js` / `logic.js` 的 `import()`）。看起来像懒加载，
实际上**打不开 chunk** —— 因为这几个模块同时被 `app.js` 静态 import。它们真正的用途是
**"进入某个 section 时才去拉数据"**（`loadBulkJobsOnce()` / `loadScheduleJobs()`），
用 `import()` 只是为了避免在模块初始化期形成循环依赖。

**代价**：读代码的人会以为首屏省了体积（并没有）。**建议**（二选一，都不影响行为）：
① 把这几处注释从"懒加载"改成"按需拉数据 + 规避循环依赖"；
② 真想省体积的话，得让 `app.js` 不再静态 import 它们（风险高，收益有限，不建议）。
目前**只有 `session_info.js`（3.8KB）是真正切开的懒加载 chunk**。

### 2.4 一处死分支：`window.DOMPurify`**【已于 2026-10-15 删除假防护并写明真实防线 ✅】**

`ui.js` 的 `renderMarkdownContent()` 里有 `if (window.DOMPurify) html = DOMPurify.sanitize(html)`，
但**全仓没有任何地方加载 DOMPurify** → 这个"安全清理"从来没生效过。
要么真引入（多 20KB），要么删掉这行并写明"文档来源是扩展包内的受信文件，不需要 sanitize"。
现状是**最差的一种**：看起来有防护，实际没有。

### 2.5 `.git` 97MB（dist 入库的历史膨胀）

181 个跟踪文件，但 `.git` 有 97MB —— 因为 `dist/` 每次都入库，每次构建的 chunk 文件名带 hash，
历史里堆了几十份几乎相同的产物。当前 CI 依赖"dist 与 src 同步"这条检查（很有价值，别动）。
若将来想瘦身：把 `dist/` 改为发布产物（打 tag 时附 zip），CI 的同步检查改成"构建后比对"。
**收益中、改动面大、且动了发布流程 → 建议单独一次做，别和功能混在一起。**

---

## 2.6 【已修】所有数据表其实渲染成了一长串文本（2026-10-16 发现）

做「Order 历史」时撞上的：要求「以 table 方式列出来」，结果 DOM 里根本没有 `<tr>`。

- 各功能页的表容器都是 `<div id="xxx-table" class="data-table">`，而共享渲染器
  `common/table_utils.js` 直接 `tableEl.innerHTML = "<thead>…<tbody>…"` ——
  **`<thead>/<tr>/<td>` 在 `<div>` 里非法，HTML 解析器会把标签丢掉、只留文字**。
  实测：`renderTable(..., [{时间:'a'}])` 之后 `innerHTML === "时间a"`，`querySelectorAll("tbody tr").length === 0`。
- 影响面：T-4 清单 / 当日数据 / 报表 / PCD 四个域 / VVIP / 数据分析 / SOQL 导出 / 批量导入 /
  Metadata / 事件监听 —— 凡是走 `renderTable()` 的都中招；`.data-table { border-collapse: collapse }`
  这类「表样式挂在 div 上」的写法就是同一个误会的痕迹。
- 为什么一直没被发现：① 静态预览里这些表大多没有数据（假 Org 不支持那些查询）；
  ② 任何「断言表里有 N 行」的检查都会静默失败/通过；③ 截图上看是「一坨文字」，容易被当成导出前的中转态。
- 修法：渲染器检测容器不是 `<table>` 时，在里面建一个真 `<table>` 并复用（一次性修好全部调用点，
  传真 `<table>` 的老调用点行为不变）。回归网 = panel-shot 的 `order-history-*`（断言 `tbody tr` 行数）。

## 3. 顺带发现的小事（低优先级，记录备查）

- `src/docs/` 两个 md 都会被插件内页面 fetch 渲染 → 保留；但两者合计 40KB+，
  其中 README 里有一份目录树（已经与真实目录不同步，属于文档漂移）。
- `lib/css/antd.min.css` 24KB（裁剪版）+ `main.css` 116KB + `cmdk.css` 12KB；
  `antd.full.css` 558KB 只作为 vendored 源头留在 src（已在复制规则里排除，不进 dist）。
- `check-ui` 的 L 组现在也认"包装函数"（本轮改成：lib_loader 里包着 `ensureXxx()` 的导出，
  如 `requireXLSX()`，算合格调用）—— 这样以后再加包装不会被误报。

---

## 4. 本轮验证记录（全部通过）

| 套件 | 结果 |
|---|---|
| `npm run check:ui` | ERROR 0 · WARN 0（A~Q 组） |
| `npx jest` | 10 套件 / 220 用例 |
| `panel-shot` src + dist 全量 | OK（新增 `readme-panel-400`，`home-tab-1280` 加 `markedChunk`） |
| `neg-cases` 反向自检 | 如期 FAIL（证明断言不是装饰） |
| `ext-verify` src + dist | 15 项 |
| `overlay-verify` dist | 11 项 |
| `page-boot-verify` dist | 14 项 |
| API 版本 67.0 生效证据 | 默认 case 请求路径 `["67.0"]`；降级 case（假 org 只到 66）协商成 `["66.0"]` 并连上 |
