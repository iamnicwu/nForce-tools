# nForce Tools · UI 显示逻辑分析与简化方案

> 结论先说：**UI 本身的分层是对的（首页磁贴 → 详情页单 section），问题不在设计，而在"一个功能的定义被复制到了 6 个文件里"。**
> 只要把「功能定义」收敛成一份清单、其余全部派生，就能同时解决"查问题难"和"加功能烦"。
> 配套自检脚本已就位：`npm run check:ui`。

---

## 一、现状盘点（实测数据）

| 项目 | 数值 | 说明 |
|---|---|---|
| `src/index.html` | 1680 行 / 247 个唯一 id | 26 个 `#section-N` 卡片全部内联写死 |
| 首页磁贴 | 23 个 | 由 `rules/ui_layout.json` 驱动 |
| 详情页 section | 26 个 | 20/21 为内部页（齿轮/设置页进入），6 由设置页 `data-goto` 进入 |
| `getElementById` 调用 | **≈ 400 次** | app.js 96 · ui.js 120 · logic.js 87 · inspector_tools.js 47 · ui_table.js 27 · ui_layout.js 10 |
| `main.css` | 2465 行单文件 | 含"统一组件"与"App 图标式布局"两套体系 |
| 图标映射 | 44 个 | `common/icons.js` 的 IconMap（无 FontAwesome 字体，全部靠内联 SVG） |

显示链路本身很清晰，不需要动：

```
index.html
  ├─ #launcher-view   首页：磁贴网格（ui_layout.js 渲染）
  └─ #detail-view     详情页：26 个 .step-section，靠 .active 显示其中一个
                       （.step-section{display:none} + .active{display:block}）
```

---

## 二、症状：自检脚本抓到的真实问题

> 状态：以下 1~3 类**已在 Step 1 中修复**（见 §八 执行记录），第 4 类为设计隐患已加固。
> 自检脚本当前输出 **ERROR 0 · WARN 1**（仅剩一处需要产品决策的语义不一致，见 §8.3）。

`npm run check:ui` 首次运行报告 **ERROR 17 · WARN 14 · INFO 6**。其中最影响用户的三类：

### 1. 首页 3 个磁贴图标是空白方块（ERROR）
`common/icons.js` 里没有这三个映射，而项目**根本没有 FontAwesome 字体**（`<i class="fas fa-xxx">` 不会被替换就什么都不显示）：

| 磁贴 | 图标 | 位置 |
|---|---|---|
| 批量导入 | `fa-file-import` | `rules/ui_layout.json:87` |
| Metadata 工具 | `fa-box-open` | `rules/ui_layout.json:88` |
| 事件监听 | `fa-satellite-dish` | `rules/ui_layout.json:89` |

另有 14 个图标在 `index.html` 里同样是空白（`fa-cloud-download-alt`、`fa-play`、`fa-file-csv`、`fa-dice`、`fa-inbox`、`fa-broom`…）。
**成因**：新增功能时只改了 `ui_layout.json`，忘了改 `icons.js`。

### 2. 16 处死引用（WARN）
JS 在找 HTML 里不存在的元素，是旧侧边栏时代删除 UI 后留下的：

- `user-current-step`、`user-daily-orders`、`user-report-records`、`user-t2-records`、`user-uploaded-orders`、`user-pcd-daily-orders`、`user-session-id`（`biz/ui.js:790-820`，对应整套 `updateStats` 统计逻辑）
- `session-status-badge`、`connection-badge`、`t2-analysis-badge`、`order-count`、`file-upload-success`
- `pcd-daily-custom-date-checkbox` / `-container`（`app.js:437-440`）

这些是无害噪音，但会让"查问题"时误以为功能还在。

### 3. 零引用的死配置（结构性）
`biz/ui_config.js` 里的 `submenuConfig`（62 行，描述 LTS/OTT/PCD/CVP7/Tools/Settings 横向子菜单）与 `sectionToModule` **全项目无人引用**，描述的是早已移除的侧边栏架构。任何新同学读它都会被带偏。

### 4. 单点故障风险（P0 隐患，未触发）
`app.js:259-261` 是 `bindEvents()` 的第一句，且**没有 null 保护**：

