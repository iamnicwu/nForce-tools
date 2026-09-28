// login.html JavaScript Logic
// API Version
import { createLogger, maskSecret } from "./common/logger.js";
import { SfRestConnection } from "./common/sf_rest_client.js";
import { loadPrefs, getApiVersion } from "./common/prefs.js";
import { pickUsableApiVersion, probeInstanceApiVersions } from "./common/api_version.js";
import { replaceIcons } from "./common/icons.js";
const log = createLogger("LOGIN");

// API 版本不再写死在这里。设置页（section-28「插件偏好」）里配置的值存在
// chrome.storage.local，登录时读一次即可。
// 模块加载就开始读：用户点「登录」时这个 Promise 早已 settle，
// 因此下面可以无条件 await，不会读到"还没来得及载入"的默认值。
const prefsReady = loadPrefs();

// （原先这里会空闲预热 1.37MB 的 jsforce。改用自研的 sf_rest_client.js 之后，
//   它是普通 ESM、已在上面静态 import，无需预热，也不需要 lib_loader。）

// State
let availableSessions = [];
let selectedSessionIndex = -1;

// DOM Elements
const loadingState = document.getElementById('loading-state');
const sessionListContainer = document.getElementById('session-list-container');
const loginBtn = document.getElementById('login-btn');
const noSession = document.getElementById('no-session');
const showManualLogin = document.getElementById('show-manual-login');
const manualLoginSection = document.getElementById('manual-login-section');
const manualLoginBtn = document.getElementById('manual-login-btn');
const sessionIdInput = document.getElementById('session-id');
const errorMsg = document.getElementById('error-msg');


// Get domain from tab URL
function getDomain(currentTabUrl) {
    log.debug('getDomain called with:', currentTabUrl);
    if (currentTabUrl) {
        if (currentTabUrl.includes(".lightning.force.com")) {
            const domain = currentTabUrl.split(".lightning.force.com")[0] + ".my.salesforce.com";
            log.debug('Lightning domain extracted:', domain);
            return domain;
        } else if (currentTabUrl.includes(".my.salesforce.com")) {
            const domain = currentTabUrl.split(".my.salesforce.com")[0] + ".my.salesforce.com";
            log.debug('MySalesforce domain extracted:', domain);
            return domain;
        }
    }
    log.warn('无法从 URL 提取域名:', currentTabUrl);
    return null;
}

