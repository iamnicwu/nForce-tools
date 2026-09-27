# nForce-tools UI 设计审计：字体一致性 & 报错一致性

> 审计范围：`src/` 全部 49 个 `.js/.css/.html` 文件（已排除 `.history/` 快照目录）
> 审计时间：2026-09-24
> 方法：① 源码静态正则统计；② headless Chrome 实测 `getComputedStyle`（`?audit=1`）
> 结论一句话：**字体不统一（3 套页面各自为政，源码 44 种字号 / 10 种字族 / 5 种等宽栈）；报错提示也不统一（4 条并存通道 + 5 套并列配色）。两者都是"能跑但不一致"，暂时不产生功能性 Bug，但已经在制造真实的视觉与维护成本。**

---

## 0. 结论摘要

| 维度 | 现状 | 判定 | 风险 |
|---|---|---|---|
| 字族 font-family | 3 个页面 3 套声明；缺一个统一基座（`main.css` 的 `body` **完全没写** font-family） | ❌ 不统一 | 中 |
| 等宽字族 | 5 种不同写法表达同一件事 | ❌ 不统一 | 低 |
| 字号 font-size | 源码 **44 种**（含 `7px/9px/85%/1.16666667em`）；实测 index 页面 **14 种** | ❌ 严重不统一 | 中 |
| 字重 font-weight | `main.css` 用 **600** 表强调，`index.html` 内联用 **500** 表强调 —— 主次颠倒 | ❌ 不统一 | 中 |
| 行高 line-height | 实测 index 页面 **20 种** | ❌ 不统一 | 低 |
| 颜色 | **1542** 处硬编码 hex vs **332** 处 `var(--)`；同一语义 7 种灰色 / 7 种蓝 | ❌ 严重不统一 | 中 |
| 提示通道 | 5 条并存（toast / log 面板 / console.log / console.error / console.warn） | ⚠️ 不一致 | 中 |
| 通知组件 | `ant-alert` 动态版 与 `.notification.error` 静态版 **两套样式**，配色不同 | ⚠️ 不一致 | 中 |
| `showNotification` 类型 | `error 85 / success 35 / warning 34 / info 5 / 默认 22 / 表达式 9`，22 处**默认走绿色 success** | ⚠️ 脆弱 | 中 |
| 图标体系 | **5 套**：共享 `icons.js` SVG / login 的 FontAwesome CDN / popup 手写内联 map | ❌ 严重不统一 | 高（CDN 依赖） |
| 版本号 | 三处不一致：`manifest 3.3.0` / `package.json 3.2.0` / `popup.html v1.0` | ❌ 不一致 | 低 |
| 内联样式 | **374** 处 `style="..."`（index.html 296 处）绕过所有类体系 | ❌ 严重不统一 | 中 |
| 原生弹窗 | `alert()` 0 次、`confirm()` 0 次 ✅ | ✅ 好 | — |

**总体判断：UI 的可维护性瓶颈不在"逻辑复杂"，而在"同一个视觉决策被独立决定了多次"。** 这与 Step 1 里发现的"一个功能的定义散落在 6 个文件"是同一类问题，只是这次发生在样式层。

---

## 1. 字体是否统一？——**否**

### 1.1 字族：三个页面，三套声明，一个缺失的基座

| 页面 | 引用的样式表 | 生效的页面级 font-family | 来源 |
|---|---|---|---|
| `index.html` | `lib/css/antd.min.css` + `lib/css/main.css` | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, **"Noto Sans"**, sans-serif` | **antd.min.css** 的 `body` |
| `login.html` | **`https://cdnjs.cloudflare.com/.../font-awesome/6.4.0/css/all.min.css`** | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`（**少了 `"Noto Sans"`**） | 自己的内联 `<style>` L19 |
| `popup.html` | `lib/css/antd.min.css` | `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`（**少了 `"Noto Sans"`**） | 自己的内联 `<style>` L28 |

**关键发现：`main.css` 里没有给 `body` 设 `font-family`。** 原文注释写得很直白：

```css
/* src/lib/css/main.css:55-58 */
/* 基础样式重置 - 移除与 Ant Design 冲突的部分 */
body {
    background-color: var(--bg-secondary);
    /* font-family 由 Ant Design 接管 */
}
```

这是一个**隐式契约**：整个主应用（3000+ 行 `main.css`）的字体基座被外包给了第三方 `antd.min.css`。后果有两个：

