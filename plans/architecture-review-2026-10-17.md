# nForce-tools 架构评审（前后端 · 耦合 · 健壮性 · 可靠性）

> 评审时间：2026-10-17　版本：**v4.12.1**（manifest）
> 范围：`src/` 全部自有代码（59 个模块 / 27,249 行 JS）+ `index.html`（2,249 行 / 145KB）+ Service Worker + 构建与验证链
> 方法：静态依赖图（脚本建图 + 环检测）、调用面统计、错误处理密度统计、逐文件精读（app / background / sf_service / sf_rest_client / prefs / state / session_recovery / data_query / table_utils / ima_service / history_store / schedule / bulk / inspector_tools）、跑 `check:ui` + `jest` 复核当前基线
> 前序文档：`plans/architecture_audit.md`（2026-10-15）、`review-2026-09-28-jsforce.md`。**本文只写新增结论与仍未治理的部分，不重复已被修掉的 4 项冗余。**

---

## 0. 结论速览

| 维度 | 评分 | 一句话判断 |
|---|---|---|
| 分层结构 | **B+** | `common` / `biz` 两层划得清，但 `sf_service` 这一层把「连接」「业务查询」「数据整形」三件事压在同一个对象里 |
| 耦合度（纵向） | **C+** | JS ↔ DOM 靠 243 处 `getElementById` + 51 处 `section-N` 字符串直连，没有任何编译期校验，全靠 `check:ui` 兜 |
| 耦合度（横向） | **B** | 模块间依赖方向基本单向，只有 3 处**逻辑环**（用动态 import 打破）；但数据管道有 5 份近逐字复制 |
| 健壮性（异常/超时/取消） | **C** | 错误处理覆盖率很高（无空 catch），**但整条 Salesforce 请求链没有一个超时，也没有一处取消** |
| 可靠性（多宿主/生命周期） | **C+** | 会话自愈是教科书级；但「定时任务」在 SW 里没有执行体，关掉面板就静默失效 |
| 安全面 | **B** | 转义纪律好（`escapeHtml` 单一实现、通知走 `textContent`），但 SW 的消息白名单过宽 |
| 可验证性 | **A-** | 392 个单测 + 1,883 行自检工具 + 截图套件，这个体量的个人项目里属于罕见水平 |

**五个最该动的点（按性价比排序）**

1. **给 Salesforce 请求加超时 + 有限重试**（`sf_rest_client.request`）——目前一处 hang 就能让整个面板停在 loading，且无法自愈。
2. **定时任务要么在 SW 里真的执行，要么在 UI 上明确写「需保持插件页打开」**——现在它给用户的是"已创建"的确定感，实际是空转。
3. **抽一条统一的数据管道**（`runQuery({ fetch, render, export })`）——5 份 90% 相同的 `get*Data` 是未来的 bug 温床。
4. **`is_connected` 收敛到单一写点**——现在有 3 个写点 + 2 份新鲜度时钟，多宿主同时打开时会出现两份看门狗同时打 API。
5. **消息总线建注册表**——5 个 `onMessage` 监听 + 一处靠"必须最先放行"的顺序 hack 才不静默失败。

---

## 0.5 已实施（2026-10-17 当天，三项 P0）

| # | 改动 | 落地位置 | 验证 |
|---|---|---|---|
| 1 | **请求超时**：`request()` 默认 **120s**（2026-10-17 用户反馈 45s 会让慢 org 的大结果集查询假报错；设置页可改 10~600 秒，按次也能用 `timeoutMs` 覆盖）；超时抛 `REQUEST_TIMEOUT`、网络/CSP 抛 `NETWORK_ERROR`，两者都**不在** `AUTH_FAILURE_CODES` 里 → 慢链路不会被误判成会话过期；Metadata 的 SOAP 裸 `fetch` 一并覆盖；SW 的 Graph 代理 30s（超时文案改成"检查网络或 token 是否过期"） | `common/sf_rest_client.js`、`common/prefs.js`、`biz/prefs_panel.js`、`background.js` | 9 个新单测（含"超时**不**触发续期钩子、不重发"、默认值与上下限夹取、脏值回落） |
| 2 | **定时任务不再静默失效**：SW 改成**先落盘再广播**（`schedule_fired_log`，留 50 条）；页面启动时 `flushMissedAlarmReminders()` 把"本页打开之前触发过"的补成一条汇总提醒，实时通知则摘掉对应记录避免重复；清空任务时连记录一起清 | `background.js`、`biz/schedule.js`、`app.js`、`index.html`（文案） | 5 个新单测（含"晚于本页打开的记录不补报也不能被误删"） |
| 3 | **防重复提交**：新增 `guardAction(key, task, { buttonId })`，同一 key 同时只跑一趟、执行期间禁用按钮、`finally` 一定解锁且不越权恢复、**不吞错**；11 个入口接入（7 个取数表单 + 最新 / VVIP + Bulk 建 Job + Execute Anonymous），并把这些入口原本"调了但没 await"的调用补成 `await`（否则守卫会在活儿没干完时解锁，等于没防住） | `common/async_guard.js`（新）、`app.js` | 6 个新单测 + 全套回归 |

**验证记录**：`check:ui` ERROR 0 / WARN 0；`jest` **22 套件 / 421 用例全绿**（起点 19/392）；`npm run build` 通过，`dist/app.js` 346,027 → 348,920 字节（gzip ~103KB）；`check:coverage` 通过。

