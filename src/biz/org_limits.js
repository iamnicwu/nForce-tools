/**
 * Org Dashboard（首页面板 + section-27 详情页）
 *
 * 通过 REST Limits API（GET /services/data/vXX.X/limits/）展示当前 Salesforce Org
 * 各项限额的用量，让用户一眼看清系统状态：
 *   - 功能中心首页：顶部的「Org 状态」面板（#org-dashboard-panel），
 *     直接展示 4 个关键指标摘要卡，不再占用功能磁贴位；
 *     点「查看全部」进入 section-27 详情页
 *   - section-27 详情页：顶部汇总卡片 + 全量列表（含搜索过滤），
 *     进度条按用量着色 <60% 正常（success）、60~85% 警告（warning）、≥85% 危险（error）
 *
 * 数据在模块内缓存（含抓取时间）：首页面板与详情页共享同一份缓存，
 * 首页渲染时缓存超过 2 分钟才后台静默重拉；详情页进入时同理；
 * 「刷新」按钮始终强制重新拉取。
 *
 * 时序约束（重要）：Limits API 依赖有效 session。本模块持有 sessionReady
 * 门闩 —— app.js 必须在 session 真正可用（启动校验通过 / Cookie 续期成功 /
 * 手动测试连接成功）之后调用 markSessionReady()，此前一律不发起 limits 请求，
 * 否则会拿着过期 / 未确认的 session 去调接口而报错。
 */
import { createLogger } from "../common/logger.js";

const log = createLogger("LIMITS");
import { sfConn } from "./sf_service.js";
import { appState } from "./state.js";
import { showSection } from "./ui.js";
import { showNotification, escapeHtml } from "../common/utils.js";
import { replaceIcons } from "../common/icons.js";

const HOST_ID = "org-limits-content";
// 首页「Org 状态」面板宿主
const HOME_HOST_ID = "org-dashboard-panel";
const STALE_MS = 2 * 60 * 1000; // 2 分钟内不重复自动拉取

// 进度条配色阈值
const WARN_PCT = 60;
const DANGER_PCT = 85;

// 顶部汇总卡片的关键指标（顺序即展示顺序）
const KEY_LIMITS = [
  { key: "DailyApiRequests", label: "Daily Api Requests", hint: "REST / SOAP 调用，含本插件全部查询" },
  { key: "DailyAsyncApexExecutions", label: "Daily Async Apex Executions", hint: "每日异步" },
  { key: "DailyBulkApiRequests", label: "Daily Bulk Api Requests", hint: "Bulk 2.0 批量作业" },
  { key: "DataStorageMB", label: "Data Storage", hint: "记录数据占用（MB）" }
];

// 常见限额的中文名（没命中的 key 会退化为去掉 __c / 驼峰分词后的原文）
const LIMIT_LABELS = {
  DailyApiRequests: "Daily Api Requests",
  DailyBulkApiRequests: "Daily Bulk Api Requests",
  DailyBulkV2QueryFileProcessingRequests: "每日 Bulk V2 查询文件处理",
  DailyBulkV2QueryRequests: "每日 Bulk V2 查询请求",
  DailyBulkV2UploadFileStorageMB: "每日 Bulk V2 上传文件存储 (MB)",
  DailyDurableGenericStreamingApiConcurrentEvents: "持久通用流并发事件",
  DailyDurableStreamingApiEvents: "每日持久流事件",
  DailyGenericStreamingApiEvents: "每日通用流事件",
  DailyStandardVolumePlatformEvents: "每日标准量平台事件",
  DailyWorkflowEmails: "每日工作流邮件",
  DataStorageMB: "数据存储 (MB)",
  DurableStreamingApiConcurrentClients: "持久流并发客户端",
  FileStorageMB: "文件存储 (MB)",
  MassMail: "群发邮件",
  PermissionSets: "权限集",
  ConcurrentAsyncGetReportInstances: "并发异步报表实例",
  ConcurrentEclairSparkAndPardotRequests: "并发 Eclair/Pardot 请求",
  ConcurrentSyncApiReportRuns: "并发同步报表运行",
  StreamingApiConcurrentClients: "流 API 并发客户端",
  SingleEmail: "单发邮件",
  DailyAsyncApexExecutions: "Daily Async Apex Executions",
};