1. 升级 antd 或换掉 antd，全站字体静默改变，没人会想到要去看那个注释；
2. 想统一字号／字重时，没有"一处改全站"的落点。

另外 `main.css` 内部还有一处**与基座不一致**的回归：
- `antd` 基座含 `"Noto Sans"`；
- `main.css:856` 的 `.markdown-body` 自己写了一遍 `-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif` —— **漏了 `"Noto Sans"`**。

于是同一页里，普通段落走 antd 字族，Markdown 渲染的段落走另一条字族（仅当系统装了 Noto Sans 时才看得出差异，所以肉眼很难发现）。

### 1.2 login.html 的表单控件回退到 Arial（真实可复现）

`login.html` 只加载了 FontAwesome CDN，**没有加载 antd，也没有加载 main.css**。它只给 `body` 设了字族，没给表单控件设。

实测结果（headless Chrome `getComputedStyle`）：

```
index.html : button → -apple-system,…, 13px/12px/14px/16px ;  input → -apple-system, 14px/13px
login.html : button → Arial 16px | Arial 14px             ;  input → Arial 14px     ← 不继承页面字体
popup.html : button → -apple-system,… 16px
```

`login.html` 上所有 `<button>` / `<input>` 计算出的字族都是 **`Arial`**（表单控件默认 `font: 400 13.333px Arial`，且未写 `font-family: inherit`）。所以登录页里"标题是系统字体、按钮是 Arial"——两个地方的字母形状肉眼可辨。

### 1.3 等宽字族：同一件事，5 种写法

```
main.css:827   'Monaco', 'Menlo', 'Ubuntu Mono', monospace
main.css:905   ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace
main.css:1815  'Consolas', 'Monaco', monospace
main.css:1979  'Consolas', 'Monaco', monospace          （重复第 3 种）
index.html:561 style="… font-family: monospace; …"       （裸 monospace）
index.html:1116 style="font-family: monospace; …"
index.html:1298 style="… font-family: 'Consolas', 'Monaco', monospace; …"
ui.js:2168     <div style="font-family: monospace; font-size: 12px; …">
antd.min.css   SFMono-Regular, Consolas, Liberation Mono, Menlo, Courier, monospace
```

同一个"我要等宽字体"的意图，被写成了 **5 种不同优先级链**。其中 `monospace`（裸写）依赖浏览器默认等宽字体，在 macOS 上会落到 `Courier`——和 `main.css` 里刻意挑选的 `Monaco/Consolas` 完全不是同一款。所以 Bulk Job 状态框、SOQL 结果框、Anonymous 结果框**三处等宽文本的字体其实互不相同**。

### 1.4 字号：源码 44 种，实测 14 种

源码层面统计到的全部 `font-size` 取值（44 种，按出现频次排序）：

```
14px×167  12px×67  16px×60  13px×39  0.875rem×23  24px×20  48px×10  1.25rem×10
10px×10   18px×9   0.9em×7  1rem×7   0×7          11px×4    32px×4   inherit×4
20px×4    2rem×3   0.75rem×3 15px×3  1em×3        26px×3    3rem×2   28px×2
85%×2     30px×2   1.1rem×1 0.85em×1 1.875rem×1   1.125rem×1 1.5rem×1 100%×1
21px×1    12.5px×1 80%×1    75%×1    1.5em×1      7px×1     22px×1   1.16666667em×1
72px×1    9px×1    38px×1   90%×1
```

问题点：

1. **单位体系混乱**：`px` 与 `rem` / `em` / `%` 混用。`14px`（167 次）和 `0.875rem`（23 次）在默认 16px 根字号下**完全等价**，却写成两种形式。同理 `12px` vs `0.75rem`、`16px` vs `1rem`。
2. **相对单位事故**：`1.16666667em`、`0.9em`、`0.85em`、`85%`、`75%`、`80%`、`90%` —— 这些会**随父元素字号浮动**。实测 index 页面出现的 `12.6px`（12 × 0.9 × 1.1666…?）、`16.38px`、`11.9px`、`17.6px` 就是这类复合计算的产物。**没有任何设计系统会产生 16.38px 这个值。**
3. **等价但不同源的像素级碎片**：`11px / 10px / 9px / 7px / 12.5px / 21px / 26px / 28px / 38px / 72px` —— 十个只用 1–2 次的尺寸，说明是逐个"看着调"出来的。
4. **`0` 被当成 font-size 写了 7 次**（合法但可疑，通常是隐藏文本的手法，应该用 `display:none` 或 `sr-only` 类）。

