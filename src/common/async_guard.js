/**
 * 「同一动作只跑一趟」的守卫（防重复提交）
 *
 * ── 为什么需要它（P0，2026-10-17 架构评审）──
 * 取数类操作末尾都会**自动导出 Excel**（"取完就落盘"是既有行为，见 `data_query.js`），
 * 而 Execute Anonymous 则会真的跑 Apex（可能含 DML）。这些入口原先都是
 * 「submit → 不 disable 按钮 → 不记 in-flight」：
 *
 *   双击一次 = 2 次 SOQL + 2 个 xlsx 下载（`stats` 还会被写两次）
 *   双击 Execute Anonymous = **同一段 Apex 跑两遍**
 *
 * ── 两种用法 ──
 *   on("daily-data-form", "submit", guardAction("daily", async (e) => { … }));
 *   on("apex-btn", "click", guardAction("apex", async () => { … }, { buttonId: "apex-btn" }));
 *
 * 表单场景会自动找表单里的 submit 按钮，不需要额外传 `buttonId`。
 *
 * ── 语义（三条，都别改）──
 *   1. 正在跑 → **不重复执行**，只提示一句；提示文案相同的短时间内部叠成多条
 *      （`showNotification` 自带按 `type:message` 合并计数）；
 *   2. **finally 一定解锁并恢复按钮** —— 一次异常不能把按钮永久禁用；
 *   3. **不吞错**：异常继续向上抛，交给全局 `unhandledrejection` 记录并收掉 loading mask。
 *      这也意味着被包裹的 task **必须 await 它内部的异步调用**，否则守卫会在
 *      真正的活儿还没干完时就解锁（等于没防住）。
 */
import { createLogger } from "./logger.js";
import { $ } from "./dom.js";
import { showNotification } from "./utils.js";

const log = createLogger("GUARD");

/** key -> 开始时刻（毫秒）。用 Map 而不是 Set，便于排查时读出"已跑了多久" */
const inFlight = new Map();

/** 该动作当前是否正在执行（供测试与调试使用） */
export function isActionRunning(key) {
  return inFlight.has(key);
}

/**
 * 把一个可能较慢、且**不应该被重复触发**的动作包成受保护的事件处理器。
 *
 * @param {string} key 动作标识（同一 key 同时只允许跑一趟）
 * @param {(event?: Event) => Promise<*>|*} task 真正的动作；内部异步调用请 await
 * @param {{buttonId?: string, busyMessage?: string}} [options]
 * @returns {(event?: Event) => Promise<void>}
 */
export function guardAction(key, task, options = {}) {
  const { buttonId = null, busyMessage = "上一次操作还在执行中，请稍候…" } = options;

  return async function guarded(event) {
    // 表单提交一律先拦下默认行为 —— 调用方原本各自写了一遍，这里统一。
    if (event && typeof event.preventDefault === "function") {
      try {
        event.preventDefault();
      } catch (e) {
        log.debug("preventDefault 失败（事件可能不可取消）:", e);
      }
    }

    if (inFlight.has(key)) {
      log.info(`忽略重复触发：${key}（已运行 ${Date.now() - inFlight.get(key)}ms）`);
      showNotification(busyMessage, "info");
      return;
    }

    inFlight.set(key, Date.now());
    const button = resolveButton(event, buttonId);
    const previousDisabled = button ? button.disabled : null;
    if (button) button.disabled = true;

    try {
      await task(event);
    } finally {
      inFlight.delete(key);
      // 只恢复"我们改过的那一项"：任务内部若另有意把按钮留在禁用态，不去覆盖它
      if (button && previousDisabled !== null) button.disabled = previousDisabled;
    }
  };
}

/**
 * 找出这次触发对应的按钮。
 * 表单提交 → 表单里的 submit 按钮；按钮点击 → 调用方给的 `buttonId`。
 * 都找不到就返回 null（照常执行，只是没有禁用态）。
 */
function resolveButton(event, buttonId) {
  if (buttonId) return $(buttonId);
  const target = event && event.target;
  if (target && target.tagName === "FORM") {
    return target.querySelector('button[type="submit"], input[type="submit"]');
  }
  return null;
}