// 分组规则：按 key 关键字归类，未命中的进「其他」
const LIMIT_GROUPS = [
  { id: "api", title: "API 调用", match: (k) => /Api|api/i.test(k) || k === "MassMail" || k === "SingleEmail" },
  { id: "storage", title: "存储", match: (k) => /Storage|storage/.test(k) },
  { id: "record", title: "记录与配置", match: (k) => /Records|Permission|Custom|Fields|Tabs|Apps|Roles|Groups|Sites|Communities|Dashboards|Reports|Workflow|Escalation/i.test(k) }
  // 其余 → 其他
];

// ---------- 模块内缓存 ----------

let lastLimits = null;       // 最近一次拉到的原始数据
let lastFetchedAt = null;    // 拉取时间戳（毫秒）
let loading = false;
// session 就绪门闩：app.js 在 session 确认可用后调 markSessionReady() 打开
let sessionReady = false;

// ---------- 工具 ----------

function fmtNum(n) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return "-";
  return Number(n).toLocaleString("en-US");
}

/** 驼峰 / 下划线 key → 可读文本 */
function prettifyKey(key) {
  if (LIMIT_LABELS[key]) return LIMIT_LABELS[key];
  return key
    .replace(/__c$/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/_/g, " ")
    .trim();
}

/**
 * 把 Limits API 的一个条目归一化为 { max, used, remaining, pct, complex }。
 * Complex 类型（带 Consumed 数组）没有 Remaining 时，用 Max - ΣConsumed 近似。
 *
 * 注意：pct **不设上限**。部分限额（数据存储、文件存储等）实际用量会超过配额
 * （Salesforce 允许超额使用一段时间），此时 pct > 100，需要在界面上如实呈现。
 */
function normalizeEntry(entry) {
  if (!entry || typeof entry !== "object") return null;
  const max = Number(entry.Max);
  if (!Number.isFinite(max) || max <= 0) return null;

  let remaining = Number(entry.Remaining);
  if (!Number.isFinite(remaining) && Array.isArray(entry.Consumed)) {
    const consumedTotal = entry.Consumed.reduce(
      (sum, c) => sum + (Number(c && c.Count) || 0),
      0
    );
    remaining = max - consumedTotal;
  }
  if (!Number.isFinite(remaining)) return null;

  const used = max - remaining; // 可为正（超额时 used > max）
  const pct = (used / max) * 100; // 允许 > 100
  return {
    max,
    used: Math.max(0, used),
    remaining,
    pct: Math.max(0, pct),
    over: used > max, // 已超额
    complex: entry.type === "Complex"
  };
}

function levelOf(pct) {
  if (pct > 100) return "over";   // 突破配额：比 danger 更醒目的一档
  if (pct >= DANGER_PCT) return "danger";
  if (pct >= WARN_PCT) return "warn";
  return "ok";
}

// ---------- 汽车仪表盘（ECharts gauge，转速表式 240° 扫描角） ----------
// 结构：底部分区色带（绿 0-60 / 黄 60-85 / 红 85-100，用语义色的 border 档做低饱和底）
//       + 进度弧（按级别着色，圆头）+ 中心指针 + 轴点 + 5 段分度线。
// ECharts 是 canvas 绘制，itemStyle/lineStyle 里 var() 不生效，必须写字面色；
// 色值与 main.css :root 令牌一一对应（见下方注释），并登记在 check-ui 的 HEX_ALLOWLIST。

const LEVEL_COLORS = {
  ok: "#52c41a",     // = --success-color
  warn: "#faad14",   // = --warning-color
  danger: "#ff4d4f", // = --error-color
  over: "#cf1322"    // = --error-strong（突破 100% 的超额档，比 danger 更深）
};

const ZONE_COLORS = {
  ok: "#b7eb8f",     // = --success-border（分区带用 border 档，比进度弧更柔和）
  warn: "#ffe58f",   // = --warning-border
  danger: "#ffccc7"  // = --error-border
};