实测（真实渲染后 `getComputedStyle` 去重）index 页面 **440 个含文本元素**上共出现 **14 种计算字号**：

```
14px×235  12px×68  16px×57  15px×24  20px×20  13px×19
12.6px×7  21px×2   16.38px×2  11px×2  17.6px×1  12.5px×1  11.9px×1  18px×1
```

`12.6px / 16.38px / 11.9px / 17.6px` 这 4 种一共只有 11 个元素，纯属相对单位溢出，**应全部归一化**。真正有设计意图的其实只有 5 档：`12 / 13 / 14 / 16 / 20`（+ 标题级 `24 / 32 / 48`）。

### 1.5 字重：主次颠倒（同一件事两种表达）

按文件拆分统计 `font-weight`：

```
src/lib/css/main.css  →  600×25  500×4   700×2      ← 用 600 表强调
src/index.html（内联）→  500×30  600×1              ← 用 500 表强调
```

**同一个项目里，"加粗强调"这件事在样式表里是 600、在页面内联块里是 500。** 由于 `index.html` 的内联 `<style>` 通常排在 `main.css` 之后（同优先级下后者胜出），**页面内联块里的元素实际上会把 600 降成 500**。这就是"有些标题看着比另一些轻"的机械原因，而不是谁手滑写错了某一行。

实测 index 页面共 4 种计算字重：`400×248 / 600×85 / 500×79 / 700×28`。

### 1.6 行高：实测 20 种

源码 `main.css` 8 种 + `index.html` 1 种 + `antd` 40 种，叠加后实测 index 页面 **20 种**计算行高。`main.css` 里自己也有 `1.6 / 1.5 / 1.7 / 1.5715 / 1.25 / 1 / 22px / 20px` 八种并存 —— 其中 `1.5715`（从 antd 抄来的固定值）与 `1.6`（自己定的）是同一个意图的两种写法。

---

## 2. 显示报错是否一致？——**否**

### 2.1 五条并存的通知通道，选择无规则

```
console.log        228 次    ← 开发调试，混着真实失败信息
showNotification   190 次    ← 唯一面向用户的 toast
console.error      147 次    ← 同时承担"记录"和"实际告知"两种职责
loadingLog          32 次    ← 页面内日志面板
console.warn        30 次
alert() / confirm()  0 次  ✅
```

**问题在于"哪条通道"没有可推导的规则**。同一个 `excel_utils.js` 文件内部就不一致：

```js
// src/common/excel_utils.js:54-59   三种一起上
if (!file.name.endsWith(".xlsx")) {
  console.error("文件格式不正确，请上传Excel文件(.xlsx)");
  showNotification("请上传Excel文件(.xlsx)", "error");
  loadingLog("文件格式不正确，请上传Excel文件(.xlsx)", "error");
  ...
}

// src/common/excel_utils.js:228-232   同级别的失败，只给了 log 面板，没给 toast
} else {
  console.log("Excel文件中没有数据行");
  loadingLog("Excel文件中没有数据行", "warning");
  if (onError) onError("Excel文件中没有数据行");   // ← 用户界面上什么都不弹
}
```

用户侧表现：上传一个空的 xlsx，**界面上不会有任何 toast**，只有那个默认折叠的日志面板里多一行黄字。而上传一个 `.xls`，会连弹三个通道。这两个都是"文件不合格"，体验却不同。

### 2.2 `showNotification` 内部：英文标题 + 中文正文

`src/common/utils.js:79-85` 把通知标题写死成**类型名的英文首字母大写**：

```js
const messageDiv = document.createElement('div');
messageDiv.className = 'ant-alert-message';
messageDiv.textContent = type.charAt(0).toUpperCase() + type.slice(1);   // "Success" / "Error" / "Warning" / "Info"
```

而 `description` 才是真正的中文消息（`已自动连接到Salesforce` / `获取当日数据失败…`）。所以**每一条通知都是「Error / 获取当日数据失败」这种中英混排**。全站 190 处通知，190 次这个混排。

### 2.3 22 处调用不传 type，默认静默变成绿色 success

`showNotification(message, type = "success")` —— 默认值是 **success**（`utils.js:17`）。

统计（仅 `src/`，括号平衡 + 字符串掩码精确解析）：

```
"error"      85
"success"    35
"warning"    34
<默认→success> 22      ← 这 22 处
<表达式>       9
"info"        5
```

