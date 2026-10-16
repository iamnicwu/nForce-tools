/**
 * Execute Anonymous 的「自动取日志」纯逻辑。
 *
 * ── 背景：为什么不能直接查「最新一条 ApexLog」──
 * Salesforce **默认不给任何用户记日志**：Tooling API 的 `executeAnonymous` 只回编译/执行结果，
 * 想拿到日志必须在 `ApexLog` 里有这条记录。而 `ApexLog` 里要有记录，前提是当前用户存在一条
 * 未过期的 **`TraceFlag`**（Setup → Debug Logs 里那个"用户跟踪"）。所以完整链路是四步：
 *   ① 确保 TraceFlag 有效（没有就建、过期就续期）
 *   ② 记下**执行前**最新一条 `ApexLog` 的 Id
 *   ③ 执行，然后轮询「最新一条 `ApexLog`」直到它**不等于**②那条 —— 那条才是本次的
 *   ④ 取它的 Body（`/tooling/sobjects/ApexLog/{id}/Body`）
 * 第 ③ 步刻意用「Id 变没变」而不是「时间 > 执行时刻」：日志的 `StartTime` 由服务端时钟决定，
 * 与本机时钟有偏差（还有时区），拿时间比会偶发漏掉或抓错；Id 是确定的。
 *
 * ── 为什么这段单独一个模块 ──
 * 脏活全在「拼 SOQL」与「哪条才算本次的」这两处，而它们**可以在 node 里单测**；
 * 真发请求那层（`biz/sf_service.js`）测不了。定位与 `common/order_query.js` 一样：
 * 零依赖、纯函数，不碰 DOM 与 chrome.*。
 */

/** 一次 Execute Anonymous 会落到哪几类 TraceFlag 上。查询时都认，避免重复创建。 */
export const TRACE_LOG_TYPES = ["DEVELOPER_LOG", "USER_DEBUG"];

/** 新建 / 续期 TraceFlag 的有效期（分钟）。Salesforce 上限是 24 小时。 */
export const TRACE_TTL_MINUTES = 30;

/**
 * 自建 DebugLevel 的 DeveloperName。优先复用 org 自带的 `SFDC_DevConsole`
 * （Developer Console 用的那套，几乎所有 org 都有），查不到才建这套。
 */
export const DEBUG_LEVEL_NAME = "nForce_Debug";

/** 日志正文只在界面显示这么多字节，超出截断（避免几 MB 的日志把页面卡住） */
export const LOG_BODY_DISPLAY_LIMIT = 200 * 1024;

/** 轮询等日志落库：间隔与总超时（毫秒）。日志通常 <1s 出现，偶尔要几秒。 */
export const LOG_POLL_INTERVAL_MS = 600;
export const LOG_POLL_TIMEOUT_MS = 9000;

/** SOQL 字符串字面量转义（用户 Id 是 15/18 位字母数字，正常不会命中，防御性保留） */
function quote(value) {
  return `'${String(value == null ? "" : value).replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`;
}

/**
 * 查当前用户的 TraceFlag。
 *
 * 按 `ExpirationDate DESC` 取前几条，让调用方在本地挑「还没过期的」——
 * **不把过期判断写进 SOQL**（`ExpirationDate > ...` 需要 DateTime 字面量，
 * 而服务端时钟与本机时钟不一定一致，边界上会漏掉刚过期/刚生效的那条）。
 */
export function traceFlagSoql(tracedEntityId) {
  return (
    `SELECT Id, LogType, DebugLevelId, StartDate, ExpirationDate FROM TraceFlag` +
    ` WHERE TracedEntityId = ${quote(tracedEntityId)}` +
    ` AND LogType IN (${TRACE_LOG_TYPES.map(quote).join(", ")})` +
    ` ORDER BY ExpirationDate DESC LIMIT 20`
  );
}

/** 查某个 DeveloperName 的 DebugLevel（用来复用 org 自带的调试级别） */
export function debugLevelSoql(developerName = "SFDC_DevConsole") {
  return (
    `SELECT Id, DeveloperName FROM DebugLevel` +
    ` WHERE DeveloperName = ${quote(developerName)} LIMIT 1`
  );
}

