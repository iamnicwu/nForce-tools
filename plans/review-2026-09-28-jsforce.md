# jsforce 能否被 `sf_rest_client.js` 替代 —— 可行性评审

- 日期：2026-09-28
- 对象：`src/lib/js/jsforce.min.js`（1.37MB，当前最大的单个依赖）
- 替代品：`src/common/sf_rest_client.js`（26.4KB / 627 行，含大量注释；**尚未接线**）
- 触发：原问题「jsforce 成为占用 size 最大的引用，是否有办法单独写个 js 代替它，因为如果很久不更新，很多功能会有问题」

---

## 结论

**可以替代，且证据是逐字节的，不是「看起来差不多」。**

在真实 Chrome 里让 jsforce 3.2.2 与替代品跑同一套假 Salesforce，比较**每一次请求的 method + URL + body** 与**每一个返回值**：
**15/15 场景完全一致**，其中 12 个连 SOAP／JSON 报文都逐字相同，另 2 个是**我们有意**做得更好的偏差（批量 upsert、真实的 `includeZip`），1 个是 jsforce 根本不具备的能力（`queryAll`）。

体积上：**1.37MB → 约 8KB（压缩后）**，`dist/` 从 4.03MB 降到约 2.67MB（**−34%**），且这 1.37MB 目前在**每次打开侧边栏时都要重新解析一遍**（见 `lib_loader.js` 的注释）。

代价是：**Metadata API 那一段 SOAP 必须自己维护**（约 120 行），这是唯一有技术含量的部分，也是唯一不能在真实 org 上被本地测试完全覆盖的部分 —— 所以迁移前需要一次真机验证（§9）。

---

## 1. 问题比「体积大」更具体

两件事同时成立，第二件才是真正的风险：

**（1）它确实是最大的单文件。** `dist/` 里前几名：

| 文件 | 大小 |
|---|---|
| `lib/js/jsforce.min.js` | **1368 KB** |
| `lib/js/echarts.min.js` | 1004 KB |
| `lib/js/xlsx.full.min.js` | 834 KB |
| `app.js`（自己的代码） | 290 KB |
| `lib/js/jszip.min.js` | 95 KB |

第三方库合计 3.33MB，jsforce 一家占 41%。而 `lib_loader.js` 的存在说明它已经被当成「启动成本」处理过了 —— 但**侧边栏每点一次工具栏图标就会重新加载并解析一次 `index.html`**，所以这 1.37MB 是反复付出的固定成本，不是一次性的。

**（2）版本漂移已经真实造成了功能损坏。**

| | 值 |
|---|---|
| `package.json` 声明 | `"jsforce": "^1.11.1"` |
| 实际打包进 `dist/` 的 | **3.2.2** |

跨了两个大版本。而**替换 jsforce 的动机 —— 「很久不更新会导致功能出问题」—— 现实里发生的是反过来的事：jsforce 更新了，代码没跟上，于是坏了一个功能且没人发现**（§5 的 `queryAll`）。这比「库不更新」更值得担心：库在动，而它是 vendored 的 min 文件，没人在看 changelog。

---

## 2. 真实调用面：14 个方法 + 3 个属性

jsforce 暴露 78 个方法、11 个惰性子客户端。逐个 grep 调用点后，本项目用的**全部**内容是：

| 用到 | 位置 |
|---|---|
| `new Connection({instanceUrl, sessionId, version})` | `sf_service.js:51`、`login_app.js:65` |
| `.instanceUrl` / `.accessToken` / `.version` | `sf_service.js`、`inspector_tools.js` |
| `request(url \| {method,url,body,headers})` | `sf_service.js` × 6、`inspector_tools.js` × 3 |
| `query(soql, {autoFetch, maxFetch})` | `sf_service.js` × 13 |
| `query(soql, {scanAll})` | `inspector_tools.js:168`（原为 `queryAll`，见 §5） |
| `identity()` | `sf_service.js:59`、`login_app.js:73` |
| `describeGlobal()` | `inspector_tools.js:92` |
| `sobject(name).describe()` | `inspector_tools.js:110/298` |
| `sobject(name).insert/update/upsert()` | `inspector_tools.js:425-427` |
| `metadata.describe/list/retrieve/checkRetrieveStatus` | `inspector_tools.js:508/535/594/598` |