那 22 处清单（好消息：**逐条核对过，全部确实是成功语义，目前没有可见 Bug**）：

```
src/biz/logic.js:118,145,421,423,488,561,654,729,801,870,1084,1155,1217,1281,1407   (15)
src/biz/ui_layout.js:300,493,510,521                                                (4)
src/app.js:274,324                                                                  (2)
src/biz/session_info.js:40                                                          (1)
```

**为什么仍然算问题：**

1. **语义靠默认值兜底**，谁把 `type` 默认值改成 `"info"` 或 `"error"`，22 条成功提示会集体变色，而代码里没有任何提示；
2. **同一个文件里两种写法并存**。`session_info.js` 内部：
   ```js
   // L40 —— 隐式
   showNotification("已复制到剪贴板");
   // L54 —— 显式
   showNotification(ok ? "已复制到剪贴板" : "复制失败，请手动选中复制", ok ? "success" : "error");
   ```
   同一个功能两次实现，一次隐式一次显式；
3. **新增功能时容易漏**：开发者看见 `showNotification("...")` 能跑、是绿的，就不会去查默认值。一旦某天写了 `showNotification("保存失败")` 而忘了传 type，用户会收到一条**绿色的"保存失败"**。

### 2.4 同一个"错误"，5 套并列配色

| 出现位置 | 选择器 | 背景 | 文字 | 边框 | 风格来源 |
|---|---|---|---|---|---|
| 动态 toast（`showNotification`） | `.ant-alert-error` | antd `#fff2f0` 系 | antd | antd | **Ant Design** |
| 连接错误横幅（`index.html:176`） | `.notification.error` | **`#fee2e2`** | **`#991b1b`** | `var(--error-color)` | **Tailwind** |
| 日志面板 | `.log-entry.error` | 无 | **`#ff4d4f`** | 无 | 硬编码（**且该规则在 main.css 里重复定义 2 次**） |
| 登录页 | `.error-msg` | 无 | `#ff4d4f` | 无 | **仅存在于 login.html 内联，main.css 里 0 处** |
| 流程图兜底 | `.flowchart-error`（`ui.js:1904`） | 自有 | 自有 | 自有 | 单点专用 |

其中最关键的一处：`index.html:176` 的

```html
<div id="connection-error" class="notification error" style="display: none;">
```

用的是**走 Tailwind 色板的静态横幅**，而所有其他错误都走 **antd 色板的动态 toast**。于是"没连上 Salesforce"这个**最高频的错误**，恰恰是唯一一个长得跟别人都不一样的 —— 红得不一样（`#991b1b` vs `#ff4d4f`/antd 红），位置不一样（页面内嵌 vs 顶部居中浮层），关闭方式不一样（固定展示 vs 3 秒自动消失）。

顺带一个死代码：`main.css:321-368` 同时定义了 `.notification, .ant-alert { ... }` 和 `.notification.success / .error / .icon / .content / .close-btn`。但 `showNotification` 只生成 `.ant-alert*` 类。**`.notification.*` 这一半（约 5 条规则）除了 `#connection-error` 之外没有任何生产者**，属于典型的"改了 CSS 但没人用"。

### 2.5 图标体系 5 套（这是最该修的一条）

| # | 位置 | 机制 | 是否需要网络 |
|---|---|---|---|
| 1 | `src/common/icons.js` + `replaceIcons()` | 内联 SVG，`IconMap` 映射 `fa-*` | 否 ✅ |
| 2 | `src/login.html` | **cndjs FontAwesome 6.4.0 CDN**，`<i>` 计算为 `font-family: "Font Awesome 6 Free"` | **是 ⚠️** |
| 3 | `src/popup.html` | **手写内联 iconMap**（另一份实现） | 否 |
| 4 | `src/lib/css/antd.min.css` | antd 自带 `anticon` 字体 | 否（本地） |
| 5 | `index.html` 遗留 `<i class="fa-*">` | 由 #1 兜底替换 | 否 |

- `login.html` 实测有 **7 个未替换的 `<i>`**，它们靠 CDN 字体渲染。其余 3 个页面全部走内联 SVG。**只有登录页在扩展里发起外部网络请求**——虽然 `content_security_policy` 只约束 `script-src`（CSS 不受限）所以能工作，但它意味着：断网 / CDN 被墙 / CDN 下线时，**用户唯一能进系统的入口页会显示 7 个方框**。
- `popup.html` 有自己一份手写的 icon map，与 `icons.js` 完全独立。改 `icons.js` 不会影响 popup。