/**
 * 查当前用户最近的几条 ApexLog。
 *
 * ⚠️ 必须带 `LogUserId` 过滤：`ApexLog` 在 Tooling API 里能查到**全 org** 的日志
 * （只要有权限），不加这个条件会拿到别人的、或系统批处理产生的日志 —— 那正是"取到错日志"
 * 最常见的成因。假 Org 会校验这个子句。
 */
export function apexLogSoql(userId, limit = 5) {
  const n = Math.max(1, Math.min(200, Number(limit) || 5));
  return (
    `SELECT Id, LogUserId, LogLength, Operation, Request, StartTime, Status FROM ApexLog` +
    ` WHERE LogUserId = ${quote(userId)}` +
    ` ORDER BY StartTime DESC LIMIT ${n}`
  );
}

/** SOQL 的 DateTime 字面量：不带引号，形如 `2026-10-16T10:00:00.000+0000` */
export function soqlDateTime(ms) {
  return new Date(ms).toISOString().replace("Z", "+0000");
}

/**
 * 新建 TraceFlag 的请求体。
 *
 * `LogType` 取 `DEVELOPER_LOG`：Execute Anonymous 属开发者行为，Developer Console
 * 自己建的也是这一档；查询时会连同 `USER_DEBUG` 一起认（见 `TRACE_LOG_TYPES`）。
 */
export function traceFlagPayload(tracedEntityId, debugLevelId, nowMs = Date.now(), ttlMinutes = TRACE_TTL_MINUTES) {
  const start = new Date(nowMs);
  const end = new Date(nowMs + ttlMinutes * 60 * 1000);
  return {
    TracedEntityId: tracedEntityId,
    LogType: "DEVELOPER_LOG",
    DebugLevelId: debugLevelId,
    StartDate: start.toISOString(),
    ExpirationDate: end.toISOString()
  };
}

/** 续期请求体（PATCH 一条已存在的 TraceFlag）：只改时间与级别 */
export function traceFlagRenewPayload(debugLevelId, nowMs = Date.now(), ttlMinutes = TRACE_TTL_MINUTES) {
  const start = new Date(nowMs);
  const end = new Date(nowMs + ttlMinutes * 60 * 1000);
  return {
    DebugLevelId: debugLevelId,
    StartDate: start.toISOString(),
    ExpirationDate: end.toISOString()
  };
}

/** 自建 DebugLevel 的请求体。ApexCode 至少要 DEBUG，否则 `System.debug()` 的输出不会进日志。 */
export function debugLevelPayload(masterLabel = "nForce Debug") {
  return {
    DeveloperName: DEBUG_LEVEL_NAME,
    MasterLabel: masterLabel,
    ApexCode: "DEBUG",
    ApexProfiling: "INFO",
    Callout: "INFO",
    Database: "INFO",
    System: "DEBUG",
    Validation: "INFO",
    Visualforce: "INFO",
    Workflow: "INFO"
  };
}

/**
 * 从 TraceFlag 查询结果里挑一条当前可用的（未过期的最优）。
 *
 * @param {Array} records SOQL 结果
 * @param {number} nowMs 当前时间（测试可注入）
 * @returns {object|null}
 */
export function pickActiveTraceFlag(records, nowMs = Date.now()) {
  const usable = (Array.isArray(records) ? records : []).filter((r) => {
    if (!r || !r.Id) return false;
    if (!r.ExpirationDate) return true; // 没写到期时间的，按可用处理（保守：宁可不建新的）
    const exp = Date.parse(r.ExpirationDate);
    return Number.isNaN(exp) ? true : exp > nowMs;
  });
  if (!usable.length) return null;
  // 到期时间最晚的那条（Salesforce 同类型 flag 通常只有一条，多个时挑有效期最长的）
  return usable.sort((a, b) => {
    const ea = Date.parse(a.ExpirationDate || "");
    const eb = Date.parse(b.ExpirationDate || "");
    if (Number.isNaN(ea) && Number.isNaN(eb)) return 0;
    if (Number.isNaN(ea)) return 1;
    if (Number.isNaN(eb)) return -1;
    return eb - ea;
  })[0];
}

/** 从 TraceFlag 查询结果里挑一条"已过期、可以续期"的（没有则返回 null） */
export function pickExpiredTraceFlag(records, nowMs = Date.now()) {
  const expired = (Array.isArray(records) ? records : []).filter((r) => {
    if (!r || !r.Id || !r.ExpirationDate) return false;
    const exp = Date.parse(r.ExpirationDate);
    return !Number.isNaN(exp) && exp <= nowMs;
  });
  return expired.length ? expired[0] : null;
}