**同日追加的设置页改动**：新增「请求超时」组（10~600 秒，默认 120，带恢复默认与即时生效提示）；移除「侧边栏位置」组 —— 那一项只有 `sidePanel.getLayout()`、没有 `setLayout()`，只能显示一个只读值加一段"请去 Chrome 设置里改"，占地方且容易被误认为插件设置（`detectPanelSide()` 与三个 `panel-side-*` id 一并删除）。

> 说明：本次未做版本号与 README 变更（属发布动作）。工作区里**另有他人/本人此前未提交的改动**（`ui_layout.js` / `main.css` / `prefs_panel.js` / `manifest.json` 等），本次构建把它们的 `dist` 一并同步了 —— 提交时请按功能拆分。

---

## 1. 拓扑：这个项目里的「前端 / 后端」到底是什么

没有服务器。所谓后端由三段组成：**MV3 Service Worker（唯一的常驻进程）**、**Salesforce REST/Tooling/Bulk API**、**两个第三方 HTTP（Microsoft Graph / ima OpenAPI）**。前端则有三种宿主同时可能存在，加载的是**同一个 `index.html`**。

```
                    ┌─────────────────────────── chrome.storage.local（唯一的跨宿主真相源）
                    │        session / prefs / ui_layout / history / graph_token
                    │
┌───────────────────┴──────────────┐        ┌──────────────────────────────────┐
│  Service Worker  background.js   │        │  插件页面 index.html（同一份）    │
│  · alarms 调度（只广播，不执行） │◄──────►│  ├─ 宿主 A：side panel（默认）    │
│  · 搜索索引构建 + 结果 HTML      │ 消息    │  ├─ 宿主 B：普通标签页（宽屏）    │
│  · Graph API 代理（绕宿主 CSP）  │+storage │  └─ 宿主 C：search_overlay 注入页 │
│  · sidePanel open/close 状态     │        │      （经典脚本，不能 import）    │
└───────────────┬──────────────────┘        └───────────────┬──────────────────┘
                │                                            │
                │  fetch（Bearer sid）                       │  fetch（Bearer sid）
                ▼                                            ▼
        ┌──────────────────────────────────────────────────────────┐
        │ Salesforce REST / Tooling / Bulk 2.0 / Metadata(SOAP)    │
        │ Microsoft Graph（OneDrive）· ima OpenAPI（知识库同步）    │
        └──────────────────────────────────────────────────────────┘
```

**这个拓扑带来三个结构性事实**，后面所有问题都从这里长出来：

| 事实 | 后果 |
|---|---|
| 业务逻辑几乎全在页面里（SW 只做转发） | 面板一关，定时任务、会话自愈、后台请求全部停摆 |
| 同一份 HTML 跑在三种宿主上 | 所有"我在哪"的判断必须运行时探测（`detectHost()`），并衍生出 `?section=` / `pendingSection` / 整页锁 一整套补偿机制 |
| 跨宿主只能靠 `chrome.storage` 通信 | 出现了 `storage.onChanged` 反向同步内存状态这类"看起来像事件总线、实际是共享数据库"的模式 |

---

## 2. 分层与依赖

### 2.1 目录分层是清楚的

| 层 | 模块数 | 职责 | 是否碰 DOM |
|---|---|---|---|
| `common/` | 26 | 纯工具/协议/存储/日志 | 少数（table_utils / cmdk_view / ui_events） |
| `biz/` | 27 | 功能域 + 编排 + 渲染 | 大量 |
| 入口 | 5 | app / background / login_app / popup_app / search_overlay | — |

被依赖最多的模块（fan-in）：`logger 37` → `utils 25` → `state 14` → `sf_service 13` → `icons 11` → `ui 10`。
注入最重的模块（fan-out）：`app.js 30` → `ui.js 11` → `command_palette/order_history/ui_layout 各 8`。

`app.js` 扇出 30 是**合理的**（它是编排层，本来就该认识所有功能域）；真正的问题是它有 2,442 行，其中 1,200 行是在写事件绑定。

### 2.2 三个逻辑环（不是 ESM 求值环，但仍是设计环）

```
ui.js ──动态 import()──► bulk.js      ──静态 import──► ui.js   （渲染表格）
ui.js ──动态 import()──► schedule.js  ──静态 import──► ui.js   （渲染任务列表）
ui.js ──动态 import()──► org_limits.js──静态 import──► ui.js   （showSection）
```

为什么存在：`ui.js` 进入某个 section 时要去拉数据，而数据模块渲染结果时又要回 `ui.js` 拿渲染函数。

代价（已有实测证据）：
- 构建期稳定出现 3 条 `INEFFECTIVE_DYNAMIC_IMPORT` 警告 —— 因为这几个模块同时被 `app.js` 静态 import，**chunk 根本打不开**，动态 import 只起到"打破环"的作用，一处也没省体积；
- 读代码的人会以为这是懒加载 → 想省首屏却在改注释。

**建议（低成本、不动行为）**：把 `bulk.js` / `schedule.js` / `org_limits.js` 里对 `ui.js` 的依赖反过来 —— 让 `ui.js` 接收渲染回调，或把 `renderBulkJobsTable` / `renderScheduleJobsData` / `renderLimitsList` 移到独立的 `biz/*_view.js`（无 import 的纯渲染）。这样三个环全部消失，`ui.js` 的 fan-in 从 10 降到 ~7。