// Test connection and get user info
async function testConnectionWithUserInfo(session_id, instanceUrl) {
    log.debug('testConnectionWithUserInfo called');
    log.debug('session_id:', session_id ? maskSecret(session_id) : 'null');
    log.debug('instanceUrl:', instanceUrl);

    if (!instanceUrl) {
        // 没有 instanceUrl 就无法构造连接：sessionId 只对特定 org 有效，
        // 猜一个默认域必然失败，还会写出空的实例地址。
        // 这里提前拦下，给出可执行的提示。
        log.error('缺少 instanceUrl，无法建立连接');
        return { success: false, error: '缺少实例地址(instanceUrl)，请先完成一次自动检测连接' };
    }

    try {
        log.debug('Creating Salesforce connection...');
        await prefsReady;
        const apiVersion = getApiVersion();
        log.debug('使用 API 版本:', apiVersion);

        // 各 org 的升级窗口不同（Winter '27 / v68.0 的生产窗口是 2026-09-04 / 10-02 / 10-09，
        // 全面 GA 是 10-12）：对还没升级的 org 请求 /services/data/v68.0/ 会拿到 404，
        // 而下面 conn.identity() 正是建连接的第一步 —— 不协商就会表现为「一直连不上」。
        // 配置的版本可用则原样使用，不可用才退到实例支持的最高版本。
        const pickedVersion = pickUsableApiVersion(
            apiVersion,
            await probeInstanceApiVersions(instanceUrl)
        );
        if (pickedVersion.fellBack) {
            log.warn(
                `该 org 不支持 API v${apiVersion}（实例可用：` +
                `${pickedVersion.available.map((v) => 'v' + v.toFixed(1)).join(' / ')}），` +
                `本次连接改用 v${pickedVersion.version}`
            );
        }

        const conn = new SfRestConnection({
            instanceUrl: instanceUrl,
            serverUrl: `${instanceUrl}/services/Soap/u/${pickedVersion.version}`,
            sessionId: session_id,
            version: pickedVersion.version,
        });
        
        log.debug('Calling conn.identity()...');
        const userInfo = await conn.identity();
        log.debug('User identity retrieved successfully');
        // 安全：不输出完整的 userInfo 对象，避免泄露敏感信息
        log.debug('User:', userInfo.display_name || userInfo.name || userInfo.username);
        log.debug('User photos available:', !!userInfo.photos);
        log.debug('User thumbnail available:', !!userInfo.thumbnail);
        
        let orgInfo = null;
        try {
            log.debug('Querying Organization info...');
            const orgResult = await conn.query("SELECT Id, IsSandbox, OrganizationType FROM Organization");
            if (orgResult.records && orgResult.records.length > 0) {
                orgInfo = orgResult.records[0];
                log.debug('Organization info:', orgInfo);
            }
        } catch (orgErr) {
            log.warn('获取组织信息失败:', orgErr);
        }
        
        const result = {
            success: true,
            userInfo: {
                username: userInfo.username || userInfo.user_id || '',
                email: userInfo.email || '',
                fullName: userInfo.display_name || userInfo.name || '',
                thumbnail: userInfo.photos?.thumbnail || userInfo.photos?.[0]?.thumbnail || userInfo.thumbnail || userInfo.photos?.picture || ''
            },
            orgInfo: orgInfo,
            // 显式回传实例地址：调用方原本读的是 result.userInfo.instanceUrl（不存在），
            // 结果把 sf_instance_url 写成 null，下次启动就丢了实例地址。
            instanceUrl: instanceUrl,
            connection: conn
        };
        
        log.debug('testConnectionWithUserInfo SUCCESS');
        // 安全：不输出完整的 result 对象，避免泄露敏感信息
        return result;
    } catch (err) {
        log.error('连接测试失败:', err);
        return { success: false, error: err.message };
    }
}

