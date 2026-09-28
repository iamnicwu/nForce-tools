/**
 * 会话自动恢复：从**浏览器 Cookie** 里换一个真正可用的 Salesforce Session。
 *
 * ── 为什么需要它 ──
 * 会话过期后，在**标签页**里最自然的动作是 ⌘R 重载 —— `app.js` 的启动流程会顺手
 * 用浏览器 Cookie 换一次新会话。但**侧边栏（side panel）没有地址栏、也没有"重载
 * 当前页"的动线**：一旦启动时就被判为未连接，侧边栏会永久停在那里。
 *
 * 更糟的是原入口断了：`login.html`（"自动检测会话"辅助页）**唯一的打开方式是**
 * `chrome.action.onClicked`，而侧边栏开启 `setPanelBehavior({openPanelOnActionClick:true})`
 * 之后 Chrome 就**不再派发**该事件（`background.js` 里有注释记录这一点）。
 * 于是侧边栏用户根本拿不到那条"从 Cookie 自动检测会话"的通道，只能手动粘贴
 * Session ID —— 而多数人手上并没有 Session ID。
 *
 * 本模块把那条通道搬进应用本体（`src/` 不打包也能跑，所以放在 `biz/` 里、由
 * `app.js` 静态 import）。它与 `login_app.js` 的 `autoDetectSession()` 同源，
 * 但做了四处必要补强：
 *   1. **不要求先知道 instance_url**：候选可以从标签页 URL 或 Cookie 域本身推出来；
 *   2. **不要求开着 Salesforce 标签页**：已保存的实例地址也能当查询锚点；
 *   3. **分区 Cookie 兜底**：带 `Partitioned` 属性的 `sid` 不带 partitionKey 查不到
 *      （CHIPS），所以主查询为空时会用当前活动标签页的 origin 再查一次；
 *   4. **同族域名互换**：`xxx.lightning.force.com` 与 `xxx.my.salesforce.com` 是
 *      **不同根域**，挂在 `.salesforce.com` 上的 `sid` 用 lightning 域去查会是 0 枚
 *      —— 见 `siblingHosts()` 的注释。这是真机复现出来的那个 bug。
 *
 * ── 候选来源与优先级（越靠前越可信，先命中的先验证）──
 *   0. **已知主机**（已保存的实例地址 + 打开的 Salesforce 标签页，各自连同同族域名）：
 *      `getAll({url})` 返回的是「会被发往该 URL 的 Cookie」，所以查到的 sid 天然属于
 *      那个 org，**不需要从 Cookie 域反推**（泛域 `.salesforce.com` 反推不出是哪个 org）。
 *   1. 其余所有 sid Cookie —— **仅当 Cookie 域自身就能反推出 org 实例地址**时才可用。
 *      这是最后的兜底：没有实例地址、也没有 Salesforce 标签页时才走到这里。
 *
 * ── 安全 ──
 * sid 等同登录凭证：本模块只把它写进 `chrome.storage.local`（与手动连接一致），
 * 日志里一律先过 `maskSecret()`。
 */

import { createLogger, maskSecret } from "../common/logger.js";

const log = createLogger("SESSION");
import { sfConn } from "./sf_service.js";
import { appState } from "./state.js";

/** 与 `manifest.json` 的 host_permissions 对齐：能取到 sid Cookie 的 Salesforce 页面 */
const SF_TAB_URL_PATTERNS = [
  "https://*.salesforce.com/*",
  "https://*.force.com/*",
  "https://*.salesforce-setup.com/*"
];

/**
 * 能直接当 REST 实例地址用的 org 主机名。
 * 只认 `*.my.salesforce.com` 与 `*.lightning.force.com`（后者归一化成前者）——
 * `*.visualforce.com` / `*.cloudforce.com` 不是 API 域名，拼出来的连接必然失败。
 * 支持 sandbox / 我的域名的双横线形式（`acme--uat.my.salesforce.com`）。
 */