### 2.6 `popup.html` 是一整个平行世界

```css
/* src/popup.html 内联 */
:root {
    --primary-color: #4f46e5;   /* indigo */
    --primary-hover: #4338ca;
    --bg-color:      #f9fafb;   /* Tailwind gray-50 */
    --text-primary:  #1f2937;   /* Tailwind gray-800 */
    --text-secondary:#6b7280;   /* Tailwind gray-500 */
}
```

而 `main.css:2-21` 是：

```css
:root {
    --primary-color: #1890ff;   /* Ant Design blue */
    --primary-hover: #40a9ff;
    --bg-secondary:  #edf1f7;
    --text-primary:  rgba(0, 0, 0, 0.85);
    --text-secondary:rgba(0, 0, 0, 0.45);
}
```

`popup.html` **同时加载了 `antd.min.css` 又用 Tailwind 色板覆盖主色**，等于把两套设计系统叠在一起。而且它**没有加载 `main.css`**，所以同一套 `--primary-color` 变量名在两个页面里指向两种蓝（`#4f46e5` vs `#1890ff`）。工具栏弹窗和主界面放在一起看，是两个产品的观感。

### 2.7 374 处内联样式绕过所有类体系

```
总计 374 处 style="...":
  src/index.html              296
  src/biz/inspector_tools.js   37
  src/biz/ui.js                26
  src/login.html                4
  src/biz/ui_layout.js          2
  src/popup.html                1
  src/app.js                    1
  src/biz/logic.js              1
```

`index.html` 的 296 处里大量是 `style="margin-bottom: 1rem; font-size: 0.875rem; color: #8c8c8c;"` 这类三连。**任何"全局统一字体/颜色"的改动，对这 296 处都无效**——这是字号 44 种、颜色 1542 处硬编码的直接来源。

### 2.8 颜色：1542 处硬编码 vs 332 处变量

```
硬编码 hex 出现总次数：1542
var(--)  使用次数：   332
```

同一语义的多种写法（仅 `src/`，全量统计）：

```
次要灰文字：  #8c8c8c×29  #666×9  #999×5  #9ca3af×1  #6b7280×1  #888  #999999
深色文字：    #333×15  #262626×3  #1f2937×3  #333333×1
浅灰边框：    #d9d9d9×143  #f0f0f0×94  #e8e8e8×10  #ddd  #e5e7eb  #d1d5db
浅灰背景：    #f5f5f5×82  #fafafa×39  #f7f7f7  #f9fafb  #f0f0f2
主色蓝：      #1890ff×176  #40a9ff×81  #096dd9×37  #2f54eb×18  #1677ff  #4096ff  #4f46e5
```

注意 `--text-secondary: rgba(0,0,0,0.45)` ≈ `#8c8c8c` —— 也就是说 `#8c8c8c` 出现 29 次的地方，**本来就应该写 `var(--text-secondary)`**。同理 `--border-color: #d9d9d9` 被硬编码了 143 次。

`main.css` 只定义了 **5 个语义色变量**（primary / success / error / warning + 3 档文字色），但源码里用到 **7 种蓝、7 种灰、6 种边框灰**。变量体系存在，只是没被当作唯一入口使用。

### 2.9 版本号三处不一致

```
src/manifest.json   → 3.3.0
package.json        → 3.2.0
src/popup.html:88   → v1.0      ← 界面上显示给用户看的
```

---

## 3. 修复建议（按性价比排序）

### P0 — 低成本、立刻见效、零行为变化

| # | 动作 | 落点 | 收益 |
|---|---|---|---|
| 1 | 给 `main.css` 的 `body` 补上显式 `font-family`（含 `"Noto Sans"`），不再"由 antd 接管" | `main.css:56` | 字体基座从隐式契约变显式，全站一个落点 |
| 2 | `.markdown-body` 的字族改为 `font-family: inherit` | `main.css:856` | 消除与基座的那一处不一致 |
| 3 | `login.html` 补 `button, input, textarea { font-family: inherit; }` | `login.html` 内联 | 消除 Arial 回退 |
| 4 | 22 处 `showNotification(...)` 补上显式 `"success"` | 4 个文件（清单见 §2.3） | 消除对默认值的隐式依赖 |
| 5 | `showNotification` 的标题改为中文（`成功/错误/警告/提示`），或直接去掉标题只留正文 | `utils.js:81` | 190 处通知去掉中英混排 |
| 6 | 给 `.log-entry.error` 补 `var(--error-color)` 并删掉重复规则 | `main.css` | 消除重复定义 |
| 7 | `popup.html` 的版本号改为从 `manifest.json` 读，或手动同步 | `popup.html:88` | 消除三处版本不一致 |

