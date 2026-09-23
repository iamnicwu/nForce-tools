/**
 * DOM 访问帮助函数
 *
 * 为什么需要这个文件？
 *   项目里 `getElementById` 出现约 400 次，其中大量写成
 *       document.getElementById("x").addEventListener(...)
 *   `bindEvents()` 是一个上千行的巨型函数，一旦某一行里的 id 被改名或删除，
 *   就会在**绑定阶段**直接抛 TypeError，把整个 `bindEvents()` 中断掉 ——
 *   表现是「页面渲染正常、图标都在，但很多按钮点了没反应」，且很难定位。
 *
 * 这里把「取元素」和「绑定事件」收敛成不会抛错的版本：
 *   - $ / $$      取不到时返回 null / 空数组（不抛错，交给调用方判断）
 *   - on / onAll  元素不存在时打印一条去重 warn 并跳过，绝不中断调用方
 *
 * 约定：新增的事件绑定请使用 on / onAll，不要再写裸的 getElementById(...).addEventListener。
 */

/** 取单个元素，找不到返回 null（等价于 document.getElementById） */
import { createLogger } from "./logger.js";

const log = createLogger("DOM");
export function $(id) {
  return document.getElementById(id);
}

/** 取元素列表，永远返回真实数组，可直接 forEach / map */
export function $$(selector, root = document) {
  return Array.from(root.querySelectorAll(selector));
}

// 同 (id, 事件) 只提示一次，避免刷屏
const warned = new Set();

function warnMissing(id, type) {
  const key = `${id}::${type}`;
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(
    `[DOM] 未找到 #${id}，已跳过它的「${type}」事件绑定。` +
      `请检查 index.html 里该元素是否已改名或删除（运行 npm run check:ui 可定位同类问题）。`
  );
}

/**
 * 安全绑定事件。
 * @param {string|Element} target 元素 id 或元素本身
 * @param {string} type            事件名
 * @param {Function} handler       处理函数
 * @param {object|boolean} [options]
 * @returns {Element|null} 绑定成功返回元素，元素缺失返回 null
 */
export function on(target, type, handler, options) {
  const el = typeof target === "string" ? document.getElementById(target) : target;
  if (!el) {
    warnMissing(typeof target === "string" ? target : String(target), type);
    return null;
  }
  el.addEventListener(type, handler, options);
  return el;
}

/**
 * 安全批量绑定（选择器匹配不到任何元素时静默返回空数组，不抛错）
 * @returns {Element[]} 实际绑定成功的元素数组
 */
export function onAll(selector, type, handler, root = document) {
  const list = Array.from(root.querySelectorAll(selector));
  list.forEach((el) => el.addEventListener(type, handler));
  return list;
}

/** 调试用：列出本次运行中所有「取不到」的 id（配合 ?debug 或控制台调用） */
export function getMissingTargets() {
  return [...warned];
}

/** 显示 / 隐藏（改 display 比 style.display 直接赋值更抗 null） */
export function setVisible(target, visible) {
  const el = typeof target === "string" ? document.getElementById(target) : target;
  if (el) el.style.display = visible ? "" : "none";
  return el;
}