// 文字/指针色用 rgba（canvas 支持，取值对应 --text-primary / --text-light 令牌）
const GAUGE_TEXT = "rgba(0, 0, 0, 0.85)";
const GAUGE_TICK = "rgba(0, 0, 0, 0.25)";

// 图表实例管理：innerHTML 重建前必须 dispose，否则实例泄漏。
// 实例表全局共享（首页面板 + 详情页各一份），dispose 时必须限定 scope host ——
// 首页面板重建不能误伤详情页的实例（反之亦然）。
const gaugeCharts = new Map(); // Element -> echarts 实例

function disposeGaugeCharts(scopeHost) {
  gaugeCharts.forEach((chart, el) => {
    if (scopeHost && !scopeHost.contains(el)) return; // 不在本次重建范围内，保留
    try { chart.dispose(); } catch (e) { /* ignore */ }
    gaugeCharts.delete(el);
  });
}

function resizeGaugeCharts() {
  gaugeCharts.forEach((chart) => {
    try { chart.resize(); } catch (e) { /* ignore */ }
  });
}

/** ECharts gauge 配置（单个指标） */
function gaugeOption(pct) {
  const level = levelOf(pct);
  // 用量可以突破配额（pct > 100）：表盘刻度上限随之扩展，
  // 否则指针会停在 100 的位置，看不出超了多少
  const gaugeMax = pct > 100 ? Math.max(120, Math.ceil(pct / 10) * 10) : 100;
  // 分区带按「真实百分比」换算到当前刻度（60% / 85% / 100%+ 超额区）
  const z60 = WARN_PCT / gaugeMax;
  const z85 = DANGER_PCT / gaugeMax;
  return {
    series: [
      {
        type: "gauge",
        startAngle: 210,
        endAngle: -30,
        min: 0,
        max: gaugeMax,
        splitNumber: 5,
        radius: "100%",
        center: ["50%", "62%"],
        // 转速表式分区底带：绿区 / 黄区 / 红区（含超额区）
        axisLine: {
          lineStyle: {
            width: 12,
            color: [
              [z60, ZONE_COLORS.ok],
              [z85, ZONE_COLORS.warn],
              [1, ZONE_COLORS.danger]
            ]
          }
        },
        // 当前用量进度弧（覆盖在分区带上）
        progress: {
          show: true,
          width: 12,
          roundCap: true,
          itemStyle: { color: LEVEL_COLORS[level] }
        },
        pointer: {
          length: "58%",
          width: 4,
          itemStyle: { color: GAUGE_TEXT }
        },
        anchor: {
          show: true,
          size: 8,
          itemStyle: { color: GAUGE_TEXT }
        },
        axisTick: { show: false },
        splitLine: {
          length: 4,
          distance: 2,
          lineStyle: { color: GAUGE_TICK, width: 1.5 }
        },
        axisLabel: { show: false },
        title: { show: false },
        detail: { show: false },
        data: [{ value: Number(pct.toFixed(1)) }],
        animationDuration: 500
      }
    ]
  };
}

/**
 * 在 host 容器内初始化所有 .org-gauge-chart。
 * 必须在 innerHTML 写入之后调用（此时 DOM 已存在且可见）。
 * 若容器宽度为 0（宿主处于 display:none，如连接成功后首页还隐藏着），
 * 实例仍会创建，等 nforce:home / resize 时统一 resize 补救。
 */
function initGaugeCharts(host) {
  if (!host) return;
  if (typeof echarts === "undefined") {
    log.warn("echarts 未加载（lib/js/echarts.min.js），仪表盘退化为纯文字显示");
    return;
  }
  host.querySelectorAll(".org-gauge-chart").forEach((el) => {
    const pct = parseFloat(el.getAttribute("data-pct"));
    if (!Number.isFinite(pct)) return;
    try {
      const chart = echarts.init(el);
      chart.setOption(gaugeOption(pct));
      gaugeCharts.set(el, chart);
    } catch (e) {
      log.warn("初始化仪表盘失败:", e);
    }
  });
}