const MY_SF_RE = /(^|\.)[a-z0-9-]+(--[a-z0-9-]+)?\.my\.salesforce\.com$/i;
const LIGHTNING_RE = /(^|\.)[a-z0-9-]+(--[a-z0-9-]+)?\.lightning\.force\.com$/i;

/** 把 Cookie 值（`orgId!sessionId`）拆成 sessionId；格式不符时原样返回 */
function splitSidFromCookieValue(value) {
  const parts = String(value || "").split("!");
  return (parts.length >= 2 ? parts[1] : parts[0]) || "";
}

/** 从主机名或完整 URL 里取主机名；取不到返回 null */
function hostnameOf(hostOrUrl) {
  const raw = String(hostOrUrl || "").trim();
  if (!raw) return null;
  try {
    return (/^https?:\/\//i.test(raw) ? new URL(raw) : new URL(`https://${raw}`)).hostname.toLowerCase();
  } catch (e) {
    return null;
  }
}

/**
 * `*.lightning.force.com` ⇄ `*.my.salesforce.com` 的互换。
 *
 * ⚠️ **这是本模块最要紧的一处修正**（2026-09-28 真机复现）。
 * `xxx.lightning.force.com` 与 `xxx.my.salesforce.com` 是**不同根域**
 * （force.com ≠ salesforce.com），所以挂在 `.salesforce.com` 上的 `sid`
 * **不会**被 `chrome.cookies.getAll({url: "https://xxx.lightning.force.com"})` 命中
 * —— 实测返回 0 枚。
 * 而存储里的 `sf_instance_url` 完全可能就是 lightning 主机名（用户地址栏里那个，
 * 或手工「测试连接」时粘进去的）。上游若直接拿它去查 Cookie，就会一枚都查不到，
 * 表现为「浏览器明明登录着，却一直说没找到登录态」。
 */
function siblingHosts(hostname) {
  const h = String(hostname || "").replace(/^\./, "").toLowerCase();
  const out = new Set();
  if (!h) return out;
  out.add(h);
  if (LIGHTNING_RE.test(h)) {
    out.add(`${h.slice(0, -".lightning.force.com".length)}.my.salesforce.com`);
  } else if (MY_SF_RE.test(h)) {
    out.add(`${h.slice(0, -".my.salesforce.com".length)}.lightning.force.com`);
  }
  return out;
}

/**
 * 主机名 → 可建连接的 **REST API 实例地址**；认不出来返回 null。
 * Lightning 域名不能当 API 域名用，一律换回 `my.salesforce.com`
 * （与 `sf_rest_client` 的归一化方向一致）。接受主机名或完整 URL。
 */
function hostToInstanceUrl(hostOrUrl) {
  const h = hostnameOf(hostOrUrl);
  if (!h) return null;
  if (LIGHTNING_RE.test(h)) {
    return `https://${h.slice(0, -".lightning.force.com".length)}.my.salesforce.com`;
  }
  if (MY_SF_RE.test(h)) return `https://${h}`;
  return null;
}

/** 当前活动标签页的 origin —— 分区 Cookie 兜底查询要用它当 topLevelSite */
async function activeTopLevelSite() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.url) return null;
    const origin = new URL(tab.url).origin;
    return /^https?:/i.test(origin) ? origin : null;
  } catch (e) {
    return null;
  }
}

/** `chrome.cookies.getAll` 的安全包装：任何异常都退化成"没查到" */
async function safeGetAll(details, partitionKey) {
  try {
    const query = partitionKey ? { ...details, partitionKey } : details;
    const cookies = await chrome.cookies.getAll(query);
    return Array.isArray(cookies) ? cookies : [];
  } catch (e) {
    log.debug("读取 Cookie 失败（忽略本次查询）:", e);
    return [];
  }
}