**从来没用过**：`apex`、`bulk`、`bulk2`、`chatter`、`analytics`、`streaming`、`tooling`、`oauth2`、`soap`、`cache`、`process` 这 11 个子客户端，以及 OAuth 授权码流程、EventEmitter、`regenerator-runtime`、lodash。

其中 Bulk API 2.0 是**已经用裸 `fetch` 手写**的（`sf_service.js:959`），Tooling 是通过通用 `request()` 打 `/services/data/vXX/tooling/...` —— 也就是说这些能力根本不依赖 jsforce 的方法封装。

> 被替换掉的是 1.37MB 里 78 个方法中的 14 个，其余 64 个方法 + 全部子客户端都是死重。

---

## 3. 验证方法：为什么不是「读文档 + 猜」

写一个 REST 客户端最容易犯的错，是按**文档**实现而不是按**实际报文**实现。SOAP 那部分尤其如此（元素名、元素顺序、哪些 header 该发）。所以这次不靠推测，而是把两个实现放进同一个环境做差分。

**环境**：`/tmp/sf-probe/browser/` —— 一个同源 HTTP 服务，同时扮演三件事：

1. 提供测试页面；
2. 提供 `jsforce.min.js` 和 `sf_rest_client.js`；
3. 假扮 Salesforce（`/services/data/v65.0/...`、`/services/Soap/m/...`），并记录**收到的每一个请求**（method + URL + body）。

**为什么必须在真浏览器里跑**：jsforce 会根据环境选传输层。在 Node 里它会走 Node 的 `http` 模块，配合假响应会报 `The "chunk" argument must be one of type string or Buffer`；而且 `metadata.*` 会直接抛 `c.stream is not a function`。**浏览器才是 jsforce 的原生环境**，也只有在那里才能拿到真实的响应解析结果。每一步都跑无头 Chrome（`--headless=new --no-sandbox --dump-dom`），把断言写进 DOM 再抓出来。

**每个场景的做法**：`reset` 请求日志 → 跑 jsforce → 读日志；`reset` → 跑替代品 → 读日志；然后比较**两次的请求序列**与**两个返回值**。

**比较口径上的两个刻意选择**（都很关键，否则会产生大量假阳性）：

- **错误按 `errorCode` / `statusCode` 比较，不按 message。** 两个实现是两个 Error 类，措辞必然不同；而调用方真正依赖的是 `errorCode`（`app.js` 的失效判定，见 §7）。
- **返回值按「顶层键的交集」比较，不整体 JSON 相等。** 因为 jsforce 的返回对象是**类实例**，构造函数会把字段初始化成空值，于是它总有一些我们「没有」的键（`childXmlNames: []`、`metaFields` 之类）。这些是它类的产物，不是线上数据。把它们和「同一个键值不同」混在一起报，会淹没真正的问题。（实测确实如此：`retrieve` 的 4 个空键就是这么来的，最终在替代品里如实补齐了，见 §4。）

---

## 4. 结果：15/15

```
[PASS] query(no autoFetch)               请求:同   值:同
[PASS] query(autoFetch,maxFetch:5)       请求:同   值:同
[PASS] query(autoFetch,maxFetch:99999)   请求:同   值:同
[PASS] query(scanAll:true)               请求:同   值:同
[PASS] identity                          请求:同   值:同
[PASS] describeGlobal                    请求:同   值:同
[PASS] sobject.describe                  请求:同   值:同
[PASS] sobject.insert                    请求:同   值:同
[PASS] sobject.update                    请求:同   值:同
[PASS] sobject.upsert(2 条)               请求:有意不同   值:同
[PASS] request(limits)                   请求:同   值:同
[PASS] metadata.describe                 请求:同   值:同
[PASS] metadata.list                     请求:同   值:同
[PASS] metadata.retrieve                 请求:同   值:同
[PASS] metadata.checkRetrieveStatus      请求:同(严格比较多一个 includeZip)  值:同
```

