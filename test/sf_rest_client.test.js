/**
 * 单元测试: src/common/sf_rest_client.js —— 「会话中途失效自动续期」
 *
 * 为什么这个测试值得单独写：这段逻辑的失败模式全是**静默**的。
 *   · 重试多了一次 → 请求量翻倍、且重复提交（POST 尤其危险）；
 *   · 重试用旧 token → 再吃一个 401，看起来像"重试没用"；
 *   · 非鉴权失败也去续期 → 真正的错误（404 版本不对、500 服务端炸）被盖成
 *     "重试后仍然失败"，排查时完全看不到原本的原因；
 *   · 钩子本身抛异常把原始 401 盖掉 → 同上。
 * 这些在真机上都不容易一眼看出来，但在这里是几行断言的事。
 *
 * 另一条同样重要的断言：**默认（没挂钩子）时行为必须与改动前逐字节一致**，
 * 因为 `tools/jsforce-diff/` 是逐请求比对 method + URL 的金标准基线。
 */

const { default: SfRestConnection } = require('../src/common/sf_rest_client.js');

const INSTANCE = 'https://acme.my.salesforce.com';

/** 造一个 fetch 响应 */
const res = (status, body) => ({
  ok: status >= 200 && status < 300,
  status,
  text: async () => (body === undefined ? '' : JSON.stringify(body)),
});

const UNAUTHORIZED = [
  { message: 'Session expired or invalid', errorCode: 'INVALID_SESSION_ID' },
];