// 首页/详情页切换或窗口尺寸变化时，同步图表尺寸
// （ECharts 不会自动 resize；隐藏容器里 init 的图表靠 nforce:home 补救）
if (typeof window !== "undefined") {
  window.addEventListener("resize", resizeGaugeCharts);
  window.addEventListener("nforce:home", resizeGaugeCharts);
  window.addEventListener("nforce:section", (e) => {
    if (e.detail && e.detail.section === 27) resizeGaugeCharts();
  });
}

// ---------- 渲染 ----------

/** 详情页（section-27）顶部汇总卡：仪表盘 + 明细 */
function cardHtml(item) {
  const e = item.entry;
  const level = levelOf(e.pct);
  return `<div class="org-limit-card is-${level}">
                    <div class="org-limit-card-head">
                        <span class="org-limit-card-title">${escapeHtml(item.label)}</span>
                        <span class="org-limit-card-pct">${e.pct.toFixed(1)}%</span>
                    </div>
                    <div class="org-gauge-chart" data-pct="${e.pct.toFixed(1)}" role="img" aria-label="已用 ${e.pct.toFixed(1)}%"></div>
                    <div class="org-limit-card-detail">
                        已用 ${fmtNum(e.used)} / ${fmtNum(e.max)} · ${e.over ? `超出 ${fmtNum(e.used - e.max)}` : `剩余 ${fmtNum(e.remaining)}`}
                    </div>
                    <div class="org-limit-card-hint">${escapeHtml(item.hint || "")}</div>
                </div>`;
}

function rowHtml(item) {
  const e = item.entry;
  const level = levelOf(e.pct);
  // 进度条容器宽度有限，超过 100% 时截断在 100%（百分比文本仍显示真实值）
  const barPct = Math.min(100, e.pct);
  return `<div class="org-limit-row is-${level}">
                    <span class="org-limit-name" title="${escapeHtml(item.key)}">${escapeHtml(item.label)}</span>
                    <span class="org-limit-bar">
                        <span style="width: ${Math.max(barPct, barPct > 0 ? 1.5 : 0)}%;"></span>
                    </span>
                    <span class="org-limit-pct">${e.pct.toFixed(1)}%</span>
                    <span class="org-limit-count">已用 ${fmtNum(e.used)} / ${fmtNum(e.max)}${e.over ? `（超额 ${fmtNum(e.used - e.max)}）` : ""}</span>
                </div>`;
}

/** 由原始 limits 构建展示列表（key/label/entry），KEY_LIMITS 的除外 */
function buildItems(limits) {
  const keySet = new Set(KEY_LIMITS.map((k) => k.key));
  const items = [];
  for (const [key, raw] of Object.entries(limits)) {
    const entry = normalizeEntry(raw);
    if (!entry) continue;
    items.push({ key, label: prettifyKey(key), entry, keyLimit: keySet.has(key) });
  }
  return items;
}

function filteredItems(items) {
  const input = document.getElementById("org-limits-filter");
  const q = (input && input.value ? input.value : "").trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (it) => it.label.toLowerCase().includes(q) || it.key.toLowerCase().includes(q)
  );
}

