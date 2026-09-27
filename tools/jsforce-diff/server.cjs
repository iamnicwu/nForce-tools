/**
 * jsforce ↔ sf_rest_client 差分测试服务器
 *
 * 一个同源 HTTP 服务，同时扮演三件事：
 *   1. 提供测试页面（diff.html）
 *   2. 提供待比较的两个客户端（jsforce.min.js / sf_rest_client.js）
 *   3. 假扮 Salesforce，并记录收到的每一个请求
 *
 * ── 为什么必须在真浏览器里跑 ──
 * jsforce 会按环境选传输层：在 Node 里它走 Node 的 http 模块，配合假响应会报
 * `The "chunk" argument must be one of type string or Buffer`，`metadata.*` 还会
 * 直接抛 `c.stream is not a function`。**浏览器才是它的原生环境**，也只有在那里
 * 才拿得到真实的响应解析结果。
 *
 * ── 用法 ──
 *   exec env -u NODE_OPTIONS node tools/jsforce-diff/server.cjs   # 常驻（必须单独后台任务）
 *   tools/jsforce-diff/snap.sh /tmp/jsforce-diff-dump.html 40      # 另一个终端跑
 *
 * ── 写这个假服务时踩过的三个坑（照抄时要留意）──
 *   1. **不要给假 API 加挂载前缀**（如 /api）。真实 instanceUrl 永远只到 origin、
 *      没有路径段。带前缀会让 nextRecordsUrl 被前缀两次（/api/api/...）。
 *   2. **SOAP 响应必须包一层 `<xxxResponse>`**。缺了它 jsforce 会**静默**退回空默认值
 *      （不抛错），4 个 metadata 场景会全成假阳性。
 *   3. **listMetadata 的字段直接挂在 `<result>` 下**，不套 `<fileProperties>`
 *      （只有 checkRetrieveStatus 的 fileProperties 才是包裹形式）。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

/** 仓库根：本文件在 <repo>/tools/jsforce-diff/ 下 */
const REPO = path.resolve(__dirname, '..', '..');
const PAGE = path.join(__dirname, 'diff.html');

const seen = [];