```js
document.getElementById("session-id-form").addEventListener("submit", ...)
```

`bindEvents()` 本身也没有 try/catch（`app.js:187`）。一旦 `session-id-form` 这个 id 被改掉，**整个绑定函数会在第一句抛错中断，全站按钮集体失效**。同理 `session_info.js`、`ui_table.js` 等也存在无保护访问。

---

## 三、根因：一个功能的定义被复制到 6 处

要新增/改名/删除一个功能，必须同时改对这些地方，漏一处就出现上面那类 bug：

| # | 位置 | 声明了什么 | 漏改的后果 |
|---|---|---|---|
| 1 | `src/index.html` `#section-N` | 卡片内容、`needs-connection`、`theme-*` | 点进去无反应 / 空白 |
| 2 | `src/rules/ui_layout.json` | 磁贴 id / step / label / icon / desc | 首页没入口 |
| 3 | `src/biz/ui_layout_default.js` | 上面这份磁贴的**手工同步副本** | 扩展目录读不到 JSON 时兜底与 JSON 不一致 |
| 4 | `src/biz/ui_layout.js:30` `CONNECTION_REQUIRED_STEPS` | 是否需连接（硬编码 Set） | 未连接时图标不锁 / 锁了不解 |
| 5 | `src/biz/ui.js:95` 白名单 + `:109-132` 懒加载 | 未连接可访问 + 何时加载数据 | 未连接被弹回 / 数据不加载 |
| 6 | `src/app.js` `bindEvents()` | 按元素 id 逐个绑事件 | 按钮点了没反应 |

第 3 处尤其典型：`rules/ui_layout.json`（102 行）与 `ui_layout_default.js`（123 行）内容逐行重复，只差 `favorites.ids`。

---

## 四、目标设计：一份清单派生一切

### 新增 `src/biz/features.js` —— 功能的唯一事实来源

```js
/** 每个功能只在这里声明一次；首页磁贴、详情页卡片、连接门禁、
 *  懒加载、事件绑定全部由本清单派生。 */
export const FEATURES = [
  {
    id: "lts-daily",
    step: 2,
    group: "lts",              // 归入哪个分组
    label: "获取当日数据",
    icon: "fa-calendar-day",   // 必须是 icons.js 里已映射的图标
    desc: "当日订单数据",
    theme: "lts",              // 对应 .theme-lts 的配色
    requiresConnection: true,  // 唯一门禁声明，不再有 Set / 白名单 / CSS 类三份
    module: () => import("./sections/lts_daily.js")  // 懒加载 + 渲染 + 绑定
  },
  // …
];

export const byStep  = new Map(FEATURES.map(f => [f.step, f]));
export const byId    = new Map(FEATURES.map(f => [f.id,   f]));
export const GROUPS  = [ /* 分组顺序与配色，仍可由 rules/ui_layout.json 覆盖 */ ];
```

### 各派生面如何由清单生成

| 现在的 6 处 | 改为 |
|---|---|
| 首页磁贴 | `renderLauncher()` 遍历 `FEATURES` 生成（顺序取自 `ui_layout.json`，缺项按清单补全） |
| 详情页卡片 | `ensureSectionHost(f)` 自动建 `<div id="section-N" class="step-section theme-x">`，再调 `f.module().mount(host)` |
| 连接门禁 | `f.requiresConnection` 一处判断，同时用于磁贴加 `.locked` 与 `showSection` 拦截 |
| 未连接白名单 | 同上，不再需要 `[1,6,20,21]` |
| 懒加载 | `showSection` 统一 `await f.module()`，删掉 7 个 `if (sectionNumber === N)` 分支 |
| 事件绑定 | 各功能模块在自己的 `mount(host)` 里用 `data-action` 事件委托（`ui_layout.js` 已验证此模式可行） |

### 收益

