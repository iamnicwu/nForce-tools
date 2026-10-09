import{b as e,x as t}from"./chunk-prefs-DbR162fL.js";import{c as n,r,t as i}from"./chunk-state-28piBmoE.js";var a=t(`SESSION`),o=`session-info-list`,s=`•••••••••••••••••••••••• 已隐藏`;function c(){return i.instance_url||``}function l(){let e=c(),t=i.session_id;return!e||!t?``:`${e}/secur/frontdoor.jsp?sid=${encodeURIComponent(t)}&retURL=%2F`}async function u(e){if(!e)return n(`没有可复制的内容`,`warning`),!1;try{return await navigator.clipboard.writeText(e),n(`已复制到剪贴板`,`success`),!0}catch{try{let t=document.createElement(`textarea`);t.value=e,t.setAttribute(`readonly`,``),t.style.position=`fixed`,t.style.left=`-9999px`,document.body.appendChild(t),t.select();let r=document.execCommand(`copy`);return document.body.removeChild(t),n(r?`已复制到剪贴板`:`复制失败，请手动选中复制`,r?`success`:`error`),r}catch(e){return a.error(`复制失败:`,e),n(`复制失败，请手动选中复制`,`error`),!1}}}function d(e,t,n={}){let{mono:i=!0,sensitive:a=!1,link:o=``}=n;if(t==null||t===``)return`<div class="kv-row">
                <span class="kv-label">${r(e)}</span>
                <span class="kv-value kv-empty">-</span>
            </div>`;let c=String(t),l=[`kv-value`];i&&l.push(`mono`),a&&l.push(`is-sensitive`);let u=a?`<span class="${l.join(` `)}" data-raw="${r(c)}" data-masked="1">${r(s)}</span>`:`<span class="${l.join(` `)}">${r(c)}</span>`;return`<div class="kv-row">
                <span class="kv-label">${r(e)}</span>
                ${u}
                <span class="kv-actions">
                    ${a?`<button type="button" class="kv-btn" data-action="toggle">显示</button>`:``}
                    ${o?`<button type="button" class="kv-btn" data-action="open" data-href="${r(o)}">打开</button>`:``}
                    <button type="button" class="kv-btn kv-btn-primary" data-action="copy">
                        <i class="fas fa-copy"></i><span>复制</span>
                    </button>
                </span>
            </div>`}function f(){return i.session_id?`<div class="kv-group">
                <div class="kv-group-title">Session（敏感）</div>
                ${d(`Instance URL`,c())}
                ${d(`Session ID`,i.session_id,{sensitive:!0})}
                ${d(`Frontdoor 登录链接`,l(),{sensitive:!0,link:l()})}
            </div>`:`<div class="kv-empty-state">
                <i class="fas fa-link"></i>
                <p>当前没有可用的 Salesforce Session。</p>
                <p class="kv-empty-hint">请先在「连接设置」中完成连接，再回到这里查看 Session 链接。</p>
            </div>`}function p(){return[`nForce Tools - Salesforce Session`,`生成时间: ${typeof dayjs==`function`?dayjs().format(`YYYY-MM-DD HH:mm:ss`):new Date().toLocaleString()}`,``,`Instance URL: ${c()}`,`Session ID: ${i.session_id||``}`,`Frontdoor 登录链接: ${l()}`].join(`
`)}function m(){let t=document.getElementById(o);if(!t)return;t.innerHTML=f(),e(),h(t);let n=document.getElementById(`session-info-copy-all`);n&&!n.dataset.bound&&(n.dataset.bound=`1`,n.addEventListener(`click`,()=>u(p())))}function h(e){e.addEventListener(`click`,t=>{let n=t.target.closest(`.kv-btn`);if(!n||!e.contains(n))return;t.preventDefault();let r=n.closest(`.kv-row`),i=r?r.querySelector(`.kv-value`):null,a=n.getAttribute(`data-action`);if(a===`copy`)u(((i&&i.dataset.masked?i.getAttribute(`data-raw`):i?i.textContent:``)||``).trim());else if(a===`toggle`&&i)i.dataset.masked===`1`?(i.textContent=i.getAttribute(`data-raw`)||``,i.dataset.masked=`0`,n.textContent=`隐藏`):(i.textContent=s,i.dataset.masked=`1`,n.textContent=`显示`);else if(a===`open`){let e=n.getAttribute(`data-href`);if(!e)return;try{chrome.tabs.create({url:e})}catch{window.open(e,`_blank`)}}})}export{m as renderSessionInfo};