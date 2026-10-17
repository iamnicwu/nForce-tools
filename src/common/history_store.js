/**
 * 历史记录仓库 —— SOQL 查询历史 / Execute Anonymous 执行历史共用一份实现
 *
 * ── 为什么抽出这个模块（2026-10-17）──
 * 两条历史原先各写各的：SOQL 那份把 `string[]` 直接塞进 storage（只有 20 条、没有时间、
 * 没有次数、不能批量拿走）；Apex 那份压根没有。要做「批量导出 / 批量导入 / 同步知识库」，
 * 至少需要四件东西：稳定 id（勾选与去重）、时间戳（排序与展示）、元信息（结果行数 / 是否成功）、
 * 一个统一的文件格式（导出的文件必须能被自己导回来）。这些东西写两遍必然漂移，
 * 所以条目结构、迁移、合并、文件解析都在这里，UI 只负责画。
 *
 * ── 条目结构 ──
 *   { id, text, createdAt, lastUsedAt, uses, meta }
 *   · id        由正文哈希得来（`q1a2b3c4`）—— 同一段文字在任何设备上 id 都一样，
 *               所以「导入去重」和「勾选」都不需要额外的注册表
 *   · meta      各功能自定义的小字段（行数 / 耗时 / 是否成功 / Log ID），**不参与去重**
 *
 * ── 兼容旧数据 ──
 * `soql_history` 里原本存的是 `["SELECT ...", ...]`。`normalizeHistory()` 两种形状都吃，
 * 旧数组会在第一次写入时被顺手升级成新结构（不需要单独的迁移脚本）。
 *
 * ── 关于 storage ──
 * 只用 `chrome.storage.local`（不上 sync）：查询语句可能很长、条数也多，sync 有 8KB/项、
 * 100KB 总量的硬限制，撞上就是"静默不同步"。
 */
import { createLogger } from "./logger.js";

const log = createLogger("HIST");

/**
 * 各条历史的元信息。新增一条历史 = 在这里加一项 + 在 UI 里挂一个面板。
 * `limit` 是**保留条数上限**（超出时丢最久没用过的，不是最老的）。
 */
export const HISTORY_KINDS = Object.freeze({
  soql: {
    storageKey: "soql_history",
    limit: 100,
    label: "SOQL 查询历史",
    unit: "条查询",
    /** 同步到知识库时的标题前缀 */
    titlePrefix: "nForce Tools · SOQL 查询历史"
  },
  apex: {
    storageKey: "apex_history",
    limit: 100,
    label: "Apex 执行历史",
    unit: "段代码",
    titlePrefix: "nForce Tools · Apex 执行历史"
  }
});

/** 导出文件的格式标识（导入时校验，避免把别的 JSON 当历史导进来） */
const FILE_FORMAT = "nforce-tools-history";
const FILE_VERSION = 1;

export function isHistoryKind(kind) {
  return Object.prototype.hasOwnProperty.call(HISTORY_KINDS, kind);
}

function specOf(kind) {
  const spec = HISTORY_KINDS[kind];
  if (!spec) throw new Error(`未知的历史类型：${kind}`);
  return spec;
}

/* ------------------------------------------------------------------ *
 * 纯函数：规范化 / 哈希 / 合并 / 解析
 * （全部导出，test/history_store.test.js 直接打这些）
 * ------------------------------------------------------------------ */

/** 统一换行符并去掉首尾空白 —— 判断"是不是同一段代码"的唯一口径 */
export function normalizeText(text) {
  if (typeof text !== "string") return "";
  return text.replace(/\r\n?/g, "\n").trim();
}

/**
 * FNV-1a 32 位哈希（同步、无依赖、结果稳定）。
 * 不用 crypto.subtle：那是异步的，而且这里只需要"碰撞概率足够低"的短 id，
 * 8 位十六进制在几百条历史里碰撞概率可以忽略。
 */