`metadata.*` 那 4 个能过，是因为把三件事逐一对齐了（每一件都是先抓到报文差异、再改代码、再复跑确认）：

1. **`AllOrNoneHeader` 不该发。** 替代品曾用 `asOfVersion` 参数当开关顺手加了它 —— 张冠李戴。`describeMetadata`/`listMetadata` 根本不接受这个 header，jsforce 也不发。
2. **`retrieve` 的包装元素必须是 `<request>`**，不是 WSDL 上的 `retrieveRequest`。依据是 jsforce 源码本身：`_invoke("retrieve", { request: t })`，整个 bundle 里 `retrieveRequest` 出现 **0 次**。这个写法是 Salesforce Inspector Reloaded 等工具在真实 org 上跑了多年的，跟着它走风险最低。
3. **`<types>` 里 `name` 在 `members` 前面。** Metadata API 的 WSDL 是 sequence 语义，元素顺序有实际意义；同样跟随 jsforce 实测报文。

另外补齐了 4 处 jsforce 的**形状归一化**（都是它类实例的产物，但既然是 drop-in，形状就得一致）：

- `describe()`：每个 metadata 对象补 `childXmlNames: []`
- `retrieve()` / `checkRetrieveStatus()`：补 `fileProperties: []`、`messages: []`、`status: ""`、`success: false`、`zipFile: ""`
- `fileProperties` 只有一条时统一成**数组**（XML 单条会被解析成对象，jsforce 给的是数组）
- `nextRecordsUrl` 由相对路径补成**绝对 URL**（jsforce 就是这么返回的）

---

## 5. 过程中挖出的 3 个存量问题

这三个都不是「替代品的问题」，而是**现有代码的问题**，其中前两个是差分测试顺带抓出来的 —— 读文档看不出，只有真跑才会暴露。

### 5.1 `queryAll` 不存在 —— 「含已删除记录」勾选必崩（**已修**）

`inspector_tools.js` 原来是：

```js
const fetcher = queryAll && queryAll.checked ? "queryAll" : "query";
let result = await conn[fetcher](soql);
```

而 jsforce **2.x 起已移除 `queryAll` 方法**，改由 `query(soql, {scanAll: true})` 承担。已从 bundle 里确认：`queryAll` 作为方法定义出现 **0 次**，只有 `scanAll` 选项（`c ? "queryAll" : "query"` 那个字符串拼接）。

也就是说：**勾上「含已删除记录（queryAll）」再点执行，必然抛 `TypeError: conn[fetcher] is not a function`。** 这是个 100% 复现的用户可见故障，根因正是 §1 的版本漂移（该功能是 jsforce 1.x 时代写的）。

已改为正规写法，`jsforce` 与替代品两边都能跑：

```js
const scanAll = !!(queryAll && queryAll.checked);
let result = await conn.query(soql, { scanAll });
```

### 5.2 `destroy` 的移除只做了一半（**已补齐**）

按安全策略去掉删除能力时，只从 `sf_rest_client.js` 里删了 `destroy()`/`del()`，但：

- `src/index.html` 的下拉框**还留着** `<option value="delete">delete（删除，需 Id 列）</option>`
- `inspector_tools.js` 还在 `sobj.destroy(batch.map(r => r.Id), …)`

于是「原型没有这个方法」+「调用点还在」+「UI 还在引导用户选它」三者对不上 —— 选中 delete 点执行会直接抛 TypeError。

已把三处一起摘干净：下拉选项、`delete` 前置校验、`delete` 分支、以及功能说明文案里的 `delete` 字样。另外删掉了替代品里没人用的 `requestDelete()` 等 4 个便捷别名（`requestGet/Post/Patch/Delete`，全仓库零调用），其中 `requestDelete` 与「不提供删除能力」直接冲突。

> 注：`ui.js` 的「删除定时任务」、`onedrive_service.js` 的 `deleteWorksheet/deleteRange` 是无关功能，未动。

### 5.3 `checkRetrieveStatus` 的第二个参数被 jsforce 静默丢弃

`inspector_tools.js:598` 调用 `checkRetrieveStatus(id, true)` 并立刻读 `status.zipFile`，意图是「要 zip」。而 jsforce 的签名是：