// Auto detect sessions
async function autoDetectSession() {
    log.debug('========== autoDetectSession START ==========');
    
    try {
        log.debug('Querying Chrome tabs for Salesforce URLs...');
        const tabs = await chrome.tabs.query({
            url: [
                "https://*.salesforce.com/*",
                "https://*.force.com/*",
                "https://*.salesforce-setup.com/*",
            ],
        });
        
        log.debug('Tabs query result:', tabs);
        log.debug('Total tabs found:', tabs ? tabs.length : 0);
        
        // ── 第一步：把所有标签页收敛成「唯一的 (sid, instanceUrl) 候选」──
        // 同一个 org 开 5 个 Salesforce 标签页时，原来会对同一个 sid 发起 5 次
        // conn.identity() 网络请求；这里先去重，再做探测。
        const candidates = [];
        const candidateKeys = new Set();
        // domainKey -> 已见过的 sid，用于跳过同一 org 的重复凭证
        const sidByDomain = new Map();

        if (tabs && tabs.length > 0) {
            log.debug(`Processing ${tabs.length} tabs...`);

            for (const tab of tabs) {
                log.debug('-----------------------------------');
                log.debug('Processing tab:', {
                    id: tab.id,
                    url: tab.url,
                    title: tab.title
                });

                try {
                    const url = new URL(tab.url);
                    const hostname = url.hostname;

                    // Extract domain key
                    let domainKey = hostname;
                    if (hostname.includes('--')) {
                        domainKey = hostname.split('--')[0];
                        log.debug('  Domain key (with --):', domainKey);
                    } else {
                        domainKey = hostname.split('.')[0];
                        log.debug('  Domain key (simple):', domainKey);
                    }

                    // Get cookie URL
                    const cookieUrl = getDomain(tab.url);
                    log.debug('  Cookie URL:', cookieUrl);

                    if (!cookieUrl) {
                        log.warn('  SKIP: Could not get cookie URL');
                        continue;
                    }

                    // Get session from cookies
                    const cookies = await chrome.cookies.getAll({ url: cookieUrl, name: "sid" });
                    log.debug('  Cookies count for sid:', cookies ? cookies.length : 0);

                    if (!cookies || cookies.length === 0) {
                        log.warn('  No cookies found for this tab');
                        continue;
                    }

                    const cookieValue = cookies[0].value;
                    const instanceUrl = "https://" + getDomain(cookies[0].domain);

                    // Parse session ID from cookie（格式：something!sessionId）
                    const parts = cookieValue.split('!');
                    let sid = null;
                    if (parts.length >= 2) {
                        sid = parts[1];
                    } else if (parts.length === 1) {
                        sid = parts[0];
                    }

                    log.debug('  Extracted SID:', sid ? maskSecret(sid) : 'null');

                    if (!sid) {
                        log.warn('  SKIP: 无法从 cookie 解析出 session id');
                        continue;
                    }
                    if (!instanceUrl || instanceUrl === "https://undefined") {
                        log.warn('  SKIP: 无法确定实例地址');
                        continue;
                    }

                    // 同一 domain 已探测过同一个 sid → 直接跳过，不再发网络请求
                    if (sidByDomain.get(domainKey) === sid) {
                        log.debug(`  SKIP: ${domainKey} 的该 session 已探测过`);
                        continue;
                    }
                    sidByDomain.set(domainKey, sid);

                    const key = `${sid}::${instanceUrl}`;
                    if (candidateKeys.has(key)) {
                        log.debug('  SKIP: (sid, instanceUrl) 重复');
                        continue;
                    }
                    candidateKeys.add(key);
                    candidates.push({ sid, instanceUrl, tabId: tab.id, tabTitle: tab.title });
                } catch (err) {
                    log.error('  Error processing tab:', err);
                }
            }
        } else {
            log.warn('未找到 Salesforce 标签页');
        }

        log.info(`待探测的 session 候选：${candidates.length} 个（来自 ${tabs ? tabs.length : 0} 个标签页）`);

        // ── 第二步：限并发探测（每个候选一次 conn.identity() 网络往返）──
        // 原来是串行 await，标签页一多就要等很久；这里并发 3 个，兼顾速度与限流。
        const CONCURRENCY = 3;
        const results = new Array(candidates.length);
        let nextIndex = 0;

        const worker = async () => {
            while (true) {
                const i = nextIndex++;
                if (i >= candidates.length) return;
                const c = candidates[i];
                try {
                    const connectionResult = await testConnectionWithUserInfo(c.sid, c.instanceUrl);
                    if (connectionResult.success) {
                        results[i] = {
                            sid: c.sid,
                            instanceUrl: c.instanceUrl,
                            tabId: c.tabId,
                            tabTitle: c.tabTitle,
                            userInfo: connectionResult.userInfo,
                            orgInfo: connectionResult.orgInfo,
                            connection: connectionResult.connection
                        };
                    } else {
                        log.warn(`  Connection FAILED: ${c.instanceUrl}`);
                    }
                } catch (err) {
                    log.error(`  探测 ${c.instanceUrl} 失败:`, err);
                }
            }
        };

        await Promise.all(
            Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, worker)
        );
        const availableSessions = results.filter(Boolean);

        log.debug('========== autoDetectSession END ==========');
        log.debug('Total sessions:', availableSessions.length);
        availableSessions.forEach((s, i) => {
            log.debug(`  Session ${i}:`, {
                instanceUrl: s.instanceUrl,
                username: s.userInfo?.username,
                fullName: s.userInfo?.fullName
            });
        });

        return availableSessions;
    } catch (error) {
        log.error('自动检测 Session 失败:', error);
        return [];
    }
}

