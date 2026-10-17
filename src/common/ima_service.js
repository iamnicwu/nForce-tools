/**
 * ima 知识库同步（腾讯 ima OpenAPI）
 *
 * 让「SOQL 查询历史」「Apex 执行历史」能一键存进 ima 的知识库，方便以后在 ima 里提问
 * （"上次查 Order 用的是什么 SOQL"这种东西，存在本地 storage 里只能自己翻）。
 *
 * ── 为什么走 OpenAPI 而不是 MCP ──
 * 扩展是纯前端环境，够不到 WorkBuddy 那边的 MCP 连接器；ima 对外提供的是
 * **带 Client ID / API Key 的 HTTP OpenAPI**（凭证在 https://ima.qq.com/agent-interface 生成），
 * 这条路径只用 fetch，天然适配扩展（域名单列在 manifest 的 host_permissions 与
 * CSP connect-src 里，两处都要有，否则请求会被静默拦掉）。
 *
 * ── 只用两个接口（都不需要 COS 签名）──
 *   ① POST /openapi/note/v1/import_doc     Markdown → 新建笔记，拿到 note_id
 *   ② POST /openapi/wiki/v1/add_knowledge  note_id → 加入知识库（media_type = 11 笔记）
 * 另有 `get_addable_knowledge_base_list` 用于「测试连接 + 选知识库」那一步。
 *
 * 上传文件那条路（create_media → COS PUT → add_knowledge）要算 COS 签名，
 * 为了存一段文本去实现一套签名不划算，所以这里一律走"先建笔记、再加进知识库"。
 *
 * ── 失败口径 ──
 * ima 的错误是 `{ code, msg }`，code≠0 时**直接把 msg 给用户**（服务端文案比我们准）。
 * 只有 HTTP 401/403 这类"根本没被受理"的情况才翻译成"凭证无效/过期"。
 */
import { createLogger } from "./logger.js";
import { getPref, PREF_KEYS } from "./prefs.js";
import { HISTORY_KINDS } from "./history_store.js";

const log = createLogger("IMA");

/** ima OpenAPI 根地址（与 manifest 的 host_permissions / CSP 必须一致） */
export const IMA_BASE_URL = "https://ima.qq.com";
/** 凭证生成页（设置里给用户的链接） */
export const IMA_CREDENTIAL_URL = "https://ima.qq.com/agent-interface";

/** 单次请求超时。ima 在国内，20 秒已经非常宽松；超时比挂死好。 */
const REQUEST_TIMEOUT_MS = 20000;

/** 笔记正文的分片长度：单次导入过长容易被下游截断，宁可分成几条笔记 */
const NOTE_CHUNK_CHARS = 18000;

/** ima 的 NoteMediaType：笔记 */
const MEDIA_TYPE_NOTE = 11;

/* ------------------------------------------------------------------ *
 * 配置
 * ------------------------------------------------------------------ */

/**
 * 当前 ima 配置（来自 common/prefs.js，密钥不会出现在日志里 —— 那边写值时会脱敏）。
 * @returns {{clientId: string, apiKey: string, kbId: string, configured: boolean}}
 */
export function getImaConfig() {
  const clientId = String(getPref(PREF_KEYS.imaClientId) || "").trim();
  const apiKey = String(getPref(PREF_KEYS.imaApiKey) || "").trim();
  const kbId = String(getPref(PREF_KEYS.imaKbId) || "").trim();
  return { clientId, apiKey, kbId, configured: !!(clientId && apiKey) };
}