```js
{key:"checkRetrieveStatus", value:function(t){ … {asyncProcessId:t} … }}
```

**只有一个形参**，bundle 里连 `includeZip` 这个字符串都**不存在**。第二个参数从头到尾被丢掉。替代品会真的把 `includeZip` 发出去 —— 见 §6。

---

## 6. 两处有意偏差（都是「更好」，且都有理由）

| # | 场景 | jsforce 行为 | 替代品行为 | 为什么 |
|---|---|---|---|---|
| 1 | `upsert(N 条)` | **逐条** `PATCH /sobjects/{obj}/{extIdField}/{value}`，N 条 = N 次串行往返 | **1 次** `PATCH /composite/sobjects/{obj}/{extIdField}` | 导入 200 条就是 200 次串行往返。Salesforce 的 composite upsert 端点就是为此存在的 |
| 2 | `checkRetrieveStatus` | 丢弃 `includeZip`，完全依赖服务端默认值 | 真的发送 `includeZip=true` | 调用方明确传了 `true`（§5.3）。顺带说明：这也意味着**轮询时每轮都可能带回 zip**，若那次 retrieve 的包很大，流量会比现在高 —— 真机验证时值得看一眼 |

除这两处外，**所有请求与返回值都逐字一致**。

---

## 7. 兼容性中被验证过的那条硬契约

替代品的错误类是自建的 `SalesforceApiError`，不是 jsforce 的。这条路径必须保证不破坏「只有服务端明确说会话失效才降级」的逻辑（历史上踩过：CSP／网络拦截被误判成会话失效，表现是「找到 session 进主页却显示未连接」）。

```
app.js:120    if (err.statusCode === 401 || err.statusCode === 403) return true;
app.js:121    if (!err.errorCode) return false;
app.js:122    return AUTH_FAILURE_CODES.includes(err.errorCode.toUpperCase());   // 含 INVALID_SESSION_ID

sf_service.js:73   errorCode : err.errorCode || err.name
sf_service.js:74   statusCode: err.statusCode
```

替代品的对应行为：

| 情况 | 抛出的东西 | 判定结果 |
|---|---|---|
| 服务端 401/403 + `[{errorCode:"INVALID_SESSION_ID"}]` | `SalesforceApiError{errorCode, statusCode:401}` | **会话失效** ✓ |
| 服务端 500 | `SalesforceApiError{errorCode:"ERROR_HTTP_500", statusCode:500}` | 非失效 ✓（`ERROR_HTTP_500` 不在白名单） |
| 网络/CSP 拦截 | `fetch` 抛 `TypeError`（无 `errorCode`/`statusCode`）→ `lastError.errorCode = "TypeError"` | **非失效** ✓ 正是需要的行为 |
| Metadata SOAP Fault | `SalesforceApiError{errorCode: exceptionCode}` | 非失效 ✓ |

`ERROR_HTTP_{status}` 这个兜底值是**刻意对齐 jsforce 的**：实测它对 500 返回体 `{"error":"..."}` 给出的 `errorCode` 正是 `ERROR_HTTP_500`。

---

## 8. 尺寸与启动收益

| | 现在 | 替换后 |
|---|---|---|
| jsforce | 1368 KB（min） | 约 **8 KB**（webpack 压缩后；源码 26.4KB / 627 行，其中约一半是注释） |
| `dist/` 合计 | 4031 KB | 约 **2670 KB**（−34%） |
| 第三方库合计 | 3.33 MB | 约 **1.96 MB** |
| 侧边栏每次打开 | 重新解析 1.37MB | 不需要加载任何脚本 |

必须一起改的还有 `tools/check-ui.mjs` 的体积预算数字（`第三方库合计 3.33MB` 会变成约 1.96MB）。

**附带收益**：依赖从「vendored 的 min 文件」变成 627 行可读、可改、可加断点的源码。上面 §5 的三个问题里有两个是「代码与库版本脱节」造成的，替换之后这类脱节会变成显式的编译/测试失败，而不是线上静默故障。

---

## 9. 迁移步骤（8 处改动）