### 2.3 巨型模块（仍然存在）

| 文件 | 行数 | 主要负担 |
|---|---|---|
| `app.js` | 2,442 | 编排 + `bindEvents()` 单函数 ~1,060 行（约 90 个 `on()` 绑定） |
| `biz/ui.js` | 2,296 | 31 个 section 的渲染 + 首页 + 图表 + Markdown |
| `biz/sf_service.js` | 1,826 | 见 2.4 |
| `biz/ui_layout.js` | 1,324 | 布局归一化 + 拖拽 + 导出导入 |
| `common/excel_utils.js` | 1,065 | 表格↔对象互转 |
| `common/onedrive_service.js` | 1,024 | Graph 客户端（单个 class） |

前 4 个合计 7,888 行 = 自有代码的 **29%**。`logic.js` 已经拆掉了（2026-10-15），剩下的这 6 个里，**只有 `sf_service.js` 是结构性问题**，其余是"体积问题"。

### 2.4 `sfConn`：一个对象，五种职责

34 个方法，全部挂在一个对象字面量上：

| 职责 | 方法（举例） | 问题 |
|---|---|---|
| 连接生命周期 | `testConnection` / `applyApiVersion` / `clearSchemaCache` | — |
| 业务查询（**内联 SOQL**） | `getDailyData` / `getReportData` / `getT2Data` / `getPCD*4` / `getVVIPData` | 8 条几百字的 SOQL 常量直接写在连接层，字段名与业务口径和 HTTP 细节混在同一文件 |
| 数据整形（**业务规则**） | `flattenRecords` / `remove_duplicates` / `applyT2Rules` / `applyExpiryRules` | 是 import 进来的纯函数，但被当作"查询的一部分"调用 |
| 平台 API | Bulk 3 个 / Tooling 6 个 / `runAnonymousCode` | 与业务查询同层级 |
| 缓存 | `_schemaCachedForInstance` / `describe*` | 缓存生命周期绑在对象上，重连逻辑要小心翼翼绕开它（`testConnection` 里那段注释就是证据） |

**这才是"前后端耦合"最实质的一处**：不是文件放错了目录，而是**协议层与领域层没有分开**。直接后果是 `get*Data` 全都返回 `{success, error}` 而不是抛错（协议层要兼容两种错误口径），于是上层所有调用点都要写 `if (result.success) ... else showNotification`，错误处理从此分裂成两套（见 4.4）。

**建议的切法（渐进，不需要一次到位）**：
1. 把 8 条 SOQL 提到 `biz/soql/{daily,report,t2,pcd,vvip}.js`，导出 `buildXxxQuery(params)`（纯函数，可单测，能直接断言 WHERE 子句）；
2. `sf_service` 只保留 `query(soql, opts)` / `tooling*` / `bulk*` / `executeAnonymous`，**一律 throw**；
3. 建 `biz/domain/*.js`，做 `fetch + 整形 + 规则`，返回 `{rows, meta}`，由上层统一 catch。

---

## 3. 耦合性

### 3.1 纵向耦合：JS ↔ DOM 是"字符串契约"

| 指标 | 数值 | 风险 |
|---|---|---|
| `document.getElementById` 直接调用 | **243** 处 | `dom.js` 的 `$()` / `on()` 已成规范，但只覆盖了一部分 |
| `section-N` 字符串引用 | **51** 处 | 编号即协议；改版号 = 全局搜索改 |
| `innerHTML =` 赋值 | **123** 处 | 其中 `ui.js` 36 处、`inspector_tools.js` 17 处 |
| `index.html` | 2,249 行 / 145KB，31 个 section **全在 DOM 里** | 任何 id 改名都不会有编译期报错 |

这条契约由 `check:ui`（1,883 行，A~R 组）兜底 —— 这是正确的取舍：**在"src 必须能直接加载"的硬约束下，不可能上模板引擎**。但 `check:ui` 是"事后检查"，改 id 时得到的反馈是"跑完脚本报红"，而不是编辑器里的红波浪线。

**低成本改善**：把 31 个 section 号 + 关键 id 收进 `common/dom_ids.js` 常量表（`SECTION.ORDER_HISTORY = 30`），JS 侧不再写字面量 `30` / `"section-30"`；`check:ui` 已经有磁贴↔section 的映射表，顺手就能校验常量表与 HTML 一致。这一步能消掉 51 处魔法数字里的大部分。

### 3.2 横向耦合：`appState` 是"上帝状态"

`biz/state.js`：**52 个字段 + 20 个 `has_*` 布尔**，且每个 `has_*` 都在和对应的 `*_data` 重复表达同一件事：

```js
has_daily_data: false,      daily_data: null,
has_report_data: false,     report_data: null,
has_t2_data: false,         t2_data: null,
... 共 10 组
```

这是典型的**派生状态冗余**：只要有一条路径漏写 `has_xxx = true`，按钮就永远不亮（或者反过来，数据被清空但按钮还亮着）。当前靠人肉纪律维持（`updateUIState()` 里 23 处调用）。

**建议**：`has_*` 全部改成 getter（`get hasDailyData() { return !!this.daily_data?.length }`），或者直接在 `updateUIState()` 里由 `*_data` 现算。收益：删掉 20 个可写字段，少一类"状态不同步"bug。