// Render session list
function renderSessionList(sessions) {
    log.debug('renderSessionList called with', sessions ? sessions.length : 0, 'sessions');
    
    if (!sessionListContainer) {
        log.error('未找到 #session-list-container 容器!');
        return;
    }
    
    sessionListContainer.innerHTML = '';
    
    if (!sessions || sessions.length === 0) {
        log.warn('没有可渲染的会话');
        return;
    }
    
    sessions.forEach((session, index) => {
        log.debug('Rendering session', index, ':', session.instanceUrl);
        
        const card = document.createElement('div');
        card.className = 'session-card';
        card.dataset.index = index;
        
        // Determine environment type
        const isSandbox = session.orgInfo?.IsSandbox;
        let envClass = 'unknown';
        let envLabel = 'Unknown';
        if (isSandbox === true) {
            envClass = 'sandbox';
            envLabel = 'Sandbox';
        } else if (isSandbox === false) {
            envClass = 'production';
            envLabel = 'Production';
        }
        
        log.debug('  Environment:', envLabel, 'IsSandbox:', isSandbox);
        
        // Extract domain for display
        let domainDisplay = session.instanceUrl;
        try {
            const url = new URL(session.instanceUrl);
            domainDisplay = url.hostname;
        } catch (e) {
            log.warn('  Could not parse domain:', e);
        }
        
        const userDisplay = session.userInfo?.fullName || session.userInfo?.username || 'Unknown User';
        const emailDisplay = session.userInfo?.email || '-';
        
        log.debug('  User:', userDisplay);
        log.debug('  Email:', emailDisplay);
        
        card.innerHTML = `
            <span class="session-env ${envClass}">${envLabel}</span>
            <div class="session-domain">${domainDisplay}</div>
            <div class="session-user">${userDisplay}</div>
            <div class="session-email">${emailDisplay}</div>
        `;
        
        card.addEventListener('click', () => {
            log.debug('Session card clicked, index:', index);
            selectSession(index);
        });
        
        sessionListContainer.appendChild(card);
    });
    
    log.debug('renderSessionList complete');
}

// Select session
function selectSession(index) {
    log.debug('selectSession called with index:', index);
    
    selectedSessionIndex = index;
    
    // Update UI
    const cards = document.querySelectorAll('.session-card');
    log.debug('Found', cards.length, 'session cards');
    
    cards.forEach((card, i) => {
        const isSelected = i === index;
        log.debug('  Card', i, 'selected:', isSelected);
        card.classList.toggle('selected', isSelected);
    });
    
    if (loginBtn) {
        loginBtn.disabled = false;
        const session = availableSessions[index];
        const userName = session?.userInfo?.fullName || session?.userInfo?.username || '此环境';
        loginBtn.innerHTML = '<i class="fas fa-sign-in-alt"></i><span>登录到 ' + userName + '</span>';
        log.debug('Login button updated, user:', userName);
    } else {
        log.error('未找到 #login-btn!');
    }
}

// Handle login
async function handleLogin() {
    log.debug('handleLogin called');
    log.debug('selectedSessionIndex:', selectedSessionIndex);
    log.debug('availableSessions.length:', availableSessions.length);
    
    if (selectedSessionIndex < 0 || selectedSessionIndex >= availableSessions.length) {
        log.error('无效的会话索引!');
        return;
    }
    
    const session = availableSessions[selectedSessionIndex];
    log.debug('Selected session:', {
        instanceUrl: session.instanceUrl,
        username: session.userInfo?.username,
        fullName: session.userInfo?.fullName
    });
    
    // Save to chrome.storage.local
    log.debug('Saving to chrome.storage.local...');
    try {
        await chrome.storage.local.set({
            sf_session_id: session.sid,
            sf_instance_url: session.instanceUrl,
            is_connected: true,
            userInfo: session.userInfo,
            orgInfo: session.orgInfo
        });
        log.debug('chrome.storage.local saved successfully');
    } catch (e) {
        log.error('写入 chrome.storage.local 失败:', e);
    }
    
    // Session 信息仅保存在 chrome.storage.local 中，不再存储到 localStorage
    // localStorage 可被同源脚本访问，存在安全风险
    log.debug('Session saved to chrome.storage.local only (localStorage removed for security)');
    
    // Show success
    if (loginBtn) {
        loginBtn.innerHTML = '<i class="fas fa-check"></i><span>登录成功！</span>';
        loginBtn.style.background = 'var(--success-color)';
        log.debug('Login button updated to success state');
    }
    
    // Navigate to index.html after delay
    log.debug('Scheduling redirect to index.html...');
    setTimeout(() => {
        log.debug('Creating new tab with index.html...');
        chrome.tabs.create({
            url: chrome.runtime.getURL('index.html')
        }, (tab) => {
            log.debug('New tab created:', tab);
            window.close();
        });
    }, 500);
}

