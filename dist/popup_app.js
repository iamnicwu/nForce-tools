// popup.html 的页面脚本：图标替换 / 版本号 / 「打开完整应用」按钮。
//
// ⚠️ 为什么必须是独立文件，不能写成内联 <script>：
// manifest.json 的 content_security_policy.extension_pages 是 `script-src 'self'`，
// **不含 'unsafe-inline'**。内联脚本（含 <script type="module">）会被整段拒绝执行，
// 而且不产生任何页面上看得见的异常 —— 只在控制台留一条 CSP 报错。后果是全静默的：
//   · 「打开完整应用」按钮点了毫无反应（openFullApp is not defined）
//   · 图标一直是空白方块（replaceIcons 从未执行）
//   · #popup-version 一直是空的
// 同理，HTML 里的 `onclick="..."` 内联事件处理器也受 script-src 管辖，
// 所以按钮改成 id + addEventListener，不再用 onclick 属性。
//
// 这些在静态预览（serve.py + shim.js）里全都看不出来：预览走的是普通 HTTP，
// 没有扩展的 CSP。只有真加载扩展才会暴露 —— 见 assets/net-probe.mjs 与
// assets/page-boot-verify.mjs。
import { replaceIcons } from './common/icons.js';

replaceIcons();

// 版本号唯一来源：manifest.json。
// 以前这里硬编码 v1.0，而 manifest 是 3.3.0、package.json 是 3.2.0，三处互不一致。
const versionEl = document.getElementById('popup-version');
if (versionEl) {
    try {
        versionEl.textContent = 'v' + chrome.runtime.getManifest().version;
    } catch (e) {
        versionEl.textContent = '';
    }
}

const openAppBtn = document.getElementById('open-app-btn');
if (openAppBtn) {
    openAppBtn.addEventListener('click', () => {
        chrome.tabs.create({ url: chrome.runtime.getURL('index.html'), active: true });
    });
}