另外 `state.js` 自己留了一段诚实的注释：**8 个数据集常驻内存、没有任何释放路径**。配合 `maxFetch: 999999`（`getT2Data` / `getDailyData` / `getReportData`），长时间使用后侧边栏内存会持续增长。

### 3.3 存储耦合：`prefs.js` 是"应该的唯一入口"，实际只有 6 个模块用

`chrome.storage.local` 出现 **71 次**、分布在 **15 个文件**；`chrome.storage.session` 12 次。
`common/prefs.js` 的设计很好（表驱动 `PREF_KEYS / PREF_DEFAULTS / SPECS`，含 `secret` 脱敏与非法值自愈回写），但它只覆盖了偏好类 5 个键。

真正散落的是这几类：
- 会话三件套（`sf_session_id` / `sf_instance_url` / `is_connected`）在 6 个文件里各自 `get/set`；
- `ui_layout` 在 `ui_layout.js`、`background.js`（搜索索引）、`command_palette.js` 各读一遍；
- 历史、Graph token、调度配置各自一套读写。

**建议**：按 `prefs.js` 的模式再抽 2 个 store —— `session_store.js`（三件套 + 新鲜度）与 `ui_store.js`（layout / favorites）。不是为了少写代码，是为了让"谁能写 `is_connected`"变成一个问题只有答案的事（见 5.2）。

### 3.4 消息耦合：5 个监听器 + 一处顺序 hack

```
background.js:169   ← 白名单校验（alarm / onedrive 代理）
background.js:789   ← search:* 协议
app.js:1173         ← ui:goto-section
biz/schedule.js:336 ← ALARM_TRIGGERED
biz/command_palette.js:360 ← search:open
```

`background.js:169` 里有一段必须存在的 hack：

```js
// ⚠️ 必须最先放行 `search:*`（那条链路的监听器在文件末尾）。
const earlyPass = typeof message?.type === "string" && message.type.startsWith("search:");
if (earlyPass) return undefined;
```

原因写得很清楚：Chrome 对同一条消息会依次调用**所有**监听器，但只认**第一个** `sendResponse`；如果白名单先回一句 `Invalid message type`，浮层就永远打不开。**这是"消息总线没有注册表"的直接代价**：新增一条消息类型时，正确性取决于"你有没有记得在 169 行加白名单"。

**建议**：`common/message_bus.js` 维护 `{ type → handler }` 注册表，`background.js` 只保留**一个**监听器做分发：
- 未知类型 → 不响应（返回 `undefined`），让别的上下文自己处理，而不是抢先回 `success:false`；
- 白名单（允许来自网页的注入脚本）变成注册时的 `allowFromContentScript: true` 标记；
- `earlyPass` 这件事从此在结构上不可能发生。

### 3.5 重复逻辑：数据管道 9 份、loading mask 约 10 份

`biz/data_query.js` 5 个（latest / daily / report / t2 / vvip）+ `biz/data_pcd.js` 4 个（pcd-daily / pid-fallout / qc-issue / expired），**形状完全一致**：

```js
const loadingMask = document.getElementById("loading-mask");
if (loadingMask) { loadingMask.style.display = "none"; loadingMask.querySelector("h3").textContent = "正在从Salesforce获取数据..."; }
if (result.success) {
  appState.has_xxx = true; appState.xxx_data = result.data; appState.stats.xxx = result.data.length;
  renderXxxData(result.data);
  document.getElementById("xxx-data-actions").style.display = "block";   // ← 有的有、有的没有
  document.getElementById("export-xxx-data").style.display = "inline-block";
  updateUIState(); updateStats();
  await exportXxxData();
}
```

差异只有 4 个变量名，**并且在已经漂移**：`getSalesforceData` / `getReportData` / `getT2Data` 成功时不弹通知，`getDailyData` / `getVVIPData` 弹；`export-btn` 与 `export-actions` 有的设有的不设；`getT2Data` 连 `else showNotification(失败)` 分支都没有。

**建议**：

```js
// biz/query_pipeline.js
export async function runQuery({ title, stateKey, statKey, fetch, render, exportFn, notify = true }) {
  mask.show(title);
  try {
    const rows = await fetch();               // 域层 throw，不再返回 {success}
    appState[stateKey] = rows;
    appState.stats[statKey] = rows.length;
    render(rows); updateUIState(); updateStats();
    if (exportFn) await exportFn();
    if (notify) showNotification(`${title}成功，共 ${rows.length} 条`, "success");
  } catch (e) {
    showNotification(`${title}失败：${describeError(e)}`, "error");
  } finally {
    mask.hide();
  }
}
```

**9 个函数 → 9 行声明。**这一条是本次评审里收益最高的重构**：它同时解决重复、错误口径不一、以及"漏写 updateUIState"这类静默 bug。**

---

## 4. 健壮性（Robustness）

### 4.1 【P0】整条 Salesforce 请求链没有超时

`common/sf_rest_client.js` 的 `request()` 是全项目唯一出口，而它是这样发的：

```js
const res = await fetch(absoluteUrl, { method, headers, body: sendBody });
```

**没有 `signal`**。全仓 `AbortController` 只出现在 `ima_service.js`（20s）和 `api_version.js`（`AbortSignal.timeout(4000)`）—— 说明团队知道这个模式，只是没用到主链路上。