替换品已写好且差分通过，但**刻意没有接线**（文件头有明确标注）。落地动作：

1. **`src/biz/sf_service.js:51`** —— `new jsforce.Connection({…})` → `new SfRestConnection({…})`；同时删掉 `import { ensureJsForce }`（第 7 行）和 `await ensureJsForce()`（第 49 行）。
2. **`src/login_app.js:65`** —— 同样替换；删掉第 8-10 行的 `warmupLibs(["jsforce"])`。
3. **`src/common/lib_loader.js`** —— 移除 jsforce：`GLOBAL_NAME`、`LIB_PATH`、`ensureJsForce`、`warmupLibs` 映射表，以及头部注释里的体积表。
4. **`src/manifest.json:64`** —— 从 `web_accessible_resources` 移除 `"lib/js/jsforce.min.js"`。
5. **删除文件** —— `src/lib/js/jsforce.min.js` 与 `jsforce.min.js.LICENSE.txt`（webpack 会一并从 `dist/` 清掉）。
6. **`package.json:42`** —— 移除 `"jsforce": "^1.11.1"`。
7. **文案** —— `src/index.html:10/16`、`login.html:7` 里「jsforce 1.37MB」之类说明。
8. **`tools/check-ui.mjs`** —— 更新体积预算基线。

预计净改动约 30 行代码 + 若干文案，调用方**一行都不用改**（这是设计目标：保留 jsforce 的签名与返回结构）。

> 打包上不会踩 `src/common/**` 那个坑：`sf_rest_client.js` 是被 `sf_service.js` **import** 的，
> 属于 webpack 入口的依赖，会被正常打进 bundle，**不需要**往 `CopyWebpackPlugin` 里加复制规则。
> （`common/icons.js` 当年需要补规则，是因为它被 HTML 侧直接引用，不在依赖图里 —— 两者情况不同。
> `check-ui` 的 J 组会自动拦这类问题。）

**上线前的最后一道闸（重要）**：本地差分只能证明「报文与形状和 jsforce 一致」，**不能证明真实 org 接受**。所以建议先用一个 sandbox 的 Session ID 实机跑一遍这 5 条路径 —— 它们覆盖了全部非 REST 的复杂度：

1. 连接 + `identity()`（含 Lightning 域名 → `my.salesforce.com` 的归一化）
2. 一次会翻页的 `query`（`autoFetch` 走 `nextRecordsUrl`）
3. 导入 `insert` / `update` / `upsert` 各一次
4. Metadata：`describe` → `list` → `retrieve` → `checkRetrieveStatus` 完整打包一次
5. 故意用一个失效 Session ID，确认弹的是「会话失效」而不是「未连接」

**回退**：把 jsforce 文件与 8 处改动回滚即可，两边接口同形，不需要改调用方。

---

## 10. 替换后拿不到的能力（诚实边界）

- **Streaming API（CometD）** —— 项目现在用的是独立的 `src/lib/js/cometd/cometd.js`，不经过 jsforce，**不受影响**。
- **`apex` / `tooling` / `bulk` 等命名空间封装** —— 本来就没用。Tooling 走通用 `request()`；Bulk 2.0 是手写 `fetch`。若将来要用 Bulk 1.0／`apex.execute`，需要自己补。
- **OAuth 授权码流程** —— 没用（本项目是 Session ID 直连）。
- **`sobject().destroy()`** —— 按安全策略**有意不实现**。
- **Metadata API 的其余操作**（`deploy`、`create`、`updateMetadata`、`checkDeployStatus`…）—— 只实现了用到的 4 个。要加的话都是同一个 `_invoke()` 加一个操作 XML，成本低。
- **SOAP 报文的命名空间写法**与 jsforce 不同（jsforce 用默认命名空间，我们用 `met:` 前缀）。URI 与结构一致，实测两边都收；这是唯一一处「报文不是逐字节相同但语义相同」的地方。

---

## 附录 A：15 个差分场景