function render() {
  const host = document.getElementById(HOST_ID);
  if (!host) return;

  if (!lastLimits) {
    host.innerHTML = `<div class="kv-empty-state">
                        <i class="fas fa-tachometer-alt"></i>
                        <p>还没有 Limits 数据。</p>
                        <p class="kv-empty-hint">点击右上角「刷新」从 Salesforce 拉取当前 Org 的限额用量。</p>
                    </div>`;
    replaceIcons();
    return;
  }

  const items = buildItems(lastLimits);
  const byKey = new Map(items.map((it) => [it.key, it]));

  // 1) 顶部汇总卡片：固定四个关键指标（缺失的跳过）
  const keyCards = KEY_LIMITS
    .map((k) => {
      const hit = byKey.get(k.key);
      return hit ? cardHtml({ ...hit, label: k.label, hint: k.hint }) : "";
    })
    .filter(Boolean)
    .join("\n");

  // 2) 全量列表：按分组渲染（搜索过滤后）
  const rest = filteredItems(items.filter((it) => !it.keyLimit));
  const groupsHtml = LIMIT_GROUPS.map((g) => {
    const rows = rest.filter((it) => g.match(it.key));
    if (!rows.length) return "";
    return `<div class="org-limit-group">
                        <div class="org-limit-group-title">${escapeHtml(g.title)}<span class="org-limit-group-count">${rows.length} 项</span></div>
                        ${rows.map(rowHtml).join("\n")}
                    </div>`;
  }).filter(Boolean).join("\n");

  const others = rest.filter((it) => !LIMIT_GROUPS.some((g) => g.match(it.key)));
  const othersHtml = others.length
    ? `<div class="org-limit-group">
                        <div class="org-limit-group-title">其他<span class="org-limit-group-count">${others.length} 项</span></div>
                        ${others.map(rowHtml).join("\n")}
                    </div>`
    : "";

  const timeText = lastFetchedAt
    ? `上次刷新：${new Date(lastFetchedAt).toLocaleString()}`
    : "";

  // 重建 DOM 前先记住搜索词与焦点状态（重建后要还原，否则每敲一个字就丢焦点）
  const prevInput = document.getElementById("org-limits-filter");
  const prevQuery = prevInput ? prevInput.value : "";
  const prevFocused = prevInput && document.activeElement === prevInput;

  // 详情页与首页面板的 gauge 共享实例表：只释放本宿主内的旧实例
  disposeGaugeCharts(host);
  host.innerHTML = `
                <div class="org-limits-summary">${keyCards}</div>
                <div class="org-limits-toolbar">
                    <input type="text" id="org-limits-filter" class="ant-input" placeholder="搜索限额名称，如 API / Storage / Email">
                    <span class="org-limits-updated">${escapeHtml(timeText)}</span>
                </div>
                ${rest.length ? groupsHtml + othersHtml : `<div class="kv-empty-state"><i class="fas fa-search"></i><p>没有匹配的限额</p></div>`}
            `;

  // 搜索框：输入即按缓存数据重新渲染
  const filterInput = document.getElementById("org-limits-filter");
  if (filterInput) {
    filterInput.value = prevQuery;
    if (prevFocused) filterInput.focus();
    // 把光标放到末尾，避免重新渲染后跳到开头
    try { filterInput.setSelectionRange(prevQuery.length, prevQuery.length); } catch (e) { /* ignore */ }
    filterInput.addEventListener("input", () => render());
  }

  // DOM 就绪后初始化汇总卡仪表盘
  initGaugeCharts(host);

  // 给自动化验证用：把当前状态挂到 DOM 上（对用户无副作用）
  const section = document.getElementById("section-27");
  if (section) {
    section.dataset.limitsLoaded = "true";
    section.dataset.limitsCount = String(items.length);
    const api = byKey.get("DailyApiRequests");
    if (api) section.dataset.apiPct = api.entry.pct.toFixed(1);
  }

  replaceIcons();
}

// ---------- 首页「Org 状态」面板（功能中心顶部） ----------

/** 首页面板的仪表盘卡（ECharts gauge） */
function gaugeCardHtml(item) {
  const e = item.entry;
  const level = levelOf(e.pct);
  return `<div class="org-dash-gauge is-${level}" title="${escapeHtml(item.hint || item.key)}">
                        <div class="org-gauge-chart" data-pct="${e.pct.toFixed(1)}" role="img" aria-label="已用 ${e.pct.toFixed(1)}%"></div>
                        <span class="org-dash-gauge-name">${escapeHtml(item.label)}</span>
                        <span class="org-dash-gauge-value">${e.pct.toFixed(1)}%${e.over ? `<small>超额</small>` : ""}</span>
                        <span class="org-dash-gauge-count">已用 ${fmtNum(e.used)} / ${fmtNum(e.max)}${e.over ? `（+${fmtNum(e.used - e.max)}）` : ""}</span>
                    </div>`;
}

function panelShell(inner, titleExtra = "") {
  return `<section class="org-dash-panel">
                    <div class="org-dash-head">
                        <span class="org-dash-title"><i class="fas fa-tachometer-alt"></i>Org 状态${titleExtra}</span>
                        <button type="button" class="org-dash-more" data-action="open-detail">查看全部 →</button>
                    </div>
                    ${inner}
                </section>`;
}