后果链条很具体：
- 请求 hang 住（代理半开、网关黑洞、Salesforce 长事务）→ `await` 永不返回；
- 上层 `get*Data` 的 `finally` 永远不执行 → **loading mask 永远不消失**（`showNotification` 也不会弹）；
- 用户唯一自救方式是关掉侧边栏重开（面板没有地址栏，没得刷新）；
- 401 自动续期钩子也救不了 —— 它挂在 `res.status` 上，而 `res` 根本没来。

**修法（10 行，收益最大）**：

```js
// 实际落地形态（2026-10-17）：默认值可被设置页覆盖，模块级变量而非常量
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;   // 大结果集查询可能跑过一分钟
let currentRequestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS;
export function setRequestTimeout(ms) { /* 夹在 1s ~ 600s */ }

// request() 内部：每次发请求现算
const timeoutMs = Number.isFinite(optsObject.timeoutMs) && optsObject.timeoutMs > 0
  ? optsObject.timeoutMs
  : currentRequestTimeoutMs;
const res = await fetch(absoluteUrl, {
  method: method || "GET",
  headers: {...},
  body: sendBody,
  signal: timeoutSignal(timeoutMs)     // AbortSignal.timeout 的能力检测版
});
```
超时抛 `AbortError` → `toTransportError()` 转成 `SalesforceApiError(..., { errorCode: "REQUEST_TIMEOUT" })`，并在 `sf_service` 的 `isSessionAuthFailure()` 里**不算鉴权失败**（只认 `AUTH_FAILURE_CODES` 白名单，`REQUEST_TIMEOUT` / `NETWORK_ERROR` 都不在里面）。这样"网络慢"不会被误判成"会话过期"，也就不会触发一轮白跑的 Cookie 恢复。

`background.js` 的 `handleOneDriveApiRequest` 也一并加了 30s 超时（浏览器侧最坏情况从"永久挂着"收成 30 秒后一句能照做的提示）。

### 4.2 重试策略只有一种：401 换会话

现状：`request()` 在 401/403 时调钩子换会话并**原样重发一次**（设计得很克制，注释里解释了为什么只重试一次、以及为什么钩子必须在 `identity()` 成功后才挂 —— 否则递归）。

缺的是**瞬态故障**这一类：500/502/503/504、`fetch` 直接抛网络错误。Salesforce 的 `REQUEST_RUNNING_TOO_LONG` / 网关 502 都不罕见，现在的表现是直接报错给用户。

**建议**：只在 **幂等请求**（GET，或带 `Idempotency-Key` 的调用）上做 3 次指数退避（500ms / 1.5s / 4s + 抖动）。POST（`executeAnonymous`、Bulk 建 job）**不能盲重试** —— 会把一条 Apex 跑两遍。这条边界必须写进注释，否则下一个人一定会顺手加上。

### 4.3 没有取消：切页/重开都在等旧请求

- 用户在 `section-2` 点了"获取当日数据"，立刻切到 `section-30`：旧请求继续跑，回来后往已隐藏的 DOM 里写数据（`renderDataTable` 里对容器做了 `null` 保护，所以不会炸，但会白烧 API 配额，并在统计里留下痕迹）；
- 同一个 section 连点两次 = 两条查询并行 + **两个 Excel 文件被下载**（见 5.3）。

### 4.4 错误口径有两套，且都在"静默"

| 形态 | 出现场景 | 问题 |
|---|---|---|
| `return { success: false, error }` | `sfConn.get*Data`、`bulk`、`inspector_tools` | 调用方**必须**记得检查 `success`；漏了就是静默什么都不做 |
| `throw` | `sf_rest_client`、`ima_service`、`history_store` | 需要 catch；`data_query` 里 catch 后统一弹"请稍后重试" |
| 字符串错误 | `testConnection` 的 `lastError` | 与上面两套都不兼容 |

`describeError()`（`utils.js:298`）已经存在，但只在全局 handler 与少数地方用；`data_query` 里 5 处 catch 全都写死了"请稍后重试"，把 `result.error` 丢了。

**建议**：统一到"**域层 throw、编排层 catch 并 `describeError(e)`**"，`{success}` 只在**跨上下文（消息）**边界保留 —— 因为 `sendResponse` 传不了 Error 对象。

### 4.5 有的兜底（值得保留）

- `window.addEventListener('unhandledrejection' / 'error')` → 记日志 + 弹通知 + 强制隐藏所有 `#loading-mask`。**"顺手把 mask 关掉"这一句是全项目最实用的一行**，它把任何未捕获异常从"卡死"降级成"报错"。
- 无空 `catch`（全仓 grep 0 处）→ 不会出现"错误被吞掉、表现为没反应"。
- `testConnection` 里把 `lastError` 结构化（`message / errorCode / statusCode`），`isSessionAuthFailure()` 只认 401/403 或明确错误码 —— 这条纪律避免了"网络抖动被当成会话过期，把已连接状态误降级"。
- `probeInstanceApiVersions` 的失败**不缓存**，注释写明"一次网络抖动不该变成永久结论"。

### 4.6 会话自愈：四层设计，是本项目最扎实的一块

`app.js` 的 189~550 行值得单独表扬，也值得作为其他模块的范式：

