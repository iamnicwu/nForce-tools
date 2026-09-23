/**
 * Session 链接（section-22，位于「连接与环境」分组）
 *
 * 只展示插件当前实际使用的 Salesforce Session 相关内容，并提供一键复制：
 *   - Session ID
 *   - Frontdoor 登录链接（${instance}/secur/frontdoor.jsp?sid=...&retURL=%2F，可直接登录）
 *
 * 安全提示：Session ID 等同于账号登录凭证，页面顶部有醒目提示；
 * 默认以掩码展示，点「显示」可查看明文，复制按钮始终复制真实值。
 */
import { createLogger } from "../common/logger.js";

const log = createLogger("SESSION");
import { appState } from "./state.js";
import { showNotification, escapeHtml } from "../common/utils.js";

const LIST_ID = "session-info-list";
const MASK_TEXT = "•••••••••••••••••••••••• 已隐藏";

// ---------- 取值 ----------

function instanceUrl() {
  return appState.instance_url || "";
}

/** frontdoor.jsp 可以直接用 session 登录，是最常用的「session 链接」 */
function frontdoorUrl() {
  const base = instanceUrl();
  const sid = appState.session_id;
  if (!base || !sid) return "";
  return `${base}/secur/frontdoor.jsp?sid=${encodeURIComponent(sid)}&retURL=%2F`;
}

// ---------- 复制 ----------

async function copyText(text) {
  if (!text) {
    showNotification("没有可复制的内容", "warning");
    return false;
  }
  try {
    await navigator.clipboard.writeText(text);
    showNotification("已复制到剪贴板", "success");
    return true;
  } catch (e) {
    // 兜底：clipboard API 不可用时用临时 textarea + execCommand
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      showNotification(ok ? "已复制到剪贴板" : "复制失败，请手动选中复制", ok ? "success" : "error");
      return ok;
    } catch (err) {
      log.error("复制失败:", err);
      showNotification("复制失败，请手动选中复制", "error");
      return false;
    }
  }
}

// ---------- 渲染 ----------

/**
 * 生成一行信息
 * @param {string} label 左侧名称
 * @param {string} value 真实值
 * @param {object} opts { mono, sensitive, link }
 */
function rowHtml(label, value, opts = {}) {
  const { mono = true, sensitive = false, link = "" } = opts;
  const hasValue = value !== undefined && value !== null && value !== "";

  if (!hasValue) {
    return `<div class="kv-row">
                <span class="kv-label">${escapeHtml(label)}</span>
                <span class="kv-value kv-empty">-</span>
            </div>`;
  }

  const raw = String(value);
  const classes = ["kv-value"];
  if (mono) classes.push("mono");
  if (sensitive) classes.push("is-sensitive");

  const display = sensitive
    ? `<span class="${classes.join(" ")}" data-raw="${escapeHtml(raw)}" data-masked="1">${escapeHtml(MASK_TEXT)}</span>`
    : `<span class="${classes.join(" ")}">${escapeHtml(raw)}</span>`;

  return `<div class="kv-row">
                <span class="kv-label">${escapeHtml(label)}</span>
                ${display}
                <span class="kv-actions">
                    ${sensitive ? `<button type="button" class="kv-btn" data-action="toggle">显示</button>` : ""}
                    ${link ? `<button type="button" class="kv-btn" data-action="open" data-href="${escapeHtml(link)}">打开</button>` : ""}
                    <button type="button" class="kv-btn kv-btn-primary" data-action="copy">
                        <i class="fas fa-copy"></i><span>复制</span>
                    </button>
                </span>
            </div>`;
}

function buildHtml() {
  if (!appState.session_id) {
    return `<div class="kv-empty-state">
                <i class="fas fa-link"></i>
                <p>当前没有可用的 Salesforce Session。</p>
                <p class="kv-empty-hint">请先在「连接设置」中完成连接，再回到这里查看 Session 链接。</p>
            </div>`;
  }

  return `<div class="kv-group">
                <div class="kv-group-title">Session（敏感）</div>
                ${rowHtml("Instance URL", instanceUrl())}
                ${rowHtml("Session ID", appState.session_id, { sensitive: true })}
                ${rowHtml("Frontdoor 登录链接", frontdoorUrl(), { sensitive: true, link: frontdoorUrl() })}
            </div>`;
}

/** 拼一份纯文本，供「复制全部」使用 */
function buildPlainText() {
  const now = typeof dayjs === "function" ? dayjs().format("YYYY-MM-DD HH:mm:ss") : new Date().toLocaleString();
  return [
    "nForce Tools - Salesforce Session",
    `生成时间: ${now}`,
    "",
    `Instance URL: ${instanceUrl()}`,
    `Session ID: ${appState.session_id || ""}`,
    `Frontdoor 登录链接: ${frontdoorUrl()}`
  ].join("\n");
}

/** 渲染（进入该功能页时调用） */
export function renderSessionInfo() {
  const host = document.getElementById(LIST_ID);
  if (!host) return;
  host.innerHTML = buildHtml();
  bindListEvents(host);

  const copyAllBtn = document.getElementById("session-info-copy-all");
  if (copyAllBtn && !copyAllBtn.dataset.bound) {
    copyAllBtn.dataset.bound = "1";
    copyAllBtn.addEventListener("click", () => copyText(buildPlainText()));
  }
}

function bindListEvents(host) {
  host.addEventListener("click", (e) => {
    const btn = e.target.closest(".kv-btn");
    if (!btn || !host.contains(btn)) return;
    e.preventDefault();

    const row = btn.closest(".kv-row");
    const valueEl = row ? row.querySelector(".kv-value") : null;
    const action = btn.getAttribute("data-action");

    if (action === "copy") {
      // 敏感行取 data-raw，其余直接取文本
      const raw = valueEl && valueEl.dataset.masked ? valueEl.getAttribute("data-raw") : valueEl ? valueEl.textContent : "";
      copyText((raw || "").trim());
      return;
    }

    if (action === "toggle" && valueEl) {
      const masked = valueEl.dataset.masked === "1";
      if (masked) {
        valueEl.textContent = valueEl.getAttribute("data-raw") || "";
        valueEl.dataset.masked = "0";
        btn.textContent = "隐藏";
      } else {
        valueEl.textContent = MASK_TEXT;
        valueEl.dataset.masked = "1";
        btn.textContent = "显示";
      }
      return;
    }

    if (action === "open") {
      const href = btn.getAttribute("data-href");
      if (!href) return;
      try {
        chrome.tabs.create({ url: href });
      } catch (err) {
        window.open(href, "_blank");
      }
    }
  });
}