/** 用缓存数据渲染首页面板（无数据时渲染占位态） */
function renderHomePanel() {
  const host = document.getElementById(HOME_HOST_ID);
  if (!host) return;

  bindHomePanelEvents(host);

  if (!appState.is_connected) {
    host.innerHTML = panelShell(`<div class="org-dash-placeholder">
                        <i class="fas fa-plug"></i>
                        <span>连接 Salesforce 后，此处显示 Org 限额用量（API 请求 / 存储 / …）</span>
                        <button type="button" class="org-dash-connect-btn" data-action="goto-connect">去连接</button>
                    </div>`);
    replaceIcons();
    return;
  }

  // session 尚未确认（启动校验 / Cookie 续期 / 手动连接还没完成）：
  // 只显示等待态，绝不能在此阶段发起 limits 请求
  if (!sessionReady) {
    host.innerHTML = panelShell(`<div class="org-dash-placeholder">
                        <i class="fas fa-key"></i>
                        <span>正在确认 Salesforce 会话，确认后自动获取 Org 限额用量...</span>
                    </div>`);
    replaceIcons();
    return;
  }

  if (!lastLimits) {
    host.innerHTML = panelShell(`<div class="org-dash-placeholder">
                        <i class="fas fa-spinner fa-spin"></i>
                        <span>正在获取 Org 限额用量...</span>
                    </div>`);
    replaceIcons();
    return;
  }

  const items = buildItems(lastLimits);
  const byKey = new Map(items.map((it) => [it.key, it]));

  const metrics = KEY_LIMITS
    .map((k) => {
      const hit = byKey.get(k.key);
      return hit ? gaugeCardHtml({ ...hit, label: k.label, hint: k.hint }) : "";
    })
    .filter(Boolean)
    .join("\n");

  // 警示条：警告 / 危险 / 超额三档（含非关键指标）
  const warns = items.filter((it) => levelOf(it.entry.pct) === "warn").length;
  const dangers = items.filter((it) => levelOf(it.entry.pct) === "danger").length;
  const overs = items.filter((it) => levelOf(it.entry.pct) === "over").length;
  let alertHtml = "";
  if (overs || dangers || warns) {
    const parts = [];
    if (overs) parts.push(`${overs} 项已超出配额（>100%）`);
    if (dangers) parts.push(`${dangers} 项超过 ${DANGER_PCT}%`);
    if (warns) parts.push(`${warns} 项超过 ${WARN_PCT}%`);
    alertHtml = `<div class="org-dash-alert is-${overs ? "over" : dangers ? "danger" : "warn"}">
                        <i class="fas fa-exclamation-triangle"></i>
                        ${parts.join("，")}
                        <button type="button" class="org-dash-alert-link" data-action="open-detail">查看详情</button>
                    </div>`;
  }

  // 只释放首页面板内的旧实例（详情页的实例不受影响）
  disposeGaugeCharts(host);
  host.innerHTML = panelShell(`${alertHtml}<div class="org-dash-grid">${metrics}</div>`, "");
  initGaugeCharts(host);
  if (overs || dangers || warns) {
    // 标题旁的计数徽标
    const title = host.querySelector(".org-dash-title");
    if (title) {
      const badge = document.createElement("span");
      badge.className = "org-dash-badge";
      if (overs) badge.classList.add("is-over");
      else if (dangers) badge.classList.add("is-danger");
      badge.textContent = overs
        ? `${overs} 项超额`
        : dangers
          ? `${dangers} 项危险`
          : `${warns} 项警告`;
      title.appendChild(badge);
    }
  }

  // 给自动化验证用（对用户无副作用）
  host.dataset.panelLoaded = "true";
  host.dataset.panelMetrics = String(KEY_LIMITS.filter((k) => byKey.has(k.key)).length);
  const api = byKey.get("DailyApiRequests");
  if (api) host.dataset.panelApiPct = api.entry.pct.toFixed(1);

  replaceIcons();
}

