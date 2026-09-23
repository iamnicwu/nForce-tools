/**
 * nForce Tools 统一日志模块
 *
 * 用法：
 *   import { createLogger, maskSecret, setLogLevel } from "<相对路径>/common/logger.js";
 *   const log = createLogger("SF");       // 每个文件一个短 TAG
 *   log.debug("..."); log.info("..."); log.warn("..."); log.error("...", err);
 *
 * 输出格式：[nForce][TAG] 消息 [附加参数...]
 * 级别：debug < info < warn < error < off，默认 info（debug 不输出）。
 *
 * 开启 debug（三选一）：
 *   1. DevTools 控制台执行 __NFORCE_LOG_LEVEL__ = "debug" 后刷新页面；
 *   2. chrome.storage.local.set({ log_level: "debug" })，跨页面持久生效；
 *   3. 代码中调用 setLogLevel("debug")。
 *
 * 敏感信息（Session ID / Cookie / token）一律先过 maskSecret() 再输出。
 * 本文件自身不 import 任何模块，可被 webpack 打包、也可逐字复制到
 * dist/ 供 background.js 以原生 ESM 方式 import。
 */

const BRAND = "nForce";

const LEVELS = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  off: 50,
});

function normalizeLevel(level) {
  if (typeof level === "string" && Object.prototype.hasOwnProperty.call(LEVELS, level.toLowerCase())) {
    return level.toLowerCase();
  }
  return null;
}

let currentLevel = normalizeLevel(globalThis.__NFORCE_LOG_LEVEL__) || "info";

// 跨页面持久化的日志级别（静默失败：预览/测试环境可能没有 chrome.storage）
try {
  if (typeof chrome !== "undefined" && chrome?.storage?.local?.get) {
    Promise.resolve(chrome.storage.local.get("log_level"))
      .then((stored) => {
        const level = normalizeLevel(stored?.log_level);
        if (level) currentLevel = level;
      })
      .catch(() => {});
  }
} catch {
  /* ignore */
}

function setLogLevel(level) {
  const normalized = normalizeLevel(level);
  if (!normalized) {
    console.warn(`[${BRAND}] 无效日志级别: ${level}（可选 debug/info/warn/error/off）`);
    return;
  }
  currentLevel = normalized;
}

function getLogLevel() {
  return currentLevel;
}

/**
 * 脱敏：保留头尾少量字符 + 总长度，例如 "00Dxx…abcd (52)"
 */
function maskSecret(value, keepStart = 6, keepEnd = 4) {
  if (value === null || value === undefined) return String(value);
  const s = String(value);
  if (s.length <= keepStart + keepEnd) {
    return `${s.slice(0, 2)}…(${s.length})`;
  }
  return `${s.slice(0, keepStart)}…${s.slice(-keepEnd)}(${s.length})`;
}

function createLogger(tag) {
  const prefix = `[${BRAND}][${tag}]`;
  return {
    debug: (...args) => {
      if (LEVELS[currentLevel] <= LEVELS.debug) console.debug(prefix, ...args);
    },
    info: (...args) => {
      if (LEVELS[currentLevel] <= LEVELS.info) console.log(prefix, ...args);
    },
    warn: (...args) => {
      if (LEVELS[currentLevel] <= LEVELS.warn) console.warn(prefix, ...args);
    },
    error: (...args) => {
      if (LEVELS[currentLevel] <= LEVELS.error) console.error(prefix, ...args);
    },
  };
}

export { createLogger, setLogLevel, getLogLevel, maskSecret };