// Show manual login
if (showManualLogin) {
    log.debug('showManualLogin button found, adding listener');
    showManualLogin.addEventListener('click', () => {
        log.debug('showManualLogin clicked');
        if (manualLoginSection) {
            manualLoginSection.style.display = 'block';
            log.debug('manualLoginSection shown');
        }
        if (noSession) {
            noSession.style.display = 'none';
            log.debug('noSession hidden');
        }
    });
} else {
    log.warn('未找到 #show-manual-login');
}

// Manual login
if (manualLoginBtn) {
    log.debug('manualLoginBtn found, adding listener');
    manualLoginBtn.addEventListener('click', async () => {
        log.debug('manualLoginBtn clicked');
        
        const sessionId = sessionIdInput ? sessionIdInput.value.trim() : '';
        log.debug('Session ID 输入:', sessionId ? maskSecret(sessionId) : 'empty');
        
        if (!sessionId) {
            if (errorMsg) {
                errorMsg.textContent = '请输入 Session ID';
                errorMsg.classList.add('show');
            }
            log.warn('未输入 Session ID');
            return;
        }
        
        if (errorMsg) {
            errorMsg.classList.remove('show');
        }

        // 手动登录没有 instanceUrl 来源（页面上只输入 Session ID）。
        // 沿用上一次成功连接的实例地址；没有就明确报错，别带着
        // undefined 去拼连接。
        let instanceUrl = null;
        try {
            const stored = await chrome.storage.local.get('sf_instance_url');
            instanceUrl = stored?.sf_instance_url || null;
        } catch (e) {
            log.warn('读取已保存的实例地址失败:', e);
        }
        if (!instanceUrl) {
            log.warn('手动登录缺少实例地址');
            if (errorMsg) {
                errorMsg.textContent = '手动登录需要实例地址：请先用「自动检测」成功连接一次，或在该 org 登录后再回来';
                errorMsg.classList.add('show');
            }
            return;
        }

        if (manualLoginBtn) {
            manualLoginBtn.disabled = true;
            manualLoginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i><span>验证中...</span>';
        }
        
        log.debug('Calling testConnectionWithUserInfo...');
        const result = await testConnectionWithUserInfo(sessionId, instanceUrl);
        
        if (result.success) {
            log.debug('Manual login SUCCESS');
            
            // Save to chrome.storage.local
            await chrome.storage.local.set({
                sf_session_id: sessionId,
                sf_instance_url: result.instanceUrl || instanceUrl,
                is_connected: true,
                userInfo: result.userInfo,
                orgInfo: result.orgInfo
            });
            
            // Session 信息仅保存在 chrome.storage.local 中，不再存储到 localStorage
            // localStorage 可被同源脚本访问，存在安全风险
            
            if (manualLoginBtn) {
                manualLoginBtn.innerHTML = '<i class="fas fa-check"></i><span>登录成功！</span>';
                manualLoginBtn.style.background = 'var(--success-color)';
            }
            
            setTimeout(() => {
                chrome.tabs.create({
                    url: chrome.runtime.getURL('index.html')
                });
                window.close();
            }, 500);
        } else {
            log.error('手动登录失败');
            if (errorMsg) {
                errorMsg.textContent = 'Session ID 无效或已过期';
                errorMsg.classList.add('show');
            }
            if (manualLoginBtn) {
                manualLoginBtn.disabled = false;
                manualLoginBtn.innerHTML = '<i class="fas fa-check"></i><span>验证并登录</span>';
            }
        }
    });
} else {
    log.warn('未找到 #manual-login-btn');
}

// Login button click
if (loginBtn) {
    log.debug('loginBtn found, adding listener');
    loginBtn.addEventListener('click', handleLogin);
} else {
    log.error('未找到 #login-btn!');
}

