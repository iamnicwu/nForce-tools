/**
 * Salesforce REST 客户端 —— jsforce 的替代实现
 *
 * 状态（2026-09-28）：**已接线**。`sf_service.js` 与 `login_app.js` 都用它建连接，
 * jsforce（1.37MB）已从仓库移除。评审与验证过程见 `plans/review-2026-09-28-jsforce.md`，
 * 协议回归测试见 `tools/jsforce-diff/`。
 *
 * ⚠️ 改这个文件前先读 §「为什么敢删 jsforce」：里面的写法和元素顺序大多是
 *    「按 jsforce 3.2.2 的实测报文对齐」的结果，不是随手写的，改动前请先跑一次
 *    `tools/jsforce-diff/` 的断言，别凭直觉「简化」。
 *
 * ── 为什么敢删 jsforce ──
 * `src/lib/js/jsforce.min.js` 曾是 1.37MB（dist 里 1.40MB），是最大的单个依赖。
 * 但它在本项目里实际被用到的只有 **14 个方法 + 3 个属性**（逐个 grep 调用点确认）：
 *
 *   new Connection({instanceUrl, sessionId, version})   request(url | {method,url,body,headers})
 *   .instanceUrl / .accessToken / .version              query(soql, {autoFetch, maxFetch, scanAll})
 *   identity()                                          queryAll(soql)
 *   describeGlobal()                                    sobject(name).describe()
 *   sobject(name).insert/update/upsert()                metadata.describe/list/retrieve/checkRetrieveStatus()
 *
 * 两处值得单独说：
 *   · `queryAll` —— jsforce **2.x 起已移除**该方法（改由 `query(soql,{scanAll:true})` 承担），
 *     而 `inspector_tools.js` 当时还在 `conn[checked ? "queryAll" : "query"](soql)`，
 *     所以那一版「含已删除记录」勾选后必然抛 `TypeError`。这是差分测试抓到的存量 bug，
 *     不是读文档能看出来的。本模块两条路都提供。
 *   · `sobject().destroy()` / `del()` —— **本模块有意不实现**。按安全策略，扩展不提供删除能力，
 *     调用侧的 `delete` 操作也已一并摘除（见 `plans/review-2026-09-28-jsforce.md` §5）。
 *     为此连 `requestDelete()` 这类无用的删除便捷别名也去掉了。
 *
 * 其余 68 个方法、11 个子客户端（apex / bulk / bulk2 / chatter / analytics / streaming /
 * tooling / oauth2 / soap / cache / process）、OAuth 流程、EventEmitter、
 * regenerator + lodash 运行时 —— 全部是死重。
 *
 * 而且**除了 metadata 之外，上面每一个方法在线上都是普通 REST**（`plans/review-2026-09-28-jsforce.md`
 * 附录 B 记录了从 jsforce 3.2.2 实测抓到的 method + URL + body）。也就是说：
 * 替换工作量的 95% 是把 REST 调用写直白，真正有技术含量的是 Metadata API 那一段 SOAP。
 *
 * ── 设计取舍 ──
 * 1. 只用 `fetch`（扩展页与 service worker 都有），不引入任何依赖。
 * 2. 保留 jsforce 的**调用签名与返回结构**，这样迁移时调用方几乎不用改；
 *    故意不照搬它的内部实现（那些 `$` / `$$` 后缀、Transport 抽象、stream 包装）。
 * 3. 错误统一抛 `SalesforceApiError`，字段与 jsforce 对齐（`message` / `errorCode` /
 *    `statusCode`）—— `sf_service.js` 的 `lastError` 与「401/403 才算真失效」的判定依赖它们。
 * 4. 唯一的**行为改进**：`upsert` 走 `PATCH /composite/sobjects/{obj}/{extIdField}`
 *    批量端点。jsforce 是**每条记录一次请求**（实测确认），批量 200 条就是 200 个串行往返。
 *    这是替换之后顺带拿到的性能收益。
 */

// API 版本的常量与解析器在 `common/api_version.js`。
// 抽出去的理由：内容脚本（`biz/dock.js`）也要读偏好，而偏好层要校验版本号；
// 若把常量留在本文件，一个版本号字符串就会把整个 REST 客户端拖进客户页面。
// 这里保留 import，是因为连接对象的 `version` 兜底要用 `DEFAULT_API_VERSION`。
import { DEFAULT_API_VERSION } from "./api_version.js";