| 层 | 触发 | 关键保护 |
|---|---|---|
| ① 启动校验 | 打开面板 | 失败**不**降级（区分 CSP/网络 vs 真失效） |
| ② 运行期 401 | 任意请求 | 换会话后**原样重发一次**，用户无感 |
| ③ 回到面板 / sid Cookie 变化 | focus / visibility / cookies | 按**新鲜度**（5min）判断，而不是信 `is_connected` |
| ④ 看门狗 | 15s 起、退避到 120s、8 次后暂停 | 连上即停，不烧配额 |

共用的三把锁：`recoveryInFlight`（重入）、`RECOVERY_MIN_INTERVAL_MS`（节流）、`lastVerifiedAt`（新鲜度）。注释里明确写了**为什么钩子不能在 `identity()` 成功前挂**（否则 401 → 续期 → 验证 → 401 递归），这类"把踩过的坑写进代码旁"的做法，是这个仓库最大的资产。

### 4.7 输入校验：关键路径都有，但不成体系

- SOQL 注入：`_validateDate()` 只放行 `YYYY-MM-DD`（做得好），但**用户自填 SOQL 的入口（SOQL 导出 / Bulk）本身不做任何限制** —— 这是产品定位（开发者工具），可接受，但它意味着"插件能跑任意 SOQL"，权限面等同于当前用户。
- 布局 JSON：`normalizeLayout()` 是纯函数 + 确定性输出，非法值回落默认（好）；`test/cmdk_view.test.js` 甚至断言"布局 JSON 是用户可编辑的 → 条目文本必须转义"。
- 偏好：`SPECS.parse` 校验失败**不写入**并回显 `howto`（好，避免"填了但没生效"）。

---

## 5. 可靠性（Reliability）

### 5.1 【P0】定时任务是"看起来能跑"的空壳

链路是这样：

```
chrome.alarms.onAlarm (SW)
  → getTaskConfigs() 读 storage
  → chrome.runtime.sendMessage({ type: 'ALARM_TRIGGERED' })   ← 只有广播
  → biz/schedule.js:336 才有真正的处理逻辑（在**页面**里）
```

而 SW 里那句注释已经预告了结局：

```js
}).catch(err => {
  log.debug("无活动页面可接收消息:", err.message);
});
```

**当侧边栏关闭、也没有插件标签页时，`sendMessage` 没有接收者 → 任务静默不执行**。用户看到的是"任务已创建、下次执行时间 X"，实际什么都没发生。而且这不是边缘场景：侧边栏是最主要的宿主形态，用户点一下图标就会收起它。

同类问题还有一个更隐蔽的：`chrome.alarms` 的周期在 MV3 稳定版最小 1 分钟，低于此值会被 **Chrome 静默 clamp**，而 UI 允许填任意小数 —— 用户填 0.5 会得到"每 1 分钟"，界面上看不出来。

**两条路，必须选一条**：

- **A（推荐，符合 MV3 语义）**：执行体搬进 SW。任务定义改为**声明式**（`{ type: "daily_report", params }`），SW 在 `onAlarm` 里自己发 REST 请求、把结果写 storage，页面只负责展示历史。代价：SW 里需要一份 SF 客户端（可直接 import `sf_rest_client.js`，它零 DOM 依赖——这也是当初删 jsforce 的红利），以及会话凭据（storage 里本来就有）。
- **B（一天能做完）**：诚实地降级。UI 上把"定时任务"改成"提醒"，文案写明"需保持插件页面打开"；`onAlarm` 时若无接收者，写一条 `missed_alarms` 记录，下次打开页面时用通知汇总告知"错过的 X 次"。**至少让沉默变成可见。**

补充：`periodInMinutes` 建议在 UI 侧 clamp 到 `Math.max(1, v)` 并回显实际值。

### 5.2 `is_connected` 有 3 个写点 + 2 份"新鲜度时钟"

| 写点 | 位置 |
|---|---|
| `app.js` | `handleAuthFailure`、启动分支、手动连接成功 |
| `session_recovery.js` | 恢复成功后写 `appState` + `storage` |
| `app.js` 的 `watchSessionStorage` | 另一处宿主的 storage 变化**反向覆盖**本页内存 |

`lastVerifiedAt` / `sessionSuspect` 只活在 `app.js` 的模块作用域里。

多宿主场景（用户固定侧边栏 + 另开一个完整应用，这是**官方鼓励**的用法，顶栏就有"完整应用"按钮）：
- 两个页面各有自己的看门狗与新鲜度时钟 → 会话真失效时，**两个看门狗会各试一轮**（每个候选 2-3 个请求），API 配额翻倍；
- A 页把 `is_connected=false` 写入 storage，B 页收到通知后 `markSessionReady()` **反而**被跳过/触发不一致；
- 现有缓冲：`RECOVERY_MIN_INTERVAL_MS` 只在**本页**生效，不跨宿主。

**建议**：把"会话 + 新鲜度 + 看门狗"抽成 `biz/session_store.js`，`lastVerifiedAt` 写进 `chrome.storage.session`（SW 与所有页面共享，且天然不持久），看门狗用 `storage.session` 里的 `recoveryOwner` 做**跨宿主互斥**（谁抢到锁谁试，另一页只监听结果）。这是 5.1 方案 A 的前置条件。

### 5.3 没有防重入：双击 = 两次查询 + 两个文件

`app.js` 的所有取数表单都是这样：

```js
on("daily-data-form", "submit", function (e) {
  e.preventDefault();
  mask.show("正在获取当日数据...");
  getDailyData();          // ← 不 await，不 disable 按钮，无 in-flight 标记
});
```