### P1 — 建立单一来源（与 `plans/ui_architecture_review.md` 的 Step 2 同一思路）

| # | 动作 | 说明 |
|---|---|---|
| 8 | 在 `:root` 里补齐**语义色 + 字号刻度 + 等宽字族**变量 | 例如 `--fs-xs/sm/base/lg/xl` = 12/13/14/16/20、`--font-mono`、`--text-tertiary`、`--border-light` |
| 9 | 把 374 处内联 `style` 中的**字体/颜色**类属性迁到工具类或语义类 | 优先 `index.html` 的 296 处；可先只处理重复度最高的三连 `margin+font-size+color` |
| 10 | `login.html` 去掉 FontAwesome CDN，复用 `common/icons.js` 的内联 SVG | 与 Step 1 已完成的"全站 0 个未映射图标"成果对齐，同时消除外部依赖 |
| 11 | `popup.html` 删掉自己的 `:root` 与内联 iconMap，改为复用共享 `:root` + `icons.js` | 消除第 5 套图标体系与第 2 套配色 |
| 12 | 统一错误呈现：把 `#connection-error` 改为走 `showNotification(..., "error")`，删除 `.notification.*` 死规则 | 让"没连上"这个最高频错误和其他错误长得一样 |
| 13 | 把归一化后的字号写入 `tools/check-ui.mjs` 新增检查项：禁止 `font-size` 出现约定刻度以外的值 | 已有诊断工具可以直接扩展，防止回退 |

### P2 — 需要设计决策

| # | 动作 | 说明 |
|---|---|---|
| 14 | 选定唯一设计系统 | antd 还是 Tailwind。目前 `popup` 是 Tailwind，其余是 antd；建议全站 antd（`#1890ff`），把 `popup` 的 indigo 改掉 |
| 15 | 定义字号刻度表（Type Scale） | 建议 5 档正文 + 3 档标题，砍掉 44 种取值 |
| 16 | 定义字重规则 | 建议只保留 `400 / 500 / 600`，并明确"页面内联块不得覆盖字重"，修正 §1.5 的主次颠倒 |
| 17 | 定义"什么时候用 toast、什么时候用 log 面板、什么时候必须两个都用" | 修掉 `excel_utils.js` 里同类失败不同通道的问题 |
| 18 | 补 `.error-msg` 等页面私有类到 `main.css`，或反过来删掉 | 消除"类只在某一个页面存在"的情况 |

---

## 3.5 执行结果（P0 7 项 + P1 6 项已全部完成）

> 完成时间：2026-09-24 · 验证：`npm run check:ui` ERROR 0 / WARN 2 · webpack 生产构建通过 · 三个页面 headless 实测

### P0 —— 全部完成，零行为变化

| # | 动作 | 结果 |
|---|---|---|
| 1 | `main.css` 的 `body` 补显式 `font-family: var(--font-sans)` | ✅ 基座不再外包给 antd，注释「由 Ant Design 接管」已删除 |
| 2 | `.markdown-body` → `font-family: inherit` | ✅ |
| 3 | 表单控件继承字族 | ✅ 改为在 `main.css` 统一声明 `button, input, select, textarea, optgroup { font-family: inherit }`（比写在 login.html 内联覆盖面更广）。实测 login 的 `button/input` 已从 **Arial** 变为共享字族 |
| 4 | 22 处 `showNotification` 补显式 `"success"` | ✅ 全部 190 处调用现在都显式传 type，且已加守卫禁止回退 |
| 5 | 通知标题中文化 | ✅ `utils.js` 新增 `TYPE_LABELS = {success:成功, error:错误, warning:警告, info:提示}`，标题与 `aria-label` 都用它 |
| 6 | `.log-entry.*` 改用语义令牌 | ✅ **原报告"重复定义"是误报**（我的脚本 `[^{]*` 过匹配导致同一条规则被报两次），实际只定义一次。色值已换成 `var(--success-color)` 等 |
| 7 | 版本号统一 | ✅ `package.json` 3.2.0 → **3.3.0** 对齐 manifest；`popup.html` 与 `login.html` 改为运行时读 `chrome.runtime.getManifest().version`（原先写死 `v1.0` / `v3.0`） |

