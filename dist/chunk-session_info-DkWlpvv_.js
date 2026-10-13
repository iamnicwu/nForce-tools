import{b as e,x as t}from"./chunk-prefs-DbR162fL.js";import{a as n,l as r,r as i,t as a}from"./chunk-state-BfLpz9nk.js";var o=t(`SESSION`),s=`session-info-list`,c=`•••••••••••••••••••••••• 已隐藏`;function l(){return a.instance_url||``}function u(){let e=l(),t=a.session_id;return!e||!t?``:`${e}/secur/frontdoor.jsp?sid=${encodeURIComponent(t)}&retURL=%2F`}async function d(e){if(!e)return r(`没有可复制的内容`,`warning`),!1;try{return await navigator.clipboard.writeText(e),r(`已复制到剪贴板`,`success`),!0}catch{try{let t=document.createElement(`textarea`);t.value=e,t.setAttribute(`readonly`,``),t.style.position=`fixed`,t.style.left=`-9999px`,document.body.appendChild(t),t.select();let n=document.execCommand(`copy`);return document.body.removeChild(t),r(n?`已复制到剪贴板`:`复制失败，请手动选中复制`,n?`success`:`error`),n}catch(e){return o.error(`复制失败:`,e),r(`复制失败，请手动选中复制`,`error`),!1}}}function f(e,t,n={}){let{mono:r=!0,sensitive:a=!1,link:o=``}=n;if(t==null||t===``)return`<div class="kv-row">
                <span class="kv-label">${i(e)}</span>
                <span class="kv-value kv-empty">-</span>
            </div>`;let s=String(t),l=[`kv-value`];r&&l.push(`mono`),a&&l.push(`is-sensitive`);let u=a?`<span class="${l.join(` `)}" data-raw="${i(s)}" data-masked="1">${i(c)}</span>`:`<span class="${l.join(` `)}">${i(s)}</span>`;return`<div class="kv-row">
                <span class="kv-label">${i(e)}</span>
                ${u}
                <span class="kv-actions">
                    ${a?`<button type="button" class="kv-btn" data-action="toggle">显示</button>`:``}
                    ${o?`<button type="button" class="kv-btn" data-action="open" data-href="${i(o)}">打开</button>`:``}
                    <button type="button" class="kv-btn kv-btn-primary" data-action="copy">
                        <i class="fas fa-copy"></i><span>复制</span>
                    </button>
                </span>
            </div>`}function p(){return a.session_id?`<div class="kv-group">
                <div class="kv-group-title">Session（敏感）</div>
                ${f(`Instance URL`,l())}
                ${f(`Session ID`,a.session_id,{sensitive:!0})}
                ${f(`Frontdoor 登录链接`,u(),{sensitive:!0,link:u()})}
            </div>`:`<div class="kv-empty-state">
                <i class="fas fa-link"></i>
                <p>当前没有可用的 Salesforce Session。</p>
                <p class="kv-empty-hint">请先在「连接设置」中完成连接，再回到这里查看 Session 链接。</p>
            </div>`}function m(){return[`nForce Tools - Salesforce Session`,`生成时间: ${n()}`,``,`Instance URL: ${l()}`,`Session ID: ${a.session_id||``}`,`Frontdoor 登录链接: ${u()}`].join(`
`)}function h(){let t=document.getElementById(s);if(!t)return;t.innerHTML=p(),e(),g(t);let n=document.getElementById(`session-info-copy-all`);n&&!n.dataset.bound&&(n.dataset.bound=`1`,n.addEventListener(`click`,()=>d(m())))}function g(e){e.addEventListener(`click`,t=>{let n=t.target.closest(`.kv-btn`);if(!n||!e.contains(n))return;t.preventDefault();let r=n.closest(`.kv-row`),i=r?r.querySelector(`.kv-value`):null,a=n.getAttribute(`data-action`);if(a===`copy`)d(((i&&i.dataset.masked?i.getAttribute(`data-raw`):i?i.textContent:``)||``).trim());else if(a===`toggle`&&i)i.dataset.masked===`1`?(i.textContent=i.getAttribute(`data-raw`)||``,i.dataset.masked=`0`,n.textContent=`隐藏`):(i.textContent=c,i.dataset.masked=`1`,n.textContent=`显示`);else if(a===`open`){let e=n.getAttribute(`data-href`);if(!e)return;try{chrome.tabs.create({url:e})}catch{window.open(e,`_blank`)}}})}export{h as renderSessionInfo};