而 `getDailyData()` 成功后**自动导出 Excel**（"取完就落盘"是既有行为）。所以双击一次会：2 次 SOQL + 2 个 `data_YYYY-MM-DD.xlsx` 下载 + `stats` 被写两次。对 `executeAnonymous` 更严重 —— 双击等于**同一段 Apex 跑两遍**（可能是 DML）。

**建议**：`runQuery`（见 3.5）内部维护 `inFlight: Set<key>`，重复触发直接 `return` 并提示"正在执行中"；按钮同时 `disabled`。`executeAnonymous` 单独加一次二次确认或防重（写操作，语义上不该静默重复）。

### 5.4 数据不释放 + 超大 `maxFetch`

`state.js` 自己写了这段注释（诚实，但问题仍在）：

> 8 个 `getXxxData()` 拿到的全量数据都常驻在 `_appState` 里……没有任何路径会把它们置空。

配合 `maxFetch: 999999`（T2 / daily / report 三处），一次"未来 4 天的 T2 数据"在客户大 org 上可能是 5 万行 × 25 列。这些对象会：
1. 常驻内存（面板开着就一直占）；
2. 进 `appState` 后被 Proxy 的 set 触发监听（大数组只 set 一次，没有逐条开销，OK）；
3. 被 `renderTable` 截到 1,000 行（好），但导出时**全量**进 XLSX。

**建议**：给数据集加生命周期 —— 离开 section 或导出完成后置 `null`，导出按钮改为"需要时重拉"；`maxFetch` 收到 50,000 并在 UI 上说明"超出部分请用 Bulk"。这条不是 bug，但会在"客户 org 数据量涨上来"那天变成 bug。

### 5.5 外部依赖的可靠性差异很大

| 依赖 | 超时 | 重试 | 凭据 | 评价 |
|---|---|---|---|---|
| Salesforce REST | **无** | 仅 401 | sid（storage） | 主链路最大缺口 |
| ima OpenAPI | 20s | 无 | ClientId + ApiKey（storage，日志脱敏） | **范式级**：错误码翻译成人话、`code≠0` 直接透传服务端文案 |
| Microsoft Graph | **无**（SW 代理裸 fetch） | 无 | **手工粘贴 token，1 小时过期** | 最脆弱：过期后用户只会看到 401 |
| Metadata SOAP | 无（但轮询有 300s 上限） | 无 | sid | 可接受 |

Graph 那条建议至少做两件事：① SW 代理加超时；② 401 时把提示改成"Graph token 已过期（约 1 小时），请到设置重新粘贴"——现在只会显示 `Graph API error (401)`。

### 5.6 构建/发布的可靠性（这块比大多数商业项目更严）

- `src/` 本身就是可直接加载的扩展目录 → 不打包也能跑。这是**最贵的一条约束**，也是 `COPY_RULES` + J 组存在的原因；
- `dist/` 入库 + CI 检查"dist 与 src 同步"；
- `test/sw_module_graph.test.js` 用万能桩把 SW 的整条模块图 require 一遍 —— 因为"逐字复制的 SW 里顶层写错 = SW 静默不注册，唯一表现是快捷键没反应"；
- `check:ui` 的 J 组守住"HTML/manifest 里的相对引用在 dist 里真的存在"（产物名带 hash 或 chunk 没落进 dist → **页面空壳且零报错**）。

这三条对应三个真实的静默故障，属于**用工具弥补语言缺陷**的正确做法。

### 5.7 SW 生命周期相关的两个小隐患

- `searchIndexCache`（30s TTL）与 `describeglobal` 缓存都在内存里，SW 被回收即丢 —— 这是设计过的（注释写明"丢了重建即可"），但**页面侧的 `_schemaCache` 与 SW 侧各一份**，跨宿主不共享，describe 日限额在"侧边栏 + 标签页同时开"时仍会翻倍。`MODULES O` 只保证了"同一个上下文内不重复"，没保证"跨上下文"。
- `readOpenWindows()` 用 `storage.session` 记侧边栏开合状态（因为 API 没有 `isOpen()`），但 `onOpened/onClosed` 需 Chrome 141+，低版本退化成"盲开"。注释写了，代码也兜了 —— 可以接受。

---

## 6. 安全面（顺带做的一轮）

| 项 | 现状 | 判断 |
|---|---|---|
| XSS（数据 → DOM） | 单一 `escapeHtml`（47 处调用），通知用 `textContent`，`cmdk_view` 有专门的"布局 JSON 是用户可编辑的 → 必须转义"测试 | **良好**。123 处 `innerHTML` 里绝大多数是拼静态骨架 + 转义后的数据 |
| 会话凭据 | sid 明文存 `storage.local` | 与浏览器 Cookie 本身等价（`chrome.cookies` 随时能读到同一个 sid），不算额外暴露；但**没有 `unlimitedStorage` 之外的加密**，多用户共机时需提示 |
| ima API Key | 存 `storage.local`，`setPref` 日志走 `maskSecret` | 良好 |
| SW 消息来源校验 | `isValidSender()` 接受**任何**带 `sender.tab.id` 的消息 | **偏宽**。当前只有我们自己的注入脚本会发消息，但"任何网页一旦能注入我们的 content script"（例如未来加了 `content_scripts`）就能调 `ONEDRIVE_API_REQUEST`，而那个 handler **不校验目标域名**，等于一个"带凭据的任意 URL 代理"（SSRF 面）。建议：`host` 白名单 + 每条消息显式声明 `allowFromContentScript` |
| 权限面 | `tabs` 仍在（`architecture_audit.md` §2.1 已论证可去掉，唯一盲区是"非 Salesforce 页按快捷键"无法自动验） | 建议人工验一次后去掉，安装提示少一条"读取浏览历史" |