/** Metadata API 的 SOAP 命名空间与端点前缀 */
const METADATA_NS = "http://soap.sforce.com/2006/04/metadata";
const SOAP_ENV_NS = "http://schemas.xmlsoap.org/soap/envelope/";

/**
 * Salesforce 返回的错误结构对齐 jsforce：
 * jsforce 会把 `[{ message, errorCode }]` 摊平到 Error 上，`sf_service` 正是靠
 * `err.errorCode` / `err.statusCode` 区分「会话真的失效」与「请求被 CSP/网络拦住」。
 */
export class SalesforceApiError extends Error {
  /**
   * @param {string} message
   * @param {{errorCode?: string|null, statusCode?: number|null, details?: *}} [opts]
   */
  constructor(message, { errorCode = null, statusCode = null, details = null } = {}) {
    super(message);
    this.name = "SalesforceApiError";
    this.errorCode = errorCode;
    this.statusCode = statusCode;
    this.details = details;
  }
}

/** 去掉 instanceUrl 末尾的斜杠；Lightning 域名换成 my.salesforce.com */
function normalizeInstanceUrl(instanceUrl) {
  let url = String(instanceUrl || "").replace(/\/+$/, "");
  // Lightning 的 *.lightning.force.com 不能当 REST/API 域名用
  url = url.replace(/\.lightning\.force\.com$/i, ".my.salesforce.com");
  return url;
}

/**
 * 把 `[{message,errorCode}]` 解析成可读信息 + errorCode。
 *
 * 后端没给 `errorCode` 时兜底成 `ERROR_HTTP_{status}`（jsforce 正是这个值，实测：
 * 对 500 返回体 `{"error":"..."}` 它给出 `errorCode: "ERROR_HTTP_500"`）。
 * 这一致性有实际意义：`sf_service` 用 `errorCode` 判断「会话真失效」与否。
 */
function extractApiError(body, status) {
  let errorCode = `ERROR_HTTP_${status}`;
  let message = `HTTP ${status}`;
  let details = body;
  try {
    const parsed = typeof body === "string" ? JSON.parse(body) : body;
    const first = Array.isArray(parsed) ? parsed[0] : parsed;
    if (first && typeof first === "object") {
      if (first.errorCode) errorCode = String(first.errorCode);
      if (first.message) message = String(first.message);
      else if (first.error) message = String(first.error);
    }
  } catch (_) {
    if (typeof body === "string" && body.trim()) message = body.trim().slice(0, 500);
  }
  return new SalesforceApiError(message, { errorCode, statusCode: status, details });
}

// ==========================================================================
// SOAP（Metadata API）—— 这是整个替换里唯一非 REST 的部分
// ==========================================================================