// Initialize
async function init() {
    log.debug('========================================');
    log.debug('nForce Tools Login Page Initializing...');
    log.debug('========================================');
    
    log.debug('Checking DOM elements...');
    log.debug('  loadingState:', loadingState ? 'found' : 'NULL');
    log.debug('  sessionListContainer:', sessionListContainer ? 'found' : 'NULL');
    log.debug('  loginBtn:', loginBtn ? 'found' : 'NULL');
    log.debug('  noSession:', noSession ? 'found' : 'NULL');
    log.debug('  showManualLogin:', showManualLogin ? 'found' : 'NULL');
    log.debug('  manualLoginSection:', manualLoginSection ? 'found' : 'NULL');
    log.debug('  manualLoginBtn:', manualLoginBtn ? 'found' : 'NULL');
    log.debug('  sessionIdInput:', sessionIdInput ? 'found' : 'NULL');
    log.debug('  errorMsg:', errorMsg ? 'found' : 'NULL');
    
    log.debug('Calling autoDetectSession()...');
    const sessions = await autoDetectSession();
    availableSessions = sessions;
    
    log.debug('autoDetectSession returned, sessions count:', sessions ? sessions.length : 0);
    
    // Hide loading state
    if (loadingState) {
        loadingState.style.display = 'none';
        log.debug('Loading state hidden');
    } else {
        log.error('未找到 #loading-state，无法隐藏');
    }
    
    if (sessions && sessions.length > 0) {
        log.debug('Sessions available, sessions count:', sessions.length);
        
        if (sessions.length === 1) {
            // Auto login when only one session found
            log.debug('Single session found, auto-logging in...');
            availableSessions = sessions;
            selectedSessionIndex = 0;
            
            // Auto login directly
            await handleLogin();
        } else {
            // Multiple sessions - show selection list
            log.debug('Multiple sessions, showing selection list...');
            
            renderSessionList(sessions);
            
            if (sessionListContainer) {
                sessionListContainer.style.display = 'block';
            }
            log.debug('Session list displayed');
        }
    } else {
        // No sessions found
        log.warn('未发现可用会话，显示无会话提示');
        
        if (noSession) {
            noSession.style.display = 'block';
            log.debug('noSession shown');
        }
        
        if (loginBtn) {
            loginBtn.style.display = 'none';
            log.debug('loginBtn hidden');
        }
    }
    
    log.debug('========================================');
    log.debug('Initialization complete');
    log.debug('========================================');
}

// ── 页面外壳：图标替换 + 版本号 ──
// 这两件事原先写在 login.html 末尾的一段内联 <script type="module"> 里，
// 被 CSP `script-src 'self'`（不含 'unsafe-inline'）整段拒绝执行 —— 而且**没有任何
// 页面可见的异常**，只在控制台留一条 CSP 报错。后果是全静默的：登录页 7 个图标
// 一直是空白方块，#login-version 一直停在占位符 "v-"。
// 挪到本文件（登录页唯一的脚本）之后由它统一负责。
// type="module" 天然 defer，执行到这里时 DOM 已解析完，元素必然拿得到。
replaceIcons();

// 版本号唯一来源：manifest.json。
// 原先这里硬编码 v3.0，与 manifest 3.3.0 / popup v1.0 三处互不一致。
const loginVersionEl = document.getElementById('login-version');
if (loginVersionEl) {
    try {
        loginVersionEl.textContent = 'v' + chrome.runtime.getManifest().version;
    } catch (e) {
        loginVersionEl.textContent = '';
    }
}
log.debug('页面外壳已初始化：图标已替换，版本号 =', loginVersionEl ? loginVersionEl.textContent : '(未找到 #login-version)');

// Start initialization when DOM is ready
log.debug('Script loaded, checking document.readyState:', document.readyState);

if (document.readyState === 'loading') {
    log.debug('Document still loading, waiting for DOMContentLoaded...');
    document.addEventListener('DOMContentLoaded', () => {
        log.debug('DOMContentLoaded fired');
        init();
    });
} else {
    log.debug('Document already loaded, calling init() directly');
    init();
}