### P1 —— 全部完成

| # | 动作 | 结果 |
|---|---|---|
| 8 | `:root` 补齐语义色 + 字号刻度 + 等宽字族 | ✅ `:root` 扩成完整令牌表：5 组语义色、8 档字号（`--fs-xs`~`--fs-4xl`）、5 档图标尺寸（`--icon-sm`~`--icon-2xl`）、`--font-mono`、`--accent-*` 调色板、品牌/代码色。**顺带发现 `--bg-tertiary` 被引用但从未定义**（一个静默失效的 CSS 变量），已补上 |
| 9 | 内联样式里的字体/颜色收敛 | ✅ 硬编码 hex **1542 → 19 处 / 3 种**（`#fff`×17 + 2 个 ECharts canvas 色，后者 `var()` 在 canvas 里不生效必须字面量）。`font-size` 收敛为 208 处 / 14 种，除 `85%`/`100%`（markdown 代码块的相对字号）外**全部走令牌**。做法见 `tools/migrate-style-tokens.py` |
| 10 | login.html 去掉 FontAwesome CDN | ✅ 删掉扩展里唯一的外部网络依赖，改用共享 `common/icons.js`。实测「含 CDN 的样式表 = 无」 |
| 11 | popup.html 复用共享令牌 | ✅ 删掉自己的 indigo `:root` 与手写 iconMap。**第 2 套配色与第 5 套图标体系一并消除** |
| 12 | 统一错误呈现 | ✅ `.ant-alert`（动态 toast）与 `.notification`（静态内嵌）在 CSS 里正式拆成两个基类；`.notification.error` 从 Tailwind 色板（`#fee2e2`/`#991b1b`）改为 antd 语义令牌；删掉死规则 `.notification.success` 与 `.notification .close-btn`。顺带收敛了第 6 套成功样式 `.success-message`（Tailwind `#d1fae5`/`#065f46`） |
| 13 | 把刻度写入 `check-ui.mjs` | ✅ 新增 **I. 样式守卫**（字号必须在刻度内 / 不得新增硬编码色 / 通知必须显式传 type / 白名单色不得超标）+ **J. 页面资源可达性**（见下） |

### 意外收获：修掉一个我自己引入的真实回归

P1-10 / P1-11 把 login/popup 改成 `import { replaceIcons } from "./common/icons.js"` 后，`src/` 直接加载一切正常，但**构建产物 `dist/` 里根本没有 `common/` 目录** —— `icons.js` 既不是 webpack 入口，也不在 `CopyPlugin` 的复制列表里。

后果：`dist` 下这个 import 404 → `replaceIcons()` 从不执行 → **登录页 7 个图标、弹窗 2 个图标全部退化成空白方块**。headless 实测坐实：

```
修复前： dist-login 全站未替换 = 7   dist-popup 全站未替换 = 2
修复后： dist-login 全站未替换 = 0   dist-popup 全站未替换 = 0
```

修法是给 `webpack.config.js` 的 `CopyWebpackPlugin` 补一条 `src/common/icons.js → common/icons.js`，并用 `info: { minimized: true }` 让 webpack 跳过 Terser（否则复制过去的文件会被顺手压一遍，28.6KB → 24.6KB，虽然仍是合法 ESM 但"复制"就该逐字节一致）。

**这个教训值得记住：HTML 里写一个相对路径很容易，但"这个路径在 dist/ 里到底存不存在"取决于 webpack 配置，两者相隔很远。** 所以新增了 **J. 页面资源可达性** 检查，交叉比对三份信息：HTML/manifest 里的引用 × 文件是否真实存在 × 是否被 webpack 入口或 CopyPlugin 覆盖。负向测试确认它能精准命中上面这个 bug。

### 收敛后的实测数字（headless Chrome `getComputedStyle`）

| 页面 | 字族种数 | 字号种数 | 外部 CDN | 未替换图标 | 表单控件字体 |
|---|---|---|---|---|---|
| `index.html` | **4 → 3**（437/440 在统一字栈上，其余 3 个是日志/代码区的等宽栈） | **14 → 8** | 0 | 0 | 全部继承（仅代码 textarea 用等宽，属有意） |
| `login.html` | **4 → 1** | 44 → 6 | 0 | 0 | **Arial → 共享字栈** |
| `popup.html` | **1**（原本是独立一套） | 4 | 0 | 0 | 继承 |

### 仍未处理（留给 P2，`line-height` 与设计决策）