/** 同步前的前置检查，返回一句"为什么不能同步"（能同步时返回空串） */
export function describeImaBlocker() {
  const { clientId, apiKey, kbId } = getImaConfig();
  if (!clientId || !apiKey) return "还没配置 ima 凭证（Client ID / API Key）";
  if (!kbId) return "还没选择要同步到的 ima 知识库";
  return "";
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

/** ima 返回的业务错误（code 非 0）。调用方一般直接把 message 展示给用户。 */
export class ImaApiError extends Error {
  constructor(message, code, path) {
    super(message);
    this.name = "ImaApiError";
    this.code = code;
    this.path = path;
  }
}

/**
 * POST 一个 ima OpenAPI 接口。
 * @param {string} path 形如 `/openapi/wiki/v1/get_addable_knowledge_base_list`
 * @param {object} body JSON 请求体
 * @returns {Promise<object>} 响应里的 `data`（没有 data 时返回整个响应体）
 */
async function imaPost(path, body) {
  const { clientId, apiKey } = getImaConfig();
  if (!clientId || !apiKey) throw new ImaApiError("未配置 ima 凭证", -1, path);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(IMA_BASE_URL + path, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "ima-openapi-clientid": clientId,
        "ima-openapi-apikey": apiKey
      },
      body: JSON.stringify(body || {}),
      signal: controller.signal
    });
  } catch (e) {
    if (e && e.name === "AbortError") throw new ImaApiError("请求 ima 超时（20 秒）", -2, path);
    // 网络类错误（DNS / 断网 / 被 CSP 或权限拦掉）在这里统一成一句人话：
    // 扩展里被 host_permissions 挡掉的请求，异常信息往往只有 "Failed to fetch"
    throw new ImaApiError("连不上 ima（检查网络，或确认扩展有 ima.qq.com 的访问权限）", -3, path);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401 || res.status === 403) {
    throw new ImaApiError(`ima 拒绝访问（HTTP ${res.status}）：凭证无效或已过期，请到设置里重新填`, res.status, path);
  }
  if (!res.ok) {
    throw new ImaApiError(`ima 返回 HTTP ${res.status}`, res.status, path);
  }

  let payload;
  try {
    payload = await res.json();
  } catch (e) {
    throw new ImaApiError("ima 返回的不是 JSON（可能被网关拦截）", -4, path);
  }

  const code = payload && typeof payload.code === "number" ? payload.code : 0;
  if (code !== 0) {
    const msg = (payload && payload.msg) || `ima 返回错误码 ${code}`;
    throw new ImaApiError(msg, code, path);
  }
  return payload && payload.data !== undefined ? payload.data : payload;
}

/** 能拿到的可写知识库列表（最多 50 个，够用；ima 侧很少超过这个数） */
export async function listAddableKnowledgeBases() {
  const data = await imaPost("/openapi/wiki/v1/get_addable_knowledge_base_list", { cursor: "", limit: 50 });
  const list = (data && data.addable_knowledge_base_list) || [];
  return list
    .map((kb) => ({ id: String(kb.id || ""), name: String(kb.name || "(未命名)") }))
    .filter((kb) => kb.id);
}

/**
 * 测试连接并顺带把知识库列表拿回来（设置页那个「测试并加载」按钮）。
 * @returns {Promise<{ok: boolean, list?: Array, error?: string}>}
 */
export async function testImaConnection() {
  try {
    const list = await listAddableKnowledgeBases();
    log.info(`ima 连接正常，可写知识库 ${list.length} 个`);
    return { ok: true, list };
  } catch (e) {
    log.warn("ima 连接测试失败:", e.message || e);
    return { ok: false, error: e.message || String(e) };
  }
}

/* ------------------------------------------------------------------ *
 * 同步：历史 → Markdown → 笔记 → 知识库
 * ------------------------------------------------------------------ */

/** 两位补零 */
const pad2 = (n) => String(n).padStart(2, "0");