export function hashText(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** 正文 → 稳定 id（同一段文字永远同一个 id） */
export function itemId(text) {
  const normalized = normalizeText(text);
  return normalized ? `q${hashText(normalized)}` : "";
}

/** 名字的长度上限。SQL 语句可以很长，名字只需要"一眼认出是哪条" */
export const NAME_MAX_LENGTH = 60;

/**
 * 名字规范化：去首尾空白、把连续空白压成一个空格、截断到上限。
 * 空串是**合法**语义 —— 它表示"没起名字"，界面会退回显示正文首行。
 */
export function normalizeName(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/\s+/g, " ").trim().slice(0, NAME_MAX_LENGTH);
}

/**
 * 把任意来源的一条记录规范成标准条目；无法识别时返回 null。
 * @param {*} raw 字符串（旧格式）或对象
 * @param {number} now 缺省时间戳（旧数据没有时间时用它兜底）
 */
export function normalizeItem(raw, now = Date.now()) {
  if (typeof raw === "string") {
    const text = normalizeText(raw);
    if (!text) return null;
    return { id: itemId(text), name: "", text, createdAt: now, lastUsedAt: now, uses: 1, meta: {} };
  }
  if (!raw || typeof raw !== "object") return null;

  const text = normalizeText(raw.text);
  if (!text) return null;

  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now;
  const lastUsedAt = Number.isFinite(raw.lastUsedAt) ? raw.lastUsedAt : createdAt;
  const uses = Number.isFinite(raw.uses) && raw.uses > 0 ? Math.floor(raw.uses) : 1;
  const meta = raw.meta && typeof raw.meta === "object" ? { ...raw.meta } : {};

  return { id: itemId(text), name: normalizeName(raw.name), text, createdAt, lastUsedAt, uses, meta };
}