- **新增功能**：写 1 个模块文件 + 在 `FEATURES` 加 1 条记录。
- **删除功能**：删记录 + 删文件，首页不会残留死图标。
- **改标题/图标/主题/门禁**：只改清单里那一个字段。
- **`src/index.html` 可从 1680 行降到约 150 行**（只剩顶栏、两个容器、loading mask）。
- 元数据集中后，"查问题"只需看一张表；`check:ui` 作为 CI 断言防退化。

---

## 五、迁移路径（每步独立可验证、可回滚）

### Step 0 —— 已完成的（本次交付）
新增 `tools/check-ui.mjs` + `npm run check:ui`，把上文所有隐含规则显式成断言（磁贴↔section 双向、两份默认布局一致、门禁三处对齐、未连接白名单、图标映射、死引用、懒加载分支）。
**后续任何一步重构，都用它验证没有退化。**

### Step 1 —— 清理（零风险，不动结构）
1. 删掉 `biz/ui_config.js` 的 `submenuConfig` / `sectionToModule`（62 行死配置）。
2. 给 `bindEvents()` 加保护：引入 `const $ = id => document.getElementById(id)`，缺失时 `console.warn` 并跳过，不再整函数中断。
3. 补 3 个首页图标映射（`fa-file-import` / `fa-box-open` / `fa-satellite-dish`）或改用已有图标。
4. 修 / 删 16 处死引用。

### Step 2 —— 收敛元数据（1 天，`index.html` 不动）
建 `features.js`，先只承载元数据；把 `ui_layout.js` 的磁贴、`CONNECTION_REQUIRED_STEPS`、`ui.js` 的白名单与懒加载分支全改为从它读取。
此时耦合从"6 处"降到"1 处 + `index.html`"，风险大幅下降且可立即用 `check:ui` 验证行为等价。

### Step 3 —— 卡片外移（按功能分批，单个约 0.5h）
把 `index.html` 里的 `#section-N` 卡片逐个搬成 `sections/<id>.js`（`export function mount(host)`），搬一个删一段。**一次只搬一个**，`check:ui` 与手工点一遍即验证。建议从简单的开始（14 中午食乜 → 6 项目说明 → 23-26 Inspector 四件套）。

### Step 4 —— 绑定下沉（可选）
把 `app.js` 里 1300 行的 `bindEvents()` 按功能拆到各模块的 `mount()`；跨模块的全局交互（顶栏齿轮、Esc 返回）留在 `app.js`。

> **为什么不建议一次性重写**：`src/` 目录本身就能被 Chrome 直接「加载已解压的扩展程序」运行，且测试套件（jest 4 套件）当前是挂的，没有回归网。所以必须按 section 分批搬，每批用 `check:ui` + 手工点击验收。

---

## 六、查问题工具箱

```bash
npm run check:ui            # 人类可读报告，退出码 1 表示存在 ERROR
node tools/check-ui.mjs --json   # JSON 输出，供 CI / 编辑器消费
```

覆盖 8 类断言：

| 编号 | 断言 | 级别 |
|---|---|---|
| A | 每个磁贴指向的 `section-N` 必须存在 | ERROR |
| B | 每个 section 必须有入口（磁贴或设置页 `data-goto`） | ERROR |
| C | 两份默认布局磁贴集合一致；`favorites.ids` 不得引用不存在的 id | WARN / ERROR |
| D | `requiresConnection` / `needs-connection` / `CONNECTION_REQUIRED_STEPS` 三处对齐 | ERROR / WARN |
| E | 免连接功能必须出现在 `showSection` 未连接白名单 | ERROR |
| F | 用到的 `fa-*` 必须在 `IconMap` 中有映射 | ERROR（HTML/布局）· INFO（JS） |
| G | JS 引用的 id 必须存在于 HTML 或由 JS 动态创建 | WARN |
| H | 懒加载分支对应的 section 必须存在 | WARN |

规则参数（内部 section、已确认可忽略的 id）集中在脚本顶部，可随重构逐步收紧。

---

## 七、一句话总结

显示逻辑不需要重做，需要的是**把"一个功能是什么"从 6 份手抄副本收敛成 1 份声明**。
`features.js` 提供单一事实来源，`check-ui.mjs` 提供防退化的断言网，两者配合后：查问题看一张表，加功能改一条记录。

---

