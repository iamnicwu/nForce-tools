/**
 * 单元测试: src/biz/schedule.js 的「补报错过提醒」
 *
 * 这是 P0 修复里**用户可见的那一半**：定时任务的接收方是插件页面，
 * 侧边栏一收，`ALARM_TRIGGERED` 就没有接收者了。修法是 SW 先把每次触发落盘
 * （`background.js` 的 `schedule_fired_log`），页面启动时再补一条汇总。
 *
 * 断言重点：
 *   · 早于本页打开的记录 → 补报一次，然后从 storage 清掉（不能每次打开都重报）；
 *   · 晚于本页打开的记录 → **不**补报（那条已经走过实时通知），也不能被误删；
 *   · 没有记录 / storage 报错 → 安静返回 0，绝不阻断启动。
 */

jest.mock('../src/common/utils.js', () => {
  const actual = jest.requireActual('../src/common/utils.js');
  return { ...actual, showNotification: jest.fn() };
});

const FIRED_LOG_KEY = 'schedule_fired_log';

const storageState = { data: {} };

global.chrome = {
  storage: {
    local: {
      get: jest.fn(async (key) => {
        const name = typeof key === 'string' ? key : null;
        if (!name) return { ...storageState.data };
        return { [name]: storageState.data[name] };
      }),
      set: jest.fn(async (patch) => {
        Object.assign(storageState.data, patch);
      }),
      remove: jest.fn(async (key) => {
        const name = typeof key === 'string' ? key : null;
        if (name) delete storageState.data[name];
      }),
    },
  },
  runtime: { onMessage: { addListener: jest.fn() } },
};

const { flushMissedAlarmReminders } = require('../src/biz/schedule.js');
const { showNotification } = require('../src/common/utils.js');

describe('schedule · 补报错过的定时提醒', () => {
  beforeEach(() => {
    storageState.data = {};
    delete storageState.data[FIRED_LOG_KEY];
  });

  test('没有任何触发记录 → 返回 0，不弹通知', async () => {
    await expect(flushMissedAlarmReminders()).resolves.toBe(0);
    expect(showNotification).not.toHaveBeenCalled();
  });

  test('一条早于本页打开的记录 → 补报，并从 storage 清掉', async () => {
    storageState.data[FIRED_LOG_KEY] = [{ name: 'daily_report', label: '日报提醒', at: 1 }];

    await expect(flushMissedAlarmReminders()).resolves.toBe(1);

    expect(showNotification).toHaveBeenCalledTimes(1);
    const [message, type] = showNotification.mock.calls[0];
    expect(message).toContain('日报提醒');
    expect(message).toContain('当时插件页面没有打开');
    expect(type).toBe('info');

    // 清掉 → 下次打开不会重复报
    expect(storageState.data[FIRED_LOG_KEY]).toBeUndefined();
  });

  test('多条 → 汇总成一句，带条数', async () => {
    storageState.data[FIRED_LOG_KEY] = [
      { name: 'a', label: '提醒 A', at: 1 },
      { name: 'b', label: '提醒 B', at: 2 },
      { name: 'c', label: '提醒 C', at: 3 },
      { name: 'd', label: '提醒 D', at: 4 },
    ];

    await expect(flushMissedAlarmReminders()).resolves.toBe(4);

    const [message] = showNotification.mock.calls[0];
    expect(message).toContain('错过了 4 个定时提醒');
    // 只列**最近** 3 条（用户更关心刚才错过了什么），更早的用「等」省略
    expect(message).toContain('提醒 B');
    expect(message).toContain('提醒 D');
    expect(message).not.toContain('提醒 A');
    expect(message).toContain('等');
  });

  test('晚于本页打开的记录（已走过实时通知）→ 不补报，也不能被删掉', async () => {
    const future = Date.now() + 60 * 60 * 1000;
    storageState.data[FIRED_LOG_KEY] = [{ name: 'live', label: '刚触发过', at: future }];

    await expect(flushMissedAlarmReminders()).resolves.toBe(0);
    expect(showNotification).not.toHaveBeenCalled();
    expect(storageState.data[FIRED_LOG_KEY]).toHaveLength(1);
  });

  test('storage 抛错 → 安静返回 0（不能把启动流程带崩）', async () => {
    global.chrome.storage.local.get.mockRejectedValueOnce(new Error('storage broken'));

    await expect(flushMissedAlarmReminders()).resolves.toBe(0);
    expect(showNotification).not.toHaveBeenCalled();
  });
});
