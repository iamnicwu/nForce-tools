import{D as e,E as t}from"./chunk-prefs-CLf3g_ZY.js";import{i as n,n as r,o as i,t as a}from"./chunk-state-CLMltSMO.js";e(`SESSION`);var o=`session-info-list`,s=`•••••••••••••••••••••••• 已隐藏`;function c(){return a.instance_url||``}function l(){let e=c(),t=a.session_id;return!e||!t?``:`${e}/secur/frontdoor.jsp?sid=${encodeURIComponent(t)}&retURL=%2F`}function u(e,t,r={}){let{mono:i=!0,sensitive:a=!1,link:o=``}=r;if(t==null||t===``)return`<div class="kv-row">
                <span class="kv-label">${n(e)}</span>
                <span class="kv-value kv-empty">-</span>
            </div>`;let c=String(t),l=[`kv-value`];i&&l.push(`mono`),a&&l.push(`is-sensitive`);let u=a?`<span class="${l.join(` `)}" data-raw="${n(c)}" data-masked="1">${n(s)}</span>`:`<span class="${l.join(` `)}">${n(c)}</span>`;return`<div class="kv-row">
                <span class="kv-label">${n(e)}</span>
                ${u}
                <span class="kv-actions">
                    ${a?`<button type="button" class="kv-btn" data-action="toggle">显示</button>`:``}
                    ${o?`<button type="button" class="kv-btn" data-action="open" data-href="${n(o)}">打开</button>`:``}
                    <button type="button" class="kv-btn kv-btn-primary" data-action="copy">
                        <i class="fas fa-copy"></i><span>复制</span>
                    </button>
                </span>
            </div>`}function d(){return a.session_id?`<div class="kv-group">
                <div class="kv-group-title">Session（敏感）</div>
                ${u(`Instance URL`,c())}
                ${u(`Session ID`,a.session_id,{sensitive:!0})}
                ${u(`Frontdoor 登录链接`,l(),{sensitive:!0,link:l()})}
            </div>`:`<div class="kv-empty-state">
                <i class="fas fa-link"></i>
                <p>当前没有可用的 Salesforce Session。</p>
                <p class="kv-empty-hint">请先在「连接设置」中完成连接，再回到这里查看 Session 链接。</p>
            </div>`}function f(){return[`nForce Tools - Salesforce Session`,`生成时间: ${i()}`,``,`Instance URL: ${c()}`,`Session ID: ${a.session_id||``}`,`Frontdoor 登录链接: ${l()}`].join(`
`)}function p(){let e=document.getElementById(o);if(!e)return;e.innerHTML=d(),t(),m(e);let n=document.getElementById(`session-info-copy-all`);n&&!n.dataset.bound&&(n.dataset.bound=`1`,n.addEventListener(`click`,()=>r(f())))}function m(e){e.addEventListener(`click`,t=>{let n=t.target.closest(`.kv-btn`);if(!n||!e.contains(n))return;t.preventDefault();let i=n.closest(`.kv-row`),a=i?i.querySelector(`.kv-value`):null,o=n.getAttribute(`data-action`);if(o===`copy`){let e=a&&a.dataset.masked?a.getAttribute(`data-raw`):a?a.textContent:``;r((e||``).trim())}else if(o===`toggle`&&a)a.dataset.masked===`1`?(a.textContent=a.getAttribute(`data-raw`)||``,a.dataset.masked=`0`,n.textContent=`隐藏`):(a.textContent=s,a.dataset.masked=`1`,n.textContent=`显示`);else if(o===`open`){let e=n.getAttribute(`data-href`);if(!e)return;try{chrome.tabs.create({url:e})}catch{window.open(e,`_blank`)}}})}export{p as renderSessionInfo};