## 八、Step 1 执行记录（2026-09-24）

目标：清理死配置 / 死引用、补齐空白图标、给 `bindEvents` 加保护。**不改动任何功能行为。**

### 8.1 改动清单

| 文件 | 改动 |
|---|---|
| `src/common/dom.js` | **新增**。`$` / `$$` / `on` / `onAll` / `setVisible` / `getMissingTargets`；元素缺失时 warn 并跳过，绝不抛错 |
| `src/app.js` | 12 处跨行**无保护**的表单绑定改为 `on(...)`；全部 `document.getElementById("x")` 改为 `$("x")`（96 → 0）；删除 PCD 自定义日期的死代码（PCD 用的是 SOQL 输入框，从没有日期选择器）；`bindEvents()` 调用处加 try/catch 兜底 |
| `src/biz/ui.js` | import 只保留实际使用的 `DEFAULT_LUNCH_PLACES`；删除 10 处死引用对应的代码块（`session-status-badge` / `connection-badge` / `t2-analysis-badge` / `file-upload-success` / `order-count` / `user-session-id` / `user-current-step` / `user-daily-orders` / `user-pcd-daily-orders` / `user-report-records` / `user-t2-records` / `user-uploaded-orders`） |
| `src/biz/ui_config.js` | 136 行 → 22 行。删除 `submenuConfig`(62 行)、`sectionToModule`、`DEFAULT_STATS`、`DEFAULT_USER_INFO`、`BULK_JOBS_DISPLAY_FIELDS` —— 前两个描述已移除的侧边栏架构，后三个与 `state.js` 重复且无人引用 |
| `src/common/icons.js` | 新增 7 个 SVG（`play`/`stop`/`pause`/`plus`/`trash`/`arrowUp`/`arrowDown`）+ 22 条 `IconMap` 映射；删除重复定义的 `arrowLeft` 键 |
| `tools/check-ui.mjs` | 跳过注释行（注释里的示例代码不再被当作死引用）；新增「声明需要连接但三处都没门禁」检查 |

### 8.2 验证结果（同一份代码、只回退图标映射做严格对照）

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 首页磁贴数 | 23 | 23 |
| 磁贴内渲染出的 SVG 图标 | 20 | **23** |
| 磁贴内残留 `<i>`（空白方块） | **3** （`fa-file-import` / `fa-box-open` / `fa-satellite-dish`） | **0** |
| 全站未替换图标数 | 27 | **0** |
| `check:ui` ERROR | 17 | **0** |
| 运行时 JS 报错 | 0 | 0 |

验证方式：`src/` 副本 + `chrome.*` shim，用无头 Chrome `--dump-dom` 抓渲染结果，覆盖 `未连接` / `已连接` / `Sandbox` 三个场景；已连接场景下 `已连接` 徽标、`Production` 环境标签、用户姓名均正确渲染。webpack 生产构建通过。

> 已知非问题：已连接场景会有一条 `unhandledrejection: Failed to fetch` —— 这是 `validateStoredSession()` 访问不存在的预览 org 导致，`app.js` 已按设计容忍（不降级连接状态）。git HEAD 版本同样存在，非本次改动引入。

### 8.3 待决策（1 处，自检持续提示）

**「中午食乜」(step 14)** 声明 `requiresConnection: true`，但它既不在 `CONNECTION_REQUIRED_STEPS` 里、section 也没有 `needs-connection` 类、也不在 `showSection` 的未连接白名单里。
结果：未连接时图标**不显示锁定**（看着能点），点进去却被 `showSection` 弹回「连接设置」——用户看到的是"能点但没反应"。

该功能是纯本地的午餐抽签（只需要上传一个 Excel），`initLunch()` 在 `initApp()` 里也无条件执行，因此**建议按"免连接"处理**：

- `rules/ui_layout.json` + `ui_layout_default.js`：`lunch` 的 `requiresConnection` 改为 `false`
- `biz/ui.js`：未连接白名单 `[1, 6, 20, 21]` 改为 `[1, 6, 14, 20, 21]`

这是行为变更（会让未连接用户也能用午餐抽签），故留待确认后再改。
