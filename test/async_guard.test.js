/**
 * 单元测试: src/common/async_guard.js —— 「同一动作只跑一趟」
 *
 * 为什么值得断言：这个守卫的失败模式全是静默的。
 *   · 没 await 内部异步 → 守卫在活儿还没干完时就解锁（等于没防住），
 *     表现和"没加守卫"完全一样；
 *   · 解锁写错位置 → 一次异常之后按钮永久禁用；
 *   · 不同动作共用 key → 两个无关功能互相卡住。
 */

jest.mock('../src/common/utils.js', () => ({
  showNotification: jest.fn(),
}));
jest.mock('../src/common/dom.js', () => ({
  $: jest.fn(() => null),
}));

const { guardAction, isActionRunning } = require('../src/common/async_guard.js');
const { showNotification } = require('../src/common/utils.js');

/** 造一个可手动 resolve 的 task */
function deferredTask() {
  let release;
  const task = jest.fn(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  return { task, release: () => release() };
}

const fakeEvent = () => ({ preventDefault: jest.fn() });

describe('async_guard · guardAction', () => {
  test('正常路径：拦默认行为 + 执行一次 + 结束后解锁', async () => {
    const event = fakeEvent();
    const task = jest.fn(async () => {});

    await guardAction('daily', task)(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(task).toHaveBeenCalledTimes(1);
    expect(isActionRunning('daily')).toBe(false);
  });

  test('执行期间重复触发 → 不重复执行，只提示一句', async () => {
    const { task, release } = deferredTask();
    const guarded = guardAction('daily', task);

    const first = guarded(fakeEvent());
    await guarded(fakeEvent()); // 第二次：应该被挡下

    expect(task).toHaveBeenCalledTimes(1);
    expect(showNotification).toHaveBeenCalledWith(expect.stringContaining('还在执行'), 'info');

    release();
    await first;
  });

  test('任务抛错 → 仍然解锁（不能把按钮永久禁用），且异常向上抛', async () => {
    const boom = new Error('boom');
    const guarded = guardAction('daily', async () => {
      throw boom;
    });

    await expect(guarded(fakeEvent())).rejects.toThrow('boom');
    expect(isActionRunning('daily')).toBe(false);
  });

  test('表单场景：submit 按钮在执行期间禁用，结束后恢复原值', async () => {
    const { task, release } = deferredTask();
    const button = { disabled: false };
    const form = { tagName: 'FORM', querySelector: () => button };
    const guarded = guardAction('report', task);

    const running = guarded({ preventDefault: jest.fn(), target: form });
    expect(button.disabled).toBe(true);

    release();
    await running;
    expect(button.disabled).toBe(false);
  });

  test('按钮本来就被禁用 → 结束后保持禁用（不越权恢复）', async () => {
    const button = { disabled: true };
    const form = { tagName: 'FORM', querySelector: () => button };

    await guardAction('bulk-create', async () => {})({ preventDefault: jest.fn(), target: form });

    expect(button.disabled).toBe(true);
  });

  test('不同 key 互不阻塞', async () => {
    const a = deferredTask();
    const b = deferredTask();

    const pa = guardAction('a', a.task)(fakeEvent());
    const pb = guardAction('b', b.task)(fakeEvent());

    // 两者都在跑：说明 key 之间没有互相卡住
    expect(a.task).toHaveBeenCalledTimes(1);
    expect(b.task).toHaveBeenCalledTimes(1);

    a.release();
    b.release();
    await Promise.all([pa, pb]);
    expect(isActionRunning('a')).toBe(false);
    expect(isActionRunning('b')).toBe(false);
  });
});