- `line-height` 实测仍有 16 种 —— 这是**继承**的必然结果（字号还是 8 种，行高会等比派生）。要收敛得先定义行高规则，属 §3 P2-15/16 的设计决策范围。
- 内联 `#fff` 17 处**有意保留**：白色没有语义等价的令牌（`--text-inverse` 的语义是"深色底上的字"，拿来当背景在换主题时会错），写死反而更诚实。
- `src/icons/logo_generator.html` 是独立开发工具页，自带 `<style>`、不加载 `main.css`，已从守卫中排除。
- manifest 的 `web_accessible_resources` 里有 **4 个死条目**（`display_data.html`、`lib/js/mermaid.min.js` 全项目无人引用；`README.md`/`LTS_Fallout_Summary.md` 实际在 `docs/` 下）。Chrome 会静默忽略，不影响功能，因此 `check-ui.mjs` 将其报为 **WARN 而非 ERROR**。是否清理待定 —— 改这里会动到扩展的对外可访问面。

---

## 4. 与 Step 1 的关系

Step 1 修的是**功能性一致**（图标不再空白、死引用清零、`bindEvents` 不再单点崩溃），已完成、ERROR 17 → 0。

本次审计发现的是**同一层问题的样式面**：
- Step 1 是"一个功能的定义散落在 6 个文件"；
- 本次是"一个视觉决策被独立决定了 N 次"（字号 44 次、灰色 7 次、等宽 5 次、错误配色 5 次、图标 5 次）。

两者的**解法是同构的**：把散落的决策收拢成一份可执行的清单。
- Step 1 的解法是 `tools/check-ui.mjs`（把 6 文件耦合变成断言）；
- 本次的解法是 `:root` 变量刻度表 + 在 `check-ui.mjs` 里加"字号/颜色必须在刻度内"的检查项。

建议把 §3 的 **P0 七项**当作 Step 1.5：它们全部是零行为变化、可独立验证的（每一项都能用 `?audit=1` 的 computed style 输出前后对比）。

---

## 5. 复现命令

**源码静态统计**（用 python，macOS 自带 grep 不支持 `\s`）：

```bash
# 字号 / 字族 / 颜色统计
cd /Users/nickwu/Downloads/repo/nForce-tools
/opt/homebrew/opt/python@3.13/libexec/bin/python3 - <<'PY'
import re,os,collections
files=[]
for dp,dn,fn in os.walk("src"):
    if ".history" in dp: continue
    for f in fn:
        if f.endswith((".js",".css",".html")): files.append(os.path.join(dp,f))
fs=collections.Counter(); ff=collections.Counter(); hexes=collections.Counter(); varc=0
for p in files:
    s=open(p,encoding="utf-8",errors="ignore").read()
    varc += len(re.findall(r"var\(--",s))
    for m in re.findall(r"font-size\s*:\s*([^;}\"']+)",s): fs[m.strip()]+=1
    for m in re.findall(r"font-family\s*:\s*([^;}\"']+)",s): ff[m.strip()]+=1
    for h in re.findall(r"#[0-9a-fA-F]{3,8}\b",s): hexes[h.lower()]+=1
print("font-size 种数:",len(fs)); print("font-family 种数:",len(ff))
print("硬编码 hex:",sum(hexes.values()),"| var(--):",varc)
PY
```

**真实渲染实测**（复用 Step 1 建立的 skill）：

```bash
# 需要 .workbuddy/skills/nforce-ui-verify/ 里的 serve.py + prepare.py + shim.js
python3 serve.py &                      # 正确 MIME 的静态服务，端口 8765
python3 prepare.py                      # 复制 dist/ 与 src/ 两份副本 + 注入 chrome.* shim
# 用 headless Chrome 打开 ?audit=1，抓取页面内的 getComputedStyle 报告
```

`shim.js` 中 `styleAudit()`（`?audit=1` 触发）会输出：
- 页面加载的样式表清单
- 所有含文本元素的 `font-family / font-size / font-weight / line-height` 去重计数
- 表单控件（button/input/textarea）的计算字体
- 未替换的 `<i class="fa-*">` 清单

---

## 6. 一句话总结

**字体不统一、报错不一致，都不是"某个地方写错了"，而是"同一个决定被重复做了很多次"。** Step 1 已经把功能定义收拢成 `check-ui.mjs`；下一步该做的是把视觉决策收拢成 `:root` 刻度表，并把刻度约束也写进那个检查工具里。