/** 面板内按钮的事件委托（容器常驻，只绑一次） */
function bindHomePanelEvents(host) {
  if (host.dataset.bound === "1") return;
  host.dataset.bound = "1";
  host.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.getAttribute("data-action");
    if (action === "open-detail") showSection(27);
    else if (action === "goto-connect") showSection(1);
  });
}

/**
 * 首页面板入口：由 ui_layout.js 的 renderLauncher() 调用（首页每次渲染 / 连接状态变化后都会走）。
 * - 未连接：占位提示
 * - 已连接但 session 未确认：只渲染等待态，不发起请求
 * - 已连接 + session 就绪 + 缓存新鲜：直接渲染摘要
 * - 已连接 + session 就绪 + 缓存缺失/过期：先渲染加载态，再后台静默拉取（不打断用户）
 */
export function refreshHomeDashboard() {
  renderHomePanel();

  if (
    sessionReady &&
    appState.is_connected &&
    (!lastLimits || !lastFetchedAt || Date.now() - lastFetchedAt >= STALE_MS)
  ) {
    fetchLimits(false);
  }
}

/**
 * session 就绪门闩：app.js 在 session 真正可用后调用
 * （启动校验通过 / Cookie 自动续期成功 / 手动测试连接成功），
 * 之前本模块不会发起任何 limits 请求。
 */
export function markSessionReady() {
  sessionReady = true;
  refreshHomeDashboard();
}

// ---------- 拉取 ----------

async function fetchLimits(force = false) {
  // session 未确认前绝不调 Limits API（会话无效只会得到报错）
  if (!sessionReady) {
    if (force) showNotification("Salesforce 会话尚未确认，请稍候再试", "warning");
    return;
  }
  if (loading) return;
  if (!force && lastLimits && lastFetchedAt && Date.now() - lastFetchedAt < STALE_MS) {
    render();
    renderHomePanel();
    return;
  }

  loading = true;
  const host = document.getElementById(HOST_ID);
  if (host && !lastLimits) {
    host.innerHTML = `<div class="org-limits-loading">
                        <i class="fas fa-spinner fa-spin"></i> 正在从 Salesforce 获取 Org Limits...
                    </div>`;
    replaceIcons();
  }

  const result = await sfConn.getOrgLimits();
  loading = false;

  if (result.success) {
    lastLimits = result.limits;
    lastFetchedAt = Date.now();
    log.info(`Org Limits 获取成功，共 ${Object.keys(lastLimits).length} 项`);
    render();
    renderHomePanel();
  } else {
    log.error("Org Limits 获取失败:", result.error);
    if (host) {
      host.innerHTML = `<div class="kv-empty-state">
                            <i class="fas fa-exclamation-triangle"></i>
                            <p>获取 Org Limits 失败：${escapeHtml(result.error || "未知错误")}</p>
                            <p class="kv-empty-hint">该接口需要账号具备「View Setup and Configuration」权限；也可稍后点「刷新」重试。</p>
                        </div>`;
      replaceIcons();
    }
    // 首页面板给出轻量失败态（不弹通知，避免打扰首页）
    const homeHost = document.getElementById(HOME_HOST_ID);
    if (homeHost && appState.is_connected) {
      homeHost.innerHTML = panelShell(`<div class="org-dash-placeholder">
                            <i class="fas fa-exclamation-triangle"></i>
                            <span>获取 Org 限额失败：${escapeHtml(result.error || "未知错误")}</span>
                            <button type="button" class="org-dash-connect-btn" data-action="open-detail">查看详情</button>
                        </div>`);
      replaceIcons();
    }
    showNotification("获取 Org Limits 失败：" + (result.error || "未知错误"), "error");
  }
}

/** 进入详情页（section-27）时调用：懒加载入口（ui.js showSection 27 分支） */
export function initOrgDashboard() {
  const refreshBtn = document.getElementById("org-limits-refresh-btn");
  if (refreshBtn && !refreshBtn.dataset.bound) {
    refreshBtn.dataset.bound = "1";
    refreshBtn.addEventListener("click", () => fetchLimits(true));
  }
  fetchLimits(false);
}

/** 供外部（如控制台调试）强制刷新 */
export function loadOrgLimits() {
  return fetchLimits(true);
}