---

## 7. 做得好的地方（改动时别顺手破坏）

1. **会话自愈四层 + 三把锁**，注释里带着"为什么不能那样写"的反例。这是全项目最高质量的一段。
2. **`sf_rest_client` 替换 jsforce**：8KB 换掉 1.37MB，且保留了调用签名；`upsert` 顺手改成批量端点；有 `tools/jsforce-diff/` 逐请求比对基线。
3. **`prefs.js` 表驱动**：新增偏好 = 三行，且非法值自愈回写。
4. **`history_store.js`**：正文哈希当 id（导入去重与勾选都靠它）+ 旧 `string[]` 读时升级，不需要迁移脚本。
5. **`ima_service` 的错误分层**：网络/超时/401/业务码/非 JSON 五类，各自一句人话。
6. **`table_utils` 的分页渲染**：`pageSize` 是唯一真正有效的优化（成本 O(行数) 是布局对象，不是 DOM 节点）。
7. **验证网**：`check:ui` A~R 组 + 392 单测 + panel-shot / neg-cases / ext-verify / overlay-verify / page-boot-verify。**这个项目的可靠性主要来自这里，而不是来自架构本身** —— 也就是说，架构的缺陷目前是被测试网兜住的，一旦测试网跟不上新增功能，缺陷就会漏水。

---

## 8. 路线图（按性价比）

### P0 —— ✅ 已完成（详见 §0.5）

| # | 事项 | 状态 |
|---|---|---|
| 1 | `sf_rest_client.request()` 加超时（默认 **120s**，设置页可调 10~600s）+ `REQUEST_TIMEOUT` 错误码（不进 `AUTH_FAILURE_CODES`）；Metadata SOAP 与 SW 的 Graph 代理同理 | ✅ 已实施 |
| 2 | 定时任务：SW 先落盘再广播 + 页面启动补报错过的提醒（选了"诚实降级"这条，成本最低且不改权限面） | ✅ 已实施 |
| 3 | 取数/执行类入口防重入（`guardAction`：in-flight + 按钮 disabled + 必定解锁） | ✅ 已实施 |

### P1 —— 两到三周，都是"止血 + 减面"

| # | 事项 | 收益 |
|---|---|---|
| 4 | 抽 `biz/query_pipeline.js`，9 份 `get*Data` 收敛 | 删 ~700 行重复，统一错误口径与 UI 收尾顺序 |
| 5 | `has_*` 20 个布尔改派生 | 消灭"状态不同步"一类 bug |
| 6 | 消息总线注册表（替换 5 个监听 + `earlyPass`） | 新增消息类型不再依赖"记得改白名单" |
| 7 | `session_store.js` + `storage.session` 里的跨宿主恢复互斥 | 多宿主不再双份打 API |
| 8 | 幂等请求的 3 次指数退避 | 网关抖动不再直接报错 |

### P2 —— 有空再做

| # | 事项 | 说明 |
|---|---|---|
| 9 | 拆 3 个逻辑环（`ui.js` fan-in 10 → 7） | 顺带消掉 3 条误导性的 `INEFFECTIVE_DYNAMIC_IMPORT` |
| 10 | SOQL 常量外移 + `sfConn` 分层（协议 / 领域） | 让"改业务口径"只改一个文件 |
| 11 | DOM id 常量表（`SECTION.*`） | 51 处魔法数字收敛，`check:ui` 顺带校验 |
| 12 | 数据集生命周期（离开 section 释放）+ `maxFetch` 收敛 | 长时间使用内存不再单调增长 |
| 13 | Graph OAuth refresh（或至少 401 时给准确提示） | OneDrive 同步从"1 小时后失效"变成"能用" |
| 14 | 去掉 `tabs` 权限（人工验一次快捷键注入） | 安装提示少一条最吓人的 |

---

## 9. 附录：本文数据的取法

| 数据 | 命令/方法 |
|---|---|
| 依赖图 / 环检测 | 自写脚本遍历 `src/**/*.js`（排除 `lib`）收集静态 `import ... from` 与 `import(".")`，DFS 三色标记 |
| 行数 / 扇入扇出 | `wc -l` + `inDeg` 统计 |
| 错误处理密度 | 每文件 `catch` / `await` 计数；空 catch 用 `catch\s*\(\s*\)\s*{\s*}` 匹配（0 处） |
| DOM / 存储 / 消息面 | `document.getElementById` / `chrome.storage.*` / `onMessage.addListener` 出现次数 |
| 当前基线 | `node tools/check-ui.mjs` → ERROR 0 · WARN 0；`npx jest` → 19 套件 / 392 用例全绿 |
| 产物体积 | `du -sh dist` = 3.4MB；主 bundle 346KB，懒加载 chunk 最大 56KB |

> 说明：本次评审**没有改任何代码**。P0 的三项如果需要，我可以直接落地并跑完整验证链（`check:ui` + `jest` + `build` + `ext-verify`）。
