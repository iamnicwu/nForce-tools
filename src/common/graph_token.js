/**
 * Microsoft Graph Access Token —— 安全存取层
 *
 * ⚠️ 安全约定：**令牌绝不写进源码**
 * 硬编码 token 会被 git 永久记录，一旦仓库公开（哪怕是后来才公开的），
 * 凭据泄露就无法通过「删文件」撤回。因此本文件只提供「读取/写入」通道，
 * 真正的令牌存放在 chrome.storage.local 的 `graph_token` 键里。
 *
 * ── 写入方式（任选其一）──
 *   1. 扩展页面 DevTools 控制台：
 *        chrome.storage.local.set({ graph_token: "eyJ..." })
 *   2. 业务代码里调用 setGraphToken("eyJ...")
 *   3. 设置界面提供输入框，提交后调用 setGraphToken()
 *
 * ── 注意 ──
 * Graph 的 access token 有效期约 1 小时，过期后需重新写入。
 * 若要「长期免维护」，正确做法是走 OAuth2 授权码流程拿 refresh_token，
 * 在 background 里静默续期 —— 属后续独立功能，不在本模块职责内。
 *
 * 本模块不含任何凭据，因此可以安全地提交进版本库。
 */

import { createLogger } from "./logger.js";

const log = createLogger("OD");

const STORAGE_KEY = "graph_token";

/**
 * 判断当前环境是否具备 chrome.storage.local
 * （静态预览 / 单测环境里没有扩展 API）
 * @returns {boolean}
 */
function hasStorageApi() {
  return (
    typeof chrome !== "undefined" &&
    !!chrome.storage &&
    !!chrome.storage.local
  );
}

/**
 * 读取 Graph access token
 *
 * 优先级：内存覆盖值（window.__GRAPH_TOKEN__，仅供本地调试）
 *        → chrome.storage.local.graph_token
 *        → null
 *
 * @returns {Promise<string|null>} 令牌字符串，未配置时返回 null
 */
export async function getGraphToken() {
  // 本地调试逃生口：静态预览时可在控制台临时赋值，不落盘
  if (typeof window !== "undefined" && window.__GRAPH_TOKEN__) {
    return window.__GRAPH_TOKEN__;
  }

  if (!hasStorageApi()) {
    return null;
  }

  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const token = result?.[STORAGE_KEY];
    return typeof token === "string" && token.trim() ? token.trim() : null;
  } catch (error) {
    log.warn("读取 Graph Token 失败:", error);
    return null;  }
}

/**
 * 写入 Graph access token
 * @param {string} token - Microsoft Graph access token
 * @returns {Promise<boolean>} 是否写入成功
 */
export async function setGraphToken(token) {
  if (!token || typeof token !== "string" || !token.trim()) {
    throw new Error("Invalid graph token: token must be a non-empty string");
  }
  if (!hasStorageApi()) {
    throw new Error("chrome.storage.local 不可用，无法保存 Graph Token");
  }
  await chrome.storage.local.set({ [STORAGE_KEY]: token.trim() });
  return true;
}

/**
 * 清除已保存的 Graph access token
 * @returns {Promise<boolean>}
 */
export async function clearGraphToken() {
  if (!hasStorageApi()) return false;
  await chrome.storage.local.remove(STORAGE_KEY);
  return true;
}

/**
 * 是否已配置 Graph token（不校验有效性，只看是否存在）
 * @returns {Promise<boolean>}
 */
export async function hasGraphToken() {
  return (await getGraphToken()) !== null;
}

export default getGraphToken;