/**
 * 查 `sid` Cookie。
 * 先按常规方式查；**查不到时才**用活动标签页的 origin 当 topLevelSite 再查一次 ——
 * 专门覆盖带 `Partitioned` 属性（CHIPS）的 `sid`：这种 Cookie 不带 partitionKey
 * 是查不出来的，表现就是"明明登录着却说没登录"。
 */
async function findSidCookies(filter = {}) {
  if (!chrome.cookies || typeof chrome.cookies.getAll !== "function") {
    log.warn("当前环境没有 chrome.cookies，无法自动获取会话");
    return [];
  }
  const details = { name: "sid", ...filter };
  const direct = await safeGetAll(details);
  if (direct.length > 0) return direct;

  const topLevelSite = await activeTopLevelSite();
  if (!topLevelSite) return [];
  const partitioned = await safeGetAll(details, { topLevelSite });
  if (partitioned.length > 0) {
    log.info("常规查询未命中，改用分区 Cookie（Partitioned）方式命中 sid");
  }
  return partitioned;
}

/**
 * 收集「已知主机名」：这些是我们**确实知道属于某个 org** 的域名，
 * 拿它们去查 Cookie 比从 Cookie 域反推可靠得多。
 *
 * 两个来源：
 *   ① 已保存的 `sf_instance_url`（它可能带协议、可能是 lightning 域）
 *   ② 当前打开的 Salesforce 标签页（`login_app.js` 用的就是这条路，最稳）
 *
 * 返回的是**去重后的主机名**，且已把同族域名（lightning ⇄ my.salesforce.com）展开。
 *
 * @param {string|null} preferredInstanceUrl
 * @returns {Promise<string[]>}
 */
async function collectKnownHosts(preferredInstanceUrl) {
  const hosts = new Set();
  const addHost = (hostOrUrl) => {
    for (const h of siblingHosts(hostnameOf(hostOrUrl))) hosts.add(h);
  };

  if (preferredInstanceUrl) addHost(preferredInstanceUrl);

  try {
    const tabs = await chrome.tabs.query({ url: SF_TAB_URL_PATTERNS });
    for (const tab of tabs || []) addHost(tab.url);
  } catch (e) {
    log.debug("枚举 Salesforce 标签页失败:", e);
  }

  return [...hosts];
}

/**
 * 按优先级收集候选会话。
 *
 * ── 顺序为什么是这样 ──
 * 优先用「已知主机」：`chrome.cookies.getAll({url})` 返回的是**会被发往该 URL 的
 * Cookie**，所以查到的 sid 天然就属于那个 org，不需要再从 Cookie 域反推
 * （泛域 `.salesforce.com` / `.my.salesforce.com` 反推不出是哪个 org，
 * 这正是 `login_app.js` 里 `getDomain()` 那段的历史隐患）。
 * 只有当「没有已保存实例地址、也没有 Salesforce 标签页」时，才退化到
 * 从 Cookie 域反推——那是最后一条路，能救多少算多少。
 *
 * @param {string|null} preferredInstanceUrl 已保存的实例地址（可为空）
 * @param {string|null} knownBadSid 刚被服务端判定失效的 sid，直接跳过、不做无谓请求
 * @returns {Promise<Array<{sid:string, instanceUrl:string, source:string}>>}
 */