/** 把 storage 里读出来的东西规范成条目数组（去重 + 按最近使用倒序） */
export function normalizeHistory(raw, now = Date.now()) {
  const list = Array.isArray(raw) ? raw : [];
  const seen = new Set();
  const items = [];
  for (const entry of list) {
    const item = normalizeItem(entry, now);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    items.push(item);
  }
  // 旧数据全是同一个 now，sort 是稳定的 → 原顺序保留
  return items.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/**
 * 合并两份历史（导入用）。
 *
 * 同一条（id 相同）**不新增**，只把 `uses` 累加、`lastUsedAt` 取较晚的那个、
 * `meta` 保留现有的 —— 导入一份自己导出的文件时结果就是"0 新增、N 已存在"。
 *
 * 名字的取舍：**本地已有的名字优先**（那是本机用户自己起的），只有本地没名字时
 * 才采纳文件里的 —— 反过来会让"导入一份旧备份"冲掉刚起好的名字。
 *
 * @returns {{items: Array, added: number, duplicates: number}}
 */
export function mergeHistories(existing, incoming, limit = Infinity) {
  const byId = new Map();
  for (const item of normalizeHistory(existing)) byId.set(item.id, item);

  let added = 0;
  let duplicates = 0;
  for (const item of normalizeHistory(incoming)) {
    const prev = byId.get(item.id);
    if (!prev) {
      byId.set(item.id, item);
      added += 1;
      continue;
    }
    duplicates += 1;
    byId.set(item.id, {
      ...prev,
      name: prev.name || item.name,
      uses: Math.max(prev.uses, item.uses),
      lastUsedAt: Math.max(prev.lastUsedAt, item.lastUsedAt),
      createdAt: Math.min(prev.createdAt, item.createdAt)
    });
  }

  const items = [...byId.values()].sort((a, b) => b.lastUsedAt - a.lastUsedAt).slice(0, Math.max(1, limit));
  return { items, added, duplicates };
}

/** 导出文件的内容（带格式标识，便于导入时识别与将来升级） */
export function buildExportPayload(kind, items) {
  const spec = specOf(kind);
  return {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    kind,
    label: spec.label,
    exportedAt: new Date().toISOString(),
    count: items.length,
    items: items.map((item) => ({
      // name 一并导出：换台机器导入后，起好的名字还在（id 由正文重算，不落盘）
      name: item.name || "",
      text: item.text,
      createdAt: item.createdAt,
      lastUsedAt: item.lastUsedAt,
      uses: item.uses,
      meta: item.meta || {}
    }))
  };
}

/** 导出文件名：`nforce_soql_history_20261017_1340.json` */
export function exportFileName(kind, when = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  const stamp =
    `${when.getFullYear()}${p(when.getMonth() + 1)}${p(when.getDate())}` +
    `_${p(when.getHours())}${p(when.getMinutes())}`;
  return `nforce_${kind}_history_${stamp}.json`;
}

/**
 * 解析导入文件。支持三种形状：
 *   ① 本模块导出的 JSON（`{ format, kind, items: [...] }`）
 *   ② JSON 数组（`["SELECT ...", { text }]`，手写文件常见）
 *   ③ 纯文本：按扩展名决定切法 ——
 *      `.json` 以外的都当文本；`;` 结尾的语句逐条切（.sql），其余整段算一条（.apex/.cls/.txt）
 *
 * @param {string} content 文件正文
 * @param {{kind: string, fileName?: string}} options
 * @returns {Array} 条目数组（已规范化，可能为空）
 * @throws {Error} 内容无法识别时抛出**给人看**的说明
 */
export function parseHistoryFileContent(content, options) {
  const kind = options && options.kind;
  specOf(kind);
  const text = typeof content === "string" ? content : "";
  const fileName = (options && options.fileName) || "";
  if (!text.trim()) throw new Error("文件是空的");

  const isJson = /\.json$/i.test(fileName) || /^\s*[[{]/.test(text);
  if (isJson) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      throw new Error("不是合法的 JSON：" + (e.message || e));
    }

    // ① 本模块导出的格式：kind 不一致时拒绝，避免把 Apex 历史导进 SOQL
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      if (parsed.format && parsed.format !== FILE_FORMAT) {
        throw new Error("这不是 nForce Tools 导出的历史文件");
      }
      if (parsed.kind && parsed.kind !== kind) {
        throw new Error(`这是一份「${parsed.kind}」历史，不能导入到「${kind}」`);
      }
      const list = Array.isArray(parsed.items) ? parsed.items : [];
      return normalizeHistory(list);
    }
    if (Array.isArray(parsed)) return normalizeHistory(parsed);
    throw new Error("JSON 里没有可识别的历史条目");
  }

  // ③ 纯文本
  const raw = normalizeText(text);
  if (!raw) throw new Error("文件是空的");

  // SOQL 才按 `;` 切（.sql/.soql 的常见写法）；Apex 反过来 —— 一段脚本本来就含很多分号，
  // 按分号切会把一段代码拆成几十条无意义的"历史"。所以 Apex 永远是整段一条。
  if (kind !== "soql") {
    return normalizeHistory([{ text: raw }]);
  }

  const statements = raw
    .split(/;[\s]*(?:\n|$)/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("//"));

  const list = statements.length ? statements : [raw];
  return normalizeHistory(list.map((s) => ({ text: s })));
}

/* ------------------------------------------------------------------ *
 * storage 读写
 * ------------------------------------------------------------------ */

function storageLocal() {
  return typeof chrome !== "undefined" && chrome.storage ? chrome.storage.local : null;
}

/**
 * 读某个功能的全部历史（已规范化、按最近使用倒序）。
 * storage 读失败时返回空数组 —— 历史丢了不该让整个页面起不来。
 */
export async function loadHistory(kind) {
  const spec = specOf(kind);
  const store = storageLocal();
  if (!store) return [];
  try {
    const res = await store.get([spec.storageKey]);
    return normalizeHistory(res && res[spec.storageKey]);
  } catch (e) {
    log.warn(`读取「${spec.label}」失败:`, e);
    return [];
  }
}

async function persist(kind, items) {
  const spec = specOf(kind);
  const store = storageLocal();
  const trimmed = items.slice(0, spec.limit);
  if (!store) return trimmed;
  try {
    await store.set({ [spec.storageKey]: trimmed });
  } catch (e) {
    // 配额超了是这里最常见的失败：只警告、不抛 —— 本次会话里界面仍有数据
    log.warn(`保存「${spec.label}」失败（本次会话内仍可用）:`, e);
  }
  return trimmed;
}