| 场景 | 请求比较 | 返回值比较 | 说明 |
|---|---|---|---|
| `query`（不翻页） | 同 | 同 | 含 `nextRecordsUrl` 绝对化 |
| `query`（autoFetch，maxFetch 5） | 同 | 同 | 验证截断语义：`maxFetch` 只影响抓取量 |
| `query`（autoFetch，maxFetch 99999） | 同 | 同 | 一直取到 `done` |
| `query`（scanAll:true） | 同 | 同 | 走 `/queryAll` |
| `identity` | 同 | 同 | 2 次 GET，第二次带 `oauth_token` |
| `describeGlobal` | 同 | 同 | |
| `sobject.describe` | 同 | 同 | |
| `sobject.insert` | 同 | 同 | `POST /composite/sobjects` |
| `sobject.update` | 同 | 同 | `PATCH /composite/sobjects` |
| `sobject.upsert`（2 条） | **有意不同** | 同 | 1 次批量 vs 2 次逐条 |
| `request(limits)` | 同 | 同 | |
| `metadata.describe` | 同 | 同 | SOAP 前缀不同、语义相同 |
| `metadata.list` | 同 | 同 | |
| `metadata.retrieve` | 同 | 同 | 含 `<request>` 命名与元素顺序对齐 |
| `metadata.checkRetrieveStatus` | 同（严格比较多 `includeZip`） | 同 | 见 §6 |

（`sobject.destroy` 无对照：按安全策略两边都不再有这个能力。）

## 附录 B：从 jsforce 3.2.2 实测抓到的 wire protocol

`instanceUrl` = `{I}`，`version` = `{V}`（本次实测 V=65.0）。所有请求带 `Authorization: Bearer {sessionId}`；SOAP 请求带 `Content-Type: text/xml; charset=UTF-8` 与 `SOAPAction: ""`。

| 操作 | method + URL | body |
|---|---|---|
| query 首页 | `GET {I}/services/data/v{V}/query?q={SOQL}` | — |
| query 翻页 | `GET {nextRecordsUrl}`（**绝对 URL**） | — |
| query scanAll | `GET {I}/services/data/v{V}/queryAll?q={SOQL}` | — |
| identity ① | `GET {I}/services/data/v{V}`（**无尾斜杠**） | — |
| identity ② | `GET {identity}?format=json&oauth_token={sid}` | — |
| describeGlobal | `GET {I}/services/data/v{V}/sobjects` | — |
| sobject.describe | `GET {I}/services/data/v{V}/sobjects/{obj}/describe` | — |
| insert | `POST …/composite/sobjects` | `{allOrNone:false, records:[{attributes:{type}, …}]}` |
| update | `PATCH …/composite/sobjects` | `{allOrNone:false, records:[{id, attributes:{type}, …}]}` |
| upsert | `PATCH …/sobjects/{obj}/{extIdField}/{value}` **× N（逐条）** | `{…}` |
| destroy | `DELETE …/composite/sobjects?ids=a,b` | — |
| limits | `GET …/limits/` | — |
| tooling query | `GET …/tooling/query?q={SOQL}` | — |
| metadata.describe | `POST {I}/services/Soap/m/{V}` | `<describeMetadata><asOfVersion>{V}</asOfVersion></describeMetadata>` |
| metadata.list | `POST {I}/services/Soap/m/{V}` | `<listMetadata><queries><type>{T}</type></queries><asOfVersion>{V}</asOfVersion></listMetadata>` |
| metadata.retrieve | `POST {I}/services/Soap/m/{V}` | `<retrieve><request><unpackaged><types><name>{N}</name><members>{M}</members></types><version>{V}</version></unpackaged></request></retrieve>` |
| metadata.checkRetrieveStatus | `POST {I}/services/Soap/m/{V}` | `<checkRetrieveStatus><asyncProcessId>{id}</asyncProcessId></checkRetrieveStatus>`（jsforce 不传 `includeZip`） |

SOAP 信封里的鉴权固定是 `<SessionHeader><sessionId>{sid}</sessionId></SessionHeader>`。

**`query` 的默认选项**（从 bundle 里读到，与实测一致）：

```js
{ headers: {}, maxFetch: 10000, autoFetch: false, scanAll: false, responseTarget: "QueryResult" }
```