async function collectCandidates(preferredInstanceUrl, knownBadSid) {
  const candidates = [];
  const seenSid = new Set();

  const add = (sid, instanceUrl, source) => {
    if (!sid || !instanceUrl) return;
    if (knownBadSid && sid === knownBadSid) return;
    if (seenSid.has(sid)) return; // 同一个 sid 只验证一次（多标签页同一 org 是常态）
    seenSid.add(sid);
    candidates.push({ sid, instanceUrl, source });
  };

  // ── 优先级 0：已知主机（已保存实例地址 + 打开的 Salesforce 标签页）──
  // 对每个主机名连同它的同族域名一起查，然后把查到的 sid 绑到**这个已知主机**的
  // API 地址上（而不是从 Cookie 域反推）。
  const knownHosts = await collectKnownHosts(preferredInstanceUrl);
  for (const host of knownHosts) {
    const apiUrl = hostToInstanceUrl(host);
    if (!apiUrl) continue; // 不是可建连接的主机（如 *.cloudforce.com）
    const source = preferredInstanceUrl && siblingHosts(hostnameOf(preferredInstanceUrl)).has(host)
      ? "已保存的实例地址"
      : "Salesforce 标签页";
    for (const c of await findSidCookies({ url: `https://${host}` })) {
      add(splitSidFromCookieValue(c.value), apiUrl, source);
    }
  }

  // ── 优先级 1：全部 sid Cookie（域能反推出 org 才收）──
  // 走到这里说明上面一无所获（没有实例地址、也没有 Salesforce 标签页）。
  // 泛域 Cookie（`.salesforce.com` / `.my.salesforce.com`）在这一步必然被跳过 ——
  // 它们推不出具体是哪个 org，硬拼只会得到 `https://null`。
  for (const c of await findSidCookies({})) {
    const instanceUrl = hostToInstanceUrl(c.domain);
    if (!instanceUrl) continue;
    add(splitSidFromCookieValue(c.value), instanceUrl, "浏览器 Cookie");
  }

  return candidates;
}

/**
 * 从浏览器 Cookie 恢复会话。
 *
 * 成功时会同时落三处，保证与手动「测试连接」成功后的状态完全一致：
 *   · `sfConn.connection` / `globalConn`（由 `testConnection` 内部设置）
 *   · `appState.session_id` / `instance_url` / `is_connected`
 *   · `chrome.storage.local`（跨宿主同步：标签页与侧边栏共享）
 *
 * 用户 / 组织信息的补齐交给调用方的 `onSessionRestored()`，本模块不越权。
 *
 * @param {{preferredInstanceUrl?: string|null, knownBadSid?: string|null}} [options]
 * @returns {Promise<{ok:boolean, sid?:string, instanceUrl?:string, source?:string,
 *                    tried:number, reason?:string}>}
 *   `reason`：`no-candidate`（浏览器里根本没有登录态）/ `all-invalid`（有候选但都失效）
 */
export async function recoverSessionFromBrowser(options = {}) {
  const { preferredInstanceUrl = null, knownBadSid = null } = options;

  const candidates = await collectCandidates(preferredInstanceUrl, knownBadSid);
  if (candidates.length === 0) {
    log.info("浏览器里没有可用的 sid Cookie 候选（未登录 Salesforce 时属正常）");
    return { ok: false, reason: "no-candidate", tried: 0 };
  }

  log.info(`发现 ${candidates.length} 个会话候选，按来源优先级逐个验证`);

  let tried = 0;
  for (const candidate of candidates) {
    tried += 1;
    log.debug(
      `验证候选 #${tried}：来源=${candidate.source} 实例=${candidate.instanceUrl} sid=${maskSecret(candidate.sid)}`
    );
    let ok = false;
    try {
      ok = await sfConn.testConnection(candidate.sid, candidate.instanceUrl);
    } catch (e) {
      log.warn(`候选 #${tried} 验证异常:`, e);
    }
    if (!ok) continue;

    appState.session_id = candidate.sid;
    appState.instance_url = candidate.instanceUrl;
    appState.is_connected = true;
    try {
      await chrome.storage.local.set({
        sf_session_id: candidate.sid,
        sf_instance_url: candidate.instanceUrl,
        is_connected: true
      });
    } catch (e) {
      log.warn("写入刷新后的会话失败:", e);
    }
    log.info(`已从浏览器获取可用会话（来源：${candidate.source}）`);
    return {
      ok: true,
      sid: candidate.sid,
      instanceUrl: candidate.instanceUrl,
      source: candidate.source,
      tried
    };
  }

  log.warn(`已尝试 ${tried} 个会话候选，均不可用`);
  return { ok: false, reason: "all-invalid", tried };
}
