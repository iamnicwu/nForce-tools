# jsforce ↔ sf_rest_client 差分测试

验证 `src/common/sf_rest_client.js`（jsforce 的替代品）与 jsforce 3.2.2
**在报文与返回值上是否等价**。评审结论见 [`plans/review-2026-09-28-jsforce.md`](../../plans/review-2026-09-28-jsforce.md)。

不是在读文档，而是让两个实现跑同一套假 Salesforce，比较**每一次请求的 method + URL + body**
与**每一个返回值**。

> **2026-09-28 起 jsforce 已从仓库移除**（`src/lib/js/jsforce.min.js` 1.37MB 已删、已不在
> `manifest.json` / `package.json`）。所以这套工具默认在 **assert 模式** 下工作：不再需要
> jsforce，而是拿 `expected.json`（当年逐字节差分通过时的快照）当基线。若哪天要重新引入
> jsforce 做一次性核对，把 `jsforce.min.js` 放回 `src/lib/js/` 即自动切回 **compare 模式**。

## 三种模式（由页面自己判定，不用手动切）

| 模式 | 触发条件 | 对照物 | 用途 |
|---|---|---|---|
| `compare` | `/jsforce.min.js` 能加载 | 现场跑 jsforce | 一次性核对（改协议时的金标准） |
| `assert` | 加载不到 jsforce，但 `expected.json` 在 | `expected.json` 快照 | **日常回归**（现在的默认） |
| `capture` | 两者都没有 | 无 | 重新生成 `expected.json` |

模式会打在 `#__report__` 的 `data-mode` 上，`report.py` 的 SUMMARY 里也会写出来。

## 跑

要两个终端：服务器是常驻的，不能和跑测试的那条命令挤在一起
（用 `&` 起服务再退出，任务结束进程会被杀，表现是先 200 后 502，Chrome 抓到的就成错误页了）。

```bash
# 终端 1（常驻）
exec env -u NODE_OPTIONS node tools/jsforce-diff/server.cjs     # 监听 127.0.0.1:8788

# 终端 2
chmod +x tools/jsforce-diff/snap.sh
tools/jsforce-diff/snap.sh /tmp/jsforce-diff-dump.html 40
python3 tools/jsforce-diff/report.py /tmp/jsforce-diff-dump.html
```

`report.py` 退出码 0 = 全部一致，1 = 有 FAIL。

> 端口 8788 常被上一轮没清掉的进程占着。**旧进程跑的是旧代码**（`diff.html` 是每次现读的、
> 但 `server.cjs` 是启动时载入的），会出现「路由 404 / 新加的 `/expected.json` 不生效」这类怪象。
> 先 `lsof -nP -iTCP:8788 -sTCP:LISTEN` 确认，必要时 kill 掉再起。

## 现在的预期结果

```
STATUS : ok
SUMMARY: 15/15 场景一致（模式 assert）
```

两处**有意**的偏差（脚本里已标注，不算失败）：

1. `sobject.upsert(N 条)` —— 替代品用 1 次 `PATCH /composite/sobjects/{obj}/{extIdField}`，
   jsforce 是逐条 N 次 `PATCH /sobjects/{obj}/{extIdField}/{value}`。
   （请求条数本就不同，`skipReq` 对这一项不做请求对照，只比值。）
2. `metadata.checkRetrieveStatus` —— 替代品真的发送 `includeZip`，jsforce 丢弃该参数
   （它的形参只有一个，bundle 里连 `includeZip` 这个字符串都不存在）。

## 重新生成 expected.json

删掉 `tools/jsforce-diff/expected.json` 再跑一次即进 `capture` 模式，页面的
`#__report__` 上会多一个 `data-capture`（JSON）。把它按下面结构落盘即可：

```bash
python3 - <<'PY'
import html, json, re, pathlib
src = pathlib.Path('/tmp/jsforce-diff-dump.html').read_text(encoding='utf-8', errors='replace')
blk = re.search(r'id="__report__"(.*?)</div>', src, re.S).group(1)
cap = json.loads(html.unescape(re.search(r'data-capture="(.*?)"(?:\s|>)', blk, re.S).group(1)))
pathlib.Path('tools/jsforce-diff/expected.json').write_text(
    json.dumps({'_comment': 'jsforce 3.2.2 差分基线', '_jsforceVersion': '3.2.2',
                'scenarios': cap}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
PY
```

**capture 的键名口径必须与 assert 的读取口径一致**（都是宽松归一化后的 `reqs` +
`valueKey`），否则断言会假失败。`capture` 会一并记 `reqsStrict` 供严格列比对。

## 加新场景

在 `diff.html` 的 `scenarios` 数组里加一行 `[名字, (c) => c.xxx()]`，
两个客户端用的是同样的调用（`mkJf()` / `mkProto()` 只差构造函数），
再在 `server.cjs` 里补对应路由。**不要忘记**：假服务的响应要尽量与真实 Salesforce 一致 ——
下面三条都是这个脚本里踩过的坑，桩不像真实服务时产生的全是假阳性。
加完场景后要**重新采集一次 `expected.json`**（否则 assert 会报「基线里没有这个场景」）。


## 假服务必须像真实服务的三条（踩过）

1. **不要给假 API 加挂载前缀**（如 `/api/`）。
   真实 `instanceUrl` 永远只到 origin、没有路径段。带前缀会让 `nextRecordsUrl`
   被前缀两次（`/api/api/...`）—— 而 jsforce 只补 origin 所以侥幸不炸、
   替代品补整个 `instanceUrl` 就 500。**「谁对」取决于桩像不像，而不是谁跑通了。**
2. **SOAP 响应必须包一层 `<xxxResponse>`**，例如
   `<soapenv:Body><describeMetadataResponse><result>…</result></describeMetadataResponse></soapenv:Body>`。
   缺了它 jsforce 会**静默**退回空默认值（不抛错），4 个 metadata 场景会全成假阳性。
3. **`listMetadata` 的字段直接挂在 `<result>` 下**，不套 `<fileProperties>`；
   只有 `checkRetrieveStatus` 的 `fileProperties` 才是包裹形式（0..n 条）。
   搞错的话 jsforce 会把数据赋到它的空壳实例上、自己的字段留成 `''`，
   看起来就像「替代品漏了字段」。

## 两个比较口径（否则大量假阳性）

- **错误按 `errorCode` / `statusCode` 比较**，不按 message。两个实现是两个 Error 类，
  措辞必然不同；调用方真正依赖的是 `errorCode`（`app.js` 的会话失效判定）。
- **返回值按「顶层键的交集」比较**，不整体 JSON 相等。jsforce 的返回对象是**类实例**，
  构造函数会把字段初始化成空值，所以它总有一些我们「没有」的键
  （`childXmlNames: []`、`fileProperties: []` …）。那是它类的产物、不是线上数据；
  混在一起报会淹没真正的问题。只在单边出现的键会单独列出，可见但不判失败。

## SOAP 报文的比较

替代品用 `met:` 前缀，jsforce 用默认命名空间（`xmlns=` 声明在 `Header`/`Body` 上）。
URI 与结构一致、实测两边都收，所以脚本会把 `<?xml?>`、`xmlns` 声明、元素前缀
归一化掉再比 —— 这是唯一一处「语义相同但字节不同」的地方。

`strict` 列会把归一化**之前**的差异也显示出来（目前只有 `includeZip` 一处，即上表第 2 条）。