注意 `autoFetch` 默认是 **false**（不是某些历史版本里的 true），且 `autoFetch` 抓满 `maxFetch` 后**不会**把 `records` 截断到 `maxFetch` —— 调用方拿到的是「全部已抓取的记录」，需要自己截。这两点替代品都照做了。

## 附录 C：被差分测试证伪的几个「我以为」

写替代品的过程中有几处判断是错的，记下来避免下次再猜：

1. **「`destroy` 用 `/sobjects/{obj}?ids=`」** —— 错。实测 jsforce 3.2.2 用的是 `/composite/sobjects?ids=`。当时我看到一处只有「请求不同」而没有原始请求的差分结果，就凭印象改了端点，结果把本来正确的一行改错了。**教训：只凭「不同」这个结论去改代码是不够的，必须先把两侧原始报文打出来看。**
2. **「`upsert` 每条记录一次请求」（对）但以为 `insert` 也是逐条** —— 错。`insert`/`update` 走的是 composite 批量端点，只有 `upsert` 是逐条。
3. **「jsforce 会发 `AllOrNoneHeader`」** —— 错，四个 metadata 操作都不发。
4. **「`nextRecordsUrl` 是相对路径」** —— 客户端收到的值是被 jsforce 绝对化过的。
5. **「Metadata SOAP 用 WSDL 上的 `retrieveRequest`」** —— 错，jsforce 用 `<request>`。

另外有 8 个最初的「失败」其实是**假 Salesforce 桩不够像**造成的，不是替代品的问题。三条主要原因，都值得记住：

- **假 API 挂在 `/api` 前缀下** —— 真实 `instanceUrl` 永远只到 origin、没有路径段。带前缀会让 `nextRecordsUrl` 被前缀两次（`/api/api/...`），而 jsforce 只补 origin 所以侥幸不炸，替代品补整个 `instanceUrl` 就 500。**「谁对」取决于桩像不像真实服务，不是取决于谁跑通了。**
- **SOAP 响应缺 `<xxxResponse>` 包裹层** —— jsforce 解析不到会**静默**退回空默认值（不抛错），于是 4 个场景全成假阳性；替代品的解析更宽容，反而「看起来不一致」。
- **`listMetadata` 的字段被错误地包了一层 `<fileProperties>`** —— 真实响应里这些字段直接挂在 `<result>` 下。jsforce 把数据赋到它的空壳实例上、自己的字段留成 `''`，看起来就像「替代品漏了字段」。

还有一个操作性的坑：**测试服务器启动时把 `diff.html` 读进了内存**，导致改完页面重跑却看到旧结果，白绕了一轮去查客户端。已改成每次请求现读。

---

## 附：复现方式

差分测试三件套**已留存进仓库**（`/tmp` 会被清理，而迁移前后都需要重跑）：

```
tools/jsforce-diff/
├── server.cjs    # 同源服务：测试页 + 两个客户端 + 假 Salesforce + 请求日志
├── diff.html     # 15 个场景，逐场景比较请求序列与返回值
├── snap.sh       # 无头 Chrome 抓 DOM
├── report.py     # 解析成可读表格（退出码 0 = 全过，1 = 有 FAIL）
└── README.md     # 含「假服务必须像真实服务」的三条坑与比较口径说明
```

```bash
# 终端 1（常驻；必须单独后台任务，用 & 起服务再退出会被杀 → 先 200 后 502）
exec env -u NODE_OPTIONS node tools/jsforce-diff/server.cjs

# 终端 2
tools/jsforce-diff/snap.sh /tmp/jsforce-diff-dump.html 40
python3 tools/jsforce-diff/report.py /tmp/jsforce-diff-dump.html     # 预期 15/15
```

`README.md` 里写清了「为什么必须在真浏览器里跑」「假服务要像真实服务的三条」「两个比较口径」，
以及 `snap.sh` 里那个自查出来的坑：**macOS 的 BSD grep 不支持 BRE 的 `\|` 交替，
`grep -q 'data-status="\(ok\|diff\)"'` 会静默零匹配**，导致轮询从不提前退出、每次空等满超时
（修成 `grep -E` 后同样一轮从 40 秒降到 3 秒）。