/** 时间戳 → `2026-10-17 13:45`（导入 Markdown 用，与界面显示口径一致） */
export function formatStamp(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** meta 里的小字段 → 一行人话（没有就不输出） */
function metaLine(kind, item) {
  const meta = (item && item.meta) || {};
  const bits = [];
  if (kind === "soql") {
    if (Number.isFinite(meta.rows)) bits.push(`${meta.rows} 行`);
    if (Number.isFinite(meta.ms)) bits.push(`${meta.ms}ms`);
    if (meta.ok === false) bits.push("查询失败");
    if (meta.scanAll) bits.push("含已删除");
  } else if (kind === "apex") {
    if (meta.ok === true) bits.push("执行成功");
    if (meta.ok === false) bits.push(meta.compiled === false ? "编译失败" : "执行失败");
    if (meta.logId) bits.push(`Log ID ${meta.logId}`);
    if (Number.isFinite(meta.ms)) bits.push(`${meta.ms}ms`);
  }
  return bits.length ? bits.join(" · ") : "";
}

/**
 * 把一批历史渲染成一份 Markdown（可单测）。
 *
 * 结构刻意做成"每条一个二级标题 + 一段代码块"：ima 知识库是按段落切块检索的，
 * 标题里带上正文开头（一句话能认出是哪条）比 `#1 #2 #3` 有用得多。
 *
 * @param {"soql"|"apex"} kind
 * @param {Array} items history_store 的条目
 * @param {{part?: number, total?: number}} [opts] 分片信息（多于一片时标题带 `（1/3）`）
 */
export function buildHistoryMarkdown(kind, items, opts = {}) {
  const spec = HISTORY_KINDS[kind] || { label: kind, titlePrefix: "nForce Tools · 历史" };
  const part = opts.part || 1;
  const total = opts.total || 1;
  const title = total > 1 ? `${spec.titlePrefix}（${part}/${total}）` : spec.titlePrefix;

  const lines = [`# ${title}`, ""];
  lines.push(
    `> 同步时间：${formatStamp(Date.now())} · 共 ${items.length} 条` +
      (total > 1 ? `（本份是第 ${part} 份）` : "") +
      " · 由 nForce Tools 扩展自动整理"
  );
  lines.push("");

  items.forEach((item, index) => {
    const firstLine = item.text.split("\n").find((l) => l.trim()) || "";
    const preview = firstLine.length > 70 ? firstLine.slice(0, 70) + "…" : firstLine;
    // 标题：起了名字就用名字（那是用户自己认得的叫法），没用名字才退回正文首行。
    // 带上序号是为了在 ima 里按顺序读得下去。
    const heading = item.name ? `${item.name}` : preview || "(空)";
    const meta = metaLine(kind, item);
    lines.push(`## ${index + 1}. ${heading}`);
    lines.push("");
    // 有名字时补一行正文预览：光看名字不够判断"这条到底查的是什么"
    if (item.name && preview) lines.push(`> ${preview}`);
    lines.push(`- 最近使用：${formatStamp(item.lastUsedAt)}`);
    if (item.uses > 1) lines.push(`- 使用次数：${item.uses}`);
    if (meta) lines.push(`- 本次结果：${meta}`);
    lines.push("");
    lines.push("```" + (kind === "soql" ? "soql" : "apex"));
    lines.push(item.text);
    lines.push("```");
    lines.push("");
  });

  return lines.join("\n").trimEnd() + "\n";
}

/**
 * 按字符数把条目切成若干份（每份不超过 NOTE_CHUNK_CHARS）。
 * 单条本身就超长时独占一份（不再尝试切正文 —— 把一条查询切成两半没有意义）。
 * @returns {Array<Array>}
 */
export function chunkHistoryItems(items, maxChars = NOTE_CHUNK_CHARS) {
  const chunks = [];
  let current = [];
  let size = 0;
  for (const item of items) {
    const len = (item.text || "").length + 200; // 200 ≈ 标题与元信息
    if (current.length && size + len > maxChars) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(item);
    size += len;
  }
  if (current.length) chunks.push(current);
  return chunks;
}

/** 新建一条笔记，返回 note_id */
export async function createNoteFromMarkdown(markdown) {
  const data = await imaPost("/openapi/note/v1/import_doc", {
    content_format: 1, // 1 = MARKDOWN
    content: markdown
  });
  const noteId = (data && (data.note_id || data.noteId)) || "";
  if (!noteId) throw new ImaApiError("ima 没有返回笔记 ID（导入可能被拒）", -5, "/openapi/note/v1/import_doc");
  return noteId;
}

/** 把一条笔记加进知识库 */
export async function addNoteToKnowledgeBase(noteId, knowledgeBaseId, title) {
  await imaPost("/openapi/wiki/v1/add_knowledge", {
    media_type: MEDIA_TYPE_NOTE,
    title: title || "nForce Tools 历史",
    knowledge_base_id: knowledgeBaseId,
    note_info: { content_id: noteId }
  });
  return noteId;
}

/**
 * 「同步到知识库」的主流程：Markdown 分片 → 逐片建笔记 → 逐条加入知识库。
 *
 * 中途失败时抛错，错误信息里带上"已经成功几份"，避免用户以为整批都没进去。
 *
 * @param {"soql"|"apex"} kind
 * @param {Array} items
 * @returns {Promise<{ok: true, count: number, notes: Array<{noteId: string, title: string}>}>}
 */
export async function syncHistoryToIma(kind, items) {
  const blocker = describeImaBlocker();
  if (blocker) throw new ImaApiError(blocker, -6, "precheck");
  if (!Array.isArray(items) || !items.length) throw new ImaApiError("没有可同步的历史", -7, "precheck");

  const { kbId } = getImaConfig();
  const chunks = chunkHistoryItems(items);
  const notes = [];

  for (let i = 0; i < chunks.length; i += 1) {
    const part = i + 1;
    const markdown = buildHistoryMarkdown(kind, chunks[i], { part, total: chunks.length });
    const spec = HISTORY_KINDS[kind] || { titlePrefix: "nForce Tools 历史" };
    const title = chunks.length > 1 ? `${spec.titlePrefix}（${part}/${chunks.length}）` : spec.titlePrefix;
    try {
      const noteId = await createNoteFromMarkdown(markdown);
      await addNoteToKnowledgeBase(noteId, kbId, title);
      notes.push({ noteId, title });
    } catch (e) {
      const done = notes.length ? `（已成功 ${notes.length} 份，失败在第 ${part} 份）` : "";
      throw new ImaApiError((e.message || String(e)) + done, e.code, e.path);
    }
  }

  log.info(`已同步「${HISTORY_KINDS[kind] ? HISTORY_KINDS[kind].label : kind}」${items.length} 条到 ima（${notes.length} 份笔记）`);
  return { ok: true, count: items.length, notes };
}