/**
 * 记一条历史。
 *
 * 已存在（同一段文字）时**不新增**，而是把它挪到最前面、`uses + 1`、
 * 并覆盖 meta（行数 / 是否成功这些描述的是"最近一次"）。
 *
 * @param {"soql"|"apex"} kind
 * @param {string} text 查询语句 / Apex 代码
 * @param {object} [meta] 附加信息，如 `{ rows: 24, ms: 320, ok: true }`
 * @returns {Promise<{items: Array, item: object|null, isNew: boolean}>}
 */
export async function addHistoryEntry(kind, text, meta) {
  const normalized = normalizeText(text);
  if (!normalized) return { items: await loadHistory(kind), item: null, isNew: false };

  const now = Date.now();
  const id = itemId(normalized);
  const existing = await loadHistory(kind);
  const prev = existing.find((it) => it.id === id);

  const item = prev
    ? { ...prev, lastUsedAt: now, uses: prev.uses + 1, meta: meta ? { ...meta } : prev.meta }
    : { id, name: "", text: normalized, createdAt: now, lastUsedAt: now, uses: 1, meta: meta ? { ...meta } : {} };

  const items = await persist(kind, [item, ...existing.filter((it) => it.id !== id)]);
  return { items, item, isNew: !prev };
}

/**
 * 给某一条起名字 / 改名（空串 = 取消名字，退回显示正文首行）。
 *
 * id 不变、正文不变、排序不变 —— 改名只是给人看的标签，
 * 不参与去重（去重永远看正文），所以同名两条是允许的（正文预览负责区分）。
 *
 * @param {"soql"|"apex"} kind
 * @param {string} id 条目 id
 * @param {string} name 新名字
 * @returns {Promise<Array>} 更新后的完整列表
 */
export async function renameHistoryEntry(kind, id, name) {
  const existing = await loadHistory(kind);
  const target = existing.find((it) => it.id === id);
  if (!target) return existing;
  const name2 = normalizeName(name);
  if (name2 === target.name) return existing;
  const items = await persist(
    kind,
    existing.map((it) => (it.id === id ? { ...it, name: name2 } : it))
  );
  log.info(`「${specOf(kind).label}」的条目已${name2 ? "命名为「" + name2 + "」" : "取消命名"}`);
  return items;
}

/** 删除若干条（按 id） */
export async function removeHistoryEntries(kind, ids) {
  const drop = new Set(Array.isArray(ids) ? ids : []);
  if (!drop.size) return loadHistory(kind);
  const existing = await loadHistory(kind);
  return persist(kind, existing.filter((it) => !drop.has(it.id)));
}

/** 清空 */
export async function clearHistory(kind) {
  return persist(kind, []);
}

/**
 * 导入：合并进现有历史（去重见 mergeHistories）。
 * @param {"soql"|"apex"} kind
 * @param {Array} incoming 已解析的条目
 */
export async function importHistory(kind, incoming) {
  const spec = specOf(kind);
  const existing = await loadHistory(kind);
  const merged = mergeHistories(existing, incoming, spec.limit);
  const items = await persist(kind, merged.items);
  log.info(`导入「${spec.label}」：新增 ${merged.added} 条，已存在 ${merged.duplicates} 条`);
  return { items, added: merged.added, duplicates: merged.duplicates };
}

/**
 * 订阅历史变化（跨宿主同步用：侧边栏改了，标签页里的面板也要刷新）。
 * 只读 storage、从不回写，所以不存在互相触发的循环。返回取消订阅函数。
 */
export function onHistoryChanged(callback) {
  const store = storageLocal();
  if (!store || !chrome.storage.onChanged) return () => {};
  const keys = Object.values(HISTORY_KINDS).map((s) => s.storageKey);

  const listener = (changes, area) => {
    if (area !== "local") return;
    for (const kind of Object.keys(HISTORY_KINDS)) {
      const key = HISTORY_KINDS[kind].storageKey;
      if (!(key in changes)) continue;
      try {
        callback(kind, normalizeHistory(changes[key].newValue));
      } catch (e) {
        log.warn("历史变更监听器执行失败:", e);
      }
    }
  };
  chrome.storage.onChanged.addListener(listener);
  return () => {
    try {
      chrome.storage.onChanged.removeListener(listener);
    } catch (e) {
      /* 宿主已销毁，忽略 */
    }
  };
}