/**
 * 从最新的 ApexLog 列表里挑出「本次执行新产生的那条」。
 *
 * 判据是**与执行前那条的 Id 不同**（见文件头说明：不用时间比较）。
 * `beforeId` 为 null（执行前一条都没有）时，直接取第一条。
 *
 * @param {Array} records 按 StartTime DESC 排好的记录
 * @param {string|null} beforeId 执行前最新一条的 Id
 * @returns {object|null}
 */
export function pickNewestLog(records, beforeId) {
  const list = (Array.isArray(records) ? records : []).filter((r) => r && r.Id);
  if (!list.length) return null;
  if (!beforeId) return list[0];
  return list.find((r) => r.Id !== beforeId) || null;
}

/**
 * 归一化日志正文。
 *
 * 两件事：
 *   ① 有些返回会把换行转义成字面量 `\n`（历史实现里那段 `replace(/\\n/g,"\n")` 保留），
 *      不还原的话整个日志会挤成一行；
 *   ② 超过 `limit` 只留头部并附一句提示 —— 单条日志上限 5MB，直接塞进 `<pre>` 会把页面拖死。
 *
 * @returns {{text: string, truncated: boolean, bytes: number}}
 */
export function normalizeLogBody(raw, limit = LOG_BODY_DISPLAY_LIMIT) {
  let text = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  if (text.includes("\\n")) text = text.replace(/\\n/g, "\n");
  const bytes = text.length;
  if (limit > 0 && bytes > limit) {
    const kept = text.slice(0, limit);
    return {
      text: `${kept}\n\n…（日志过长，界面只显示前 ${Math.round(limit / 1024)}KB / 共 ${Math.round(bytes / 1024)}KB；完整内容请用「下载日志」）`,
      truncated: true,
      bytes
    };
  }
  return { text, truncated: false, bytes };
}

/** 一行摘要：`ExecuteAnonymous · 12.3 KB · 2026-10-16 18:05:42 · Success` */
export function logMetaText(record) {
  if (!record) return "";
  const parts = [];
  if (record.Operation) parts.push(record.Operation);
  if (Number.isFinite(Number(record.LogLength))) {
    parts.push(`${(Number(record.LogLength) / 1024).toFixed(1)} KB`);
  }
  if (record.StartTime) parts.push(formatDateTime(record.StartTime));
  if (record.Status) parts.push(record.Status);
  return parts.join(" · ");
}

/** 本地时间 `YYYY-MM-DD HH:mm:ss`（不引 dayjs：本模块零依赖，单测里也好断言） */
function formatDateTime(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  const p = (n) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/**
 * TraceFlag 那一步的结果 → 给用户看的一句话（顺便决定提示的轻重）。
 * @param {{ok: boolean, status?: string, error?: string}} trace
 */
export function traceFlagHint(trace) {
  if (!trace) return "";
  if (trace.ok) {
    if (trace.status === "created") return `已自动开启日志跟踪（TraceFlag，${TRACE_TTL_MINUTES} 分钟有效）`;
    if (trace.status === "renewed") return `已续期日志跟踪（TraceFlag，顺延 ${TRACE_TTL_MINUTES} 分钟）`;
    const exp = trace.traceFlag && trace.traceFlag.ExpirationDate;
    return exp ? `复用现有日志跟踪（有效期至 ${formatDateTime(exp)}）` : "复用现有日志跟踪";
  }
  return `未能开启日志跟踪：${trace.error || "未知原因"}`;
}

/** Execute Anonymous 后没拿到日志时的排查建议（按最可能的原因排序） */
export function noLogHint({ traceOk, hasTraceFlagError } = {}) {
  if (!traceOk) {
    return (
      "没有日志是因为**日志跟踪没开起来**（见上一行提示）。" +
      "也可以自己到 Setup → Debug Logs 给本用户加一条跟踪，再重跑一次。"
    );
  }
  if (hasTraceFlagError) return "日志跟踪状态异常，请到 Setup → Debug Logs 检查。";
  return (
    "日志跟踪已开启，但这次执行没有产生日志 —— 常见原因：" +
    "① 日志还在落库（稍等几秒再点一次执行）；" +
    "② 代码里没有任何 `System.debug()` 输出；" +
    "③ 日志已被 org 的保留策略清理。"
  );
}