function apiHandler(req, res, body) {
  const json = (o, code = 200) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  const xml = (s) => { res.writeHead(200, { 'Content-Type': 'text/xml; charset=UTF-8' }); res.end(s); };

  // 真实的 Salesforce SOAP 响应会把 <result> 包在 <opName>Response> 里（坑 2）
  const env = (inner, responseName) =>
    '<?xml version="1.0" encoding="UTF-8"?><soapenv:Envelope '
    + 'xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:met="http://soap.sforce.com/2006/04/metadata">'
    + '<soapenv:Body><' + responseName + '>' + inner + '</' + responseName + '></soapenv:Body></soapenv:Envelope>';

  // ── SOQL 分页：每页 3 条，共 9 条 ──────────────────────────────
  if (req.url.startsWith('/services/data/v65.0/query?')) {
    return json({ totalSize: 9, done: false, nextRecordsUrl: '/services/data/v65.0/query/0gZ-2000',
      records: Array.from({ length: 3 }, (_, i) => ({ Id: 'a' + i, Name: 'N' + i })) });
  }
  const mp = /^\/services\/data\/v65\.0\/query\/(0gZ-\d+)/.exec(req.url);
  if (mp) {
    const start = Number(mp[1].split('-')[1]);
    const done = start + 3 >= 9;
    return json({ totalSize: 9, done,
      nextRecordsUrl: done ? undefined : '/services/data/v65.0/query/0gZ-' + (start + 3),
      records: Array.from({ length: 3 }, (_, i) => ({ Id: 'a' + (start + i), Name: 'N' + (start + i) })) });
  }
  if (/^\/services\/data\/v65\.0\/queryAll\?/.test(req.url)) {
    return json({ totalSize: 2, done: true,
      records: [{ Id: 'a0', Name: 'N0' }, { Id: 'd1', Name: 'D1', IsDeleted: true }] });
  }

  // ── 身份 ──────────────────────────────────────────────────────
  // jsforce 请求的是**无尾斜杠**的 /v65.0，两个都收
  if (req.url === '/services/data/v65.0/' || req.url === '/services/data/v65.0') {
    return json({ identity: 'http://127.0.0.1:' + PORT + '/id/00Dxx/005xx' });
  }
  if (req.url.startsWith('/id/')) {
    return json({ user_id: '005xx', organization_id: '00Dxx', display_name: 'Tester', name: 'Tester', username: 't@example.com' });
  }

  // ── 描述 ──────────────────────────────────────────────────────
  if (req.url === '/services/data/v65.0/sobjects') {
    return json({ encoding: 'UTF-8', sobjects: [{ name: 'Account', createable: true }, { name: 'Contact', createable: true }] });
  }
  if (req.url === '/services/data/v65.0/sobjects/Account/describe') {
    return json({ name: 'Account', label: 'Account', fields: [
      { name: 'Id', label: 'ID', type: 'id', nillable: false },
      { name: 'Name', label: 'Name', type: 'string', nillable: false }] });
  }

  // ── 写操作 ────────────────────────────────────────────────────
  if (req.url === '/services/data/v65.0/composite/sobjects' && req.method === 'POST') {
    return json(JSON.parse(body).records.map((r, i) => ({ id: '001new' + i, success: true, errors: [] })));
  }
  if (req.url === '/services/data/v65.0/composite/sobjects' && req.method === 'PATCH') {
    return json(JSON.parse(body).records.map((r, i) => ({ id: r.id || '001upd' + i, success: true, errors: [] })));
  }
  // 替代品的批量 upsert。id 由 extId 值推导（而非请求内下标），
  // 这样「逐条 N 次」与「批量 1 次」两条路产生的 id 才可比。
  if (/^\/services\/data\/v65\.0\/composite\/sobjects\/\w+\/\w+$/.test(req.url) && req.method === 'PATCH') {
    return json(JSON.parse(body).records.map((r) => ({ id: '001' + (r.Ext__c || ''), success: true, errors: [] })));
  }
  // jsforce 的逐条 upsert：PATCH /sobjects/{obj}/{extIdField}/{value}
  const up = /^\/services\/data\/v65\.0\/sobjects\/(\w+)\/(\w+)\/(.+)$/.exec(req.url);
  if (up && req.method === 'PATCH') {
    return json({ id: '001' + decodeURIComponent(up[3]), success: true, errors: [] });
  }
  if (req.url.startsWith('/services/data/v65.0/composite/sobjects?ids=') && req.method === 'DELETE') {
    return json(req.url.split('ids=')[1].split(',').map((id) => ({ id, success: true, errors: [] })));
  }

  // ── 其它 REST ─────────────────────────────────────────────────
  if (req.url === '/services/data/v65.0/limits/') {
    return json({ DailyApiRequests: { Max: 100000, Remaining: 99000 } });
  }
  if (req.url.startsWith('/services/data/v65.0/tooling/query?q=')) {
    return json({ totalSize: 1, done: true, records: [{ QualifiedApiName: 'MyEvent__e', Label: 'My Event' }] });
  }

  // ── Metadata API（SOAP）────────────────────────────────────────
  if (req.url.startsWith('/services/Soap/m/')) {
    const mo = (o) => '<metadataObjects>'
      + '<directoryName>' + o.d + '</directoryName>'
      + '<inFolder>' + o.f + '</inFolder>'
      + '<metaFile>false</metaFile>'
      + '<suffix>' + o.s + '</suffix>'
      + '<xmlName>' + o.n + '</xmlName>'
      + '</metadataObjects>';
    if (body.includes('describeMetadata')) {
      return xml(env('<result>'
        + mo({ n: 'ApexClass', d: 'classes', f: 'false', s: 'cls' })
        + mo({ n: 'Report', d: 'reports', f: 'true', s: 'report' })
        + '<organizationNamespace></organizationNamespace>'
        + '<partialSaveAllowed>true</partialSaveAllowed>'
        + '<testRequired>false</testRequired>'
        + '</result>', 'describeMetadataResponse'));
    }
    // FileProperties 字段集。坑 3：listMetadata 直接挂 <result> 下，
    // 只有 checkRetrieveStatus 才用 <fileProperties> 包裹。
    const fpInner = '<createdById>005</createdById><createdByName>Tester</createdByName>'
      + '<createdDate>2026-01-01T00:00:00.000Z</createdDate>'
      + '<fileName>classes/MyClass.cls</fileName><fullName>MyClass</fullName><id></id>'
      + '<lastModifiedById>005</lastModifiedById><lastModifiedByName>Tester</lastModifiedByName>'
      + '<lastModifiedDate>2026-02-02T00:00:00.000Z</lastModifiedDate><type>ApexClass</type>';
    if (body.includes('listMetadata')) {
      return xml(env('<result>' + fpInner + '</result>', 'listMetadataResponse'));
    }
    if (body.includes('checkRetrieveStatus')) {
      // 真实响应在没有 message 时**不会**输出 <messages/>（发了空元素，
      // jsforce 会造出一条 {fileName:'',problem:''} 的假记录）
      return xml(env('<result>'
        + '<done>true</done>'
        + '<fileProperties>' + fpInner + '</fileProperties>'
        + '<id>04pFAKE</id>'
        + '<status>Succeeded</status>'
        + '<success>true</success>'
        + '<zipFile>UEsDBAoAAAAAAA==</zipFile>'
        + '</result>', 'checkRetrieveStatusResponse'));
    }
    if (body.includes('retrieve')) {
      return xml(env('<result><done>false</done><id>04pFAKE</id><state>Queued</state></result>', 'retrieveResponse'));
    }
    return xml(env('<result><done>true</done></result>', 'okResponse'));
  }

  json({ error: 'unhandled ' + req.method + ' ' + req.url }, 500);
}