describe('sf_rest_client · 会话中途失效自动续期', () => {
  let calls;

  beforeEach(() => {
    calls = [];
    global.fetch = jest.fn(async (url, init) => {
      const auth = (init && init.headers && init.headers.Authorization) || '';
      calls.push({ url, method: (init && init.method) || 'GET', auth, body: init && init.body });
      return res(200, { ok: true });
    });
  });

  afterEach(() => {
    delete global.fetch;
  });

  const makeConn = (onAuthFailure = null) => {
    const conn = new SfRestConnection({ instanceUrl: INSTANCE, sessionId: 'SID_OLD', version: '68.0' });
    conn.onAuthFailure = onAuthFailure;
    return conn;
  };

  describe('默认关闭（没挂钩子）时行为不变', () => {
    test('401 直接抛出，且只发一次请求', async () => {
      global.fetch = jest.fn(async () => res(401, UNAUTHORIZED));
      const conn = makeConn(null);

      await expect(conn.request('/limits/')).rejects.toThrow(/Session expired/);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('钩子存在也不影响成功路径（不触发、不重发）', async () => {
      const hook = jest.fn();
      const conn = makeConn(hook);

      await expect(conn.request('/limits/')).resolves.toEqual({ ok: true });
      expect(hook).not.toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('挂上钩子后：401 → 换会话 → 原请求重发一次', () => {
    test('用新 token 重发同一条请求，并把结果正常返回', async () => {
      global.fetch = jest.fn(async (url, init) => {
        const auth = init.headers.Authorization;
        calls.push({ url, method: init.method, auth, body: init.body });
        return auth === 'Bearer SID_OLD' ? res(401, UNAUTHORIZED) : res(200, { limits: 42 });
      });
      const hook = jest.fn(async () => ({ sessionId: 'SID_NEW' }));
      const conn = makeConn(hook);

      await expect(conn.request('/limits/')).resolves.toEqual({ limits: 42 });

      expect(hook).toHaveBeenCalledTimes(1);
      expect(calls).toHaveLength(2);
      expect(calls[0].auth).toBe('Bearer SID_OLD');
      expect(calls[1].auth).toBe('Bearer SID_NEW');
      // 重发的必须是**同一条**请求
      expect(calls[1].url).toBe(calls[0].url);
      expect(calls[1].method).toBe(calls[0].method);
      // 连接对象上的 token 也要跟着换掉，后续请求与 Bulk 下载才用得上
      expect(conn.accessToken).toBe('SID_NEW');
    });

    test('POST 的 method 与 body 原样保留（401 意味着请求没被受理，重发是安全的）', async () => {
      global.fetch = jest.fn(async (url, init) => {
        calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body });
        return init.headers.Authorization === 'Bearer SID_OLD' ? res(401, UNAUTHORIZED) : res(201, { id: '001' });
      });
      const conn = makeConn(async () => ({ sessionId: 'SID_NEW' }));

      await expect(
        conn.request({ method: 'POST', url: '/sobjects/Account', body: { Name: 'Acme' } })
      ).resolves.toEqual({ id: '001' });

      expect(calls[1].method).toBe('POST');
      expect(calls[1].body).toBe('{"Name":"Acme"}');
      expect(calls[1].body).toBe(calls[0].body);
    });

    test('403 同样算会话失效', async () => {
      global.fetch = jest.fn(async (url, init) =>
        init.headers.Authorization === 'Bearer SID_OLD' ? res(403, []) : res(200, { ok: true })
      );
      const conn = makeConn(async () => ({ sessionId: 'SID_NEW' }));
      await expect(conn.request('/limits/')).resolves.toEqual({ ok: true });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    test('换的是另一个 org 时，重试要打到新实例地址上', async () => {
      global.fetch = jest.fn(async (url, init) => {
        calls.push({ url, auth: init.headers.Authorization });
        return url.startsWith('https://other.my.salesforce.com') ? res(200, { ok: true }) : res(401, UNAUTHORIZED);
      });
      const conn = makeConn(async () => ({
        sessionId: 'SID_NEW',
        instanceUrl: 'https://other.my.salesforce.com',
      }));

      await expect(conn.request('/limits/')).resolves.toEqual({ ok: true });
      expect(calls[1].url).toBe('https://other.my.salesforce.com/services/data/v68.0/limits/');
      expect(conn.instanceUrl).toBe('https://other.my.salesforce.com');
    });

    test('同样适用于 `_query()` 那种"先拼好绝对 URL"的调用（换 org 后基址也要跟着改）', async () => {
      global.fetch = jest.fn(async (url, init) => {
        calls.push({ url, auth: init.headers.Authorization });
        return url.startsWith('https://other.my.salesforce.com') ? res(200, { records: [] }) : res(401, UNAUTHORIZED);
      });
      const conn = makeConn(async () => ({
        sessionId: 'SID_NEW',
        instanceUrl: 'https://other.my.salesforce.com',
      }));

      await conn.query('SELECT Id FROM Account');
      expect(calls[0].url).toBe('https://acme.my.salesforce.com/services/data/v68.0/query?q=SELECT%20Id%20FROM%20Account');
      expect(calls[1].url).toBe('https://other.my.salesforce.com/services/data/v68.0/query?q=SELECT%20Id%20FROM%20Account');
    });

    test('只重试一次：新会话也 401 就如实抛出，不再继续换', async () => {
      global.fetch = jest.fn(async () => res(401, UNAUTHORIZED));
      const hook = jest.fn(async () => ({ sessionId: 'SID_NEW' }));
      const conn = makeConn(hook);

      await expect(conn.request('/limits/')).rejects.toThrow(/Session expired/);
      expect(hook).toHaveBeenCalledTimes(1);
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('不该续期的情况一律不续期', () => {
    test.each([400, 404, 500, 503])('%i 不触发钩子、不重发', async (status) => {
      global.fetch = jest.fn(async () => res(status, [{ message: 'boom' }]));
      const hook = jest.fn(async () => ({ sessionId: 'SID_NEW' }));
      const conn = makeConn(hook);

      await expect(conn.request('/limits/')).rejects.toThrow(/boom/);
      expect(hook).not.toHaveBeenCalled();
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('钩子返回 null（浏览器里也没有可用会话）→ 抛原始 401，不重发', async () => {
      global.fetch = jest.fn(async () => res(401, UNAUTHORIZED));
      const conn = makeConn(async () => null);

      await expect(conn.request('/limits/')).rejects.toMatchObject({
        errorCode: 'INVALID_SESSION_ID',
        statusCode: 401,
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('钩子抛异常 → 不能把原始 401 盖掉（排错时要看到真正的原因）', async () => {
      global.fetch = jest.fn(async () => res(401, UNAUTHORIZED));
      const conn = makeConn(async () => {
        throw new Error('恢复流程自身炸了');
      });

      await expect(conn.request('/limits/')).rejects.toMatchObject({
        errorCode: 'INVALID_SESSION_ID',
        statusCode: 401,
      });
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('钩子返回空对象（没拿到 token）→ 不重发', async () => {
      global.fetch = jest.fn(async () => res(401, UNAUTHORIZED));
      const conn = makeConn(async () => ({}));
      await expect(conn.request('/limits/')).rejects.toThrow(/Session expired/);
      expect(global.fetch).toHaveBeenCalledTimes(1);
    });

    test('fetch 直接抛（网络/CSP 拦截）→ 不触发钩子', async () => {
      global.fetch = jest.fn(async () => {
        throw new TypeError('Failed to fetch');
      });
      const hook = jest.fn(async () => ({ sessionId: 'SID_NEW' }));
      const conn = makeConn(hook);

      await expect(conn.request('/limits/')).rejects.toThrow(/Failed to fetch/);
      expect(hook).not.toHaveBeenCalled();
    });
  });

  describe('renewAuth()：给绕过 request() 的调用方（Bulk 结果下载）用', () => {
    test('公开可用，且与自动续期共用同一套逻辑', async () => {
      const conn = makeConn(async () => ({ sessionId: 'SID_NEW' }));
      expect(conn.accessToken).toBe('SID_OLD');

      await expect(conn.renewAuth()).resolves.toBe(true);
      expect(conn.accessToken).toBe('SID_NEW');
    });

    test('没挂钩子时返回 false，不抛异常', async () => {
      const conn = makeConn(null);
      await expect(conn.renewAuth()).resolves.toBe(false);
      expect(conn.accessToken).toBe('SID_OLD');
    });
  });
});