/** XML 文本转义 */
function xmlEscape(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** 拼一个 `met:` 命名空间下的元素 */
function el(name, content) {
  if (content === undefined || content === null) return "";
  const inner = Array.isArray(content) ? content.join("") : xmlEscape(content);
  return `<met:${name}>${inner}</met:${name}>`;
}

/**
 * 把 SOAP 响应里的 `<result>` 节点转成 JS 对象。
 *
 * 只做「够用」的通用转换：同名子元素重复出现 → 数组；`true`/`false` → 布尔；
 * 其余保持字符串（Salesforce 的 SOAP 字段大多是字符串，元数据日期也是字符串）。
 * 刻意不追求完整 XML Schema 语义 —— 我们只解析自己发起的那 4 个操作。
 *
 * @param {Element} node
 * @returns {*}
 */
function elementToJs(node) {
  const children = Array.from(node.children || []);
  if (children.length === 0) {
    const text = node.textContent == null ? "" : node.textContent;
    if (text === "true") return true;
    if (text === "false") return false;
    return text;
  }
  const out = {};
  for (const child of children) {
    const key = child.localName || child.nodeName.replace(/^.*:/, "");
    const value = elementToJs(child);
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      if (!Array.isArray(out[key])) out[key] = [out[key]];
      out[key].push(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** 取所有 `<result>` 元素（SOAP Body 的直接子节点） */
function findResults(doc) {
  const all = Array.from(doc.getElementsByTagName("*"));
  return all.filter((n) => (n.localName || n.nodeName.replace(/^.*:/, "")) === "result");
}

/** 解析 SOAP 响应；遇到 SOAP Fault 抛错 */
function parseSoapResponse(xmlText, status) {
  const Parser = globalThis.DOMParser;
  if (typeof Parser !== "function") {
    throw new SalesforceApiError("当前环境没有 DOMParser，无法解析 Metadata API 的 SOAP 响应", {
      errorCode: "SOAP_UNSUPPORTED_ENV",
      statusCode: status,
    });
  }
  const doc = new Parser().parseFromString(xmlText, "text/xml");
  const fault = Array.from(doc.getElementsByTagName("*")).find(
    (n) => (n.localName || n.nodeName.replace(/^.*:/, "")) === "Fault"
  );
  if (fault) {
    const info = elementToJs(fault);
    const detail = info && info.detail ? info.detail : {};
    const message =
      (detail && (detail.exceptionMessage || detail.message)) ||
      info.faultstring ||
      "Metadata API SOAP Fault";
    throw new SalesforceApiError(String(message), {
      errorCode: String((detail && detail.exceptionCode) || info.faultcode || "SOAP_FAULT"),
      statusCode: status,
    });
  }
  return findResults(doc).map(elementToJs);
}

/**
 * 把 Metadata API 的结果补成 jsforce 的形状。
 *
 * jsforce 的 `AsyncResult` / `RetrieveResult` 是**类实例**，字段在构造时就初始化成空值，
 * 所以后端没返回的键也一定存在（`fileProperties` 永远是数组、`messages` 永远是数组、
 * `status`/`zipFile` 永远是字符串、`success` 永远是布尔）。
 * 本模块返回的是纯解析结果，「没有就没有」—— 为了让替换之后不出现
 * 「字段突然 undefined」这类差异，这里统一补齐。
 *
 * 另外 `fileProperties` 在 XML 里只有一条时通用转换会得到**对象**，
 * 这里统一成**数组**（jsforce 也是数组）。
 */
function normalizeMetadataResult(result) {
  const out = result && typeof result === "object" ? result : {};
  const fp = out.fileProperties;
  out.fileProperties = fp === undefined || fp === null ? [] : Array.isArray(fp) ? fp : [fp];
  const msgs = out.messages;
  out.messages =
    msgs === undefined || msgs === null || msgs === "" ? [] : Array.isArray(msgs) ? msgs : [msgs];
  if (out.status === undefined) out.status = "";
  if (out.success === undefined) out.success = false;
  if (out.zipFile === undefined) out.zipFile = "";
  return out;
}

// ==========================================================================
// SObject 写操作（insert / update / upsert）
// 注：**不提供 destroy / del** —— 按安全策略，扩展不做删除，见文件头说明。
// ==========================================================================

class SObjectClient {
  /**
   * @param {SfRestConnection} conn
   * @param {string} name 对象 API 名
   */
  constructor(conn, name) {
    this._conn = conn;
    this._name = name;
  }

  /** 字段描述：GET /sobjects/{name}/describe */
  describe() {
    return this._conn.request({ method: "GET", url: this._conn._api(`/sobjects/${encodeURIComponent(this._name)}/describe`) });
  }

  /**
   * 插入：POST /composite/sobjects
   * body 形如 `{allOrNone:false, records:[{attributes:{type:"Account"},...}]}`
   */
  insert(records) {
    const list = Array.isArray(records) ? records : [records];
    return this._conn.request({
      method: "POST",
      url: this._conn._api("/composite/sobjects"),
      body: {
        allOrNone: false,
        records: list.map((r) => ({ attributes: { type: this._name }, ...r })),
      },
    });
  }

  /**
   * 更新：PATCH /composite/sobjects
   * 每条记录必须带 `Id`（jsforce 把它放在 `id` 字段里，这里跟随该形状）。
   */
  update(records) {
    const list = Array.isArray(records) ? records : [records];
    return this._conn.request({
      method: "PATCH",
      url: this._conn._api("/composite/sobjects"),
      body: {
        allOrNone: false,
        records: list.map((r) => {
          const { Id, ...rest } = r;
          return { id: r.id || Id, attributes: { type: this._name }, ...rest };
        }),
      },
    });
  }

  /**
   * Upsert：**批量**走 `PATCH /composite/sobjects/{obj}/{extIdField}`
   * （jsforce 是每条记录一次 `PATCH /sobjects/{obj}/{extIdField}/{value}`，串行 N 次 → 这里是一次）
   */
  upsert(records, extIdField) {
    const list = Array.isArray(records) ? records : [records];
    const field = extIdField || "Id";
    return this._conn.request({
      method: "PATCH",
      url: this._conn._api(`/composite/sobjects/${encodeURIComponent(this._name)}/${encodeURIComponent(field)}`),
      body: {
        allOrNone: false,
        records: list.map((r) => ({ attributes: { type: this._name }, ...r })),
      },
    });
  }
}

// ==========================================================================
// Metadata API（SOAP）
// ==========================================================================

class MetadataClient {
  /** @param {SfRestConnection} conn */
  constructor(conn) {
    this._conn = conn;
  }

  /**
   * POST 一个 SOAP 信封到 `{instanceUrl}/services/Soap/m/{version}`
   *
   * 命名空间写法与 jsforce 不同但等价：jsforce 把 Metadata 命名空间声明成
   * `soapenv:Header`/`soapenv:Body` 上的**默认命名空间**（元素不带前缀），
   * 这里用 `met:` **前缀**。两者发给 Salesforce 的 URI 与结构完全一致，实测都收。
   *
   * ⚠️ 只有 `SessionHeader`，**不要**再给这四个操作加 `AllOrNoneHeader` ——
   * jsforce 不加（实测抓包），而且 `describeMetadata` / `listMetadata` 根本不接受它。
   * （踩过：曾用一个 `asOfVersion` 参数当开关顺手加了这个头，纯属张冠李戴。）
   */
  async _invoke(operationXml) {
    const conn = this._conn;
    const envelope =
      '<?xml version="1.0" encoding="UTF-8"?>'
      + `<soapenv:Envelope xmlns:soapenv="${SOAP_ENV_NS}" xmlns:met="${METADATA_NS}">`
      + "<soapenv:Header>"
      + `<met:SessionHeader><met:sessionId>${xmlEscape(conn.accessToken)}</met:sessionId></met:SessionHeader>`
      + "</soapenv:Header>"
      + `<soapenv:Body>${operationXml}</soapenv:Body>`
      + "</soapenv:Envelope>";

    const res = await fetch(`${conn.instanceUrl}/services/Soap/m/${conn.version}`, {
      method: "POST",
      headers: {
        "Content-Type": "text/xml; charset=UTF-8",
        SOAPAction: '""',
      },
      body: envelope,
    });
    const text = await res.text();
    if (!res.ok && !/<(?:\w+:)?Fault/.test(text)) {
      throw extractApiError(text, res.status);
    }
    return parseSoapResponse(text, res.status);
  }

  /** describeMetadata：返回 `{metadataObjects:[{xmlName,inFolder,...}]}` */
  async describe(asOfVersion) {
    const version = asOfVersion || this._conn.version;
    const results = await this._invoke(
      `<met:describeMetadata>${el("asOfVersion", version)}</met:describeMetadata>`
    );
    const first = results[0] || {};
    // `metadataObjects` 只有一条时通用转换会得到对象，这里统一成数组
    const objects = first.metadataObjects;
    const list = Array.isArray(objects) ? objects : objects ? [objects] : [];
    // jsforce 会给缺失的 childXmlNames 补 `[]`（实测），跟着补上以便逐字对齐
    for (const o of list) {
      if (!Array.isArray(o.childXmlNames)) o.childXmlNames = [];
    }
    return { ...first, metadataObjects: list };
  }

  /**
   * listMetadata：入参形如 `[{type:"ApexClass", folder?:"MyFolder"}]`
   *
   * 返回**扁平的**组件数组：`[{fullName, type, createdByName, lastModifiedDate, …}]`。
   * 注意这些字段是**顶层**的，不套一层 `fileProperties` —— `inspector_tools.js:543`
   * 直接读 `r["fullName"]` / `r["type"]` / `r["lastModifiedByName"]`，
   * 多套一层那张组件表就会全是空格子。
   */
  async list(queries, asOfVersion) {
    const version = asOfVersion || this._conn.version;
    const list = Array.isArray(queries) ? queries : [queries];
    const queriesXml = list
      .map((q) => `<met:queries>${el("type", q.type)}${q.folder ? el("folder", q.folder) : ""}</met:queries>`)
      .join("");
    return this._invoke(
      `<met:listMetadata>${queriesXml}${el("asOfVersion", version)}</met:listMetadata>`
    );
  }

  /**
   * retrieve：入参 `{unpackaged:{types:[{name,members:[]}],version}}`
   * 返回 `{id, done, state, …}`；调用方接 `.id` 去轮询 `checkRetrieveStatus`。
   *
   * 两处刻意与 jsforce 逐字对齐（都是「哪个写法被生产验证过」的问题，不是风格问题）：
   *   · 包装元素是 `<request>` **不是** WSDL 上的 `retrieveRequest`
   *     —— jsforce 源码就是 `_invoke("retrieve", { request: t })`，
   *       整个 bundle 里 `retrieveRequest` 出现 0 次，而这个写法是
   *       Salesforce Inspector Reloaded 等工具在真实 org 上跑了多年的。
   *   · `<types>` 里 `name` 在 `members` **前面**（Metadata API 的 WSDL 是 sequence 语义，
   *     顺序有实际意义），同样跟随 jsforce 实测报文。
   */
  async retrieve(request) {
    const req = request || {};
    const un = req.unpackaged || {};
    const typesXml = (un.types || [])
      .map((t) => `<met:types>${el("name", t.name)}${(t.members || []).map((m) => el("members", m)).join("")}</met:types>`)
      .join("");
    const unpackagedXml = `<met:unpackaged>${typesXml}${el("version", un.version || this._conn.version)}</met:unpackaged>`;
    const results = await this._invoke(
      `<met:retrieve><met:request>${unpackagedXml}</met:request></met:retrieve>`
    );
    return normalizeMetadataResult(results[0]);
  }

  /**
   * checkRetrieveStatus：返回 `{done, zipFile?, errorMessage?, status, success}`
   *
   * ⚠️ **有意的行为改进（偏差之二）**：这里会把 `includeZip` 真的发出去，
   * 而 jsforce 3.2.2 **完全忽略第二个参数**（bundle 里连 `includeZip` 这个字符串
   * 都不存在，实测抓包也确实没发）。调用方 `inspector_tools.js:598` 传的是 `true`
   * 并且立刻读 `status.zipFile`，所以「显式声明要 zip」才是它本来的意图。
   */
  async checkRetrieveStatus(asyncProcessId, includeZip = true) {
    const results = await this._invoke(
      `<met:checkRetrieveStatus>${el("asyncProcessId", asyncProcessId)}${el("includeZip", includeZip ? "true" : "false")}</met:checkRetrieveStatus>`
    );
    return normalizeMetadataResult(results[0]);
  }
}

// ==========================================================================
// 连接
// ==========================================================================

/**
 * 只实现本项目实际用到的那部分 jsforce Connection。
 */
export class SfRestConnection {
  /**
   * @param {{instanceUrl: string, sessionId?: string, accessToken?: string,
   *          version?: string, serverUrl?: string}} opts
   *   `sessionId` 与 `accessToken` 在本项目的用法里是同一个值（Session ID 直连），
   *   与 jsforce 一致：传 sessionId 时它会同时当成 accessToken。
   *   `serverUrl` 仅为兼容既有调用处而接受，本身不使用（那是 SOAP 登录用的）。
   */
  constructor({ instanceUrl, sessionId, accessToken, version, serverUrl } = {}) {
    if (!instanceUrl) {
      throw new SalesforceApiError("缺少 instanceUrl", { errorCode: "MISSING_INSTANCE_URL" });
    }
    this.instanceUrl = normalizeInstanceUrl(instanceUrl);
    this.accessToken = accessToken || sessionId || null;
    this.version = String(version || DEFAULT_API_VERSION);
    this.serverUrl = serverUrl || null;
    this.loginUrl = "https://login.salesforce.com";
    this.userInfo = undefined;
    this._sobjects = new Map();
    this._metadata = null;
  }

  /** `{instanceUrl}/services/data/v{version}`，与 jsforce 的 `_baseUrl()` 同义 */
  _baseUrl() {
    return `${this.instanceUrl}/services/data/v${this.version}`;
  }

  /**
   * 把路径拼成绝对 URL。
   * 绝对 URL、以及以 `/services/` 开头的路径原样使用；其余相对路径挂到 `_baseUrl()` 下。
   */
  _api(path) {
    if (/^https?:\/\//i.test(path)) return path;
    if (path.startsWith("/services/")) return this.instanceUrl + path;
    return this._baseUrl() + (path.startsWith("/") ? path : `/${path}`);
  }

  /**
   * 通用请求。接受两种调用形式，覆盖项目里全部用法：
   *   request("/services/data/v68.0/limits/")
   *   request({method, url, body, headers})
   *
   * @param {string|{method?: string, url: string, body?: *, headers?: object}} opts
   * @returns {Promise<*>} 解析后的 JSON（204 无内容时为 null）
   */
  async request(opts) {
    const { method, url, body, headers } =
      typeof opts === "string" ? { method: "GET", url: opts } : opts || {};
    const absolute = this._api(url);
    const sendBody =
      body === undefined || body === null
        ? undefined
        : typeof body === "string"
          ? body
          : JSON.stringify(body);

    const finalHeaders = {
      Authorization: `Bearer ${this.accessToken}`,
      Accept: "application/json",
      ...(sendBody !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(headers || {}),
    };

    const res = await fetch(absolute, { method: method || "GET", headers: finalHeaders, body: sendBody });
    const text = await res.text();
    if (!res.ok) throw extractApiError(text, res.status);
    if (res.status === 204 || !text) return null;
    try {
      return JSON.parse(text);
    } catch (_) {
      // Bulk 结果之类会返回 CSV；保持原样交给调用方
      return text;
    }
  }

  /**
   * SOQL 查询。
   *
   * 分页语义与 jsforce 3.2.2 实测行为对齐（见 review 文档 §附录 B）：
   *   · `autoFetch` **默认 false**：只发一次请求，返回首页 + `done` / `nextRecordsUrl`
   *     （实测确认 jsforce 3.2.2 的默认值是 false，不是历史版本里的 true）
   *   · `autoFetch:true`：沿 `nextRecordsUrl` 一直取到 `done` 或累计 **maxFetch**（默认 10000，与 jsforce 同）
   *   · 返回结构保持 `{records, done, nextRecordsUrl, totalSize}`，`done` 反映**最后一页**
   *
   * 「调用方拿到的是全部记录、需要自己截断」这一点与 jsforce 一致，不要改。
   *
   * @param {string} soql
   * @param {{autoFetch?: boolean, maxFetch?: number}} [opts]
   */
  query(soql, opts) {
    // jsforce 3.x 用 `scanAll: true` 选 `/queryAll`（`queryAll` 方法在 2.x 已被移除）
    return this._query(opts && opts.scanAll ? "queryAll" : "query", soql, opts);
  }

  /**
   * `queryAll`：与 `query` 唯一区别是走 `/queryAll`，结果**包含已删除/归档记录**。
   *
   * ⚠️ jsforce **3.2.2 里没有这个方法**（已从 bundle 里确认：只有 `scanAll` 选项，
   * 没有任何 `queryAll` 方法定义）。而 `inspector_tools.js:168` 写的是
   * `conn[queryAll.checked ? "queryAll" : "query"](soql)` —— 所以那一版「含已删除记录」
   * 勾选后必然抛 `TypeError: conn[fetcher] is not a function`（差分测试抓到的存量 bug）。
   * 这里**同时**提供 `queryAll()` 与 `query(soql,{scanAll:true})` 两条路：
   * 前者让现有调用点不改也能跑通，后者对齐 jsforce 3.x 的正规写法。
   */
  queryAll(soql, opts) {
    return this._query("queryAll", soql, opts);
  }

  /** `query` / `queryAll` 的公共实现（两者除资源名外语义完全相同） */
  async _query(resource, soql, opts = {}) {
    const { autoFetch = false, maxFetch = 10000 } = opts || {};
    let result = await this.request({
      method: "GET",
      url: `${this._baseUrl()}/${resource}?q=${encodeURIComponent(soql)}`,
    });
    this._absolutizeNext(result);
    if (!autoFetch) return result;

    const records = Array.isArray(result.records) ? result.records.slice() : [];
    while (!result.done && result.nextRecordsUrl && records.length < maxFetch) {
      result = await this.request({ method: "GET", url: result.nextRecordsUrl });
      this._absolutizeNext(result);
      if (Array.isArray(result.records)) records.push(...result.records);
    }
    result.records = records.length > maxFetch ? records.slice(0, maxFetch) : records;
    return result;
  }

  /**
   * 把 `nextRecordsUrl` 由**相对路径**补成**绝对 URL**，与 jsforce 的返回值逐字对齐
   * （实测 jsforce 返回 `https://xxx.my.salesforce.com/services/data/v68.0/query/01g…`）。
   *
   * 这不是洁癖：`inspector_tools.js:173` 会把 `result.nextRecordsUrl` 直接交回
   * `conn.request(...)`。留相对路径虽然也能被 `_api()` 兜住，但一旦哪天有人
   * 换个方式拼接（先 `_baseUrl()` 再拼），就会得到 `…/v68.0/services/data/v68.0/…`
   * 这种重复路径 —— 补成绝对 URL 可以从根上消掉这类风险。
   */
  _absolutizeNext(result) {
    if (!result || typeof result !== "object") return result;
    const next = result.nextRecordsUrl;
    if (typeof next === "string" && next && !/^https?:\/\//i.test(next)) {
      result.nextRecordsUrl = this.instanceUrl + (next.startsWith("/") ? next : `/${next}`);
    }
    return result;
  }

  /**
   * 取下一页。可以传 `nextRecordsUrl`（完整 URL 或 `/services/data/...` 路径），
   * 也可以只传 locator（如 `0gZxx-2000`），后者与 jsforce 的 `queryMore` 行为一致。
   */
  async queryMore(urlOrLocator) {
    const raw = String(urlOrLocator || "");
    const url = raw.startsWith("/") || /^https?:/i.test(raw)
      ? raw
      : `${this._baseUrl()}/query/${encodeURIComponent(raw)}`;
    return this.request({ method: "GET", url });
  }

  /**
   * 当前用户身份：两次 GET
   *   ① `{baseUrl}` → `{identity}`
   *   ② `{identity}?format=json&oauth_token=...` → 用户信息
   * 结果缓存在 `this.userInfo`，与 jsforce 相同（第二次调用只发 1 个请求）。
   */
  async identity() {
    let identityUrl = this.userInfo && this.userInfo.url;
    if (!identityUrl) {
      const base = await this.request({ method: "GET", url: this._baseUrl() });
      identityUrl = base && base.identity;
      if (!identityUrl) {
        throw new SalesforceApiError("身份接口未返回 identity 地址", {
          errorCode: "IDENTITY_MISSING",
          statusCode: 200,
        });
      }
    }
    const separator = identityUrl.includes("?") ? "&" : "?";
    const info = await this.request({
      method: "GET",
      url: `${identityUrl}${separator}format=json&oauth_token=${encodeURIComponent(this.accessToken)}`,
    });
    this.userInfo = { id: info.user_id, organizationId: info.organization_id, url: info.id };
    return info;
  }

  /** 全部 sObject 清单：GET /sobjects */
  describeGlobal() {
    return this.request({ method: "GET", url: `${this._baseUrl()}/sobjects` });
  }

  /**
   * 取（并缓存）某个对象的写操作客户端。
   * 与 jsforce 一样按对象名缓存实例。
   * @param {string} name
   */
  sobject(name) {
    if (!this._sobjects.has(name)) this._sobjects.set(name, new SObjectClient(this, name));
    return this._sobjects.get(name);
  }

  /** Metadata API 客户端（惰性创建） */
  get metadata() {
    if (!this._metadata) this._metadata = new MetadataClient(this);
    return this._metadata;
  }
}

export default SfRestConnection;