let PORT = 8788;
const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    // 只记录真正打到「Salesforce」的请求，静态资源不掺进来
    if (req.url.startsWith('/services/') || req.url.startsWith('/id/')) {
      seen.push({ method: req.method, url: req.url, body: body || null });
      return apiHandler(req, res, body);
    }
    if (req.url === '/' || req.url === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      // 每次请求现读：启动时缓存过一次，结果改了页面重跑却看到旧结果，白绕一轮
      return res.end(fs.readFileSync(PAGE, 'utf8').replace('__ORIGIN__', 'http://127.0.0.1:' + PORT));
    }
    if (req.url === '/jsforce.min.js') {
      // jsforce 已于 2026-09-28 从仓库移除，所以这个文件**通常不存在**。
      // 不存在时返回 404 —— 页面会据此切到「对照基线快照」的断言模式，不再需要 jsforce。
      const p = path.join(REPO, 'src/lib/js/jsforce.min.js');
      if (!fs.existsSync(p)) { res.writeHead(404); return res.end('jsforce removed'); }
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return fs.createReadStream(p).pipe(res);
    }
    if (req.url === '/sf_rest_client.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript' });
      return fs.createReadStream(path.join(REPO, 'src/common/sf_rest_client.js')).pipe(res);
    }
    if (req.url === '/expected.json') {
      // 经 jsforce 差分验证过的协议基线；缺失时页面进入 capture 模式用于重新生成
      const p = path.join(__dirname, 'expected.json');
      if (!fs.existsSync(p)) { res.writeHead(404); return res.end('no baseline'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return fs.createReadStream(p).pipe(res);
    }
    if (req.url === '/seen') return (res.writeHead(200, { 'Content-Type': 'application/json' }), res.end(JSON.stringify(seen)));
    if (req.url === '/reset') { seen.length = 0; return (res.writeHead(200), res.end('ok')); }
    res.writeHead(404); res.end('nf');
  });
});

server.listen(PORT, '127.0.0.1', () => { PORT = server.address().port; console.log('ready on ' + PORT); });
