/**
 * 单元测试: src/common/prefs.js 的「请求超时」偏好
 *
 * 为什么值得断言：这个值决定"慢查询会不会被误判成故障"。
 *   · 默认值错了 → 大结果集查询在慢 org 上稳定假报错（用户报的就是这个）；
 *   · 校验没兜住 → 用户填 0 / 0.5 / 空串，超时变成"立即失败"或"永久挂起"，
 *     而界面上看不出异常；
 *   · storage 里存了脏值（手改 / 老版本遗留）→ 必须回落默认并回写修复，
 *     否则每次启动都会用它发请求。
 */

const storageState = { data: {} };

global.chrome = {
  storage: {
    local: {
      get: jest.fn(async (key) => {
        if (Array.isArray(key)) {
          const out = {};
          key.forEach((k) => {
            if (k in storageState.data) out[k] = storageState.data[k];
          });
          return out;
        }
        if (typeof key === 'string') {
          return key in storageState.data ? { [key]: storageState.data[key] } : {};
        }
        return { ...storageState.data };
      }),
      set: jest.fn(async (patch) => {
        Object.assign(storageState.data, patch);
      }),
      remove: jest.fn(async (key) => {
        delete storageState.data[key];
      }),
    },
  },
  runtime: { lastError: null },
};

const {
  PREF_KEYS,
  REQUEST_TIMEOUT_DEFAULT_SEC,
  REQUEST_TIMEOUT_MIN_SEC,
  REQUEST_TIMEOUT_MAX_SEC,
  loadPrefs,
  setPref,
  resetPref,
  getRequestTimeoutSeconds,
} = require('../src/common/prefs.js');

const KEY = PREF_KEYS.requestTimeout;

describe('prefs · 请求超时', () => {
  beforeEach(async () => {
    storageState.data = {};
    await loadPrefs(); // 回到全默认
  });

  test('默认 120 秒（原 45 秒会把慢查询误报成故障）', () => {
    expect(REQUEST_TIMEOUT_DEFAULT_SEC).toBe(120);
    expect(getRequestTimeoutSeconds()).toBe(120);
  });

  test('保存合法值 → 生效并落盘', async () => {
    const result = await setPref(KEY, '300');

    expect(result).toMatchObject({ ok: true, value: 300 });
    expect(getRequestTimeoutSeconds()).toBe(300);
    expect(storageState.data[KEY]).toBe(300);
  });

  test('接受数字型输入（输入框 value 是字符串，但 API 也可能直接给 number）', async () => {
    await expect(setPref(KEY, 60)).resolves.toMatchObject({ ok: true, value: 60 });
  });

  test('低于下限被拒，且不写入 storage、不改变当前值', async () => {
    const result = await setPref(KEY, String(REQUEST_TIMEOUT_MIN_SEC - 1));

    expect(result.ok).toBe(false);
    expect(result.error).toContain('请求超时');
    expect(getRequestTimeoutSeconds()).toBe(120);
    expect(storageState.data[KEY]).toBeUndefined();
  });

  test('高于上限被拒', async () => {
    await expect(setPref(KEY, String(REQUEST_TIMEOUT_MAX_SEC + 1))).resolves.toMatchObject({ ok: false });
  });

  test('小数被拒（界面 step=5，允许小数只会让"我填的"和实际值不一致）', async () => {
    await expect(setPref(KEY, '12.5')).resolves.toMatchObject({ ok: false });
  });

  test('空串被拒（超时没有"清空"语义，恢复默认请用「恢复默认」）', async () => {
    const result = await setPref(KEY, '');
    expect(result.ok).toBe(false);
    expect(result.error).toContain(String(REQUEST_TIMEOUT_DEFAULT_SEC));
  });

  test('恢复默认', async () => {
    await setPref(KEY, '400');
    const result = await resetPref(KEY);

    expect(result).toMatchObject({ ok: true, value: REQUEST_TIMEOUT_DEFAULT_SEC });
    expect(getRequestTimeoutSeconds()).toBe(REQUEST_TIMEOUT_DEFAULT_SEC);
  });

  test('storage 里是脏值 → loadPrefs 回落默认并回写修复', async () => {
    storageState.data[KEY] = 99999;

    await loadPrefs();

    expect(getRequestTimeoutSeconds()).toBe(REQUEST_TIMEOUT_DEFAULT_SEC);
    expect(storageState.data[KEY]).toBe(REQUEST_TIMEOUT_DEFAULT_SEC);
  });
});
